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
import { gather } from '../evidence/cli.mjs';
import { launchChrome, resolveChromePath, sandboxDisableReason } from '../evidence/cdp.mjs';
import { testCdpEndpointExposure, testEndpointProbesRunConcurrently, testEndpointProbeRejectionStaysFailClosed } from './cdp-endpoint-exposure.mjs';
import { testCdpPipeTransport, testSilentPipeReadinessIsBounded, testClosedPipeRejectsPendingSends, testPipeReadinessThenExitFailsTheLaunch } from './cdp-pipe-transport.mjs';

// resolveChromePath must find a Chrome for Testing / Puppeteer cache binary when
// CHROME_BIN is not set. The fleet VMs have no distro Chrome, so before this an
// npm test run there failed only after it had already queued for the single
// heavy slot. No browser is launched: the candidates are plain files in a fake
// HOME, which also pins the override precedence (CHROME_BIN > CHROME_PATH >
// cache > distro).
export function testChromeCandidateDiscovery() {
  const home = mkdtempSync(join(tmpdir(), 'web-uplift-chrome-cache-'));
  const cftNew = join(home, '.cache', 'chrome', 'linux-1000.0.0.0', 'chrome-linux64', 'chrome');
  const cftOld = join(home, '.cache', 'chrome', 'linux-999.0.8037.99', 'chrome-linux64', 'chrome');
  const puppeteer = join(home, '.cache', 'puppeteer', 'chrome', 'linux-888.0.0.0', 'chrome-linux64', 'chrome');
  const alias = join(home, 'chrome-path-alias');
  const binOverride = join(home, 'chrome-bin-override');
  for (const file of [cftNew, cftOld, puppeteer, alias, binOverride]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }

  const saved = new Map(['HOME', 'CHROME_BIN', 'CHROME_PATH'].map((name) => [name, process.env[name]]));
  try {
    process.env.HOME = home;
    delete process.env.CHROME_BIN;
    delete process.env.CHROME_PATH;

    assert(
      resolveChromePath() === cftNew,
      `CHROME_BIN unset: the newest cache version must win (numeric sort, not lexicographic), got ${resolveChromePath()}`,
    );
    // A cache path that exists but is not an executable file (a partial extract
    // or directory husk) must be skipped, not returned and left to fail at spawn.
    chmodSync(cftNew, 0o644);
    assert(
      resolveChromePath() === cftOld,
      `a non-executable cache entry must be skipped in favour of the next candidate, got ${resolveChromePath()}`,
    );
    chmodSync(cftNew, 0o755);
    assert(resolveChromePath() === cftNew, `an executable cache entry must be used, got ${resolveChromePath()}`);
    rmSync(cftNew);
    rmSync(cftOld);
    assert(
      resolveChromePath() === puppeteer,
      `CHROME_BIN unset: must fall back to the Puppeteer cache layout, got ${resolveChromePath()}`,
    );
    process.env.CHROME_PATH = alias;
    assert(
      resolveChromePath() === alias,
      `CHROME_PATH must be honoured as a CHROME_BIN alias, got ${resolveChromePath()}`,
    );
    process.env.CHROME_BIN = binOverride;
    assert(
      resolveChromePath() === binOverride,
      `CHROME_BIN must win over CHROME_PATH, got ${resolveChromePath()}`,
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}


// The launch layer must retry the WHOLE attempt (a fresh profile dir each time)
// and must say WHY it failed, because "still alive but silent" (a wedge) and
// "exited early" (a crash) are different faults with different fixes, and a
// bare "timed out" collapses them into one symptom. A fake CHROME_BIN that exits
// immediately, and one that fails once and then prints the DevTools line,
// exercise the retry, the diagnostics, the recovery and the profile-dir cleanup
// with no real browser, so this stays cheap and deterministic.
export async function testLaunchRetryAndDiagnostics() {
  const savedBin = process.env.CHROME_BIN;
  const dir = mkdtempSync(join(tmpdir(), 'web-uplift-launch-retry-'));
  try {
    // Every attempt exits immediately: retry, then a diagnostic failure.
    const marker = join(dir, 'attempts');
    const failing = join(dir, 'failing-chrome');
    writeFileSync(failing, `#!/bin/sh\necho attempt >> "${marker}"\nexit 7\n`, { mode: 0o755 });
    const profiles = [];
    process.env.CHROME_BIN = failing;
    let error = null;
    try {
      await launchChrome({
        log: (line) => {
          const match = /profile (\S+)\)/.exec(line);
          if (match) profiles.push(match[1]);
        },
      });
    } catch (err) {
      error = err;
    }
    assert(error instanceof Error, 'launchChrome must reject when every attempt fails');
    // Both transports must NAME the early exit. They word it differently because the port path parses
    // Chrome's DevTools line out of stderr while the pipe path reads the process state; BOTH now attach
    // that stderr to the failure detail (web-uplift-ik04). The pipe half of that capture is asserted
    // HERE, by the wedge fake in testLaunchRetryAndDiagnostics that echoes a marker to fd 2; an earlier
    // version of this comment pointed at the pipe test file, which has no marker fake at all.
    assert(/exited (early|during startup)/.test(error.message),
      `launch failure must name the early exit: ${error.message}`);
    assert(/code 7/.test(error.message), `launch failure must report the exit code: ${error.message}`);
    assert(/freshProfile=true/.test(error.message), `launch failure must report a fresh profile: ${error.message}`);
    assert(/alive=false/.test(error.message), `launch failure must report liveness: ${error.message}`);
    assert(/stderr=/.test(error.message), `launch failure must report stderr: ${error.message}`);
    if (existsSync('/proc/loadavg')) {
      assert(/load=/.test(error.message), `launch failure must report host load: ${error.message}`);
    }
    const spawns = existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    assert(profiles.length > 1, `launchChrome must retry the whole launch, saw ${profiles.length} attempt(s)`);
    assert(spawns === profiles.length, `each retry must spawn once, marker=${spawns} profiles=${profiles.length}`);
    assert(new Set(profiles).size === profiles.length, 'each retry must use a fresh profile dir');
    for (const profile of profiles) {
      assert(!existsSync(profile), `a failed launch must clean up its profile dir: ${profile}`);
    }

    // A browser that announces its DevTools endpoint and THEN dies must fail the attempt, not return a
    // handle for a corpse. The endpoint promise resolves on the announcement, so the later exit cannot
    // reject it: without an explicit liveness check after the exposure probe, launchChrome returns a
    // success handle AND never retries, because the attempt is never seen as failed (web-uplift-py0e).
    const dying = join(dir, 'announce-then-die-chrome');
    writeFileSync(dying, '#!/bin/sh\necho "DevTools listening on ws://127.0.0.1:1/" >&2\nexit 3\n', { mode: 0o755 });
    process.env.CHROME_BIN = dying;
    let dyingError = null;
    try {
      await launchChrome({
        transport: 'port',
        devtoolsTimeoutMs: 2000,
        // The synchronous stub is deliberate, and it makes this case DETERMINISTIC. An earlier version of
        // this comment argued the opposite and was wrong: it read the harness metric "handleDead" (the
        // LAUNCHER returned a handle) as the mutation escaping, when a dead handle is exactly what makes
        // this test's assertion fire - so a dead handle is the test DETECTING the mutation. The real
        // probe's asynchronous work incidentally gives Node time to observe the exit, so without the
        // settle the launcher rejects anyway and the mutant SURVIVES mostly (measured 7 of 8 and 9 of 10
        // in review, 1 in 4 detected for me; the rate is load-dependent). The stub removes
        // that accidental pause: measured over 8 runs, removing the settle then fails the test 8 of 8
        // (web-uplift-py0e, second-opinion review). The CONTROL launch below keeps the real probe, on a
        // LIVE browser through to a successful launch; note that no integration test now runs the real
        // probe against a browser that is EXITING, which this dying case did in most runs before. A dead
        // pid is still covered at unit level, in tests/cdp-endpoint-exposure.mjs.
        exposureProbe: () => ({ exposed: false }),
        log: () => {},
      });
    } catch (err) { dyingError = err; }
    assert(dyingError instanceof Error,
      'a browser that exits during the launch must fail it, not produce a handle for a dead browser');
    assert(/exited \(code 3/.test(dyingError.message),
      `the failure must name the exit rather than a generic error: ${dyingError.message}`);
    // A browser dying during launch is plausibly a one-off, so the attempt must be RETRIED, not fatal.
    // Without this assertion, changing the failure to fatal would silently pass.
    assert(/after 3 attempt/.test(dyingError.message),
      `a crash during launch must be retried, not treated as fatal: ${dyingError.message}`);
    // CONTROL, so that a launcher which simply failed every launch could not pass this test.
    const live = join(dir, 'announce-and-live-chrome');
    writeFileSync(live, '#!/bin/sh\necho "DevTools listening on ws://127.0.0.1:1/" >&2\nwhile true; do sleep 1; done\n', { mode: 0o755 });
    process.env.CHROME_BIN = live;
    const liveHandle = await launchChrome({ transport: 'port', devtoolsTimeoutMs: 2000, log: () => {} });
    assert(liveHandle && liveHandle.proc && liveHandle.proc.exitCode === null,
      'CONTROL: a browser that announces its endpoint and stays alive must still launch');
    await liveHandle.close();

    // A wedge (browser still alive but never printing the DevTools line) must be
    // reported as ALIVE, not as the SIGTERM-killed process that teardown leaves
    // behind. The short timeout keeps this cheap, and this is the assertion that
    // fails if liveness is read after close() instead of before it.
    const wedging = join(dir, 'wedging-chrome');
    writeFileSync(wedging, '#!/bin/sh\necho "wedge-marker-h6yn" >&2\nsleep 30\n', { mode: 0o755 });
    const wedgeProfiles = [];
    process.env.CHROME_BIN = wedging;
    let wedgeError = null;
    try {
      await launchChrome({
        devtoolsTimeoutMs: 400,
        log: (line) => {
          const match = /profile (\S+)\)/.exec(line);
          if (match) wedgeProfiles.push(match[1]);
        },
      });
    } catch (err) {
      wedgeError = err;
    }
    assert(wedgeError instanceof Error, 'a wedged chrome must fail the launch');
    assert(/alive=true/.test(wedgeError.message), `a wedge must be reported as alive-but-silent: ${wedgeError.message}`);
    assert(/signal=null/.test(wedgeError.message), `a wedge must not be reported as signal-killed: ${wedgeError.message}`);
    // The stderr half of the diagnosis needs its own evidence: "stderr=" also matches "(stderr empty)",
    // so on its own it proves nothing about the capture (the opus review of 5da2310 said exactly that).
    // The wedge fake writes this marker to fd 2, and it must survive into the reported failure.
    assert(/wedge-marker-h6yn/.test(wedgeError.message),
      `a wedge must carry the browser's own stderr into the failure: ${wedgeError.message}`);
    assert(/stderr=/.test(wedgeError.message), `a wedge must report stderr: ${wedgeError.message}`);
    assert(wedgeProfiles.length > 1, `a wedged launch must still retry, saw ${wedgeProfiles.length}`);
    for (const profile of wedgeProfiles) {
      assert(!existsSync(profile), `a wedged launch must clean up its profile dir: ${profile}`);
    }

    // A transient failure followed by a good launch must recover on retry.
    const counter = join(dir, 'count');
    const flaky = join(dir, 'flaky-chrome');
    writeFileSync(
      flaky,
      `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0)\nn=$((n + 1))\necho $n > "${counter}"\n` +
        `if [ "$n" -ge 2 ]; then echo "DevTools listening on ws://127.0.0.1:9222/" 1>&2; sleep 30; fi\nexit 5\n`,
      { mode: 0o755 },
    );
    process.env.CHROME_BIN = flaky;
    // The fake writes a DevTools listening line on stderr, which only the PORT transport parses, so this
    // recovery test asks for it (web-uplift-ik04).
    const handle = await launchChrome({ log: () => {}, transport: 'port' });
    assert(handle.port === 9222, `a recovered launch must parse the DevTools port, got ${handle.port}`);
    assert(readFileSync(counter, 'utf8').trim() === '2', 'the flaky launch must recover on its second attempt');
    await handle.close();
    assert(!existsSync(handle.userDataDir), `close must remove the profile dir: ${handle.userDataDir}`);
  } finally {
    if (savedBin === undefined) delete process.env.CHROME_BIN;
    else process.env.CHROME_BIN = savedBin;
    rmSync(dir, { recursive: true, force: true });
  }
}


// web-uplift-d2l: every primitive navigates a page the operator does not control,
// so Chrome's OS sandbox must be ON unless the operator explicitly opts out or
// Chrome cannot start it at all (root). The claim is about the ARGUMENTS the
// browser is spawned with, so it is asserted from a fake CHROME_BIN that records
// its own argv - not from launchChrome's own logging, which could describe an
// intent the argv does not carry.
export async function testChromeSandboxPolicy() {
  // The decision itself: unset, empty and false-y all keep the sandbox on.
  assert(sandboxDisableReason({ env: {}, uid: 1000 }) === null, 'an unset WEB_UPLIFT_NO_SANDBOX must keep the sandbox on');
  assert(sandboxDisableReason({ env: { WEB_UPLIFT_NO_SANDBOX: '0' }, uid: 1000 }) === null, 'WEB_UPLIFT_NO_SANDBOX=0 must keep the sandbox on');
  assert(sandboxDisableReason({ env: { WEB_UPLIFT_NO_SANDBOX: '1' }, uid: 1000 }) !== null, 'WEB_UPLIFT_NO_SANDBOX=1 must disable the sandbox');
  assert(sandboxDisableReason({ env: {}, uid: 0 }) !== null, 'running as root must disable the sandbox (Chrome cannot start it as uid 0)');

  const savedBin = process.env.CHROME_BIN;
  const savedOptOut = process.env.WEB_UPLIFT_NO_SANDBOX;
  const dir = mkdtempSync(join(tmpdir(), 'web-uplift-sandbox-'));
  try {
    const argvFile = join(dir, 'argv');
    const fake = join(dir, 'chrome');
    // Records the arguments, announces the DevTools line so the launch succeeds,
    // then stays alive for close() to tear down (the same shape the retry test
    // uses above).
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\necho "DevTools listening on ws://127.0.0.1:9223/" 1>&2\nsleep 30\n`,
      { mode: 0o755 },
    );
    process.env.CHROME_BIN = fake;

    delete process.env.WEB_UPLIFT_NO_SANDBOX;
    // transport: 'port' because this fake announces a DevTools listening line, which only the port
    // transport reads; the pipe default would wait for a protocol the fake does not speak (web-uplift-ik04).
    const byDefault = await launchChrome({ log: () => {}, transport: 'port' });
    await byDefault.close();
    const defaultArgs = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
    // The policy verdict for THIS process (a suite run as root is the one case
    // where the ambient launch is legitimately the disabled one) - the argv must
    // match it rather than silently disagreeing with the logged reason.
    const ambientReason = sandboxDisableReason();
    assert(
      defaultArgs.includes('--no-sandbox') === (ambientReason !== null),
      `the default launch must keep Chrome's OS sandbox on unless the policy says otherwise (policy says ${ambientReason ?? 'sandbox on'}), argv: ${JSON.stringify(defaultArgs)}`,
    );

    process.env.WEB_UPLIFT_NO_SANDBOX = '1';
    const optedOut = await launchChrome({ log: () => {}, transport: 'port' });
    await optedOut.close();
    const optedOutArgs = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
    assert(
      optedOutArgs.includes('--no-sandbox'),
      `WEB_UPLIFT_NO_SANDBOX=1 must pass --no-sandbox, argv: ${JSON.stringify(optedOutArgs)}`,
    );
  } finally {
    if (savedBin === undefined) delete process.env.CHROME_BIN;
    else process.env.CHROME_BIN = savedBin;
    if (savedOptOut === undefined) delete process.env.WEB_UPLIFT_NO_SANDBOX;
    else process.env.WEB_UPLIFT_NO_SANDBOX = savedOptOut;
    rmSync(dir, { recursive: true, force: true });
  }
}


// web-uplift-17o: a starved host can leave the browser never answering, and until the CDP
// deadline landed the evidence CLI waited INDEFINITELY (the dl6 reproduction). The honest
// evidence is a BOUNDED REPRODUCTION of the wait, not an assertion that a timeout constant
// exists: a server that accepts connections and never responds is the starvation condition
// itself (the load event never fires), and the navigation must fail loudly within the order
// of the deadline, naming the URL, the bound and how to raise it.
export async function testCdpDeadline() {
  const { withDeadline, launchChrome, newSession, navigate } = await import(
    pathToFileURL(join(repoRoot, 'evidence/cdp.mjs')).href
  );

  // THE MECHANISM, directly: a promise that never settles must reject within the bound,
  const t0 = Date.now();
  let mechErr = null;
  try {
    await withDeadline(new Promise(() => {}), 120, 'the test wait');
  } catch (e) {
    mechErr = e;
  }
  assert(
    mechErr && mechErr.message.includes('timed out after 120ms waiting for the test wait'),
    `17o deadline: a never-settling wait must reject with the loud text (${mechErr && mechErr.message})`,
  );
  assert(
    mechErr && mechErr.message.includes('--cdp-deadline'),
    '17o deadline: the error must say how to raise the bound',
  );
  assert(
    Date.now() - t0 < 5000,
    `17o deadline: the rejection must arrive at the order of the bound, not the suite timeout (${Date.now() - t0}ms)`,
  );
  // and a promise that settles must pass through undisturbed.
  assert(
    (await withDeadline(Promise.resolve(42), 120, 'a settled wait')) === 42,
    '17o deadline: a settling promise must pass through',
  );

  // --out naming a directory (or a path with a missing parent) must fail LOUDLY AND FAST,
  // before any browser is launched - the raw EISDIR used to surface from writeFileSync
  // mid-run and read as a tool bug.
  const healthy = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>ok</title><p>healthy</p>');
  });
  await new Promise((res) => healthy.listen(0, '127.0.0.1', res));
  const page = `http://127.0.0.1:${healthy.address().port}/`;
  const t1 = Date.now();
  const badOut = run(process.execPath, ['evidence/cli.mjs', 'dom', page, '--out', tmp]);
  assert(badOut.status !== 0, `17o --out: a directory must be rejected (exit ${badOut.status})`);
  assert(
    (badOut.stderr || '').includes('must be a file path') && (badOut.stderr || '').includes(tmp),
    `17o --out: the error must name the path (${badOut.stderr})`,
  );
  assert(
    !(badOut.stderr || '').includes('[browser] launching'),
    `17o --out: the rejection must precede any browser launch, asserted by the ABSENCE of the launch diagnostic, not inferred from elapsed time (${badOut.stderr})`,
  );
  const missingParent = run(process.execPath, ['evidence/cli.mjs', 'dom', page, '--out', join(tmp, 'no-such-dir', 'x.json')]);
  assert(
    missingParent.status !== 0 && (missingParent.stderr || '').includes('does not exist'),
    `17o --out: a missing parent directory must be rejected loudly (${missingParent.stderr})`,
  );
  assert(
    !(missingParent.stderr || '').includes('[browser] launching'),
    '17o --out: the missing-parent rejection must also precede any browser launch (absence of the launch diagnostic)',
  );

  // THE REAL PATH: a server that accepts connections and never answers. The first
  // navigation (about:blank) completes; the second load event never fires, and the
  // deadline must turn an indefinite hang into a loud, bounded failure.
  const sockets = new Set();
  // The handler firing IS the proof the target was contacted: a deadline that fires BEFORE
  // the target navigation (e.g. on the about:blank pre-step under load) leaves this at zero,
  // and the starved assertions below REQUIRE it to have increased - otherwise the test would
  // pass without ever reproducing the starvation it claims to reproduce.
  let blackholeHits = 0;
  const blackhole = http.createServer(() => {
    blackholeHits += 1;
    /* accept and never answer */
  });
  blackhole.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise((res) => blackhole.listen(0, '127.0.0.1', res));
  const chrome = await launchChrome({ log: () => {} });
  try {
    const session = await newSession(chrome, { log: () => {} });
    try {
      const starvedUrl = `http://127.0.0.1:${blackhole.address().port}/`;
      const hitsBeforeNav = blackholeHits;
      const t2 = Date.now();
      let navErr = null;
      try {
        // 1500ms, not a few hundred: under fleet load the about:blank pre-step alone can
        // exceed a very small deadline (observed in the first gate run), and the bound must
        // survive that while still firing promptly on the never-responding target. Every
        // step's message names the ultimate target URL, so the assertion holds whichever
        // step the bound fires on - and the run is bounded either way, which is the claim.
        await navigate(session.client, starvedUrl, { settleMs: 0, navigationDeadlineMs: 1500 });
      } catch (e) {
        navErr = e;
      }
      const elapsed = Date.now() - t2;
      assert(
        navErr && navErr.message.includes('timed out after 1500ms'),
        `17o: a starved navigation must fail loudly with the bound (${navErr && navErr.message})`,
      );
      assert(
        navErr &&
          (navErr.message.includes(`the load event for ${starvedUrl}`) ||
            navErr.message.includes(`the navigation to ${starvedUrl}`)),
        `17o: the failure must identify the TARGET wait, not the about:blank pre-step (${navErr && navErr.message})`,
      );
      assert(
        blackholeHits > hitsBeforeNav,
        `17o: the black-hole server must have been CONTACTED (hits ${hitsBeforeNav} -> ${blackholeHits}) - otherwise the starvation was never reached and this test proves nothing`,
      );
      assert(
        elapsed < 15000,
        `17o: the starved navigation must return at the order of the deadline, not the suite timeout (${elapsed}ms)`,
      );
      // CONTROL: the same navigation with a generous deadline against a healthy server must
      // complete, so the bound is not just always-failing.
      let controlErr = null;
      try {
        await navigate(session.client, page, { settleMs: 0, navigationDeadlineMs: 20000 });
      } catch (e) {
        controlErr = e;
      }
      assert(
        !controlErr,
        `17o control: a healthy navigation under a generous deadline must complete (${controlErr && controlErr.message})`,
      );
    } finally {
      await session.close();
    }
  } finally {
    await chrome.close();
  }

  // THE TRACE PATH, reproduced the same way: the trace primitive navigates DIRECTLY (it
  // must start tracing before navigationStart), and before this revision its load wait had
  // no bound at all - the hole found while writing the residual note. Driven IN-PROCESS via
  // gather() (the suite's convention, as the har tests do it): a CLI child cannot be used
  // here because spawnSync blocks this process's event loop, which would freeze the test's
  // own servers - observed directly: SERVER HITS 0 and a 30s timeout on a healthy page.
  // The deadline is set through the same module state the CLI flag writes, and RESTORED in
  // the finally so the rest of the suite keeps the production defaults.
  // COVERAGE, STATED PRECISELY SO IT DOES NOT OVERCLAIM: this case reproduces a PAGE-side
  // stall (the server never answers, so the navigation and load waits must fire their
  // bounds). The mechanism itself is unit-tested (a never-settling promise rejects within
  // the bound; a settling one passes through), and the tracing call sites are enumerated and
  // code-covered. This case CANNOT fire the tracingComplete / Tracing.end bounds - those
  // are answered by the BROWSER, not the page, so a never-responding server never reaches
  // them; their firing is demonstrated by the STUB-CLIENT cases below (web-uplift-4ux).
  // What remains unreproduced is a REAL wedged browser mid-trace (a frozen Chrome on a
  // live socket): wedging a real browser takes an OS-level freeze or a stalling proxy on
  // the CDP port, and the stubs below already reproduce its observable failure - the
  // event never arrives, the command is never acked - in-process, with no browser to
  // wedge and no flake, so the real wedge stays out of the suite.
  const { gather, trace } = await import(pathToFileURL(join(repoRoot, 'evidence/cli.mjs')).href);
  const { configureCdpDeadlines } = await import(pathToFileURL(join(repoRoot, 'evidence/cdp.mjs')).href);
  const bhUrl = `http://127.0.0.1:${blackhole.address().port}/`;
  const hitsBeforeTrace = blackholeHits;
  try {
    configureCdpDeadlines({ navigationMs: 4000, callMs: 4000 });
    const t3 = Date.now();
    let traceErr = null;
    try {
      await gather('trace', bhUrl, { quiet: true, wait: 100, out: join(tmp, 'trace-starved.json') });
    } catch (e) {
      traceErr = e;
    }
    const traceElapsed = Date.now() - t3;
    assert(
      traceErr && traceErr.message.includes('timed out after 4000ms'),
      `17o trace: a starved trace must fail loudly with the bound (${traceErr && traceErr.message})`,
    );
    assert(
      traceErr &&
        (traceErr.message.includes(`the load event for ${bhUrl}`) ||
          traceErr.message.includes(`the navigation to ${bhUrl}`)),
      `17o trace: the failure must identify the TARGET wait, not the about:blank pre-step (${traceErr && traceErr.message})`,
    );
    assert(
      blackholeHits > hitsBeforeTrace,
      `17o trace: the black-hole server must have been CONTACTED (hits ${hitsBeforeTrace} -> ${blackholeHits}) - otherwise the starvation was never reached`,
    );
    assert(
      traceElapsed < 30000,
      `17o trace: the starved trace must return at the order of the deadline, not the suite timeout (${traceElapsed}ms)`,
    );
  } finally {
    configureCdpDeadlines({ navigationMs: 30000, callMs: 30000 });
  }
  // HEALTHY CONTROL for the same primitive: a wrap added to a real primitive whose
  // generous-deadline behaviour is not asserted would let the fix break the primitive
  // silently, and trace is user-visible - so it must still succeed when healthy.
  let healthyTraceErr = null;
  try {
    await gather('trace', page, { quiet: true, wait: 200, out: join(tmp, 'trace-ok.json') });
  } catch (e) {
    healthyTraceErr = e;
  }
  assert(
    !healthyTraceErr && existsSync(join(tmp, 'trace-ok.json')),
    `17o trace control: a healthy trace under the default deadline must complete and write its artifact (${healthyTraceErr && healthyTraceErr.message})`,
  );
  // web-uplift-4ux: STUB FIRING REPRO for the two tracing bounds of the trace path. The
  // starved case above stalls the PAGE side, which fires the load-event bound before the
  // browser is ever asked to answer the two tracing waits. These cases drive the exported
  // trace() directly with a fake client: no browser exists in these cases, and every
  // await on the path is either withDeadline-wrapped or a fixed sleep(), so no stub-side
  // wait can be unbounded - the bound-firing cases EXPECT the deadline rejection (the
  // healthy control would fail loudly instead). What the stubs demonstrate: the
  // tracing-COMPLETE bound fires with the actionable error when the event never arrives,
  // the tracing-END bound fires when the command is never acked, and the healthy control
  // writes both artifacts when the event does arrive. What they do NOT demonstrate: a real
  // wedged browser mid-trace (see the coverage note above - deliberately out of the suite).
  const stubClient = ({ completeFires, endResolves }) => ({
    Page: {
      navigate: async () => ({}),
      loadEventFired: () => Promise.resolve({ timestamp: 0 }),
    },
    Tracing: {
      dataCollected: () => {},
      start: async () => ({}),
      end: endResolves ? async () => ({}) : () => new Promise(() => {}),
      tracingComplete: (cb) => {
        if (completeFires) setTimeout(() => cb({ dataLossInfo: [] }), 0);
      },
    },
  });
  const STUB_DEADLINE_MS = 300;
  const stubUrl = 'http://stub.invalid/';
  // TEST-OWNED TIMEOUT, and why it is NOT redundant - do not remove it: the assertions
  // below must be able to FAIL ON THEIR OWN. The stub promises behind the two failure
  // cases never settle, so if the production bound were ever removed or broken, awaiting
  // trace() directly would HANG the suite (the runner has no timeout of its own) - and a
  // guard that cannot report the exact regression it exists to catch is not a control.
  // Each failure-case call therefore races a test deadline set comfortably above the
  // production bound, so the two cannot be confused: bound present -> the production
  // rejection wins the race and the assertions check its text; bound absent -> the test
  // deadline wins and the case fails BY ASSERTION within TEST_OWNED_TIMEOUT_MS, naming
  // which bound never rejected.
  const TEST_OWNED_TIMEOUT_MS = 5000;
  const withTestTimeout = (call, boundName) => {
    let timer = null;
    return Promise.race([
      call,
      new Promise((_, rejectTest) => {
        timer = setTimeout(
          () =>
            rejectTest(
              new Error(
                `4ux stub: TEST-OWNED TIMEOUT - the production bound (${boundName}) did not reject within ${TEST_OWNED_TIMEOUT_MS}ms; without it this call never settles and the suite would hang`,
              ),
            ),
          TEST_OWNED_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  };
  try {
    configureCdpDeadlines({ navigationMs: STUB_DEADLINE_MS, callMs: STUB_DEADLINE_MS });
    // (a) the tracing-complete event never arrives -> that bound must fire.
    const t4 = Date.now();
    let completeErr = null;
    try {
      await withTestTimeout(
        trace(
          stubClient({ completeFires: false, endResolves: true }),
          stubUrl,
          { wait: 0, out: join(tmp, 'trace-stub-complete.json') },
          () => {},
        ),
        'the trace-to-complete bound',
      );
    } catch (e) {
      completeErr = e;
    }
    const completeElapsed = Date.now() - t4;
    assert(
      completeErr &&
        completeErr.message.includes(`timed out after ${STUB_DEADLINE_MS}ms waiting for the trace to complete for ${stubUrl}`),
      `4ux stub: a tracing-complete event that never arrives must fire the bound with the actionable text (${completeErr && completeErr.message})`,
    );
    assert(
      completeErr && completeErr.message.includes('--cdp-deadline'),
      '4ux stub: the rejection must say how to raise the bound',
    );
    assert(
      !existsSync(join(tmp, 'trace-stub-complete.json')),
      '4ux stub: a starved stub trace must not write an artifact',
    );
    assert(
      completeElapsed < 10000,
      `4ux stub: the rejection must arrive at the order of the bound, not the suite timeout (${completeElapsed}ms)`,
    );
    // (b) Tracing.end is never acked -> the end bound must fire (the complete wait is never reached).
    let endErr = null;
    try {
      await withTestTimeout(
        trace(
          stubClient({ completeFires: false, endResolves: false }),
          stubUrl,
          { wait: 0, out: join(tmp, 'trace-stub-end.json') },
          () => {},
        ),
        'the browser-to-end-tracing bound',
      );
    } catch (e) {
      endErr = e;
    }
    assert(
      endErr &&
        endErr.message.includes(`timed out after ${STUB_DEADLINE_MS}ms waiting for the browser to end tracing for ${stubUrl}`),
      `4ux stub: an unacked Tracing.end must fire its own bound (${endErr && endErr.message})`,
    );
    // (c) HEALTHY CONTROL: same stub, event fires -> trace completes and writes both
    // artifacts. The control races a setTimeout(0) against the bound, so it gets a
    // GENEROUS deadline: the small bound above is for the firing cases only, and a tiny
    // deadline under fleet load is a known flake shape in this suite.
    configureCdpDeadlines({ navigationMs: 10000, callMs: 10000 });
    const stubOkOut = join(tmp, 'trace-stub-ok.json');
    const stubOk = await trace(
      stubClient({ completeFires: true, endResolves: true }),
      stubUrl,
      { wait: 0, out: stubOkOut },
      () => {},
    );
    assert(
      existsSync(stubOkOut) && existsSync(join(tmp, 'trace-stub-ok-summary.json')),
      '4ux stub control: a healthy stub trace must write the raw trace and the summary artifacts',
    );
    assert(
      stubOk && stubOk.eventCount === 0 && stubOk.mainThread && stubOk.summaryArtifact,
      `4ux stub control: the summary must be returned even with zero events (${JSON.stringify(stubOk).slice(0, 200)})`,
    );
  } finally {
    configureCdpDeadlines({ navigationMs: 30000, callMs: 30000 });
  }
  // RESILIENCE: its initial load goes through navigate() (bounded above), and its offline
  // reload is wrapped with its own offlineBudget; the suite's existing resilience tests
  // drive the primitive healthy against a local server, including that reload - so the
  // healthy control for this wrap already exists in the suite rather than being duplicated.
  blackhole.close();
  for (const sock of sockets) sock.destroy();
  healthy.close();
}


// Launch-time attribution (web-uplift-4wx): a primitive still IN FLIGHT when the
// job dies leaves no result artifact, and the browser's profile/pid only ever
// reached the caller's stderr stream — so a surviving or orphaned chrome could
// not be tied to the invocation that launched it. With WEB_UPLIFT_LAUNCH_LOG
// set (the batch runner points it at <run dir>/launches.jsonl for every agent
// child), the CLI appends a marker AT LAUNCH. This test is the bead's
// acceptance control, run for real: a primitive against a server that never
// responds is killed EXTERNALLY mid-flight, and the launches.jsonl line alone
// must attribute it — and is then USED to reap the browser, which is the
// post-mortem flow the file exists for. The CLI runs as a child (async spawn,
// never spawnSync: the in-process server must keep answering).
export async function testLaunchAttributionForHungPrimitive() {
  const hung = http.createServer(() => {
    // accepts and never responds: the navigation stays in flight
  });
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  const hungUrl = `http://127.0.0.1:${hung.address().port}/`;
  const runTmp = mkdtempSync(join(tmpdir(), 'web-uplift-launches-'));
  const launchesFile = join(runTmp, 'launches.jsonl');
  const outFile = join(runTmp, 'out.json');

  const child = spawn(
    process.execPath,
    [join(repoRoot, 'evidence/cli.mjs'), 'dom', hungUrl, '--out', outFile],
    {
      cwd: repoRoot,
      env: { ...process.env, WEB_UPLIFT_LAUNCH_LOG: launchesFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let childStderr = '';
  child.stderr.on('data', (chunk) => { childStderr += chunk; });
  const childGone = new Promise((r) => child.on('close', r));

  const killTree = (pid) => {
    // chrome leads its own process group (detached): signal the whole tree.
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  };

  // Track the browser OUTSIDE the success path: any assertion failure below
  // (including the mutation controls that prove this test can fail) must still
  // reap the chrome, or a red run leaks an orphaned browser for the reaper -
  // observed for real on 2026-10-06, when a pid-nulled mutant threw at the
  // field asserts and left /tmp/web-uplift-cdp-* alive until the reaper's
  // 10-minute orphan rule killed it. The marker's own fields are the FIRST
  // source, but cleanup must not DEPEND on marker content: a marker with a
  // nulled pid is exactly the mutation this test uses, so the finally also
  // discovers the browser directly, as the chrome child of the CLI process we
  // spawned (chrome is spawned by the CLI, then detached into its own group).
  let browserPid = null;
  let browserProfile = null;
  const findLaunchedChrome = () => {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1]);
        if (ppid !== child.pid) continue;
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
        if (cmdline.includes('web-uplift-cdp-')) return Number(entry);
      } catch { /* process vanished mid-scan */ }
    }
    return null;
  };

  try {
    // Wait for the LAUNCH-TIME record (bounded; chrome launch on a loaded box
    // can take seconds). The marker must appear while the primitive is hung —
    // if it only ever appeared at completion, this poll would time out.
    let record = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !record) {
      if (child.exitCode !== null) {
        throw new Error(`the CLI exited before any launch marker landed: ${childStderr}`);
      }
      if (existsSync(launchesFile)) {
        const line = readFileSync(launchesFile, 'utf8').trim().split('\n').filter(Boolean)[0];
        if (line) {
          record = JSON.parse(line);
          // Track for the finally's cleanup the moment the marker exists,
          // BEFORE any assert can throw (a malformed marker still names a
          // real browser).
          if (Number.isInteger(record.pid)) browserPid = record.pid;
          if (typeof record.profileDir === 'string') browserProfile = record.profileDir;
        }
      }
      if (!record) await new Promise((r) => setTimeout(r, 250));
    }
    assert(record, `no launch marker within 90s; launches.jsonl attribution is absent (child stderr: ${childStderr.slice(-400)})`);
    assert(record.primitive === 'dom', `the marker must name the primitive: ${JSON.stringify(record)}`);
    assert(record.url === hungUrl, `the marker must name the target: ${JSON.stringify(record)}`);
    assert(Number.isInteger(record.pid) && record.pid > 0, `the marker must carry the browser pid (the reaper kills by tree): ${JSON.stringify(record)}`);
    assert(
      typeof record.profileDir === 'string' && record.profileDir.includes('web-uplift-cdp-'),
      `the marker must carry the profile dir: ${JSON.stringify(record)}`,
    );
    assert(record.launcherPid === child.pid, `the marker must tie back to the invoking process: ${JSON.stringify(record)} vs child ${child.pid}`);
    // THE POINT: attribution exists with NO completion artifact - the hung
    // primitive never wrote its result.
    assert(!existsSync(outFile), 'the hung primitive must have written no result artifact, or this test proves nothing about in-flight attribution');

    // THE POST-MORTEM FLOW: the record alone is enough to find and reap the
    // browser the dead job left behind.
    killTree(record.pid);
    child.kill('SIGKILL');
    await childGone;
    // A SIGKILLed pid can answer kill(pid, 0) until it is reaped, so wait
    // (bounded) for it to actually vanish rather than racing the zombie.
    let reaped = false;
    for (let i = 0; i < 40 && !reaped; i++) {
      try { process.kill(record.pid, 0); } catch { reaped = true; }
      if (!reaped) await new Promise((r) => setTimeout(r, 250));
    }
    assert(reaped, `the browser named by the marker (${record.pid}) must be reaped via the marker's pid`);
    rmSync(record.profileDir, { recursive: true, force: true });
    browserPid = null; // reaped and verified above; the finally must not kill again.
    // browserProfile STAYS SET: the group kill does not reach the crashpad
    // handler (it double-forks out of the group - the reaper took one such
    // remnant from a GREEN run of this test at 10 min), so the finally's
    // profile-path sweep must run on the success path too. The repeated rmSync
    // is idempotent (force: true).
  } finally {
    child.kill('SIGKILL');
    if (!browserPid) browserPid = findLaunchedChrome();
    // Resolve the profile BEFORE killing: a dead browser's cmdline is gone.
    if (!browserProfile && browserPid) {
      try {
        const cmdline = readFileSync(`/proc/${browserPid}/cmdline`, 'utf8');
        const m = /(\/tmp\/web-uplift-cdp-[^\0\s]+)/.exec(cmdline);
        if (m) browserProfile = m[1];
      } catch { /* already reaped */ }
    }
    if (browserPid) killTree(browserPid);
    // chrome's crashpad handler is NOT in the browser's process group (it
    // double-forks), so the group kill leaves it behind and the reaper takes
    // it at 10 min - observed 2026-10-06. Sweep by the unique profile path,
    // which only this launch's processes carry. (Never pkill -f from a shell:
    // the pattern appears in the shell's own cmdline.)
    if (browserProfile) {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(browserProfile)) {
            try { process.kill(Number(entry), 'SIGKILL'); } catch { /* gone */ }
          }
        } catch { /* process vanished mid-scan */ }
      }
      rmSync(browserProfile, { recursive: true, force: true });
    }
    hung.close();
    rmSync(runTmp, { recursive: true, force: true });
  }
}


// Operator-path launch attribution (web-uplift-6x7): the flow record/replay
// subcommands launch chrome too, and a failed launch attempt used to record
// nothing at all. Both now write the same launches.jsonl marker.
export async function testOperatorLaunchAttribution() {
  const runTmp = mkdtempSync(join(tmpdir(), 'web-uplift-flow-launch-'));
  const launchesFile = join(runTmp, 'launches.jsonl');
  try {
    // 1. THE OPERATOR PATH: `flow replay` launches chrome through the same
    //    recordLaunch the agent-run primitives use. A zero-step flow keeps
    //    this cheap: launch, attribute, close (the child's own finally).
    const flowPath = join(runTmp, 'flow.json');
    writeFileSync(flowPath, JSON.stringify({ title: 'empty', steps: [] }));
    const replay = await runAsync(
      process.execPath,
      [join(repoRoot, 'runner/flow.mjs'), 'replay', flowPath, '--url', 'https://example.com', '--out', join(runTmp, 'evidence')],
      { env: { ...process.env, WEB_UPLIFT_LAUNCH_LOG: launchesFile } },
    );
    assert(replay.status === 0, `flow replay must succeed: ${replay.stderr}`);
    assert(existsSync(launchesFile), `flow replay must write a launch marker to WEB_UPLIFT_LAUNCH_LOG; none exists (replay stderr: ${replay.stderr.slice(-300)})`);
    const lines = readFileSync(launchesFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const replayMark = lines.find((l) => l.primitive === 'flow-replay');
    assert(replayMark, `flow replay must be attributed in launches.jsonl: ${lines.map((l) => JSON.stringify(l)).join(' | ')}`);
    assert(
      replayMark.outcome === 'launched' && Number.isInteger(replayMark.pid) && replayMark.profileDir.includes('web-uplift-cdp-'),
      `the operator marker must look like every other launch marker: ${JSON.stringify(replayMark)}`,
    );

    // 2. THE FAILED LAUNCH: an attempt that dies before the DevTools endpoint
    //    records what it knew - pid, profile, reason - with outcome 'failed'.
    //    A 50ms devtools budget forces the failure against real chrome (real
    //    boots take hundreds of ms); the attempt's own close() reaps the tree,
    //    so nothing here leaks.
    process.env.WEB_UPLIFT_LAUNCH_LOG = launchesFile;
    let launchErr = null;
    try {
      // devtoolsTimeoutMs IS the pipe deadline too (waitForPipeReady receives it), so a 50ms budget fails
      // on both transports - an earlier version of this comment said otherwise and was wrong. The port
      // transport is still the right one here, because the assertion below reads the reason this
      // transport words as "timed out waiting for the DevTools endpoint", which is a port diagnostic
      // (web-uplift-ik04).
      await launchChrome({ log: () => {}, devtoolsTimeoutMs: 50, transport: 'port' });
    } catch (e) {
      launchErr = e;
    } finally {
      delete process.env.WEB_UPLIFT_LAUNCH_LOG;
    }
    assert(launchErr, 'a 50ms devtools budget must fail the launch');
    const failedMarks = readFileSync(launchesFile, 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((l) => l.outcome === 'failed');
    assert(failedMarks.length > 0, 'a failed launch attempt must be recorded in launches.jsonl');
    const fm = failedMarks[failedMarks.length - 1];
    assert(Number.isInteger(fm.pid) && fm.pid > 0, `the failed attempt must record the pid it created: ${JSON.stringify(fm)}`);
    assert(
      typeof fm.reason === 'string' && fm.reason.includes('timed out'),
      `the failed attempt must record why it died: ${JSON.stringify(fm)}`,
    );
  } finally {
    delete process.env.WEB_UPLIFT_LAUNCH_LOG;
    rmSync(runTmp, { recursive: true, force: true });
  }
}


// The Chrome bootstrap was flaky in CI: a bare CDP({ port }) relied on a
// default page target that Chrome for Testing 154 sometimes does not provide.
// Keep a cheap (3-iteration) launch+newSession loop in the suite so a
// regression fails fast instead of surfacing as a random mid-suite death.
export async function testLaunchSessionLoop() {
  const result = await runAsync(process.execPath, [join(repoRoot, 'tests', 'launch-loop.mjs'), '3']);
  assert(result.status === 0, `launch-session loop failed:
${result.stderr || result.stdout}`);
}


// Deterministic teardown guard (web-uplift-knz): every browser the harness
// launches must be fully gone (process tree AND profile dir) after close().
// The launcher used to leave a wedged browser group and one /tmp/web-uplift-cdp-*
// husk per boot, which the (now stopped) VM reaper had to clean up. Kept cheap:
// one browser in the suite; the standalone default is three.
export async function testNoOrphanBrowser() {
  const result = await runAsync(process.execPath, [join(repoRoot, 'tests', 'no-orphan-browser.mjs'), '1']);
  assert(result.status === 0, `no-orphan-browser failed:
${result.stderr || result.stdout}`);
}


// web-uplift-pv1: evidence-out is a committed provenance record of real runs, so
// its scratch probes are copy-pasteable samples. The contact-lead submit probe
// shipped with a live POST to the page's own form action and real-looking sample
// data. It has to keep its path (write-scope.json:49 references it), so it is
// neutralised in place rather than deleted, and this guard keeps it that way: the
// request stays commented out and the payload stays a placeholder.
export function testCommittedProbeIsInert() {
  const file = join(repoRoot, 'evidence-out', 'web-uplift-cpa', 'model-led', 'contact-lead', 'scratch', 'submit-render.js');
  assert(existsSync(file), `the neutralised probe must keep the path write-scope.json references: ${file}`);
  const text = readFileSync(file, 'utf8');
  // Executable lines only: the record of the original request is a comment, and a
  // comment cannot POST anything.
  const live = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  assert(!/\bfetch\s*\(/.test(live), `the live POST must stay disabled (uncommented fetch):\n${live}`);
  assert(!/requestSubmit\s*\(/.test(live), `the probe must not submit the form:\n${live}`);
  for (const pii of ['Jo Bloggs', 'jo@example.com']) {
    assert(!text.includes(pii), `sample personal data must be a placeholder, found ${JSON.stringify(pii)}`);
  }
  assert(text.includes('user@example.invalid'), 'the sample email must be an RFC 2606 placeholder');
}


export function testCommittedSiblingProbesAreInert() {
  const scratch = join(repoRoot, 'evidence-out', 'web-uplift-cpa', 'model-led', 'contact-lead', 'scratch');
  for (const name of ['submit.js', 'flow-probe.js']) {
    assert(existsSync(join(scratch, name)), `the neutralised probe must keep the path write-scope.json references: ${name}`);
  }
  assertProbeFileInert(join(scratch, 'submit.js'), { forbid: [/\brequestSubmit\s*\(/, /\bfetch\s*\(/] });
  assertProbeFileInert(join(scratch, 'flow-probe.js'), { forbid: [/method:\s*'POST'/] });
  // Negative control: a live probe shape (uncommented requestSubmit plus the
  // original sample data, no placeholder) must trip the checks.
  const fixture = join(tmp, 'live-probe-shape.js');
  writeFileSync(
    fixture,
    "(() => {\n  document.getElementById('email').value = 'jo@example.com';\n  document.getElementById('enquiry-form').requestSubmit();\n})()\n",
  );
  let fired = false;
  try {
    assertProbeFileInert(fixture, { forbid: [/\brequestSubmit\s*\(/] });
  } catch {
    fired = true;
  }
  assert(fired, 'negative control: the inertness checks must fire on a live probe shape');
}


export const chromeCdpTests = [
  testCdpEndpointExposure,
  testEndpointProbesRunConcurrently,
  testEndpointProbeRejectionStaysFailClosed,
  testCdpPipeTransport,
  testSilentPipeReadinessIsBounded,
  testClosedPipeRejectsPendingSends,
  testPipeReadinessThenExitFailsTheLaunch,
  testChromeCandidateDiscovery,
  testLaunchRetryAndDiagnostics,
  testChromeSandboxPolicy,
  testCdpDeadline,
  testLaunchAttributionForHungPrimitive,
  testOperatorLaunchAttribution,
  testLaunchSessionLoop,
  testNoOrphanBrowser,
  testCommittedProbeIsInert,
  testCommittedSiblingProbesAreInert,
];

export {
  testCdpEndpointExposure,
  testEndpointProbesRunConcurrently,
  testEndpointProbeRejectionStaysFailClosed,
  testCdpPipeTransport,
  testSilentPipeReadinessIsBounded,
  testClosedPipeRejectsPendingSends,
  testPipeReadinessThenExitFailsTheLaunch,
};

await runSuite(chromeCdpTests, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
