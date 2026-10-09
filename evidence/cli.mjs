#!/usr/bin/env node
// web-uplift evidence primitives: a GENERIC, tool-agnostic, content-agnostic
// library the MODEL calls AT INSPECTION TIME to gather evidence about a page.
//
//   node evidence/cli.mjs <primitive> <url> [options]
//
// These primitives make NO judgements. They do not know about principles,
// checks, severities, or what "good" looks like. They return raw data and
// artifacts (JSON, PNG, MP4, heap summaries). The intelligence lives entirely in
// the model following .claude/skills/web-audit/SKILL.md: the model decides which
// primitives to run, under which emulated conditions, what probes to evaluate in
// the page, and how to reason over the results. There are no hard-coded checks
// and no fast paths anywhere in this file.
//
// Everything is raw Chrome DevTools Protocol via chrome-remote-interface against
// the system google-chrome-stable. ffmpeg (system binary) assembles screencast
// frames into a video. No Playwright, no Puppeteer.
//
// Primitives (subcommands):
//   screenshot <url>     Page.captureScreenshot -> PNG
//   video <url>          Page.startScreencast frames -> MP4 (records an interaction
//                        window; --interact runs model-supplied JS to trigger it)
//   heap <url>           HeapProfiler.takeHeapSnapshot -> a readable summary
//                        (the model never reads the raw multi-MB snapshot)
//   layout <url>         Page.getLayoutMetrics + layout-shift (CLS) + long tasks
//   dom <url>            DOM tree, computed styles for a selector set, page HTML/CSS,
//                        and (with --source <dir>) the local source files, redacted
//                        and with credential-named files skipped unread
//   evaluate <url>       Runtime.evaluate of a model-supplied expression
//                        (--expr "<js>" or --expr-file <path>); the model's
//                        ad-hoc-probe / on-the-fly static-test escape hatch
//   trace <url>          Tracing.start/end over the load (+ optional --interact)
//                        -> a devtools-loadable trace.json AND a compact
//                        *-summary.json (FCP/LCP, long tasks, total blocking
//                        time); the model reads the summary, never the raw trace
//   har <url>            Network domain capture over the load (+ optional
//                        --interact / --duration; --bodies to include response
//                        bodies) assembled into a valid HAR 1.2 file AND a compact
//                        *-summary.json of network signals (totals, third parties,
//                        render-blocking candidates, weight offenders, hygiene);
//                        the model reads the summary, never the raw HAR
//   discoverability <url> fetches the RAW server HTML (no JS) and diffs it against
//                        the rendered DOM: coveragePct (rendered content words
//                        present in the raw HTML), isJsShell, empty SPA mounts,
//                        title/h1/meta survival. The url-influence "invisible to
//                        non-JS crawlers" failure mode, per-site. Feeds
//                        be-discoverable / be-agent-ready
//
// Common options (most primitives accept these so the model can set the
// condition it wants to observe under, but the harness never decides them):
//   --out <path>            Where to write the artifact / JSON (default: stdout/derived)
//   --emulate-media k=v,..  Emulated media features, e.g.
//                           prefers-color-scheme=dark,prefers-reduced-motion=reduce
//   --viewport WxH          Device-metrics override, e.g. 360x800 (mobile)
//   --wait <ms>             Settle time after load before measuring (default 1000)
//   --cpu-throttle <n>      CPU slowdown factor (Emulation.setCPUThrottlingRate)
//   --network <profile>     Network shaping: slow-3g | fast-3g | slow-4g | fast-4g |
//                           mobile-lighthouse (150ms RTT, 1638.4/750 kbit/s, 4x CPU -
//                           the profile CWV thresholds are calibrated against)
//   --locale <bcp47>        Locale override (Emulation.setLocaleOverride), e.g. de-DE
//   --timezone <iana>       Time zone override (Emulation.setTimezoneOverride), e.g.
//                           Asia/Tokyo - i18n checks are only observable by rendering
//                           under a second locale/zone and diffing the output
//   --selector <css>        Element(s) of interest (dom/screenshot/layout)
//   --quiet                 Less logging

import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchChrome,
  newSession,
  attachConsoleCollector,
  attachConsoleEvidence,
  configureCdpDeadlines,
  recordLaunch,
} from './cdp.mjs';

import { screenshot } from './primitives/screenshot.mjs';
import { video } from './primitives/video.mjs';
import { heap } from './primitives/heap.mjs';
import { layout } from './primitives/layout.mjs';
import { dom, readSourceTree } from './primitives/dom.mjs';
import { evaluateCmd } from './primitives/evaluate.mjs';
import { axe } from './primitives/axe.mjs';
import { trace } from './primitives/trace.mjs';
import { har } from './primitives/har.mjs';
import { discoverability } from './primitives/discoverability.mjs';
import {
  secrets,
  scanTextForSecrets,
  classifyScriptFetch,
  scriptFetchFailure,
} from './primitives/secrets.mjs';
import { headers } from './primitives/headers.mjs';
import { cookies } from './primitives/cookies.mjs';
import { trackers } from './primitives/trackers.mjs';
import { images } from './primitives/images.mjs';
import { consolePrimitive, waitForInteractEvidence } from './primitives/console.mjs';
import { targets } from './primitives/targets.mjs';
import { features } from './primitives/features.mjs';
import { resilience, iconSatisfies } from './primitives/resilience.mjs';
import { a11ytree } from './primitives/a11ytree.mjs';

import {
  isCredentialName,
  redactUrlCredentialValues,
  redactQueryList,
  redactBodyText,
  redactHeaderList,
} from './redaction.mjs';

import {
  assertPageDerivedFetchAllowed,
  configureFetchDeadline,
  readBodyCapped,
  safeFetch,
} from './fetch.mjs';

import {
  stripHtmlToText,
  contentTokens,
  contentPresentInRaw,
  detectEmptyMounts,
  isFirstPartyHost,
  isThirdPartyCookie,
} from './html-text.mjs';

// Re-exports for backwards compatibility across existing callers
export {
  readSourceTree,
  trace,
  isCredentialName,
  redactUrlCredentialValues,
  redactQueryList,
  redactBodyText,
  redactHeaderList,
  assertPageDerivedFetchAllowed,
  configureFetchDeadline,
  readBodyCapped,
  safeFetch,
  stripHtmlToText,
  contentTokens,
  contentPresentInRaw,
  detectEmptyMounts,
  isFirstPartyHost,
  isThirdPartyCookie,
  scanTextForSecrets,
  classifyScriptFetch,
  scriptFetchFailure,
  waitForInteractEvidence,
  iconSatisfies,
};

const PRIMITIVES = {
  screenshot,
  video,
  heap,
  layout,
  dom,
  evaluate: evaluateCmd,
  axe,
  trace,
  har,
  discoverability,
  console: consolePrimitive,
  targets,
  features,
  resilience,
  a11ytree,
  secrets,
  headers,
  cookies,
  trackers,
  images,
};

// --- argument plumbing -----------------------------------------------------

function parseArgs(argv) {
  const args = { _: [], wait: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--cdp-deadline') args.cdpDeadline = Number(argv[++i]);
    else if (a === '--fetch-deadline') args.fetchDeadline = Number(argv[++i]);
    else if (a === '--emulate-media') args.emulateMediaRaw = argv[++i];
    else if (a === '--viewport') args.viewportRaw = argv[++i];
    else if (a === '--max-nodes') args.maxNodes = Number(argv[++i]);
    else if (a === '--max-stops') args.maxStops = Number(argv[++i]);
    else if (a === '--wait') args.wait = Number(argv[++i]);
    else if (a === '--cpu-throttle') args.cpuThrottle = Number(argv[++i]);
    else if (a === '--network') args.network = argv[++i];
    else if (a === '--locale') args.locale = argv[++i];
    else if (a === '--timezone') args.timezone = argv[++i];
    else if (a === '--duration') args.duration = Number(argv[++i]);
    else if (a === '--fps') args.fps = Number(argv[++i]);
    else if (a === '--selector') args.selector = argv[++i];
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--expr') args.expr = argv[++i];
    else if (a === '--expr-file') args.expr = readFileSync(argv[++i], 'utf8');
    else if (a === '--interact') args.interact = argv[++i];
    else if (a === '--interact-file') args.interact = readFileSync(argv[++i], 'utf8');
    else if (a === '--interact-deadline') {
      // A typo must not silently become an unbounded wait: NaN makes
      // `elapsed >= NaN` false forever and sleep(NaN) a 0ms spin, Infinity never
      // exits, and <= 0 makes the wait vacuous. Accept only a finite positive ms.
      const raw = argv[++i];
      const ms = Number(raw);
      if (!(Number.isFinite(ms) && ms > 0)) {
        throw new Error(`--interact-deadline must be a positive number of milliseconds, got ${raw}`);
      }
      args.interactDeadlineMs = ms;
    }
    else if (a === '--full-page') args.fullPage = true;
    else if (a === '--no-screenshots') args.screenshots = false;
    else if (a === '--bodies') args.bodies = true;
    else if (a === '--no-redact-headers') args.redactHeaders = false;
    else if (a === '--quiet') args.quiet = true;
    else args._.push(a);
  }
  if (args.emulateMediaRaw) {
    args.emulateMedia = args.emulateMediaRaw.split(',').map((kv) => {
      const [name, value] = kv.split('=');
      return { name: name.trim(), value: (value ?? '').trim() };
    });
  }
  if (args.viewportRaw) {
    const m = args.viewportRaw.match(/(\d+)x(\d+)/);
    if (m) args.viewport = { w: Number(m[1]), h: Number(m[2]) };
  }
  return args;
}

export async function gather(primitive, url, opts = {}) {
  const fn = PRIMITIVES[primitive];
  if (!fn) throw new Error(`Unknown primitive "${primitive}". One of: ${Object.keys(PRIMITIVES).join(', ')}`);
  const log = opts.quiet ? () => {} : (m) => console.error(m);
  const chrome = await launchChrome({ log });
  // Attribute the browser to this invocation AT LAUNCH (web-uplift-4wx): a
  // primitive that never completes writes no result artifact, so without this
  // marker nothing in the run tree ties a surviving chrome to its primitive.
  recordLaunch({ primitive, url, chrome });
  try {
    const session = await newSession(chrome.port, { log });
    try {
      // Attach BEFORE the primitive runs so console output from the load itself
      // is captured, not just whatever fires after it settles.
      const collector = await attachConsoleCollector(session.client, { log });
      const result = await fn(session.client, url, opts, log, collector);
      const block = attachConsoleEvidence(session.client, result);
      if (block && (block.consoleErrorCount > 0 || block.exceptionCount > 0)) {
        log(
          `[evidence] WARNING: the page logged ${block.consoleErrorCount} console error(s)` +
            `${block.exceptionCount ? ` and ${block.exceptionCount} uncaught exception(s)` : ''} during ${primitive}; they are in the returned console block`,
        );
      }
      return result;
    } finally {
      await session.close();
    }
  } finally {
    await chrome.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const primitive = args._[0];
  const url = args._[1];
  if (!primitive || !url) {
    console.error(
      'Usage: node evidence/cli.mjs <screenshot|video|heap|layout|dom|evaluate|axe|trace|har|discoverability|console|targets|features|resilience|a11ytree|secrets|headers|cookies|trackers|images> <url> [options]\n' +
        'Options: --out --emulate-media k=v,.. --viewport WxH --wait ms --selector css --max-nodes n --max-stops n\n' +
        '         --cpu-throttle n --network slow-3g|fast-3g|slow-4g|fast-4g|mobile-lighthouse\n' +
        '         --locale de-DE --timezone Asia/Tokyo\n' +
        '         --source dir --expr "<js>" --expr-file f --interact "<js>" --interact-file f --interact-deadline ms\n' +
        '         --source dir reads a local source tree: contents are redacted (names-based, as the HAR bodies) and credential-named files are skipped unread before anything is inlined\n' +
        '         --rules a,b,c --tags a,b,c --duration ms --fps n --full-page --bodies\n' +
        '         --cdp-deadline ms (bound every CDP attach/navigation wait; default 30000)\n' +
        '         --fetch-deadline ms (bound each raw-fetch exchange; default 30000)\n' +
        '         --no-redact-headers (keep raw credential header values; publication risk) --quiet',
    );
    process.exit(1);
  }
  // --out names a FILE: a directory (EISDIR) or a missing parent surfaces at the
  // first writeFileSync as a raw syscall error, which reads as a tool bug rather
  // than an argument mistake (the dl6 footgun). Validate once here - opts.out
  // flows into every writeFileSync site - before any browser is launched.
  if (args.out) {
    const resolvedOut = resolve(args.out);
    if (existsSync(resolvedOut) && statSync(resolvedOut).isDirectory()) {
      console.error(`web-uplift: --out names a directory, but it must be a file path: ${resolvedOut}`);
      process.exit(1);
    }
    const outDir = dirname(resolvedOut);
    if (!existsSync(outDir)) {
      console.error(`web-uplift: --out's directory does not exist: ${outDir}`);
      process.exit(1);
    }
  }
  // The flag beats the environment; either overrides the CDP wait defaults.
  const deadlineArg = Number(args.cdpDeadline ?? process.env.WEB_UPLIFT_CDP_DEADLINE_MS);
  if (Number.isFinite(deadlineArg) && deadlineArg > 0) {
    configureCdpDeadlines({ navigationMs: deadlineArg, callMs: deadlineArg });
  }
  const fetchDeadlineArg = Number(args.fetchDeadline ?? process.env.WEB_UPLIFT_FETCH_DEADLINE_MS);
  if (Number.isFinite(fetchDeadlineArg) && fetchDeadlineArg > 0) {
    configureFetchDeadline(fetchDeadlineArg);
  }
  const result = await gather(primitive, url, args);
  // Print the result (or artifact pointer) as JSON to stdout for the model.
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
