#!/usr/bin/env node
// Trackers and resilience: the cases whose subject is third-party attribution and what the page does
// without a network.
//
// SPLIT FROM tests/evidence.test.mjs / tests/evidence-network.test.mjs (web-uplift-f5mb). The gate runs
// each tests/*.test.mjs in its own node:test process and is bounded by the files on its critical path, so
// the heaviest cases in those two files throttled every landing. The cases moved here unchanged: none was
// dropped, relaxed or reordered, and each remains independent (it builds its own server and browser).
// tests/regression.mjs discovers this file automatically, and testSuiteListsMatchRegressionRegistry pins
// that the union of the suite lists is unchanged.

import http from 'node:http';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { assert, run, tmp, runSuite } from './test-helpers.mjs';
import { gather, isFirstPartyHost } from '../evidence/cli.mjs';



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
        '<img src="http://notlocalhost:9/tracker-again.js" alt="">' +
        '<img src="http://tracker.invalid:9/beacon.gif" alt="">' +
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
    // Two third-party origins with DIFFERENT request counts (web-uplift-js42): the
    // ranking is built by a sort and a map that only run with two or more, so
    // without this the list order is untested and the busier origin could be
    // reported second without any assertion noticing.
    const top = result.topThirdPartyByRequests || [];
    assert(
      top.length >= 2 && top[0].origin === 'notlocalhost' && top[0].requests > top[1].requests,
      `third-party origins must be ranked by request count, busiest first: ${JSON.stringify(top)}`,
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

export const evidenceNetworkResilienceTests = [
  testTrackersThirdPartySuffix,
  testResiliencePrimitive,
  testResilienceWaitsForLateServiceWorkerRegistration,
];

await runSuite(evidenceNetworkResilienceTests, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
