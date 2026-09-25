// Thin Chrome DevTools Protocol launcher + client wrapper.
//
// This deliberately uses the raw CDP via the `chrome-remote-interface` package
// (a thin CDP client, NOT a browser-automation framework). We drive the system
// Chrome at /usr/bin/google-chrome-stable, launched headless with an ephemeral
// debugging port, and parse the chosen port from Chrome's stderr. No Playwright,
// no Puppeteer.
//
// IMPORTANT: this module is a GENERIC harness. It makes no judgements and knows
// nothing about principles, checks, or what "good" looks like. It only knows how
// to launch Chrome, open a session, navigate, and run model-supplied code in the
// page. The intelligence lives in the model (following SKILL.md), not here.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CDP from 'chrome-remote-interface';

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function resolveChromePath() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No Chrome binary found. Tried: ${CHROME_CANDIDATES.join(', ')}. ` +
      'Set CHROME_BIN to override.',
  );
}

// Launch headless Chrome with an ephemeral remote-debugging port and return a
// handle. We parse the actual port from the "DevTools listening on ws://..."
// line Chrome prints to stderr (remote-debugging-port=0 picks a free port).
export async function launchChrome({ log = () => {}, headless = true } = {}) {
  const chromePath = resolveChromePath();
  const userDataDir = mkdtempSync(join(tmpdir(), 'web-uplift-cdp-'));
  log(`[browser] launching ${chromePath} (${headless ? 'headless' : 'headed'}, profile ${userDataDir})`);

  const proc = spawn(
    chromePath,
    [
      // Headed for `flow record` (the user interacts); headless everywhere else.
      ...(headless ? ['--headless=new'] : []),
      '--remote-debugging-port=0',
      '--no-sandbox',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars=false',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for Chrome DevTools endpoint')),
      20000,
    );
    proc.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      const match = buf.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited early (code ${code}) before listening`));
    });
  });

  log(`[browser] DevTools port ${port}`);

  async function close() {
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  return { proc, port, userDataDir, close };
}

// Open a fresh CDP session against a new target (tab) and enable the domains we
// rely on across the auditor. Returns the CDP client plus a per-target cleanup.
export async function newSession(port, { log = () => {} } = {}) {
  // Create a dedicated target so emulation overrides do not leak between pages.
  const browser = await CDP({ port });
  const { targetId } = await browser.Target.createTarget({ url: 'about:blank' });
  await browser.close();

  const client = await CDP({ port, target: targetId });
  const { Page, Runtime, DOM, CSS, Emulation, Network } = client;
  await Promise.all([
    Page.enable(),
    Runtime.enable(),
    DOM.enable(),
    CSS.enable(),
    Network.enable(),
  ]);
  void Emulation;
  log('[browser] session ready');

  async function close() {
    try {
      await client.close();
    } catch {
      // ignore
    }
    try {
      const tmp = await CDP({ port });
      await tmp.Target.closeTarget({ targetId });
      await tmp.close();
    } catch {
      // ignore
    }
  }

  return { client, targetId, close };
}

// Navigate and wait for the load event plus a short settle window so that
// late-injected content (e.g. the playground's 600ms banner) and post-load
// layout shifts have a chance to occur before we measure.
//
// The playground is a single-document hash-routed SPA, so navigating directly
// from #a to #b is a same-document change that does NOT fire the load event.
// To get a clean, fully-reloaded document for each check (and to re-run the
// scenario's mount + injected styles from scratch), we always route through
// about:blank first, forcing a real load of the target URL.
export async function navigate(
  client,
  url,
  { settleMs = 1200, log = () => {}, beforeTargetNavigate = null } = {},
) {
  const { Page } = client;

  const blanked = Page.loadEventFired();
  await Page.navigate({ url: 'about:blank' });
  await blanked;

  if (beforeTargetNavigate) await beforeTargetNavigate();

  const loaded = Page.loadEventFired();
  await Page.navigate({ url });
  await loaded;
  log(`[browser] loaded ${url}`);
  if (settleMs > 0) {
    await new Promise((r) => setTimeout(r, settleMs));
  }
}

// Run an arbitrary expression in the page and return its value. This is the
// model's escape hatch: it can pass any probe / ad-hoc static test it writes at
// inspection time. The harness does not interpret what the expression means.
export async function evaluate(client, expression, { awaitPromise = true } = {}) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (exceptionDetails) {
    throw new Error(
      `evaluate failed: ${exceptionDetails.text} ${
        exceptionDetails.exception?.description ?? ''
      }`,
    );
  }
  return result.value;
}

// --- console evidence ------------------------------------------------------
//
// What a page LOGS while it is being measured is evidence in its own right: an
// uncaught exception during load explains a broken interaction, and the audit's
// no-console-errors check needs it first-party (an evaluate probe that runs
// after load cannot see what already fired). Runtime.enable is already on from
// newSession; Log.enable adds browser-level entries (failed resource loads, CSP
// violations, deprecations) that never reach console.*.
//
// This is a generic harness: it collects and counts, the model judges. Console
// errors, warnings and assert calls, every uncaught exception, and browser log
// errors/warnings are recorded (deduplicated with a repeat count, then capped);
// info/log/debug chatter only bumps a counter so a noisy page cannot bury the
// signal.
//
// Attached to the client so every primitive can report what the page logged
// while it was being measured, not just the dedicated `console` primitive.
const collectors = new WeakMap();
const CONSOLE_ENTRY_CAP = 100;
const CONSOLE_BUFFER_CAP = 500;

export async function attachConsoleCollector(client, { log = () => {} } = {}) {
  const entries = [];
  const byKey = new Map(); // dedupe key -> recorded entry (with a repeat count)
  let ignoredCount = 0; // info/log/debug/verbose, counted but not itemised
  let droppedCount = 0; // past the buffer cap

  const record = (entry) => {
    // The url is part of the identity when there is one: two different failed
    // resources are different findings, while a retry loop hitting the same
    // resource collapses into a repeat count.
    const key = [entry.kind, entry.level, entry.source, entry.url || '', entry.text].join('|');
    const existing = byKey.get(key);
    if (existing) {
      existing.repeat++;
      return;
    }
    if (byKey.size >= CONSOLE_BUFFER_CAP) {
      droppedCount++;
      return;
    }
    const stored = { ...entry, repeat: 1 };
    byKey.set(key, stored);
    entries.push(stored);
  };

  const textOfArg = (arg) => {
    if (!arg) return '';
    if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : String(arg.value);
    return arg.description || arg.unserializableValue || arg.type || '';
  };
  const framesOf = (stackTrace) =>
    (stackTrace?.callFrames || [])
      .slice(0, 3)
      .map((f) => `${f.functionName || '<anonymous>'} (${f.url || '?'}:${f.lineNumber + 1}:${f.columnNumber + 1})`);

  client.Runtime.consoleAPICalled(({ type, args, stackTrace }) => {
    const text = (args || []).map(textOfArg).join(' ').trim();
    if (type === 'error' || type === 'assert') {
      const stack = framesOf(stackTrace);
      record({ kind: 'console', level: 'error', source: 'console', text, ...(stack.length ? { stack } : {}) });
    } else if (type === 'warning' || type === 'warn') {
      record({ kind: 'console', level: 'warning', source: 'console', text });
    } else {
      ignoredCount++;
    }
  });

  client.Runtime.exceptionThrown(({ exceptionDetails }) => {
    const ex = exceptionDetails || {};
    record({
      kind: 'exception',
      level: 'error',
      source: 'runtime',
      text: ex.exception?.description || ex.text || 'Uncaught exception',
      ...(ex.url ? { url: ex.url } : {}),
      ...(ex.lineNumber != null ? { line: ex.lineNumber + 1 } : {}),
      stack: framesOf(ex.stackTrace),
    });
  });

  client.Log.entryAdded(({ entry }) => {
    const e = entry || {};
    if (e.level === 'error' || e.level === 'warning') {
      record({
        kind: 'log',
        level: e.level,
        source: e.source || 'browser',
        text: e.text || '',
        ...(e.url ? { url: e.url } : {}),
        ...(e.lineNumber != null ? { line: e.lineNumber } : {}),
      });
    } else {
      ignoredCount++;
    }
  });

  await Promise.all([
    client.Runtime.enable().catch(() => {}),
    client.Log.enable().catch((err) => log(`[evidence] console collector: Log.enable failed: ${err.message}`)),
  ]);

  function summary() {
    const consoleErrorCount = entries.filter((e) => e.kind === 'console' && e.level === 'error').length;
    const exceptionCount = entries.filter((e) => e.kind === 'exception').length;
    const warningCount = entries.filter((e) => e.level === 'warning').length;
    // Failed resource loads arrive through the browser log (Log.entryAdded,
    // source 'network'), not through console.*. Splitting them out keeps the
    // page-authored signal (console errors + exceptions) separate from broken
    // subresource requests; Chrome's automatic /favicon.ico request shows up
    // here on any site that does not serve one, and is not a page-authored
    // console error.
    const networkErrorCount = entries.filter((e) => e.source === 'network').length;
    const browserLogErrorCount = entries.filter(
      (e) => e.kind === 'log' && e.level === 'error' && e.source !== 'network',
    ).length;
    const errorCount = consoleErrorCount + networkErrorCount + browserLogErrorCount;
    const shown = entries.slice(0, CONSOLE_ENTRY_CAP).map((e) => ({ ...e }));
    return {
      entryCount: entries.length,
      consoleErrorCount,
      exceptionCount,
      warningCount,
      networkErrorCount,
      browserLogErrorCount,
      errorCount,
      hasErrors: errorCount > 0 || exceptionCount > 0,
      entries: shown,
      entriesTotal: entries.length,
      entriesTruncated: entries.length > CONSOLE_ENTRY_CAP,
      ...(ignoredCount ? { ignoredMessageCount: ignoredCount } : {}),
      ...(droppedCount ? { droppedMessageCount: droppedCount } : {}),
      note: 'What the page logged while this primitive was measuring it: console errors, console warnings, uncaught exceptions, and browser log errors/warnings. networkErrorCount counts failed subresource requests (a broken first-party script or stylesheet is a real defect; Chrome\'s automatic /favicon.ico 404 is not page-authored - the entry carries the url so you can tell them apart). Identical messages are deduplicated and carry a repeat count. Descriptive signal, not a verdict: judge each entry against follow-best-practices/no-console-errors, and weigh it by whose code it is - a third-party analytics failure is not the same finding as a first-party TypeError.',
  };
  }

  const collector = { entries, summary };
  collectors.set(client, collector);
  log('[evidence] console collector attached (Runtime + Log)');
  return collector;
}

// Join a primitive's evidence with what the page logged during it, so the
// returned evidence (stdout) and the JSON artifact a primitive writes agree.
// Only attached when the page actually logged something: a clean page must not
// bloat every primitive's output with an empty console block. Returns the block
// that was attached, or null.
export function attachConsoleEvidence(client, result) {
  const collector = collectors.get(client);
  if (!collector || !result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (result.console) return result.console;
  const block = collector.summary();
  if (!block.entryCount) return null;
  result.console = block;
  return block;
}

// Launch Chrome, open a session, run the body, and always clean up. A thin
// convenience so each primitive does not repeat the launch/teardown dance.
export async function withSession(fn, { log = () => {} } = {}) {
  const chrome = await launchChrome({ log });
  try {
    const session = await newSession(chrome.port, { log });
    try {
      return await fn(session.client, { chrome, session });
    } finally {
      await session.close();
    }
  } finally {
    await chrome.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };
