// Interactive HTML scorecard generator.
//
// Rolls a host's retained audit runs (reports/<host>/<runId>/report.json, plus
// compare.json where a fix produced a before/after) into a single, shareable
// scorecard.html that leads with OUTCOMES a site owner cares about rather than a
// flat list of findings:
//
//   - Lighthouse-style circular score gauges, one per owner outcome
//     (Speed & Stability, Memory Health, Usability, Inclusivity, Discoverability
//     & AI, Trust & Resilience), computed from the model's principleOutcomes and
//     the severity of the findings under each.
//   - A "do these first" top-3 pulled from the run's prioritised taskList.
//   - A findings deep-dive: every finding opens a native <dialog> with its
//     evidence, suggested fix, effort, and the actual screenshots/video the audit
//     captured.
//   - A history chart of the overall score across every retained run, so repeated
//     audits show the trend.
//   - A before/after panel from the latest compare.json (resolved findings,
//     Core Web Vitals deltas, paired before/after screenshots).
//
// The page is self-contained: all CSS/JS is inline, screenshots are inlined as
// data URIs so the scores and imagery travel in the one file. Video is
// referenced by relative path (too large to inline), so the reports/<host>/
// folder is the fully portable unit. No external requests, no build step — it
// opens from file:// and is safe to publish as a CI artifact.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { hostSlug, listRuns, resolveLatest } from '../runner/run-history.mjs';

// --- Outcome model ----------------------------------------------------------
// The 17 quality principles, grouped into the outcomes a site owner recognises.
// Every principle appears in exactly one outcome, so the gauges partition the
// whole quality model with nothing dropped.
export const OUTCOMES = [
  {
    key: 'speed',
    label: 'Speed & Stability',
    blurb: 'How fast it loads and how steady it feels while it does.',
    principles: ['be-fast-and-stable', 'be-sustainable'],
  },
  {
    key: 'memory',
    label: 'Memory Health',
    blurb: 'Stays light on the device — no leaks, no slow-motion crawl to a crash.',
    principles: ['be-memory-efficient'],
  },
  {
    key: 'usability',
    label: 'Usability & UX',
    blurb: 'Easy, natural, and adapts to whatever screen it lands on.',
    principles: [
      'respect-user-preferences',
      'implement-natural-interactions',
      'provide-guided-navigation',
      'maximize-content-reduce-noise',
      'adapt-to-the-form-factor',
      'support-core-task-success',
    ],
  },
  {
    key: 'inclusive',
    label: 'Inclusivity & Reach',
    blurb: 'Usable by everyone, assistive tech included, in any language.',
    principles: ['be-inclusive', 'be-internationalised'],
  },
  {
    key: 'discoverable',
    label: 'Discoverability & AI',
    blurb: 'Search engines and AI models can actually see the content, not a blank shell.',
    principles: ['be-discoverable', 'be-agent-ready'],
  },
  {
    key: 'trust',
    label: 'Trust & Resilience',
    blurb: 'Private, secure, keeps working when the network or a script fails.',
    principles: ['be-private-and-secure', 'be-trustworthy', 'be-resilient', 'follow-best-practices'],
  },
];

const PRINCIPLE_OUTCOME = new Map();
for (const o of OUTCOMES) for (const p of o.principles) PRINCIPLE_OUTCOME.set(p, o.key);

// How far a single "issues" verdict pulls a principle's 0-100 sub-score down,
// scaled by the model's stated confidence. A "pass" is 100; not-applicable /
// opted-out principles are excluded from the average entirely.
const SEVERITY_PENALTY = { critical: 90, high: 55, medium: 35, low: 15 };
const CONFIDENCE_SCALE = { high: 1, medium: 0.75, low: 0.5 };

// --- Scoring ----------------------------------------------------------------

function worstFindingFor(report, principleId) {
  const order = { critical: 4, high: 3, medium: 2, low: 1 };
  let worst = null;
  for (const f of report.findings ?? []) {
    if (f.principleId !== principleId) continue;
    if (!worst || (order[f.severity] ?? 0) > (order[worst.severity] ?? 0)) worst = f;
  }
  return worst;
}

function principleScore(report, outcomeRecord) {
  if (outcomeRecord.status === 'pass') return 100;
  if (outcomeRecord.status !== 'issues') return null; // not-applicable / opted-out
  const worst = worstFindingFor(report, outcomeRecord.principleId);
  const penalty = SEVERITY_PENALTY[worst?.severity] ?? SEVERITY_PENALTY.medium;
  const scale = CONFIDENCE_SCALE[worst?.confidence] ?? 1;
  return Math.max(0, Math.round(100 - penalty * scale));
}

// Compute per-outcome scores (0-100 or null when N/A for this site) and an
// overall score (equal-weighted mean of the applicable outcome gauges) for one
// report.
export function scoreReport(report) {
  const outcomeById = new Map();
  for (const rec of report.principleOutcomes ?? []) {
    const key = PRINCIPLE_OUTCOME.get(rec.principleId);
    if (!key) continue;
    const s = principleScore(report, rec);
    if (!outcomeById.has(key)) outcomeById.set(key, []);
    outcomeById.get(key).push({ principleId: rec.principleId, status: rec.status, score: s, findingIds: rec.findingIds ?? [] });
  }

  const outcomes = OUTCOMES.map((o) => {
    const parts = outcomeById.get(o.key) ?? [];
    const scored = parts.filter((p) => typeof p.score === 'number');
    const score = scored.length ? Math.round(scored.reduce((s, p) => s + p.score, 0) / scored.length) : null;
    return { key: o.key, label: o.label, blurb: o.blurb, score, principles: parts };
  });

  const applicable = outcomes.filter((o) => typeof o.score === 'number');
  const overall = applicable.length
    ? Math.round(applicable.reduce((s, o) => s + o.score, 0) / applicable.length)
    : null;

  return { overall, outcomes };
}

// --- Data assembly ----------------------------------------------------------

function loadRun(dir, runId) {
  const reportPath = join(dir, 'report.json');
  if (!existsSync(reportPath)) return null;
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const comparePath = join(dir, 'compare.json');
  const compare = existsSync(comparePath) ? JSON.parse(readFileSync(comparePath, 'utf8')) : null;
  return { runId, dir, report, compare, ...scoreReport(report) };
}

export function buildScorecardData(hostRoot, host, generatedAt) {
  const runs = listRuns(hostRoot)
    .map((r) => loadRun(r.dir, r.runId))
    .filter(Boolean);
  if (!runs.length) throw new Error(`No runs with a report.json under ${hostRoot}.`);
  const latestDir = resolveLatest(hostRoot);
  const latest = runs.find((r) => r.dir === latestDir) ?? runs[runs.length - 1];
  return { host, generatedAt, runs, latest };
}

// --- Rendering helpers ------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function gradeClass(score) {
  if (score == null) return 'na';
  if (score >= 90) return 'good';
  if (score >= 50) return 'ok';
  return 'poor';
}

// Inline a screenshot as a data URI so the imagery travels in the HTML. Video is
// referenced by relative path (too big to inline). Returns null if unreadable.
function dataUri(dir, relPath) {
  try {
    const abs = join(dir, relPath);
    if (!existsSync(abs)) return null;
    const ext = relPath.split('.').pop().toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext];
    if (!mime) return null;
    const b64 = readFileSync(abs, { encoding: 'base64' });
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

// SVG ring gauge, Lighthouse-style: a track circle plus a coloured arc whose
// length encodes the score. Size in px.
function gauge(score, { size = 128, stroke = 10 } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score));
  const offset = c * (1 - pct / 100);
  const cls = gradeClass(score);
  const label = score == null ? 'N/A' : String(score);
  return `<svg class="gauge ${cls}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Score ${label} out of 100">
  <circle class="gauge-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"></circle>
  <circle class="gauge-arc" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"
    stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" stroke-linecap="round"
    transform="rotate(-90 ${size / 2} ${size / 2})"></circle>
  <text class="gauge-num" x="50%" y="50%" dominant-baseline="central" text-anchor="middle">${esc(label)}</text>
</svg>`;
}

// Small inline SVG line chart of overall score across runs (0-100). No deps.
function historyChart(runs, { w = 640, h = 180, pad = 28 } = {}) {
  const pts = runs.map((r, i) => ({ i, score: r.overall })).filter((p) => typeof p.score === 'number');
  if (pts.length < 2) return '<p class="muted">Run at least two audits to see the trend.</p>';
  const n = runs.length;
  const x = (i) => pad + (n === 1 ? 0 : (i * (w - 2 * pad)) / (n - 1));
  const y = (s) => h - pad - (s / 100) * (h - 2 * pad);
  const line = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts[pts.length - 1].i).toFixed(1)},${(h - pad).toFixed(1)} L${x(pts[0].i).toFixed(1)},${(h - pad).toFixed(1)} Z`;
  const dots = pts
    .map((p) => `<circle class="${gradeClass(p.score)}" cx="${x(p.i).toFixed(1)}" cy="${y(p.score).toFixed(1)}" r="4"><title>Run ${p.i + 1}: ${p.score}</title></circle>`)
    .join('');
  const grid = [0, 50, 90, 100]
    .map((v) => `<line class="grid" x1="${pad}" y1="${y(v)}" x2="${w - pad}" y2="${y(v)}"></line><text class="axis" x="4" y="${y(v) + 3}">${v}</text>`)
    .join('');
  return `<svg class="history" viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Overall score across ${n} runs">
  ${grid}
  <path class="area" d="${area}"></path>
  <path class="spark" d="${line}"></path>
  ${dots}
</svg>`;
}

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

// Display metadata for the metrics compare.mjs emits (lcp/inp/cls/fcp/tbt +
// lh-* category scores). lowerBetter drives the improved/regressed colouring.
const METRIC_META = {
  lcp: { label: 'LCP', unit: 'ms', lowerBetter: true },
  inp: { label: 'INP', unit: 'ms', lowerBetter: true },
  cls: { label: 'CLS', unit: '', lowerBetter: true },
  fcp: { label: 'FCP', unit: 'ms', lowerBetter: true },
  tbt: { label: 'TBT', unit: 'ms', lowerBetter: true },
  'lh-performance': { label: 'Lighthouse Performance', unit: '', lowerBetter: false },
  'lh-accessibility': { label: 'Lighthouse Accessibility', unit: '', lowerBetter: false },
  'lh-best-practices': { label: 'Lighthouse Best Practices', unit: '', lowerBetter: false },
  'lh-seo': { label: 'Lighthouse SEO', unit: '', lowerBetter: false },
};

function findingDialog(report, dir, f) {
  const arts = (report.artifacts ?? []).filter((a) => (a.findingIds ?? []).includes(f.id));
  const media = arts
    .map((a) => {
      const rel = `${encodeURI(report.__runId)}/${a.path}`;
      if (a.type === 'screenshot') {
        const inline = dataUri(dir, a.path) ?? rel;
        return `<figure><img loading="lazy" src="${esc(inline)}" alt="${esc(a.caption || 'evidence screenshot')}"><figcaption>${esc(a.caption || '')}${a.condition ? ` <span class="cond">(${esc(a.condition)})</span>` : ''}</figcaption></figure>`;
      }
      if (a.type === 'video') {
        return `<figure><video controls preload="none" src="${esc(rel)}"></video><figcaption>${esc(a.caption || 'evidence recording')}${a.condition ? ` <span class="cond">(${esc(a.condition)})</span>` : ''}</figcaption></figure>`;
      }
      return '';
    })
    .join('');
  return `<dialog id="fd-${esc(f.id)}" class="finding-dialog">
  <form method="dialog" class="dialog-head">
    <div><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span> ${f.effort ? `<span class="effort">${esc(f.effort)} effort</span>` : ''}</div>
    <button class="x" aria-label="Close" value="close">${ICON.close}</button>
  </form>
  <h3>${esc(f.summary)}</h3>
  <p class="meta">${esc(f.principleId)}${f.guidanceId ? ` &middot; guidance: ${esc(f.guidanceId)}` : ''}${f.url ? ` &middot; <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.url)}</a>` : ''}</p>
  ${f.evidence ? `<h4>Evidence</h4><p>${esc(f.evidence)}</p>` : ''}
  ${f.suggestedFix ? `<h4>Suggested fix</h4><p>${esc(f.suggestedFix)}</p>` : ''}
  ${media ? `<h4>Captured evidence</h4><div class="media">${media}</div>` : ''}
</dialog>`;
}

// --- Icons (inline SVG, never emoji) ---------------------------------------
const ICON = {
  close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13 2L4 14h6l-1 8 9-12h-6z"/></svg>',
  arrowUp: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  arrowDown: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M18 13l-6 6-6-6"/></svg>',
};

// --- Page rendering ---------------------------------------------------------

export function renderScorecard(data) {
  const { host, generatedAt, latest, runs } = data;
  const report = latest.report;
  report.__runId = latest.runId;

  // Top-3 actions from the prioritised task list.
  const findingById = new Map((report.findings ?? []).map((f) => [f.id, f]));
  const top3 = [...(report.taskList ?? [])]
    .filter((t) => t.status !== 'done')
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .slice(0, 3);

  const gaugeCards = latest.outcomes
    .map(
      (o) => `<button class="outcome ${gradeClass(o.score)}" data-jump="findings" aria-label="${esc(o.label)}: ${o.score == null ? 'not applicable' : o.score}">
    ${gauge(o.score, { size: 116 })}
    <div class="outcome-label">${esc(o.label)}</div>
    <div class="outcome-blurb">${esc(o.blurb)}</div>
  </button>`,
    )
    .join('\n');

  const top3Html = top3.length
    ? top3
        .map((t) => {
          const f = (t.findingIds ?? []).map((id) => findingById.get(id)).find(Boolean);
          const sev = f?.severity ?? 'medium';
          const open = f ? ` data-open="fd-${esc(f.id)}"` : '';
          return `<li class="action ${esc(sev)}"${open} ${f ? 'role="button" tabindex="0"' : ''}>
        <span class="rank">${t.priority ?? ''}</span>
        <span class="action-title">${esc(t.title)}</span>
        <span class="sev ${esc(sev)}">${esc(sev)}</span>
      </li>`;
        })
        .join('\n')
    : '<li class="muted">No outstanding actions — every applicable principle passed.</li>';

  // Findings grouped by outcome.
  const findingsByOutcome = OUTCOMES.map((o) => {
    const items = (report.findings ?? [])
      .filter((f) => PRINCIPLE_OUTCOME.get(f.principleId) === o.key)
      .sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0));
    return { o, items };
  }).filter((g) => g.items.length);

  const findingsHtml = findingsByOutcome.length
    ? findingsByOutcome
        .map(
          (g) => `<section class="fgroup">
      <h3>${esc(g.o.label)} <span class="count">${g.items.length}</span></h3>
      <ul class="flist">
        ${g.items
          .map(
            (f) => `<li class="fitem ${esc(f.severity)}" data-open="fd-${esc(f.id)}" role="button" tabindex="0">
          <span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>
          <span class="fsummary">${esc(f.summary)}</span>
          ${f.effort ? `<span class="effort">${esc(f.effort)}</span>` : ''}
        </li>`,
          )
          .join('\n')}
      </ul>
    </section>`,
        )
        .join('\n')
    : '<p class="muted">No findings on the latest run.</p>';

  const dialogs = (report.findings ?? []).map((f) => findingDialog(report, latest.dir, f)).join('\n');

  // History rows.
  const historyRows = runs
    .map((r, i) => {
      const d = r.report.auditedAt ? new Date(r.report.auditedAt).toISOString().slice(0, 16).replace('T', ' ') : r.runId;
      const outstanding = (r.report.findings ?? []).length;
      return `<tr${r.runId === latest.runId ? ' class="current"' : ''}>
      <td>${i + 1}</td>
      <td>${esc(d)}</td>
      <td><span class="pill ${r.report.mode === 'fix' ? 'fix' : 'report'}">${esc(r.report.mode ?? 'report')}</span></td>
      <td><span class="score-chip ${gradeClass(r.overall)}">${r.overall == null ? 'N/A' : r.overall}</span></td>
      <td>${outstanding} finding${outstanding === 1 ? '' : 's'}</td>
    </tr>`;
    })
    .join('\n');

  // Before/after from the latest compare.
  const cmp = latest.compare;
  let beforeAfter = '<p class="muted">No before/after yet. Run <code>web-uplift fix</code> or a second audit and it appears here.</p>';
  if (cmp) {
    const s = cmp.summary ?? {};
    const metricRows = (cmp.metrics ?? [])
      .filter((m) => m && m.metric)
      .map((m) => {
        const meta = METRIC_META[m.metric] ?? { label: m.metric, unit: '', lowerBetter: true };
        // Direction: for timing metrics (lcp/inp/cls/fcp/tbt) a drop is an
        // improvement; for the Lighthouse category scores a rise is.
        let dir = 'na';
        if (typeof m.delta === 'number' && m.delta !== 0) {
          const improved = meta.lowerBetter ? m.delta < 0 : m.delta > 0;
          dir = improved ? 'good' : 'poor';
        }
        const arrow = dir === 'good' ? ICON.arrowDown : dir === 'poor' ? ICON.arrowUp : '';
        const fmt = (v) => (v == null ? '—' : `${v}${meta.unit}`);
        const deltaTxt = typeof m.delta === 'number' ? `${m.delta > 0 ? '+' : ''}${m.delta}${meta.unit}` : '';
        return `<tr><td>${esc(meta.label)}</td><td>${esc(fmt(m.before))}</td><td>${esc(fmt(m.after))}</td><td class="${dir}">${arrow} ${esc(deltaTxt)}</td></tr>`;
      })
      .join('');
    const pairs = (cmp.screenshotPairs ?? [])
      .map((p) => {
        const beforeSrc = p.before ? (dataUri(join(latest.dir, '..', cmp.runA), p.before) ?? '') : '';
        const afterSrc = p.after ? (dataUri(join(latest.dir, '..', cmp.runB), p.after) ?? '') : '';
        if (!beforeSrc && !afterSrc) return '';
        return `<div class="ba-pair"><figure><figcaption>Before</figcaption>${beforeSrc ? `<img loading="lazy" src="${esc(beforeSrc)}" alt="before">` : '<div class="noimg">n/a</div>'}</figure><figure><figcaption>After</figcaption>${afterSrc ? `<img loading="lazy" src="${esc(afterSrc)}" alt="after">` : '<div class="noimg">n/a</div>'}</figure><p class="ba-cap">${esc(p.caption || p.condition || '')}</p></div>`;
      })
      .join('');
    beforeAfter = `<div class="ba-summary">
      <div class="ba-stat good"><strong>${s.resolved ?? 0}</strong> resolved</div>
      <div class="ba-stat ${(s.newlyIntroduced ?? 0) > 0 ? 'poor' : 'na'}"><strong>${s.newlyIntroduced ?? 0}</strong> new</div>
      <div class="ba-stat na"><strong>${s.persisting ?? 0}</strong> persisting</div>
      <div class="ba-stat good"><strong>${s.principlesImproved ?? 0}</strong> principles improved</div>
    </div>
    ${metricRows ? `<h4>Core Web Vitals</h4><table class="metrics"><thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Change</th></tr></thead><tbody>${metricRows}</tbody></table>` : ''}
    ${pairs ? `<h4>Before / after</h4><div class="ba-pairs">${pairs}</div>` : ''}`;
  }

  const overallCls = gradeClass(latest.overall);
  const auditedAt = report.auditedAt ? new Date(report.auditedAt).toISOString().slice(0, 16).replace('T', ' ') : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>web-uplift scorecard — ${esc(host)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="topbar">
  <div class="brand">web-uplift <span class="muted">scorecard</span></div>
  <div class="host">${esc(report.url || host)}</div>
</header>

<main>
  <section class="hero ${overallCls}">
    <div class="hero-gauge">${gauge(latest.overall, { size: 168, stroke: 12 })}</div>
    <div class="hero-copy">
      <h1>Overall quality</h1>
      <p>${esc(host)} scores <strong>${latest.overall == null ? 'N/A' : latest.overall}/100</strong> across the six outcomes that matter to your visitors and to search &amp; AI crawlers. Audited ${esc(auditedAt)}${report.page?.appType ? ` &middot; ${esc(report.page.appType.toUpperCase())}${report.page?.framework ? ` (${esc(report.page.framework)})` : ''}` : ''}.</p>
      <div class="do-first">
        <h2>${ICON.bolt} If you do nothing else, do these</h2>
        <ol class="actions">${top3Html}</ol>
      </div>
    </div>
  </section>

  <nav class="tabs" role="tablist">
    <button class="tab active" data-tab="overview" role="tab" aria-selected="true">Outcomes</button>
    <button class="tab" data-tab="findings" role="tab" aria-selected="false">Findings <span class="count">${(report.findings ?? []).length}</span></button>
    <button class="tab" data-tab="history" role="tab" aria-selected="false">History <span class="count">${runs.length}</span></button>
    <button class="tab" data-tab="beforeafter" role="tab" aria-selected="false">Before / after</button>
  </nav>

  <section class="panel active" id="overview" role="tabpanel">
    <div class="outcomes">${gaugeCards}</div>
  </section>

  <section class="panel" id="findings" role="tabpanel">
    ${findingsHtml}
  </section>

  <section class="panel" id="history" role="tabpanel">
    ${historyChart(runs)}
    <table class="runs"><thead><tr><th>#</th><th>Audited</th><th>Mode</th><th>Score</th><th>Findings</th></tr></thead><tbody>${historyRows}</tbody></table>
  </section>

  <section class="panel" id="beforeafter" role="tabpanel">
    ${beforeAfter}
  </section>
</main>

<footer class="foot">Generated ${esc(generatedAt)} by web-uplift. Scores roll the model's 17 quality principles into six owner outcomes; not-applicable and opted-out principles are excluded, never penalised.</footer>

${dialogs}
<script>${JS}</script>
</body>
</html>`;
}

// --- Inline CSS -------------------------------------------------------------
const CSS = `
:root{--bg:#0f1216;--panel:#171b21;--line:#262c35;--txt:#e6e9ee;--muted:#9aa4b2;--good:#12b76a;--ok:#f79009;--poor:#f04438;--na:#5b6472;--accent:#5b8def}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--txt)}
h1,h2,h3,h4{margin:0 0 .4em}
a{color:var(--accent)}
.muted{color:var(--muted)}
.topbar{display:flex;justify-content:space-between;align-items:center;padding:14px 22px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
.brand{font-weight:700;letter-spacing:.2px}
.host{color:var(--muted);font-size:.9rem;word-break:break-all}
main{max-width:1000px;margin:0 auto;padding:22px}
.hero{display:grid;grid-template-columns:auto 1fr;gap:26px;align-items:center;background:var(--panel);border:1px solid var(--line);border-left:6px solid var(--na);border-radius:16px;padding:24px}
.hero.good{border-left-color:var(--good)}.hero.ok{border-left-color:var(--ok)}.hero.poor{border-left-color:var(--poor)}
.hero-copy p{color:var(--muted);margin:.2em 0 1em}
.do-first h2{display:flex;align-items:center;gap:6px;font-size:1rem}
.actions{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.action{display:flex;align-items:center;gap:10px;background:#12161c;border:1px solid var(--line);border-radius:10px;padding:10px 12px;cursor:pointer}
.action:hover{border-color:var(--accent)}
.action .rank{flex:0 0 24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-size:.8rem;font-weight:700}
.action-title{flex:1}
.tabs{display:flex;gap:4px;margin:22px 0 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.tab{background:none;border:none;color:var(--muted);padding:10px 14px;cursor:pointer;font:inherit;border-bottom:2px solid transparent}
.tab.active{color:var(--txt);border-bottom-color:var(--accent)}
.count{display:inline-block;min-width:20px;padding:0 6px;background:var(--line);border-radius:10px;font-size:.75rem;color:var(--muted)}
.panel{display:none;padding:20px 0}
.panel.active{display:block}
.outcomes{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.outcome{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;text-align:center;cursor:pointer;color:inherit;font:inherit}
.outcome:hover{border-color:var(--accent)}
.outcome-label{font-weight:600;margin-top:8px}
.outcome-blurb{color:var(--muted);font-size:.85rem;margin-top:4px}
.gauge{display:block;margin:0 auto}
.gauge-track{stroke:var(--line)}
.gauge .gauge-arc{transition:stroke-dashoffset .8s ease}
.gauge.good .gauge-arc{stroke:var(--good)}.gauge.ok .gauge-arc{stroke:var(--ok)}.gauge.poor .gauge-arc{stroke:var(--poor)}.gauge.na .gauge-arc{stroke:var(--na)}
.gauge-num{fill:var(--txt);font-size:2rem;font-weight:700}
.gauge.na .gauge-num{font-size:1.2rem;fill:var(--muted)}
.fgroup{margin-bottom:18px}
.fgroup h3{display:flex;align-items:center;gap:8px}
.flist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.fitem{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;cursor:pointer}
.fitem:hover{border-color:var(--accent)}
.fsummary{flex:1}
.sev{font-size:.7rem;text-transform:uppercase;letter-spacing:.4px;padding:2px 7px;border-radius:20px;font-weight:700}
.sev.critical{background:#4a1512;color:#ffb4a8}.sev.high{background:#4a2a12;color:#ffd0a8}.sev.medium{background:#3a3212;color:#ffe9a8}.sev.low{background:#1d3320;color:#b6f0c4}
.effort{font-size:.72rem;color:var(--muted);border:1px solid var(--line);border-radius:20px;padding:1px 7px}
.history{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px;margin-bottom:16px}
.history .grid{stroke:var(--line)}.history .axis{fill:var(--muted);font-size:10px}
.history .area{fill:rgba(91,141,239,.12)}
.history .spark{fill:none;stroke:var(--accent);stroke-width:2}
.history circle.good{fill:var(--good)}.history circle.ok{fill:var(--ok)}.history circle.poor{fill:var(--poor)}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}
tr.current{background:#12161c}
.pill{font-size:.72rem;padding:1px 8px;border-radius:20px;border:1px solid var(--line)}
.pill.fix{background:#12261a;color:#8ee0ad}
.score-chip{font-weight:700;padding:2px 9px;border-radius:8px}
.score-chip.good{background:#12261a;color:#7ee2a8}.score-chip.ok{background:#2a2110;color:#ffcf8a}.score-chip.poor{background:#2a1310;color:#ff9f92}.score-chip.na{color:var(--muted)}
.ba-summary{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.ba-stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 18px;min-width:120px}
.ba-stat strong{display:block;font-size:1.6rem}
.ba-stat.good strong{color:var(--good)}.ba-stat.poor strong{color:var(--poor)}
.metrics td.good{color:var(--good)}.metrics td.poor{color:var(--poor)}
.ba-pairs{display:flex;flex-direction:column;gap:18px}
.ba-pair{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px}
.ba-pair>figure{display:inline-block;width:calc(50% - 8px);margin:0;vertical-align:top}
.ba-pair img{width:100%;border-radius:8px;border:1px solid var(--line)}
.ba-pair figcaption{color:var(--muted);font-size:.8rem;margin-bottom:4px}
.ba-cap{color:var(--muted);font-size:.85rem;margin:.6em 0 0}
.noimg{aspect-ratio:16/10;display:grid;place-items:center;color:var(--muted);border:1px dashed var(--line);border-radius:8px}
.finding-dialog{max-width:640px;width:calc(100% - 32px);border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--txt);padding:0 22px 22px}
.finding-dialog::backdrop{background:rgba(0,0,0,.6)}
.dialog-head{display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:var(--panel);padding:16px 0 8px;margin:0}
.dialog-head .x{background:none;border:none;color:var(--muted);cursor:pointer;padding:4px;border-radius:6px}
.dialog-head .x:hover{color:var(--txt);background:var(--line)}
.finding-dialog h3{margin-top:4px}
.finding-dialog .meta{color:var(--muted);font-size:.85rem;word-break:break-word}
.finding-dialog h4{margin-top:16px;font-size:.8rem;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
.media{display:flex;flex-direction:column;gap:14px}
.media figure{margin:0}
.media img,.media video{width:100%;border-radius:8px;border:1px solid var(--line)}
.media figcaption{color:var(--muted);font-size:.8rem;margin-top:4px}
.cond{opacity:.8}
.foot{max-width:1000px;margin:0 auto;padding:22px;color:var(--muted);font-size:.82rem;border-top:1px solid var(--line)}
@media(max-width:640px){.hero{grid-template-columns:1fr;text-align:center}.ba-pair>figure{width:100%}}
`;

// --- Inline JS (minimal; native <dialog> for the deep-dive) -----------------
const JS = `
(function(){
  // Tabs.
  var tabs=[].slice.call(document.querySelectorAll('.tab'));
  var panels=[].slice.call(document.querySelectorAll('.panel'));
  function show(id){
    tabs.forEach(function(t){var on=t.dataset.tab===id;t.classList.toggle('active',on);t.setAttribute('aria-selected',on?'true':'false');});
    panels.forEach(function(p){p.classList.toggle('active',p.id===id);});
  }
  tabs.forEach(function(t){t.addEventListener('click',function(){show(t.dataset.tab);});});
  document.querySelectorAll('[data-jump]').forEach(function(el){el.addEventListener('click',function(){show(el.dataset.jump);});});
  // Deep-dive dialogs: any element with data-open="<dialogId>" opens it.
  function openFor(el){var id=el.getAttribute('data-open');if(!id)return;var d=document.getElementById(id);if(d&&d.showModal){d.showModal();}}
  document.querySelectorAll('[data-open]').forEach(function(el){
    el.addEventListener('click',function(){openFor(el);});
    el.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();openFor(el);}});
  });
  // Click-outside (light dismiss) for dialogs.
  document.querySelectorAll('dialog.finding-dialog').forEach(function(d){
    d.addEventListener('click',function(e){if(e.target===d){d.close();}});
  });
})();
`;

// --- CLI --------------------------------------------------------------------

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
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
  let out = null;
  let generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reports') reportsRoot = argv[++i];
    else if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--generated-at') generatedAt = argv[++i];
    else positional.push(argv[i]);
  }
  const hostArg = positional[0];
  if (!hostArg) {
    console.error('Usage: web-uplift scorecard <host|url> [--reports <dir>] [--out <file>]');
    process.exit(1);
  }
  const host = hostSlug(hostArg);
  const hostRoot = join(reportsRoot, host);
  console.log(`[scorecard] host=${host} reports=${reportsRoot}`);
  const data = buildScorecardData(hostRoot, host, generatedAt);
  console.log(`[scorecard] ${data.runs.length} run(s); latest=${data.latest.runId} overall=${data.latest.overall}`);
  for (const o of data.latest.outcomes) console.log(`[scorecard]   ${o.key.padEnd(13)} ${o.score == null ? 'N/A' : o.score}`);
  const html = renderScorecard(data);
  const dest = out ?? join(hostRoot, 'scorecard.html');
  writeFileSync(dest, html);
  console.log(`[scorecard] wrote ${dest} (${(html.length / 1024).toFixed(0)} KB)`);
}
