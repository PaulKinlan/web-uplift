#!/usr/bin/env node
/**
 * web-uplift compare: diff two RETAINED runs of the same host so the hill-climb
 * is measurable across runs (before -> after).
 *
 *   node aggregate/compare.mjs <host> [runA] [runB] [--reports reports] [--out <dir>]
 *
 * host  is the slug under reports/ (e.g. localhost_8090) or a URL we slugify.
 * runA/runB default to the two most recent runs (runA = older/before,
 * runB = newer/after). Writes compare.md + compare.json into runB's dir (or
 * --out), reporting:
 *   - principle status changes (pass/issues/n-a/opted-out deltas),
 *   - per-finding resolved / new / persisting,
 *   - metric deltas (LCP/INP/CLS, Lighthouse perf/a11y/bp/seo where present),
 *   - network/HAR deltas (request count, transferred bytes) where present,
 *   - PAIRED before/after screenshots referenced side by side.
 *
 * This reads ONLY the two report.json files (and their referenced artifact
 * paths); it makes no judgements of its own. The model produced the reports;
 * compare just diffs them.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, isAbsolute, relative } from 'node:path';
import { hostSlug, pickRuns } from '../runner/run-history.mjs';

export function compareReports(reportA, reportB, { dirA, dirB } = {}) {
  const principleChanges = diffPrinciples(reportA, reportB);
  const findingDelta = diffFindings(reportA, reportB);
  const metricDelta = diffMetrics(reportA, reportB);
  const networkDelta = diffNetwork(reportA, reportB, dirA, dirB);
  const screenshotPairs = pairScreenshots(reportA, reportB);

  const outstandingBefore = countOutstanding(reportA);
  const outstandingAfter = countOutstanding(reportB);

  return {
    before: { url: reportA.url, auditedAt: reportA.auditedAt, mode: reportA.mode, outstanding: outstandingBefore },
    after: { url: reportB.url, auditedAt: reportB.auditedAt, mode: reportB.mode, outstanding: outstandingAfter },
    summary: {
      outstandingBefore,
      outstandingAfter,
      resolved: findingDelta.resolved.length,
      newlyIntroduced: findingDelta.added.length,
      persisting: findingDelta.persisting.length,
      principlesImproved: principleChanges.filter((p) => p.direction === 'improved').length,
      principlesRegressed: principleChanges.filter((p) => p.direction === 'regressed').length,
    },
    principleChanges,
    findings: findingDelta,
    metrics: metricDelta,
    network: networkDelta,
    screenshotPairs,
  };
}

// --- principle status deltas ----------------------------------------------

const STATUS_RANK = { issues: 0, pass: 3, 'not-applicable': 2, 'opted-out': 2 };

function diffPrinciples(a, b) {
  const aMap = new Map((a.principleOutcomes ?? []).map((o) => [o.principleId, o.status]));
  const bMap = new Map((b.principleOutcomes ?? []).map((o) => [o.principleId, o.status]));
  const ids = new Set([...aMap.keys(), ...bMap.keys()]);
  const out = [];
  for (const id of ids) {
    const before = aMap.get(id) ?? '(absent)';
    const after = bMap.get(id) ?? '(absent)';
    if (before === after) continue;
    const ra = STATUS_RANK[before] ?? 1;
    const rb = STATUS_RANK[after] ?? 1;
    out.push({
      principleId: id,
      before,
      after,
      direction: rb > ra ? 'improved' : rb < ra ? 'regressed' : 'changed',
    });
  }
  return out.sort((x, y) => x.principleId.localeCompare(y.principleId));
}

// --- finding deltas ---------------------------------------------------------

// Findings are matched on a stable key: principleCheckId + pathId where present,
// else id. This survives id renumbering between runs (the usual case after a fix
// pass) while still pairing the same underlying issue.
function findingKey(f) {
  if (f.principleCheckId) return `${f.principleId ?? '?'}::${f.principleCheckId}::${f.pathId ?? ''}`;
  return `id::${f.id}`;
}

function diffFindings(a, b) {
  const aFind = a.findings ?? [];
  const bFind = b.findings ?? [];
  const aKeys = new Map(aFind.map((f) => [findingKey(f), f]));
  const bKeys = new Map(bFind.map((f) => [findingKey(f), f]));

  const resolved = [];
  const persisting = [];
  const added = [];
  for (const [k, f] of aKeys) {
    if (bKeys.has(k)) persisting.push(summariseFinding(f, bKeys.get(k)));
    else resolved.push(summariseFinding(f));
  }
  for (const [k, f] of bKeys) {
    if (!aKeys.has(k)) added.push(summariseFinding(f));
  }
  return { resolved, added, persisting };
}

function summariseFinding(f, after) {
  return {
    id: f.id,
    afterId: after?.id,
    principleId: f.principleId,
    principleCheckId: f.principleCheckId,
    severity: f.severity,
    severityAfter: after?.severity,
    summary: f.summary,
  };
}

// --- metric deltas ----------------------------------------------------------

// Metrics may live in a few shapes depending on what the model recorded. We look
// for a `metrics` block and for a Lighthouse `categories`/`scores` block, plus
// the trace-summary-derived LCP if the model surfaced it. Absent metrics are
// simply omitted, not invented.
function diffMetrics(a, b) {
  const ma = collectMetrics(a);
  const mb = collectMetrics(b);
  const keys = new Set([...Object.keys(ma), ...Object.keys(mb)]);
  const rows = [];
  for (const k of [...keys].sort()) {
    const before = ma[k];
    const after = mb[k];
    if (before == null && after == null) continue;
    const delta = typeof before === 'number' && typeof after === 'number' ? round(after - before) : null;
    rows.push({ metric: k, before: before ?? null, after: after ?? null, delta });
  }
  return rows;
}

function collectMetrics(report) {
  const out = {};
  const m = report.metrics ?? {};
  for (const k of ['lcp', 'inp', 'cls', 'fcp', 'tbt', 'LCP', 'INP', 'CLS']) {
    if (typeof m[k] === 'number') out[k.toLowerCase()] = m[k];
  }
  // Lighthouse category scores under a few common shapes.
  const lh = report.lighthouse ?? m.lighthouse ?? {};
  const cats = lh.categories ?? lh.scores ?? lh;
  for (const [name, key] of [
    ['performance', 'lh-performance'],
    ['accessibility', 'lh-accessibility'],
    ['best-practices', 'lh-best-practices'],
    ['seo', 'lh-seo'],
  ]) {
    const v = cats?.[name];
    const score = typeof v === 'object' ? v.score : v;
    if (typeof score === 'number') out[key] = score <= 1 ? Math.round(score * 100) : score;
  }
  return out;
}

// --- network / HAR deltas ---------------------------------------------------

// Prefer an explicit `network` block the model recorded; else read the linked
// HAR artifact(s) from the artifacts manifest and derive request count +
// transferred bytes. dirOf lets us resolve artifact paths relative to the run.
function diffNetwork(a, b, dirA, dirB) {
  const na = collectNetwork(a, dirA);
  const nb = collectNetwork(b, dirB);
  if (!na && !nb) return null;
  const f = (o, k) => (o && typeof o[k] === 'number' ? o[k] : null);
  return {
    requestCount: { before: f(na, 'requestCount'), after: f(nb, 'requestCount') },
    transferredBytes: { before: f(na, 'transferredBytes'), after: f(nb, 'transferredBytes') },
    requestCountDelta: na && nb ? f(nb, 'requestCount') - f(na, 'requestCount') : null,
    transferredBytesDelta: na && nb ? f(nb, 'transferredBytes') - f(na, 'transferredBytes') : null,
  };
}

function collectNetwork(report, dir) {
  if (report.network && typeof report.network === 'object') {
    return {
      requestCount: report.network.requestCount ?? report.network.entryCount ?? null,
      transferredBytes: report.network.transferredBytes ?? report.network.totalTransferredBytes ?? null,
    };
  }
  // Fall back to a linked HAR artifact.
  const har = (report.artifacts ?? []).find((art) => art.type === 'har');
  if (har && dir) {
    const p = resolveArtifact(dir, har.path);
    if (p && existsSync(p)) {
      try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        const entries = parsed.log?.entries ?? [];
        return {
          requestCount: entries.length,
          transferredBytes: entries.reduce((acc, e) => acc + (e.response?._transferSize || 0), 0),
        };
      } catch {
        /* unreadable HAR */
      }
    }
  }
  return null;
}

// --- paired screenshots -----------------------------------------------------

// Pair before/after screenshots by their capture condition (and, where set, the
// findings they evidence) so the report can show them side by side.
function pairScreenshots(a, b) {
  const sa = (a.artifacts ?? []).filter((x) => x.type === 'screenshot');
  const sb = (b.artifacts ?? []).filter((x) => x.type === 'screenshot');
  const keyOf = (x) => x.condition || (x.findingIds ?? []).join(',') || x.path;
  const bByKey = new Map(sb.map((x) => [keyOf(x), x]));
  const pairs = [];
  const usedB = new Set();
  for (const x of sa) {
    const k = keyOf(x);
    const match = bByKey.get(k);
    if (match) usedB.add(keyOf(match));
    pairs.push({
      condition: x.condition || match?.condition || '',
      caption: x.caption || match?.caption || '',
      before: x.path,
      after: match?.path ?? null,
    });
  }
  for (const x of sb) {
    if (!usedB.has(keyOf(x))) {
      pairs.push({ condition: x.condition || '', caption: x.caption || '', before: null, after: x.path });
    }
  }
  return pairs;
}

// --- shared -----------------------------------------------------------------

function countOutstanding(report) {
  const excused = new Set(
    (report.principleOutcomes ?? [])
      .filter((o) => o.status === 'not-applicable' || o.status === 'opted-out')
      .map((o) => o.principleId),
  );
  return (report.findings ?? []).filter((f) => !excused.has(f.principleId)).length;
}

function resolveArtifact(dir, p) {
  if (!p) return null;
  return isAbsolute(p) ? p : join(dir, p);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// --- markdown ---------------------------------------------------------------

export function renderCompareMd(cmp, { hostName, runAId, runBId, dirA, dirB } = {}) {
  const s = cmp.summary;
  const arrow = (n) => (n == null ? '' : n < 0 ? ` (${n})` : n > 0 ? ` (+${n})` : ' (0)');
  const lines = [];
  lines.push(`# web-uplift compare: ${hostName ?? cmp.after.url}`);
  lines.push('');
  lines.push(`- **Before:** ${runAId ?? cmp.before.auditedAt ?? '?'} (${cmp.before.mode ?? 'report'} mode, ${s.outstandingBefore} outstanding)`);
  lines.push(`- **After:** ${runBId ?? cmp.after.auditedAt ?? '?'} (${cmp.after.mode ?? 'report'} mode, ${s.outstandingAfter} outstanding)`);
  lines.push(`- **Outstanding issue-findings:** ${s.outstandingBefore} -> ${s.outstandingAfter}${arrow(s.outstandingAfter - s.outstandingBefore)}`);
  lines.push(`- **Resolved:** ${s.resolved} | **New:** ${s.newlyIntroduced} | **Persisting:** ${s.persisting}`);
  lines.push('');

  lines.push('## Principle status changes');
  if (cmp.principleChanges.length) {
    lines.push('| Principle | Before | After | |');
    lines.push('|---|---|---|---|');
    for (const p of cmp.principleChanges) {
      const tag = p.direction === 'improved' ? 'improved' : p.direction === 'regressed' ? 'REGRESSED' : 'changed';
      lines.push(`| ${p.principleId} | ${p.before} | ${p.after} | ${tag} |`);
    }
  } else {
    lines.push('_No principle status changed between the two runs._');
  }
  lines.push('');

  lines.push('## Findings');
  lines.push(`**Resolved (${cmp.findings.resolved.length})**`);
  if (cmp.findings.resolved.length) {
    for (const f of cmp.findings.resolved) lines.push(`- ~~${f.id}~~ (${f.severity}) ${f.summary} _[${f.principleCheckId ?? f.principleId ?? ''}]_`);
  } else lines.push('- none');
  lines.push('');
  lines.push(`**Newly introduced (${cmp.findings.added.length})**`);
  if (cmp.findings.added.length) {
    for (const f of cmp.findings.added) lines.push(`- ${f.id} (${f.severity}) ${f.summary} _[${f.principleCheckId ?? f.principleId ?? ''}]_`);
  } else lines.push('- none');
  lines.push('');
  lines.push(`**Persisting (${cmp.findings.persisting.length})**`);
  if (cmp.findings.persisting.length) {
    for (const f of cmp.findings.persisting) {
      const sev = f.severityAfter && f.severityAfter !== f.severity ? `${f.severity} -> ${f.severityAfter}` : f.severity;
      lines.push(`- ${f.id} (${sev}) ${f.summary} _[${f.principleCheckId ?? f.principleId ?? ''}]_`);
    }
  } else lines.push('- none');
  lines.push('');

  if (cmp.metrics.length) {
    lines.push('## Metric deltas');
    lines.push('| Metric | Before | After | Delta |');
    lines.push('|---|---|---|---|');
    for (const m of cmp.metrics) {
      lines.push(`| ${m.metric} | ${fmt(m.before)} | ${fmt(m.after)} | ${m.delta == null ? '-' : (m.delta > 0 ? '+' : '') + m.delta} |`);
    }
    lines.push('');
  }

  if (cmp.network) {
    lines.push('## Network / HAR deltas');
    lines.push('| | Before | After | Delta |');
    lines.push('|---|---|---|---|');
    lines.push(`| requests | ${fmt(cmp.network.requestCount.before)} | ${fmt(cmp.network.requestCount.after)} | ${signed(cmp.network.requestCountDelta)} |`);
    lines.push(`| transferred bytes | ${fmt(cmp.network.transferredBytes.before)} | ${fmt(cmp.network.transferredBytes.after)} | ${signed(cmp.network.transferredBytesDelta)} |`);
    lines.push('');
  }

  if (cmp.screenshotPairs.length) {
    lines.push('## Before / after screenshots');
    for (const p of cmp.screenshotPairs) {
      lines.push('');
      lines.push(`**${p.caption || p.condition || 'screenshot'}**${p.condition ? ` _(${p.condition})_` : ''}`);
      lines.push('');
      lines.push('| Before | After |');
      lines.push('|---|---|');
      const beforeRef = p.before ? `![before](${relForMd(dirB, dirA, p.before)})` : '_n/a_';
      const afterRef = p.after ? `![after](${p.after})` : '_n/a_';
      lines.push(`| ${beforeRef} | ${afterRef} |`);
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

// The compare.md lives in runB's dir; an `after` screenshot path is relative to
// that dir already, but a `before` path is relative to runA's dir, so we rewrite
// it relative to runB's dir for the embedded image to resolve.
function relForMd(dirB, dirA, beforePath) {
  if (!dirB || !dirA || isAbsolute(beforePath)) return beforePath;
  const abs = join(dirA, beforePath);
  const rel = relative(dirB, abs);
  return rel.split('\\').join('/');
}

function fmt(v) {
  return v == null ? '-' : v;
}
function signed(n) {
  return n == null ? '-' : n > 0 ? `+${n}` : String(n);
}

// --- CLI --------------------------------------------------------------------

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('compare.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const positional = [];
  let reportsRoot = 'reports';
  let outDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reports') reportsRoot = argv[++i];
    else if (argv[i] === '--out') outDir = argv[++i];
    else positional.push(argv[i]);
  }
  const [hostArg, runA, runB] = positional;
  if (!hostArg) {
    console.error('Usage: web-uplift compare <host|url> [runA] [runB] [--reports <dir>] [--out <dir>]');
    process.exit(1);
  }
  const host = hostSlug(hostArg);
  const hostRoot = join(reportsRoot, host);
  const { a, b } = pickRuns(hostRoot, runA, runB);

  const reportA = JSON.parse(readFileSync(join(a.dir, 'report.json'), 'utf8'));
  const reportB = JSON.parse(readFileSync(join(b.dir, 'report.json'), 'utf8'));

  const cmp = compareReports(reportA, reportB, { dirA: a.dir, dirB: b.dir });

  const dest = outDir ?? b.dir;
  const json = {
    host,
    runA: a.runId,
    runB: b.runId,
    ...cmp,
  };
  writeFileSync(join(dest, 'compare.json'), JSON.stringify(json, null, 2) + '\n');
  const md = renderCompareMd(cmp, {
    hostName: host,
    runAId: a.runId,
    runBId: b.runId,
    dirA: a.dir,
    dirB: dest,
  });
  writeFileSync(join(dest, 'compare.md'), md);
  console.log(md);
  console.log(`-> wrote ${join(dest, 'compare.md')} and compare.json`);
}
