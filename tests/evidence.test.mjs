#!/usr/bin/env node
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assert,
  run,
  runAsync,
  repoRoot,
  tmp,
  runSuite,
  readJson,
  validateJson,
  listFiles,
  assertProbeFileInert,
  assertUnknownRawSurface,
  cleanStaleNpxRegressionTrees,
  packTarball,
  noUpdateEnv,
  SKIP_DIRS,
} from './test-helpers.mjs';
import {
  gather,
  waitForInteractEvidence,
  safeFetch,
  assertPageDerivedFetchAllowed,
  isFirstPartyHost,
} from '../evidence/cli.mjs';
import { launchChrome } from '../evidence/cdp.mjs';
import { testConsoleEvidenceRedaction } from './console-evidence-redaction.mjs';
import {
  testNoSourceArgumentOmitsSource,
  testAdversarialPageCannotInfluenceSource,
  testExplicitSourceHonoursOperatorSpecifiedRoot,
} from './evidence-cli-source-containment.mjs';

export async function testPreNavigationEmulation() {
  const html =
    '<!doctype html><script>' +
    "window.initialReduce = matchMedia('(prefers-reduced-motion: reduce)').matches;" +
    '</script>';
  const value = await gather(
    'evaluate',
    `data:text/html,${encodeURIComponent(html)}`,
    {
      quiet: true,
      wait: 0,
      emulateMedia: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      expr:
        "({ initial: window.initialReduce, current: matchMedia('(prefers-reduced-motion: reduce)').matches })",
    },
  );
  assert(value.initial === true, `emulated media was not visible during load: ${JSON.stringify(value)}`);
  assert(value.current === true, `emulated media was not visible after load: ${JSON.stringify(value)}`);
}


// The axe primitive must work where the audit was previously blind: a site
// with a strict script-src refuses CDN fetches and injected <script src>, so
// axe through the evaluate primitive silently returned nothing. The primitive
// reads the VENDORED axe-core from disk and enables Page.setBypassCSP scoped to
// itself. If either regresses this test finds no violations on a page that
// provably has them.
export async function testAxePrimitiveBypassesStrictCsp() {
  const html =
    '<!doctype html><html><head><title>strict csp</title></head><body>' +
    '<h1>Title</h1><h3>Skipped level</h3>' +
    '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">' +
    '<button></button>' +
    '</body></html>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Security-Policy': "script-src 'self'; default-src 'self'",
    });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const result = await gather('axe', `http://127.0.0.1:${server.address().port}/`, { quiet: true, wait: 200 });
    const all = Object.values(result.violations).flat();
    const ids = all.map((v) => v.id);
    assert(result.toolVersion, `axe: toolVersion missing (injection failed?): ${JSON.stringify(result)}`);
    assert(ids.includes('image-alt'), `axe: image-alt not found under strict CSP: ${ids.join(', ')}`);
    assert(ids.includes('heading-order'), `axe: heading-order not found under strict CSP: ${ids.join(', ')}`);
    assert(ids.includes('button-name'), `axe: button-name not found under strict CSP: ${ids.join(', ')}`);
    assert(result.violations.critical.some((v) => v.id === 'image-alt'),
      'axe: violations must be grouped by impact (image-alt is critical)');
    for (const v of all) {
      assert(v.nodeCount >= v.nodes.length, `axe: ${v.id} node cap must be announced, not silent`);
      assert(v.nodes.length > 0 && v.nodes[0].target, `axe: ${v.id} should carry node targets`);
    }
    assert(result.counts.passes > 0, 'axe: counts should include concluded passes');
  } finally {
    server.close();
  }
}


// The axe primitive audits the page under the page's own policy. A strict
// script-src must still block the page's own inline script - the audit used to
// lift the policy before navigation, so the page's blocked scripts ran - the
// vendored engine must still be injected and produce results, and the result
// must say the policy was lifted for the injection, so a reader can tell this
// run from one where no bypass happened (web-uplift-8np).
export async function testAxeKeepsPagePolicyAndDisclosesInjectionBypass() {
  let pageScriptRan = false;
  const html =
    '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'">' +
    '<title>strict csp</title></head><body><img src="data:," id="noalt">' +
    "<script>new Image().src = '/ran';</script></body></html>";
  const server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/ran')) {
      pageScriptRan = true;
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'axe-csp.json');
    const result = await gather('axe', `http://127.0.0.1:${port}/`, { quiet: true, wait: 500, out });
    assert(
      pageScriptRan === false,
      "a page script blocked by the page's own policy must not run during an axe audit",
    );
    assert(result.violationCount > 0, `the vendored axe-core must still report violations: ${JSON.stringify(result.counts)}`);
    assert(
      JSON.stringify(result.violations).includes('image-alt'),
      `the missing-alt image must still be reported: ${JSON.stringify(result.violations)}`,
    );
    assert(result.cspBypassedForInjection === true, 'the result must disclose that the policy was lifted for the injection');
    assert(
      typeof result.cspBypassNote === 'string' && result.cspBypassNote.length > 0,
      'the disclosure must explain what was lifted and for how long',
    );
    const artifact = readFileSync(out, 'utf8');
    assert(artifact.includes('cspBypassNote'), 'the artifact must carry the disclosure');
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// CWV thresholds are calibrated against mid-tier mobile on variable networks;
// an unthrottled headless desktop is the one configuration guaranteed to pass.
// The throttling conditions must be (a) actually applied to the connection/CPU
// and (b) recorded in the output, so a finding states the device class it was
// measured on.
export async function testThrottlingConditions() {
  const html = '<!doctype html><html><head><title>t</title></head><body><h1>x</h1></body></html>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/`;

    // The conditions a run was measured under are recorded in the output.
    const shaped = await gather('layout', base, {
      quiet: true,
      wait: 100,
      network: 'fast-3g',
      cpuThrottle: 4,
      viewport: { w: 360, h: 800 },
    });
    assert(shaped.conditions?.network?.profile === 'fast-3g',
      `throttle: layout output must record the network profile: ${JSON.stringify(shaped.conditions)}`);
    assert(shaped.conditions.network.downloadThroughputBps === 180000 &&
      shaped.conditions.network.uploadThroughputBps === 84375 &&
      shaped.conditions.network.latencyMs === 562.5,
      `throttle: fast-3g must carry the exact DevTools preset numbers: ${JSON.stringify(shaped.conditions.network)}`);
    assert(shaped.conditions.cpuThrottleRate === 4,
      `throttle: layout output must record the CPU rate: ${JSON.stringify(shaped.conditions)}`);
    assert(
      shaped.conditions.viewport?.width === 360 && shaped.conditions.viewport?.height === 800 &&
        shaped.conditions.viewport?.mobile === true && shaped.conditions.viewport?.deviceScaleFactor === 1 &&
        shaped.conditions.viewport?.profile === 'mobile',
      `conditions: the artifact must record the whole emulated profile, not only its size: ${JSON.stringify(shaped.conditions.viewport)}`,
    );

    // The same fixed size with the mobile profile switched off must record the
    // desktop profile, so the recorded value cannot be a constant.
    const desktopProfile = await gather('layout', base, {
      quiet: true,
      wait: 100,
      viewport: { w: 360, h: 800 },
      viewportMobile: false,
    });
    assert(
      desktopProfile.conditions.viewport?.mobile === false &&
        desktopProfile.conditions.viewport?.profile === 'desktop' &&
        desktopProfile.conditions.viewport?.width === 360,
      `conditions: an opted-out run must record the desktop profile: ${JSON.stringify(desktopProfile.conditions.viewport)}`,
    );

    // ...and a run with no device-metrics override must not claim one: an unemulated
    // run carries no viewport record rather than an invented profile.
    const noViewport = await gather('layout', base, { quiet: true, wait: 100 });
    assert(
      !noViewport.conditions || noViewport.conditions.viewport === undefined,
      `conditions: a run with no device-metrics override must not report an emulated profile: ${JSON.stringify(noViewport.conditions)}`,
    );

    // mobile-lighthouse applies its 4x CPU slowdown without a separate flag.
    const mobile = await gather('layout', base, { quiet: true, wait: 100, network: 'mobile-lighthouse' });
    assert(mobile.conditions.cpuThrottleRate === 4 && mobile.conditions.network.latencyMs === 150,
      `throttle: mobile-lighthouse must imply 4x CPU + 150ms RTT: ${JSON.stringify(mobile.conditions)}`);

    // The shaping must be REAL, not just recorded: a slow-3g RTT of 2000ms
    // shows up in a fetch the page makes (warm up the socket first so cold-start
    // socket setup on a loaded VM does not inflate plain latency).
    const probe = { quiet: true, wait: 100, expr: '(async()=>{await fetch("/p"); const t=performance.now(); await fetch("/p"); return performance.now()-t;})()' };
    const plain = await gather('evaluate', base, probe);
    const throttled = await gather('evaluate', base, { ...probe, network: 'slow-3g' });
    assert(throttled > plain + 1000,
      `throttle: slow-3g should add ~2000ms RTT, got plain=${Math.round(plain)}ms shaped=${Math.round(throttled)}ms`);

    // An unthrottled run carries no conditions block at all (not an empty one).
    const unthrottled = await gather('layout', base, { quiet: true, wait: 100 });
    assert(!('conditions' in unthrottled),
      `throttle: an unthrottled run must not claim conditions: ${JSON.stringify(unthrottled.conditions)}`);

    // Unknown profiles fail loudly, never silently fall back to unshaped.
    let rejected = false;
    try {
      await gather('layout', base, { quiet: true, wait: 100, network: 'dial-up' });
    } catch (err) {
      rejected = /Unknown network profile/.test(err.message);
    }
    assert(rejected, 'throttle: an unknown profile must be rejected by name');
  } finally {
    server.close();
  }
}


// The three be-internationalised checks are only observable by rendering under
// a second locale / time zone and diffing what the page actually shows -
// source reading cannot see a hard-coded calendar assumption or a naive Date
// through a formatter. The overrides must be REAL (rendered output differs)
// and RECORDED (each side of the diff states its conditions).
export async function testLocaleTimezoneConditions() {
  const probe =
    '({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone,' +
    ' rendered: new Date(Date.UTC(2026, 0, 15, 2, 0)).toLocaleString(),' +
    ' num: (12345.678).toLocaleString() })';
  const url = 'data:text/html,<h1>i18n</h1>';

  const tokyo = await gather('evaluate', url, { quiet: true, wait: 0, expr: probe, timezone: 'Asia/Tokyo' });
  const newYork = await gather('evaluate', url, { quiet: true, wait: 0, expr: probe, timezone: 'America/New_York' });
  assert(tokyo.tz === 'Asia/Tokyo' && newYork.tz === 'America/New_York',
    `i18n: the timezone override must apply: ${tokyo.tz} / ${newYork.tz}`);
  assert(tokyo.rendered !== newYork.rendered,
    `i18n: 02:00 UTC must render as different local times in Tokyo and New York: ${tokyo.rendered} / ${newYork.rendered}`);
  assert(tokyo.conditions?.timezone === 'Asia/Tokyo' && newYork.conditions?.timezone === 'America/New_York',
    `i18n: each side of the diff must record its timezone: ${JSON.stringify(tokyo.conditions)} / ${JSON.stringify(newYork.conditions)}`);

  const german = await gather('evaluate', url, { quiet: true, wait: 0, expr: probe, locale: 'de-DE' });
  assert(german.num === '12.345,678',
    `i18n: de-DE must render the comma decimal separator: ${german.num}`);
  assert(german.conditions?.locale === 'de-DE',
    `i18n: the locale must be recorded: ${JSON.stringify(german.conditions)}`);

  // The screenshot primitive records its conditions too (it bypasses emit()
  // because its artifact is binary).
  const shot = await gather('screenshot', url, { quiet: true, wait: 0, locale: 'fr-FR', out: join(tmp, 'i18n-shot.png') });
  assert(shot.conditions?.locale === 'fr-FR',
    `i18n: the screenshot must record its locale: ${JSON.stringify(shot)}`);

  // Invalid values fail loudly instead of silently judging the default locale.
  for (const [opts, pattern] of [
    [{ locale: '!!bogus!!' }, /Invalid --locale/],
    [{ timezone: 'Mars/Olympus_Mons' }, /Invalid --timezone/],
  ]) {
    let rejected = false;
    try {
      await gather('evaluate', url, { quiet: true, wait: 0, expr: '1', ...opts });
    } catch (err) {
      rejected = pattern.test(err.message);
    }
    assert(rejected, `i18n: ${JSON.stringify(opts)} must be rejected by name`);
  }
}


// follow-best-practices/no-console-errors needs first-party evidence: what the
// page logged DURING load is invisible to a post-load evaluate probe, so the
// console primitive collects Runtime + Log events from before the navigation.
// The counts are split by source so a failed subresource request is not
// confused with a page-authored console error (web-uplift-2dg).
export async function testConsoleEvidence() {
  const noisy = [
    '<!doctype html><html><head><title>noisy</title><script>',
    "  console.warn('fixture warning');",
    "  console.error('fixture console error');",
    "  console.error('fixture console error');",
    "  setTimeout(function () { throw new Error('fixture uncaught exception'); }, 0);",
    "  fetch('/missing.json').catch(function () {});",
    '</script></head><body><p>Deterministic console story.</p></body></html>',
  ].join('\n');
  const clean = '<!doctype html><html><head><title>clean</title></head><body><p>Nothing is logged here.</p>' +
    '<button id="boom">boom</button>' +
    "<script>document.querySelector('#boom').addEventListener('click', function () { throw new Error('fixture interact exception'); });</script>" +
    '</body></html>';

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === '/clean') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(clean);
      return;
    }
    if (path === '/noisy') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(noisy);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const result = await gather('console', `${base}/noisy`, { quiet: true, wait: 500 });
    const block = result.console;
    assert(
      block.exceptionCount === 1 && block.entries.some((e) => e.kind === 'exception' && e.text.includes('fixture uncaught exception')),
      `console: the load-time exception was not captured: ${JSON.stringify(block)}`,
    );
    assert(
      block.consoleErrorCount === 1 && block.entries.some((e) => e.text.includes('fixture console error')),
      `console: the load-time console error was not captured: ${JSON.stringify(block)}`,
    );
    assert(
      block.warningCount === 1 && block.entries.some((e) => e.text.includes('fixture warning')),
      `console: the console warning was not captured: ${JSON.stringify(block)}`,
    );
    assert(
      block.networkErrorCount === 1 && block.entries.some((e) => e.source === 'network' && (e.url || '').endsWith('/missing.json')),
      `console: the failed subresource request was not captured separately: ${JSON.stringify(block)}`,
    );
    assert(block.hasErrors === true, `console: a page that threw should report errors: ${JSON.stringify(block)}`);
    const repeated = block.entries.find((e) => e.text.includes('fixture console error'));
    assert(repeated.repeat === 2, `console: identical messages should collapse into a repeat count: ${JSON.stringify(repeated)}`);
    const exception = block.entries.find((e) => e.kind === 'exception');
    assert(Array.isArray(exception.stack) && exception.stack.length > 0, `console: an exception should carry a stack frame: ${JSON.stringify(exception)}`);

    // Every primitive carries the block, and the artifact a primitive writes has
    // to agree with its stdout: that is what emit() is for.
    const out = join(tmp, 'console-dom-artifact.json');
    const cli = await runAsync(process.execPath, [
      'evidence/cli.mjs', 'dom', `${base}/noisy`, '--wait', '300', '--out', out, '--interact-deadline', '2000',
    ]);
    assert(cli.status === 0, `console: dom CLI failed:\n${cli.stderr}`);
    const artifact = JSON.parse(readFileSync(out, 'utf8'));
    const stdout = JSON.parse(cli.stdout);
    assert(
      artifact.console?.exceptionCount === 1 && stdout.console?.exceptionCount === 1,
      `console: the console block should ride along on other primitives, in the artifact and stdout:\n${JSON.stringify({ artifact: artifact.console, stdout: stdout.console })}`,
    );

    // A page that logs nothing reports zeroes: the empty block is the evidence
    // that the check can pass, not the absence of evidence.
    const cleanResult = await gather('console', `${base}/clean`, { quiet: true, wait: 400 });
    assert(
      cleanResult.console.entryCount === 0 && cleanResult.console.hasErrors === false && cleanResult.console.entries.length === 0,
      `console: a page that logs nothing must report zeroes: ${JSON.stringify(cleanResult.console)}`,
    );

    // Interaction errors count too: the same page throws only when its button is
    // clicked, which is exactly the error class a post-load probe cannot see.
    const interactResult = await gather('console', `${base}/clean`, {
      quiet: true,
      wait: 400,
      // An explicit deadline: under load the zero-delay click's exception can
      // cross the old fixed 250ms window, which was the 7kl flake.
      interactDeadlineMs: 2000,
      interact: "setTimeout(() => document.querySelector('#boom').click(), 0)",
    });
    assert(
      interactResult.console.exceptionCount === 1 &&
        interactResult.console.entries.some((e) => e.text.includes('fixture interact exception')),
      `console: an error raised by --interact was not captured: ${JSON.stringify(interactResult.console)}`,
    );
    assert(
      interactResult.interactObserved === true && interactResult.interactEvidencePending === false,
      `console: a captured interact must report observed evidence and no truncation: ${JSON.stringify({ observed: interactResult.interactObserved, pending: interactResult.interactEvidencePending, wait: interactResult.interactWaitMs })}`,
    );

    // AC1: a benign entry at +0ms must not mask a throw at +100ms. A poll that
    // returns on the FIRST new entry misses the exception; the trailing silence
    // window is what catches it.
    const mixedResult = await gather('console', `${base}/clean`, {
      quiet: true,
      wait: 400,
      interactDeadlineMs: 2000,
      interact:
        "setTimeout(() => console.warn('fixture benign entry'), 0);" +
        "setTimeout(() => document.querySelector('#boom').click(), 100)",
    });
    assert(
      mixedResult.console.warningCount === 1 &&
        mixedResult.console.entries.some((e) => e.text.includes('fixture benign entry')),
      `console: the benign interact entry was not captured: ${JSON.stringify(mixedResult.console)}`,
    );
    assert(
      mixedResult.console.exceptionCount === 1 &&
        mixedResult.console.entries.some((e) => e.text.includes('fixture interact exception')),
      `console: a throw after an earlier benign entry was missed (first-entry-only exit): ${JSON.stringify(mixedResult.console)}`,
    );

    // AC2: a quiet interaction costs the default settle, not the hard deadline,
    // and is not reported as a pending failure.
    const quietResult = await gather('console', `${base}/clean`, { quiet: true, wait: 400, interact: 'void 0' });
    assert(
      quietResult.interactObserved === false && quietResult.interactEvidencePending === false,
      `console: a quiet interact must not report observed or pending evidence: ${JSON.stringify({ observed: quietResult.interactObserved, pending: quietResult.interactEvidencePending })}`,
    );
    assert(
      quietResult.interactWaitMs >= 200 && quietResult.interactWaitMs < 1000,
      `console: a quiet interact must return on the default settle, not the hard deadline: ${quietResult.interactWaitMs}ms`,
    );

    // AC3: with an explicit longer deadline, an entry that only arrives at +700ms
    // is still captured, and the reported wait reflects it.
    const delayedResult = await gather('console', `${base}/clean`, {
      quiet: true,
      wait: 400,
      interactDeadlineMs: 2000,
      interact: "setTimeout(() => document.querySelector('#boom').click(), 700)",
    });
    assert(
      delayedResult.console.exceptionCount === 1 &&
        delayedResult.console.entries.some((e) => e.text.includes('fixture interact exception')),
      `console: an interact error raised after the old 250ms window was not captured: ${JSON.stringify(delayedResult.console)}`,
    );
    assert(
      delayedResult.interactEvidencePending === false,
      `console: the poll must report that evidence arrived rather than pending: ${JSON.stringify({ wait: delayedResult.interactWaitMs, pending: delayedResult.interactEvidencePending })}`,
    );
    assert(
      typeof delayedResult.interactWaitMs === 'number' && delayedResult.interactWaitMs >= 650,
      `console: the poll must wait for the delayed entry and report how long it waited: ${delayedResult.interactWaitMs}`,
    );

    // A typo'd --interact-deadline must fail fast at parse time rather than
    // becoming an unbounded wait (NaN / Infinity) or a vacuous one (<= 0). These
    // are parse errors, so no browser is launched (web-uplift-3t2 review).
    for (const bad of ['foo', '0', '-5', 'Infinity', 'NaN', '']) {
      const rejected = await runAsync(process.execPath, [
        'evidence/cli.mjs', 'console', `${base}/clean`, '--interact', 'void 0', '--interact-deadline', bad,
      ]);
      assert(
        rejected.status !== 0 && /--interact-deadline must be a positive number/.test(rejected.stderr),
        `console: --interact-deadline ${bad} must be rejected with a usage error, got status ${rejected.status}: ${rejected.stderr}`,
      );
    }
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// The interact deadline must be validated in the LOOP, not only in the CLI
// parser: a caller that passes opts.interactDeadlineMs directly to gather()
// bypasses parseArgs, and a non-finite or non-positive value would make
// `elapsed >= NaN` false forever with sleep(NaN) spinning at 0ms. No browser is
// needed here: the helper only reads collector.entries.
// The interact deadline must be bounded by the LOOP, not only by the CLI parser:
// gather() calls never go through parseArgs, and NaN/Infinity are not nullish, so
// a bad programmatic value used to make `elapsed >= NaN` false forever with
// sleep(NaN) spinning at 0ms. A bad value must degrade to the default bounded
// wait (the parser keeps its fail-fast usage error for CLI typos). No browser is
// needed here: the helper only reads collector.entries.
export async function testConsoleInteractDeadlineValidation() {
  const fake = { entries: [] };
  for (const bad of [NaN, Infinity, -Infinity, 0, -5, null, undefined, '']) {
    const r = await waitForInteractEvidence(fake, 0, bad);
    assert(
      r.deadlineMs === 250 && r.observed === false && r.pending === false && r.waitedMs >= 200 && r.waitedMs < 1000,
      `a bad deadline (${String(bad)}) must degrade to the default bounded wait: ${JSON.stringify(r)}`,
    );
  }

  // A numeric string is coerced, and a valid number is honoured.
  const str = await waitForInteractEvidence(fake, 0, '500');
  assert(str.deadlineMs === 500 && str.waitedMs >= 450, `a numeric string deadline must be coerced: ${JSON.stringify(str)}`);
  const num = await waitForInteractEvidence(fake, 0, 60);
  assert(num.deadlineMs === 60 && num.waitedMs >= 55, `a valid deadline must be honoured: ${JSON.stringify(num)}`);

  // An entry that arrives during the wait is observed and not reported pending.
  const collector = { entries: [] };
  setTimeout(() => collector.entries.push({ kind: 'exception', level: 'error', source: 'runtime', text: 'x' }), 20);
  const seen = await waitForInteractEvidence(collector, 0, 500);
  assert(
    seen.observed === true && seen.pending === false,
    `an entry during the wait must be observed and not pending: ${JSON.stringify(seen)}`,
  );
}


// The headers primitive reads a site's security response headers, and header names
// are case-insensitive (RFC 9110): Chrome hands them over as the server sent them, so
// an HTTP/1.1 response arrives capitalised and an HTTP/2 one lowercased. The lookup
// used to be lowercase-only, which made every capitalised response report all six
// headers as missing - a false negative written into the tool's own security
// evidence. This drives the real primitive over both wire shapes and checks that a
// header the response does not send still reads as absent, so the fix cannot be
// over-broad (web-uplift-0w6).
export async function testHeadersPrimitiveFindsHeadersRegardlessOfNameCase() {
  const page = (title) =>
    `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1></main></body></html>`;
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/caps') {
      // HTTP/1.1 wire shape: Node writes header names exactly as given.
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': "default-src 'self'",
        'Strict-Transport-Security': 'max-age=63072000',
      });
      res.end(page('caps'));
      return;
    }
    if (path === '/lower') {
      // The shape HTTP/2 delivers: the case that already worked, kept as a
      // regression guard in the other direction.
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': "default-src 'self'",
        'x-content-type-options': 'nosniff',
      });
      res.end(page('lower'));
      return;
    }
    if (path === '/empty') {
      // Present but empty protects nothing: it must read as its own state, not as
      // absent and not as a pass.
      res.setHeader('Content-Security-Policy', '');
      res.setHeader('Referrer-Policy', '');
      res.setHeader('Strict-Transport-Security', 'max-age=63072000');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page('empty'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page('bare'));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    // Prove the fixtures carry the casing each case is about: res.rawHeaders keeps
    // the wire casing, while res.headers is lowercased by Node itself and would
    // prove nothing here.
    const wireNames = async (path) =>
      new Promise((resolve, reject) => {
        const request = http.get(`${base}${path}`, (res) => {
          const names = res.rawHeaders.filter((_, index) => index % 2 === 0);
          res.resume();
          resolve(names);
        });
        request.on('error', reject);
      });
    assert(
      (await wireNames('/caps')).includes('Content-Security-Policy'),
      'the HTTP/1.1 fixture must really send a capitalised header name',
    );
    assert(
      (await wireNames('/lower')).includes('content-security-policy'),
      'the lowercase fixture must really send a lowercase header name',
    );

    const caps = await gather('headers', `${base}/caps`, { quiet: true, wait: 400 });
    assert(
      caps.securityHeaders['content-security-policy'].present === true,
      `a capitalised response header must be found: ${JSON.stringify(caps.securityHeaders['content-security-policy'])}`,
    );
    assert(
      caps.securityHeaders['content-security-policy'].value === "default-src 'self'",
      `the header value must survive the normalisation: ${JSON.stringify(caps.securityHeaders['content-security-policy'])}`,
    );
    assert(
      caps.securityHeaders['strict-transport-security'].present === true,
      `a capitalised HSTS header must be found: ${JSON.stringify(caps.securityHeaders['strict-transport-security'])}`,
    );
    assert(
      caps.securityHeaders['x-frame-options'].present === false,
      `a header the response does not send must still read as absent: ${JSON.stringify(caps.securityHeaders['x-frame-options'])}`,
    );

    const lower = await gather('headers', `${base}/lower`, { quiet: true, wait: 400 });
    assert(
      lower.securityHeaders['content-security-policy'].present === true,
      `a lowercase response header must still be found: ${JSON.stringify(lower.securityHeaders['content-security-policy'])}`,
    );
    assert(
      lower.securityHeaders['x-content-type-options'].present === true,
      `a lowercase nosniff header must still be found: ${JSON.stringify(lower.securityHeaders['x-content-type-options'])}`,
    );

    const bare = await gather('headers', `${base}/bare`, { quiet: true, wait: 400 });
    assert(
      bare.securityHeaders['content-security-policy'].present === false &&
        bare.securityHeaders['strict-transport-security'].present === false,
      `a response that sends no security headers must report none: ${JSON.stringify(bare.securityHeaders)}`,
    );

    // Present-but-empty is a third state. Reading it as absent would be the false
    // negative this bead fixed; reading it as a pass would be false assurance - an
    // empty security header protects nothing.
    const empty = await gather('headers', `${base}/empty`, { quiet: true, wait: 400 });
    const emptyCsp = empty.securityHeaders['content-security-policy'];
    assert(emptyCsp.present === true, `a header sent with an empty value is still present: ${JSON.stringify(emptyCsp)}`);
    assert(
      emptyCsp.empty === true && emptyCsp.value === '',
      `an empty value must be recorded as its own state: ${JSON.stringify(emptyCsp)}`,
    );
    assert(
      emptyCsp.issues.includes('present but empty'),
      `an empty security header must not read as a pass: ${JSON.stringify(emptyCsp)}`,
    );
    assert(
      empty.securityHeaders['referrer-policy'].empty === true,
      `an empty referrer-policy is empty too: ${JSON.stringify(empty.securityHeaders['referrer-policy'])}`,
    );
    const controlHsts = empty.securityHeaders['strict-transport-security'];
    assert(
      controlHsts.present === true && controlHsts.empty === false && controlHsts.issues.length === 0,
      `a header sent with a value must read as neither absent nor empty: ${JSON.stringify(controlHsts)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// headers() used to have a timeout of (opts.wait || 5000) + 3000ms. When tests or callers
// specified wait: 400ms, the budget was only 3400ms. Under CPU load (or a slow TTFB),
// navigate() plus the HTTP response exceeded 3400ms, docPromise resolved null, and all
// security headers were reported as missing (false audit findings and flaky full gates).
// This test delays the response beyond that 3400ms window with wait: 400 and asserts
// that the scaled budget in docPromise captures the headers (web-uplift-met0).
export async function testHeadersPrimitiveSurvivesSlowResponseUnderLoad() {
  const page = (title) =>
    `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1></main></body></html>`;
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/slow-headers') {
      // Delay response headers by 3600ms, which exceeds the old (400 + 3000) = 3400ms ceiling.
      setTimeout(() => {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "default-src 'self'",
          'Strict-Transport-Security': 'max-age=63072000',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(page('slow'));
      }, 3600);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page('ok'));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    // Passing wait: 400 gives opts.wait = 400. In the old implementation, docPromise
    // timed out at 3400ms and resolved null, causing all security headers to be missing.
    const result = await gather('headers', `${base}/slow-headers`, { quiet: true, wait: 400 });
    const csp = result.securityHeaders['content-security-policy'];
    const hsts = result.securityHeaders['strict-transport-security'];
    const xcto = result.securityHeaders['x-content-type-options'];
    assert(csp.present === true, `slow CSP must be captured despite wait: 400: ${JSON.stringify(csp)}`);
    assert(csp.value === "default-src 'self'", `slow CSP value must match: ${JSON.stringify(csp)}`);
    assert(hsts.present === true, `slow HSTS must be captured despite wait: 400: ${JSON.stringify(hsts)}`);
    assert(xcto.present === true && xcto.issues.length === 0, `slow X-Content-Type-Options must be valid: ${JSON.stringify(xcto)}`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// The HAR path reads two header values out of the raw CDP objects: a request's
// content-type and a redirect's location. Both were looked up by one exact casing
// ('Content-Type', and only 'Location'/'location'), so any other casing was missed
// - the fetch API sends a lower-case name, and a server may send LOCATION in any
// case at all. Both now go through headerMap, the same lower-casing the rest of
// the HAR path uses (web-uplift-0w6).
export async function testHarReadsRequestContentTypeAndRedirectLocationRegardlessOfCase() {
  const received = [];
  const page = (title, script = '') =>
    `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1></main>${script}</body></html>`;
  const postScript = `<script>fetch('/post',{method:'POST',headers:{'content-type':'application/json'},body:'{"a":1}'}).catch(()=>{})</script>`;
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/post') {
      received.push(req.rawHeaders);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (path === '/redirect') {
      res.writeHead(302, { 'LOCATION': '/final', 'Content-Type': 'text/html' });
      res.end(page('redirect', postScript));
      return;
    }
    // A redirect response body is never executed, so the POST belongs to the page
    // the redirect lands on.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page(path === '/final' ? 'final' : 'root', path === '/final' ? postScript : ''));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    // Prove the fixtures: the redirect really leaves with an all-caps name, and the
    // POST really arrives with a lower-case one.
    const wire = await new Promise((resolve, reject) => {
      const request = http.get(`${base}/redirect`, (res) => {
        const names = res.rawHeaders.filter((_, index) => index % 2 === 0);
        res.resume();
        resolve(names);
      });
      request.on('error', reject);
    });
    assert(wire.includes('LOCATION'), `the redirect fixture must really send an all-caps header name: ${JSON.stringify(wire)}`);

    const out = join(tmp, 'har-header-case.har');
    await gather('har', `${base}/redirect`, { quiet: true, wait: 1200, out });
    const entries = JSON.parse(readFileSync(out, 'utf8')).log.entries;
    const redirect = entries.find((entry) => entry.response.status === 302);
    assert(redirect, `the redirect entry must be recorded: ${JSON.stringify(entries.map((entry) => entry.response.status))}`);
    assert(
      redirect.response.redirectURL === '/final',
      `a redirect location must be read whatever case its name arrives in: ${JSON.stringify(redirect.response.redirectURL)}`,
    );
    assert(received.length > 0, 'the fixture must have received the POST');
    assert(
      received[0].includes('content-type'),
      `the POST must really arrive with a lower-case header name: ${JSON.stringify(received[0])}`,
    );
    const post = entries.find((entry) => entry.request.method === 'POST');
    assert(post, `the POST entry must be recorded: ${JSON.stringify(entries.map((entry) => entry.request.method))}`);
    assert(
      post.request.postData?.mimeType === 'application/json',
      `a request content-type must be read whatever case its name arrives in: ${JSON.stringify(post.request.postData)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


export async function testHarRedirects() {
  // Also covers the --bodies path: the document plus 12 scripts is more than the
  // body-fetch pool's in-flight limit, so the pool has to recycle its workers,
  // and the redirect entry must still end up with no body attached.
  const BODY_COUNT = 12;
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/start') {
      res.writeHead(302, { Location: '/final' });
      res.end('redirecting');
      return;
    }
    if (/^\/s\d+\.js$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(`window.__body_${path.slice(2, -3)} = true;`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const scripts = Array.from({ length: BODY_COUNT }, (_, i) => `<script src="/s${i}.js"></script>`).join('');
    res.end(`<!doctype html><title>ok</title><link rel="icon" href="data:,">${scripts}ok`);
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'network.har');
    const result = await gather('har', `http://127.0.0.1:${port}/start`, {
      quiet: true,
      // 2.5s, not the 250ms this test used before it asserted on bodies: the
      // subresource loadingFinished events that make a body retrievable can
      // arrive well after the load event on a heavily stolen-CPU box, so a
      // tight window makes --bodies assertions flap for environmental reasons.
      wait: 2500,
      bodies: true,
      out,
    });
    assert(result.statusBreakdown['302'] === 1, `HAR status breakdown missed redirect: ${JSON.stringify(result.statusBreakdown)}`);

    const summary = JSON.parse(readFileSync(join(tmp, 'network-summary.json'), 'utf8'));
    assert(
      summary.hygiene.redirects.some((r) => r.status === 302 && r.location === '/final'),
      `HAR summary missed redirect hygiene entry: ${JSON.stringify(summary.hygiene.redirects)}`,
    );

    // --bodies must attach every retrievable body, including past the pool's
    // concurrency limit, and must not attach one to the redirect entry.
    const har = JSON.parse(readFileSync(out, 'utf8'));
    const withBody = har.log.entries.filter((e) => e.response?.content?.text !== undefined);
    assert(
      withBody.length === BODY_COUNT + 1,
      `--bodies must capture ${BODY_COUNT + 1} bodies (document + ${BODY_COUNT} scripts), got ${withBody.length}`,
    );
    for (let i = 0; i < BODY_COUNT; i++) {
      const entry = har.log.entries.find((e) => e.request.url.endsWith(`/s${i}.js`));
      assert(
        entry?.response?.content?.text === `window.__body_${i} = true;`,
        `--bodies missed or corrupted /s${i}.js body: ${JSON.stringify(entry?.response?.content)}`,
      );
    }
    const redirectEntry = har.log.entries.find((e) => e.request.url.endsWith('/start'));
    assert(redirectEntry?.response?.content?.text == null, '--bodies must not attach a body to the redirect entry');
    const documentEntry = har.log.entries.find((e) => e.request.url.endsWith('/final'));
    assert(documentEntry?.response?.content?.text?.includes('ok'), '--bodies must capture the document body');
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// har records the network while a page loads, but a response can land after the
// fixed observation window: a fetch/XHR the page fires post-load, or a CDP event
// still queued under host CPU starvation. The primitive must settle the network
// before snapshotting rather than trusting the sleep, and it must say how long
// the load waiter took (web-uplift-e13). The server here deliberately holds the
// response past the window, so a primitive that trusts the sleep reports
// response.status 200 with no body and a non-zero pending count.
export async function testHarWaitsForPendingResponses() {
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/slow.json') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"slow":true}');
      }, 1500);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>slow-fixture</title><link rel="icon" href="data:,">' +
        '<script>fetch("/slow.json");</script><h1>slow</h1>',
    );
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'slow-network.har');
    const result = await gather('har', `http://127.0.0.1:${port}/`, { quiet: true, wait: 400, bodies: true, out });
    assert(Number.isFinite(result.loadWaitMs), `har must report how long the load waiter took: ${result.loadWaitMs}`);
    assert(
      result.networkPendingAtSnapshot === 0,
      `har must settle the network before snapshotting; ${result.networkPendingAtSnapshot} still pending`,
    );
    const har = JSON.parse(readFileSync(out, 'utf8'));
    const slow = har.log.entries.find((e) => e.request.url.endsWith('/slow.json'));
    assert(
      slow?.response?.content?.text === '{"slow":true}',
      `har must capture a body that arrives after the observation window: ${JSON.stringify(slow?.response?.content)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// The trackers primitive records HOSTNAMES, so a third party whose hostname
// merely ENDS WITH the first-party hostname ('notlocalhost' for a page on
// 'localhost') must still be counted, while a SUBDOMAIN of the first party
// ('sub.localhost') must not be. The old bare `!endsWith(firstParty)` suffix
// match classified the first case as first-party and dropped it, and with it any
// known tracker on such a host.
export async function testTrackersThirdPartySuffix() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>trackers-fixture</title><link rel="icon" href="data:,">' +
        '<img src="http://notlocalhost:9/tracker.js" alt="">' +
        '<img src="http://sub.localhost:9/sub.js" alt=""><h1>trackers fixture</h1>',
    );
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const result = await gather('trackers', `http://localhost:${port}/`, { quiet: true, wait: 1500 });
    const third = (result.topThirdPartyByRequests || []).map((e) => e.origin);
    assert(
      result.firstParty === 'localhost',
      `trackers must record the page hostname as firstParty, got ${result.firstParty}`,
    );
    assert(
      third.includes('notlocalhost'),
      `a third party whose host only ends with the first-party host must still be counted: ${JSON.stringify(third)}`,
    );
    assert(
      !third.includes('localhost'),
      `the first-party host itself must not be counted as third-party: ${JSON.stringify(third)}`,
    );
    // Without this the test still passes with the subdomain clause deleted from
    // isFirstPartyHost (a mutant reduced to `host === firstParty` classifies
    // sub.localhost as third-party).
    assert(
      !third.includes('sub.localhost'),
      `a SUBDOMAIN of the first-party host must count as first-party: ${JSON.stringify(third)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// web-uplift-1s8: a cap that drops evidence must say so, in the JSON and on
// stderr. The dom primitive's 200000-character CSS/HTML cap is the dangerous
// one: a model grepping the returned css for "@container" cannot otherwise tell
// "the site does not use container queries" from "the evidence was cut off".
export async function testEvidenceTruncationReporting() {
  const filler = 'z'.repeat(1000);
  const bigCss = Array.from({ length: 300 }, (_, i) => `.pad${i}{--filler-${i}:"${filler}"}`).join('\n');
  const pixel = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='), (c) => c.charCodeAt(0));

  const server = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/pixel.gif') {
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(pixel);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (path === '/over-cap') {
      res.end(`<!doctype html><title>over</title><style>${bigCss}</style><h1>over</h1>`);
      return;
    }
    if (path === '/under-cap') {
      res.end('<!doctype html><title>under</title><style>.a{color:#123}</style><h1>under</h1>');
      return;
    }
    if (path === '/many-images') {
      const imgs = Array.from({ length: 40 }, (_, i) => `<img src="/pixel.gif?i=${i}" alt="pixel ${i}" width="1" height="1">`).join('');
      res.end(`<!doctype html><title>images</title>${imgs}`);
      return;
    }
    if (path === '/many-cookies') {
      res.end("<!doctype html><title>cookies</title><script>for (let i = 0; i < 51; i++) document.cookie = 'cap' + i + '=1;path=/';</script>");
      return;
    }
    res.end('<!doctype html><title>empty</title>');
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    // Over the cap, through the real CLI: the JSON reports what was cut, stderr
    // says it out loud, and the shown text is exactly the cap.
    const cli = await runAsync(process.execPath, ['evidence/cli.mjs', 'dom', `${base}/over-cap`, '--wait', '250']);
    assert(cli.status === 0, `truncation: dom CLI failed:\n${cli.stderr}\n${cli.stdout}`);
    const over = JSON.parse(cli.stdout);
    assert(
      over.page.cssTruncated === true && over.page.cssChars > 200000 && over.page.css.length === 200000,
      `truncation: the 200KB CSS cap was not reported: ${JSON.stringify({ cssChars: over.page.cssChars, shown: over.page.css.length, truncated: over.page.cssTruncated })}`,
    );
    assert(
      over.page.outerHTML.length === Math.min(over.page.outerHTMLChars, 200000),
      'truncation: outerHTML length does not match its reported total',
    );
    assert(
      /WARNING: dom\.css/.test(cli.stderr),
      `truncation: the CLI did not warn about the cut CSS:\n${cli.stderr}`,
    );

    // Under the cap the same fields have to prove completeness: not truncated,
    // and the shown text is the whole text.
    const under = await gather('dom', `${base}/under-cap`, { quiet: true, wait: 250 });
    assert(
      under.page.cssTruncated === false && under.page.cssChars === under.page.css.length && under.page.css.length > 0,
      `truncation: a complete CSS sample was not reported as complete: ${JSON.stringify({ cssChars: under.page.cssChars, shown: under.page.css.length, truncated: under.page.cssTruncated })}`,
    );

    // The list caps report the same way: 40 images on the page, 30 listed.
    const images = await gather('images', `${base}/many-images`, { quiet: true, wait: 250 });
    assert(images.totalImages === 40, `truncation: images total is wrong: ${images.totalImages}`);
    assert(
      images.imagesInspected === 40 && images.imagesInspectedTruncated === false,
      `truncation: images inspection cap misreported: ${JSON.stringify({ inspected: images.imagesInspected, truncated: images.imagesInspectedTruncated })}`,
    );
    assert(
      images.imagesTruncated === true && images.images.length === 30,
      `truncation: images listing cap misreported: ${JSON.stringify({ listed: images.images.length, truncated: images.imagesTruncated })}`,
    );

    // 51 cookies set, 50 listed.
    const cookies = await gather('cookies', `${base}/many-cookies`, { quiet: true, wait: 250 });
    assert(cookies.totalCookies === 51, `truncation: cookies total is wrong: ${cookies.totalCookies}`);
    assert(
      cookies.cookiesTruncated === true && cookies.cookies.length === 50,
      `truncation: cookies listing cap misreported: ${JSON.stringify({ listed: cookies.cookies.length, truncated: cookies.cookiesTruncated })}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// The checks that turn on which modern CSS a page actually ships need the LIVE
// CSSOM, not a grep of the dom primitive's capped css string. This fixture
// covers every census source (document sheet with @import/@layer/@container/
// @starting-style/@scope/@supports/@property, a cross-origin sheet that must be
// skipped rather than crash the walk, a shadow-root adopted sheet, inline
// styles), the tracked feature rows, the overlay census, and the condition cap
// (web-uplift-xci).
export async function testFeaturesPrimitive() {
  // The cross-origin sheet has to be a different origin, and a different port
  // is a different origin, so a second server is the cheapest honest fixture.
  const cross = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end('.cross { color: orange; }');
  });
  await new Promise((resolveListen) => cross.listen(0, '127.0.0.1', resolveListen));
  const crossPort = cross.address().port;

  const css = [
    '@layer base, theme;',
    '@layer base { .a { color: light-dark(#111, #eee); } }',
    '@media (prefers-color-scheme: dark) { .a { color-scheme: dark; } }',
    '@container card (min-width: 300px) { .b { color: red; } }',
    '@starting-style { .c { opacity: 0; } }',
    '@scope (.scope-root) { .d { color: blue; } }',
    '@supports (color: light-dark(black, white)) { .e { color: light-dark(black, white); } }',
    '.f { container-type: inline-size; container-name: card; anchor-name: --a; position-try: --t; text-wrap: balance; }',
    '.g:has(> .h) { color: green; }',
    'dialog::backdrop { background: rgb(0 0 0 / 0.5); }',
    '.pop:popover-open { color: purple; }',
    '@keyframes fade { from { opacity: 0; } to { opacity: 1; } }',
    "@property --my-prop { syntax: '<length>'; inherits: false; initial-value: 0px; }",
    ':root { --brand: #123; --space: 4px; }',
  ].join('\n');
  const manyConditions = Array.from({ length: 70 }, (_, i) => `@media (min-width: ${100 + i}px) { .m${i} { color: red; } }`).join('\n');

  const page = (many) => [
    '<!doctype html><html><head><title>features</title>',
    ...(many ? [] : [`<link rel="stylesheet" href="http://127.0.0.1:${crossPort}/cross.css">`]),
    '<style>',
    "@import url('/imported.css');",
    many ? manyConditions : css,
    '</style></head><body>',
    '<div class="scope-root"><p class="d">scoped</p></div>',
    '<dialog open>native dialog</dialog>',
    '<div popover id="pop">popover</div>',
    '<details><summary>more</summary>body</details>',
    '<div role="dialog" aria-modal="true">div dialog</div>',
    '<div id="stack" style="position:fixed;z-index:60">stacked</div>',
    '<div id="inline" style="container-type:inline-size">inline container</div>',
    '<div id="host"></div>',
    '<script>',
    "  const root = document.getElementById('host').attachShadow({ mode: 'open' });",
    '  const sheet = new CSSStyleSheet();',
    "  sheet.replaceSync('.shadowed { interpolate-size: allow-keywords; }');",
    '  root.adoptedStyleSheets = [sheet];',
    "  root.innerHTML = '<span class=\"shadowed\">shadow</span>';",
    '</script>',
    '</body></html>',
  ].join('\n');

  const main = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/imported.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('.imported { animation-timeline: --t; }');
      return;
    }
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page(path === '/many'));
  });

  await new Promise((resolveListen) => main.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = main.address();
    const base = `http://127.0.0.1:${port}`;

    const result = await gather('features', `${base}/`, { quiet: true, wait: 600 });

    // Every style source is visited, and the unreadable one is counted, named,
    // and makes the census explicitly partial rather than silently thin.
    assert(result.censusComplete === false, `features: a cross-origin sheet must make the census incomplete: ${result.censusComplete}`);
    assert(result.sheets.crossOriginSkipped === 1, `features: the cross-origin sheet should be skipped and counted: ${JSON.stringify(result.sheets)}`);
    assert(
      result.sheets.crossOriginSheetUrls.some((u) => u.includes('/cross.css')),
      `features: the skipped sheet should be named so it can be checked another way: ${JSON.stringify(result.sheets.crossOriginSheetUrls)}`,
    );
    assert(result.sheets.importedSheetsFollowed === 1, `features: the @import sheet should be followed: ${JSON.stringify(result.sheets)}`);
    assert(result.sheets.shadowRootsScanned === 1, `features: the shadow root should be scanned: ${JSON.stringify(result.sheets)}`);
    assert(result.sheets.inlineStyleElements === 2, `features: both inline styles should be scanned: ${JSON.stringify(result.sheets)}`);

    const atRules = result.tracked.atRules;
    assert(
      atRules['@container'] === 1 && atRules['@starting-style'] === 1 && atRules['@scope'] === 1 &&
        atRules['@supports'] === 1 && atRules['@property'] === 1 && atRules['@layer'] === 2 && atRules['@view-transition'] === 0,
      `features: at-rule census is wrong: ${JSON.stringify(atRules)}`,
    );
    const props = result.tracked.properties;
    assert(
      props['container-type'] >= 2 && props['anchor-name'] === 1 && props['position-try-fallbacks'] === 1 &&
        props['animation-timeline'] === 1 && props['interpolate-size'] === 1 && props['color-scheme'] === 1 &&
        props['content-visibility'] === 0,
      `features: property census is wrong: ${JSON.stringify(props)}`,
    );
    assert(result.tracked.functions['light-dark'] >= 2, `features: light-dark() usage was not counted: ${JSON.stringify(result.tracked.functions)}`);
    const sels = result.tracked.selectors;
    assert(
      sels[':has('] === 1 && sels['::backdrop'] === 1 && sels[':popover-open'] === 1 && sels[':is('] === 0,
      `features: selector census is wrong: ${JSON.stringify(sels)}`,
    );
    assert(result.customProperties.distinct === 2, `features: custom properties were not counted: ${JSON.stringify(result.customProperties)}`);
    const conditionNames = Object.keys(result.conditions);
    assert(
      conditionNames.includes('@media (prefers-color-scheme: dark)') && conditionNames.some((c) => c.startsWith('@container card')),
      `features: conditional at-rule preludes should be in the census: ${JSON.stringify(conditionNames)}`,
    );

    const overlays = result.overlays;
    assert(
      overlays.dialogElements === 1 && overlays.openDialogs === 1 && overlays.popoverElements === 1 &&
        overlays.detailsElements === 1 && overlays.roleDialogElements === 1 && overlays.ariaModalElements === 1,
      `features: overlay census is wrong: ${JSON.stringify(overlays)}`,
    );
    assert(
      overlays.highZIndexCount === 1 && overlays.highZIndexMax === 60 && overlays.highZIndexExamples[0]?.id === 'stack',
      `features: the high z-index div was not surfaced: ${JSON.stringify(overlays)}`,
    );

    // The condition map is capped, and the cap is reported rather than silent.
    // This page has no cross-origin sheet, so it also proves the complete case.
    const capped = await gather('features', `${base}/many`, { quiet: true, wait: 500 });
    assert(capped.censusComplete === true, `features: a same-origin-only page should report a complete census: ${JSON.stringify(capped.sheets)}`);
    assert(
      capped.conditionsTotal === 70 && capped.conditionsTruncated === true && Object.keys(capped.conditions).length === 60,
      `features: the condition cap was not reported: ${JSON.stringify({ total: capped.conditionsTotal, shown: Object.keys(capped.conditions).length, truncated: capped.conditionsTruncated })}`,
    );
  } finally {
    await new Promise((resolveClose) => main.close(resolveClose));
    await new Promise((resolveClose) => cross.close(resolveClose));
  }
}


export async function testDiscoverabilityHelpers() {
  const { stripHtmlToText, contentTokens, detectEmptyMounts, contentPresentInRaw } = await import('../evidence/cli.mjs');

  // stripHtmlToText drops scripts/styles/markup, keeps visible text.
  const text = stripHtmlToText('<html><head><style>.x{color:red}</style></head><body><h1>Hello There</h1><script>var a=1</script><p>Body &amp; content</p></body></html>');
  assert(text.includes('Hello There') && text.includes('Body & content'), `stripHtmlToText missed content: ${text}`);
  assert(!text.includes('color:red') && !text.includes('var a'), `stripHtmlToText leaked script/style: ${text}`);

  // contentTokens keeps >=4-char words, lowercased, de-duped.
  const toks = contentTokens('The Thylakoid MEMBRANE membrane a to');
  assert(toks.has('thylakoid') && toks.has('membrane'), 'contentTokens missing expected words');
  assert(!toks.has('the') && !toks.has('to'), 'contentTokens should skip short words');
  assert(toks.size === 2, `contentTokens should de-dupe case-insensitively, got ${toks.size}`);

  // detectEmptyMounts flags an empty SPA root but not a filled one.
  assert(detectEmptyMounts('<div id="root"></div>').includes('#root'), 'should detect empty #root');
  assert(detectEmptyMounts('<div id="root"><h1>hi</h1></div>').length === 0, 'should not flag a filled #root');
  assert(detectEmptyMounts('<div id="__next">   </div>').includes('#__next'), 'should detect empty #__next');

  // contentPresentInRaw: inline markup and line breaks must not hide a
  // server-rendered h1/title (web-uplift-406). innerText collapses them, so the
  // verbatim-substring compare reported the h1 of paul.kinlan.me as missing.
  const rawFixture = stripHtmlToText('<html><head><title>Hello. I am Paul Kinlan.</title></head><body><h1 class="x">\n          Hello. I am <span class="fn">Paul Kinlan</span>.\n        </h1></body></html>');
  assert(contentPresentInRaw('Hello. I am Paul Kinlan.', rawFixture), `inline-span h1 should be present in raw text: ${rawFixture}`);
  assert(contentPresentInRaw('Hello. I am\n          Paul Kinlan.', rawFixture), 'a rendered value with line breaks should still match');
  assert(!contentPresentInRaw('Client Injected Heading', rawFixture), 'a JS-only heading must not read as present');
  assert(!contentPresentInRaw('', rawFixture) && !contentPresentInRaw(null, rawFixture), 'empty values are not present');
  // A value with no >=4-char tokens still compares, so it is not present by default.
  assert(contentPresentInRaw('Hi', '<p>Hi there</p>'), 'short text should be found when present');
  assert(!contentPresentInRaw('Hi', '<p>Bye there</p>'), 'short text should not be found when absent');
}


// End to end, through the real primitive: a server-rendered h1 broken up by an
// inline span and line breaks must report h1PresentInRaw true (the paul.kinlan.me
// shape, web-uplift-406), and an h1 that only JavaScript inserts must stay false,
// so the fix cannot be paid for by weakening the shell detection.
export async function testDiscoverabilityH1InRaw() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if ((req.url || '').startsWith('/markup')) {
      res.end('<!doctype html><html><head><title>Inline markup</title></head><body>' +
        '<h1 class="page-title">\n          Hello. I am <span class="fn">Paul Kinlan</span>.\n        </h1>' +
        '<p>A server-rendered paragraph with enough words for the coverage measure to compare.</p>' +
        '</body></html>');
      return;
    }
    res.end('<!doctype html><html><head><title>Client rendered</title></head><body>' +
      '<div id="app"></div>' +
      '<p>A server-rendered paragraph with enough words for the coverage measure to compare.</p>' +
      '<script>document.querySelector("#app").innerHTML = "<h1>Client Injected Heading</h1>";</script>' +
      '</body></html>');
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const markup = await gather('discoverability', `${base}/markup`, { quiet: true, wait: 0, screenshots: false });
    assert(markup.rendered.h1Count === 1, `discoverability: expected the rendered h1: ${JSON.stringify(markup.rendered)}`);
    assert(
      markup.h1PresentInRaw === true,
      `discoverability: an inline-span h1 was reported missing from the raw HTML: ${JSON.stringify(markup.rendered)}`,
    );

    const injected = await gather('discoverability', `${base}/client`, { quiet: true, wait: 0, screenshots: false });
    assert(injected.rendered.h1Count === 1, `discoverability: expected the JS-injected h1: ${JSON.stringify(injected.rendered)}`);
    assert(
      injected.h1PresentInRaw === false,
      `discoverability: a JS-injected h1 read as present in the raw HTML: ${JSON.stringify(injected.rendered)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// WCAG 2.2 SC 2.5.8 Target Size (Minimum) needs real geometry: the targets
// primitive enumerates pointer targets, flags anything under 24x24 CSS px, marks
// the inline-in-text and spacing exceptions it can read from geometry, and
// measures a desktop and a narrow layout by default (web-uplift-uz7).
export async function testTargetsPrimitive() {
  const page = [
    '<!doctype html><html><head><title>targets</title><style>',
    '  body { margin: 0; }',
    '  .tiny { width: 16px; height: 16px; padding: 0; border: 0; }',
    '  .big { width: 48px; height: 48px; }',
    '  .gap { margin-left: 200px; }',
    '  section, p { margin-bottom: 40px; }',
    '  p { font-size: 16px; line-height: 20px; }',
    '</style></head><body>',
    '<p>Read the <a class="tiny" href="#a" id="inline-link">text</a> in this sentence.</p>',
    '<section><button class="tiny" id="tight-a">a</button><button class="tiny" id="tight-b">b</button></section>',
    '<section><button class="tiny" id="spaced-a">a</button><button class="tiny gap" id="spaced-b">b</button></section>',
    '<section><button class="big" id="big-button">ok</button></section>',
    '<section><span style="display:none">hidden</span><a href="#z" style="width:0;height:0"></a></section>',
    '</body></html>',
  ].join('\n');
  const many = '<!doctype html><html><head><title>many</title><style>a{display:inline-block;width:8px;height:8px}</style></head><body>' +
    Array.from({ length: 420 }, (_, i) => `<a href="#${i}">${i}</a>`).join('') +
    '</body></html>';
  const empty = '<!doctype html><html><head><title>empty</title></head><body><p>No pointer targets at all here.</p></body></html>';

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (path === '/many') res.end(many);
    else if (path === '/empty') res.end(empty);
    else res.end(page);
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const result = await gather('targets', `${base}/page`, { quiet: true, wait: 250 });
    assert(result.minimumPx === 24, `targets: minimum should be 24 CSS px: ${result.minimumPx}`);
    assert(result.viewports.length === 2, `targets: expected a desktop and a narrow pass by default: ${result.viewports.length}`);
    const [desktop, narrow] = result.viewports;
    assert(
      desktop.name === 'desktop-1280x720' && desktop.viewport.width === 1280 && desktop.viewport.height === 720,
      `targets: the desktop pass did not measure a 1280x720 layout: ${JSON.stringify(desktop.viewport)}`,
    );
    assert(
      narrow.name === 'narrow-360x800' && narrow.viewport.width === 360 && narrow.viewport.height === 800,
      `targets: the narrow pass did not measure a 360x800 layout: ${JSON.stringify(narrow.viewport)}`,
    );

    const byId = new Map(desktop.targets.map((t) => [t.id, t]));
    const inline = byId.get('inline-link');
    assert(
      inline?.underMin === true && inline.inlineInText === true,
      `targets: an undersized link in a sentence should be flagged and marked inline-exempt: ${JSON.stringify(inline)}`,
    );
    for (const id of ['tight-a', 'tight-b']) {
      const t = byId.get(id);
      assert(
        t?.underMin === true && t.inlineInText === false && t.spacingPasses === false,
        `targets: ${id} is undersized with no spacing clearance and should say so: ${JSON.stringify(t)}`,
      );
    }
    for (const id of ['spaced-a', 'spaced-b']) {
      const t = byId.get(id);
      assert(
        t?.underMin === true && t.spacingPasses === true,
        `targets: ${id} is undersized but clears its neighbours and should say so: ${JSON.stringify(t)}`,
      );
    }
    const big = byId.get('big-button');
    assert(
      big?.underMin === false && big.spacingPasses === null,
      `targets: a 48x48 button is not undersized: ${JSON.stringify(big)}`,
    );
    assert(desktop.skippedZeroSizeCount === 1, `targets: the zero-size target should be skipped: ${desktop.skippedZeroSizeCount}`);
    assert(
      desktop.underMinCount === 5 &&
        desktop.underMinInlineExemptCount === 1 &&
        desktop.underMinSpacingExemptCount === 3 &&
        desktop.underMinNoKnownExemptionCount === 2,
      `targets: summary counts do not match the inventory: ${JSON.stringify({ underMin: desktop.underMinCount, inline: desktop.underMinInlineExemptCount, spacing: desktop.underMinSpacingExemptCount, none: desktop.underMinNoKnownExemptionCount })}`,
    );
    assert(
      narrow.underMinNoKnownExemptionCount === 2,
      `targets: the narrow pass should reach the same verdict on this fixture: ${narrow.underMinNoKnownExemptionCount}`,
    );

    // An explicit --viewport means one pass, and the inventory is capped with the
    // cap reported rather than silently trimmed.
    const manyResult = await gather('targets', `${base}/many`, { quiet: true, wait: 200, viewport: { w: 360, h: 800 } });
    assert(manyResult.viewports.length === 1, `targets: an explicit viewport should give one pass: ${manyResult.viewports.length}`);
    const capped = manyResult.viewports[0];
    assert(
      capped.matchedCount === 420 && capped.measuredCount === 400 && capped.omittedByCapCount === 20,
      `targets: the target cap was not reported: ${JSON.stringify({ matched: capped.matchedCount, measured: capped.measuredCount, omitted: capped.omittedByCapCount })}`,
    );
    assert(
      capped.underMinCount === 400 && capped.underMinNoKnownExemptionCount === 400,
      `targets: a wall of adjacent 8x8 links has no read exemption: ${JSON.stringify({ underMin: capped.underMinCount, noExemption: capped.underMinNoKnownExemptionCount })}`,
    );

    // No targets is a clean zero result, not an absent field: that is the
    // evidence a no-target page needs for the check to pass.
    const emptyResult = await gather('targets', `${base}/empty`, { quiet: true, wait: 200, viewport: { w: 360, h: 800 } });
    const none = emptyResult.viewports[0];
    assert(
      none.measuredCount === 0 && none.underMinNoKnownExemptionCount === 0 && none.targets.length === 0,
      `targets: a page with no targets should report zeroes: ${JSON.stringify({ measured: none.measuredCount, noExemption: none.underMinNoKnownExemptionCount })}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


export async function testResiliencePrimitive() {
  const swJs = [
    "const CACHE = 'fixture-v1';",
    "self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/offline.html']))); });",
    "self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });",
    'self.addEventListener(\'fetch\', (e) => {',
    // Navigations use the app-shell fallback (no network), so the fallback path
    // is deterministic offline; other requests go cache-first then network.
    "  if (e.request.mode === 'navigate') {",
    "    e.respondWith(caches.match(e.request).then((hit) => hit || caches.match('/offline.html')));",
    '    return;',
    '  }',
    "  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));",
    '});',
  ].join('\n');
  const manifest = JSON.stringify({
    name: 'Fixture App',
    short_name: 'Fixture',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: '#123456',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
  const pixel = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0),
  );
  const swPage = (title) => `<!doctype html><html><head><title>${title}</title>` +
    '<link rel="manifest" href="/manifest.webmanifest">' +
    '<script>navigator.serviceWorker.register("/sw.js")</script></head>' +
    `<body><h1>${title}</h1><p>Fixture body content for the resilience primitive.</p></body></html>`;
  // A page-controlled manifest href must not make the privileged Node process
  // fetch a private address: the guard has to refuse it and persist nothing into
  // the report (threat model I2 / F-003, web-uplift-2kh). 169.254.169.254 is the
  // cloud metadata service.
  const evilManifestPage = '<!doctype html><html><head><title>Evil manifest</title>' +
    '<link rel="manifest" href="http://169.254.169.254/latest/meta-data/"></head>' +
    '<body><h1>Evil manifest</h1></body></html>';

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    const send = (type, body, code = 200, extra = {}) => {
      res.writeHead(code, { 'Content-Type': type, ...extra });
      res.end(body);
    };
    if (path === '/sw.js') return send('text/javascript', swJs);
    if (path === '/manifest.webmanifest') return send('application/manifest+json', manifest);
    if (path === '/offline.html') {
      return send('text/html', '<!doctype html><html><head><title>Offline fallback</title></head>' +
        '<body><h1>Offline fallback</h1><p>Cached by the service worker.</p></body></html>');
    }
    if (path.startsWith('/icon-')) return send('image/png', pixel);
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === '/no-sw') {
      return send('text/html', '<!doctype html><html><head><title>No service worker</title></head>' +
        '<body><h1>No service worker</h1><p>Nothing resilient here.</p></body></html>');
    }
    if (path === '/evil-manifest') return send('text/html', evilManifestPage);
    // no-store, so the browser's HTTP cache cannot quietly stand in for the
    // service worker's fallback: offline emulation still serves cache hits.
    if (path === '/uncached-sw') return send('text/html', swPage('Uncached page with service worker'), 200, { 'Cache-Control': 'no-store' });
    return send('text/html', swPage('Fixture with service worker'));
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const out = join(tmp, 'resilience-sw.json');

    const withSw = await gather('resilience', `${base}/`, { quiet: true, wait: 800, out });
    assert(
      withSw.manifest.found === true && withSw.manifest.fields?.name === 'Fixture App' && withSw.manifest.icons.length === 2,
      `resilience: the manifest was not resolved with its fields: ${JSON.stringify(withSw.manifest)}`,
    );
    assert(
      withSw.serviceWorker.scriptTextHasFetchListener === true,
      `resilience: the fetch listener was not read from the worker script: ${JSON.stringify(withSw.serviceWorker)}`,
    );
    assert(
      withSw.serviceWorker.page.controller?.endsWith('/sw.js') === true,
      `resilience: the page should report its controller: ${JSON.stringify(withSw.serviceWorker.page)}`,
    );
    const cdpRegs = withSw.serviceWorker.cdp.registrations;
    assert(
      cdpRegs.some((r) => r.pageOrigin && r.scopeURL.startsWith(base)),
      `resilience: the page-origin registration should be in the CDP list: ${JSON.stringify(cdpRegs)}`,
    );
    assert(
      cdpRegs.some((r) => !r.pageOrigin),
      `resilience: the browser's own workers must be marked as not this origin: ${JSON.stringify(cdpRegs)}`,
    );
    const signals = withSw.installabilitySignals;
    assert(
      signals.secureContext === true && signals.manifestResolved === true && signals.hasName === true &&
        signals.has192Icon === true && signals.has512Icon === true && signals.displayStandaloneish === true &&
        signals.serviceWorkerRegistered === true && signals.serviceWorkerHasFetchListener === true,
      `resilience: installability signals are wrong: ${JSON.stringify(signals)}`,
    );

    // Offline: the precached URL renders from cache, controlled by the worker,
    // and the legible artifact is on disk.
    assert(
      withSw.offline.navigationFailed === false && withSw.offline.rendered?.title === 'Fixture with service worker',
      `resilience: the precached page should render offline: ${JSON.stringify(withSw.offline)}`,
    );
    assert(
      withSw.offline.rendered.controlled === true,
      `resilience: the offline render should be under the worker's control: ${JSON.stringify(withSw.offline.rendered)}`,
    );
    assert(
      typeof withSw.offline.screenshot === 'string' && statSync(withSw.offline.screenshot).size > 0,
      `resilience: the offline screenshot should exist: ${withSw.offline.screenshot}`,
    );

    // An uncached URL inside the worker's scope falls back to the offline page.
    const fallback = await gather('resilience', `${base}/uncached-sw`, { quiet: true, wait: 800, screenshots: false });
    assert(
      fallback.offline.navigationFailed === false && fallback.offline.rendered?.title === 'Offline fallback',
      `resilience: an uncached URL should render the fallback: ${JSON.stringify(fallback.offline)}`,
    );

    // Nothing resilient: the offline navigation fails and says why.
    const bare = await gather('resilience', `${base}/no-sw`, { quiet: true, wait: 500, screenshots: false });
    assert(
      bare.serviceWorker.page.registrations.length === 0 && bare.installabilitySignals.serviceWorkerRegistered === false,
      `resilience: a page without a worker should report none: ${JSON.stringify(bare.serviceWorker)}`,
    );
    assert(
      bare.manifest.found === false && bare.installabilitySignals.manifestResolved === false,
      `resilience: a page without a manifest should report none: ${JSON.stringify(bare.manifest)}`,
    );
    assert(
      bare.offline.navigationFailed === true && typeof bare.offline.errorText === 'string' && bare.offline.rendered === null,
      `resilience: offline navigation should fail with a net error: ${JSON.stringify(bare.offline)}`,
    );

    // A page-controlled manifest href pointing at a private address must be
    // refused by the guard, with no body persisted into the evidence.
    const evil = await gather('resilience', `${base}/evil-manifest`, { quiet: true, wait: 300, screenshots: false });
    assert(
      evil.manifest.found === false &&
        evil.manifest.data === null &&
        /refused:/.test(String(evil.manifest.fetchError)) &&
        evil.installabilitySignals.manifestResolved === false,
      `resilience: a manifest href pointing at a private address must be refused with nothing persisted: ${JSON.stringify(evil.manifest)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// be-resilient/offline-and-installable had no evidence path: the model could
// read the manifest and nothing else. This drives the real behaviour - install a
// service worker online, then go genuinely offline and reload: once for a
// precached URL (the cached page renders), once for an uncached one in scope
// (the offline fallback renders), and once on a page with nothing resilient at
// all (the navigation fails with a net error). It also checks that CDP's worker
// list is attributed per origin, because the domain also reports the browser's
// own extension workers (web-uplift-7v3).
// A service worker registration is reported by the ServiceWorker domain asynchronously, so
// under load it can land after the navigation settle window has closed. The primitive used
// to extend its wait only when a page-origin registration had ALREADY been observed - which
// is exactly the state the race produces - so a slow registration was snapshotted as no
// service worker at all: an intermittent false negative in an audit finding
// (web-uplift-5jd). This fixture makes the race deterministic instead of waiting for
// contention to produce it: the page registers its worker after the settle window expires,
// so the registration can only be reported if the primitive waits for it.
export async function testResilienceWaitsForLateServiceWorkerRegistration() {
  const swJs = [
    "self.addEventListener('install', (e) => { e.waitUntil(caches.open('late-v1').then((c) => c.addAll(['/']))); });",
    "self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)); });",
  ].join('\n');
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    const send = (type, body) => {
      res.writeHead(200, { 'Content-Type': type });
      res.end(body);
    };
    if (path === '/sw.js') return send('text/javascript', swJs);
    if (path === '/no-worker') {
      return send('text/html', '<!doctype html><html><head><title>No worker</title></head>' +
        '<body><h1>No worker</h1></body></html>');
    }
    return send('text/html', '<!doctype html><html><head><title>Late worker</title>' +
      // 1200ms is well past the 400ms settle passed below, so the registration is
      // guaranteed to be unobserved when the settle window closes.
      '<script>setTimeout(() => navigator.serviceWorker.register("/sw.js"), 1200);</script>' +
      '</head><body><h1>Late worker</h1></body></html>');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    // screenshots: false, matching the other resilience fixtures that assert state rather
    // than pixels: without it (or an `out` path) the primitive derives the offline
    // screenshot name from the report path and writes it into the working directory, which
    // leaves an untracked file in the checkout after every suite run.
    const result = await gather('resilience', `${base}/`, { quiet: true, wait: 400, screenshots: false });
    const regs = result.serviceWorker?.cdp?.registrations ?? [];
    assert(
      regs.some((r) => r.pageOrigin && String(r.scopeURL).startsWith(base)),
      `resilience: a registration landing after the settle window must still be reported, got ${JSON.stringify(regs)}`,
    );
    assert(
      result.serviceWorker?.scriptTextHasFetchListener === true,
      `resilience: the late worker's script must still be read, got ${JSON.stringify(result.serviceWorker)}`,
    );

    // The report has to say which of the two claims it is making. A worker observed inside
    // the window must not be recorded as an expired window (web-uplift-5jd).
    const seen = result.serviceWorker?.observation;
    assert(
      seen?.registrationObserved === true && seen?.budgetExhausted === false,
      `resilience: an observed registration must not be reported as an exhausted window, got ${JSON.stringify(seen)}`,
    );
    assert(
      seen?.budgetMs > 0 && seen?.waitedMs <= seen.budgetMs,
      `resilience: the observation window must be recorded with what was actually spent, got ${JSON.stringify(seen)}`,
    );

    // The other half of the distinction: a page with no worker at all. The primitive cannot
    // prove absence - it can only say the window closed with nothing observed - so the
    // artifact has to carry that caveat rather than leaving a reader to infer absence from
    // an empty list.
    const bare = await gather('resilience', `${base}/no-worker`, { quiet: true, wait: 400, screenshots: false });
    const unseen = bare.serviceWorker?.observation;
    assert(
      unseen?.registrationObserved === false && unseen?.budgetExhausted === true,
      `resilience: a page with no worker must be recorded as an expired window, not as an observation of one, got ${JSON.stringify(unseen)}`,
    );
    assert(
      typeof unseen?.note === 'string' && unseen.note.includes('not evidence of absence'),
      `resilience: an expired window must carry its caveat in the artifact itself, got ${JSON.stringify(unseen)}`,
    );
    assert(
      (bare.serviceWorker?.page?.registrations?.length ?? -1) === 0 &&
        bare.installabilitySignals?.serviceWorkerRegistered === false,
      `resilience: a page with no worker should still report none in the page view, got ${JSON.stringify(bare.serviceWorker?.page)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// be-inclusive/names-roles-labels and structure-and-focus cannot be judged from
// DOM attributes alone: aria-labelledby overrides aria-label, a name can come
// from title, and a subtree hidden by aria-hidden is still in the tab order.
// This drives the computed AX tree and the real tab order (web-uplift-5lp).
export async function testA11yTreePrimitive() {
  const page = [
    '<!doctype html><html lang="en"><head><title>a11y fixture</title><style>',
    '  body { margin: 0; font-family: sans-serif; }',
    '  button, input, a { display: inline-block; margin: 4px; }',
    '  .no-outline:focus { outline: none; }',
    '  .visible:focus { outline: 3px solid #f00; }',
    '</style></head><body>',
    '<header><h1>Accessibility fixture</h1></header>',
    '<nav aria-label="Main navigation"><a href="#1" id="first" class="visible">One</a><a href="#2" id="second">Two</a></nav>',
    '<main>',
    '<button id="labelled" aria-label="Ignored label" aria-labelledby="lbl">x</button><span id="lbl">Labelled by text</span>',
    '<button id="titled" title="Name from title"></button>',
    '<button id="no-outline" class="no-outline">No outline</button>',
    '<div aria-hidden="true"><button id="hidden-button">Hidden button</button></div>',
    '<a href="#skipped" id="tabindex-minus" tabindex="-1">Not in tab order</a>',
    '<input id="email" type="email" aria-label="Email address">',
    '<h2 id="heading-2">Section</h2>',
    '</main>',
    '<footer><a href="#3" id="third">Three</a></footer>',
    '</body></html>',
  ].join('\n');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page);
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const result = await gather('a11ytree', `http://127.0.0.1:${port}/`, { quiet: true, wait: 600 });

    const flat = [];
    const walk = (n) => {
      if (!n) return;
      flat.push(n);
      for (const child of n.children || []) walk(child);
    };
    walk(result.tree.root);
    const accessible = flat.filter((n) => !n.ignored);
    const named = (role, name) => accessible.find((n) => n.role === role && n.name === name);

    assert(
      named('navigation', 'Main navigation') && named('main') && named('contentinfo'),
      `a11ytree: landmark roles/names missing from the computed tree: ${JSON.stringify(result.tree.roleCounts)}`,
    );
    assert(
      !!named('button', 'Labelled by text'),
      `a11ytree: aria-labelledby should win over aria-label in the computed name: ${JSON.stringify(accessible.filter((n) => n.role === 'button'))}`,
    );
    assert(
      !!named('button', 'Name from title'),
      `a11ytree: a name coming from title should appear in the computed tree: ${JSON.stringify(accessible.filter((n) => n.role === 'button'))}`,
    );
    assert(
      !accessible.some((n) => n.role === 'button' && n.name === 'Hidden button'),
      'a11ytree: a button inside aria-hidden must not be exposed as an accessible button',
    );
    assert(result.tree.ignoredCount >= 1, `a11ytree: the aria-hidden subtree should be ignored: ${result.tree.ignoredCount}`);
    assert(
      result.tree.truncated === false && result.tree.maxDepth >= 3 && result.tree.totalNodes > 10,
      `a11ytree: the tree census looks wrong: ${JSON.stringify({ total: result.tree.totalNodes, projected: result.tree.nodesProjected, depth: result.tree.maxDepth })}`,
    );
    assert(
      result.tree.maxNodes === 400 && result.focusOrder.maxStops === 60,
      `a11ytree: the effective caps should be reported: ${JSON.stringify({ maxNodes: result.tree.maxNodes, maxStops: result.focusOrder.maxStops })}`,
    );

    // The real tab order: DOM order, tabindex=-1 skipped, and aria-hidden content
    // still reachable (which the tree says is hidden).
    const ids = result.focusOrder.stops.filter((s) => !s.isBody).map((s) => s.id);
    assert(
      JSON.stringify(ids) === JSON.stringify(['first', 'second', 'labelled', 'titled', 'no-outline', 'hidden-button', 'email', 'third']),
      `a11ytree: focus order is wrong: ${JSON.stringify(ids)}`,
    );
    assert(
      !ids.includes('tabindex-minus'),
      `a11ytree: tabindex=-1 must stay out of the tab order: ${JSON.stringify(ids)}`,
    );
    assert(
      result.focusOrder.stopsInsideAriaHidden === 1 && result.focusOrder.stops.some((s) => s.id === 'hidden-button' && s.insideAriaHidden === true),
      `a11ytree: the focusable element inside aria-hidden should be recorded as such: ${JSON.stringify(result.focusOrder.stops.map((s) => [s.id, s.insideAriaHidden]))}`,
    );
    assert(result.focusOrder.cycleDetected === true, 'a11ytree: the walk should detect the tab cycle wrapping');

    // Focus indicators: the author-suppressed one reads as none, the styled one
    // as visible.
    const noOutline = result.focusOrder.stops.find((s) => s.id === 'no-outline');
    const firstStop = result.focusOrder.stops.find((s) => s.id === 'first');
    assert(
      noOutline?.hasVisibleIndicator === false && noOutline.outline.style === 'none',
      `a11ytree: outline:none should read as no visible indicator: ${JSON.stringify(noOutline)}`,
    );
    assert(
      firstStop?.hasVisibleIndicator === true,
      `a11ytree: a 3px outline should read as a visible indicator: ${JSON.stringify(firstStop)}`,
    );

    // The caps are the model's to widen, and a widened or lowered cap is echoed
    // in the output rather than applied silently.
    const narrowCaps = await gather('a11ytree', `http://127.0.0.1:${port}/`, { quiet: true, wait: 400, maxNodes: 5, maxStops: 2 });
    assert(
      narrowCaps.tree.maxNodes === 5 && narrowCaps.tree.nodesProjected <= 5 && narrowCaps.tree.truncated === true,
      `a11ytree: --max-nodes should cap the projection and say so: ${JSON.stringify({ maxNodes: narrowCaps.tree.maxNodes, projected: narrowCaps.tree.nodesProjected, truncated: narrowCaps.tree.truncated })}`,
    );
    assert(
      narrowCaps.focusOrder.maxStops === 2 && narrowCaps.focusOrder.stopCount === 2 && narrowCaps.focusOrder.truncated === true,
      `a11ytree: --max-stops should cap the walk and say so: ${JSON.stringify({ maxStops: narrowCaps.focusOrder.maxStops, stops: narrowCaps.focusOrder.stopCount, truncated: narrowCaps.focusOrder.truncated })}`,
    );

    // A bad value must fall back to the documented default rather than
    // producing an empty tree.
    const badCaps = await gather('a11ytree', `http://127.0.0.1:${port}/`, { quiet: true, wait: 400, maxNodes: 0, maxStops: Number.NaN });
    assert(
      badCaps.tree.maxNodes === 400 && badCaps.focusOrder.maxStops === 60 && badCaps.tree.nodesProjected > 5,
      `a11ytree: invalid caps should fall back to the defaults: ${JSON.stringify({ maxNodes: badCaps.tree.maxNodes, maxStops: badCaps.focusOrder.maxStops, projected: badCaps.tree.nodesProjected })}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// web-uplift-17o, the census ENFORCED. The completeness claim is arithmetic, and this test is
// what keeps it true rather than read: every non-comment await line across the evidence modules
// must match exactly one disposition rule below, and each rule's count must equal its
// expectation. A NEW await that matches nothing fails HERE, naming the file, the line number
// and the text, so the next author classifies it (bounds it, or records the exclusion with
// its reason) in the census comment next to withDeadline in evidence/cdp.mjs - and a
// classification that drifts fails the same way. The expected counts live here, not in
// prose, so this is the one authoritative list; the comment summarises and points here.
export function testAwaitCensus() {
  // The rules match the ACTUAL bounded call sites, not shapes that merely look bounded: the
  // fetch rule requires the AbortSignal on the same line, so removing the signal leaves the
  // site UNCLASSIFIED (loud) rather than still "bounded"; and the primitive dispatch is
  // excluded, because it can run the unbounded content probes. Each site must match EXACTLY
  // ONE rule (checked below): first-match-permissive is how a dispatch got called bounded.
  // THE CENSUS'S LIMIT, stated plainly: it verifies that every site is CLASSIFIED. It cannot
  // verify that a bound is still PRESENT at a classified site - that is what review and the
  // targeted tests are for.
  const rules = [
    ['bounded:withDeadline', /await withDeadline\(|await withRetry\(/],
    ['bounded:navigate-helper', /await navigate\(/],
    // web-uplift-j3re listed the pipe readiness probe here as bounded by the enclosing
    // waitForPipeReady(). web-uplift-xnte proved that false - the loop consulted its deadline only in the
    // catch - and moved the probe into a race that owns its bound. The shape is therefore dropped from
    // this rule rather than left looking classified: a bare await of it reappearing is now UNCLASSIFIED
    // and loud, which is the truthful disposition, because no caller bounds it.
    ['bounded:transitive-caller-wraps', /await client\.Emulation\.(setEmulatedMedia|setDeviceMetricsOverride|setCPUThrottlingRate|setLocaleOverride|setTimezoneOverride)|await client\.Network\.emulateNetworkConditions|await client\.ServiceWorker\.enable/],
    ['bounded:sleep', /await sleep\(|await new Promise\(\(r\) => setTimeout/],
    ['bounded:pre-existing-mechanism', /await waitForProcExit|await waitForGroupDrain|port = await new Promise|await close\(\)|await result\.handle\.close\(\)|await launchChromeOnce|return await fn\(\)/],
    // web-uplift-4rv added two sites whose bound belongs to the CALLEE, which is why they are
    // classified here rather than wrapped: `connect(host, port, timeoutMs)` is handed its deadline
    // explicitly (the regex requires that argument, so removing it leaves the site UNCLASSIFIED
    // instead of quietly still 'bounded'), and `exposureProbe` is an injected probe whose
    // production default, cdpEndpointExposure, bounds its own sockets by PROBE_TIMEOUT_MS. Same
    // shape as `await launchChromeOnce`, which is bounded by the mechanism it contains.
    ['bounded:own-deadline', /await waitForNetworkIdle|await waitForInteractEvidence|await Promise\.race|await (?:fetch|pinnedFetch)\(.*AbortSignal|await fetched\.text\(\)|await docPromise|await exposureProbe\(|await waitForPipeReady\([^)]*deadlineMs|await Promise\.allSettled\(hosts\.map\(async \(host\) => connect\([^)]*timeoutMs\)\)\)/],
    ['bounded:gather-spine', /await launchChrome\(|await newSession\(|await attachConsoleCollector|await session\.close\(\)|await chrome\.close\(\)|await gather\(/],
    ['excluded:page-side-template', /await navigator\.|await fetch\(\$\{JSON\.stringify\(su\)\}, \{ signal: controller\.signal \}\)|const t = await res\.text\(\);/],
    ['excluded:primitive-probe', /await evaluate\(|captureScreenshot|getResponseBody|[Ss]creencast|HeapProfiler|axeSource|axe\.run|Accessibility|Input\.|getCookies|getLayoutMetrics|safeFetch\(|assertPageDerivedFetchAllowed|await lookup\(|await reader\.|res\.body|client\.Runtime\.evaluate|setBypassCSP|setScriptExecutionDisabled|getFullAXTree|await task\(item\)|await Promise\.all\(workers\)|await mapBounded\(|await fn\(session/],
  ];
  const expected = {
    'evidence/cdp.mjs': {
      // lsn3 and j3re moved these: the console redaction work, and then the pipe transport, which
      // adds five withDeadline-wrapped pipe calls, one bounded retry sleep, one grace-bounded
      // `await close()` on the pipe-readiness failure path, the readiness wait itself and the
      // Browser.getVersion probe inside its bounded loop. Every one is classified by the mechanism
      // that bounds it; none is a catch-all.
      'bounded:withDeadline': 17,
      // 9, not 7: the exposure verdict added a SECOND grace-bounded `await close()` on the path that
      // refuses an exposed launch (web-uplift-4rv), and every site in this bucket is the same
      // mechanism (waitForProcExit, waitForGroupDrain, the deadline-bounded endpoint wait, the
      // idempotent teardown, launchChromeOnce, withRetry's pass-through). The old count was never
      // wrong to the point of failing loudly: the unmatched-site assertion fires first and its
      // message hid this one behind it.
      // web-uplift-690r replaced the serial per-host probe loop with one Promise.all: the same number of
      // awaited sites in this file (the loop's await connect became the awaited Promise.all), so the
      // total is unchanged. The aggregate is bounded by the deadline each probe carries, not by their
      // sum - which is the point of the change.
      // web-uplift-py0e added four: the two liveness checks, each a bounded waitForProcExit settle plus
      // a teardown through the same `await close()` as every other launch failure - deliberately, so the
      // retry logic treats a browser that died during launch exactly like any other failed attempt.
      // web-uplift-uuod added one: the throwing-probe path now attributes the attempt and tears the
      // browser down exactly like every other launch failure, so it gained one `await close()`.
      'bounded:pre-existing-mechanism': 16,
      'bounded:sleep': 5,
      'bounded:gather-spine': 4,
      'excluded:primitive-probe': 2,
      // web-uplift-4rv: the exposure probe's own connect (handed timeoutMs) and the injected
      // exposureProbe, both bounded by the callee rather than by a wrapper at the call site.
      // web-uplift-j3re added a third: the pipe readiness wait, which takes deadlineMs.
      // web-uplift-xnte added a fourth: that wait now RACES its Browser.getVersion send against the
      // remaining budget and against process exit, so the send itself is bounded rather than only the
      // loop around it. The rule catches it because it matches await Promise.race.
      'bounded:own-deadline': 4,
      // web-uplift-j3re: the Browser.getVersion probe inside waitForPipeReady's bounded loop.
      // web-uplift-xnte moved that probe OUT of an awaited line and into the race that owns its bound, so
      // the rule matches nothing on this tree now. It is kept rather than deleted because applyConditions
      // and sw.enable still rely on it (see the rule above), and a bare await of the probe reappearing
      // would now be unclassified and loud - the truthful disposition, not an accident.
      'bounded:transitive-caller-wraps': 0,
    },
    'evidence/cli.mjs': {
      'bounded:gather-spine': 6,
      'excluded:primitive-probe': 1,
    },
    'evidence/common.mjs': {
      'bounded:transitive-caller-wraps': 6,
    },
    'evidence/fetch.mjs': {
      'excluded:primitive-probe': 3,
      'bounded:withDeadline': 1,
      'bounded:own-deadline': 1,
    },
    'evidence/primitives/a11ytree.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 5,
    },
    'evidence/primitives/axe.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 8,
    },
    'evidence/primitives/console.mjs': {
      'bounded:sleep': 2,
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 1,
      'bounded:own-deadline': 1,
    },
    'evidence/primitives/cookies.mjs': {
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 1,
    },
    'evidence/primitives/discoverability.mjs': {
      'excluded:primitive-probe': 6,
      'bounded:own-deadline': 1,
      'bounded:navigate-helper': 2,
      'bounded:sleep': 1,
    },
    'evidence/primitives/dom.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 1,
    },
    'evidence/primitives/evaluate.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 2,
    },
    'evidence/primitives/features.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 1,
    },
    'evidence/primitives/har.mjs': {
      'excluded:primitive-probe': 5,
      'bounded:sleep': 2,
      'bounded:navigate-helper': 1,
      'bounded:own-deadline': 1,
    },
    'evidence/primitives/headers.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:own-deadline': 1,
    },
    'evidence/primitives/heap.mjs': {
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 4,
      'bounded:sleep': 1,
    },
    'evidence/primitives/images.mjs': {
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 1,
    },
    'evidence/primitives/layout.mjs': {
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 4,
      'bounded:sleep': 1,
    },
    'evidence/primitives/resilience.mjs': {
      'bounded:transitive-caller-wraps': 1,
      'bounded:withDeadline': 4,
      'bounded:navigate-helper': 1,
      'bounded:sleep': 3,
      'excluded:primitive-probe': 6,
      'excluded:page-side-template': 1,
      'bounded:own-deadline': 3,
    },
    'evidence/primitives/screenshot.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 2,
    },
    'evidence/primitives/secrets.mjs': {
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 7,
      'excluded:page-side-template': 1,
    },
    'evidence/primitives/targets.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 1,
    },
    'evidence/primitives/trace.mjs': {
      'bounded:withDeadline': 8,
      'bounded:sleep': 2,
    },
    'evidence/primitives/trackers.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
    },
    'evidence/primitives/video.mjs': {
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 4,
      'bounded:sleep': 2,
    },
  };
  function findEvidenceFiles(dir) {
    const res = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) res.push(...findEvidenceFiles(full));
      else if (ent.isFile() && ent.name.endsWith('.mjs')) res.push(full);
    }
    return res;
  }
  const allEvidenceFiles = findEvidenceFiles(join(repoRoot, 'evidence')).map((p) => relative(repoRoot, p));
  for (const f of allEvidenceFiles) {
    const content = readFileSync(join(repoRoot, f), 'utf8');
    const hasAwait = content.split('\n').some((ln) => ln.includes('await ') && !ln.trim().startsWith('//'));
    if (hasAwait) {
      assert(expected[f], `await census: ${f} contains non-comment await statements but is not covered in expected map!`);
    }
  }
  for (const [file, expect] of Object.entries(expected)) {
    const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
    const counts = {};
    const unmatched = [];
    let total = 0;
    lines.forEach((ln, i) => {
      if (!ln.includes('await ') || ln.trim().startsWith('//')) return;
      total += 1;
      const matches = rules.filter(([, re]) => re.test(ln));
      if (matches.length !== 1) {
        unmatched.push(
          `${file}:${i + 1} [${matches.length === 0 ? 'NO' : matches.length + ' (' + matches.map((m) => m[0]).join(',') + ')'} rule match(es)]: ${ln.trim().slice(0, 100)}`,
        );
        return;
      }
      counts[matches[0][0]] = (counts[matches[0][0]] || 0) + 1;
    });
    assert(
      unmatched.length === 0,
      `await census: ${unmatched.length} await site(s) in ${file} match NO disposition rule - classify them in the census comment next to withDeadline in evidence/cdp.mjs and in this test:\n  ${unmatched.join('\n  ')}`,
    );
    const expectTotal = Object.values(expect).reduce((a, b) => a + b, 0);
    assert(
      total === expectTotal,
      `await census: ${file} has ${total} non-comment await sites but the census expects ${expectTotal} - a site was added or removed without updating the census (testAwaitCensus + the comment next to withDeadline)`,
    );
    for (const [name, n] of Object.entries(expect)) {
      assert(
        (counts[name] || 0) === n,
        `await census: ${file} disposition '${name}' holds ${counts[name] || 0} site(s), expected ${n} - a classification drifted; update the census with the reason`,
      );
    }
  }
}


export const evidenceTests = [
  testPreNavigationEmulation,
  testAxePrimitiveBypassesStrictCsp,
  testAxeKeepsPagePolicyAndDisclosesInjectionBypass,
  testThrottlingConditions,
  testLocaleTimezoneConditions,
  testConsoleEvidence,
  testConsoleEvidenceRedaction,
  testConsoleInteractDeadlineValidation,
  testHeadersPrimitiveFindsHeadersRegardlessOfNameCase,
  testHeadersPrimitiveSurvivesSlowResponseUnderLoad,
  testHarReadsRequestContentTypeAndRedirectLocationRegardlessOfCase,
  testHarRedirects,
  testHarWaitsForPendingResponses,
  testTrackersThirdPartySuffix,
  testEvidenceTruncationReporting,
  testFeaturesPrimitive,
  testDiscoverabilityHelpers,
  testDiscoverabilityH1InRaw,
  testTargetsPrimitive,
  testResiliencePrimitive,
  testResilienceWaitsForLateServiceWorkerRegistration,
  testA11yTreePrimitive,
  testAwaitCensus,
  testNoSourceArgumentOmitsSource,
  testAdversarialPageCannotInfluenceSource,
  testExplicitSourceHonoursOperatorSpecifiedRoot,
];

export {
  testConsoleEvidenceRedaction,
  testNoSourceArgumentOmitsSource,
  testAdversarialPageCannotInfluenceSource,
  testExplicitSourceHonoursOperatorSpecifiedRoot,
};

await runSuite(evidenceTests, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
