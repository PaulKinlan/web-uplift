#!/usr/bin/env node
// conditions, console and axe: the cases whose subject is how the page under a given condition behaves.
//
// SPLIT FROM tests/evidence.test.mjs (web-uplift-bop3). The gate runs each tests/*.test.mjs in
// its own node:test process and is bounded by its slowest single file, so one 121s file
// throttled the whole gate. Cases moved here unchanged; no case was dropped, relaxed or
// reordered, and every case remains independent (it builds its own server and browser).

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, run, runAsync, tmp, runSuite } from './test-helpers.mjs';
import { gather, waitForInteractEvidence } from '../evidence/cli.mjs';
import { launchChrome } from '../evidence/cdp.mjs';
import { testConsoleEvidenceRedaction } from './console-evidence-redaction.mjs';
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
  // One browser for the six console loads this case drives (web-uplift-t2mr): the console collector is
  // attached per SESSION, so a fresh session/target per gather keeps console events isolated between them,
  // and no load here depends on a fresh profile - the pages come from this case's own server, whose content
  // differs per path. The "a page that logs nothing reports zeroes" assertion is the functional check that
  // nothing leaked from the noisy load into the clean ones.
  let browser = null;
  try {
    browser = await launchChrome({ log: () => {} });
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const result = await gather('console', `${base}/noisy`, { quiet: true, wait: 500, browser });
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
    const cleanResult = await gather('console', `${base}/clean`, { quiet: true, wait: 400, browser });
    assert(
      cleanResult.console.entryCount === 0 && cleanResult.console.hasErrors === false && cleanResult.console.entries.length === 0,
      `console: a page that logs nothing must report zeroes: ${JSON.stringify(cleanResult.console)}`,
    );

    // Interaction errors count too: the same page throws only when its button is
    // clicked, which is exactly the error class a post-load probe cannot see.
    const interactResult = await gather('console', `${base}/clean`, {
      quiet: true,
      browser,
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
      browser,
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
    const quietResult = await gather('console', `${base}/clean`, { quiet: true, wait: 400, interact: 'void 0', browser });
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
      browser,
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
    if (browser) await browser.close();
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

export const evidenceTests = [
  testPreNavigationEmulation,
  testAxePrimitiveBypassesStrictCsp,
  testAxeKeepsPagePolicyAndDisclosesInjectionBypass,
  testThrottlingConditions,
  testLocaleTimezoneConditions,
  testConsoleEvidence,
  testConsoleEvidenceRedaction,
  testConsoleInteractDeadlineValidation,
];

export {
  testConsoleEvidenceRedaction,
};

await runSuite(evidenceTests, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
