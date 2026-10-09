import { announceCap, emit } from '../common.mjs';
import { isFirstPartyHost } from '../html-text.mjs';
import { navigate, sleep } from '../cdp.mjs';

const KNOWN_TRACKERS = new Set([
  'google-analytics.com','googletagmanager.com','doubleclick.net','googleadservices.com','googlesyndication.com',
  'facebook.net','connect.facebook.net','hotjar.com','segment.io','segment.com','mixpanel.com','amplitude.com',
  'fullstory.com','clarity.ms','quantserve.com','scorecardresearch.com','criteo.com','taboola.com','outbrain.com',
  'pubmatic.com','rubiconproject.com','openx.net','adnxs.com','casalemedia.com','nr-data.net','newrelic.com',
  'sentry.io','bugsnag.com','branch.io','appsflyersdk.com','adjust.com','tiktokv.com','bat.bing.com',
  'ads.linkedin.com','ads.twitter.com','pinterest.com',
]);
export async function trackers(client, url, opts, log) {
  log('[trackers] enumerating ' + url);
  const origins = new Map();
  client.Network.requestWillBeSent(({request}) => {
    try {
      const o = new URL(request.url).hostname;
      const entry = origins.get(o) || { origin: o, requests: 0 };
      entry.requests++;
      origins.set(o, entry);
    } catch {}
  });
  await navigate(client, url, { settleMs: opts.wait || 4000, log });
  await sleep(1000);
  let firstParty = '';
  try { firstParty = new URL(url).hostname; } catch {}
  const all = [...origins.values()];
  // o.origin is a HOSTNAME (see requestWillBeSent above), so compare hostnames.
  // The old `!o.origin.endsWith(firstParty)` suffix-matched a hostname against a
  // bare hostname, so a genuine third party whose name merely ENDS WITH the
  // first-party name ('notlocalhost' for 'localhost', 'notexample.com' for
  // 'example.com') was classified first-party and dropped from thirdParty,
  // thirdPartyOrigins and topThirdPartyByRequests. The comparison now lives in
  // the shared isFirstPartyHost helper (also used by the cookies primitive, so a
  // future fix cannot miss one call site); the first-party host itself and its
  // subdomains stay first-party, matching the tracker comparison below.
  const thirdParty = all.filter((o) => !isFirstPartyHost(o.origin, firstParty));
  const trackersFound = thirdParty.filter(o => [...KNOWN_TRACKERS].some(t => o.origin === t || o.origin.endsWith('.' + t)));
  announceCap('trackers.topThirdPartyByRequests', Math.min(thirdParty.length, 15), thirdParty.length, log);
  const summary = {
    primitive: 'trackers', url,
    scannedAt: new Date().toISOString(),
    firstParty,
    totalOrigins: all.length,
    thirdPartyOrigins: thirdParty.length,
    knownTrackers: trackersFound.map(t => t.origin),
    topThirdPartyByRequests: thirdParty.sort((a,b) => b.requests - a.requests).slice(0, 15).map(o => ({ origin: o.origin, requests: o.requests })),
    topThirdPartyByRequestsTotal: thirdParty.length,
    topThirdPartyByRequestsTruncated: thirdParty.length > 15,
    note: 'Descriptive signal. Judge against be-private-and-secure (tracking footprint) and be-sustainable (third-party bytes). Known tracker domains indicate active tracking.',
  };
  return emit(opts, summary, client);
}

// --- images primitive: image optimization audit ---------------------------
