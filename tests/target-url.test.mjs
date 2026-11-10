#!/usr/bin/env node
// Target-URL scheme gate (web-uplift-fs20): the audited target reached Chrome with
// NO scheme check, while flow replay refused non-web schemes since web-uplift-w0zq.
// The gate now lives in gather() (evidence/cli.mjs) - the one place a target URL
// becomes a navigation - with an explicit per-scheme --allow-scheme opt-in that is
// recorded on the result, and the SAME allow-list guards the MCP web-audit prompt
// (mcp/skills-server.mjs), because the MCP surface is exactly how a caller-supplied
// file:/javascript:/data: URL reached the browser (web-uplift-8m4y).
//
// What each case owns:
//   - testTargetUrlSchemeGatePredicate: the pure matrix (what is allowed, what is
//     refused, and that every refusal names why and the opt-in).
//   - testTargetUrlOptInParsingAndRecording: --allow-scheme parsing/normalisation
//     and the targetUrlPolicy record.
//   - testTargetUrlGateRefusesBeforeAnyBrowserLaunch: the launch-LOG evidence that
//     refusals cost no browser (the web-uplift-3mrg pattern, web-uplift-f5mb
//     measurement), with a positive control that proves the detector works and that
//     a normal http URL still audits, plus one deliberate opt-in file:// audit.
//   - testTargetUrlCliRefusalExitsBeforeAnyBrowser: the CLI subprocess refusals -
//     these exit before any browser, so a child run is safe (the tests/test-helpers
//     convention, web-uplift-17o).
//   - testTargetUrlMcpChainLandsOnTheGatedCli: the REAL skills server over stdio.
//     The MCP surface has exactly ONE route to Chrome - the CLI invocation the
//     rendered instructions name - so the gate at gather() covers that path too;
//     this case pins the chain rather than a second, drifting check at the surface
//     (the surface-side argument constraint is web-uplift-8m4y, a different owner).

import http from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assert, tmp, runSuite, runAsync } from './test-helpers.mjs';
import { gather } from '../evidence/cli.mjs';
import { launchChrome } from '../evidence/cdp.mjs';
import {
  TARGET_URL_SCHEMES,
  assertTargetUrlAllowed,
  normalizeScheme,
  parseSchemeOptIn,
  recordTargetUrlPolicy,
} from '../evidence/target-url.mjs';

export async function testTargetUrlSchemeGatePredicate() {
  // The allow-list itself is exactly http and https.
  assert.deepEqual([...TARGET_URL_SCHEMES].sort(), ['http:', 'https:'], 'the default allow-list must be exactly http: and https:');

  // What the gate is FOR: ordinary web targets pass, scheme and case notwithstanding.
  for (const good of [
    'https://example.com/',
    'http://example.test/x',
    'HTTPS://EXAMPLE.test/Page',
    'http://[::1]:8080/',
    'https://example.com:8443/p?query=1#frag',
  ]) {
    const verdict = assertTargetUrlAllowed(good);
    assert(verdict.url.href === new URL(good).href, `${good} must parse unchanged (${verdict.url.href})`);
    assert(verdict.policy.scheme === new URL(good).protocol, `${good} must record its own scheme`);
  }

  // What a caller-supplied hostile or mistaken target looks like. Every refusal must
  // say WHY (the scheme), HOW to opt in (--allow-scheme), and carry the bead id, so
  // an agent reading the error can act on it without this test suite open.
  for (const bad of [
    'file:///etc/passwd',
    'file:///tmp/fixture.html',
    'javascript:alert(1)',
    'data:text/html,<h1>injected</h1>',
    'blob:https://example.test/8f1',
    'chrome://settings',
    'view-source:https://example.test/',
    'about:blank',
    'ftp://example.test/x',
  ]) {
    let message = null;
    try {
      assertTargetUrlAllowed(bad);
    } catch (err) {
      message = err.message;
    }
    assert(message !== null, `${bad} must be refused, not silently audited`);
    assert(message.startsWith('refused:'), `${bad} refusal must start "refused:": ${message}`);
    assert(message.includes('web-uplift-fs20'), `${bad} refusal must carry the bead id: ${message}`);
    assert(message.includes('--allow-scheme'), `${bad} refusal must name the opt-in flag: ${message}`);
  }
  // The scheme names appear in their own refusals (the actionable part).
  for (const [bad, scheme] of [
    ['file:///etc/passwd', 'file:'],
    ['javascript:alert(1)', 'javascript:'],
    ['data:text/html,<h1>x</h1>', 'data:'],
    ['chrome://settings', 'chrome:'],
    ['about:blank', 'about:'],
  ]) {
    let message = null;
    try {
      assertTargetUrlAllowed(bad);
    } catch (err) {
      message = err.message;
    }
    assert(message.includes(scheme), `${bad}: the refusal must name the scheme ${scheme}: ${message}`);
  }

  // A scheme-less value is the common operator mistake; the refusal must give the fix.
  for (const noScheme of ['example.com', '', '  ', '/local/path', 12, {}, undefined, null]) {
    let message = null;
    try {
      assertTargetUrlAllowed(noScheme);
    } catch (err) {
      message = err.message;
    }
    assert(message !== null, `${JSON.stringify(noScheme)} must be refused`);
    assert(
      message.includes('no URL scheme'),
      `${JSON.stringify(noScheme)}: the refusal must say the value has no scheme: ${message}`,
    );
  }
  let m = null;
  try {
    assertTargetUrlAllowed('example.com');
  } catch (err) {
    m = err.message;
  }
  assert(m.includes('https://example.com'), `the scheme-less refusal must show the corrected form: ${m}`);

  // A scheme that does not parse at all is a different refusal from a scheme-less one.
  m = null;
  try {
    assertTargetUrlAllowed('http://');
  } catch (err) {
    m = err.message;
  }
  assert(m !== null && m.includes('not a valid URL'), `http:// must be refused as invalid, got: ${m}`);

  // The opt-in is per scheme: granting file: must not widen anything else.
  const opted = assertTargetUrlAllowed('file:///etc/hosts', { optInSchemes: ['file'] });
  assert(opted.scheme === 'file:', 'an opted-in file: target must pass');
  let refused = null;
  try {
    assertTargetUrlAllowed('chrome://settings', { optInSchemes: ['file'] });
  } catch (err) {
    refused = err.message;
  }
  assert(refused !== null, 'opting into file: must not grant chrome://');
}

export async function testTargetUrlPolicyRecordRedactsCredentials() {
  // web-uplift-alwp: the policy RECORD is an output (stdout JSON + every artifact that carries it), so a
  // credential-bearing target must reach it redacted. The NAVIGATION keeps the real URL (a session'd page is
  // the page being audited) - only the recorded provenance is made safe to share.
  const userinfo = assertTargetUrlAllowed('https://user:pass@example.test/');
  assert(
    !userinfo.policy.url.includes('pass') && userinfo.policy.url.includes('%5Bredacted%5D'),
    `userinfo credentials must be redacted in the policy record: ${userinfo.policy.url}`,
  );
  assert.equal(userinfo.url.href, 'https://user:pass@example.test/', 'the NAVIGATION url must stay the real target');

  const session = assertTargetUrlAllowed('https://example.test/?session=review_dummy');
  assert(
    !session.policy.url.includes('review_dummy') && session.policy.url.includes('session=%5Bredacted%5D'),
    `a credential-named query value must be redacted in the policy record: ${session.policy.url}`,
  );

  // Over-redaction is a defect too: a query parameter that is not a credential name stays readable.
  const benign = assertTargetUrlAllowed('https://example.test/?q=1&lang=de');
  assert.equal(benign.policy.url, 'https://example.test/?q=1&lang=de', 'a benign query must survive into the policy record');

  // The refusal MESSAGE is an output too (stderr, run logs). The scheme refusal names the SCHEME, not the
  // URL, so a token-bearing target is not echoed there; the parseable-URL refusal paths (no-scheme,
  // invalid-URL) run the same redactor, so a token-bearing URL that reaches them is redacted.
  let m = null;
  try {
    assertTargetUrlAllowed('file:///etc/creds?token=supersecret');
  } catch (err) {
    m = err.message;
  }
  assert(m !== null && m.startsWith('refused:'), 'the token-bearing refusal must still refuse');
  assert(!m.includes('supersecret'), `the refusal must not echo the token value: ${m}`);
  assert(m.includes('file:'), 'the refusal must still name the scheme');

  m = null;
  try {
    assertTargetUrlAllowed('https://example.test:bad-port/?token=supersecret');
  } catch (err) {
    m = err.message;
  }
  assert(m !== null && m.includes('not a valid URL'), `the invalid-URL refusal path must fire: ${m}`);
  assert(!m.includes('supersecret'), `the invalid-URL refusal must not echo the token: ${m}`);
  assert(m.includes('%5Bredacted%5D'), 'the invalid-URL refusal must carry the redacted placeholder');
}

export async function testTargetUrlOptInParsingAndRecording() {
  // Parsing: absent means no opt-in, not an error.
  assert.deepEqual(parseSchemeOptIn(undefined), [], 'an absent opt-in must parse to an empty list');
  assert.deepEqual(parseSchemeOptIn(null), [], 'a null opt-in must parse to an empty list');
  // One scheme, with or without the colon, any case.
  assert.deepEqual(parseSchemeOptIn('file'), ['file:']);
  assert.deepEqual(parseSchemeOptIn('file:'), ['file:']);
  assert.deepEqual(parseSchemeOptIn('FILE'), ['file:']);
  assert.equal(normalizeScheme('Web+Vendor'), 'web+vendor:');
  // Lists, in both shapes the flag and the programmatic opts take.
  assert.deepEqual(parseSchemeOptIn('file,data'), ['file:', 'data:']);
  assert.deepEqual(parseSchemeOptIn(['blob', ' file:']), ['blob:', 'file:']);
  // Garbage is refused, never silently dropped (an opt-in that does not apply is an
  // audit that fails confusingly at navigation time).
  for (const garbage of ['not a scheme!', '', '1abc', 'file,,data', 'a b']) {
    let message = null;
    try {
      parseSchemeOptIn(garbage);
    } catch (err) {
      message = err.message;
    }
    assert(message !== null && message.startsWith('refused:'), `${JSON.stringify(garbage)} must be refused as a scheme: ${message}`);
  }

  // The record: an allowed target carries its own provenance.
  assert.deepEqual(assertTargetUrlAllowed('https://example.com/').policy, {
    allowed: ['http:', 'https:'],
    optIn: [],
    url: 'https://example.com/',
    scheme: 'https:',
  });
  assert.deepEqual(assertTargetUrlAllowed('FILE:///etc/hosts', { optInSchemes: ['file'] }).policy, {
    allowed: ['http:', 'https:'],
    optIn: ['file:'],
    url: 'file:///etc/hosts',
    scheme: 'file:',
  });

  // recordTargetUrlPolicy: plain objects carry the record, everything else is left
  // alone (evaluate can return a bare string/number) and the caller's log line is
  // the record there.
  const obj = { a: 1 };
  assert.equal(recordTargetUrlPolicy(obj, { scheme: 'https:' }), obj, 'must return the same result object');
  assert.deepEqual(obj.targetUrlPolicy, { scheme: 'https:' });
  assert.equal(recordTargetUrlPolicy('bare', { scheme: 'https:' }), 'bare');
  assert.equal(recordTargetUrlPolicy(null, { scheme: 'https:' }), null);
  const arr = [1];
  recordTargetUrlPolicy(arr, { scheme: 'https:' });
  assert.deepEqual(arr, [1], 'an array result must not gain a property');
}

export async function testTargetUrlGateRefusesBeforeAnyBrowserLaunch() {
  // The evidence here is the launch LOG, not a timing, so it means the same thing on
  // a loaded VM as on an idle one (the web-uplift-3mrg / evidence-conditions shape).
  // The positive control comes FIRST and is asserted: "no records" must not be able
  // to pass because the log was never written at all.
  const html = '<!doctype html><html><head><title>target-url ok</title></head><body><h1>x</h1></body></html>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const logPath = join(tmp, `target-url-launches-${process.pid}.jsonl`);
  const previous = process.env.WEB_UPLIFT_LAUNCH_LOG;
  process.env.WEB_UPLIFT_LAUNCH_LOG = logPath;
  const launches = () =>
    existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim()).length : 0;

  const fixturePath = join(tmp, `target-url-fixture-${process.pid}.html`);
  writeFileSync(fixturePath, '<!doctype html><html><head><title>fixture target gate</title></head><body><p>deliberate non-web target</p></body></html>');
  const fixtureUrl = pathToFileURL(fixturePath).href;

  let browser = null;
  try {
    browser = await launchChrome({ log: () => {} });
    const base = `http://127.0.0.1:${server.address().port}/`;

    // A normal http URL still audits, and the policy is recorded on the result.
    const ok = await gather('layout', base, { quiet: true, wait: 100, browser });
    assert(launches() === 1, `the launch log must record the valid run's single launch (saw ${launches()})`);
    assert.deepEqual(
      ok.targetUrlPolicy,
      { allowed: ['http:', 'https:'], optIn: [], url: base, scheme: 'http:' },
      `a normal audit must record its target policy: ${JSON.stringify(ok.targetUrlPolicy)}`,
    );

    // Every refusal below is a pure, declarative rejection: it must keep the gate's
    // message and must not have launched anything to produce it.
    const refusals = ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'example.com'];
    for (const bad of refusals) {
      let message = null;
      try {
        await gather('layout', bad, { quiet: true, browser });
      } catch (err) {
        message = err.message;
      }
      assert(message !== null, `${bad} must be refused rather than navigated`);
      assert(message.startsWith('refused:'), `${bad}: the gather gate must refuse with its own message: ${message}`);
      assert(
        launches() === 1,
        `${bad}: a refused run must not launch a browser, but the launch log grew to ${launches()} record(s)`,
      );
    }

    // The opt-in end to end: file: navigates only when --allow-scheme says so, the
    // policy records the opt-in, and the page really loaded (the evaluate expression
    // read the fixture's title back out of it).
    const opted = await gather('evaluate', fixtureUrl, {
      quiet: true,
      wait: 200,
      browser,
      expr: '({ title: document.title })',
      allowScheme: ['file'],
    });
    assert(launches() === 2, `the opted-in run must be recorded in the launch log (saw ${launches()})`);
    assert.equal(opted.title, 'fixture target gate', `the opted-in file:// audit must actually load the fixture: ${JSON.stringify(opted)}`);
    assert.deepEqual(opted.targetUrlPolicy.optIn, ['file:'], `the opt-in must be recorded on the result: ${JSON.stringify(opted.targetUrlPolicy)}`);
    assert.equal(opted.targetUrlPolicy.scheme, 'file:', 'the recorded scheme must be the opted-in one');
  } finally {
    if (previous === undefined) delete process.env.WEB_UPLIFT_LAUNCH_LOG;
    else process.env.WEB_UPLIFT_LAUNCH_LOG = previous;
    rmSync(fixturePath, { force: true });
    server.close();
    if (browser) await browser.close();
  }
}

export async function testTargetUrlCliRefusalExitsBeforeAnyBrowser() {
  // These exit before any browser is launched, so a child run is safe next to this
  // process (the tests/test-helpers.mjs convention, web-uplift-17o). Status 1 and a
  // clean stdout: nothing partial may read as a result artifact.
  const cases = [
    { url: 'file:///etc/passwd', expect: ['refused:', 'file:', '--allow-scheme file', 'web-uplift-fs20'] },
    { url: 'javascript:alert(1)', expect: ['refused:', 'javascript:'] },
    { url: 'data:text/html,<h1>x</h1>', expect: ['refused:', 'data:'] },
    { url: 'example.com', expect: ['refused:', 'no URL scheme', 'https://example.com'] },
  ];
  for (const { url, expect } of cases) {
    const r = await runAsync(process.execPath, ['evidence/cli.mjs', 'layout', url], { timeout: 30000 });
    assert.equal(r.status, 1, `${url}: the CLI must exit 1 on a refused target (status ${r.status}, stderr: ${r.stderr.slice(0, 200)})`);
    assert.equal(r.stdout, '', `${url}: a refused run must print no result JSON`);
    for (const part of expect) {
      assert(r.stderr.includes(part), `${url}: the refusal must say "${part}" (stderr: ${r.stderr.slice(0, 300)})`);
    }
  }

  // A typo'd opt-in is refused at the same boundary, before any browser.
  const bad = await runAsync(process.execPath, ['evidence/cli.mjs', 'layout', 'file:///etc/passwd', '--allow-scheme', 'not a scheme!'], { timeout: 30000 });
  assert.equal(bad.status, 1, 'a malformed --allow-scheme value must exit 1');
  assert(bad.stderr.includes('is not a URL scheme'), `the opt-in refusal must name the bad value: ${bad.stderr.slice(0, 300)}`);
}

// Drives the REAL server over stdio with the JSON-RPC handshake an MCP host
// performs (the shape of testMcpSkillsServerStdio), then checks what the calling
// agent would actually receive and where its target URL can go from there.
export async function testTargetUrlMcpChainLandsOnTheGatedCli() {
  const serverPath = new URL('../mcp/skills-server.mjs', import.meta.url);
  const child = spawn(process.execPath, [serverPath.pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolveReq, rejectReq) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rejectReq(new Error(`MCP ${method}: no response within 10s`));
        }
      }, 10000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveReq(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const promptText = async (url, flags) => {
    const got = await request('prompts/get', { name: 'web-audit', arguments: { url, ...(flags !== undefined ? { flags } : {}) } });
    return got.result?.messages?.[0]?.content?.text;
  };
  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'web-uplift-target-url-test', version: '0' },
    });
    assert(init.result?.serverInfo?.name === 'web-uplift', `initialize must name the server: ${JSON.stringify(init)}`);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    // THE CHAIN, pinned end to end: whatever url a caller supplies, the rendered
    // instructions name exactly the invocation forms that all funnel into
    // evidence/cli.mjs - whose gather() is the scheme gate. That single funnel is
    // why ONE allow-list covers both the CLI and MCP paths (web-uplift-fs20), and
    // why the two cannot drift apart the way flow replay and the audit target did.
    for (const url of ['https://example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const text = await promptText(url);
      assert(
        typeof text === 'string' && text.includes('node evidence/cli.mjs'),
        `the rendered instructions for ${url} must funnel into the gated CLI: ${JSON.stringify((text || '').slice(0, 160))}`,
      );
      assert(
        typeof text === 'string' && text.includes(url),
        `the rendered instructions must carry the url argument (${url}) as the CLI's target`,
      );
    }
    for (const form of ['.web-uplift/evidence/cli.mjs', 'web-uplift evidence']) {
      const text = await promptText('https://example.com');
      assert(typeof text === 'string' && text.includes(form), `the skill's ${form} form must survive rendering: ${JSON.stringify((text || '').slice(0, 120))}`);
    }

    assert(stderr.trim() === '', `the server must keep stderr clean through the handshake: ${stderr.slice(-300)}`);
  } finally {
    child.kill('SIGKILL');
  }
}

export const targetUrlTests = [
  testTargetUrlSchemeGatePredicate,
  testTargetUrlPolicyRecordRedactsCredentials,
  testTargetUrlOptInParsingAndRecording,
  testTargetUrlGateRefusesBeforeAnyBrowserLaunch,
  testTargetUrlCliRefusalExitsBeforeAnyBrowser,
  testTargetUrlMcpChainLandsOnTheGatedCli,
];

await runSuite(targetUrlTests, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
