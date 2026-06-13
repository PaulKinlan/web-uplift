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
  await navigate(client, url, { settleMs: opts.wait, log });
  await applyConditions(client, opts, log);
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
  await navigate(client, url, { settleMs: opts.wait, log });
  await applyConditions(client, opts, log);

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
  await navigate(client, url, { settleMs: opts.wait, log });
  await applyConditions(client, opts, log);

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
  await navigate(client, url, { settleMs: 0, log });
  await applyConditions(client, opts, log);
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
  await navigate(client, url, { settleMs: opts.wait, log });
  await applyConditions(client, opts, log);
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
  await navigate(client, url, { settleMs: opts.wait, log });
  await applyConditions(client, opts, log);
  await sleep(150);
  if (opts.interact) await evaluate(client, opts.interact);
  const expr = opts.expr;
  if (!expr) throw new Error('evaluate requires --expr "<js>" or --expr-file <path>');
  const value = await evaluate(client, expr);
  if (opts.out) writeFileSync(opts.out, JSON.stringify(value, null, 2) + '\n');
  return value;
}

const PRIMITIVES = {
  screenshot,
  video,
  heap,
  layout,
  dom,
  evaluate: evaluateCmd,
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
      'Usage: node evidence/cli.mjs <screenshot|video|heap|layout|dom|evaluate> <url> [options]\n' +
        'Options: --out --emulate-media k=v,.. --viewport WxH --wait ms --selector css\n' +
        '         --source dir --expr "<js>" --expr-file f --interact "<js>" --interact-file f\n' +
        '         --duration ms --fps n --full-page --quiet',
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
