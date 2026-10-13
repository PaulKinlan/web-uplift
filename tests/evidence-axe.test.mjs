#!/usr/bin/env node
// The axe primitive under the page's own policy: what the accessibility engine may do to a page that
// refuses injected scripts, and what the result must disclose about the injection it performed.
//
// SPLIT FROM tests/evidence.test.mjs / tests/evidence-network.test.mjs (web-uplift-f5mb). The gate runs
// each tests/*.test.mjs in its own node:test process and is bounded by the files on its critical path, so
// the heaviest cases in those two files throttled every landing. The cases moved here unchanged: none was
// dropped, relaxed or reordered, and each remains independent (it builds its own server and browser).
// tests/regression.mjs discovers this file automatically, and testSuiteListsMatchRegressionRegistry pins
// that the union of the suite lists is unchanged.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, run, tmp, runSuite } from './test-helpers.mjs';
import { gather } from '../evidence/cli.mjs';



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

export const evidenceAxeTests = [
  testAxePrimitiveBypassesStrictCsp,
  testAxeKeepsPagePolicyAndDisclosesInjectionBypass,
];

await runSuite(evidenceAxeTests, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
