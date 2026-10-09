import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { applyConditions, announceCap, derivedOut, round } from '../common.mjs';
import { getNavigationDeadlineMs, withDeadline, sleep, evaluate } from '../cdp.mjs';

export async function trace(client, url, opts, log) {
  // The navigation below calls Page.navigate DIRECTLY rather than through navigate() because
  // the trace must start before navigationStart is captured; the bound is the same one
  // navigate() uses, read through the getter so the --cdp-deadline flag applies here too.
  const navDeadline = getNavigationDeadlineMs();
  // The category set DevTools itself records for a performance profile, so the
  // resulting trace.json loads in chrome://tracing and the DevTools Performance
  // panel. We keep the devtools.timeline + disabled-by-default-devtools.timeline
  // families that carry navigation, paint, long-task and main-thread events.
  const categories = [
    '-*',
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.stack',
    'disabled-by-default-v8.cpu_profiler',
    'v8.execute',
    'blink.user_timing',
    'loading',
    'latencyInfo',
    'toplevel',
    'rail',
  ];

  const events = [];
  const onData = (params) => {
    if (params.value) for (const e of params.value) events.push(e);
  };
  client.Tracing.dataCollected(onData);

  // Start tracing on a clean about:blank, then navigate so the whole load is in
  // the trace. navigate() already routes through about:blank, but we begin the
  // trace first so navigationStart is captured.
  await withDeadline(client.Page.navigate({ url: 'about:blank' }), navDeadline, `the about:blank navigation to be accepted (en route to ${url})`);
  await sleep(150);
  await withDeadline(applyConditions(client, opts, log), navDeadline, `the pre-trace condition setup (en route to ${url})`);

  await withDeadline(
    client.Tracing.start({
      categories: categories.join(','),
      transferMode: 'ReportEvents',
      options: 'sampling-frequency=10000',
    }),
    navDeadline,
    `the browser to start tracing (en route to ${url})`,
  );
  log('[evidence] tracing started; navigating');

  const loaded = client.Page.loadEventFired();
  await withDeadline(client.Page.navigate({ url }), navDeadline, `the navigation to ${url} to be accepted`);
  await withDeadline(loaded, navDeadline, `the load event for ${url}`);
  log(`[evidence] loaded ${url}`);

  if (opts.interact) {
    try {
      await withDeadline(evaluate(client, opts.interact), navDeadline, `the interact script on ${url}`);
    } catch (err) {
      log(`[evidence] interact script error: ${err.message.split('\n')[0]}`);
    }
  }
  await sleep(opts.wait);

  const done = new Promise((resolve) => client.Tracing.tracingComplete(resolve));
  await withDeadline(client.Tracing.end(), navDeadline, `the browser to end tracing for ${url}`);
  await withDeadline(done, navDeadline, `the trace to complete for ${url}`);
  log(`[evidence] tracing complete: ${events.length} events`);

  // The devtools-loadable artifact is the raw event array under { traceEvents }.
  const traceOut = opts.out || derivedOut(url, 'trace', 'json');
  writeFileSync(traceOut, JSON.stringify({ traceEvents: events }, null, 0) + '\n');

  const summary = summariseTrace(events);
  announceCap(
    'trace.mainThread.longTasks',
    summary.mainThread.longTasks.length,
    summary.mainThread.longTasksTotal,
    log,
  );
  const summaryOut = traceOut.replace(/\.json$/, '') + '-summary.json';
  writeFileSync(summaryOut, JSON.stringify(summary, null, 2) + '\n');

  return { artifact: traceOut, summaryArtifact: summaryOut, ...summary };
}

// Reduce a raw DevTools trace to the timings a model needs: navigationStart,
// First/Largest Contentful Paint (derived from the timeline markers), long
// tasks, total main-thread blocking time, and the trace window. We never hand
// the model the raw events.
function summariseTrace(events) {
  let navStartTs = null;
  let fcpTs = null;
  let lcpTs = null;
  let domContentLoadedTs = null;
  let loadTs = null;
  let minTs = Infinity;
  let maxTs = -Infinity;
  const longTasks = [];

  for (const e of events) {
    // Only count real timeline timestamps. Metadata/global events carry ts 0 (or
    // a tiny value) which would otherwise blow up the trace-window calculation.
    if (typeof e.ts === 'number' && e.ts > 0) {
      if (e.ts < minTs) minTs = e.ts;
      if (e.ts > maxTs) maxTs = e.ts;
    }
    const name = e.name;
    if (name === 'navigationStart' && navStartTs === null) navStartTs = e.ts;
    else if (name === 'firstContentfulPaint' && fcpTs === null) fcpTs = e.ts;
    else if (
      // LCP candidate markers; keep the last (largest) one seen.
      name === 'largestContentfulPaint::Candidate' ||
      name === 'largestContentfulPaint::Main'
    ) {
      lcpTs = e.ts;
    } else if (name === 'domContentLoadedEventEnd' && domContentLoadedTs === null) {
      domContentLoadedTs = e.ts;
    } else if (name === 'loadEventEnd' && loadTs === null) {
      loadTs = e.ts;
    } else if (name === 'RunTask' && e.ph === 'X' && typeof e.dur === 'number') {
      // RunTask durations are microseconds; a long task is > 50ms.
      const ms = e.dur / 1000;
      if (ms >= 50) longTasks.push({ startMs: e.ts, durationMs: round(ms) });
    }
  }

  // navigationStart may not be emitted under every category combo; fall back to
  // the earliest event ts so the relative timings still make sense.
  const base = navStartTs ?? (minTs === Infinity ? null : minTs);
  const rel = (ts) => (base != null && ts != null ? round((ts - base) / 1000) : null);

  const totalBlockingMs = longTasks.reduce((acc, t) => acc + Math.max(0, t.durationMs - 50), 0);

  return {
    timings: {
      navigationStartMs: 0,
      firstContentfulPaintMs: rel(fcpTs),
      largestContentfulPaintMs: rel(lcpTs),
      domContentLoadedMs: rel(domContentLoadedTs),
      loadEventEndMs: rel(loadTs),
      traceDurationMs: minTs === Infinity ? null : round((maxTs - minTs) / 1000),
    },
    mainThread: {
      longTaskCount: longTasks.length,
      longestTaskMs: longTasks.reduce((m, t) => Math.max(m, t.durationMs), 0),
      totalBlockingTimeMs: round(totalBlockingMs),
      longTasks: longTasks
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 25)
        .map((t) => ({ durationMs: t.durationMs, startMs: rel(t.startMs) })),
      longTasksTotal: longTasks.length,
      longTasksTruncated: longTasks.length > 25,
    },
    eventCount: events.length,
    note: 'Compact summary of a DevTools performance trace. Timings are ms from navigationStart (or the first trace event if navigationStart was not recorded). totalBlockingTimeMs sums per-long-task time over 50ms. The raw trace.json artifact loads in the DevTools Performance panel / chrome://tracing.',
  };
}

// Maximum in-flight Network.getResponseBody calls for --bodies. The calls share
// one CDP socket, so a small pool hides nearly all of the per-call latency while
// keeping the socket and the peak body memory bounded (see the har body-fetch
// loop).
