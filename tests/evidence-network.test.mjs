#!/usr/bin/env node
// headers, HAR and resilience: the cases whose subject is the response and what the page does without one.
//
// SPLIT FROM tests/evidence.test.mjs (web-uplift-bop3). The gate runs each tests/*.test.mjs in
// its own node:test process and is bounded by its slowest single file, so one 121s file
// throttled the whole gate. Cases moved here unchanged; no case was dropped, relaxed or
// reordered, and every case remains independent (it builds its own server and browser).

import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assert, run, tmp, runSuite } from './test-helpers.mjs';
import { gather, isFirstPartyHost } from '../evidence/cli.mjs';
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
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
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
    res.end(`<!doctype html><title>ok</title><link rel="icon" href="data:,">${scripts}ok`);
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

    // --bodies must attach every retrievable body, including past the pool's
    // concurrency limit, and must not attach one to the redirect entry.
    const har = JSON.parse(readFileSync(out, 'utf8'));
    const withBody = har.log.entries.filter((e) => e.response?.content?.text !== undefined);
    assert(
      withBody.length === BODY_COUNT + 1,
      `--bodies must capture ${BODY_COUNT + 1} bodies (document + ${BODY_COUNT} scripts), got ${withBody.length}`,
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


// The trackers primitive records HOSTNAMES, so a third party whose hostname
// merely ENDS WITH the first-party hostname ('notlocalhost' for a page on
// 'localhost') must still be counted, while a SUBDOMAIN of the first party
// ('sub.localhost') must not be. The old bare `!endsWith(firstParty)` suffix
// match classified the first case as first-party and dropped it, and with it any
// known tracker on such a host.

export async function testTrackersThirdPartySuffix() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>trackers-fixture</title><link rel="icon" href="data:,">' +
        '<img src="http://notlocalhost:9/tracker.js" alt="">' +
        '<img src="http://sub.localhost:9/sub.js" alt=""><h1>trackers fixture</h1>',
    );
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const result = await gather('trackers', `http://localhost:${port}/`, { quiet: true, wait: 1500 });
    const third = (result.topThirdPartyByRequests || []).map((e) => e.origin);
    assert(
      result.firstParty === 'localhost',
      `trackers must record the page hostname as firstParty, got ${result.firstParty}`,
    );
    assert(
      third.includes('notlocalhost'),
      `a third party whose host only ends with the first-party host must still be counted: ${JSON.stringify(third)}`,
    );
    assert(
      !third.includes('localhost'),
      `the first-party host itself must not be counted as third-party: ${JSON.stringify(third)}`,
    );
    // Without this the test still passes with the subdomain clause deleted from
    // isFirstPartyHost (a mutant reduced to `host === firstParty` classifies
    // sub.localhost as third-party).
    assert(
      !third.includes('sub.localhost'),
      `a SUBDOMAIN of the first-party host must count as first-party: ${JSON.stringify(third)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// web-uplift-1s8: a cap that drops evidence must say so, in the JSON and on
// stderr. The dom primitive's 200000-character CSS/HTML cap is the dangerous
// one: a model grepping the returned css for "@container" cannot otherwise tell
// "the site does not use container queries" from "the evidence was cut off".

export async function testResiliencePrimitive() {
  const swJs = [
    "const CACHE = 'fixture-v1';",
    "self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/offline.html']))); });",
    "self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });",
    'self.addEventListener(\'fetch\', (e) => {',
    // Navigations use the app-shell fallback (no network), so the fallback path
    // is deterministic offline; other requests go cache-first then network.
    "  if (e.request.mode === 'navigate') {",
    "    e.respondWith(caches.match(e.request).then((hit) => hit || caches.match('/offline.html')));",
    '    return;',
    '  }',
    "  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));",
    '});',
  ].join('\n');
  const manifest = JSON.stringify({
    name: 'Fixture App',
    short_name: 'Fixture',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: '#123456',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
  const pixel = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0),
  );
  const swPage = (title) => `<!doctype html><html><head><title>${title}</title>` +
    '<link rel="manifest" href="/manifest.webmanifest">' +
    '<script>navigator.serviceWorker.register("/sw.js")</script></head>' +
    `<body><h1>${title}</h1><p>Fixture body content for the resilience primitive.</p></body></html>`;
  // A page-controlled manifest href must not make the privileged Node process
  // fetch a private address: the guard has to refuse it and persist nothing into
  // the report (threat model I2 / F-003, web-uplift-2kh). 169.254.169.254 is the
  // cloud metadata service.
  const evilManifestPage = '<!doctype html><html><head><title>Evil manifest</title>' +
    '<link rel="manifest" href="http://169.254.169.254/latest/meta-data/"></head>' +
    '<body><h1>Evil manifest</h1></body></html>';

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    const send = (type, body, code = 200, extra = {}) => {
      res.writeHead(code, { 'Content-Type': type, ...extra });
      res.end(body);
    };
    if (path === '/sw.js') return send('text/javascript', swJs);
    if (path === '/manifest.webmanifest') return send('application/manifest+json', manifest);
    if (path === '/offline.html') {
      return send('text/html', '<!doctype html><html><head><title>Offline fallback</title></head>' +
        '<body><h1>Offline fallback</h1><p>Cached by the service worker.</p></body></html>');
    }
    if (path.startsWith('/icon-')) return send('image/png', pixel);
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === '/no-sw') {
      return send('text/html', '<!doctype html><html><head><title>No service worker</title></head>' +
        '<body><h1>No service worker</h1><p>Nothing resilient here.</p></body></html>');
    }
    if (path === '/evil-manifest') return send('text/html', evilManifestPage);
    // no-store, so the browser's HTTP cache cannot quietly stand in for the
    // service worker's fallback: offline emulation still serves cache hits.
    if (path === '/uncached-sw') return send('text/html', swPage('Uncached page with service worker'), 200, { 'Cache-Control': 'no-store' });
    return send('text/html', swPage('Fixture with service worker'));
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const out = join(tmp, 'resilience-sw.json');

    const withSw = await gather('resilience', `${base}/`, { quiet: true, wait: 800, out });
    assert(
      withSw.manifest.found === true && withSw.manifest.fields?.name === 'Fixture App' && withSw.manifest.icons.length === 2,
      `resilience: the manifest was not resolved with its fields: ${JSON.stringify(withSw.manifest)}`,
    );
    assert(
      withSw.serviceWorker.scriptTextHasFetchListener === true,
      `resilience: the fetch listener was not read from the worker script: ${JSON.stringify(withSw.serviceWorker)}`,
    );
    assert(
      withSw.serviceWorker.page.controller?.endsWith('/sw.js') === true,
      `resilience: the page should report its controller: ${JSON.stringify(withSw.serviceWorker.page)}`,
    );
    const cdpRegs = withSw.serviceWorker.cdp.registrations;
    assert(
      cdpRegs.some((r) => r.pageOrigin && r.scopeURL.startsWith(base)),
      `resilience: the page-origin registration should be in the CDP list: ${JSON.stringify(cdpRegs)}`,
    );
    assert(
      cdpRegs.some((r) => !r.pageOrigin),
      `resilience: the browser's own workers must be marked as not this origin: ${JSON.stringify(cdpRegs)}`,
    );
    const signals = withSw.installabilitySignals;
    assert(
      signals.secureContext === true && signals.manifestResolved === true && signals.hasName === true &&
        signals.has192Icon === true && signals.has512Icon === true && signals.displayStandaloneish === true &&
        signals.serviceWorkerRegistered === true && signals.serviceWorkerHasFetchListener === true,
      `resilience: installability signals are wrong: ${JSON.stringify(signals)}`,
    );

    // Offline: the precached URL renders from cache, controlled by the worker,
    // and the legible artifact is on disk.
    assert(
      withSw.offline.navigationFailed === false && withSw.offline.rendered?.title === 'Fixture with service worker',
      `resilience: the precached page should render offline: ${JSON.stringify(withSw.offline)}`,
    );
    assert(
      withSw.offline.rendered.controlled === true,
      `resilience: the offline render should be under the worker's control: ${JSON.stringify(withSw.offline.rendered)}`,
    );
    assert(
      typeof withSw.offline.screenshot === 'string' && statSync(withSw.offline.screenshot).size > 0,
      `resilience: the offline screenshot should exist: ${withSw.offline.screenshot}`,
    );

    // An uncached URL inside the worker's scope falls back to the offline page.
    const fallback = await gather('resilience', `${base}/uncached-sw`, { quiet: true, wait: 800, screenshots: false });
    assert(
      fallback.offline.navigationFailed === false && fallback.offline.rendered?.title === 'Offline fallback',
      `resilience: an uncached URL should render the fallback: ${JSON.stringify(fallback.offline)}`,
    );

    // Nothing resilient: the offline navigation fails and says why.
    const bare = await gather('resilience', `${base}/no-sw`, { quiet: true, wait: 500, screenshots: false });
    assert(
      bare.serviceWorker.page.registrations.length === 0 && bare.installabilitySignals.serviceWorkerRegistered === false,
      `resilience: a page without a worker should report none: ${JSON.stringify(bare.serviceWorker)}`,
    );
    assert(
      bare.manifest.found === false && bare.installabilitySignals.manifestResolved === false,
      `resilience: a page without a manifest should report none: ${JSON.stringify(bare.manifest)}`,
    );
    assert(
      bare.offline.navigationFailed === true && typeof bare.offline.errorText === 'string' && bare.offline.rendered === null,
      `resilience: offline navigation should fail with a net error: ${JSON.stringify(bare.offline)}`,
    );

    // A page-controlled manifest href pointing at a private address must be
    // refused by the guard, with no body persisted into the evidence.
    const evil = await gather('resilience', `${base}/evil-manifest`, { quiet: true, wait: 300, screenshots: false });
    assert(
      evil.manifest.found === false &&
        evil.manifest.data === null &&
        /refused:/.test(String(evil.manifest.fetchError)) &&
        evil.installabilitySignals.manifestResolved === false,
      `resilience: a manifest href pointing at a private address must be refused with nothing persisted: ${JSON.stringify(evil.manifest)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// be-resilient/offline-and-installable had no evidence path: the model could
// read the manifest and nothing else. This drives the real behaviour - install a
// service worker online, then go genuinely offline and reload: once for a
// precached URL (the cached page renders), once for an uncached one in scope
// (the offline fallback renders), and once on a page with nothing resilient at
// all (the navigation fails with a net error). It also checks that CDP's worker
// list is attributed per origin, because the domain also reports the browser's
// own extension workers (web-uplift-7v3).
// A service worker registration is reported by the ServiceWorker domain asynchronously, so
// under load it can land after the navigation settle window has closed. The primitive used
// to extend its wait only when a page-origin registration had ALREADY been observed - which
// is exactly the state the race produces - so a slow registration was snapshotted as no
// service worker at all: an intermittent false negative in an audit finding
// (web-uplift-5jd). This fixture makes the race deterministic instead of waiting for
// contention to produce it: the page registers its worker after the settle window expires,
// so the registration can only be reported if the primitive waits for it.

export async function testResilienceWaitsForLateServiceWorkerRegistration() {
  const swJs = [
    "self.addEventListener('install', (e) => { e.waitUntil(caches.open('late-v1').then((c) => c.addAll(['/']))); });",
    "self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)); });",
  ].join('\n');
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    const send = (type, body) => {
      res.writeHead(200, { 'Content-Type': type });
      res.end(body);
    };
    if (path === '/sw.js') return send('text/javascript', swJs);
    if (path === '/no-worker') {
      return send('text/html', '<!doctype html><html><head><title>No worker</title></head>' +
        '<body><h1>No worker</h1></body></html>');
    }
    return send('text/html', '<!doctype html><html><head><title>Late worker</title>' +
      // 1200ms is well past the 400ms settle passed below, so the registration is
      // guaranteed to be unobserved when the settle window closes.
      '<script>setTimeout(() => navigator.serviceWorker.register("/sw.js"), 1200);</script>' +
      '</head><body><h1>Late worker</h1></body></html>');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    // screenshots: false, matching the other resilience fixtures that assert state rather
    // than pixels: without it (or an `out` path) the primitive derives the offline
    // screenshot name from the report path and writes it into the working directory, which
    // leaves an untracked file in the checkout after every suite run.
    const result = await gather('resilience', `${base}/`, { quiet: true, wait: 400, screenshots: false });
    const regs = result.serviceWorker?.cdp?.registrations ?? [];
    assert(
      regs.some((r) => r.pageOrigin && String(r.scopeURL).startsWith(base)),
      `resilience: a registration landing after the settle window must still be reported, got ${JSON.stringify(regs)}`,
    );
    assert(
      result.serviceWorker?.scriptTextHasFetchListener === true,
      `resilience: the late worker's script must still be read, got ${JSON.stringify(result.serviceWorker)}`,
    );

    // The report has to say which of the two claims it is making. A worker observed inside
    // the window must not be recorded as an expired window (web-uplift-5jd).
    const seen = result.serviceWorker?.observation;
    assert(
      seen?.registrationObserved === true && seen?.budgetExhausted === false,
      `resilience: an observed registration must not be reported as an exhausted window, got ${JSON.stringify(seen)}`,
    );
    assert(
      seen?.budgetMs > 0 && seen?.waitedMs <= seen.budgetMs,
      `resilience: the observation window must be recorded with what was actually spent, got ${JSON.stringify(seen)}`,
    );

    // The other half of the distinction: a page with no worker at all. The primitive cannot
    // prove absence - it can only say the window closed with nothing observed - so the
    // artifact has to carry that caveat rather than leaving a reader to infer absence from
    // an empty list.
    const bare = await gather('resilience', `${base}/no-worker`, { quiet: true, wait: 400, screenshots: false });
    const unseen = bare.serviceWorker?.observation;
    assert(
      unseen?.registrationObserved === false && unseen?.budgetExhausted === true,
      `resilience: a page with no worker must be recorded as an expired window, not as an observation of one, got ${JSON.stringify(unseen)}`,
    );
    assert(
      typeof unseen?.note === 'string' && unseen.note.includes('not evidence of absence'),
      `resilience: an expired window must carry its caveat in the artifact itself, got ${JSON.stringify(unseen)}`,
    );
    assert(
      (bare.serviceWorker?.page?.registrations?.length ?? -1) === 0 &&
        bare.installabilitySignals?.serviceWorkerRegistered === false,
      `resilience: a page with no worker should still report none in the page view, got ${JSON.stringify(bare.serviceWorker?.page)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// be-inclusive/names-roles-labels and structure-and-focus cannot be judged from
// DOM attributes alone: aria-labelledby overrides aria-label, a name can come
// from title, and a subtree hidden by aria-hidden is still in the tab order.
// This drives the computed AX tree and the real tab order (web-uplift-5lp).

export const evidenceNetworkTests = [
  testHeadersPrimitiveFindsHeadersRegardlessOfNameCase,
  testHeadersPrimitiveSurvivesSlowResponseUnderLoad,
  testHarReadsRequestContentTypeAndRedirectLocationRegardlessOfCase,
  testHarRedirects,
  testHarWaitsForPendingResponses,
  testTrackersThirdPartySuffix,
  testResiliencePrimitive,
  testResilienceWaitsForLateServiceWorkerRegistration,
];

await runSuite(evidenceNetworkTests, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
