#!/usr/bin/env node
/**
 * Merge report.json files (any depth under the reports dir - the batch
 * runner writes reports/<agent>/<site>/report.json) into a cross-site
 * summary: which modern-UX principles are violated most, which Modern Web
 * Guidance categories show up most, severity distribution, and a per-agent
 * breakdown for cross-agent comparison.
 *
 *   node aggregate/aggregate.mjs [--reports reports] [--out reports/summary.md]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

const reportsDir = argValue('--reports') ?? 'reports';
const outFile = argValue('--out') ?? join(reportsDir, 'summary.md');

const sites = [];
const entries = await readdir(reportsDir, { recursive: true, withFileTypes: true }).catch(() => []);
for (const entry of entries) {
  if (!entry.isFile() || entry.name !== 'report.json') continue;
  const path = join(entry.parentPath ?? entry.path, entry.name);
  try {
    const report = JSON.parse(await readFile(path, 'utf8'));
    // reports/<agent>/<site>/report.json - first path segment under the
    // reports dir is the agent name (older flat layouts fall back to "claude").
    const rel = path.slice(reportsDir.length + 1).split(sep);
    report.agent = rel.length > 2 ? rel[0] : 'claude';
    sites.push(report);
  } catch {
    /* unreadable report - skip */
  }
}

if (!sites.length) {
  console.error(`No report.json files found under ${reportsDir}/ - run an audit first.`);
  process.exit(1);
}

const completed = sites.filter((s) => s.status === 'completed' || s.status === 'partial');
const findings = completed.flatMap((s) =>
  (s.findings ?? []).map((f) => ({ ...f, url: s.url, agent: s.agent, framework: s.page?.framework }))
);

const byPrinciple = tally(findings, (f) => f.principleId);
const byGuidanceCategory = tally(findings, (f) => f.guidanceCategory);
const byGuidanceId = tally(findings.filter((f) => f.guidanceId), (f) => f.guidanceId);
const bySeverity = tally(findings, (f) => f.severity);
const byAgent = tally(findings, (f) => f.agent);
const agentsSeen = new Set(sites.map((s) => s.agent));
const sitesWithFindings = new Set(findings.map((f) => f.url)).size;

const md = `# Modern web UX survey summary

- Audit runs: ${sites.length} (${completed.length} completed, ${sites.length - completed.length} blocked/errored)
- Sites with at least one finding: ${sitesWithFindings} (${pct(sitesWithFindings, completed.length)})
- Total findings: ${findings.length}

## Findings by principle violated
${table(byPrinciple, findings.length)}

## Findings by guidance category
${table(byGuidanceCategory, findings.length)}

## Top guidance use cases referenced
${byGuidanceId.length ? table(byGuidanceId.slice(0, 15), findings.length) : '_none referenced yet_'}

## Findings by severity
${table(bySeverity, findings.length)}
${agentsSeen.size > 1 ? `\n## Findings by agent\n${table(byAgent, findings.length)}\n` : ''}`;

await writeFile(outFile, md);
console.log(md);
console.log(`-> written to ${outFile}`);

function tally(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const k = keyFn(item) ?? 'unknown';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function table(rows, total) {
  return ['| | count | share |', '|---|---|---|']
    .concat(rows.map(([k, n]) => `| ${k} | ${n} | ${pct(n, total)} |`))
    .join('\n');
}

function pct(n, total) {
  return total ? `${Math.round((n / total) * 100)}%` : '-';
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
