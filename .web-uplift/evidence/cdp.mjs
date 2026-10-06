// Thin Chrome DevTools Protocol launcher + client wrapper.
//
// This deliberately uses the raw CDP via the `chrome-remote-interface` package
// (a thin CDP client, NOT a browser-automation framework). We drive a locally
// installed Chrome - CHROME_BIN/CHROME_PATH, a versioned Chrome for Testing or
// Puppeteer cache, or a distro binary (see chromeCandidates) - launched headless
// with an ephemeral debugging port, and parse the chosen port from Chrome's
// stderr. No Playwright, no Puppeteer.
//
// IMPORTANT: this module is a GENERIC harness. It makes no judgements and knows
// nothing about principles, checks, or what "good" looks like. It only knows how
// to launch Chrome, open a session, navigate, and run model-supplied code in the
// page. The intelligence lives in the model (following SKILL.md), not here.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import CDP from 'chrome-remote-interface';

// Chrome binary discovery. Env overrides come first (CHROME_PATH is honoured as
// an alias of CHROME_BIN because other Chrome tooling uses it), then the
// versioned caches Chrome for Testing and Puppeteer install into, then the
// distro paths. A fleet VM has no distro Chrome at all, so without the cache
// entries the harness could only run with CHROME_BIN exported by hand.
const CHROME_ENV_VARS = ['CHROME_BIN', 'CHROME_PATH'];

// Each cached install lands under its own versioned directory, so these are
// globbed one level deep rather than pinned to a version.
const CHROME_CACHE_LAYOUTS = [
  ['.cache', 'chrome'], // Chrome for Testing / @puppeteer/browsers default cache
  ['.cache', 'puppeteer', 'chrome'], // Puppeteer's own cache
];

function chromeCacheGlobs(home) {
  return CHROME_CACHE_LAYOUTS.map((parts) => join(home, ...parts, '*', 'chrome-linux64', 'chrome'));
}

// A candidate path can exist without being a usable binary: a directory, a
// zero-byte file, or a partial extraction left by an interrupted cache
// download. Returning one of those defers the failure to spawn (EACCES) instead
// of falling through to the next candidate, so require an executable file.
function isExecutableFile(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function cachedChromeCandidates(home) {
  const found = [];
  for (const parts of CHROME_CACHE_LAYOUTS) {
    const root = join(home, ...parts);
    let versions;
    try {
      versions = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); // newest version first
    } catch {
      continue; // no such cache on this machine
    }
    for (const version of versions) {
      const binary = join(root, version, 'chrome-linux64', 'chrome');
      if (isExecutableFile(binary)) found.push(binary);
    }
  }
  return found;
}

function chromeCandidates(home) {
  const overrides = CHROME_ENV_VARS.map((name) => process.env[name]).filter(Boolean);
  const distro = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return [...new Set([...overrides, ...cachedChromeCandidates(home), ...distro])];
}

export function resolveChromePath() {
  const home = homedir();
  const candidates = chromeCandidates(home);
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new Error(
    `No Chrome binary found. Tried: ${candidates.join(', ')}. ` +
      `Cache locations searched: ${chromeCacheGlobs(home).join(' and ')}. ` +
      'Set CHROME_BIN (or CHROME_PATH) to override.',
  );
}

// --- deterministic browser teardown ---------------------------------------
//
// Chrome boots a whole tree (browser, zygote, renderers, gpu, crashpad) and
// re-flushes its profile (Local State, Variations) while it shuts down. So
// teardown must signal the TREE, wait for it to be gone, escalate to SIGKILL if
// it is not, and only then remove the profile dir. A single SIGTERM to the
// main pid plus an immediate rmSync leaves (a) a wedged browser when the main
// pid never processes the signal and (b) a /tmp/web-uplift-cdp-* husk per boot
// when Chrome re-creates the files the rmSync just deleted.

const TERM_GRACE_MS = 5000; // SIGTERM -> wait for a graceful browser shutdown
const KILL_GRACE_MS = 2000; // SIGKILL -> wait for even a wedged tree to die
const GROUP_DRAIN_MS = 1000; // stragglers (crashpad) after the main pid exits

// Browsers this process has launched but not torn down. Chrome is spawned
// detached, so its pid IS its process-group id: kill(-pid) reaches the whole
// tree and can never include this process or its own group.
const liveBrowsers = new Set();
let interruptNetInstalled = false;

// Ctrl-C (SIGINT), CI timeouts (SIGTERM) and terminal close (SIGHUP) kill this
// process WITHOUT running 'exit' handlers (Node's default signal death skips
// them), so the async close() below cannot run. This synchronous net SIGKILLs
// every still-live browser group and drops its profile dir, then restores the
// default disposition. Installed on the first launch, never at import time,
// so importing this module stays side-effect free.
function installInterruptNet() {
  if (interruptNetInstalled) return;
  interruptNetInstalled = true;
  const sweep = () => {
    for (const browser of liveBrowsers) {
      killGroup(browser, 'SIGKILL');
      removeDirNow(browser.userDataDir);
    }
  };
  process.on('exit', sweep);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      sweep();
      // Our once-listener has already been removed. If nobody else listens,
      // re-deliver so the process still dies the way it would have without us.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}

// Record the process-group id a launched browser runs in. Chrome is spawned
// detached, so it leads its own process group and its pid IS that group id; we
// read it back instead of assuming it, so killGroup() can refuse to signal a
// group it cannot tie to this child. Without /proc (non-Linux) the
// detached-spawn contract is the only proof available, so record the pid.
function readPgid(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm can contain spaces and parentheses, so the fixed-width fields start
    // after the last ')'; pgrp is the third of them.
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  } catch {
    return pid;
  }
}

// Signal the whole browser tree, but only ever a group we can prove is this
// child's: the recorded pgid has to be the child's own pid. When they differ
// (the child is not its own group leader) -pgid could name an unrelated group,
// so signal the single pid instead. That fallback also covers a group that is
// already gone (ESRCH) or a platform without groups; already-dead errors are
// ignored either way.
function killGroup(browser, signal) {
  const { proc, pgid } = browser;
  if (pgid === proc.pid) {
    try {
      process.kill(-pgid, signal);
      return;
    } catch {
      // no such group any more; the main pid may still be worth signalling
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // already dead
  }
}

function groupHasMembers(proc) {
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function procExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function waitForProcExit(proc, ms) {
  if (procExited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    function finish(result) {
      clearTimeout(timer);
      proc.removeListener('exit', onExit);
      resolve(result);
    }
    function onExit() {
      finish(true);
    }
    const timer = setTimeout(() => finish(false), ms);
    proc.on('exit', onExit);
  });
}

// Bounded wait for the group to be empty after the main pid is gone, so a
// straggler cannot re-create profile files under the dir we are about to rm.
function waitForGroupDrain(proc, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    (function poll() {
      if (!groupHasMembers(proc)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(poll, 50);
    })();
  });
}

function removeDirNow(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// The per-attempt endpoint wait is deliberately kept near 20 s, and the number
// comes from data rather than feel: a healthy launch on this VM measured 979 ms
// min / 1397 ms median / 2003 ms p90-max across 8 launches with these exact
// flags at ~84% CPU steal. That is 10-20x a normal launch, so this constant is
// NOT the binding constraint. When it fires, Chrome never printed the DevTools
// line at all, which is a failed or wedged start (crash, unusable profile, lost
// race), not a slow one; a larger number would only turn a fast failure into a
// slow one. The fix for that is retrying the launch, not waiting longer.
const DEVTOOLS_ENDPOINT_TIMEOUT_MS = 20000;

// Hard deadlines for the CDP waits. A starved host can leave a browser that
// never answers: Page.loadEventFired never fires, the attach never completes,
// the domain enables never resolve. Until these bounds existed a run on such a
// host hung forever (the dl6 reproduction), and nothing on the path failed
// loudly. Now every wait on the attach and navigation path is bounded, and the
// failure names what it waited for, the bound, and how to raise it
// (--cdp-deadline / WEB_UPLIFT_CDP_DEADLINE_MS). The defaults are overridable
// per call so tests can use tiny values, and from the CLI via
// configureCdpDeadlines (main wires the flag and the environment there).
let navigationDeadlineMsDefault = 30000;
let cdpCallDeadlineMsDefault = 30000;

export function configureCdpDeadlines({ navigationMs, callMs } = {}) {
  if (Number.isFinite(navigationMs) && navigationMs > 0) navigationDeadlineMsDefault = navigationMs;
  if (Number.isFinite(callMs) && callMs > 0) cdpCallDeadlineMsDefault = callMs;
}

// Bound a CDP wait. A rejection carries the bound, what was being awaited, and
// how to raise the bound, so a starved host produces an actionable error
// instead of an indefinite hang.
export function withDeadline(promise, ms, description) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(
        new Error(
          `web-uplift: timed out after ${ms}ms waiting for ${description} ` +
            '(raise the bound with --cdp-deadline <ms> or WEB_UPLIFT_CDP_DEADLINE_MS)',
        ),
      );
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (e) => {
        clearTimeout(timer);
        rejectPromise(e);
      },
    );
  });
}

// A wedge or a lost race is transient and a fresh attempt is cheap (1-2 s), so
// retry the WHOLE launch - new profile dir included - with a small jittered
// backoff rather than a fixed lockstep delay on an already starved box.
const LAUNCH_ATTEMPTS = 3;
const LAUNCH_BACKOFF_BASE_MS = 250;
const LAUNCH_BACKOFF_MAX_MS = 1000;

function launchBackoffMs(attempt) {
  const base = Math.min(LAUNCH_BACKOFF_MAX_MS, LAUNCH_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * LAUNCH_BACKOFF_BASE_MS);
}

// Load and since-boot CPU steal, so a starved host can be told from a broken
// launch at a glance. Linux-only (this module already reads /proc for pgid);
// absent fields are omitted rather than guessed.
function hostLoadSummary() {
  const parts = [];
  try {
    const [one, five, fifteen] = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/);
    parts.push(`load=${one}/${five}/${fifteen}`);
  } catch {
    // no /proc/loadavg on this platform
  }
  try {
    const cpu = readFileSync('/proc/stat', 'utf8').split('\n').find((line) => line.startsWith('cpu '));
    const ticks = cpu ? cpu.trim().split(/\s+/).slice(1).map(Number) : [];
    const total = ticks.reduce((sum, value) => sum + value, 0);
    if (ticks.length > 7 && total > 0) {
      parts.push(`cpu steal=${((ticks[7] / total) * 100).toFixed(1)}% since boot`);
    }
  } catch {
    // no /proc/stat on this platform
  }
  return parts.join(', ');
}

function lastStderrLine(text) {
  const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '(stderr empty)';
}

// A launch failure has to say WHICH failure it was: alive-but-silent (a wedge)
// and exited-early (a crash) are different faults with different fixes, and a
// bare "timed out" collapses them into one symptom. Every attempt mkdtemps its
// own profile, so freshProfile=true is a property, not a claim.
function describeLaunchFailure({ attempts, reasons, detail }) {
  // Read the snapshot taken BEFORE teardown: close() signals the browser and
  // waits for it to exit, so re-reading the process here would always report
  // alive=false/signal=SIGTERM and erase the alive-but-silent vs exited-early
  // distinction this message exists to make.
  const alive = detail.spawned ? String(detail.alive) : 'n/a (no process)';
  const exit = detail.spawned ? `exitCode=${detail.exitCode}, signal=${detail.signal}` : 'exitCode=n/a';
  const host = hostLoadSummary();
  return (
    `Chrome launch failed after ${attempts} attempt(s); reasons: ${reasons.join(' | ')}; ` +
    `last attempt: browser alive=${alive}, ${exit}, freshProfile=true, ` +
    `stderr=${JSON.stringify(lastStderrLine(detail.stderrText))}` +
    (host ? `; ${host}` : '')
  );
}

// One launch attempt: a fresh profile dir, a spawn, and a bounded wait for the
// "DevTools listening on ws://..." line Chrome prints to stderr
// (remote-debugging-port=0 picks a free port). Returns { ok: true, handle } or
// { ok: false, detail } and never throws, so launchChrome() can retry the whole
// attempt and report every reason it failed.
async function launchChromeOnce({ chromePath, headless, log, devtoolsTimeoutMs }) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'web-uplift-cdp-'));
  log(`[browser] launching ${chromePath} (${headless ? 'headless' : 'headed'}, profile ${userDataDir})`);

  let proc;
  try {
    proc = spawn(
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
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        // Chrome leads its own process group (setsid), so teardown can signal
        // the whole browser tree with kill(-pid) without ever touching this
        // process's group. See killGroup().
        detached: true,
      },
    );
  } catch (err) {
    // spawn itself failed (binary vanished, EACCES): no process, no group,
    // just the empty profile dir to drop before reporting.
    removeDirNow(userDataDir);
    return {
      ok: false,
      detail: {
        reason: `spawn failed: ${err.message}`,
        spawned: false,
        alive: false,
        exitCode: null,
        signal: null,
        stderrText: '',
      },
    };
  }

  installInterruptNet();
  const browser = { proc, pgid: readPgid(proc.pid), userDataDir };
  liveBrowsers.add(browser);

  let closed = false;
  async function close() {
    if (closed) return; // idempotent: an explicit close plus a caller's finally
    closed = true;
    try {
      // Liveness guard before the first group signal: while the child is alive
      // its pid cannot be recycled, so -pid provably names this child's group.
      // Once it has exited its group is gone and that number could belong to
      // something else by now, so send nothing and let the bounded escalation
      // settle on the recorded wait status below.
      if (!procExited(proc)) killGroup(browser, 'SIGTERM');
      if (!(await waitForProcExit(proc, TERM_GRACE_MS))) {
        killGroup(browser, 'SIGKILL');
        await waitForProcExit(proc, KILL_GRACE_MS);
      }
      await waitForGroupDrain(proc, GROUP_DRAIN_MS);
      // Only now is the profile dir safe to remove: every process that could
      // re-create Local State / Variations is gone.
      let removed = false;
      for (let attempt = 1; attempt <= 3 && !removed; attempt++) {
        removed = removeDirNow(userDataDir);
        if (!removed && attempt < 3) await sleep(150);
      }
      if (!removed) {
        // Loud on purpose, and unconditional: a leaked multi-MB profile dir per
        // failed launch is how a flake fills /tmp, and the `log` sink is silent
        // under --quiet, which is how the 4.4MB husk went unnoticed. Now that
        // launches are retried, the failure path is common rather than rare.
        console.error(
          `[browser] WARNING: leaked profile dir ${userDataDir}; the Chrome tree is gone but removal failed, remove it by hand`,
        );
      }
      // The tree is dead; drop our side of the stderr pipe so it cannot pin the
      // event loop of a process that is otherwise done.
      proc.stderr.destroy();
    } finally {
      liveBrowsers.delete(browser);
    }
  }

  let stderrText = '';
  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(new Error(`timed out waiting for the DevTools endpoint after ${devtoolsTimeoutMs}ms`)),
        devtoolsTimeoutMs,
      );
      proc.stderr.on('data', (chunk) => {
        stderrText += chunk.toString();
        const match = stderrText.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });
      proc.on('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Chrome exited early (code ${code}, signal ${signal}) before listening`));
      });
    });
  } catch (err) {
    // Snapshot liveness, exit state and stderr BEFORE teardown: close() signals
    // and reaps the browser, so reading them afterwards would report every
    // timeout as an exited process (signal=SIGTERM) and hide the wedge-vs-crash
    // difference this diagnostic exists to draw.
    const detail = {
      reason: err.message,
      spawned: true,
      alive: !procExited(proc),
      exitCode: proc.exitCode,
      signal: proc.signalCode,
      stderrText,
    };
    // The browser we spawned (or its wedged tree) must not outlive the failure,
    // and its profile dir must not be left behind for the next attempt.
    await close();
    return { ok: false, detail };
  }

  log(`[browser] DevTools port ${port}`);
  return { ok: true, handle: { proc, port, userDataDir, close } };
}

// Launch headless Chrome, retrying the WHOLE attempt (fresh profile dir) a
// bounded number of times. See DEVTOOLS_ENDPOINT_TIMEOUT_MS for why a longer
// wait is not the fix, and describeLaunchFailure for what a failure reports.
export async function launchChrome({
  log = () => {},
  headless = true,
  // Overridable so tests can exercise the timeout/wedge path without a 20 s
  // wait; production callers keep the measured constant.
  devtoolsTimeoutMs = DEVTOOLS_ENDPOINT_TIMEOUT_MS,
} = {}) {
  const chromePath = resolveChromePath();
  const reasons = [];
  let lastDetail = null;
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    const result = await launchChromeOnce({ chromePath, headless, log, devtoolsTimeoutMs });
    if (result.ok) {
      if (attempt > 1) log(`[browser] launch recovered on attempt ${attempt}/${LAUNCH_ATTEMPTS}`);
      return result.handle;
    }
    lastDetail = result.detail;
    reasons.push(result.detail.reason);
    if (attempt < LAUNCH_ATTEMPTS) {
      const backoff = launchBackoffMs(attempt);
      log(
        `[browser] launch attempt ${attempt}/${LAUNCH_ATTEMPTS} failed (${result.detail.reason}); ` +
          `retrying in ${backoff}ms with a fresh profile`,
      );
      await sleep(backoff);
    }
  }
  throw new Error(describeLaunchFailure({ attempts: LAUNCH_ATTEMPTS, reasons, detail: lastDetail }));
}

// Retry a flaky bootstrap step a bounded number of times. Chrome for Testing
// 154 occasionally boots with an empty /json/list (the default New Tab fails to
// load with "incorrect profile type"), so we never use the default-target path
// here. This retry only absorbs the tiny start-up race after we have already
// created our own target, so it cannot mask a real browser hang. Under host CPU
// starvation a CDP.New attach can also end in ECONNRESET ("socket hang up"),
// which exhausted the old flat 5-attempt/200ms budget on 2026-10-05, so the
// budget is bigger and the delay backs off with jitter instead of hammering a
// starved box in lockstep.
async function withRetry(fn, { label, attempts = 8, delayMs = 200, maxDelayMs = 2000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const base = Math.min(maxDelayMs, delayMs * 2 ** (attempt - 1));
        await sleep(base + Math.floor(Math.random() * delayMs));
      }
    }
  }
  throw new Error(`${label} (${attempts} attempts): ${lastError?.message ?? lastError}`, {
    cause: lastError,
  });
}

// Open a fresh CDP session against a new target (tab) and enable the domains we
// rely on across the auditor. Returns the CDP client plus a per-target cleanup.
export async function newSession(port, { log = () => {}, cdpDeadlineMs = cdpCallDeadlineMsDefault } = {}) {
  // Create a dedicated target via the /json/new HTTP endpoint and attach to the
  // WebSocket URL it returns directly. A bare CDP({ port }) uses chrome-remote-
  // interface's default target chooser, which reads /json/list and throws
  // "No inspectable targets" when Chrome for Testing 154 boots without a usable
  // default page (the default New Tab can fail with "incorrect profile type").
  // /json/new does not depend on that page, so a fresh target is deterministic.
  const target = await withRetry(
    () => withDeadline(CDP.New({ port }), cdpDeadlineMs, 'the browser to accept a new target (CDP /json/new)'),
    { label: 'create CDP target' },
  );

  let client;
  try {
    client = await withRetry(
      () => withDeadline(CDP({ target: target.webSocketDebuggerUrl }), cdpDeadlineMs, 'the browser to accept a CDP attach'),
      { label: 'attach to CDP target' },
    );
  } catch (err) {
    // Best-effort cleanup if the attach retries are exhausted.
    await CDP.Close({ port, id: target.id }).catch(() => {});
    throw err;
  }

  const targetId = target.id;
  const { Page, Runtime, DOM, CSS, Emulation, Network } = client;
  await withDeadline(
    Promise.all([Page.enable(), Runtime.enable(), DOM.enable(), CSS.enable(), Network.enable()]),
    cdpDeadlineMs,
    'the browser to enable the CDP domains',
  );
  void Emulation;
  log('[browser] session ready');

  async function close() {
    try {
      await client.close();
    } catch {
      // ignore
    }
    try {
      await CDP.Close({ port, id: targetId });
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
  { settleMs = 1200, log = () => {}, beforeTargetNavigate = null, navigationDeadlineMs = navigationDeadlineMsDefault } = {},
) {
  const { Page } = client;

  const blanked = Page.loadEventFired();
  await withDeadline(Page.navigate({ url: 'about:blank' }), navigationDeadlineMs, `the about:blank navigation to be accepted (en route to ${url})`);
  await withDeadline(blanked, navigationDeadlineMs, `the load event for about:blank (en route to ${url})`);

  if (beforeTargetNavigate) await withDeadline(beforeTargetNavigate(), navigationDeadlineMs, 'the pre-navigation preparation');

  const loaded = Page.loadEventFired();
  await withDeadline(Page.navigate({ url }), navigationDeadlineMs, `the navigation to ${url} to be accepted`);
  await withDeadline(loaded, navigationDeadlineMs, `the load event for ${url}`);
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
export { sleep };
