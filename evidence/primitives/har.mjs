import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { applyConditions, announceCap, round, byteLength, headerMap, headerArray, derivedOut } from '../common.mjs';
import { redactUrlCredentialValues, redactQueryList, redactBodyText, redactHeaderList } from '../redaction.mjs';
import { navigate, evaluate, withDeadline, sleep } from '../cdp.mjs';

function queryString(url) {
  try {
    const u = new URL(url);
    return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

// 4 base64 chars -> 3 bytes, minus padding. No Node Buffer.
function approxBase64DecodedSize(b64) {
  const len = b64.length;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

const BODY_FETCH_CONCURRENCY = 8;

// Run `task` over `items` with at most `limit` in flight at once. Completion
// order is deliberately not preserved: callers write results into their own
// items, so the ordering of the returned promise is irrelevant. Used by the
// network body fetch, where each item is an independent CDP round trip.
async function mapBounded(items, limit, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await task(item);
    }
  });
  await Promise.all(workers);
}

// har: record the network over the load (+ optional --interact / --duration)
// via the CDP Network domain and assemble a valid HAR 1.2 log. Network.enable is
// already on from newSession; we attach the lifecycle listeners, navigate, then
// build entries. Response bodies are fetched as base64 via Network.getResponseBody
// (CDP returns a string; no Node Buffer involved).
// The fixed `sleep(opts.duration || opts.wait)` is the observation window for
// requests the page fires after load, but it must not also decide whether a
// response is available to fetch: under host CPU starvation the CDP events can
// still be queued when the sleep ends, and a request still PENDING at that point
// silently yields no body and a response.status of 0 in the HAR. Wait, bounded,
// for every recorded request to reach a terminal state (finished, failed, or a
// redirect that was followed) before snapshotting.
const NETWORK_IDLE_DEADLINE_MS = 10000;

async function waitForNetworkIdle(records, deadlineMs, log) {
  const started = Date.now();
  const pendingNow = () => records.filter((r) => !r.finished && !r.failed && !r.redirectedTo).length;
  let pending = pendingNow();
  while (pending > 0 && Date.now() - started < deadlineMs) {
    await sleep(50);
    pending = pendingNow();
  }
  if (pending > 0) {
    log(
      `[evidence] network did not settle within ${deadlineMs}ms: ${pending} request(s) still pending; their bodies will be missing`,
    );
  }
  return { pending, ms: Date.now() - started };
}

export async function har(client, url, opts, log) {
  const active = new Map(); // requestId -> current aggregate record
  const records = []; // one record per HAR entry; redirects reuse requestId but get their own entry

  client.Network.requestWillBeSent((p) => {
    let rec = active.get(p.requestId);
    if (rec && p.redirectResponse) {
      // CDP reuses requestId across a redirect chain. Preserve the completed
      // redirect response as its own HAR entry before starting the next request.
      rec.response = p.redirectResponse;
      rec.endTs = p.timestamp;
      rec.encodedDataLength = p.redirectResponse.encodedDataLength;
      rec.redirectedTo = p.request.url;
      rec = null;
    }

    if (!rec) {
      rec = { requestId: p.requestId };
      records.push(rec);
      active.set(p.requestId, rec);
    }

    rec.request = p.request;
    rec.wallTime = p.wallTime;
    rec.startTs = p.timestamp;
    rec.initiator = p.initiator;
    rec.type = p.type;
    // Priority: capture the INITIAL priority off the request now; a later
    // Network.resourceChangedPriority may upgrade/downgrade it (final wins).
    rec.initialPriority = rec.initialPriority ?? p.request?.initialPriority;
    rec.finalPriority = rec.finalPriority ?? p.request?.initialPriority;
    // renderBlockingStatus: Chrome exposes this on request.renderBlockingStatus
    // (blocking | non_blocking | in_body_parser_blocking | dynamically_inserted_*)
    // in some builds. Capture it only when present; never fabricate it.
    if (p.request?.renderBlockingStatus != null) {
      rec.renderBlockingStatus = p.request.renderBlockingStatus;
    }
    if (p.redirectResponse) rec.redirectResponse = p.redirectResponse;
  });
  // Network.resourceChangedPriority fires when the loader re-prioritises a
  // request after it was sent; the last value is the priority Chrome actually
  // scheduled with, so it overrides the initial priority for _priority.final.
  client.Network.resourceChangedPriority?.((p) => {
    const rec = active.get(p.requestId);
    if (rec && p.newPriority) rec.finalPriority = p.newPriority;
  });
  client.Network.responseReceived((p) => {
    const rec = active.get(p.requestId);
    if (rec) {
      rec.response = p.response;
      rec.type = p.type || rec.type;
      // Some builds also surface renderBlockingStatus on the response; prefer
      // the request-side value but fall back to the response-side one.
      if (rec.renderBlockingStatus == null && p.response?.renderBlockingStatus != null) {
        rec.renderBlockingStatus = p.response.renderBlockingStatus;
      }
    }
  });
  client.Network.loadingFinished((p) => {
    const rec = active.get(p.requestId);
    if (rec) {
      rec.endTs = p.timestamp;
      rec.encodedDataLength = p.encodedDataLength;
      rec.finished = true;
    }
  });
  client.Network.loadingFailed((p) => {
    const rec = active.get(p.requestId);
    if (rec) {
      rec.endTs = p.timestamp;
      rec.failed = p.errorText || 'failed';
      rec.canceled = p.canceled;
    }
  });

  // navigate() registers its load waiter BEFORE each navigation. The previous
  // hand-rolled form here registered the target waiter after
  // navigate('about:blank') + sleep(150), so under load about:blank's own load
  // event could still be pending at registration and resolve the waiter instead
  // of the target's, leaving the primitive waiting on nothing while the real page
  // was still fetching (web-uplift-e13: records stuck at response.status 0).
  const navStartedAt = Date.now();
  await navigate(client, url, {
    settleMs: 0,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  const loadWaitMs = Date.now() - navStartedAt;
  log(`[evidence] loaded ${url} after ${loadWaitMs}ms; recording network`);

  if (opts.interact) {
    try {
      await evaluate(client, opts.interact);
    } catch (err) {
      log(`[evidence] interact script error: ${err.message.split('\n')[0]}`);
    }
  }
  await sleep(opts.duration || opts.wait);

  // The observation window above is a minimum, not a verdict: settle the network
  // before snapshotting so a response that is merely late is still captured.
  const settle = await waitForNetworkIdle(records, NETWORK_IDLE_DEADLINE_MS, log);

  // Optionally fetch response bodies (base64 via the CDP string result).
  //
  // Each fetch is an independent, requestId-keyed round trip multiplexed over
  // the one CDP socket, so awaiting them one at a time is a pure N-deep
  // waterfall with no ordering benefit. Fetch them concurrently but bounded:
  // unbounded fan-out over a request-heavy page would queue every body on the
  // socket and hold them all in memory at once, which is worse on a 2-vCPU box
  // than the waterfall it replaces. The per-record try/catch and the in-place
  // rec.body assignment keep HAR assembly unchanged.
  if (opts.bodies) {
    const retrievable = records.filter((rec) => rec.response && !rec.failed && !rec.redirectedTo);
    await mapBounded(retrievable, BODY_FETCH_CONCURRENCY, async (rec) => {
      try {
        const body = await client.Network.getResponseBody({ requestId: rec.requestId });
        rec.body = body; // { body: string, base64Encoded: bool }
      } catch {
        // Some bodies (e.g. redirects, data: URIs) are not retrievable.
      }
    });
  }

  const har12 = buildHar(records, log, { redactCredentials: opts.redactHeaders !== false });
  const out = opts.out || derivedOut(url, 'network', 'har');
  writeFileSync(out, JSON.stringify(har12, null, 2) + '\n');

  // Mirror trace: write a compact, model-readable summary next to the raw .har
  // (network-summary.json). The model reads the summary; the raw .har stays on
  // disk for the report, the compare command, and DevTools/HAR viewers.
  const summary = summariseHar(har12, url, log, { redactCredentials: opts.redactHeaders !== false });
  const summaryOut = out.replace(/\.har$/, '') + '-summary.json';
  writeFileSync(summaryOut, JSON.stringify(summary, null, 2) + '\n');

  return {
    artifact: out,
    summaryArtifact: summaryOut,
    loadWaitMs,
    networkSettleMs: settle.ms,
    networkPendingAtSnapshot: settle.pending,
    ...summary.totals,
    statusBreakdown: tallyStatuses(har12.log.entries),
    note:
      'Valid HAR 1.2 log of the network over the load. The raw .har opens in DevTools Network import and is the basis for cross-run network deltas; read the companion *-summary.json for the compact, model-readable network signals (read the summary, never the raw HAR).' +
      ' Credential redaction, by default, controlled by ONE flag (--no-redact-headers keeps everything raw and accepts the publication risk). There are TWO paths, and they are not equally strong:' +
      ' STRUCTURED INPUTS - parsed, so this part holds BY CONSTRUCTION: credential-named HEADERS (Set-Cookie, Cookie, Authorization, Proxy-Authorization, X-Auth-Token, X-Api-Key, X-Amz-Security-Token) by name; request URLs and each entry\'s queryString, parsed as URLs; JSON bodies, parsed and redacted by DECODED KEY, which is what covers array values, nested values and unicode-escaped keys such as "tok\\u0065n" (a redacted JSON body keeps every byte of the original EXCEPT the replaced value spans, so its formatting is preserved exactly); the REDIRECT TARGET, absolute or relative, parsed as a URL; URL-VALUED HEADERS including the Referer; and the INITIATOR fields (the inserting document and the JS call-frame URL).' +
      ' Names are matched as whole words after splitting on separators AND camelCase, so accessToken, refreshToken, apiKey and clientSecret are recognised along with the separator-delimited spellings.' +
      ' UNSTRUCTURED TEXT - a Heuristic, NOT a guarantee: recorded bodies that are not parseable JSON (an inline script, an HTML document) go through a text scanner that covers `name=value`, `name: value`, quoted keys, and quoted values including escapes and line continuations. It cannot enumerate every syntax an arbitrary script can use, so treat a non-JSON recorded body as sensitive and read the structured fields above for the claims that hold by construction.' +
      ' STILL NOT covered, stated so nobody assumes blanket protection: (1) base64-encoded bodies, which are not text-searchable and whose credential remains recoverable by decoding; (2) a credential whose field, parameter or header NAME does not look like one - the test is names-based because the tool cannot know which value in an arbitrary body is a secret, and it deliberately errs towards over-redacting ambiguous names (`code`, `key`, or a sort-key name all redact); (3) WIRE LENGTHS - request body size is recomputed from the redacted text, but response bodySize and _transferSize are measurements of the ORIGINAL bytes, so for an uncompressed response the length of a redacted value can still be inferred. Treat a HAR as sensitive whenever the audited site handled credentials.' +
      (settle.pending > 0
        ? ` WARNING: ${settle.pending} request(s) were still pending when the network was snapshotted (load waited ${loadWaitMs}ms, settle waited ${settle.ms}ms); their bodies and statuses are missing from this HAR, which is a harness/load artifact rather than absence.`
        : ''),
  };
}

function tallyStatuses(entries) {
  const out = {};
  for (const e of entries) {
    const k = String(e.response.status || 0);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// Reduce a HAR 1.2 log to the compact network SIGNALS a model needs, the network
// analogue of summariseTrace / summariseHeapSnapshot (and the in-repo, lightweight
// analogue of memlab: it surfaces descriptive signals, NOT pass/fail verdicts; the
// model judges them against the principles). Every list is capped (~10) so the
// summary stays small and the model never has to load the raw multi-MB HAR.
function summariseHar(har, mainUrl, log, { redactCredentials = true } = {}) {
  // Same flag, same names-based test as buildHar: the model-readable summary repeats
  // request URLs and the redirect target, so it must not re-leak what the HAR redacted.
  const rurl = (u) => (redactCredentials ? redactUrlCredentialValues(u) : u);
  const entries = (har?.log?.entries ?? []).filter((e) => e && e.request);

  // The main document is the first 'document' entry (or the first entry, or the
  // requested URL). Its origin defines first vs third party.
  const typeOf = (e) => String(e?._resourceType || '').toLowerCase();
  const docEntry =
    entries.find((e) => typeOf(e) === 'document') || entries[0] || null;
  const mainOrigin = originOf(docEntry?.request?.url || mainUrl);

  // CDP Network.ResourceType values are capitalised (Document, Script,
  // Stylesheet, Image, Font, XHR, Fetch, Media, ...); normalise to lower case.
  const TYPE_BUCKETS = {
    document: 'document',
    script: 'script',
    stylesheet: 'stylesheet',
    image: 'image',
    font: 'font',
    fetch: 'xhr-fetch',
    xhr: 'xhr-fetch',
    media: 'media',
  };
  const bucketFor = (type) => TYPE_BUCKETS[String(type || '').toLowerCase()] || 'other';

  let totalTransferredBytes = 0;
  let totalContentBytes = 0;
  const byType = {}; // bucket -> { count, transferredBytes, contentBytes }
  const byOrigin = new Map(); // origin -> { count, transferredBytes, thirdParty }

  const bySize = []; // weight offenders
  const bySlow = []; // slowest
  const renderBlockingCandidates = [];
  const uncompressed = [];
  const missingCache = [];
  const redirects = [];
  const httpErrors = [];

  const sorted = [...entries].sort(
    (a, b) => startedMs(a) - startedMs(b),
  );

  for (const e of entries) {
    const type = e._resourceType || 'other';
    const bucket = bucketFor(type);
    const res = e.response || {};
    const transferred = num(res._transferSize) || num(res.bodySize) || 0;
    const content = num(res.content?.size) || 0;
    totalTransferredBytes += transferred;
    totalContentBytes += content;

    const t = (byType[bucket] = byType[bucket] || {
      count: 0,
      transferredBytes: 0,
      contentBytes: 0,
    });
    t.count++;
    t.transferredBytes += transferred;
    t.contentBytes += content;

    const origin = originOf(e.request.url);
    const isThird = origin !== mainOrigin && origin !== 'unknown';
    const o = byOrigin.get(origin) || {
      origin,
      count: 0,
      transferredBytes: 0,
      thirdParty: isThird,
    };
    o.count++;
    o.transferredBytes += transferred;
    byOrigin.set(origin, o);

    bySize.push({ url: rurl(e.request.url), type: bucket, transferredBytes: transferred });
    if (typeof e.time === 'number' && e.time >= 0) {
      bySlow.push({ url: rurl(e.request.url), type: bucket, timeMs: round(e.time) });
    }

    // Hygiene: text resources served without compression over a size threshold.
    const headers = headerMap(res.headers);
    const enc = headers['content-encoding'] || '';
    const compressed = /\b(gzip|br|deflate|zstd)\b/i.test(enc);
    const isText =
      bucket === 'script' ||
      bucket === 'stylesheet' ||
      bucket === 'document' ||
      bucket === 'xhr-fetch' ||
      /\b(text|json|javascript|xml|svg)\b/i.test(res.content?.mimeType || '');
    if (isText && !compressed && transferred >= 2048) {
      uncompressed.push({
        url: rurl(e.request.url),
        type: bucket,
        transferredBytes: transferred,
        contentEncoding: enc || 'none',
      });
    }

    // The redirect target IS a diagnostic signal, and a Location can carry a credential
    // in its query string - which is exactly why it now goes through the URL redaction
    // (web-uplift-dsj). The residual, stated where it belongs, is that a credential whose
    // NAME does not look like one is not detected.
    // Hygiene: cacheable responses missing cache-control AND expires. Skip
    // redirects/errors and non-200s where caching is not the relevant signal.
    const status = num(res.status) || 0;
    if (status >= 200 && status < 300) {
      const cc = headers['cache-control'];
      const exp = headers['expires'];
      if (!cc && !exp && (bucket === 'script' || bucket === 'stylesheet' || bucket === 'image' || bucket === 'font')) {
        missingCache.push({ url: rurl(e.request.url), type: bucket, transferredBytes: transferred });
      }
    }

    // Hygiene: redirect chains (3xx) and HTTP errors (4xx/5xx).
    if (status >= 300 && status < 400) {
      redirects.push({
        url: rurl(e.request.url),
        status,
        location: rurl(headers['location'] || res.redirectURL || ''),
      });
    } else if (status >= 400) {
      httpErrors.push({ url: rurl(e.request.url), status, type: bucket });
    }
    if (res._error) {
      httpErrors.push({ url: rurl(e.request.url), status: 0, type: bucket, error: res._error });
    }
  }

  // Render-blocking candidates, GROUNDED in the real CDP signals we now capture
  // (initiator + priority + renderBlockingStatus where the build exposes it),
  // not in load order. A request is a strong candidate when:
  //   - CDP says so outright: _renderBlockingStatus === 'blocking', OR
  //   - it is a parser-inserted stylesheet (classic <link rel=stylesheet>), OR
  //   - it is a parser-inserted script (classic <script src> in the markup),
  // and we raise confidence when the request also carries a high/blocking
  // priority. Each candidate states its basis. This is the STARTING signal: the
  // model confirms/refines it against the live DOM (async/defer/type=module and
  // <head> placement are read with the dom/evaluate primitives).
  const HIGH_PRIORITY = new Set(['VeryHigh', 'High']);
  const ranked = [];
  for (const e of sorted) {
    const type = typeOf(e);
    if (type !== 'script' && type !== 'stylesheet') continue;
    const init = e._initiator || {};
    const initType = String(init.type || 'other');
    const priority = e._priority?.final || e._priority?.initial || null;
    const rbStatus = e._renderBlockingStatus || null; // present only if CDP gave it
    const highPriority = priority ? HIGH_PRIORITY.has(priority) : false;

    const cdpBlocking = rbStatus === 'blocking';
    const parserStylesheet = type === 'stylesheet' && initType === 'parser';
    const parserScript = type === 'script' && initType === 'parser';
    const isCandidate = cdpBlocking || parserStylesheet || parserScript;
    if (!isCandidate) continue;

    // Build a human-readable basis and a numeric score for ranking.
    const reasons = [];
    let score = 0;
    if (cdpBlocking) {
      reasons.push('CDP renderBlockingStatus=blocking');
      score += 100;
    }
    if (parserStylesheet) {
      reasons.push('parser-inserted stylesheet');
      score += 40;
    }
    if (parserScript) {
      // A parser-inserted module script is deferred by spec; the DOM confirms
      // async/defer/type=module, so we flag it but rank it below classic scripts.
      reasons.push('parser-inserted script (confirm async/defer/type=module via DOM)');
      score += 25;
    }
    if (priority) {
      reasons.push(`${priority} priority`);
      if (highPriority) score += 15;
    }
    ranked.push({
      url: e.request.url,
      type: bucketFor(type),
      initiator: init,
      priority,
      ...(rbStatus ? { renderBlockingStatus: rbStatus } : {}),
      basis: reasons.join(', '),
      startedDateTime: e.startedDateTime,
      _score: score,
    });
  }
  ranked.sort((a, b) => b._score - a._score);
  for (const c of ranked) {
    delete c._score;
    renderBlockingCandidates.push(c);
  }

  const topBySize = bySize
    .sort((a, b) => b.transferredBytes - a.transferredBytes)
    .slice(0, 10);
  const topBySlow = bySlow.sort((a, b) => b.timeMs - a.timeMs).slice(0, 10);
  const origins = [...byOrigin.values()].sort(
    (a, b) => b.transferredBytes - a.transferredBytes,
  );
  const thirdPartyOrigins = origins.filter((o) => o.thirdParty);
  const thirdPartyBytes = thirdPartyOrigins.reduce(
    (acc, o) => acc + o.transferredBytes,
    0,
  );
  const thirdPartyCount = thirdPartyOrigins.reduce((acc, o) => acc + o.count, 0);

  const topOrigins = origins.slice(0, 10);
  const topBlocking = renderBlockingCandidates.slice(0, 10);
  const topUncompressed = uncompressed
    .sort((a, b) => b.transferredBytes - a.transferredBytes)
    .slice(0, 10);
  const topMissingCache = missingCache
    .sort((a, b) => b.transferredBytes - a.transferredBytes)
    .slice(0, 10);
  const topRedirects = redirects.slice(0, 10);
  const topHttpErrors = httpErrors.slice(0, 10);
  for (const [name, shown, total] of [
    ['topOriginsByBytes', topOrigins.length, origins.length],
    ['renderBlockingCandidates', topBlocking.length, renderBlockingCandidates.length],
    ['largestByBytes', topBySize.length, bySize.length],
    ['slowestByTime', topBySlow.length, bySlow.length],
    ['uncompressedTextOver2KB', topUncompressed.length, uncompressed.length],
    ['missingCacheHeaders', topMissingCache.length, missingCache.length],
    ['redirects', topRedirects.length, redirects.length],
    ['httpErrors', topHttpErrors.length, httpErrors.length],
  ]) {
    announceCap(`har.${name}`, shown, total, log);
  }

  return {
    totals: {
      requestCount: entries.length,
      totalTransferredBytes,
      totalContentBytes,
      byResourceType: byType,
    },
    thirdParty: {
      mainOrigin,
      thirdPartyRequestCount: thirdPartyCount,
      thirdPartyTransferredBytes: thirdPartyBytes,
      topOriginsByBytes: topOrigins.map((o) => ({
        origin: o.origin,
        party: o.thirdParty ? 'third-party' : 'first-party',
        count: o.count,
        transferredBytes: o.transferredBytes,
      })),
      topOriginsByBytesTotal: origins.length,
      topOriginsByBytesTruncated: origins.length > 10,
    },
    renderBlockingCandidates: topBlocking,
    renderBlockingCandidatesTotal: renderBlockingCandidates.length,
    renderBlockingCandidatesTruncated: renderBlockingCandidates.length > 10,
    weightOffenders: {
      largestByBytes: topBySize,
      largestByBytesTotal: bySize.length,
      largestByBytesTruncated: bySize.length > 10,
      slowestByTime: topBySlow,
      slowestByTimeTotal: bySlow.length,
      slowestByTimeTruncated: bySlow.length > 10,
    },
    hygiene: {
      uncompressedTextOver2KB: topUncompressed,
      uncompressedTextOver2KBTotal: uncompressed.length,
      uncompressedTextOver2KBTruncated: uncompressed.length > 10,
      missingCacheHeaders: topMissingCache,
      missingCacheHeadersTotal: missingCache.length,
      missingCacheHeadersTruncated: missingCache.length > 10,
      redirects: topRedirects,
      redirectsTotal: redirects.length,
      redirectsTruncated: redirects.length > 10,
      httpErrors: topHttpErrors,
      httpErrorsTotal: httpErrors.length,
      httpErrorsTruncated: httpErrors.length > 10,
    },
    note:
      'Compact, model-readable summary of network SIGNALS distilled from a HAR 1.2 log (the network analogue of the trace/heap summaries; the in-repo, lightweight memlab analogue). These are DESCRIPTIVE signals, not pass/fail verdicts: the model judges them against the principles (be-fast-and-stable, be-sustainable, be-private-and-secure). renderBlockingCandidates is GROUNDED in the real CDP signals we capture per request: the rich initiator (_initiator.type parser|script|preload + the inserting document url/line, or the script call frame), the request _priority (initial + final, after Network.resourceChangedPriority), and _renderBlockingStatus WHEN this Chrome build exposes it (omitted when not). Each candidate states its basis. This is the STARTING signal, not the final word: the HAR alone is partial, so CONFIRM and refine each candidate against the live DOM - use the dom and evaluate primitives to read the actual <head> placement and the async / defer / type=module attributes on the real elements (e.g. a parser-inserted module script is deferred by spec and is NOT render-blocking). Read this summary, never the raw .har; the raw .har is retained for the report, cross-run compare, and DevTools/HAR viewers.',
  };
}

// Origin (scheme://host[:port]) of a URL, or 'unknown' for data:/blob:/invalid.
function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'data:' || u.protocol === 'blob:') return 'unknown';
    return u.origin;
  } catch {
    return 'unknown';
  }
}

function startedMs(entry) {
  const t = Date.parse(entry?.startedDateTime || '');
  return Number.isNaN(t) ? Infinity : t;
}

function num(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0;
}

// Normalise a CDP Network.Initiator into the compact, render-blocking-relevant
// shape we keep on the HAR entry. We keep the type (parser | script | preload |
// SignedExchange | preflight | other), plus the request's provenance: for
// parser-inserted requests, the document url + line that wrote the tag; for
// script-initiated requests, the top call frame (url + functionName). This is
// the real CDP signal render-blocking judgement is built on.
function harInitiator(init, { redactCredentials = false } = {}) {
  if (!init) return { type: 'other' };
  // The initiator records URLS: the inserting document, and the top JS call frame - which
  // is the page URL itself when a script on the page started the request. A credential in
  // that query string reached the artifact through this field, which the request-URL and
  // header redaction never touched.
  const rurl = (u) => (redactCredentials ? redactUrlCredentialValues(u) : u);
  const out = { type: init.type || 'other' };
  // Parser-inserted (and preload): the inserting document and source position.
  if (init.url) out.url = rurl(init.url);
  if (typeof init.lineNumber === 'number') out.lineNumber = init.lineNumber;
  // Script-initiated: surface the top call frame of the JS stack, if present.
  const top = init.stack?.callFrames?.[0];
  if (top) {
    out.callFrame = {
      url: rurl(top.url || ''),
      functionName: top.functionName || '',
      ...(typeof top.lineNumber === 'number' ? { lineNumber: top.lineNumber } : {}),
    };
  }
  return out;
}

// Assemble HAR 1.2 from the aggregated CDP network records. Timestamps from CDP
// are monotonic seconds (Network timestamp); we use wallTime for startedDateTime
// and the monotonic delta for the entry time. Timing detail comes from
// response.timing where present.
function buildHar(records, log, { redactCredentials = true } = {}) {
  const entries = [];
  for (const rec of records) {
    if (!rec.request) continue;
    const req = rec.request;
    const res = rec.response;
    const startedDateTime = rec.wallTime
      ? new Date(rec.wallTime * 1000).toISOString()
      : new Date().toISOString();
    const totalMs =
      rec.endTs != null && rec.startTs != null
        ? round((rec.endTs - rec.startTs) * 1000)
        : -1;

    const reqHeaders = redactCredentials ? redactHeaderList(headerArray(req.headers)) : headerArray(req.headers);
    // The residual dkx recorded: the URL, its query string, the request body, the
    // redirect target and response body text were all still verbatim. Redacted with
    // the same flag and the same names-based test, BEFORE anything downstream (the
    // entry, the summary) can copy them.
    const reqUrl = redactCredentials ? redactUrlCredentialValues(req.url) : req.url;
    const reqQuery = redactCredentials ? redactQueryList(queryString(req.url)) : queryString(req.url);
    const reqPostText = req.postData
      ? (redactCredentials ? redactBodyText(req.postData) : req.postData)
      : null;
    const resHeaders = redactCredentials ? redactHeaderList(headerArray(res?.headers)) : headerArray(res?.headers);
    const mimeType = res?.mimeType || 'x-unknown';
    const bodySize = rec.encodedDataLength != null ? Math.round(rec.encodedDataLength) : -1;

    let content = { size: res?.encodedDataLength ? Math.round(res.encodedDataLength) : 0, mimeType };
    if (rec.body) {
      if (rec.body.base64Encoded) {
        content.encoding = 'base64';
        content.text = rec.body.body;
        content.size = approxBase64DecodedSize(rec.body.body);
      } else {
        content.text = rec.body.body;
        content.size = byteLength(rec.body.body);
      }
    }

    if (redactCredentials && typeof content.text === 'string' && content.text) {
      const redactedText = redactBodyText(content.text);
      if (redactedText !== content.text) {
        content = { ...content, text: redactedText, size: byteLength(redactedText) };
      }
    }

    const timings = harTimings(res?.timing, totalMs);

    entries.push({
      startedDateTime,
      time: totalMs < 0 ? 0 : totalMs,
      request: {
        method: req.method,
        url: reqUrl,
        httpVersion: res?.protocol || 'HTTP/1.1',
        headers: reqHeaders,
        queryString: reqQuery,
        cookies: [],
        headersSize: -1,
        // The size is taken from the REDACTED text, so it describes what the artifact
        // actually carries instead of leaking the original secret's length.
        bodySize: reqPostText ? byteLength(reqPostText) : 0,
        ...(reqPostText
          ? { postData: { mimeType: headerMap(reqHeaders)['content-type'] || '', text: reqPostText } }
          : {}),
      },
      response: {
        status: rec.failed ? 0 : res?.status || 0,
        statusText: rec.failed ? rec.failed : res?.statusText || '',
        httpVersion: res?.protocol || 'HTTP/1.1',
        headers: resHeaders,
        cookies: [],
        content,
        redirectURL: redactCredentials ? redactUrlCredentialValues(headerMap(resHeaders)['location'] || '') : (headerMap(resHeaders)['location'] || ''),
        headersSize: -1,
        bodySize,
        _transferSize: bodySize < 0 ? 0 : bodySize,
        ...(rec.failed ? { _error: rec.failed } : {}),
      },
      cache: {},
      timings,
      _resourceType: rec.type || 'other',
      // Rich initiator (not just the bare type) so render-blocking can be judged
      // from the real CDP signal: parser-inserted requests carry the inserting
      // document url + line; script-initiated requests carry the top call frame.
      _initiator: harInitiator(rec.initiator, { redactCredentials }),
      // Priority: initial (from request.initialPriority) and final (after any
      // Network.resourceChangedPriority). VeryLow|Low|Medium|High|VeryHigh.
      _priority: {
        initial: rec.initialPriority || null,
        final: rec.finalPriority || rec.initialPriority || null,
      },
      // renderBlockingStatus from CDP, ONLY when the build exposes it. If the
      // field is absent here, this Chrome did not report it (do not infer it);
      // render-blocking is then judged from initiator + priority + the DOM.
      ...(rec.renderBlockingStatus != null
        ? { _renderBlockingStatus: rec.renderBlockingStatus }
        : {}),
    });
  }
  log(`[evidence] HAR assembled: ${entries.length} entries`);
  return {
    log: {
      version: '1.2',
      creator: { name: 'web-uplift', version: '0.1.0' },
      pages: [],
      entries,
    },
  };
}

// CDP response.timing is in ms relative to requestTime (seconds). Convert to the
// HAR timing phases; missing detail collapses into wait/receive.
function harTimings(t, totalMs) {
  if (!t) {
    return { blocked: -1, dns: -1, connect: -1, send: 0, wait: totalMs < 0 ? 0 : totalMs, receive: 0, ssl: -1 };
  }
  const v = (x) => (x != null && x >= 0 ? x : -1);
  const dns = t.dnsStart >= 0 && t.dnsEnd >= 0 ? round(t.dnsEnd - t.dnsStart) : -1;
  const connect = t.connectStart >= 0 && t.connectEnd >= 0 ? round(t.connectEnd - t.connectStart) : -1;
  const ssl = t.sslStart >= 0 && t.sslEnd >= 0 ? round(t.sslEnd - t.sslStart) : -1;
  const send = t.sendStart >= 0 && t.sendEnd >= 0 ? round(t.sendEnd - t.sendStart) : 0;
  const wait = t.receiveHeadersEnd >= 0 && t.sendEnd >= 0 ? round(t.receiveHeadersEnd - t.sendEnd) : -1;
  const accounted = [dns, connect, send, wait].filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const receive = totalMs > 0 ? Math.max(0, round(totalMs - accounted)) : 0;
  return { blocked: -1, dns: v(dns), connect: v(connect), ssl: v(ssl), send, wait: v(wait), receive };
}

// Header names whose VALUES are credentials. A HAR written by an audit can carry
// a session cookie or bearer token lifted from the audited site, and this repo
// commits evidence-out artifacts to a public remote, so those values would be
// published irreversibly. The network primitive therefore redacts them BY DEFAULT
// in every HAR it writes, not only under --bodies: buildHar writes header lists
// unconditionally, so the exposure is broader than that flag suggests. The header
// NAME is kept, so its presence and count stay diagnosable (web-uplift-dxk).
