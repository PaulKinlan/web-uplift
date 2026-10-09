#!/usr/bin/env node
// The secrets primitive must not count a script it could not READ as coverage
// (web-uplift-6fe). The decision table that says what "read" means lives in
// evidence/cli.mjs `classifyScriptFetch`, which is SERIALIZED into the page
// expression (the same idiom runner/flow.mjs uses for its resolver), so this file
// drives the exact function the browser runs rather than a re-implementation.
//
// The cases below are the ways a script fetch fails without failing the FETCH: a
// 404, a redirect that ends on an HTML error page, and a body with no readable
// stream (which cannot be bounded in-page, so it must be refused rather than read
// with only its declared length as the bound).
//
// Run directly: node tests/secrets-coverage.mjs
// It is also imported by tests/regression.mjs so the full gate covers it.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function testSecretsCoverageClassification() {
  const { classifyScriptFetch } = await import('../evidence/cli.mjs');

  const verdict = (args) => classifyScriptFetch({
    httpOk: true, status: 200, contentType: 'text/javascript; charset=utf-8',
    hasStream: true, declaredLength: '1024', ...args,
  });

  // A clean, streamed 200 is the only shape that counts as read.
  assert(verdict({}).ok === true, 'a streamed 200 text/javascript must count as read');
  assert(verdict({ contentType: null }).ok === true,
    'a missing content-type is not evidence of failure and must still count as read');
  assert(verdict({ contentType: 'application/octet-stream' }).ok === true,
    'an unusual but non-HTML content type must still count as read');

  // A non-2xx body is not the script.
  assert(verdict({ httpOk: false, status: 404 }).ok === false,
    'a 404 must NOT count as scanned');
  assert(classifyScriptFetch({ httpOk: false, status: 500 }).error === 'HTTP 500',
    'the HTTP failure must name the status');

  // Redirected to an HTML error page: res.ok is true, but this is not JavaScript
  // and the browser would refuse to execute it.
  const html = verdict({ contentType: 'text/html; charset=utf-8' });
  assert(html.ok === false, 'an HTML body must NOT count as scanned JavaScript');
  assert(/HTML/.test(html.error), `the HTML failure must say so: ${JSON.stringify(html)}`);

  // No readable stream: fail closed. A DECLARED length is not a guarantee about the
  // bytes delivered, and an absent header used to become Number(null) === 0 and let
  // an unbounded read through (the review's P1).
  for (const declaredLength of [null, undefined, '', '42', '999999999']) {
    const noStream = verdict({ hasStream: false, declaredLength });
    assert(noStream.ok === false,
      `a body with no readable stream must be refused, not read (content-length ${JSON.stringify(declaredLength)})`);
    assert(/no readable stream/.test(noStream.error),
      `the refusal must name the cause: ${JSON.stringify(noStream)}`);
  }
  assert(/no content-length/.test(verdict({ hasStream: false, declaredLength: null }).error),
    'a missing content-length must be described as such, never coerced to zero');
  assert(/declared content-length 42/.test(verdict({ hasStream: false, declaredLength: '42' }).error),
    'a declared length must be reported without being trusted as the bound');

  // The function is interpolated into the page expression with .toString(), so it must
  // be self-contained: a bare-function evaluation must behave identically, or the page
  // throws a ReferenceError and every script silently reads as unscanned.
  const serialized = new Function(`return (${classifyScriptFetch.toString()})`)();
  assert(serialized({ httpOk: false, status: 403 }).ok === false, 'the serialized copy must decide a 403 the same way');
  assert(serialized({ httpOk: true, hasStream: false, contentType: 'text/javascript' }).ok === false,
    'the serialized copy must refuse a streamless body the same way');
  assert(serialized({ httpOk: true, hasStream: true, contentType: 'text/javascript' }).ok === true,
    'the serialized copy must accept a streamed script the same way');
}

// Run directly (node tests/secrets-coverage.mjs), not when imported by the
// regression suite, which calls the exported function itself.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await testSecretsCoverageClassification();
  console.log('tests OK');
}
