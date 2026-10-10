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
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import CDP from 'chrome-remote-interface';
import { redactUrlCredentialValues, redactUrlsInText } from './credential-terms.mjs';

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
// How long a reachability probe waits for an answer before calling the outcome undecided. One
// second, not a few hundred milliseconds: a verdict that flips to "unconfirmed" under load is a
// verdict that fails open exactly when the machine is busy (web-uplift-4rv review).
const PROBE_TIMEOUT_MS = 1000;

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
//
// THE COMPLETE AWAIT CENSUS - enforced, not read. A judgement-based version of this list
// was wrong three times, and a bucket-summed version hid a miscount behind a grand total
// that agreed, so the authoritative classification is INDIVIDUAL and lives in the test:
// testAwaitCensus (tests/regression.mjs) matches every non-comment await line across the
// evidence modules against exactly one disposition rule (exactly one - a line matching zero
// or two rules fails), and fails - naming the file, line and text - when a site is
// unclassified or a rule's count drifts. THE CENSUS'S LIMIT, stated plainly: it verifies
// that every site is CLASSIFIED; it cannot verify that a bound is still PRESENT at a
// classified site. That is what review and the targeted tests are for, and the census must
// never be read as a proof of boundedness. (No manual recipe is given here: the previous
// one went stale within a revision. The test IS the recipe.)
//
// WHAT THE CENSUS SHOWS, in summary. Bounded by withDeadline (this bead's helper): in
// newSession the target create, the attach, the cleanup-Close after an attach failure and
// the domain enables; in session.close() both teardown awaits; in navigate() the two
// navigations, the two load events and the pre-navigation preparation; in the console
// collector the Runtime/Log enables; in trace the two direct navigations, the load wait,
// applyConditions, Tracing.start, Tracing.end, tracingComplete and the interact evaluate;
// in resilience the ServiceWorker.enable, the offline switch, the offline-reload navigate
// and the online restore; in safeFetch the response-body reads; and (web-uplift-j3re) the five
// pipe calls in the launch and session paths, the readiness retry sleep and the grace-bounded close
// on the readiness failure path. Bounded transitively:
// applyConditions' six internals and sw.enable's internal enable (every caller wraps the call).
// web-uplift-xnte REMOVED the Browser.getVersion probe from this bucket: it was listed here as bounded
// by waitForPipeReady's deadlineMs, and that was false, because the loop consulted its deadline only in
// the catch and a promise that never settled never reached it. The probe is now inside a race that owns
// its bound, so it counts as bounded by its own deadline and nothing is listed here for the pipe. Bounded by their own deadlines: the fetch and pinnedFetch exchanges (AbortSignal), the capped body
// reader, har's network-idle wait, --interact's poll, the headers docPromise timeout,
// resilience's offline load race, and (web-uplift-4rv) the exposure probe's own connect, which is
// handed its timeoutMs explicitly, plus the injected exposureProbe, whose production default
// cdpEndpointExposure bounds its own sockets by PROBE_TIMEOUT_MS. Bounded by pre-existing mechanisms: the launcher's own close() - including the reap a failed handoff performs in its finally (web-uplift-l93f), and the same call made on a recovered handle in launchChrome when a caller's log throws after a successful attempt - the launch endpoint
// poll and its grace-bounded teardown, sleeps, withRetry around bounded calls, the gather
// spine. EXCLUDED WITH REASON: the per-primitive content probes after or outside the shared
// spine (evaluate() probes, screenshots, getResponseBody, screencast, heap, axe, a11y and
// friends) - a wedge there hangs ONE primitive's evidence, not the CLI's ability to reach
// or leave a page, and several carry their own bounds - plus TWO page-side awaits inside
// evaluate templates (not host awaits at all): the navigator.locks probe, and the secrets
// primitive's in-page fetch of a page-selected script URL (web-uplift-61i: it carries its own
// in-page AbortController deadline and a 2 MiB byte cap, the same containment values as the
// Node-side safeFetch). The former res.text() fallback for a body with no readable stream is
// GONE rather than merely bounded (web-uplift-6fe): a streamless body is now refused before any
// read, so there is no third page-side await to classify. The evaluate()
// helper's own Runtime.evaluate, which is the content-probe mechanism itself, is in the
// primitive-probe bucket.
//
// THE WARNING for the next primitive: an await added to any evidence module fails testAwaitCensus
// until it is classified, so an omission is LOUD now rather than silent. A NEW primitive
// that awaits client.* directly inherits NOTHING from this census: the trace primitive was
// exactly that hole, found by enumeration, not by the sweeps that preceded it.
// The current navigation bound, for callers that navigate directly (the trace
// primitive) and must take the same bound navigate() uses, flag included.
export function getNavigationDeadlineMs() {
  return navigationDeadlineMsDefault;
}

// The current CDP-call bound, for primitives that enable domains directly
// (resilience's ServiceWorker.enable) and must take the same bound newSession()
// uses, flag included.
export function getCdpCallDeadlineMs() {
  return cdpCallDeadlineMsDefault;
}

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

// Chrome's OS sandbox is ON by default (web-uplift-d2l). Every primitive
// navigates pages the operator does not control, so a renderer exploit must not
// land as code execution in the operator's own account. '--no-sandbox' is
// therefore opt-in, and only two things turn it on: an explicit operator opt-out,
// or a uid where Chrome cannot start its sandbox at all. Returns the reason the
// sandbox is being disabled, or null to keep it on.
//
//   WEB_UPLIFT_NO_SANDBOX=1   - operator opt-out, for environments where the
//                               sandbox cannot start (restricted container,
//                               no unprivileged user namespaces).
//   uid 0                     - Chrome refuses to start its sandbox as root, so
//                               auto-disabling is the difference between a
//                               working launch and three failed attempts.
//
export function sandboxDisableReason({ env = process.env, uid = process.getuid?.() } = {}) {
  const requested = String(env.WEB_UPLIFT_NO_SANDBOX ?? '').trim();
  if (/^(1|true|yes)$/i.test(requested)) return 'requested via WEB_UPLIFT_NO_SANDBOX';
  if (uid === 0) return 'running as root (uid 0), where Chrome cannot start its OS sandbox';
  return null;
}

// One launch attempt: a fresh profile dir, a spawn, and a bounded wait for the
// ---- The CDP endpoint's EXPOSURE (web-uplift-4rv) -------------------------------------------
//
// Chrome's DevTools endpoint has no authentication at all, and this tool keeps it open for the
// whole audit: anything that can reach its port can drive the browser as the operator, read
// every page it holds open and run script in them. The launch is pinned to loopback, but a pin
// is a claim about what another program did, so the launch MEASURES it. Two checks, because a
// security verdict that is really a guess is worse than no verdict:
//
//   1. THE BINDING ITSELF, read from the kernel and attributed to our own browser pid (that
//      pid's socket inodes from /proc/<pid>/fd, then the LISTEN rows for those inodes in
//      /proc/net/tcp and /proc/net/tcp6). This is the decisive check: it answers for IPv6 as
//      well as IPv4, it cannot be confused by an unrelated process that happens to hold the
//      same port number on a different address, and it does not depend on reachability, on
//      firewalls, or on a proxy's behaviour. Linux only.
//   2. REACHABILITY, used when the binding cannot be read (macOS, Windows, no /proc) and as a
//      second opinion when it can: connect to the endpoint over every non-loopback address
//      this host has, including IPv6, and speak just enough HTTP to ask WHO is answering.
//      Only a DevTools-shaped answer counts as exposure, so an unrelated daemon or a
//      transparent proxy holding that address cannot turn a healthy audit into a refused one.
//
// What neither check can decide is reported as UNCONFIRMED, never as verified-safe, and the
// README says which check ran and what remains unproven.
const LOOPBACK_V6 = /^(?:::1$|::ffff:127\.)/i;

// Is this a loopback address, in either family? 127.0.0.0/8 is all loopback, not just
// 127.0.0.1, and ::1 is the IPv6 one.
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  return address.startsWith('127.') || address === '0:0:0:0:0:0:0:1' || LOOPBACK_V6.test(address);
}

// The addresses our pid listens on, straight from the kernel, plus the address-family tables that
// could NOT be read. Returns null when this cannot be read at all (no /proc, a pid we cannot
// inspect), which callers must treat as "unknown" rather than as "nothing listening".
//
// The unreadable list is part of the answer, not a detail: a v4-only kernel, a hardened sandbox
// or a container that does not expose /proc/net/tcp6 leaves the IPv4 half looking perfect while a
// browser that bound a non-loopback IPv6 address is simply invisible. Reporting such a read as
// "verified by the kernel binding" would be a false all-clear, so callers must treat a non-empty
// `unreadable` as INCOMPLETE and fall through to the reachability check (web-uplift-03da).
export function readBoundListeners(pid, { fdDir = `/proc/${pid}/fd`, tcpFiles = ['/proc/net/tcp', '/proc/net/tcp6'] } = {}) {
  let fds;
  try {
    fds = readdirSync(fdDir);
  } catch {
    return null;
  }
  const inodes = new Set();
  for (const fd of fds) {
    let target;
    try {
      target = readlinkSync(join(fdDir, fd));
    } catch {
      continue; // the fd closed between readdir and readlink, which is normal
    }
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match) inodes.add(match[1]);
  }
  if (inodes.size === 0) return null;
  const listeners = [];
  const unreadable = [];
  for (const file of tcpFiles) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      unreadable.push(file); // no IPv6 table on a v4-only kernel, or unreadable in some sandboxes
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const field = line.trim().split(/\s+/);
      if (field.length < 10) continue;
      if (field[3] !== '0A') continue; // 0A is TCP_LISTEN
      if (!inodes.has(field[9])) continue;
      const [hexAddress, hexPort] = field[1].split(':');
      const address = decodeProcAddress(hexAddress, file.endsWith('6'));
      const port = parseInt(hexPort, 16);
      if (address !== null && Number.isInteger(port)) listeners.push({ address, port, family: file.endsWith('6') ? 'IPv6' : 'IPv4' });
    }
  }
  return { listeners, unreadable };
}

// /proc encodes addresses as hex, IPv4 little-endian as one word and IPv6 as four little-endian
// 32-bit words. Anything that does not decode is null rather than a made-up address.
export function decodeProcAddress(hex, v6) {
  if (typeof hex !== 'string' || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
  if (!v6) {
    const bytes = hex.match(/../g);
    if (!bytes || bytes.length !== 4) return null;
    return bytes.reverse().map((b) => parseInt(b, 16)).join('.');
  }
  if (hex.length !== 32) return null;
  const words = hex.match(/......../g);
  if (!words) return null;
  // The WORDS are already in canonical order (word 0 first): /proc byte-swaps inside each
  // 32-bit word, it does not reorder them. Reversing the word order as well turns ::1 into
  // 0:1:0:0:0:0:0:0, which is a different address.
  const bytes = words
    .map((word) => (word.match(/../g) ?? []).reverse().join(''))
    .join('');
  const groups = bytes.match(/..../g);
  if (!groups) return null;
  return groups.map((g) => parseInt(g, 16).toString(16)).join(':');
}

// The verdict from the kernel's own view: every listener our browser has on its port must be a
// loopback address. A wildcard bind (0.0.0.0 or ::) is exposure, and so is a single non-loopback
// address. No listener for the port at all is NOT a safe verdict: the browser announced that
// port, so not finding it means the read was incomplete.
export function classifyBoundListeners(port, listeners) {
  const onPort = (listeners ?? []).filter((l) => l.port === port);
  if (onPort.length === 0) {
    return { exposed: false, unknown: true, note: `no listening socket for port ${port} was found in /proc for this browser` };
  }
  const reachable = onPort.filter((l) => !isLoopbackAddress(l.address));
  if (reachable.length === 0) return { exposed: false, verifiedBy: 'the kernel binding' };
  const named = [...new Set(reachable.map((l) => (l.family === 'IPv6' ? `[${l.address}]:${l.port}` : `${l.address}:${l.port}`)))].join(', ');
  return {
    exposed: true,
    verifiedBy: 'the kernel binding',
    reason:
      `the DevTools endpoint is bound to ${named}, which is not a loopback address: an unauthenticated ` +
      'DevTools port is reachable from anywhere that can route to it, so this launch is refused',
  };
}

// Every non-loopback address this host has, IPv4 and IPv6. Link-local IPv6 needs its zone
// (scope) id to be connectable, which networkInterfaces() reports separately.
export function nonLoopbackHosts(interfaces = networkInterfaces()) {
  const hosts = [];
  for (const addrs of Object.values(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (!addr || addr.internal) continue;
      const family = addr.family === 'IPv4' || addr.family === 4 ? 'v4' : addr.family === 'IPv6' || addr.family === 6 ? 'v6' : null;
      if (!family) continue;
      if (family === 'v6' && /^fe80:/i.test(addr.address) && addr.scopeid) hosts.push(`${addr.address}%${addr.scopeid}`);
      else hosts.push(addr.address);
    }
  }
  return hosts;
}

// The exposure verdict for a browser that just announced `port`. `pid` is the browser's pid
// when the caller knows it (the launch path does), which is what makes the kernel check
// attributable; without it, only reachability can be checked. `readListeners` and `connect` are
// injectable so the decision is testable without a browser and without this machine's network.
export async function cdpEndpointExposure(port, {
  pid = null,
  interfaces = networkInterfaces(),
  connect = probeDevtools,
  timeoutMs = PROBE_TIMEOUT_MS,
  readListeners = readBoundListeners,
} = {}) {
  if (!Number.isInteger(port) || port <= 0) return { exposed: false, note: 'no CDP port to probe' };
  const notes = [];

  // Does the kernel read cover every address family? Only then is "the kernel binding" a
  // verification: an unreadable /proc/net/tcp6 hides an IPv6 listener completely, so a clean IPv4
  // answer must fall through to the reachability check rather than report an all-clear.
  let bindingIncomplete = false;
  if (Number.isInteger(pid) && typeof readListeners === 'function') {
    let read = null;
    let readFailed = false;
    try {
      read = readListeners(pid);
    } catch (err) {
      readFailed = true;
      bindingIncomplete = true;
      notes.push(`the socket binding of pid ${pid} could not be read: ${err && err.message}`);
    }
    // readBoundListeners reports its own blind spots; an injected reader may still return a bare
    // array, which is treated as complete because that is what a full answer looks like.
    const listeners = Array.isArray(read) ? read : read && Array.isArray(read.listeners) ? read.listeners : null;
    const unreadable = Array.isArray(read) ? [] : (read && Array.isArray(read.unreadable) ? read.unreadable : []);
    if (listeners) {
      const verdict = classifyBoundListeners(port, listeners);
      if (verdict.exposed) return { ...verdict, note: notes.join('; ') || undefined };
      if (unreadable.length > 0) {
        bindingIncomplete = true;
        notes.push(`the kernel binding could not be read for ${unreadable.join(', ')}, so an address family is unchecked`);
      }
      if (!verdict.unknown && !bindingIncomplete) {
        return { exposed: false, verifiedBy: 'the kernel binding', note: notes.join('; ') || undefined };
      }
      if (verdict.unknown) {
        // No listener for the port is also an INCOMPLETE binding answer, not a clean one: the
        // browser announced that port, so not finding it means the read did not cover it. The
        // verdict is already prevented from claiming the kernel, and this makes the note say why.
        bindingIncomplete = true;
        notes.push(verdict.note);
      }
    } else {
      // null means /proc could not be read at all, and any other shape is a caller's reader we
      // cannot interpret: either way the binding check did not run, so it is incomplete.
      bindingIncomplete = true;
      if (!readFailed) notes.push(`the socket binding of pid ${pid} could not be read, so the socket bindings are unchecked`);
    }
  } else if (Number.isInteger(pid)) {
    bindingIncomplete = true;
    notes.push('the kernel binding could not be checked');
  }

  const hosts = nonLoopbackHosts(interfaces);
  if (hosts.length === 0) {
    notes.push('this host has no non-loopback address, so the endpoint can only be reached on loopback');
    if (bindingIncomplete) notes.push('the kernel binding was incomplete, so only reachability was checked');
    return { exposed: false, verifiedBy: 'reachability', note: notes.join('; ') };
  }
  let probed = 0;
  // The probes are independent read-only reachability checks with no ordering dependency, so they run
  // CONCURRENTLY and the verdict is then evaluated in the original hosts order. Ordered evaluation is
  // what keeps the notes, the probed count and the host named in the refusal reason deterministic and
  // identical to the serial version, host for host; serialising them only cost time. Measured on three
  // interfaces that each take the full timeout: 602ms serially against ~200ms together, and the worst
  // case grows with the interface count on hosts with Docker bridges, VPNs or link-local IPv6
  // (web-uplift-690r).
  // allSettled, not all: Promise.all rejects at the first failure IN TIME, which would let a later
  // rejection replace the refusal an earlier host already produced - and the caller closes the browser
  // only on the refusal path, so a host that answered as DevTools could be left running. Rethrowing
  // inside the ordered loop keeps that path exactly as the serial version had it, including which
  // error is thrown. The async wrapper also keeps a synchronously throwing connect from leaving the
  // probes it already started without a handler (web-uplift-690r review, P2 and P3).
  const settled = await Promise.allSettled(hosts.map(async (host) => connect(host, port, timeoutMs)));
  for (let index = 0; index < hosts.length; index += 1) {
    const host = hosts[index];
    const outcome = settled[index];
    if (outcome.status === 'rejected') throw outcome.reason;
    const verdict = outcome.value;
    if (verdict === 'refused') continue;
    if (verdict === 'devtools') {
      return {
        exposed: true,
        verifiedBy: 'reachability',
        reason:
          `the browser answered as Chrome DevTools on ${host}:${port}, which is not a loopback address: an ` +
          'unauthenticated DevTools port is reachable from anywhere that can route to it, so this launch is refused',
        note: notes.join('; ') || undefined,
      };
    }
    if (verdict === 'other') notes.push(`${host}:${port} answers, but not with DevTools`);
    else {
      probed += 1;
      notes.push(`${host}:${port} could not be probed (${verdict}), so its exposure is unconfirmed`);
    }
  }
  // Reachability is only a verification when it decided EVERY non-loopback address. If any probe
  // was undecided (a timeout, an unusual error) then one of them could be serving DevTools, so the
  // verdict is unknown and names no verifier: "verifiedBy: reachability" beside an "unconfirmed"
  // note reads as a clean result, which is exactly what it is not (web-uplift-sj4c).
  if (probed > 0) {
    return {
      exposed: false,
      unknown: true,
      note: [...notes, `${probed} of ${hosts.length} non-loopback addresses could not be decided`].filter(Boolean).join('; '),
    };
  }
  return {
    exposed: false,
    verifiedBy: 'reachability',
    note: [...notes, bindingIncomplete ? 'the kernel binding was incomplete, so only reachability was checked' : ''].filter(Boolean).join('; ') || undefined,
  };
}

// One reachability probe: connect, then ask Chrome's own HTTP endpoint who is there. Only a
// DevTools-shaped answer is exposure - a plain 'connected' would also be true of an unrelated
// daemon that happens to hold that port, or of a proxy that accepts and answers, and refusing
// a healthy launch for either is a worse failure than the exposure check is worth.
export function probeDevtools(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let text = '';
    let totalTimer = null;
    const settle = (verdict) => {
      if (settled) return;
      settled = true;
      // A total deadline must not outlive the verdict, or a settled probe keeps a timer alive.
      if (totalTimer) clearTimeout(totalTimer);
      try {
        socket.destroy();
      } catch {
        // teardown is best effort: the verdict is already decided
      }
      resolve(verdict);
    };
    // A HARD total deadline, independent of socket idleness (web-uplift-wf0r). setTimeout below is an
    // IDLE timeout, so a peer that trickles bytes resets it forever and holds the probe up to the 64KB
    // cap: measured 2321ms for a 300ms timeout against a peer that dripped for 2s. On expiry the verdict
    // is 'devtools' if the body already proved it, otherwise 'timeout' - deliberately NEVER 'other',
    // because 'other' reads as "answers, but not with DevTools" and earns verifiedBy:'reachability', so
    // a DevTools body still arriving in pieces would be laundered into a clean verdict. 'timeout' leaves
    // the host undecided, which is the honest answer and the one the caller already handles as unknown.
    // Word carefully: this fails closed in the LABEL, not at the launch gate - the caller refuses only
    // `exposed`, so an unknown host still launches. The deadline therefore trades a slightly stricter
    // label for a bounded refusal latency, and it is a total bound, so it can in principle cut short a
    // real DevTools answer that arrives slowly; Chrome is believed to send /json/version in one write.
    const socket = netConnect({ host, port });
    // Armed AFTER netConnect on purpose: netConnect can throw synchronously (a port above 65535 gives
    // ERR_SOCKET_BAD_PORT), and a timer armed before it would outlive the rejection and hold the
    // process open until it expired - measured 5071ms against 68ms without it (web-uplift-wf0r review).
    // Arming it here also means settle() can never observe `socket` before it exists.
    totalTimer = setTimeout(() => settle(isDevtoolsBody(text) ? 'devtools' : 'timeout'), timeoutMs);
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      const authority = host.includes(':') ? `[${host.split('%')[0]}]` : host;
      socket.write(`GET /json/version HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      if (isDevtoolsBody(text)) settle('devtools');
      // A body this large is not /json/version - but that is a heuristic, not a proof, so the verdict is
      // 'oversized' rather than 'other'. 'other' is read by cdpEndpointExposure as "answers, but not with
      // DevTools" and earns verifiedBy:'reachability', and leading whitespace is legal JSON, so a peer
      // that pads past the cap before a real DevTools payload was laundered into a clean verdict - the
      // same fail-open class the total-deadline rule above exists to avoid (web-uplift-6h9o). 'oversized'
      // leaves the host undecided and with no verifier, exactly as 'timeout' did: cdpEndpointExposure
      // treats every verdict except 'other' the same way, so the caller's decision does not change. The
      // value exists so the note it writes names the real cause. It read "could not be probed (timeout)"
      // while the cause was a size cap, which sends an operator looking for a slow endpoint instead of a
      // talkative one (web-uplift-g9zr). This does widen what reads as undecided: a genuinely
      // non-DevTools peer that sends more than 64KB now reads undecided instead of 'other', which is the
      // safer label but is a change, hence the separate artifact and its own review.
      else if (text.length > 64 * 1024) settle('oversized');
    });
    socket.once('end', () => settle(isDevtoolsBody(text) ? 'devtools' : text ? 'other' : 'error'));
    // The idle timeout settles the SAME rule as the total deadline above: 'other' only applies to a
    // body that PROVED itself non-DevTools by answering in full, never to one that merely sent some
    // text and stalled. Today the deadline is armed first with the same duration and every byte pushes
    // the idle timer later, so this branch cannot win - which is exactly why the rule has to be the
    // same in both places: nothing in the code should depend on that ordering holding forever
    // (web-uplift-6h9o review).
    socket.once('timeout', () => settle(isDevtoolsBody(text) ? 'devtools' : 'timeout'));
    socket.once('error', (err) => settle(err && err.code === 'ECONNREFUSED' ? 'refused' : 'error'));
  });
}

// What Chrome's /json/version answers, and nothing else, counts as DevTools: the 404 page of an
// unrelated server and a proxy's own page must not be read as a MisDevTools endpoint.
export function isDevtoolsBody(text) {
  return /"webSocketDebuggerUrl"\s*:/.test(text) || /"Browser"\s*:\s*"Chrome/.test(text) || /"Chrome\//.test(text);
}

// "DevTools listening on ws://..." line Chrome prints to stderr
// ---- Pipe transport (web-uplift-j3re) --------------------------------------------------------
//
// --remote-debugging-port opens an UNAUTHENTICATED TCP endpoint that lives for the whole audit, and
// anything that can reach loopback can attach to it: measured, a separate process fetched
// /json/version (HTTP 200) and then attached and ran script in a target. web-uplift-4rv pins and
// verifies that endpoint; this transport removes it. Chrome speaks the same CDP over
// --remote-debugging-pipe on fd 3 (commands) and fd 4 (responses), with NUL-terminated JSON frames
// and no socket at all.
//
// Two things not to rediscover: responses are NOT one per read (a second reply can arrive in the
// same chunk, so the reader buffers and splits on the separator), and the launch must request
// THREE pipes, because fd 0 and fd 1 take the first two stdio slots and fd 3/4 only exist if the
// array is that long.
const PIPE_FRAME_SEPARATOR = '\0';
// Chrome needs a moment after spawn before the pipe answers; the wait itself is bounded by
// devtoolsTimeoutMs, this is only the gap between attempts.
const PIPE_READY_RETRY_MS = 25;

export function createPipeTransport({ toChrome, fromChrome, log = () => {} }) {
  // Every log() call below runs from an event handler rather than from a caller, so there is no frame to
  // throw into: a throwing log becomes an uncaughtException that takes the process down mid-CDP-exchange.
  // The launcher's own path has the opposite property on purpose (web-uplift-l93f) - a throw there
  // propagates and the finally reaps - but this side has nowhere to propagate to, so the failure is
  // contained and the handler keeps its real job (web-uplift-9dqr).
  const handlerLog = (msg) => {
    try { log(msg); } catch { /* a throwing log must not become an uncaught exception (web-uplift-9dqr) */ }
  };
  let nextId = 1;
  let buffer = '';
  let closed = false;
  const pending = new Map();
  const listeners = new Map();

  // Decode as a stream: a multi-byte character can straddle two chunks, and Buffer.toString per
  // chunk would corrupt it. setEncoding does that correctly, and this file does not use Buffer.
  fromChrome.setEncoding('utf8');
  fromChrome.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf(PIPE_FRAME_SEPARATOR)) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!frame) continue;
      let message;
      try {
        message = JSON.parse(frame);
      } catch (err) {
        // A frame we cannot parse is not a reason to kill the session: log it and keep reading, or
        // one stray message would take the whole browser away from the caller.
        handlerLog(`[browser] unparseable CDP pipe frame dropped: ${err && err.message}`);
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          entry.reject(new Error(`${message.error.message || 'CDP error'}${message.error.code ? ` (code ${message.error.code})` : ''}`));
        } else {
          entry.resolve(message.result);
        }
        continue;
      }
      if (message.method) {
        for (const entry of listeners.get(message.method) || []) {
          // A session-scoped listener only hears its own session's events, which is what the
          // websocket path gives callers through its per-target client.
          if (entry.sessionId && message.sessionId && entry.sessionId !== message.sessionId) continue;
          try {
            entry.callback(message.params, message.sessionId);
          } catch (err) {
            handlerLog(`[browser] a CDP pipe listener threw: ${err && err.message}`);
          }
        }
      }
    }
  });
  fromChrome.on('error', (err) => handlerLog(`[browser] CDP pipe read error: ${err && err.message}`));
  // A closed pipe takes every in-flight command with it (web-uplift-h6yn). Without this, a Chrome that
  // dies mid-audit leaves its answers pending FOREVER for any caller that passed no deadline, which is a
  // hang rather than a failure - the same class as web-uplift-xnte, whose readiness instance is bounded
  // only by racing process exit, and strictly worse than the port transport, which fails fast on a dead
  // browser. chrome-remote-interface rejects these too
  // (node_modules/chrome-remote-interface/lib/chrome.js:254-258).
  fromChrome.on('close', () => {
    closed = true;
    for (const [id, entry] of [...pending.entries()]) {
      pending.delete(id);
      entry.reject(new Error('the CDP pipe closed before every pending command was answered'));
    }
  });
  toChrome.on('error', (err) => handlerLog(`[browser] CDP pipe write error: ${err && err.message}`));

  return {
    send(method, params, sessionId) {
      if (closed) return Promise.reject(new Error('the CDP pipe is closed'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const frame = `${JSON.stringify({ id, method, params: params === undefined ? {} : params, ...(sessionId ? { sessionId } : {}) })}${PIPE_FRAME_SEPARATOR}`;
        try {
          toChrome.write(frame, (err) => {
            if (err) {
              pending.delete(id);
              reject(err);
            }
          });
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });
    },
    on(method, callback, sessionId) {
      const entry = { callback, sessionId };
      const entries = listeners.get(method) || [];
      entries.push(entry);
      listeners.set(method, entries);
      return entry;
    },
    off(method, entry) {
      const entries = listeners.get(method);
      if (!entries) return;
      const index = entries.indexOf(entry);
      if (index !== -1) entries.splice(index, 1);
      if (entries.length === 0) listeners.delete(method);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of pending.values()) entry.reject(new Error('the CDP pipe was closed'));
      pending.clear();
      listeners.clear();
    },
  };
}

// A chrome-remote-interface-shaped client over the pipe. The callers use `client.<Domain>.<method>`
// for commands and `client.<Domain>.<event>(callback)` for events, and both live in one namespace,
// so the two are told apart by ARGUMENT SHAPE: a function registers a listener, anything else is
// sent as a command. The alternative - hand-maintaining a list of event names - would be a new
// drift surface in a repo that keeps being bitten by exactly that.
export function createPipeClient(transport, sessionId) {
  const domains = new Map();
  // A name called with NO argument is genuinely ambiguous in CDP, and the callers use both meanings:
  // `client.Tracing.end()` is a command that takes no parameters, while `client.Page.loadEventFired()`
  // is how this codebase waits for the next event (four call sites await exactly that). The port
  // path's client resolves it from a schema the browser publishes over HTTP - which is the endpoint
  // the pipe exists to not have - so this does BOTH instead of guessing: it registers the one-shot
  // listener eagerly, which is what removes the race (the event can fire before a round trip would
  // have told us the name was an event), and it also sends the command, swallowing the -32601 that
  // says the name was an event after all. Whichever answers first wins, and a listener that loses the
  // race is removed so this cannot grow.
  const waitForEvent = (method) => {
    let entry = null;
    const promise = new Promise((resolve) => {
      entry = transport.on(method, (params) => resolve(params), sessionId);
    });
    return { promise, cleanup: () => entry && transport.off(method, entry) };
  };
  return new Proxy({}, {
    get(_target, property) {
      const name = String(property);
      if (name === 'close') return () => Promise.resolve();
      if (!domains.has(name)) {
        domains.set(name, new Proxy({}, {
          get(_domainTarget, methodProperty) {
            const method = `${name}.${String(methodProperty)}`;
            return (argument) => {
              if (typeof argument === 'function') {
                transport.on(method, argument, sessionId);
                return Promise.resolve();
              }
              if (argument !== undefined) return transport.send(method, argument, sessionId);
              const event = waitForEvent(method);
              const command = transport.send(method, {}, sessionId).catch((err) => {
                // -32601 is "method not found", which for a name awaited as an event is the answer
                // rather than a failure. Anything else is a real error and is re-thrown, and if
                // NEITHER ever settles the caller's own deadline is what bounds it.
                if (!/wasn't found|was not found|-32601/.test(err && err.message)) throw err;
                return new Promise(() => {});
              });
              return Promise.race([
                command.finally(() => event.cleanup()),
                event.promise.finally(() => event.cleanup()),
              ]);
            };
          },
        }));
      }
      return domains.get(name);
    },
  });
}

// Wait until the pipe answers, so a pipe launch has the same "it is usable now" contract the port
// launch gets from waiting for the DevTools line. Bounded, and it fails fast when the process is
// already gone rather than sitting out the whole deadline.
async function waitForPipeReady(pipe, { proc, deadlineMs, log = () => {} }) {
  const deadline = Date.now() + deadlineMs;
  let lastError = null;
  for (;;) {
    if (proc.exitCode !== null || proc.signalCode) {
      return { ok: false, reason: `the browser exited during startup (code ${proc.exitCode}, signal ${proc.signalCode})` };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, reason: `the CDP pipe did not answer Browser.getVersion within ${deadlineMs}ms${lastError ? `: ${lastError.message}` : ''}` };
    }
    // THE SEND ITSELF MUST BE BOUNDED (web-uplift-xnte). Awaiting it bare was a hang, not a slow path:
    // the deadline was only consulted in the catch, so a promise that never settled never reached it,
    // and the exit check at the top of the loop was unreachable for the same reason. A browser that is
    // alive but silent on fd 4 - which is exactly what a sandboxed or wedged Chrome looks like - left
    // the audit suspended forever instead of failing. Race three things: the answer, the remaining
    // budget, and the process exiting. The losing promise is caught so it cannot surface later as an
    // unhandled rejection, and both the timer and the exit listener are removed before returning.
    let timer = null;
    let onExit = null;
    const answer = pipe.send('Browser.getVersion');
    answer.catch(() => {});
    const settled = await Promise.race([
      answer.then((value) => ({ kind: 'ok', value }), (err) => ({ kind: 'err', err })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: 'timeout' }), remaining); }),
      new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode) { resolve({ kind: 'exited' }); return; }
        onExit = () => resolve({ kind: 'exited' });
        proc.once('exit', onExit);
      }),
    ]);
    if (timer !== null) clearTimeout(timer);
    if (onExit !== null) proc.off('exit', onExit);
    if (settled.kind === 'ok') return { ok: true, version: settled.value };
    if (settled.kind === 'exited') {
      return { ok: false, reason: `the browser exited during startup (code ${proc.exitCode}, signal ${proc.signalCode})` };
    }
    if (settled.kind === 'timeout') {
      return { ok: false, reason: `the CDP pipe did not answer Browser.getVersion within ${deadlineMs}ms` };
    }
    lastError = settled.err;
    if (Date.now() >= deadline) {
      return { ok: false, reason: `the CDP pipe did not answer Browser.getVersion within ${deadlineMs}ms: ${settled.err && settled.err.message}` };
    }
    await sleep(PIPE_READY_RETRY_MS);
  }
}

// (remote-debugging-port=0 picks a free port). Returns { ok: true, handle } or
// { ok: false, detail } and never throws, so launchChrome() can retry the whole
// attempt and report every reason it failed.
async function launchChromeOnce({ chromePath, headless, log, devtoolsTimeoutMs, transport = 'pipe', exposureProbe = (port) => cdpEndpointExposure(port) }) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'web-uplift-cdp-'));
  // Everything between the profile directory and the spawn runs OUTSIDE the try/finally below, so a throw
  // here has no reaper: the caller-supplied log is the one call in this region that is not ours, and a
  // throwing one stranded the directory the line above had just created (web-uplift-9dqr). Reaping here
  // rather than hoisting the block into the try is deliberate: the finally calls close(), which
  // dereferences proc, so moving this above the spawn would make the finally throw on an unspawned
  // browser and replace the caller's error with a TypeError from inside cleanup.
  let sandboxReason;
  try {
    sandboxReason = sandboxDisableReason();
    log(
      `[browser] launching ${chromePath} (${headless ? 'headless' : 'headed'}, profile ${userDataDir})` +
        (sandboxReason ? ` [OS sandbox DISABLED: ${sandboxReason}]` : ''),
    );
  } catch (err) {
    // Nothing is live yet - no process, no pipe - so the profile directory is the whole cleanup, and the
    // error still propagates so the caller sees its own throw rather than a cleanup artifact.
    removeDirNow(userDataDir);
    throw err;
  }

  let proc;
  try {
    proc = spawn(
      chromePath,
      [
        // Headed for `flow record` (the user interacts); headless everywhere else.
        ...(headless ? ['--headless=new'] : []),
        // web-uplift-j3re: the pipe has no endpoint to expose, so it needs no address pin and no
        // exposure verdict. The port path keeps both.
        ...(transport === 'pipe'
          ? ['--remote-debugging-pipe']
          : [
              '--remote-debugging-port=0',
              // web-uplift-4rv: the CDP endpoint is unauthenticated and lives for the whole audit,
              // so WHO can reach it is a security property, not a detail. Chrome defaults to
              // loopback, but the default is not a contract: pin it, and verify it below.
              '--remote-debugging-address=127.0.0.1',
            ]),
        // Absent unless the operator opted out or Chrome cannot sandbox here.
        ...(sandboxReason ? ['--no-sandbox'] : []),
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--hide-scrollbars=false',
      ],
      {
        // fd 0/1 take the first two slots, so THREE pipes are needed for fds 3 and 4 to exist:
        // fd 3 is our command channel and fd 4 Chrome's response channel.
        stdio: transport === 'pipe' ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
        // Chrome leads its own process group (setsid), so teardown can signal
        // the whole browser tree with kill(-pid) without ever touching this
        // process's group. See killGroup().
        detached: true,
      },
    );
  } catch (err) {
    // spawn itself failed (binary vanished, EACCES): no process, no group,
    // just the empty profile dir to drop before reporting. The attempt is
    // still recorded (pid null - none was created), or a run of failed
    // launches would leave the run tree with no sign a browser was ever tried.
    recordLaunchFailure({ pid: null, profileDir: userDataDir, reason: `spawn failed: ${err.message}` });
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
  let handedOff = false;
  let pipe = null;
  async function close() {
    if (closed) return; // idempotent: an explicit close plus a caller's finally
    closed = true;
    // Drop our side of the CDP pipe first: pending commands reject immediately instead of waiting
    // for a browser that is about to be signalled, and the reader stops holding the event loop.
    if (pipe) {
      try { pipe.close(); } catch { /* closing twice, or a pipe Chrome already ended */ }
      for (const fd of [proc.stdio[3], proc.stdio[4]]) {
        try { if (fd && typeof fd.destroy === 'function') fd.destroy(); } catch { /* already gone */ }
      }
    }
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

  try {

  if (transport === 'pipe') {
    pipe = createPipeTransport({ toChrome: proc.stdio[3], fromChrome: proc.stdio[4], log });
    // Capture the diagnosis BEFORE the readiness wait and before ANY teardown, for the same reason the
    // port path does (web-uplift-ik04): close() signals the browser and waits for it to exit, so a
    // snapshot taken afterwards always reports alive=false and signal=SIGTERM, which erases the
    // alive-but-silent vs exited-early distinction this failure message exists to make. The pipe path
    // previously read those fields after close() and hardcoded stderrText to '', so a wedged browser was
    // reported as a dead one with no stderr. Reading proc.stderr here also drains a stream that would
    // otherwise buffer with nothing consuming it.
    let pipeStderrText = '';
    const pipeStderrOnData = (chunk) => { pipeStderrText += chunk.toString(); };
    proc.stderr.on('data', pipeStderrOnData);
    const ready = await waitForPipeReady(pipe, { proc, deadlineMs: devtoolsTimeoutMs, log });
    if (!ready.ok) {
      const failureDetail = {
        reason: ready.reason,
        spawned: true,
        alive: !procExited(proc),
        exitCode: proc.exitCode,
        signal: proc.signalCode,
        stderrText: pipeStderrText,
      };
      recordLaunchFailure({ pid: proc.pid, profileDir: userDataDir, reason: ready.reason });
      await close();
      return { ok: false, detail: failureDetail };
    }
    // Success means nothing will read this text again, so detach the listener and let the stream flow:
    // otherwise the audit accumulates the browser's entire stderr for its whole life (web-uplift-xnte P3).
    proc.stderr.off('data', pipeStderrOnData);
    proc.stderr.resume();
    // No port exists, so there is nothing to expose and no verdict to make: the pipe is the
    // endpoint, and it is reachable only by a process that already holds this process's file
    // descriptors. That is the whole point of the transport (web-uplift-j3re), and it is why the
    // exposure probe below is skipped rather than faked.
    log(`[browser] CDP pipe ready (${(ready.version && ready.version.product) || 'unknown Chrome'})`);
    // The pipe is the transport every production caller uses, and it is the one that matters most here:
    // without the settle below the LAUNCHER rejected nothing at all in review (0 of 10): it returned a
    // dead handle every run, which is what makes the pipe test fail every run. On this path the browser
    // was still RUNNING (R/S in /proc) and exited 2-7ms later, so any instant check passes
    // (web-uplift-py0e). Readiness proved the browser alive DURING the wait; it can die between that and
    // this return, and the handle would then describe a corpse.
    await waitForProcExit(proc, 250);
    if (procExited(proc)) {
      const reason = `the browser exited (code ${proc.exitCode}, signal ${proc.signalCode}) before the launch completed`;
      recordLaunchFailure({ pid: proc.pid, profileDir: userDataDir, reason });
      await close();
      return {
        ok: false,
        detail: { reason, spawned: true, alive: false, exitCode: proc.exitCode, signal: proc.signalCode, stderrText: pipeStderrText },
      };
    }
    handedOff = true;
    return { ok: true, handle: { proc, pipe, userDataDir, close } };
  }

  let stderrText = '';
  // Named so the port path can detach it once the endpoint is found (web-uplift-xnte P3).
  let portStderrOnData = null;
  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(new Error(`timed out waiting for the DevTools endpoint after ${devtoolsTimeoutMs}ms`)),
        devtoolsTimeoutMs,
      );
      portStderrOnData = (chunk) => {
        stderrText += chunk.toString();
        const match = stderrText.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
        if (match) {
          clearTimeout(timeout);
          // The port is the whole reason this listener exists, so stop accumulating the browser's stderr
          // now: otherwise a successful audit holds its entire log for its lifetime. On the FAILURE paths
          // above and below the listener deliberately stays attached, because stderrText is the diagnosis
          // (web-uplift-xnte P3; the gemini review of e93a028 caught that this path was left unfixed while
          // the commit claimed both transports were done).
          proc.stderr.off('data', portStderrOnData);
          proc.stderr.resume();
          resolve(Number(match[1]));
        }
      };
      proc.stderr.on('data', portStderrOnData);
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
    // Attribute the failed attempt BEFORE teardown: close() reaps the tree and
    // removes the profile, and a post-mortem needs the pid/profile/reason of
    // the attempt that just died (web-uplift-6x7).
    recordLaunchFailure({ pid: proc.pid, profileDir: userDataDir, reason: err.message });
    // The browser we spawned (or its wedged tree) must not outlive the failure,
    // and its profile dir must not be left behind for the next attempt.
    await close();
    return { ok: false, detail };
  }

  // The address is pinned above, but a pin is a claim about what Chrome did, and the endpoint
  // it protects has no authentication: anything that can reach it can drive the browser as the
  // operator, read the pages it has open and run script in them. So the claim is measured
  // rather than trusted, and a non-loopback bind fails the launch instead of exposing an
  // audit (web-uplift-4rv).
  // A probe that THROWS, or that returns something that is not a verdict, must not escape this
  // function. Every other failure path here attributes the attempt and then tears the browser down; an
  // escaping exception did neither, so the spawned Chrome and its profile were left behind with no
  // handle left to close them (web-uplift-uuod). A verdict that is not a boolean is rejected rather
  // than read, because `exposure.exposed` on undefined is a TypeError that escapes the same way, and a
  // probe returning `{}` would otherwise be accepted as "not exposed" - fail-open for the one check
  // whose whole purpose is to refuse (web-uplift-uuod review).
  //
  // The failure is FATAL rather than retried, for the reason the fatal flag exists: a probe that could
  // not answer has not established that the endpoint is loopback-only. A retry runs its own probe, but
  // that does not remove the risk, because a probe CAN come back undecided - cdpEndpointExposure returns
  // {exposed:false, unknown:true} for that, and this function only refuses `exposed` - so a retry can
  // hand the caller a browser whose exposure was never decided. Note the asymmetry this creates: a
  // probe that THROWS is treated more strictly than one that comes back undecided, which the first
  // attempt accepts too. That is deliberate - a throw is a probe that did not run, while an undecided
  // verdict is a probe that ran and could not tell.
  // Deliberately NOT initialised to false: a probe that returns nothing leaves this at undefined, and
  // a boolean default would let a missing verdict pass validation as "not exposed", which is the
  // fail-open this whole check exists to prevent. My own six-shape test caught exactly that.
  let exposed;
  let probeReason = null;
  let probeNote = null;
  try {
    const exposure = await exposureProbe(port, proc.pid);
    // Read each field exactly ONCE, here, and validate the LOCAL. Reading `exposure.exposed` for the
    // check and again for the copy would consult the getter twice, and a probe whose getter answers a
    // boolean once and then throws would escape at the use site with the browser spawned and no
    // close() on that path (web-uplift-uuod review 3). Wrapping this in one destructure is what makes
    // "read once" true rather than merely intended.
    if (exposure !== null && typeof exposure === 'object') {
      ({ exposed, reason: probeReason, note: probeNote } = exposure);
    }
    if (typeof exposed !== 'boolean') {
      let shown = String(exposed);
      try {
        shown = exposure === undefined ? 'undefined' : exposure === null ? 'null' : JSON.stringify(exposure);
      } catch {
        shown = 'an object that could not be described';
      }
      throw new Error(`returned no verdict (${shown})`);
    }
  } catch (err) {
    // Coercing the throw must itself be total: String(err) on Object.create(null) throws, and an
    // Error whose message getter throws would too, and both would escape before close() (uuod review).
    let shown = 'unprintable throw';
    try {
      shown = err instanceof Error ? err.message : String(err);
    } catch {
      try {
        shown = Object.prototype.toString.call(err);
      } catch {
        // Still not printable: a revoked Proxy, or an object whose Symbol.toStringTag getter throws.
        // The default has to survive this, because the message is built in a catch that has no
        // enclosing try and would otherwise escape before close() (web-uplift-uuod review 3).
      }
    }
    const reason = `the endpoint exposure probe failed: ${shown}`;
    // Snapshot the real state BEFORE teardown, the way the readiness and exit paths do: close() reaps
    // the tree, and hard-coding these lost the real exit code of a browser that died during the probe.
    const detail = {
      reason,
      fatal: true,
      spawned: true,
      alive: !procExited(proc),
      exitCode: proc.exitCode,
      signal: proc.signalCode,
      stderrText,
    };
    recordLaunchFailure({ pid: proc.pid, profileDir: userDataDir, reason });
    await close();
    return { ok: false, detail };
  }
  if (exposed) {
    recordLaunchFailure({ pid: proc.pid, profileDir: userDataDir, reason: probeReason });
    await close();
    return {
      ok: false,
      // `fatal` is what stops launchChrome from retrying: a bind that is not loopback is a
      // verdict about this host, and a retry loop would spawn more exposed listeners and could
      // then fail OPEN on a later attempt that could not decide (web-uplift-4rv review).
      detail: { reason: probeReason, fatal: true, spawned: true, alive: false, exitCode: null, signal: null, stderrText },
    };
  }
  // The note is caller-visible text, and coercing it can throw: a Symbol, or an object whose toString
  // throws, escaped raw here with the browser running and no "launch failed" wrapper (uuod review 4).
  // Coerce defensively and only log a real string, so a note can never be the thing that fails a launch.
  if (probeNote) {
    let printableNote = null;
    try {
      printableNote = typeof probeNote === 'string' ? probeNote : String(probeNote);
    } catch {
      printableNote = null;
    }
    if (printableNote) log(`[browser] ${printableNote}`);
  }

  // The endpoint promise resolved the moment Chrome printed its listening line, so a browser that
  // died during the exposure probe still arrives here: the 'exit' listener's reject is a no-op on a
  // promise that has already settled. Without this check launchChrome returns a SUCCESS handle for a
  // browser that is already gone - and because the attempt is never seen as failed it is never
  // retried, so the caller gets a dead handle instead of a second attempt (web-uplift-py0e).
  // The failure uses the same detail shape as every other launch failure.
  // This is a short TRIAL WINDOW, not a settling of something already known: it covers both an exit
  // Node has not observed yet and an exit still in progress, which on the pipe path is the common case
  // (web-uplift-py0e review). An earlier version of this comment claimed a CDP-level liveness round trip
  // "would be exact and free" - that was wrong, because a browser that is still running passes ANY
  // instant check, and "no session yet" is untrue on the pipe path. The cost is FIXED, not a ceiling:
  // waitForProcExit only returns early once the process has exited, so every SUCCESSFUL launch pays the
  // full window (measured ~267ms port, ~335ms pipe, against ~35ms and ~119ms without). A browser that
  // dies after the window is still possible, but its first CDP call then fails loudly rather than
  // silently, which is the property that matters.
  await waitForProcExit(proc, 250);
  if (procExited(proc)) {
    const reason = `the browser exited (code ${proc.exitCode}, signal ${proc.signalCode}) before the launch completed`;
    recordLaunchFailure({ pid: proc.pid, profileDir: userDataDir, reason });
    await close();
    return {
      ok: false,
      detail: { reason, spawned: true, alive: false, exitCode: proc.exitCode, signal: proc.signalCode, stderrText },
    };
  }

  log(`[browser] DevTools port ${port}`);
    handedOff = true;
  return { ok: true, handle: { proc, port, userDataDir, close } };
  } finally {
    // The handle is only the caller's once it has been RETURNED. If anything after the spawn throws
    // before that - in practice a caller-supplied log, the one call in this region that is not ours -
    // the browser is still the launcher's to reap (web-uplift-l93f). close() is idempotent, so the
    // failure paths that already closed explicitly are unaffected.
    if (!handedOff) await close();
  }
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
  // Overridable for the same reason (web-uplift-4rv): the exposure verdict is the one thing
  // a test cannot provoke from a real browser here, because this Chrome correctly refuses
  // non-loopback, and "the launch fails closed when the endpoint IS exposed" is exactly the
  // behaviour worth telling from a source grep. Production always uses the real probe.
  exposureProbe = (port, pid) => cdpEndpointExposure(port, { pid }),
  // web-uplift-j3re: the PIPE is the default, because it is the only transport with no listening
  // endpoint for another local process to attach to. 'port' stays available and stays guarded: it is
  // what 4rv's exposure verdict exists for, and passing it is a deliberate choice to publish a port.
  transport = 'pipe',
} = {}) {
  const chromePath = resolveChromePath();
  const reasons = [];
  let lastDetail = null;
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    const result = await launchChromeOnce({ chromePath, headless, log, devtoolsTimeoutMs, transport, exposureProbe });
    if (result.ok) {
      if (attempt > 1) {
        try {
          log(`[browser] launch recovered on attempt ${attempt}/${LAUNCH_ATTEMPTS}`);
        } catch (err) {
          // The handle is not the caller's until it is returned, so a throwing log here must not leak
          // the browser this attempt just recovered (web-uplift-l93f). Same rule as launchChromeOnce.
          await result.handle.close();
          throw err;
        }
      }
      return result.handle;
    }
    lastDetail = result.detail;
    reasons.push(result.detail.reason);
    if (result.detail.fatal) {
      // A verdict is not a flake. Retrying would spawn another exposed listener, and if a
      // later attempt could not decide, launchChrome would hand the exposed browser to the
      // caller - a security check that can be retried away is not a check (web-uplift-4rv).
      throw new Error(describeLaunchFailure({ attempts: attempt, reasons, detail: result.detail }));
    }
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

// Run-level launch attribution (web-uplift-4wx). The launch-time fact — which
// profile dir and pid a browser has — was already logged here at launch, but
// only to the CALLER's stderr stream, which in a headless agent run persists
// nowhere in the run tree: a primitive still in flight when the reaper (or a
// kill) takes the job down left no artifact tying the surviving/orphaned
// chrome to the invocation that launched it. When the operator (the batch
// runner) sets WEB_UPLIFT_LAUNCH_LOG to a run-level launches.jsonl, every
// caller of this helper appends one JSON line AT LAUNCH TIME — before any
// gathering starts — so a hung primitive killed externally is attributable
// post-mortem from that file alone: primitive, target url, browser pid (the
// reaper kills by process tree) and profile dir.
//
// Best-effort by contract: attribution must never break evidence gathering,
// so an unwritable file is silently skipped, and a missing env var simply
// turns the record off (direct CLI use without the runner opts out).
export function recordLaunch({ primitive, url, chrome, launchesFile = process.env.WEB_UPLIFT_LAUNCH_LOG } = {}) {
  if (!launchesFile || !chrome) return;
  try {
    appendFileSync(
      launchesFile,
      JSON.stringify({
        ts: new Date().toISOString(),
        outcome: 'launched',
        primitive,
        url,
        pid: chrome.proc?.pid ?? null,
        profileDir: chrome.userDataDir ?? null,
        launcherPid: process.pid,
      }) + '\n',
    );
  } catch {
    // Observability is not evidence: never fail the primitive over a marker.
  }
}

// The failure twin of recordLaunch (web-uplift-6x7). A launch attempt that
// fails AFTER the browser process exists tears the tree down and removes the
// profile - nothing is orphaned - but nothing was attributable either: the run
// tree had no record that a browser ever existed for this attempt. Record what
// the attempt knew (pid once spawned, profile dir, the failure reason) to the
// same launches.jsonl with outcome:'failed', so a post-mortem can tell a dead
// attempt from a live one. Same contract as recordLaunch: env-unset is a
// no-op, and a marker failure never breaks the launch path.
export function recordLaunchFailure({ pid, profileDir, reason, launchesFile = process.env.WEB_UPLIFT_LAUNCH_LOG } = {}) {
  if (!launchesFile) return;
  try {
    appendFileSync(
      launchesFile,
      JSON.stringify({
        ts: new Date().toISOString(),
        outcome: 'failed',
        pid: pid ?? null,
        profileDir: profileDir ?? null,
        reason: String(reason ?? 'unknown'),
        launcherPid: process.pid,
      }) + '\n',
    );
  } catch {
    // Observability is not evidence: never fail the launch path over a marker.
  }
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
export async function newSession(portOrHandle, { log = () => {}, cdpDeadlineMs = cdpCallDeadlineMsDefault } = {}) {
  // web-uplift-j3re: a launch HANDLE means the pipe transport, where no port exists to dial; a
  // number keeps the websocket path unchanged, so the port route stays supported (and audited by
  // 4rv's exposure guard) rather than being deleted with the fix.
  if (portOrHandle && typeof portOrHandle === 'object' && portOrHandle.pipe) {
    return newPipeSession(portOrHandle, { log, cdpDeadlineMs });
  }
  const port = portOrHandle;
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
    // Best-effort cleanup if the attach retries are exhausted - and BOUNDED, because the
    // browser that just exhausted the attach deadline is exactly the browser that may never
    // answer this Close either: an unbounded cleanup await after a deadline has fired is how
    // a bounded operation still hangs.
    await withDeadline(CDP.Close({ port, id: target.id }), cdpDeadlineMs, 'the browser to close the unattached target').catch(() => {});
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
    // Teardown is bounded for the same reason: by the time close() runs, the browser may
    // already have proven itself unresponsive.
    try {
      await withDeadline(client.close(), cdpDeadlineMs, 'the CDP client to close');
    } catch {
      // ignore
    }
    try {
      await withDeadline(CDP.Close({ port, id: targetId }), cdpDeadlineMs, 'the browser to close the target');
    } catch {
      // ignore
    }
  }

  return { client, targetId, close };
}

// The pipe equivalent of newSession: create a target, attach FLAT (so commands and events carry a
// sessionId instead of a nested session), enable the same domains, and return the same shape - so a
// caller cannot tell which transport it got apart from the handle it passed in.
async function newPipeSession(chrome, { log = () => {}, cdpDeadlineMs }) {
  const { pipe } = chrome;
  const created = await withDeadline(
    pipe.send('Target.createTarget', { url: 'about:blank' }),
    cdpDeadlineMs,
    'the browser to accept a new target over the pipe',
  );
  const targetId = created.targetId;
  let sessionId;
  try {
    const attached = await withDeadline(
      pipe.send('Target.attachToTarget', { targetId, flatten: true }),
      cdpDeadlineMs,
      'the browser to accept a pipe attach',
    );
    sessionId = attached.sessionId;
  } catch (err) {
    // Bounded cleanup, for the same reason the websocket path bounds its own: a browser that just
    // missed a deadline is exactly the browser that may never answer a close.
    await withDeadline(pipe.send('Target.closeTarget', { targetId }), cdpDeadlineMs, 'the browser to close the unattached target').catch(() => {});
    throw err;
  }

  const client = createPipeClient(pipe, sessionId);
  await withDeadline(
    Promise.all([client.Page.enable(), client.Runtime.enable(), client.DOM.enable(), client.CSS.enable(), client.Network.enable()]),
    cdpDeadlineMs,
    'the browser to enable the CDP domains over the pipe',
  );
  log('[browser] session ready (pipe)');

  async function close() {
    try {
      await withDeadline(pipe.send('Target.closeTarget', { targetId }), cdpDeadlineMs, 'the browser to close the target over the pipe');
    } catch {
      // ignore: the session is going away either way
    }
  }

  return { client, targetId, sessionId, close };
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

export async function attachConsoleCollector(client, { log = () => {}, cdpDeadlineMs = cdpCallDeadlineMsDefault } = {}) {
  const entries = [];
  const byKey = new Map(); // dedupe key -> recorded entry (with a repeat count)
  let ignoredCount = 0; // info/log/debug/verbose, counted but not itemised
  let droppedCount = 0; // past the buffer cap

  // Every page-derived string that reaches this artifact goes through the shared credential
  // redaction HERE, at the one place all three entry paths converge (web-uplift-lsn3). A console
  // entry's url is whatever the page requested - a failed <script src> with a credential in its
  // query is the ordinary case - and its text can carry a URL too, because a page can log
  // location.href. `console` is written to disk by every primitive, so an unredacted copy here
  // lands in every artifact; the externalScriptFailures list was fixed for the same reason and
  // this surface was missed. Redacting before the dedupe key keeps retries collapsed.
  const redactEntry = (entry) => {
    const url = entry.url === undefined ? undefined : redactUrlCredentialValues(entry.url);
    return {
      ...entry,
      ...(url === undefined ? {} : { url }),
      ...(typeof entry.text === 'string' ? { text: redactUrlsInText(entry.text) } : {}),
    };
  };

  const record = (rawEntry) => {
    const entry = redactEntry(rawEntry);
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
  // The frame's url is redacted on its own, not by the prose sweep: a stack frame is
  // "fn (url:line:column)" and a URL-shaped match in that string would swallow the line and
  // column along with the credential (web-uplift-lsn3).
  const framesOf = (stackTrace) =>
    (stackTrace?.callFrames || [])
      .slice(0, 3)
      .map((f) => {
        const url = f.url ? redactUrlCredentialValues(f.url) : '?';
        // The function name is page-derived too: a computed method name can BE a URL, and it
        // reaches this artifact inside stack[]. Redacting only the url field left that open
        // (web-uplift-lsn3 review).
        const name = f.functionName ? redactUrlsInText(f.functionName) : '<anonymous>';
        return `${name} (${url}:${f.lineNumber + 1}:${f.columnNumber + 1})`;
      });

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

  await withDeadline(
    Promise.all([
      client.Runtime.enable().catch(() => {}),
      client.Log.enable().catch((err) => log(`[evidence] console collector: Log.enable failed: ${err.message}`)),
    ]),
    cdpDeadlineMs,
    'the browser to enable the console collector domains',
  );

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
    const session = await newSession(chrome, { log });
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
