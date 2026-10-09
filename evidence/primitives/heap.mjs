import { navigate, evaluate, sleep } from '../cdp.mjs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { applyConditions, derivedOut } from '../common.mjs';

export async function heap(client, url, opts, log) {
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
