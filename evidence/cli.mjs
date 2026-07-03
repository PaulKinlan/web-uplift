#!/usr/bin/env node
// web-uplift evidence primitives: a GENERIC, tool-agnostic, content-agnostic
// library the MODEL calls AT INSPECTION TIME to gather evidence about a page.
//
//   node evidence/cli.mjs <primitive> <url> [options]
//
// These primitives make NO judgements. They do not know about principles,
// checks, severities, or what "good" looks like. They return raw data and
// artifacts (JSON, PNG, MP4, heap summaries). The intelligence lives entirely in
// the model following .claude/skills/web-audit/SKILL.md: the model decides which
// primitives to run, under which emulated conditions, what probes to evaluate in
// the page, and how to reason over the results. There are no hard-coded checks
// and no fast paths anywhere in this file.
//
// Everything is raw Chrome DevTools Protocol via chrome-remote-interface against
// the system google-chrome-stable. ffmpeg (system binary) assembles screencast
// frames into a video. No Playwright, no Puppeteer.
//
// Primitives (subcommands):
//   screenshot <url>     Page.captureScreenshot -> PNG
//   video <url>          Page.startScreencast frames -> MP4 (records an interaction
//                        window; --interact runs model-supplied JS to trigger it)
//   heap <url>           HeapProfiler.takeHeapSnapshot -> a readable summary
//                        (the model never reads the raw multi-MB snapshot)
//   layout <url>         Page.getLayoutMetrics + layout-shift (CLS) + long tasks
//   dom <url>            DOM tree, computed styles for a selector set, page HTML/CSS,
//                        and (with --source <dir>) the local source files
//   evaluate <url>       Runtime.evaluate of a model-supplied expression
//                        (--expr "<js>" or --expr-file <path>); the model's
//                        ad-hoc-probe / on-the-fly static-test escape hatch
//   trace <url>          Tracing.start/end over the load (+ optional --interact)
//                        -> a devtools-loadable trace.json AND a compact
//                        *-summary.json (FCP/LCP, long tasks, total blocking
//                        time); the model reads the summary, never the raw trace
//   har <url>            Network domain capture over the load (+ optional
//                        --interact / --duration; --bodies to include response
//                        bodies) assembled into a valid HAR 1.2 file AND a compact
//                        *-summary.json of network signals (totals, third parties,
//                        render-blocking candidates, weight offenders, hygiene);
//                        the model reads the summary, never the raw HAR
//   discoverability <url> fetches the RAW server HTML (no JS) and diffs it against
//                        the rendered DOM: coveragePct (rendered content words
//                        present in the raw HTML), isJsShell, empty SPA mounts,
//                        title/h1/meta survival. The url-influence "invisible to
//                        non-JS crawlers" failure mode, per-site. Feeds
//                        be-discoverable / be-agent-ready
//
// Common options (most primitives accept these so the model can set the
// condition it wants to observe under, but the harness never decides them):
//   --out <path>            Where to write the artifact / JSON (default: stdout/derived)
//   --emulate-media k=v,..  Emulated media features, e.g.
//                           prefers-color-scheme=dark,prefers-reduced-motion=reduce
//   --viewport WxH          Device-metrics override, e.g. 360x800 (mobile)
//   --wait <ms>             Settle time after load before measuring (default 1000)
//   --selector <css>        Element(s) of interest (dom/screenshot/layout)
//   --quiet                 Less logging

import {
  writeFileSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { launchChrome, newSession, navigate, evaluate, sleep } from './cdp.mjs';

// --- generic CDP condition helpers (NOT checks) ----------------------------

async function applyConditions(client, opts, log) {
  if (opts.emulateMedia && opts.emulateMedia.length) {
    await client.Emulation.setEmulatedMedia({ features: opts.emulateMedia });
    log(
      `[evidence] emulated media: ${opts.emulateMedia
        .map((f) => `${f.name}=${f.value}`)
        .join(', ')}`,
    );
  }
  if (opts.viewport) {
    const { w, h } = opts.viewport;
    await client.Emulation.setDeviceMetricsOverride({
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: w,
      screenHeight: h,
    });
    log(`[evidence] viewport: ${w}x${h} (mobile)`);
  }
}

// --- primitives ------------------------------------------------------------

// screenshot: Page.captureScreenshot. Optionally clip to a selector's box.
async function screenshot(client, url, opts, log) {
  await navigate(client, url, {
    settleMs: opts.wait,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  await sleep(250);

  let clip;
  if (opts.selector) {
    const box = await evaluate(
      client,
      `(() => {
        const el = document.querySelector(${JSON.stringify(opts.selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`,
    );
    if (box && box.width > 0 && box.height > 0) {
      clip = { ...box, scale: 1 };
    }
  }

  const { data } = await client.Page.captureScreenshot({
    format: 'png',
    captureBeyondViewport: !!opts.fullPage,
    ...(clip ? { clip } : {}),
  });
  const out = opts.out || derivedOut(url, 'screenshot', 'png');
  writeFileSync(out, uint8FromBase64(data));
  return { artifact: out, bytes: data.length, clip: clip || 'full viewport' };
}

// video: record a screencast over an interaction window, assemble with ffmpeg.
// --interact <js> (or --interact-file) is model-supplied code run after capture
// starts, so the model can trigger the transition/animation it wants to record.
async function video(client, url, opts, log) {
  await navigate(client, url, {
    settleMs: opts.wait,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });

  const frameDir = mkdtempSync(join(tmpdir(), 'web-uplift-frames-'));
  const frames = [];
  let frameIndex = 0;

  client.Page.screencastFrame(async (params) => {
    const idx = String(frameIndex++).padStart(5, '0');
    const file = join(frameDir, `frame-${idx}.png`);
    writeFileSync(file, uint8FromBase64(params.data));
    frames.push({ file, ts: params.metadata.timestamp });
    try {
      await client.Page.screencastFrameAck({ sessionId: params.sessionId });
    } catch {
      // session may already be stopping
    }
  });

  const durationMs = opts.duration || 3000;
  await client.Page.startScreencast({
    format: 'png',
    everyNthFrame: 1,
    maxWidth: 1280,
    maxHeight: 800,
  });
  log(`[evidence] recording screencast for ${durationMs}ms`);

  // Run the model-supplied interaction (e.g. navigate a route, open a dialog,
  // dispatch events) so the recorded window captures the transition.
  if (opts.interact) {
    try {
      await evaluate(client, opts.interact);
    } catch (err) {
      log(`[evidence] interact script error: ${err.message.split('\n')[0]}`);
    }
  }

  await sleep(durationMs);
  await client.Page.stopScreencast();
  await sleep(100);

  const out = opts.out || derivedOut(url, 'transition', 'mp4');
  const fps = opts.fps || 10;
  let assembled = false;
  let ffmpegNote = '';
  if (frames.length > 0) {
    const res = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-framerate',
        String(fps),
        '-pattern_type',
        'glob',
        '-i',
        join(frameDir, 'frame-*.png'),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-vf',
        'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        out,
      ],
      { encoding: 'utf8' },
    );
    assembled = res.status === 0 && existsSync(out);
    if (!assembled) ffmpegNote = (res.stderr || res.error?.message || '').slice(-400);
  }
  rmSync(frameDir, { recursive: true, force: true });
  return {
    artifact: assembled ? out : null,
    frames: frames.length,
    fps,
    durationMs,
    note: assembled
      ? `MP4 assembled from ${frames.length} screencast frames`
      : `screencast captured ${frames.length} frames but ffmpeg did not produce a file: ${ffmpegNote}`,
  };
}

// heap: HeapProfiler.takeHeapSnapshot, summarised into something readable. We do
// NOT hand the model the raw multi-MB snapshot; we stream it, parse the node
// table, and return aggregate counts by constructor/type plus totals.
async function heap(client, url, opts, log) {
  await navigate(client, url, {
    settleMs: opts.wait,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });

  // Optionally let the model exercise the page first (e.g. open/close a dialog
  // N times) so retained growth shows up.
  if (opts.interact) {
    try {
      await evaluate(client, opts.interact);
    } catch (err) {
      log(`[evidence] interact script error: ${err.message.split('\n')[0]}`);
    }
    await sleep(opts.wait);
  }

  await client.HeapProfiler.enable();
  const chunks = [];
  const onChunk = (p) => chunks.push(p.chunk);
  client.HeapProfiler.addHeapSnapshotChunk(onChunk);
  await client.HeapProfiler.collectGarbage();
  log('[evidence] taking heap snapshot');
  await client.HeapProfiler.takeHeapSnapshot({ reportProgress: false });

  const raw = chunks.join('');
  const summary = summariseHeapSnapshot(raw);
  const out = opts.out || derivedOut(url, 'heap-summary', 'json');
  writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
  return { artifact: out, ...summary.totals };
}

// Parse a V8 .heapsnapshot JSON into a model-readable summary: total node/edge
// counts, total retained size, and the top node types/constructors by count and
// by self size. The model reads this, never the raw snapshot.
function summariseHeapSnapshot(raw) {
  const snap = JSON.parse(raw);
  const meta = snap.snapshot.meta;
  const nodeFields = meta.node_fields;
  const nodeTypes = meta.node_types[nodeFields.indexOf('type')];
  const fieldCount = nodeFields.length;
  const nodes = snap.nodes;
  const strings = snap.strings;

  const typeIdx = nodeFields.indexOf('type');
  const nameIdx = nodeFields.indexOf('name');
  const sizeIdx = nodeFields.indexOf('self_size');

  const byType = new Map();
  const byName = new Map();
  let totalSelfSize = 0;
  const nodeCount = nodes.length / fieldCount;

  for (let i = 0; i < nodes.length; i += fieldCount) {
    const typeName = nodeTypes[nodes[i + typeIdx]] ?? 'unknown';
    const selfSize = nodes[i + sizeIdx];
    const name = strings[nodes[i + nameIdx]] ?? '';
    totalSelfSize += selfSize;

    const t = byType.get(typeName) || { count: 0, size: 0 };
    t.count++;
    t.size += selfSize;
    byType.set(typeName, t);

    // Group object instances by constructor name for leak-hunting signal.
    if (typeName === 'object' && name) {
      const n = byName.get(name) || { count: 0, size: 0 };
      n.count++;
      n.size += selfSize;
      byName.set(name, n);
    }
  }

  const topN = (map, n) =>
    [...map.entries()]
      .map(([k, v]) => ({ name: k, count: v.count, selfSize: v.size }))
      .sort((a, b) => b.selfSize - a.selfSize)
      .slice(0, n);

  return {
    totals: {
      nodeCount,
      edgeCount: snap.edges.length / meta.edge_fields.length,
      totalSelfSizeBytes: totalSelfSize,
    },
    topNodeTypesBySize: topN(byType, 15),
    topConstructorsBySize: topN(byName, 25),
    note:
      'Summary of a V8 heap snapshot. Compare two snapshots (e.g. before vs after repeated interaction) to spot retained growth; a single snapshot shows the current object population by type and constructor.',
  };
}

// layout: Page.getLayoutMetrics + a layout-shift (CLS) observer + a long-task
// observer. Generic timing/stability evidence; the model decides what it means.
async function layout(client, url, opts, log) {
  // Install observers BEFORE navigation completes settling so buffered entries
  // (and late shifts) are captured.
  await navigate(client, url, {
    settleMs: 0,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  await client.Runtime.evaluate({
    expression: `
      window.__cls = 0;
      window.__shifts = [];
      window.__longTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (!e.hadRecentInput) {
              window.__cls += e.value;
              window.__shifts.push({ value: e.value, startTime: e.startTime });
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__longTasks.push({ duration: e.duration, startTime: e.startTime });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {}
    `,
  });

  // If the model wants to exercise an interaction (e.g. trigger late content),
  // let it; otherwise just settle.
  if (opts.interact) {
    try {
      await evaluate(client, opts.interact);
    } catch (err) {
      log(`[evidence] interact script error: ${err.message.split('\n')[0]}`);
    }
  }
  await sleep(opts.wait);

  const metrics = await client.Page.getLayoutMetrics();
  const observed = await evaluate(
    client,
    // Under a device-metrics override (headless), the layout viewport that
    // matters for overflow is the VISUAL viewport (window.innerWidth can lag
    // the override and report the underlying window width). We reference
    // visualViewport.width so overflow at an emulated mobile size is measured
    // against the size the page is actually being rendered at.
    `(() => {
      const ref = (window.visualViewport && window.visualViewport.width) || window.innerWidth;
      return {
        cls: window.__cls || 0,
        shifts: (window.__shifts || []).slice(0, 50),
        longTasks: (window.__longTasks || []).slice(0, 50),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        visualViewportWidth: (window.visualViewport && window.visualViewport.width) || null,
        hasViewportMeta: !!document.querySelector('meta[name="viewport"]'),
        horizontalOverflowPx: Math.max(0, Math.round(document.documentElement.scrollWidth - ref))
      };
    })()`,
  );

  const result = {
    layoutViewport: metrics.layoutViewport,
    visualViewport: metrics.visualViewport,
    cssContentSize: metrics.cssContentSize,
    observed,
  };
  if (opts.out) writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
  return result;
}

// dom: serialise the DOM, computed styles for a set of selectors, the page's
// outer HTML and collected CSS text, and (with --source) the local source tree.
async function dom(client, url, opts, log) {
  await navigate(client, url, {
    settleMs: opts.wait,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  await sleep(150);

  const selectors = opts.selector
    ? opts.selector.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const page = await evaluate(
    client,
    `(() => {
      const collectCss = () => {
        let css = '';
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch { continue; }
          if (!rules) continue;
          for (const rule of rules) css += rule.cssText + '\\n';
        }
        return css;
      };
      const computedFor = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const want = ['display','position','width','height','max-width','min-height',
          'flex-direction','color','background-color','color-scheme','outline','outline-width',
          'outline-style','animation-name','animation-duration','container-type','overflow',
          'box-sizing','font-size'];
        const out = {};
        for (const p of want) out[p] = cs.getPropertyValue(p);
        const r = el.getBoundingClientRect();
        out['__rect'] = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        return out;
      };
      const sels = ${JSON.stringify(selectors)};
      const computed = {};
      for (const s of sels) computed[s] = computedFor(s);
      return {
        title: document.title,
        url: location.href,
        lang: document.documentElement.lang || null,
        hasViewportMeta: !!document.querySelector('meta[name=viewport]'),
        outerHTML: document.documentElement.outerHTML.slice(0, 200000),
        css: collectCss().slice(0, 200000),
        computed
      };
    })()`,
  );

  const result = { page };

  if (opts.source) {
    const srcDir = resolve(opts.source);
    result.source = readSourceTree(srcDir);
    log(`[evidence] read ${result.source.files.length} source file(s) from ${srcDir}`);
  }

  if (opts.out) writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
  return result;
}

// Read a local source tree (text files) so the model can reason over the actual
// authored HTML/CSS/JS, not just the rendered output. Skips node_modules, .git,
// binaries, and very large files.
function readSourceTree(dir, base = dir, acc = { files: [] }) {
  const SKIP = new Set(['node_modules', '.git', 'reports', 'scratch', 'examples']);
  const TEXT_EXT = /\.(html?|css|js|mjs|cjs|ts|tsx|jsx|json|svg|md|txt)$/i;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      readSourceTree(full, base, acc);
    } else if (TEXT_EXT.test(name) && st.size < 256 * 1024) {
      acc.files.push({
        path: relative(base, full),
        content: readFileSync(full, 'utf8'),
      });
    }
  }
  return acc;
}

// evaluate: run a model-supplied expression in the page. The model's escape
// hatch for ad-hoc probes and static tests it writes on the spot.
async function evaluateCmd(client, url, opts, log) {
  await navigate(client, url, {
    settleMs: opts.wait,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  await sleep(150);
  if (opts.interact) await evaluate(client, opts.interact);
  const expr = opts.expr;
  if (!expr) throw new Error('evaluate requires --expr "<js>" or --expr-file <path>');
  const value = await evaluate(client, expr);
  if (opts.out) writeFileSync(opts.out, JSON.stringify(value, null, 2) + '\n');
  return value;
}

// trace: record a DevTools performance trace via the Tracing domain over the
// load (and an optional --interact window), write a devtools-loadable trace.json
// AND a compact, model-readable summary (key timings, long tasks, blocking).
// The model reads the summary, never the multi-MB raw trace.
async function trace(client, url, opts, log) {
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
  await client.Page.navigate({ url: 'about:blank' });
  await sleep(150);
  await applyConditions(client, opts, log);

  await client.Tracing.start({
    categories: categories.join(','),
    transferMode: 'ReportEvents',
    options: 'sampling-frequency=10000',
  });
  log('[evidence] tracing started; navigating');

  const loaded = client.Page.loadEventFired();
  await client.Page.navigate({ url });
  await loaded;
  log(`[evidence] loaded ${url}`);

  if (opts.interact) {
    try {
      await evaluate(client, opts.interact);
    } catch (err) {
      log(`[evidence] interact script error: ${err.message.split('\n')[0]}`);
    }
  }
  await sleep(opts.wait);

  const done = new Promise((resolve) => client.Tracing.tracingComplete(resolve));
  await client.Tracing.end();
  await done;
  log(`[evidence] tracing complete: ${events.length} events`);

  // The devtools-loadable artifact is the raw event array under { traceEvents }.
  const traceOut = opts.out || derivedOut(url, 'trace', 'json');
  writeFileSync(traceOut, JSON.stringify({ traceEvents: events }, null, 0) + '\n');

  const summary = summariseTrace(events);
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
    },
    eventCount: events.length,
    note: 'Compact summary of a DevTools performance trace. Timings are ms from navigationStart (or the first trace event if navigationStart was not recorded). totalBlockingTimeMs sums per-long-task time over 50ms. The raw trace.json artifact loads in the DevTools Performance panel / chrome://tracing.',
  };
}

// har: record the network over the load (+ optional --interact / --duration)
// via the CDP Network domain and assemble a valid HAR 1.2 log. Network.enable is
// already on from newSession; we attach the lifecycle listeners, navigate, then
// build entries. Response bodies are fetched as base64 via Network.getResponseBody
// (CDP returns a string; no Node Buffer involved).
async function har(client, url, opts, log) {
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

  await client.Page.navigate({ url: 'about:blank' });
  await sleep(150);
  await applyConditions(client, opts, log);

  const loaded = client.Page.loadEventFired();
  await client.Page.navigate({ url });
  await loaded;
  log(`[evidence] loaded ${url}; recording network`);

  if (opts.interact) {
    try {
      await evaluate(client, opts.interact);
    } catch (err) {
      log(`[evidence] interact script error: ${err.message.split('\n')[0]}`);
    }
  }
  await sleep(opts.duration || opts.wait);

  // Optionally fetch response bodies (base64 via the CDP string result).
  if (opts.bodies) {
    for (const rec of records) {
      if (!rec.response || rec.failed || rec.redirectedTo) continue;
      try {
        const body = await client.Network.getResponseBody({ requestId: rec.requestId });
        rec.body = body; // { body: string, base64Encoded: bool }
      } catch {
        // Some bodies (e.g. redirects, data: URIs) are not retrievable.
      }
    }
  }

  const har12 = buildHar(records, log);
  const out = opts.out || derivedOut(url, 'network', 'har');
  writeFileSync(out, JSON.stringify(har12, null, 2) + '\n');

  // Mirror trace: write a compact, model-readable summary next to the raw .har
  // (network-summary.json). The model reads the summary; the raw .har stays on
  // disk for the report, the compare command, and DevTools/HAR viewers.
  const summary = summariseHar(har12, url);
  const summaryOut = out.replace(/\.har$/, '') + '-summary.json';
  writeFileSync(summaryOut, JSON.stringify(summary, null, 2) + '\n');

  return {
    artifact: out,
    summaryArtifact: summaryOut,
    ...summary.totals,
    statusBreakdown: tallyStatuses(har12.log.entries),
    note: 'Valid HAR 1.2 log of the network over the load. The raw .har opens in DevTools Network import and is the basis for cross-run network deltas; read the companion *-summary.json for the compact, model-readable network signals (read the summary, never the raw HAR).',
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
function summariseHar(har, mainUrl) {
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

    bySize.push({ url: e.request.url, type: bucket, transferredBytes: transferred });
    if (typeof e.time === 'number' && e.time >= 0) {
      bySlow.push({ url: e.request.url, type: bucket, timeMs: round(e.time) });
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
        url: e.request.url,
        type: bucket,
        transferredBytes: transferred,
        contentEncoding: enc || 'none',
      });
    }

    // Hygiene: cacheable responses missing cache-control AND expires. Skip
    // redirects/errors and non-200s where caching is not the relevant signal.
    const status = num(res.status) || 0;
    if (status >= 200 && status < 300) {
      const cc = headers['cache-control'];
      const exp = headers['expires'];
      if (!cc && !exp && (bucket === 'script' || bucket === 'stylesheet' || bucket === 'image' || bucket === 'font')) {
        missingCache.push({ url: e.request.url, type: bucket, transferredBytes: transferred });
      }
    }

    // Hygiene: redirect chains (3xx) and HTTP errors (4xx/5xx).
    if (status >= 300 && status < 400) {
      redirects.push({
        url: e.request.url,
        status,
        location: headers['location'] || res.redirectURL || '',
      });
    } else if (status >= 400) {
      httpErrors.push({ url: e.request.url, status, type: bucket });
    }
    if (res._error) {
      httpErrors.push({ url: e.request.url, status: 0, type: bucket, error: res._error });
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
      topOriginsByBytes: origins.slice(0, 10).map((o) => ({
        origin: o.origin,
        party: o.thirdParty ? 'third-party' : 'first-party',
        count: o.count,
        transferredBytes: o.transferredBytes,
      })),
    },
    renderBlockingCandidates: renderBlockingCandidates.slice(0, 10),
    weightOffenders: {
      largestByBytes: topBySize,
      slowestByTime: topBySlow,
    },
    hygiene: {
      uncompressedTextOver2KB: uncompressed
        .sort((a, b) => b.transferredBytes - a.transferredBytes)
        .slice(0, 10),
      missingCacheHeaders: missingCache
        .sort((a, b) => b.transferredBytes - a.transferredBytes)
        .slice(0, 10),
      redirects: redirects.slice(0, 10),
      httpErrors: httpErrors.slice(0, 10),
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

// Lower-cased header name -> value map from a HAR header array.
function headerMap(headers) {
  const out = {};
  if (!Array.isArray(headers)) return out;
  for (const h of headers) {
    if (h && h.name) out[h.name.toLowerCase()] = String(h.value ?? '');
  }
  return out;
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
function harInitiator(init) {
  if (!init) return { type: 'other' };
  const out = { type: init.type || 'other' };
  // Parser-inserted (and preload): the inserting document and source position.
  if (init.url) out.url = init.url;
  if (typeof init.lineNumber === 'number') out.lineNumber = init.lineNumber;
  // Script-initiated: surface the top call frame of the JS stack, if present.
  const top = init.stack?.callFrames?.[0];
  if (top) {
    out.callFrame = {
      url: top.url || '',
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
function buildHar(records, log) {
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

    const reqHeaders = headerArray(req.headers);
    const resHeaders = headerArray(res?.headers);
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

    const timings = harTimings(res?.timing, totalMs);

    entries.push({
      startedDateTime,
      time: totalMs < 0 ? 0 : totalMs,
      request: {
        method: req.method,
        url: req.url,
        httpVersion: res?.protocol || 'HTTP/1.1',
        headers: reqHeaders,
        queryString: queryString(req.url),
        cookies: [],
        headersSize: -1,
        bodySize: req.postData ? byteLength(req.postData) : 0,
        ...(req.postData
          ? { postData: { mimeType: req.headers?.['Content-Type'] || '', text: req.postData } }
          : {}),
      },
      response: {
        status: rec.failed ? 0 : res?.status || 0,
        statusText: rec.failed ? rec.failed : res?.statusText || '',
        httpVersion: res?.protocol || 'HTTP/1.1',
        headers: resHeaders,
        cookies: [],
        content,
        redirectURL: res?.headers?.Location || res?.headers?.location || '',
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
      _initiator: harInitiator(rec.initiator),
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

function headerArray(headers) {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

function queryString(url) {
  try {
    const u = new URL(url);
    return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

function approxBase64DecodedSize(b64) {
  // 4 base64 chars -> 3 bytes, minus padding. No Node Buffer.
  const len = b64.length;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// --- discoverability / AI-crawlability probe --------------------------------
// How much of a page's content is visible to a crawler that fetches the raw
// HTML but does NOT execute JavaScript - the failure mode from the URL-influence
// research, where JS-rendered SPAs reach models and search as empty shells.
// Fetches the raw server HTML with a plain request (no JS), renders the same URL
// via CDP, and reports how much of the rendered content survives in the raw
// HTML. Descriptive signals only; the model judges be-discoverable /
// be-agent-ready.
const CRAWLER_UA =
  'Mozilla/5.0 (compatible; web-uplift-discoverability/1.0; +https://github.com/PaulKinlan/web-uplift)';

export function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Meaningful content words (>=4 chars, lowercased) for the overlap measure, so
// coverage reflects real content rather than boilerplate/markup.
export function contentTokens(text) {
  const set = new Set();
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []) set.add(w);
  return set;
}

// Known SPA mount roots that ship EMPTY in the server HTML and are filled by JS
// - a strong "invisible to non-JS crawlers" tell.
export function detectEmptyMounts(html) {
  const found = [];
  const patterns = [
    ['#root', /<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i],
    ['#app', /<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i],
    ['#__next', /<div[^>]+id=["']__next["'][^>]*>\s*<\/div>/i],
    ['#__nuxt', /<div[^>]+id=["']__nuxt["'][^>]*>\s*<\/div>/i],
  ];
  for (const [name, re] of patterns) if (re.test(html)) found.push(name);
  return found;
}

async function discoverability(client, url, opts, log) {
  // 1. Raw HTML as a non-JS crawler sees it: a plain fetch, no JS execution.
  let rawHtml = '';
  let rawStatus = null;
  let fetchError = null;
  let finalUrl = url;
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': CRAWLER_UA, accept: 'text/html' } });
    rawStatus = res.status;
    finalUrl = res.url || url;
    rawHtml = await res.text();
    log(`[evidence] discoverability: raw HTML ${rawStatus}, ${byteLength(rawHtml)} bytes`);
  } catch (e) {
    fetchError = String(e?.message || e);
    log(`[evidence] discoverability: raw fetch failed: ${fetchError}`);
  }

  // 2. Rendered DOM after JS runs, via CDP. SPAs often need more than the
  // default 1s to hydrate and paint their content, so settle for longer here
  // unless the caller asked for a specific --wait.
  await navigate(client, url, {
    settleMs: Math.max(opts.wait ?? 0, 3500),
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  await sleep(150);
  const rendered = await evaluate(
    client,
    `(() => {
      const txt = (document.body ? document.body.innerText : '') || '';
      return {
        title: document.title || '',
        metaDescription: (document.querySelector('meta[name="description"]') || {}).content || '',
        h1: Array.from(document.querySelectorAll('h1')).map((h) => (h.innerText || '').trim()).filter(Boolean),
        text: txt.replace(/\\s+/g, ' ').trim(),
        framework: (window.__NEXT_DATA__ ? 'Next.js' : window.__NUXT__ ? 'Nuxt'
          : document.querySelector('[ng-version]') ? 'Angular'
          : (window.React || document.querySelector('[data-reactroot],#root')) ? 'React-like' : null),
      };
    })()`,
  );

  // 3. Compare rendered content against the raw HTML.
  const rawText = stripHtmlToText(rawHtml);
  const renderedTokens = contentTokens(rendered.text);
  const rawTokens = contentTokens(rawText);
  let overlap = 0;
  for (const t of renderedTokens) if (rawTokens.has(t)) overlap++;
  // If the rendered page produced essentially no content, coverage is undefined
  // (not 100%) - the render likely failed, redirected, or the page is genuinely
  // empty. Surface that honestly rather than manufacture a perfect score.
  const renderedEmpty = renderedTokens.size < 3;
  const coveragePct = renderedEmpty ? null : Math.round((overlap / renderedTokens.size) * 100);
  const emptyMounts = detectEmptyMounts(rawHtml);
  const rawLower = rawText.toLowerCase();
  const titleInRaw = rendered.title ? rawLower.includes(rendered.title.toLowerCase().slice(0, 60)) : null;
  const h1InRaw = rendered.h1.length ? rendered.h1.some((h) => rawLower.includes(h.toLowerCase().slice(0, 40))) : null;
  const metaInRaw = rendered.metaDescription ? /name=["']description["']/i.test(rawHtml) : null;
  // A JS shell: an empty SPA mount with almost no content in the raw HTML, or a
  // content-rich rendered page whose text is essentially absent from the raw.
  // Only assertable when we actually got rendered content to compare against.
  const isJsShell =
    coveragePct != null &&
    ((emptyMounts.length > 0 && coveragePct < 25) || (renderedTokens.size >= 50 && coveragePct < 10));

  const summary = {
    type: 'discoverability',
    url,
    finalUrl,
    fetchedStatus: rawStatus,
    fetchError,
    crawlerUserAgent: CRAWLER_UA,
    coveragePct, // share of rendered content words that also appear in the raw server HTML (null if the render was empty)
    contentVisibleWithoutJs: coveragePct,
    isJsShell,
    renderedEmpty,
    emptyMounts,
    titlePresentInRaw: titleInRaw,
    h1PresentInRaw: h1InRaw,
    metaDescriptionPresentInRaw: metaInRaw,
    rendered: {
      textChars: rendered.text.length,
      contentTokens: renderedTokens.size,
      title: rendered.title,
      h1Count: rendered.h1.length,
      framework: rendered.framework,
    },
    raw: {
      htmlBytes: byteLength(rawHtml),
      textChars: rawText.length,
      contentTokens: rawTokens.size,
    },
    signalsFor: ['be-discoverable', 'be-agent-ready'],
    note:
      'coveragePct = the share of the rendered page\'s content words that also appear in the RAW server HTML - what a crawler that does not run JavaScript (many AI crawlers, per the url-influence research) can see. Low coverage with an empty SPA mount means the content is effectively invisible to non-JS crawlers and unlikely to enter model training or search. High coverage means it is server-rendered and reachable. Descriptive signal, not a verdict: judge against be-discoverable / be-agent-ready, and confirm surprising results against the raw HTML and the dom primitive.',
  };

  if (opts.out) writeFileSync(opts.out, JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

const PRIMITIVES = {
  screenshot,
  video,
  heap,
  layout,
  dom,
  evaluate: evaluateCmd,
  trace,
  har,
  discoverability,
};

// --- argument plumbing -----------------------------------------------------

function parseArgs(argv) {
  const args = { _: [], wait: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--emulate-media') args.emulateMediaRaw = argv[++i];
    else if (a === '--viewport') args.viewportRaw = argv[++i];
    else if (a === '--wait') args.wait = Number(argv[++i]);
    else if (a === '--duration') args.duration = Number(argv[++i]);
    else if (a === '--fps') args.fps = Number(argv[++i]);
    else if (a === '--selector') args.selector = argv[++i];
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--expr') args.expr = argv[++i];
    else if (a === '--expr-file') args.expr = readFileSync(argv[++i], 'utf8');
    else if (a === '--interact') args.interact = argv[++i];
    else if (a === '--interact-file') args.interact = readFileSync(argv[++i], 'utf8');
    else if (a === '--full-page') args.fullPage = true;
    else if (a === '--bodies') args.bodies = true;
    else if (a === '--quiet') args.quiet = true;
    else args._.push(a);
  }
  if (args.emulateMediaRaw) {
    args.emulateMedia = args.emulateMediaRaw.split(',').map((kv) => {
      const [name, value] = kv.split('=');
      return { name: name.trim(), value: (value ?? '').trim() };
    });
  }
  if (args.viewportRaw) {
    const m = args.viewportRaw.match(/(\d+)x(\d+)/);
    if (m) args.viewport = { w: Number(m[1]), h: Number(m[2]) };
  }
  return args;
}

function derivedOut(url, kind, ext) {
  let host = 'page';
  try {
    host = new URL(url).host.replace(/[:.]/g, '_') || 'page';
  } catch {
    // ignore
  }
  return `${host}-${kind}-${Date.now()}.${ext}`;
}

function uint8FromBase64(b64) {
  // No Node Buffer: decode base64 to a Uint8Array.
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function gather(primitive, url, opts = {}) {
  const fn = PRIMITIVES[primitive];
  if (!fn) throw new Error(`Unknown primitive "${primitive}". One of: ${Object.keys(PRIMITIVES).join(', ')}`);
  const log = opts.quiet ? () => {} : (m) => console.error(m);
  const chrome = await launchChrome({ log });
  try {
    const session = await newSession(chrome.port, { log });
    try {
      return await fn(session.client, url, opts, log);
    } finally {
      await session.close();
    }
  } finally {
    await chrome.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const primitive = args._[0];
  const url = args._[1];
  if (!primitive || !url) {
    console.error(
      'Usage: node evidence/cli.mjs <screenshot|video|heap|layout|dom|evaluate|trace|har|discoverability> <url> [options]\n' +
        'Options: --out --emulate-media k=v,.. --viewport WxH --wait ms --selector css\n' +
        '         --source dir --expr "<js>" --expr-file f --interact "<js>" --interact-file f\n' +
        '         --duration ms --fps n --full-page --bodies --quiet',
    );
    process.exit(1);
  }
  const result = await gather(primitive, url, args);
  // Print the result (or artifact pointer) as JSON to stdout for the model.
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
