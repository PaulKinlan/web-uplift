import { writeFileSync } from 'node:fs';
import { applyConditions, emit, derivedOut, uint8FromBase64 } from '../common.mjs';
import { safeFetch, CRAWLER_UA, targetOriginOf } from '../fetch.mjs';
import { evaluate, sleep, withDeadline, getCdpCallDeadlineMs, navigate } from '../cdp.mjs';

// --- resilience primitive: offline + installable ---------------------------
//
// be-resilient/offline-and-installable had no evidence path at all: the model
// could read the manifest and nothing else. This primitive loads the page, reads
// the service worker state from the ServiceWorker CDP domain (plus the page's own
// view, which knows the controller), resolves the manifest, checks the script for
// a fetch listener, then goes genuinely offline and reloads - reporting whether
// the navigation failed, whether a cached/fallback document rendered, and a
// screenshot of that state. Same evidence serves
// be-resilient/network-and-http-failure-states.
const RESILIENCE_MANIFEST_FIELDS = [
  'id', 'name', 'short_name', 'description', 'start_url', 'scope', 'display', 'display_override',
  'orientation', 'theme_color', 'background_color', 'lang', 'dir', 'categories', 'prefer_related_applications',
];

// The SW domain events arrive once enabled; keep the latest registration/version
// state so the primitive can wait for an activation and then read it.
function attachServiceWorkerState(client, url) {
  const pageOrigin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  })();
  // The domain reports the browser's own component-extension workers too, so
  // every entry says whether it belongs to the audited origin.
  const isPageOrigin = (u) => {
    const value = String(u || '');
    if (!pageOrigin) return false;
    return value === pageOrigin || value.startsWith(`${pageOrigin}/`);
  };
  const registrations = new Map();
  const versions = new Map();
  let errorMessage = null;
  client.ServiceWorker.workerRegistrationUpdated(({ registrations: regs }) => {
    for (const r of regs || []) registrations.set(r.registrationId, r);
  });
  client.ServiceWorker.workerVersionUpdated(({ versions: vs }) => {
    for (const v of vs || []) versions.set(v.versionId, v);
  });
  client.ServiceWorker.workerErrorReported(({ errorMessage: e }) => {
    errorMessage = e?.errorMessage || (e ? String(e) : null);
  });
  return {
    async enable() {
      await client.ServiceWorker.enable();
    },
    state() {
      return {
        pageOrigin,
        registrations: [...registrations.values()].map((r) => ({
          scopeURL: r.scopeURL,
          isDeleted: !!r.isDeleted,
          pageOrigin: isPageOrigin(r.scopeURL),
        })),
        versions: [...versions.values()].map((v) => ({
          registrationId: v.registrationId,
          status: v.status,
          scriptURL: v.scriptURL,
          pageOrigin: isPageOrigin(v.scriptURL),
          runningStatus: v.runningStatus,
          controlledClients: (v.controlledClients || []).length,
        })),
        errorMessage,
      };
    },
    pageOriginRegistrations() {
      return [...registrations.values()].filter((r) => !r.isDeleted && isPageOrigin(r.scopeURL));
    },
    pageOriginActiveVersions() {
      return [...versions.values()].filter((v) => v.status === 'activated' && !v.isDeleted && isPageOrigin(v.scriptURL)).length;
    },
  };
}

// The size matchers are built once per requested size and reused: the manifest
// check asks for 192 and 512 on every run, and this used to rebuild the RegExp on
// every call. The pattern carries no /g flag, so a shared instance keeps no
// lastIndex state and is safe to reuse (web-uplift-33h).
const ICON_SIZE_PATTERNS = new Map();

export function iconSatisfies(icons, size) {
  let re = ICON_SIZE_PATTERNS.get(size);
  if (!re) {
    re = new RegExp(`(^|\\s)${size}x${size}(\\s|$)`);
    ICON_SIZE_PATTERNS.set(size, re);
  }
  return (icons || []).some((i) => {
    const sizes = String(i?.sizes || '');
    return /any/i.test(sizes) || re.test(sizes);
  });
}

export async function resilience(client, url, opts, log) {
  const sw = attachServiceWorkerState(client, url);
  await withDeadline(sw.enable(), getCdpCallDeadlineMs(), 'the browser to enable the ServiceWorker domain');

  // Online first, so a service worker can install, activate and cache.
  await navigate(client, url, {
    settleMs: opts.wait ?? 2500,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  // The ServiceWorker domain reports registrations asynchronously, so a page-origin
  // registration can be observed after the settle window - under load, well after it. The
  // wait therefore has to cover "not observed yet" as well as "observed but not yet
  // activated": the previous condition required a page-origin registration to EXIST before
  // it would wait at all, which is precisely the state the race produces, so a slow
  // registration was snapshotted as no service worker and the audit recorded a false
  // negative (web-uplift-5jd).
  //
  // Cost, stated because it is real: a page with no worker pays the whole budget once per
  // resilience call. That is the cheaper error - the alternative is reporting that a site
  // has no service worker when it does.
  //
  // The budget cannot be infinite, so what the report says about it matters: an empty
  // registration list is an OBSERVATION made inside a bounded window, not proof of absence,
  // and the two are recorded separately below in serviceWorker.observation. A page that
  // registers later, or a browser under load, produces the same empty state, so a consumer
  // that reads the list alone would repeat the false negative this wait exists to prevent.
  const REGISTRATION_WAIT_BUDGET_MS = 2000;
  const REGISTRATION_WAIT_STEP_MS = 200;
  let registrationWaitedMs = 0;
  while (registrationWaitedMs < REGISTRATION_WAIT_BUDGET_MS && sw.pageOriginRegistrations().length === 0) {
    await sleep(REGISTRATION_WAIT_STEP_MS);
    registrationWaitedMs += REGISTRATION_WAIT_STEP_MS;
  }
  const registrationObserved = sw.pageOriginRegistrations().length > 0;
  // The loop only exits early on success, so "nothing observed" and "the window closed"
  // are the same fact here; both are recorded because a reader should not have to derive it.
  const registrationBudgetExhausted = !registrationObserved;
  // Activation usually lands inside the settle window; wait a bounded moment more when a
  // page-origin worker is registered but still installing.
  for (let i = 0; i < 10 && sw.pageOriginRegistrations().length && sw.pageOriginActiveVersions() === 0; i++) {
    await sleep(300);
  }

  const cdpWorkers = sw.state();
  log(
    `[evidence] resilience: ${sw.pageOriginRegistrations().length} service worker registration(s) for this origin ` +
      `(${cdpWorkers.registrations.length} seen by CDP, which includes the browser's own extension workers), ` +
      `${sw.pageOriginActiveVersions()} activated` +
      (registrationObserved
        ? ''
        : ` - none observed within ${registrationWaitedMs}ms of waiting, which is an expired observation window rather than evidence of absence`),
  );

  const pageWorkers = await evaluate(
    client,
    `(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false, controller: null, registrations: [] };
      const regs = await navigator.serviceWorker.getRegistrations();
      return {
        supported: true,
        controller: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null,
        registrations: regs.map((r) => ({
          scope: r.scope,
          active: r.active ? r.active.scriptURL : null,
          waiting: r.waiting ? r.waiting.scriptURL : null,
          installing: r.installing ? r.installing.scriptURL : null,
        })),
      };
    })()`,
  );

  // Manifest: resolve the link, then fetch it here (no page CORS in the way).
  const manifestHref = await evaluate(
    client,
    "(document.querySelector('link[rel=\"manifest\"]') || {}).href || null",
  );
  const manifest = { href: manifestHref, found: false, fetchError: null, data: null, fields: null, icons: [] };
  if (manifestHref) {
    try {
      const fetched = await safeFetch(manifestHref, {
        base: url,
        targetOrigin: targetOriginOf(url),
        headers: { 'user-agent': CRAWLER_UA, accept: 'application/manifest+json,application/json,*/*' },
      });
      if (!fetched.res.ok) throw new Error(`HTTP ${fetched.res.status}`);
      manifest.data = JSON.parse(await fetched.text());
      manifest.found = true;
      manifest.fields = Object.fromEntries(RESILIENCE_MANIFEST_FIELDS.map((f) => [f, manifest.data[f] ?? null]));
      manifest.icons = (manifest.data.icons || []).slice(0, 10).map((i) => ({ src: i?.src || null, sizes: i?.sizes || null, type: i?.type || null, purpose: i?.purpose || null }));
    } catch (e) {
      manifest.fetchError = String(e?.message || e);
    }
  }
  log(`[evidence] resilience: manifest ${manifest.found ? 'resolved' : manifestHref ? 'failed to resolve' : 'not linked'}`);

  // The definitive installability signal for Chrome is a fetch listener in the
  // worker; read the script text and say what is there (a text heuristic, stated).
  const swScriptUrl = pageWorkers?.registrations?.map((r) => r.active || r.waiting || r.installing).find(Boolean) || null;
  let swScriptHasFetchListener = null;
  if (swScriptUrl) {
    try {
      // A worker's script URL starts same-origin with its registration, but the
      // privileged GET still has to be guarded: the server can answer THIS request
      // (different user agent) with a redirect to a private address, so it goes
      // through the same per-hop guarded, capped fetch as the other call sites
      // (adversarial review P1b, web-uplift-2kh). Only a regex boolean is kept.
      const fetched = await safeFetch(swScriptUrl, {
        targetOrigin: targetOriginOf(url),
        headers: { 'user-agent': CRAWLER_UA },
      });
      const text = await fetched.text();
      swScriptHasFetchListener = /addEventListener\(\s*['"]fetch['"]|\.onfetch\s*=/.test(text);
    } catch (e) {
      log(`[evidence] resilience: service worker script fetch refused: ${String(e?.message || e)}`);
      swScriptHasFetchListener = null;
    }
  }

  // Go offline for real and reload: does a fallback render, or does the
  // navigation fail? Page.navigate reports the net error directly.
  await withDeadline(
    client.Network.emulateNetworkConditions({ offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }),
    getCdpCallDeadlineMs(),
    'the browser to switch the network offline',
  );
  const offlineBudget = Math.max(opts.wait ?? 1500, 1500) + 3000;
  let navigationFailed = false;
  let errorText = null;
  let offlinePage = null;
  try {
    const loaded = client.Page.loadEventFired();
    // Bounded by the primitive's OWN offline budget, not the navigation default: this
    // navigate runs AFTER the network goes offline, and an offline failure response is the
    // normal path (navigationFailed is the expected outcome for a page with no fallback).
    // The load wait stays a Promise.race with the same budget - already bounded, so the
    // bead's helper is not layered on top of it.
    const nav = await withDeadline(client.Page.navigate({ url }), offlineBudget, `the navigation to ${url} to be accepted`);
    errorText = nav?.errorText || null;
    navigationFailed = !!errorText;
    if (!navigationFailed) await Promise.race([loaded, sleep(offlineBudget)]);
    else await sleep(400);
    if (!navigationFailed) {
      offlinePage = await evaluate(
        client,
        `({ title: document.title || '', url: location.href,
            textChars: document.body ? document.body.innerText.length : 0,
            textSample: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 300),
            controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller) })`,
      );
    }
  } catch (e) {
    navigationFailed = true;
    errorText = errorText || String(e?.message || e);
  }

  let offlineScreenshot = null;
  if (opts.screenshots !== false) {
    try {
      const base = (opts.out ? opts.out.replace(/\.json$/i, '') : derivedOut(url, 'resilience', '').replace(/\.$/, ''));
      offlineScreenshot = `${base}-offline.png`;
      const shot = await client.Page.captureScreenshot({ format: 'png' });
      writeFileSync(offlineScreenshot, uint8FromBase64(shot.data));
      log('[evidence] resilience: wrote the offline screenshot');
    } catch (e) {
      offlineScreenshot = null;
      log(`[evidence] resilience: offline screenshot failed: ${String(e?.message || e)}`);
    }
  }
  await withDeadline(
    client.Network.emulateNetworkConditions({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }),
    getCdpCallDeadlineMs(),
    'the browser to switch the network back online',
  );
  log(
    navigationFailed
      ? `[evidence] resilience: offline navigation FAILED (${errorText})`
      : `[evidence] resilience: offline navigation rendered ${offlinePage?.textChars ?? 0} char(s) from cache`,
  );

  const icons = manifest.icons;
  const secureContext = url.startsWith('https://') || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(url);
  const result = {
    primitive: 'resilience',
    url,
    scannedAt: new Date().toISOString(),
    manifest,
    serviceWorker: {
      cdp: cdpWorkers,
      page: pageWorkers,
      scriptURL: swScriptUrl,
      scriptTextHasFetchListener: swScriptHasFetchListener,
      // What this run could and could not establish about registration. `page.registrations`
      // being empty means "not observed inside this window", never "absent": the primitive
      // cannot await a registration the page makes on its own schedule, so the window is
      // recorded alongside the list and carries its own caveat when it expired
      // (web-uplift-5jd).
      observation: {
        budgetMs: REGISTRATION_WAIT_BUDGET_MS,
        waitedMs: registrationWaitedMs,
        registrationObserved: registrationObserved,
        budgetExhausted: registrationBudgetExhausted,
        ...(registrationBudgetExhausted
          ? {
              note:
                `No page-origin service worker registration was observed within ` +
                `${REGISTRATION_WAIT_BUDGET_MS}ms of waiting after the settle window. This is an ` +
                `observation window that expired, not evidence of absence: a page that registers ` +
                `later, or a browser under load, produces the same empty state.`,
            }
          : {}),
      },
    },
    installabilitySignals: {
      secureContext,
      manifestLinked: !!manifestHref,
      manifestResolved: manifest.found,
      hasName: !!(manifest.data?.name || manifest.data?.short_name),
      declaresStartUrl: manifest.data?.start_url != null,
      display: manifest.data?.display ?? null,
      displayStandaloneish: ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'].includes(
        String(manifest.data?.display ?? '').toLowerCase(),
      ),
      has192Icon: iconSatisfies(icons, 192),
      has512Icon: iconSatisfies(icons, 512),
      serviceWorkerRegistered: (pageWorkers?.registrations?.length || 0) > 0,
      serviceWorkerControlling: !!pageWorkers?.controller,
      serviceWorkerHasFetchListener: swScriptHasFetchListener,
    },
    offline: {
      navigationFailed,
      errorText,
      rendered: offlinePage,
      screenshot: offlineScreenshot,
    },
    note:
      'Offline and installable evidence for be-resilient. The page is loaded ONLINE first so a service worker can install, activate and cache, then Network.emulateNetworkConditions(offline: true) is applied and the URL is reloaded: `offline.navigationFailed` is the net error Page.navigate reported, and `offline.rendered` is what actually painted (title, text, controller state) with `offline.screenshot` as the legible artifact - a failed navigation with no worker means the site is unusable offline, while a rendered fallback (or the cached page) is the offline story. `installabilitySignals` are the mechanical signals Chrome uses (secure context, resolved manifest with a name, 192 and 512 icons, a standalone-ish display, a registered service worker, and a fetch listener found by reading the worker script - a stated text heuristic, not a browser verdict), so judge installability from them rather than from any one field. Worker state comes from the ServiceWorker CDP domain (every entry says whether it belongs to the audited origin, because the domain also reports the browser\'s own extension workers) and is cross-checked against the page view, which is the only source for the controller. `serviceWorker.observation` states the bounded window registration was looked for in: `registrationObserved` false with `budgetExhausted` true means none was seen inside that window, which is NOT the same claim as the page having no worker, and must not be reported as one. Descriptive signal, not a verdict.',
  };
  return emit(opts, result, client);
}

