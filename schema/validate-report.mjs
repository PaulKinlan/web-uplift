#!/usr/bin/env node
/** Validate exact atomic check coverage and derived principle outcomes. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [catalogPath, reportPath] = process.argv.slice(2);
if (!catalogPath || !reportPath) {
  console.error('Usage: node schema/validate-report.mjs <principles.json> <report.json>');
  process.exit(2);
}

const catalogBytes = readFileSync(catalogPath);
const catalog = JSON.parse(catalogBytes);
const report = JSON.parse(readFileSync(reportPath));
const checksum = `sha256:${createHash('sha256').update(catalogBytes).digest('hex')}`;
const principles = new Map(catalog.principles.map(p => [p.id, p]));
const expectedPairs = new Set();
for (const principle of catalog.principles) {
  for (const check of principle.checks || []) expectedPairs.add(`${principle.id}/${check.id}`);
}

const errors = [];
if (!Array.isArray(report.evidenceUsed) || report.evidenceUsed.length === 0) errors.push('evidenceUsed must contain the modalities/tools actually used');
const paths = Array.isArray(report.paths) ? report.paths : [];
const pathIds = new Set(paths.map(path => path.id));
if (paths.length === 0) errors.push('at least one exercised path is required');
const artifacts = Array.isArray(report.artifacts) ? report.artifacts : [];
const artifactPaths = new Set(artifacts.map(artifact => artifact.path));
const findings = Array.isArray(report.findings) ? report.findings : [];
const findingIds = new Set(findings.map(finding => finding.id));
const rows = Array.isArray(report.checkOutcomes) ? report.checkOutcomes : [];
if (!Array.isArray(report.checkOutcomes)) errors.push('checkOutcomes must be an array');
const occurrences = new Map();
const byPrinciple = new Map();
const validStatuses = new Set(['pass', 'issues', 'not-applicable', 'opted-out', 'blocked', 'not-run']);
for (const [index, row] of rows.entries()) {
  const pair = `${row.principleId}/${row.checkId}`;
  occurrences.set(pair, (occurrences.get(pair) || 0) + 1);
  if (!byPrinciple.has(row.principleId)) byPrinciple.set(row.principleId, []);
  byPrinciple.get(row.principleId).push(row);
  if (!validStatuses.has(row.status)) errors.push(`checkOutcomes[${index}] has invalid status ${JSON.stringify(row.status)}`);
  if (!['low', 'medium', 'high'].includes(row.confidence)) errors.push(`${pair} requires valid confidence`);
  if (['pass', 'issues'].includes(row.status) && !String(row.evidence || '').trim()) errors.push(`${pair} ${row.status} requires concrete evidence`);
  if (['pass', 'issues'].includes(row.status) && !(row.pathIds?.length || row.artifacts?.length)) errors.push(`${pair} ${row.status} requires at least one pathIds or artifacts evidence reference`);
  for (const pathId of row.pathIds || []) if (!pathIds.has(pathId)) errors.push(`${pair} references unknown pathId ${pathId}`);
  for (const artifact of row.artifacts || []) if (!artifactPaths.has(artifact)) errors.push(`${pair} references unknown artifact ${artifact}`);
  if (row.status === 'issues' && (!Array.isArray(row.findingIds) || row.findingIds.length === 0)) errors.push(`${pair} issues requires findingIds`);
  for (const findingId of row.findingIds || []) if (!findingIds.has(findingId)) errors.push(`${pair} references unknown findingId ${findingId}`);
  if (['not-applicable', 'opted-out', 'blocked', 'not-run'].includes(row.status) && !String(row.reason || '').trim()) errors.push(`${pair} ${row.status} requires a reason`);
  if (!String(row.method || '').trim()) errors.push(`${pair} requires a method used or attempted`);
}

const missing = [...expectedPairs].filter(pair => !occurrences.has(pair));
const unknown = [...occurrences].filter(([pair]) => !expectedPairs.has(pair)).flatMap(([pair, count]) => Array(count).fill(pair));
const duplicateCount = [...occurrences.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
const statusCount = status => rows.filter(row => expectedPairs.has(`${row.principleId}/${row.checkId}`) && row.status === status).length;
const blocked = statusCount('blocked');
const notRun = statusCount('not-run');
const judged = ['pass', 'issues', 'not-applicable', 'opted-out'].reduce((sum, status) => sum + statusCount(status), 0);
const complete = missing.length === 0 && unknown.length === 0 && duplicateCount === 0 && blocked === 0 && notRun === 0 && rows.length === expectedPairs.size;

const principleRows = Array.isArray(report.principleOutcomes) ? report.principleOutcomes : [];
const principleOccurrences = new Map();
for (const row of principleRows) principleOccurrences.set(row.principleId, (principleOccurrences.get(row.principleId) || 0) + 1);
for (const id of principles.keys()) {
  if (!principleOccurrences.has(id)) errors.push(`missing principleOutcome ${id}`);
  if ((principleOccurrences.get(id) || 0) > 1) errors.push(`duplicate principleOutcome ${id}`);
}
for (const id of principleOccurrences.keys()) if (!principles.has(id)) errors.push(`unknown principleOutcome ${id}`);

function derive(rowsForPrinciple) {
  const statuses = rowsForPrinciple.map(row => row.status);
  if (statuses.includes('issues')) return 'issues';
  if (statuses.some(status => status === 'blocked' || status === 'not-run')) return 'incomplete';
  if (statuses.length && statuses.every(status => status === 'not-applicable')) return 'not-applicable';
  if (statuses.length && statuses.every(status => status === 'opted-out')) return 'opted-out';
  if (statuses.length && statuses.every(status => ['pass', 'not-applicable', 'opted-out'].includes(status)) && statuses.includes('pass')) return 'pass';
  return 'incomplete';
}
for (const outcome of principleRows) {
  if (!principles.has(outcome.principleId)) continue;
  const principle = principles.get(outcome.principleId);
  const principleChecks = byPrinciple.get(outcome.principleId) || [];
  const derived = derive(principleChecks);
  if (outcome.status !== derived) errors.push(`${outcome.principleId} status ${outcome.status} does not match derived ${derived}`);
  if (outcome.expectation !== principle.applicability?.expectation) errors.push(`${outcome.principleId} expectation ${outcome.expectation} does not match catalog ${principle.applicability?.expectation}`);
  if (['incomplete', 'not-applicable', 'opted-out'].includes(outcome.status) && !String(outcome.reason || '').trim()) errors.push(`${outcome.principleId} ${outcome.status} requires a reason`);
  if (principle.applicability?.expectation === 'default' && principleChecks.length && principleChecks.every(row => row.status === 'not-applicable')) errors.push(`${outcome.principleId} is default and cannot mark every check not-applicable`);
}
if (rows.some(row => row.status === 'opted-out') && report.config?.loaded !== true) errors.push('opted-out checks require config.loaded=true and declared configuration');

const expectedCoverage = {
  catalogVersion: catalog.guidanceCatalogVersion || catalog.version || 'unversioned',
  catalogChecksum: checksum,
  expected: expectedPairs.size,
  recorded: rows.length,
  judged,
  blocked,
  notRun,
  missing: missing.length,
  unknown: unknown.length,
  duplicates: duplicateCount,
  complete,
};
if (!report.coverage || typeof report.coverage !== 'object') {
  errors.push('coverage object is required');
} else {
  for (const [key, value] of Object.entries(expectedCoverage)) {
    if (report.coverage[key] !== value) errors.push(`coverage.${key}=${JSON.stringify(report.coverage[key])}; expected ${JSON.stringify(value)}`);
  }
}
if (complete && report.status !== 'completed') errors.push(`complete coverage requires report status completed, got ${report.status}`);
if (!complete && report.status === 'completed') errors.push('incomplete coverage cannot use report status completed');
if (!complete && ('overallScore' in report || 'score' in report)) errors.push('incomplete coverage cannot publish a score');
if (!complete) errors.push('atomic check coverage is incomplete; this report is partial and fails the publication gate');

const summary = {
  expected: expectedPairs.size,
  recorded: rows.length,
  judged,
  blocked,
  notRun,
  missing: missing.length,
  unknown: unknown.length,
  duplicates: duplicateCount,
  complete,
  errors: errors.length,
};
console.log(JSON.stringify(summary, null, 2));
if (missing.length) console.error(`Missing (first 20): ${missing.slice(0, 20).join(', ')}`);
if (unknown.length) console.error(`Unknown (first 20): ${unknown.slice(0, 20).join(', ')}`);
for (const error of errors) console.error(`ERROR: ${error}`);
process.exit(errors.length ? 1 : 0);
