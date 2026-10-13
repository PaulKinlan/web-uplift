#!/usr/bin/env node
// Response headers: the cases whose subject is the security headers a site sends, read case
// insensitively and under a slow response.
//
// SPLIT FROM tests/evidence.test.mjs / tests/evidence-network.test.mjs (web-uplift-f5mb). The gate runs
// each tests/*.test.mjs in its own node:test process and is bounded by the files on its critical path, so
// the heaviest cases in those two files throttled every landing. The cases moved here unchanged: none was
// dropped, relaxed or reordered, and each remains independent (it builds its own server and browser).
// tests/regression.mjs discovers this file automatically, and testSuiteListsMatchRegressionRegistry pins
// that the union of the suite lists is unchanged.

import http from 'node:http';
import { resolve } from 'node:path';
import { assert, runSuite } from './test-helpers.mjs';
import { gather } from '../evidence/cli.mjs';

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

export const evidenceNetworkHeadersTests = [
  testHeadersPrimitiveFindsHeadersRegardlessOfNameCase,
  testHeadersPrimitiveSurvivesSlowResponseUnderLoad,
];

await runSuite(evidenceNetworkHeadersTests, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
