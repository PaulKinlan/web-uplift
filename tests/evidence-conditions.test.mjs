#!/usr/bin/env node
// Emulated conditions: the cases whose subject is what the page reports when it is rendered under a
// chosen media preference, network/CPU throttle, locale or time zone, and the refusal of bad ones.
//
// SPLIT FROM tests/evidence.test.mjs / tests/evidence-network.test.mjs (web-uplift-f5mb). The gate runs
// each tests/*.test.mjs in its own node:test process and is bounded by the files on its critical path, so
// the heaviest cases in those two files throttled every landing. The cases moved here unchanged: none was
// dropped, relaxed or reordered, and each remains independent (it builds its own server and browser).
// tests/regression.mjs discovers this file automatically, and testSuiteListsMatchRegressionRegistry pins
// that the union of the suite lists is unchanged.

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assert, run, tmp, runSuite } from './test-helpers.mjs';
import { gather } from '../evidence/cli.mjs';
import { launchChrome } from '../evidence/cdp.mjs';

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
  // Question-first (web-uplift-qsqp): does this case depend on a fresh browser PROFILE, and does per-call
  // session/target isolation already cover the emulation it relies on? No and yes - it drives one constant
  // local page on one origin with no cookies, storage, service workers or JS-disabled emulation, and each
  // gather still creates its own session/target, which is where CDP's network/CPU/device-metrics emulation
  // lives (applyConditions runs per gather). The case's own assertions are the functional check that the
  // sharing is clean: a run with no device-metrics override must report no viewport, an unthrottled run must
  // carry no conditions block at all, and the slow-3g probe must really be ~2000ms slower than the plain one.
  let browser = null;
  try {
    browser = await launchChrome({ log: () => {} });
    const base = `http://127.0.0.1:${server.address().port}/`;

    // The conditions a run was measured under are recorded in the output.
    const shaped = await gather('layout', base, {
      quiet: true,
      browser,
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
      browser,
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
    const noViewport = await gather('layout', base, { quiet: true, wait: 100, browser });
    assert(
      !noViewport.conditions || noViewport.conditions.viewport === undefined,
      `conditions: a run with no device-metrics override must not report an emulated profile: ${JSON.stringify(noViewport.conditions)}`,
    );

    // mobile-lighthouse applies its 4x CPU slowdown without a separate flag.
    const mobile = await gather('layout', base, { quiet: true, wait: 100, network: 'mobile-lighthouse', browser });
    assert(mobile.conditions.cpuThrottleRate === 4 && mobile.conditions.network.latencyMs === 150,
      `throttle: mobile-lighthouse must imply 4x CPU + 150ms RTT: ${JSON.stringify(mobile.conditions)}`);

    // The shaping must be REAL, not just recorded: a slow-3g RTT of 2000ms
    // shows up in a fetch the page makes (warm up the socket first so cold-start
    // socket setup on a loaded VM does not inflate plain latency).
    const probe = { quiet: true, wait: 100, expr: '(async()=>{await fetch("/p"); const t=performance.now(); await fetch("/p"); return performance.now()-t;})()' };
    const plain = await gather('evaluate', base, { ...probe, browser });
    const throttled = await gather('evaluate', base, { ...probe, network: 'slow-3g', browser });
    assert(throttled > plain + 1000,
      `throttle: slow-3g should add ~2000ms RTT, got plain=${Math.round(plain)}ms shaped=${Math.round(throttled)}ms`);

    // An unthrottled run carries no conditions block at all (not an empty one).
    const unthrottled = await gather('layout', base, { quiet: true, wait: 100, browser });
    assert(!('conditions' in unthrottled),
      `throttle: an unthrottled run must not claim conditions: ${JSON.stringify(unthrottled.conditions)}`);

    // Unknown profiles fail loudly, never silently fall back to unshaped.
    let rejected = false;
    try {
      // The rejected call also gets the shared browser: gather launches BEFORE the primitive validates the
      // profile, so an unconverted call here pays a whole Chrome start only to throw (web-uplift-qsqp).
      await gather('layout', base, { quiet: true, wait: 100, network: 'dial-up', browser });
    } catch (err) {
      rejected = /Unknown network profile/.test(err.message);
    }
    assert(rejected, 'throttle: an unknown profile must be rejected by name');
  } finally {
    if (browser) await browser.close();
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




// A gather() call whose options can never be accepted must be refused before anything is launched: the
// assertion is the launch LOG, not a stopwatch, so it means the same thing on a loaded VM as on an idle
// one (web-uplift-3mrg). The comment that used to sit here described the headers primitive, which moved
// to tests/evidence-network-headers.test.mjs in web-uplift-bop3 and left its comment behind.

export async function testRejectedConditionsNeverLaunchABrowser() {
  // web-uplift-3mrg: gather launched Chrome BEFORE the primitive validated its options, so a call that was
  // always going to be rejected paid a browser start and threw it away (measured 0.6-1.4s inside the gate on
  // this VM, and the reason testThrottlingConditions looked like an 8-launch case). The evidence here is the
  // launch LOG, not a timing, so it means the same thing on a loaded VM as on an idle one.
  //
  // The valid call comes first and is asserted: "no records" must not be able to pass because the log was
  // never written at all. That is the vacuous-green shape this family keeps finding, so the detector is
  // proven before the thing it detects is asserted to be absent.
  const html = '<!doctype html><html><head><title>t</title></head><body><h1>x</h1></body></html>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const logPath = join(tmp, `rejected-conditions-launches-${process.pid}.jsonl`);
  const previous = process.env.WEB_UPLIFT_LAUNCH_LOG;
  process.env.WEB_UPLIFT_LAUNCH_LOG = logPath;
  const launches = () =>
    existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim()).length : 0;
  try {
    const base = `http://127.0.0.1:${server.address().port}/`;
    // Positive control: the detector works, and a valid run really does launch.
    await gather('layout', base, { quiet: true, wait: 100 });
    assert(
      launches() === 1,
      `the launch log must record the valid run's single launch, otherwise this case cannot tell "no launch" from "no log" (saw ${launches()})`,
    );

    // Each of these is a pure, declarative rejection: it must keep the exact message the in-session check
    // produced, and it must not have launched anything to produce it.
    const rejections = [
      [{ network: 'dial-up' }, 'Unknown network profile "dial-up". One of: '],
      [{ cpuThrottle: 0.5 }, '--cpu-throttle must be >= 1, got 0.5'],
      [{ locale: 'not a language tag' }, 'Invalid --locale "not a language tag"'],
      [{ timezone: 'Mars/Olympus_Mons' }, 'Invalid --timezone "Mars/Olympus_Mons"'],
    ];
    for (const [opts, expected] of rejections) {
      let message = null;
      try {
        await gather('layout', base, { quiet: true, ...opts });
      } catch (err) {
        message = err.message;
      }
      assert(message !== null, `${JSON.stringify(opts)} must be rejected rather than silently ignored`);
      assert(
        message.startsWith(expected),
        `${JSON.stringify(opts)}: the pre-launch check must keep the in-session message, expected one starting "${expected}", got "${message}"`,
      );
      assert(
        launches() === 1,
        `${JSON.stringify(opts)}: a rejected run must not launch a browser, but the launch log grew to ${launches()} record(s)`,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.WEB_UPLIFT_LAUNCH_LOG;
    else process.env.WEB_UPLIFT_LAUNCH_LOG = previous;
    server.close();
  }
}

export const evidenceConditionsTests = [
  testPreNavigationEmulation,
  testThrottlingConditions,
  testLocaleTimezoneConditions,
  testRejectedConditionsNeverLaunchABrowser,
];

await runSuite(evidenceConditionsTests, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
