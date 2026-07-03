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
