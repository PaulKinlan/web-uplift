#!/usr/bin/env node
// HAR capture: the cases whose subject is what the network record holds (request content type,
// redirect location) and whether it waits for responses that land late.
//
// SPLIT FROM tests/evidence.test.mjs / tests/evidence-network.test.mjs (web-uplift-f5mb). The gate runs
// each tests/*.test.mjs in its own node:test process and is bounded by the files on its critical path, so
// the heaviest cases in those two files throttled every landing. The cases moved here unchanged: none was
// dropped, relaxed or reordered, and each remains independent (it builds its own server and browser).
// tests/regression.mjs discovers this file automatically, and testSuiteListsMatchRegressionRegistry pins
// that the union of the suite lists is unchanged.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assert, tmp, runSuite } from './test-helpers.mjs';
import { gather } from '../evidence/cli.mjs';



// The HAR path reads two header values out of the raw CDP objects: a request's
// content-type and a redirect's location. Both were looked up by one exact casing
// ('Content-Type', and only 'Location'/'location'), so any other casing was missed
// - the fetch API sends a lower-case name, and a server may send LOCATION in any
// case at all. Both now go through headerMap, the same lower-casing the rest of
// the HAR path uses (web-uplift-0w6).

export async function testHarReadsRequestContentTypeAndRedirectLocationRegardlessOfCase() {
  const received = [];
  const page = (title, script = '') =>
    `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1></main>${script}</body></html>`;
  const postScript = `<script>fetch('/post',{method:'POST',headers:{'content-type':'application/json'},body:'{"a":1}'}).catch(()=>{})</script>`;
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/post') {
      received.push(req.rawHeaders);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (path === '/redirect') {
      res.writeHead(302, { 'LOCATION': '/final', 'Content-Type': 'text/html' });
      res.end(page('redirect', postScript));
      return;
    }
    // A redirect response body is never executed, so the POST belongs to the page
    // the redirect lands on.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page(path === '/final' ? 'final' : 'root', path === '/final' ? postScript : ''));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    // Prove the fixtures: the redirect really leaves with an all-caps name, and the
    // POST really arrives with a lower-case one.
    const wire = await new Promise((resolve, reject) => {
      const request = http.get(`${base}/redirect`, (res) => {
        const names = res.rawHeaders.filter((_, index) => index % 2 === 0);
        res.resume();
        resolve(names);
      });
      request.on('error', reject);
    });
    assert(wire.includes('LOCATION'), `the redirect fixture must really send an all-caps header name: ${JSON.stringify(wire)}`);

    const out = join(tmp, 'har-header-case.har');
    await gather('har', `${base}/redirect`, { quiet: true, wait: 1200, out });
    const entries = JSON.parse(readFileSync(out, 'utf8')).log.entries;
    const redirect = entries.find((entry) => entry.response.status === 302);
    assert(redirect, `the redirect entry must be recorded: ${JSON.stringify(entries.map((entry) => entry.response.status))}`);
    assert(
      redirect.response.redirectURL === '/final',
      `a redirect location must be read whatever case its name arrives in: ${JSON.stringify(redirect.response.redirectURL)}`,
    );
    assert(received.length > 0, 'the fixture must have received the POST');
    assert(
      received[0].includes('content-type'),
      `the POST must really arrive with a lower-case header name: ${JSON.stringify(received[0])}`,
    );
    const post = entries.find((entry) => entry.request.method === 'POST');
    assert(post, `the POST entry must be recorded: ${JSON.stringify(entries.map((entry) => entry.request.method))}`);
    assert(
      post.request.postData?.mimeType === 'application/json',
      `a request content-type must be read whatever case its name arrives in: ${JSON.stringify(post.request.postData)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}



export async function testHarRedirects() {
  // Also covers the --bodies path: the document plus 12 scripts is more than the
  // body-fetch pool's in-flight limit, so the pool has to recycle its workers,
  // and the redirect entry must still end up with no body attached.
  const BODY_COUNT = 12;
  // A 1x1 PNG and a cross-origin request (web-uplift-js42): the binary body is what
  // exercises the base64 content path, and asking for it on `localhost` while the
  // page is served on `127.0.0.1` makes it a genuine third-party origin, which is
  // what runs the origins ranking and the third-party byte/count totals. The dead
  // image on a closed port is what makes the transport-failure path fire.
  const PNG = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+8QAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0),
  );
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/pic.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG);
      return;
    }
    if (path === '/start') {
      res.writeHead(302, { Location: '/final' });
      res.end('redirecting');
      return;
    }
    if (/^\/s\d+\.js$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(`window.__body_${path.slice(2, -3)} = true;`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const scripts = Array.from({ length: BODY_COUNT }, (_, i) => `<script src="/s${i}.js"></script>`).join('');
    const crossHost = String(req.headers.host || '').replace('127.0.0.1', 'localhost');
    res.end(`<!doctype html><title>ok</title><link rel="icon" href="data:,">${scripts}<img src="http://${crossHost}/pic.png" alt=""><img src="http://127.0.0.1:9/dead.png" alt="">ok`);
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'network.har');
    const result = await gather('har', `http://127.0.0.1:${port}/start`, {
      quiet: true,
      // 2.5s, not the 250ms this test used before it asserted on bodies: the
      // subresource loadingFinished events that make a body retrievable can
      // arrive well after the load event on a heavily stolen-CPU box, so a
      // tight window makes --bodies assertions flap for environmental reasons.
      wait: 2500,
      bodies: true,
      out,
    });
    assert(result.statusBreakdown['302'] === 1, `HAR status breakdown missed redirect: ${JSON.stringify(result.statusBreakdown)}`);

    const summary = JSON.parse(readFileSync(join(tmp, 'network-summary.json'), 'utf8'));
    assert(
      summary.hygiene.redirects.some((r) => r.status === 302 && r.location === '/final'),
      `HAR summary missed redirect hygiene entry: ${JSON.stringify(summary.hygiene.redirects)}`,
    );

    // Every cacheable type without cache-control/expires lands in the missing-cache
    // list, and that list is ranked by transferred size (web-uplift-js42): the
    // fixture's 12 scripts and the PNG qualify, so more than one entry is expected
    // and the ordering is the contract a model reads.
    const missingCache = summary.hygiene.missingCacheHeaders || [];
    assert(
      summary.hygiene.missingCacheHeadersTotal >= 2 &&
        missingCache.every((e, i) => i === 0 || missingCache[i - 1].transferredBytes >= e.transferredBytes),
      `the missing-cache list must rank every cacheable response without cache headers by size: ${JSON.stringify(missingCache)}`,
    );

    // --bodies must attach every retrievable body, including past the pool's
    // concurrency limit, and must not attach one to the redirect entry.
    const har = JSON.parse(readFileSync(out, 'utf8'));
    const withBody = har.log.entries.filter((e) => e.response?.content?.text !== undefined);
    assert(
      withBody.length === BODY_COUNT + 2,
      `--bodies must capture ${BODY_COUNT + 2} bodies (document + ${BODY_COUNT} scripts + the PNG), got ${withBody.length}`,
    );
    for (let i = 0; i < BODY_COUNT; i++) {
      const entry = har.log.entries.find((e) => e.request.url.endsWith(`/s${i}.js`));
      assert(
        entry?.response?.content?.text === `window.__body_${i} = true;`,
        `--bodies missed or corrupted /s${i}.js body: ${JSON.stringify(entry?.response?.content)}`,
      );
    }
    const redirectEntry = har.log.entries.find((e) => e.request.url.endsWith('/start'));
    assert(redirectEntry?.response?.content?.text == null, '--bodies must not attach a body to the redirect entry');
    const documentEntry = har.log.entries.find((e) => e.request.url.endsWith('/final'));
    assert(documentEntry?.response?.content?.text?.includes('ok'), '--bodies must capture the document body');
    // A binary body arrives base64-encoded, and its reported size must be the
    // DECODED size rather than the base64 length (web-uplift-js42).
    const picEntry = har.log.entries.find((e) => e.request.url.endsWith('/pic.png'));
    assert(
      picEntry?.response?.content?.encoding === 'base64' && picEntry.response.content.size === PNG.length,
      `--bodies must record a binary body as base64 with its true decoded size (${PNG.length} bytes): ${JSON.stringify(picEntry?.response?.content)}`,
    );
    assert(
      summary.thirdParty?.thirdPartyRequestCount > 0 && summary.thirdParty?.thirdPartyTransferredBytes > 0,
      `the cross-origin image must be counted as third-party traffic: ${JSON.stringify(summary.thirdParty)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}




// har records the network while a page loads, but a response can land after the
// fixed observation window: a fetch/XHR the page fires post-load, or a CDP event
// still queued under host CPU starvation. The primitive must settle the network
// before snapshotting rather than trusting the sleep, and it must say how long
// the load waiter took (web-uplift-e13). The server here deliberately holds the
// response past the window, so a primitive that trusts the sleep reports
// response.status 200 with no body and a non-zero pending count.

export async function testHarWaitsForPendingResponses() {
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/slow.json') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"slow":true}');
      }, 1500);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>slow-fixture</title><link rel="icon" href="data:,">' +
        '<script>fetch("/slow.json");</script><h1>slow</h1>',
    );
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'slow-network.har');
    const result = await gather('har', `http://127.0.0.1:${port}/`, { quiet: true, wait: 400, bodies: true, out });
    assert(Number.isFinite(result.loadWaitMs), `har must report how long the load waiter took: ${result.loadWaitMs}`);
    assert(
      result.networkPendingAtSnapshot === 0,
      `har must settle the network before snapshotting; ${result.networkPendingAtSnapshot} still pending`,
    );
    const har = JSON.parse(readFileSync(out, 'utf8'));
    const slow = har.log.entries.find((e) => e.request.url.endsWith('/slow.json'));
    assert(
      slow?.response?.content?.text === '{"slow":true}',
      `har must capture a body that arrives after the observation window: ${JSON.stringify(slow?.response?.content)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

export const evidenceNetworkHarTests = [
  testHarReadsRequestContentTypeAndRedirectLocationRegardlessOfCase,
  testHarRedirects,
  testHarWaitsForPendingResponses,
];

await runSuite(evidenceNetworkHarTests, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
