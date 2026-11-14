#!/usr/bin/env node
// web-uplift-f9jg: the audited page's network reach is bounded by RESOLVED ADDRESS at the
// NETWORK layer. fs20/x1ru restricted navigation; this pins the other half - every request the
// renderer makes (fetch/XHR, images, redirects, service workers) is intercepted through the CDP
// Fetch domain, resolved with the SAME page-derived fetch policy the harness's own fetches use
// (evidence/fetch.mjs), and refused before it leaves the machine when it points at loopback,
// private-range or metadata addresses. Refusals are recorded in the run provenance.
//
// The audited target's own origin is the only exemption (the operator's explicit choice, the
// same semantics as fetch.mjs), which is the legitimate local-testing case: auditing your own
// http://127.0.0.1:PORT app still works; the PAGE fetching a different loopback host/port does
// not. There is deliberately NO per-run override flag.

import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const CLI_PATH = fileURLToPath(new URL('../evidence/cli.mjs', import.meta.url));

// One private listener per case: the page must NOT reach it. Its hit counter is the ground
// truth - the guard refusing the request is proven by the listener staying silent.
function makePrivateListener(label) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      server.hits += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${label}-was-reached`);
    });
    server.hits = 0;
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runCliAsync(args, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cp.kill('SIGKILL');
      reject(new Error(`cli execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    cp.stdout.on('data', (c) => { stdout += c; });
    cp.stderr.on('data', (c) => { stderr += c; });
    cp.on('error', (err) => { clearTimeout(timer); reject(err); });
    cp.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

// The AUDITED page lives on its own loopback listener (the target-origin exemption case), and
// each test gives it a job pointing at a DIFFERENT loopback listener, a resolving-private name,
// a redirect, or a service worker.
function serveOnce(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const PAGE = (job) => `<!doctype html><html><body><script>${job}</script></body></html>`;

async function expectRefused(job, label, privateServer, expectGuardRecord = true) {
  const audited = await serveOnce((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE(job));
  });
  try {
    const auditedOrigin = `http://127.0.0.1:${audited.address().port}`;
    const res = await runCliAsync(['dom', auditedOrigin, '--allow-scheme', 'http', '--quiet']);
    assert(privateServer.hits === 0, `${label}: the private listener must stay silent (hits: ${privateServer.hits})`);
    if (expectGuardRecord) {
      assert(
        res.stdout.includes('network-refusal') || res.stderr.includes('network-guard'),
        `${label}: the refusal must be recorded in the run output: ${res.stdout.slice(-400)} ${res.stderr.slice(-300)}`,
      );
    }
  } finally {
    audited.close();
  }
}

// 1. The page fetches http://127.0.0.1 (a DIFFERENT loopback service - not the exempt origin).
export async function testPageFetchLoopbackRefused() {
  const spy = await makePrivateListener('loopback');
  try {
    await expectRefused(
      `fetch('http://127.0.0.1:${spy.address().port}/probe').catch(() => {})`,
      'page fetch to a different loopback port',
      spy,
    );
    assert(spy.hits === 0, 'loopback spy must have zero hits');
  } finally {
    spy.close();
  }
}

// 2. A public-looking NAME that resolves to a private address ('localhost' always resolves
// loopback on this host): the policy resolves names, not just literals.
export async function testNameResolvingPrivateRefused() {
  const spy = await makePrivateListener('localhost');
  try {
    await expectRefused(
      `fetch('http://localhost:${spy.address().port}/probe').catch(() => {})`,
      'public name resolving to a private address',
      spy,
    );
    assert(spy.hits === 0, 'localhost spy must have zero hits');
  } finally {
    spy.close();
  }
}

// 3. A redirect to a private address: each hop is re-intercepted.
export async function testRedirectToPrivateRefused() {
  const spy = await makePrivateListener('redirect');
  const audited = await serveOnce((req, res) => {
    if (req.url === '/hop') {
      res.writeHead(302, { location: `http://127.0.0.1:${spy.address().port}/probe` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE(`fetch('/hop').catch(() => {})`));
  });
  try {
    const res = await runCliAsync(['dom', `http://127.0.0.1:${audited.address().port}`, '--allow-scheme', 'http', '--quiet']);
    assert(spy.hits === 0, `the redirect target must stay silent (hits: ${spy.hits})`);
    assert(
      res.stdout.includes('network-refusal') || res.stderr.includes('network-guard'),
      `the redirect refusal must be recorded: ${res.stdout.slice(-400)} ${res.stderr.slice(-300)}`,
    );
  } finally {
    audited.close();
    spy.close();
  }
}

// 4. A service worker's fetch: registration is refused in the audited page (a worker's requests
// do not traverse the page session's Fetch interception, so the guard refuses REGISTRATION - with
// a fresh profile no worker can exist to make an unguarded request).
export async function testServiceWorkerRequestBlocked() {
  const spy = await makePrivateListener('sw');
  const job = `
    navigator.serviceWorker.register('/sw.js').then(() => { document.title = 'sw-registered'; }).catch(() => {});
    fetch('http://127.0.0.1:${spy.address().port}/probe').catch(() => {});
  `;
  const audited = await serveOnce((req, res) => {
    if (req.url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(`self.addEventListener('fetch', (e) => e.respondWith(fetch('http://127.0.0.1:${spy.address().port}/sw-probe')));`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE(job));
  });
  try {
    const res = await runCliAsync(['dom', `http://127.0.0.1:${audited.address().port}`, '--allow-scheme', 'http', '--quiet']);
    assert(spy.hits === 0, `the service worker's target must stay silent (hits: ${spy.hits})`);
    assert(
      res.stdout.includes('network-refusal') || res.stderr.includes('network-guard'),
      `the refusal record must exist: ${res.stdout.slice(-400)} ${res.stderr.slice(-300)}`,
    );
  } finally {
    audited.close();
    spy.close();
  }
}

// 5. THE CONTROL: an asset on the AUDITED origin itself loads - the operator's explicit choice
// is the only exemption, and it must not break ordinary audits.
export async function testAuditedOriginAssetLoads() {
  const audited = await serveOnce((req, res) => {
    if (req.url === '/asset.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('same-origin-asset-ok');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE(`
      window.__asset = 'pending';
      fetch('/asset.txt').then((r) => r.text()).then((t) => { window.__asset = t; }).catch(() => { window.__asset = 'failed'; });
    `));
  });
  try {
    const res = await runCliAsync([
      'evaluate', `http://127.0.0.1:${audited.address().port}`, '--allow-scheme', 'http',
      '--expr', 'window.__asset', '--quiet',
    ]);
    assert(res.status === 0, `the evaluate primitive must succeed: ${res.status} ${res.stderr.slice(-300)}`);
    const data = JSON.parse(res.stdout);
    // The evaluate result shape: { result: { value, type, ... } } - dig defensively, the shape is
    // the primitive's contract, not this test's business.
    // evaluate returns the model's own result at the top level (a bare string here).
    const value = typeof data === 'string' ? data : data?.result?.value ?? data?.result ?? data?.value;
    assert(String(value).includes('same-origin-asset-ok'), `the same-origin asset must LOAD (got ${JSON.stringify(value ?? null).slice(0, 200)}): ${res.stdout.slice(-400)}`);
    assert(!res.stdout.includes('network-refusal'), 'the same-origin fetch must not be refused');
  } finally {
    audited.close();
  }
}

const cases = [
  testPageFetchLoopbackRefused,
  testNameResolvingPrivateRefused,
  testRedirectToPrivateRefused,
  testServiceWorkerRequestBlocked,
  testAuditedOriginAssetLoads,
];

let failed = 0;
for (const testCase of cases) {
  try {
    await testCase();
    console.log(`\u2714 ${testCase.name}`);
  } catch (err) {
    failed += 1;
    console.error(`\u2716 ${testCase.name}`);
    console.error(String(err.message || err).slice(0, 600));
  }
}
if (failed) {
  console.error(`${failed} case(s) failed`);
  process.exit(1);
}
console.log('all audited-page network guard cases passed');
