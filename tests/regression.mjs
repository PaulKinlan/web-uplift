#!/usr/bin/env node
import http from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { gather } from '../evidence/cli.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), 'web-uplift-regression-'));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'reports', 'scratch']);

try {
  testSyntaxChecks();
  testPackageRootImportIsSideEffectFree();
  testSchemaValidation();
  testAtomicCoverageValidator();
  testGuidanceUsage();
  testInstalledEvidenceCli();
  testUpdateDryRunReadsInstallManifest();
  testCachedUpdateWarning();
  await testPreNavigationEmulation();
  await testAxePrimitiveBypassesStrictCsp();
  await testHarRedirects();
  await testEvidenceTruncationReporting();
  await testConsoleEvidence();
  await testFeaturesPrimitive();
  testBatchDryRunUsesRetainedDirs();
  testBatchFlowDryRun();
  testFixSurvivesUnscoreableReports();
  testFixRefusesPassOnIncompleteCoverage();
  testFixRejectsMalformedReports();
  await testCompareReportsUnconcludedChecks();
  await testScorecardScoringAndRender();
  await testDiscoverabilityHelpers();
  await testDiscoverabilityH1InRaw();
  await testTargetsPrimitive();
  await testFlowNormalize();
  console.log('tests OK');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// Modern Web Guidance is mandatory: a report with issue-findings must record the
// guides it consulted, and every issue-finding must cite a guidanceId drawn from
// that list. This is what stops the "audit judged from memory, never called MWG"
// failure users reported — a report that skipped guidance fails validation here.
function testAtomicCoverageValidator() {
  const validator = join(repoRoot, 'schema', 'validate-report.mjs');
  const catalog = join(repoRoot, 'knowledge', 'principles.json');
  const valid = run(process.execPath, [validator, catalog, join(repoRoot, 'examples', 'playground-report.json')]);
  assert(valid.status === 0, `atomic coverage: valid fixture failed:\n${valid.stderr}\n${valid.stdout}`);

  const incomplete = JSON.parse(readFileSync(join(repoRoot, 'examples', 'playground-report.json'), 'utf8'));
  incomplete.checkOutcomes = incomplete.checkOutcomes.slice(1);
  incomplete.status = 'partial';
  incomplete.coverage = { ...incomplete.coverage, recorded: incomplete.checkOutcomes.length, judged: incomplete.checkOutcomes.length, missing: 1, complete: false };
  delete incomplete.overallScore;
  const incompletePath = join(tmp, 'incomplete-report.json');
  writeFileSync(incompletePath, JSON.stringify(incomplete));
  const rejected = run(process.execPath, [validator, catalog, incompletePath]);
  assert(rejected.status !== 0, `atomic coverage: missing check was not rejected:\n${rejected.stderr}\n${rejected.stdout}`);
}

function testGuidanceUsage() {
  const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));
  const findings = report.findings || [];
  assert(findings.length > 0, 'guidance: fixture should have issue-findings to check');
  const consulted = report.guidanceConsulted || [];
  assert(Array.isArray(consulted) && consulted.length > 0,
    'guidance: a report with issue-findings must populate guidanceConsulted (MWG was not called)');
  const consultedSet = new Set(consulted);
  for (const f of findings) {
    assert(typeof f.guidanceId === 'string' && f.guidanceId.length > 0,
      `guidance: finding ${f.id} is missing a guidanceId (its fix is not backed by Modern Web Guidance)`);
    assert(consultedSet.has(f.guidanceId),
      `guidance: finding ${f.id} cites guidanceId "${f.guidanceId}" that is not in guidanceConsulted`);
  }
  // The clean/fixed report may have no findings, but if it lists guidance it must be an array.
  const fixed = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  assert(fixed.guidanceConsulted === undefined || Array.isArray(fixed.guidanceConsulted),
    'guidance: fixed report guidanceConsulted must be an array when present');
}

// follow-best-practices/no-console-errors needs first-party evidence: what the
// page logged DURING load is invisible to a post-load evaluate probe, so the
// console primitive collects Runtime + Log events from before the navigation.
// The counts are split by source so a failed subresource request is not
// confused with a page-authored console error (web-uplift-2dg).
async function testConsoleEvidence() {
  const noisy = [
    '<!doctype html><html><head><title>noisy</title><script>',
    "  console.warn('fixture warning');",
    "  console.error('fixture console error');",
    "  console.error('fixture console error');",
    "  setTimeout(function () { throw new Error('fixture uncaught exception'); }, 0);",
    "  fetch('/missing.json').catch(function () {});",
    '</script></head><body><p>Deterministic console story.</p></body></html>',
  ].join('\n');
  const clean = '<!doctype html><html><head><title>clean</title></head><body><p>Nothing is logged here.</p>' +
    '<button id="boom">boom</button>' +
    "<script>document.querySelector('#boom').addEventListener('click', function () { throw new Error('fixture interact exception'); });</script>" +
    '</body></html>';

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === '/clean') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(clean);
      return;
    }
    if (path === '/noisy') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(noisy);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const result = await gather('console', `${base}/noisy`, { quiet: true, wait: 500 });
    const block = result.console;
    assert(
      block.exceptionCount === 1 && block.entries.some((e) => e.kind === 'exception' && e.text.includes('fixture uncaught exception')),
      `console: the load-time exception was not captured: ${JSON.stringify(block)}`,
    );
    assert(
      block.consoleErrorCount === 1 && block.entries.some((e) => e.text.includes('fixture console error')),
      `console: the load-time console error was not captured: ${JSON.stringify(block)}`,
    );
    assert(
      block.warningCount === 1 && block.entries.some((e) => e.text.includes('fixture warning')),
      `console: the console warning was not captured: ${JSON.stringify(block)}`,
    );
    assert(
      block.networkErrorCount === 1 && block.entries.some((e) => e.source === 'network' && (e.url || '').endsWith('/missing.json')),
      `console: the failed subresource request was not captured separately: ${JSON.stringify(block)}`,
    );
    assert(block.hasErrors === true, `console: a page that threw should report errors: ${JSON.stringify(block)}`);
    const repeated = block.entries.find((e) => e.text.includes('fixture console error'));
    assert(repeated.repeat === 2, `console: identical messages should collapse into a repeat count: ${JSON.stringify(repeated)}`);
    const exception = block.entries.find((e) => e.kind === 'exception');
    assert(Array.isArray(exception.stack) && exception.stack.length > 0, `console: an exception should carry a stack frame: ${JSON.stringify(exception)}`);

    // Every primitive carries the block, and the artifact a primitive writes has
    // to agree with its stdout: that is what emit() is for.
    const out = join(tmp, 'console-dom-artifact.json');
    const cli = await runAsync(process.execPath, ['evidence/cli.mjs', 'dom', `${base}/noisy`, '--wait', '300', '--out', out]);
    assert(cli.status === 0, `console: dom CLI failed:\n${cli.stderr}`);
    const artifact = JSON.parse(readFileSync(out, 'utf8'));
    const stdout = JSON.parse(cli.stdout);
    assert(
      artifact.console?.exceptionCount === 1 && stdout.console?.exceptionCount === 1,
      `console: the console block should ride along on other primitives, in the artifact and stdout:\n${JSON.stringify({ artifact: artifact.console, stdout: stdout.console })}`,
    );

    // A page that logs nothing reports zeroes: the empty block is the evidence
    // that the check can pass, not the absence of evidence.
    const cleanResult = await gather('console', `${base}/clean`, { quiet: true, wait: 400 });
    assert(
      cleanResult.console.entryCount === 0 && cleanResult.console.hasErrors === false && cleanResult.console.entries.length === 0,
      `console: a page that logs nothing must report zeroes: ${JSON.stringify(cleanResult.console)}`,
    );

    // Interaction errors count too: the same page throws only when its button is
    // clicked, which is exactly the error class a post-load probe cannot see.
    const interactResult = await gather('console', `${base}/clean`, {
      quiet: true,
      wait: 400,
      interact: "setTimeout(() => document.querySelector('#boom').click(), 0)",
    });
    assert(
      interactResult.console.exceptionCount === 1 &&
        interactResult.console.entries.some((e) => e.text.includes('fixture interact exception')),
      `console: an error raised by --interact was not captured: ${JSON.stringify(interactResult.console)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// A report that cannot be SCORED is still a legitimate INPUT to the hill-climb.
// fix.mjs used to seed its history with an unguarded scoreOf(baseline), so
// scoreReport's (correct) refusal to score incomplete atomic coverage killed the
// whole fix run with an unhandled throw - including on every report written
// before the coverage contract existed, which has no `coverage` field at all.
// Those are exactly the reports most in need of fixing.
function testFixSurvivesUnscoreableReports() {
  const complete = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));

  // Two shapes that scoreReport refuses: a partial run, and a pre-contract run.
  const partial = structuredClone(complete);
  partial.coverage.complete = false;
  partial.status = 'partial';
  const legacy = structuredClone(complete);
  delete legacy.coverage;

  const fixtures = { partial, legacy };
  for (const [name, report] of Object.entries(fixtures)) {
    writeFileSync(join(tmp, `fix-${name}.json`), JSON.stringify(report));
  }

  // --max-iterations 0 drives the whole path (baseline -> snapshot -> compare ->
  // scorecard) without spawning an agent or a browser.
  const runFix = (findings, extra = []) => run(process.execPath, [
    'fixer/fix.mjs',
    '--findings', findings,
    '--target', join(tmp, 'fix-src'),
    '--audit-url', 'http://127.0.0.1:9/',
    '--out', join(tmp, `fix-out-${Math.random().toString(36).slice(2)}`),
    '--reports-root', join(tmp, `fix-reports-${Math.random().toString(36).slice(2)}`),
    '--max-iterations', '0',
    ...extra,
  ]);

  for (const name of Object.keys(fixtures)) {
    const result = runFix(join(tmp, `fix-${name}.json`));
    assert(!/Refusing to score[\s\S]*at scoreReport/.test(result.stderr),
      `fix: ${name} report crashed the hill-climb instead of degrading:\n${result.stderr}`);
    assert(result.stdout.includes('Score unavailable:'),
      `fix: ${name} report did not explain why the score is unavailable:\n${result.stdout}`);
    assert(result.stdout.includes('score N/A'),
      `fix: ${name} report should print score N/A in the climb summary:\n${result.stdout}`);
    assert(result.stdout.includes('outstanding issue-findings to climb down'),
      `fix: ${name} report should still climb on outstanding findings:\n${result.stdout}`);
  }

  // An unscoreable report must never MEET a score goal. evaluateGates treats a
  // null outcome as not-applicable and PASSES it, so an all-null summary from a
  // partial report would otherwise satisfy every --goal-min and stop the climb
  // on a target that was never measured.
  const goalRun = runFix(join(tmp, 'fix-partial.json'), ['--goal-overall', '1', '--goal-min', 'discoverable=1']);
  assert(!goalRun.stdout.includes('PASS: score goal met.'),
    `fix: an unscoreable report falsely met a score goal:\n${goalRun.stdout}`);
  assert(goalRun.stdout.includes('atomic coverage complete'),
    `fix: the goal failure should name incomplete coverage as the reason:\n${goalRun.stdout}`);

  // The guard must not cost a complete report its score.
  const completeRun = runFix(join(repoRoot, 'examples/playground-report.json'), ['--goal-overall', '1']);
  assert(completeRun.status === 0, `fix: a complete report with a met goal should exit 0:\n${completeRun.stdout}${completeRun.stderr}`);
  assert(completeRun.stdout.includes('PASS: score goal met.'),
    `fix: a complete report should still meet a met goal:\n${completeRun.stdout}`);
  assert(!completeRun.stdout.includes('Score unavailable:'),
    `fix: a complete report must still be scoreable:\n${completeRun.stdout}`);
}

// The atomic coverage contract: a run carrying blocked or not-run checks is
// PARTIAL, never completed. fix.mjs used to decide pass/fail from findings
// alone, so a report with zero findings and five checks that never concluded
// printed "PASS: no outstanding issues remain." and exited 0 - the exact
// absence-of-evidence failure the contract exists to prevent, reintroduced
// through the fix path after the scorecard had closed it.
function testFixRefusesPassOnIncompleteCoverage() {
  const clean = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  assert((clean.findings ?? []).length === 0, 'fix coverage: the fixed fixture should have no findings');

  // Zero findings, but five checks never concluded: three blocked, two not-run.
  const partial = structuredClone(clean);
  partial.status = 'partial';
  for (let i = 0; i < 3; i++) {
    partial.checkOutcomes[i].status = 'blocked';
    partial.checkOutcomes[i].reason = 'Auth wall blocked this path';
  }
  for (let i = 3; i < 5; i++) {
    partial.checkOutcomes[i].status = 'not-run';
    partial.checkOutcomes[i].reason = 'Never attempted';
  }
  partial.coverage = { ...partial.coverage, judged: 53, blocked: 3, notRun: 2, complete: false };
  delete partial.overallScore;
  writeFileSync(join(tmp, 'fix-zero-findings-partial.json'), JSON.stringify(partial));

  // The same rows, but the report DECLARES itself complete. The checkOutcomes
  // rows are the authority, not the self-declaration, so this must not pass
  // either. Without that rule a report could buy a pass by lying in one field.
  const lying = structuredClone(partial);
  lying.status = 'completed';
  lying.coverage.complete = true;
  writeFileSync(join(tmp, 'fix-lying-complete.json'), JSON.stringify(lying));

  const runFix = (findings, extra = []) => run(process.execPath, [
    'fixer/fix.mjs',
    '--findings', findings,
    '--target', join(tmp, 'fix-src'),
    '--audit-url', 'http://127.0.0.1:9/',
    '--out', join(tmp, `fixcov-out-${Math.random().toString(36).slice(2)}`),
    '--reports-root', join(tmp, `fixcov-reports-${Math.random().toString(36).slice(2)}`),
    '--max-iterations', '0',
    ...extra,
  ]);

  for (const name of ['fix-zero-findings-partial', 'fix-lying-complete']) {
    const result = runFix(join(tmp, `${name}.json`));
    assert(!/^PASS:/m.test(result.stdout),
      `fix coverage: ${name} claimed a pass with unconcluded checks:\n${result.stdout}`);
    assert(result.status === 1,
      `fix coverage: ${name} should exit non-zero, got ${result.status}:\n${result.stdout}`);
    assert(/INCOMPLETE coverage \(3 blocked, 2 not-run\)/.test(result.stdout),
      `fix coverage: ${name} should name the unconcluded checks:\n${result.stdout}`);
    assert(result.stdout.includes('5 unconcluded check(s)'),
      `fix coverage: ${name} should count unconcluded checks in the summary:\n${result.stdout}`);
  }

  // A partial run must not buy a pass through a score goal either.
  const goalRun = runFix(join(tmp, 'fix-lying-complete.json'), ['--goal-overall', '1']);
  assert(!goalRun.stdout.includes('PASS: score goal met.'),
    `fix coverage: a partial run met a score goal:\n${goalRun.stdout}`);
  assert(goalRun.stdout.includes('atomic coverage complete'),
    `fix coverage: the goal failure should name incomplete coverage:\n${goalRun.stdout}`);

  // A pre-contract report has no coverage accounting at all, so its completeness
  // is unverifiable rather than clean. Zero findings is not enough to pass: the
  // run proceeds (that is the acl fix) but cannot claim a completed audit.
  const legacy = structuredClone(clean);
  delete legacy.coverage;
  delete legacy.overallScore;
  writeFileSync(join(tmp, 'fix-legacy-clean.json'), JSON.stringify(legacy));
  const legacyRun = runFix(join(tmp, 'fix-legacy-clean.json'));
  assert(!/^PASS:/m.test(legacyRun.stdout),
    `fix coverage: a report with no coverage accounting claimed a pass:\n${legacyRun.stdout}`);
  assert(legacyRun.stdout.includes('no coverage accounting in the report'),
    `fix coverage: the legacy report should say its coverage is unverifiable:\n${legacyRun.stdout}`);

  // A genuinely clean run (no findings, every check concluded) still passes.
  const cleanRun = runFix(join(repoRoot, 'examples/playground-report-fixed.json'));
  assert(cleanRun.status === 0,
    `fix coverage: a clean complete report should exit 0:\n${cleanRun.stdout}${cleanRun.stderr}`);
  assert(cleanRun.stdout.includes('PASS: no outstanding issues remain and every check concluded.'),
    `fix coverage: a clean complete report should pass:\n${cleanRun.stdout}`);
  assert(cleanRun.stdout.includes('0 unconcluded check(s)'),
    `fix coverage: a clean report should report zero unconcluded checks:\n${cleanRun.stdout}`);
}

// A structurally malformed report is invalid INPUT, not a crash (web-uplift-rj2).
// countOutstanding runs before the score safety net, so a non-array
// principleOutcomes or findings used to die with "x.filter is not a function" and
// a raw stack, and a non-array checkOutcomes was silently ignored, which let a
// zero-findings report print PASS. The shape is now validated once, at read time,
// and reported by name.
function testFixRejectsMalformedReports() {
  const complete = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));

  const runFix = (findings) => run(process.execPath, [
    'fixer/fix.mjs',
    '--findings', findings,
    '--target', join(tmp, 'fix-src'),
    '--audit-url', 'http://127.0.0.1:9/',
    '--out', join(tmp, `fixshape-out-${Math.random().toString(36).slice(2)}`),
    '--reports-root', join(tmp, `fixshape-reports-${Math.random().toString(36).slice(2)}`),
    '--max-iterations', '0',
  ]);

  // Present but not an array: a named error, exit 1, no raw TypeError, no PASS.
  const malformed = {
    'shape-principle-outcomes': { principleOutcomes: {} },
    'shape-findings': { findings: {} },
    'shape-findings-string': { findings: 'not an array' },
    'shape-check-outcomes': { checkOutcomes: {} },
    'shape-artifacts': { artifacts: {} },
  };
  for (const [name, patch] of Object.entries(malformed)) {
    const path = join(tmp, `${name}.json`);
    const field = Object.keys(patch)[0];
    writeFileSync(path, JSON.stringify({ ...complete, ...patch }));
    const result = runFix(path);
    assert(result.status === 1,
      `fix shape: ${name} should exit 1, got ${result.status}:\n${result.stdout}${result.stderr}`);
    assert(
      result.stderr.includes(`Invalid report at ${path}: "${field}" must be an array`),
      `fix shape: ${name} should fail with a named shape error:\n${result.stderr}`,
    );
    assert(!/is not a function|is not iterable|Cannot read propert/.test(result.stderr),
      `fix shape: ${name} leaked a raw TypeError:\n${result.stderr}`);
    assert(!/^PASS:/m.test(result.stdout),
      `fix shape: ${name} must not pass:\n${result.stdout}`);
  }

  // A whole file that is not an object at all is the same class of input error.
  for (const [name, body] of [['shape-root-string', '"just a string"'], ['shape-root-array', '[1,2,3]']]) {
    const path = join(tmp, `${name}.json`);
    writeFileSync(path, body);
    const result = runFix(path);
    assert(
      result.status === 1 && result.stderr.includes(`Invalid report at ${path}: expected a JSON object`),
      `fix shape: ${name} should fail with a named shape error:\n${result.stderr}`,
    );
  }

  // The guard must not reject legal reports: absent and null fields stay legal
  // (pre-contract reports have no coverage or checkOutcomes at all), and a clean
  // report still runs through to its pass.
  const nullish = { ...structuredClone(complete), principleOutcomes: null, findings: [] };
  const nullishPath = join(tmp, 'shape-nullish.json');
  writeFileSync(nullishPath, JSON.stringify(nullish));
  const nullishRun = runFix(nullishPath);
  assert(
    nullishRun.status === 0 && !/Invalid report at/.test(nullishRun.stderr),
    `fix shape: null/empty fields must stay legal:\n${nullishRun.stdout}${nullishRun.stderr}`,
  );

  const legacy = structuredClone(complete);
  delete legacy.coverage;
  delete legacy.checkOutcomes;
  const legacyPath = join(tmp, 'shape-legacy.json');
  writeFileSync(legacyPath, JSON.stringify(legacy));
  const legacyRun = runFix(legacyPath);
  assert(
    !/Invalid report at/.test(legacyRun.stderr) && legacyRun.stdout.includes('Baseline:'),
    `fix shape: a pre-contract report must stay legal input:\n${legacyRun.stdout}${legacyRun.stderr}`,
  );
}

// A compare between two PARTIAL runs used to print "Outstanding
// issue-findings: 0 -> 0" while checks never concluded in either run, which
// reads as "nothing left to do". compare.mjs had its own findings-only copy of
// countOutstanding (fix.mjs had already grown completionState); the shared
// runner/remaining-work.mjs module is now the single definition both callers
// use, and compare reports the unconcluded checks for BOTH sides with a delta.
async function testCompareReportsUnconcludedChecks() {
  const { compareReports, renderCompareMd } = await import('../aggregate/compare.mjs');
  const clean = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  assert((clean.findings ?? []).length === 0, 'compare: the fixed fixture should have no findings');

  const makePartial = (blocked, notRun) => {
    const r = structuredClone(clean);
    r.status = 'partial';
    const rows = r.checkOutcomes;
    for (let i = 0; i < blocked; i++) { rows[i].status = 'blocked'; rows[i].reason = 'Auth wall blocked this path'; }
    for (let i = blocked; i < blocked + notRun; i++) { rows[i].status = 'not-run'; rows[i].reason = 'Never attempted'; }
    r.coverage = { ...r.coverage, judged: rows.length - blocked - notRun, blocked, notRun, complete: false };
    delete r.overallScore;
    return r;
  };

  const before = makePartial(3, 2); // 5 unconcluded
  const after = makePartial(1, 0);  // 1 unconcluded: four concluded, no finding resolved
  const cmp = compareReports(before, after);
  assert(cmp.summary.unconcludedBefore === 5,
    `compare: unconcludedBefore should be 5, got ${cmp.summary.unconcludedBefore}`);
  assert(cmp.summary.unconcludedAfter === 1,
    `compare: unconcludedAfter should be 1, got ${cmp.summary.unconcludedAfter}`);
  assert(cmp.before.unconcluded === 5 && cmp.after.unconcluded === 1,
    'compare: before/after blocks should carry the unconcluded counts');

  const md = renderCompareMd(cmp, { hostName: 'example.test' });
  assert(md.includes('Outstanding issue-findings:** 0 -> 0'),
    `compare: findings line should still render:\n${md}`);
  assert(md.includes('Unconcluded checks (blocked/not-run):** 5 -> 1 (-4)'),
    `compare: the unconcluded line must state BOTH sides and the delta:\n${md}`);

  // Same module, same counts as the hill-climb gate: fix.mjs and compare.mjs
  // must never disagree about what remains.
  const { countOutstanding, completionState, remaining } = await import('../runner/remaining-work.mjs');
  assert(countOutstanding(before) === 0 && completionState(before).blocked === 3 && completionState(before).notRun === 2,
    'remaining-work: shared module should see the partial before-run');
  assert(remaining(before).total === 5 && remaining(after).total === 1,
    'remaining-work: total should be findings + blocked + not-run');
}

async function testScorecardScoringAndRender() {
  const { scoreReport, renderScorecard, renderTextScorecard, scorecardSummary, evaluateGates, OUTCOMES } = await import('../aggregate/scorecard.mjs');
  const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));

  const scored = scoreReport(report);
  const incomplete = structuredClone(report);
  incomplete.coverage.complete = false;
  let refusedIncomplete = false;
  try { scoreReport(incomplete); } catch (error) { refusedIncomplete = /Refusing to score/.test(error.message); }
  assert(refusedIncomplete, 'scorecard: incomplete atomic coverage must be refused');
  // The 9-finding playground should not be perfect, and must not exceed 100.
  assert(typeof scored.overall === 'number', 'scorecard: overall should be numeric for the playground report');
  assert(scored.overall > 0 && scored.overall < 100, `scorecard: expected an imperfect overall, got ${scored.overall}`);
  assert(scored.outcomes.length === OUTCOMES.length, 'scorecard: every outcome should be represented');
  for (const o of scored.outcomes) {
    assert(o.score === null || (o.score >= 0 && o.score <= 100), `scorecard: ${o.key} score out of range: ${o.score}`);
  }
  // A clean report scores 100 with no findings.
  const fixed = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  assert(scoreReport(fixed).overall === 100, 'scorecard: a findings-free report should score 100');

  // The rendered page must be self-contained and well-formed enough to open.
  report.__runId = 'r1';
  const html = renderScorecard({
    host: 'example',
    generatedAt: '2026-01-01 00:00',
    runs: [{ runId: 'r1', dir: join(repoRoot, 'examples'), report, compare: null, ...scored }],
    latest: { runId: 'r1', dir: join(repoRoot, 'examples'), report, compare: null, ...scored },
  });
  assert(html.startsWith('<!doctype html>'), 'scorecard: HTML should start with a doctype');
  assert(!html.includes('${'), 'scorecard: HTML contains an unresolved template placeholder');
  assert(!/>\s*undefined\s*</.test(html), 'scorecard: HTML contains a literal undefined');
  const openDialogs = (html.match(/<dialog /g) || []).length;
  const closeDialogs = (html.match(/<\/dialog>/g) || []).length;
  assert(openDialogs === closeDialogs && openDialogs >= report.findings.length, 'scorecard: dialog tags are unbalanced');

  // The inline text scorecard leads with the overall + a link, same numbers.
  const text = renderTextScorecard(
    { host: 'example', latest: { runId: 'r1', dir: join(repoRoot, 'examples'), report, ...scored } },
    { htmlPath: 'reports/example/scorecard.html' },
  );
  assert(text.includes(`Overall: ${scored.overall}/100`), 'scorecard text: overall line missing/mismatched');
  assert(text.includes('reports/example/scorecard.html'), 'scorecard text: HTML link missing');
  assert(text.includes('Do these first:'), 'scorecard text: top-3 section missing');

  // CI gate: machine summary + threshold evaluation.
  const data = { host: 'example', generatedAt: 'now', latest: { runId: 'r1', dir: join(repoRoot, 'examples'), report, ...scored } };
  const summary = scorecardSummary(data);
  assert(summary.overall === scored.overall, 'scorecardSummary: overall mismatch');
  assert(summary.findingsTotal === report.findings.length, 'scorecardSummary: findings total mismatch');
  assert(typeof summary.outcomes.discoverable !== 'undefined', 'scorecardSummary: outcomes map missing keys');

  // An impossible bar fails; a trivially-met bar passes.
  const fail = evaluateGates(summary, { min: {}, minOverall: 100, maxCritical: 0 });
  assert(fail.passed === false && fail.checks.some((c) => !c.ok), 'gate: overall=100 should fail an imperfect report');
  const pass = evaluateGates(summary, { min: {}, minOverall: 1, maxHigh: 999 });
  assert(pass.passed === true, 'gate: trivial thresholds should pass');
  // A not-applicable outcome never fails its gate.
  const naGate = evaluateGates({ overall: 50, outcomes: { memory: null }, findingsBySeverity: { critical: 0, high: 0 } }, { min: { memory: 90 } });
  assert(naGate.passed === true, 'gate: a null (N/A) outcome must not fail its gate');
}

async function testDiscoverabilityHelpers() {
  const { stripHtmlToText, contentTokens, detectEmptyMounts, contentPresentInRaw } = await import('../evidence/cli.mjs');

  // stripHtmlToText drops scripts/styles/markup, keeps visible text.
  const text = stripHtmlToText('<html><head><style>.x{color:red}</style></head><body><h1>Hello There</h1><script>var a=1</script><p>Body &amp; content</p></body></html>');
  assert(text.includes('Hello There') && text.includes('Body & content'), `stripHtmlToText missed content: ${text}`);
  assert(!text.includes('color:red') && !text.includes('var a'), `stripHtmlToText leaked script/style: ${text}`);

  // contentTokens keeps >=4-char words, lowercased, de-duped.
  const toks = contentTokens('The Thylakoid MEMBRANE membrane a to');
  assert(toks.has('thylakoid') && toks.has('membrane'), 'contentTokens missing expected words');
  assert(!toks.has('the') && !toks.has('to'), 'contentTokens should skip short words');
  assert(toks.size === 2, `contentTokens should de-dupe case-insensitively, got ${toks.size}`);

  // detectEmptyMounts flags an empty SPA root but not a filled one.
  assert(detectEmptyMounts('<div id="root"></div>').includes('#root'), 'should detect empty #root');
  assert(detectEmptyMounts('<div id="root"><h1>hi</h1></div>').length === 0, 'should not flag a filled #root');
  assert(detectEmptyMounts('<div id="__next">   </div>').includes('#__next'), 'should detect empty #__next');

  // contentPresentInRaw: inline markup and line breaks must not hide a
  // server-rendered h1/title (web-uplift-406). innerText collapses them, so the
  // verbatim-substring compare reported the h1 of paul.kinlan.me as missing.
  const rawFixture = stripHtmlToText('<html><head><title>Hello. I am Paul Kinlan.</title></head><body><h1 class="x">\n          Hello. I am <span class="fn">Paul Kinlan</span>.\n        </h1></body></html>');
  assert(contentPresentInRaw('Hello. I am Paul Kinlan.', rawFixture), `inline-span h1 should be present in raw text: ${rawFixture}`);
  assert(contentPresentInRaw('Hello. I am\n          Paul Kinlan.', rawFixture), 'a rendered value with line breaks should still match');
  assert(!contentPresentInRaw('Client Injected Heading', rawFixture), 'a JS-only heading must not read as present');
  assert(!contentPresentInRaw('', rawFixture) && !contentPresentInRaw(null, rawFixture), 'empty values are not present');
  // A value with no >=4-char tokens still compares, so it is not present by default.
  assert(contentPresentInRaw('Hi', '<p>Hi there</p>'), 'short text should be found when present');
  assert(!contentPresentInRaw('Hi', '<p>Bye there</p>'), 'short text should not be found when absent');
}

// End to end, through the real primitive: a server-rendered h1 broken up by an
// inline span and line breaks must report h1PresentInRaw true (the paul.kinlan.me
// shape, web-uplift-406), and an h1 that only JavaScript inserts must stay false,
// so the fix cannot be paid for by weakening the shell detection.
async function testDiscoverabilityH1InRaw() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if ((req.url || '').startsWith('/markup')) {
      res.end('<!doctype html><html><head><title>Inline markup</title></head><body>' +
        '<h1 class="page-title">\n          Hello. I am <span class="fn">Paul Kinlan</span>.\n        </h1>' +
        '<p>A server-rendered paragraph with enough words for the coverage measure to compare.</p>' +
        '</body></html>');
      return;
    }
    res.end('<!doctype html><html><head><title>Client rendered</title></head><body>' +
      '<div id="app"></div>' +
      '<p>A server-rendered paragraph with enough words for the coverage measure to compare.</p>' +
      '<script>document.querySelector("#app").innerHTML = "<h1>Client Injected Heading</h1>";</script>' +
      '</body></html>');
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const markup = await gather('discoverability', `${base}/markup`, { quiet: true, wait: 0, screenshots: false });
    assert(markup.rendered.h1Count === 1, `discoverability: expected the rendered h1: ${JSON.stringify(markup.rendered)}`);
    assert(
      markup.h1PresentInRaw === true,
      `discoverability: an inline-span h1 was reported missing from the raw HTML: ${JSON.stringify(markup.rendered)}`,
    );

    const injected = await gather('discoverability', `${base}/client`, { quiet: true, wait: 0, screenshots: false });
    assert(injected.rendered.h1Count === 1, `discoverability: expected the JS-injected h1: ${JSON.stringify(injected.rendered)}`);
    assert(
      injected.h1PresentInRaw === false,
      `discoverability: a JS-injected h1 read as present in the raw HTML: ${JSON.stringify(injected.rendered)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// WCAG 2.2 SC 2.5.8 Target Size (Minimum) needs real geometry: the targets
// primitive enumerates pointer targets, flags anything under 24x24 CSS px, marks
// the inline-in-text and spacing exceptions it can read from geometry, and
// measures a desktop and a narrow layout by default (web-uplift-uz7).
async function testTargetsPrimitive() {
  const page = [
    '<!doctype html><html><head><title>targets</title><style>',
    '  body { margin: 0; }',
    '  .tiny { width: 16px; height: 16px; padding: 0; border: 0; }',
    '  .big { width: 48px; height: 48px; }',
    '  .gap { margin-left: 200px; }',
    '  section, p { margin-bottom: 40px; }',
    '  p { font-size: 16px; line-height: 20px; }',
    '</style></head><body>',
    '<p>Read the <a class="tiny" href="#a" id="inline-link">text</a> in this sentence.</p>',
    '<section><button class="tiny" id="tight-a">a</button><button class="tiny" id="tight-b">b</button></section>',
    '<section><button class="tiny" id="spaced-a">a</button><button class="tiny gap" id="spaced-b">b</button></section>',
    '<section><button class="big" id="big-button">ok</button></section>',
    '<section><span style="display:none">hidden</span><a href="#z" style="width:0;height:0"></a></section>',
    '</body></html>',
  ].join('\n');
  const many = '<!doctype html><html><head><title>many</title><style>a{display:inline-block;width:8px;height:8px}</style></head><body>' +
    Array.from({ length: 420 }, (_, i) => `<a href="#${i}">${i}</a>`).join('') +
    '</body></html>';
  const empty = '<!doctype html><html><head><title>empty</title></head><body><p>No pointer targets at all here.</p></body></html>';

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (path === '/many') res.end(many);
    else if (path === '/empty') res.end(empty);
    else res.end(page);
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const result = await gather('targets', `${base}/page`, { quiet: true, wait: 250 });
    assert(result.minimumPx === 24, `targets: minimum should be 24 CSS px: ${result.minimumPx}`);
    assert(result.viewports.length === 2, `targets: expected a desktop and a narrow pass by default: ${result.viewports.length}`);
    const [desktop, narrow] = result.viewports;
    assert(
      desktop.name === 'desktop-1280x720' && desktop.viewport.width === 1280 && desktop.viewport.height === 720,
      `targets: the desktop pass did not measure a 1280x720 layout: ${JSON.stringify(desktop.viewport)}`,
    );
    assert(
      narrow.name === 'narrow-360x800' && narrow.viewport.width === 360 && narrow.viewport.height === 800,
      `targets: the narrow pass did not measure a 360x800 layout: ${JSON.stringify(narrow.viewport)}`,
    );

    const byId = new Map(desktop.targets.map((t) => [t.id, t]));
    const inline = byId.get('inline-link');
    assert(
      inline?.underMin === true && inline.inlineInText === true,
      `targets: an undersized link in a sentence should be flagged and marked inline-exempt: ${JSON.stringify(inline)}`,
    );
    for (const id of ['tight-a', 'tight-b']) {
      const t = byId.get(id);
      assert(
        t?.underMin === true && t.inlineInText === false && t.spacingPasses === false,
        `targets: ${id} is undersized with no spacing clearance and should say so: ${JSON.stringify(t)}`,
      );
    }
    for (const id of ['spaced-a', 'spaced-b']) {
      const t = byId.get(id);
      assert(
        t?.underMin === true && t.spacingPasses === true,
        `targets: ${id} is undersized but clears its neighbours and should say so: ${JSON.stringify(t)}`,
      );
    }
    const big = byId.get('big-button');
    assert(
      big?.underMin === false && big.spacingPasses === null,
      `targets: a 48x48 button is not undersized: ${JSON.stringify(big)}`,
    );
    assert(desktop.skippedZeroSizeCount === 1, `targets: the zero-size target should be skipped: ${desktop.skippedZeroSizeCount}`);
    assert(
      desktop.underMinCount === 5 &&
        desktop.underMinInlineExemptCount === 1 &&
        desktop.underMinSpacingExemptCount === 3 &&
        desktop.underMinNoKnownExemptionCount === 2,
      `targets: summary counts do not match the inventory: ${JSON.stringify({ underMin: desktop.underMinCount, inline: desktop.underMinInlineExemptCount, spacing: desktop.underMinSpacingExemptCount, none: desktop.underMinNoKnownExemptionCount })}`,
    );
    assert(
      narrow.underMinNoKnownExemptionCount === 2,
      `targets: the narrow pass should reach the same verdict on this fixture: ${narrow.underMinNoKnownExemptionCount}`,
    );

    // An explicit --viewport means one pass, and the inventory is capped with the
    // cap reported rather than silently trimmed.
    const manyResult = await gather('targets', `${base}/many`, { quiet: true, wait: 200, viewport: { w: 360, h: 800 } });
    assert(manyResult.viewports.length === 1, `targets: an explicit viewport should give one pass: ${manyResult.viewports.length}`);
    const capped = manyResult.viewports[0];
    assert(
      capped.matchedCount === 420 && capped.measuredCount === 400 && capped.omittedByCapCount === 20,
      `targets: the target cap was not reported: ${JSON.stringify({ matched: capped.matchedCount, measured: capped.measuredCount, omitted: capped.omittedByCapCount })}`,
    );
    assert(
      capped.underMinCount === 400 && capped.underMinNoKnownExemptionCount === 400,
      `targets: a wall of adjacent 8x8 links has no read exemption: ${JSON.stringify({ underMin: capped.underMinCount, noExemption: capped.underMinNoKnownExemptionCount })}`,
    );

    // No targets is a clean zero result, not an absent field: that is the
    // evidence a no-target page needs for the check to pass.
    const emptyResult = await gather('targets', `${base}/empty`, { quiet: true, wait: 200, viewport: { w: 360, h: 800 } });
    const none = emptyResult.viewports[0];
    assert(
      none.measuredCount === 0 && none.underMinNoKnownExemptionCount === 0 && none.targets.length === 0,
      `targets: a page with no targets should report zeroes: ${JSON.stringify({ measured: none.measuredCount, noExemption: none.underMinNoKnownExemptionCount })}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// The checks that turn on which modern CSS a page actually ships need the LIVE
// CSSOM, not a grep of the dom primitive's capped css string. This fixture
// covers every census source (document sheet with @import/@layer/@container/
// @starting-style/@scope/@supports/@property, a cross-origin sheet that must be
// skipped rather than crash the walk, a shadow-root adopted sheet, inline
// styles), the tracked feature rows, the overlay census, and the condition cap
// (web-uplift-xci).
async function testFeaturesPrimitive() {
  // The cross-origin sheet has to be a different origin, and a different port
  // is a different origin, so a second server is the cheapest honest fixture.
  const cross = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end('.cross { color: orange; }');
  });
  await new Promise((resolveListen) => cross.listen(0, '127.0.0.1', resolveListen));
  const crossPort = cross.address().port;

  const css = [
    '@layer base, theme;',
    '@layer base { .a { color: light-dark(#111, #eee); } }',
    '@media (prefers-color-scheme: dark) { .a { color-scheme: dark; } }',
    '@container card (min-width: 300px) { .b { color: red; } }',
    '@starting-style { .c { opacity: 0; } }',
    '@scope (.scope-root) { .d { color: blue; } }',
    '@supports (color: light-dark(black, white)) { .e { color: light-dark(black, white); } }',
    '.f { container-type: inline-size; container-name: card; anchor-name: --a; position-try: --t; text-wrap: balance; }',
    '.g:has(> .h) { color: green; }',
    'dialog::backdrop { background: rgb(0 0 0 / 0.5); }',
    '.pop:popover-open { color: purple; }',
    '@keyframes fade { from { opacity: 0; } to { opacity: 1; } }',
    "@property --my-prop { syntax: '<length>'; inherits: false; initial-value: 0px; }",
    ':root { --brand: #123; --space: 4px; }',
  ].join('\n');
  const manyConditions = Array.from({ length: 70 }, (_, i) => `@media (min-width: ${100 + i}px) { .m${i} { color: red; } }`).join('\n');

  const page = (many) => [
    '<!doctype html><html><head><title>features</title>',
    ...(many ? [] : [`<link rel="stylesheet" href="http://127.0.0.1:${crossPort}/cross.css">`]),
    '<style>',
    "@import url('/imported.css');",
    many ? manyConditions : css,
    '</style></head><body>',
    '<div class="scope-root"><p class="d">scoped</p></div>',
    '<dialog open>native dialog</dialog>',
    '<div popover id="pop">popover</div>',
    '<details><summary>more</summary>body</details>',
    '<div role="dialog" aria-modal="true">div dialog</div>',
    '<div id="stack" style="position:fixed;z-index:60">stacked</div>',
    '<div id="inline" style="container-type:inline-size">inline container</div>',
    '<div id="host"></div>',
    '<script>',
    "  const root = document.getElementById('host').attachShadow({ mode: 'open' });",
    '  const sheet = new CSSStyleSheet();',
    "  sheet.replaceSync('.shadowed { interpolate-size: allow-keywords; }');",
    '  root.adoptedStyleSheets = [sheet];',
    "  root.innerHTML = '<span class=\"shadowed\">shadow</span>';",
    '</script>',
    '</body></html>',
  ].join('\n');

  const main = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/imported.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('.imported { animation-timeline: --t; }');
      return;
    }
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page(path === '/many'));
  });

  await new Promise((resolveListen) => main.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = main.address();
    const base = `http://127.0.0.1:${port}`;

    const result = await gather('features', `${base}/`, { quiet: true, wait: 600 });

    // Every style source is visited, and the unreadable one is counted, named,
    // and makes the census explicitly partial rather than silently thin.
    assert(result.censusComplete === false, `features: a cross-origin sheet must make the census incomplete: ${result.censusComplete}`);
    assert(result.sheets.crossOriginSkipped === 1, `features: the cross-origin sheet should be skipped and counted: ${JSON.stringify(result.sheets)}`);
    assert(
      result.sheets.crossOriginSheetUrls.some((u) => u.includes('/cross.css')),
      `features: the skipped sheet should be named so it can be checked another way: ${JSON.stringify(result.sheets.crossOriginSheetUrls)}`,
    );
    assert(result.sheets.importedSheetsFollowed === 1, `features: the @import sheet should be followed: ${JSON.stringify(result.sheets)}`);
    assert(result.sheets.shadowRootsScanned === 1, `features: the shadow root should be scanned: ${JSON.stringify(result.sheets)}`);
    assert(result.sheets.inlineStyleElements === 2, `features: both inline styles should be scanned: ${JSON.stringify(result.sheets)}`);

    const atRules = result.tracked.atRules;
    assert(
      atRules['@container'] === 1 && atRules['@starting-style'] === 1 && atRules['@scope'] === 1 &&
        atRules['@supports'] === 1 && atRules['@property'] === 1 && atRules['@layer'] === 2 && atRules['@view-transition'] === 0,
      `features: at-rule census is wrong: ${JSON.stringify(atRules)}`,
    );
    const props = result.tracked.properties;
    assert(
      props['container-type'] >= 2 && props['anchor-name'] === 1 && props['position-try-fallbacks'] === 1 &&
        props['animation-timeline'] === 1 && props['interpolate-size'] === 1 && props['color-scheme'] === 1 &&
        props['content-visibility'] === 0,
      `features: property census is wrong: ${JSON.stringify(props)}`,
    );
    assert(result.tracked.functions['light-dark'] >= 2, `features: light-dark() usage was not counted: ${JSON.stringify(result.tracked.functions)}`);
    const sels = result.tracked.selectors;
    assert(
      sels[':has('] === 1 && sels['::backdrop'] === 1 && sels[':popover-open'] === 1 && sels[':is('] === 0,
      `features: selector census is wrong: ${JSON.stringify(sels)}`,
    );
    assert(result.customProperties.distinct === 2, `features: custom properties were not counted: ${JSON.stringify(result.customProperties)}`);
    const conditionNames = Object.keys(result.conditions);
    assert(
      conditionNames.includes('@media (prefers-color-scheme: dark)') && conditionNames.some((c) => c.startsWith('@container card')),
      `features: conditional at-rule preludes should be in the census: ${JSON.stringify(conditionNames)}`,
    );

    const overlays = result.overlays;
    assert(
      overlays.dialogElements === 1 && overlays.openDialogs === 1 && overlays.popoverElements === 1 &&
        overlays.detailsElements === 1 && overlays.roleDialogElements === 1 && overlays.ariaModalElements === 1,
      `features: overlay census is wrong: ${JSON.stringify(overlays)}`,
    );
    assert(
      overlays.highZIndexCount === 1 && overlays.highZIndexMax === 60 && overlays.highZIndexExamples[0]?.id === 'stack',
      `features: the high z-index div was not surfaced: ${JSON.stringify(overlays)}`,
    );

    // The condition map is capped, and the cap is reported rather than silent.
    // This page has no cross-origin sheet, so it also proves the complete case.
    const capped = await gather('features', `${base}/many`, { quiet: true, wait: 500 });
    assert(capped.censusComplete === true, `features: a same-origin-only page should report a complete census: ${JSON.stringify(capped.sheets)}`);
    assert(
      capped.conditionsTotal === 70 && capped.conditionsTruncated === true && Object.keys(capped.conditions).length === 60,
      `features: the condition cap was not reported: ${JSON.stringify({ total: capped.conditionsTotal, shown: Object.keys(capped.conditions).length, truncated: capped.conditionsTruncated })}`,
    );
  } finally {
    await new Promise((resolveClose) => main.close(resolveClose));
    await new Promise((resolveClose) => cross.close(resolveClose));
  }
}

async function testFlowNormalize() {
  const { normalizeFlow } = await import('../runner/flow.mjs');

  // A Chrome DevTools Recorder export normalises cleanly (same shape we use).
  const recorderJson = {
    title: 'Search',
    steps: [
      { type: 'setViewport', width: 1200, height: 800 },
      { type: 'navigate', url: 'https://example.com/' },
      { type: 'click', selectors: [['aria/Search'], ['#go']], target: 'main' },
      null, // stray/empty entries are dropped
    ],
  };
  const flow = normalizeFlow(recorderJson);
  assert(flow.title === 'Search', 'flow: title should carry through');
  assert(flow.steps.length === 3, `flow: empty steps should be dropped, got ${flow.steps.length}`);
  assert(flow.steps[2].selectors[0][0] === 'aria/Search', 'flow: selectors preserved');

  // Not-a-flow inputs throw.
  let threw = false;
  try { normalizeFlow({ nope: true }); } catch { threw = true; }
  assert(threw, 'flow: an object without steps[] must throw');
}

function run(command, args, opts = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...opts,
  });
}

// Async variant: spawnSync would block this process's event loop, so an
// in-process test server could not answer the child's browser. Bounded so a
// hung browser fails the suite instead of hanging it.
function runAsync(command, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: repoRoot, timeout: 120000, ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function testSyntaxChecks() {
  for (const file of listFiles(repoRoot, (p) => p.endsWith('.mjs'))) {
    const result = run(process.execPath, ['--check', file]);
    assert(result.status === 0, `syntax check failed for ${file}:\n${result.stderr || result.stdout}`);
  }
}

function testPackageRootImportIsSideEffectFree() {
  const result = run(process.execPath, [
    '--input-type=module',
    '-e',
    "import 'web-uplift'; console.log('import-ok')",
  ]);
  assert(result.status === 0, `package root import failed:\n${result.stderr || result.stdout}`);
  assert(result.stdout.trim() === 'import-ok', `package root import produced side effects:\n${result.stdout}`);
}

function testSchemaValidation() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const configSchema = readJson('schema/config.schema.json');
  const findingsSchema = readJson('schema/findings.schema.json');
  ajv.compile(configSchema);
  ajv.compile(findingsSchema);

  validateJson(ajv, configSchema, 'web-uplift.json');
  validateJson(ajv, configSchema, 'web-uplift.example.json');
  validateJson(ajv, findingsSchema, 'examples/playground-report.json');
  validateJson(ajv, findingsSchema, 'examples/playground-report-fixed.json');
}

function testInstalledEvidenceCli() {
  const target = join(tmp, 'installed-target');
  const tarball = packTarball();
  const install = run('npm', [
    'exec',
    '--yes',
    '--package',
    tarball,
    '--',
    'web-uplift',
    'install',
    '--agent',
    'codex',
    '--target',
    target,
  ], { env: noUpdateEnv() });
  assert(install.status === 0, `install failed: ${install.stderr || install.stdout}`);

  const manifest = JSON.parse(readFileSync(join(target, '.web-uplift/manifest.json'), 'utf8'));
  const pkg = readJson('package.json');
  assert(manifest.package === pkg.name, `installed manifest package mismatch: ${JSON.stringify(manifest)}`);
  assert(manifest.version === pkg.version, `installed manifest version mismatch: ${JSON.stringify(manifest)}`);
  assert(manifest.agents.includes('codex'), `installed manifest missed selected agent: ${JSON.stringify(manifest)}`);

  const evidenceUsage = run(process.execPath, ['.web-uplift/evidence/cli.mjs'], {
    cwd: target,
  });
  assert(evidenceUsage.status === 1, 'evidence CLI without args should print usage and exit 1');
  assert(
    evidenceUsage.stderr.includes('Usage: node evidence/cli.mjs') &&
      !evidenceUsage.stderr.includes('ERR_MODULE_NOT_FOUND'),
    `installed evidence CLI did not load cleanly:\n${evidenceUsage.stderr}`,
  );

  // The scorecard must be vendored too (aggregate/ + the runner/ it imports), so
  // an installed project can generate the interactive scorecard. A clean load
  // prints its usage; a missing aggregate/ or runner/ would throw at import.
  const scorecardUsage = run(process.execPath, ['.web-uplift/aggregate/scorecard.mjs'], { cwd: target });
  assert(
    !scorecardUsage.stderr.includes('ERR_MODULE_NOT_FOUND') && scorecardUsage.stderr.includes('scorecard'),
    `installed scorecard did not load (aggregate/ or runner/ not vendored?):\n${scorecardUsage.stderr}`,
  );
}

function testUpdateDryRunReadsInstallManifest() {
  const target = join(tmp, 'update-target');
  mkdirSync(join(target, '.web-uplift'), { recursive: true });
  writeFileSync(join(target, '.web-uplift/manifest.json'), JSON.stringify({
    package: 'web-uplift',
    version: '0.0.1',
    installedAt: '2026-01-01T00:00:00.000Z',
    agents: ['codex'],
  }, null, 2) + '\n');

  const pkg = readJson('package.json');
  const result = run(process.execPath, [
    'bin/web-uplift.mjs',
    'update',
    '--agent',
    'codex',
    '--target',
    target,
    '--dry-run',
  ], { env: noUpdateEnv() });
  assert(result.status === 0, `update dry-run failed: ${result.stderr || result.stdout}`);
  assert(result.stdout.includes('Existing web-uplift install found: 0.0.1'), `update did not read old manifest:\n${result.stdout}`);
  assert(result.stdout.includes(`Updating to: ${pkg.version}`), `update did not print target version:\n${result.stdout}`);
  assert(result.stdout.includes('.web-uplift/manifest.json'), `update dry-run did not include manifest write:\n${result.stdout}`);
}

function testCachedUpdateWarning() {
  const cacheRoot = join(tmp, 'update-cache');
  mkdirSync(join(cacheRoot, 'web-uplift'), { recursive: true });
  writeFileSync(join(cacheRoot, 'web-uplift/update-check.json'), JSON.stringify({
    latest: '999.0.0',
    checkedAt: Date.now(),
  }, null, 2) + '\n');

  const result = run(process.execPath, [
    'bin/web-uplift.mjs',
    'install',
    '--agent',
    'codex',
    '--target',
    join(tmp, 'cached-update-target'),
    '--dry-run',
  ], {
    env: {
      ...process.env,
      XDG_CACHE_HOME: cacheRoot,
      CI: '',
      WEB_UPLIFT_NO_UPDATE_CHECK: '',
    },
  });
  assert(result.status === 0, `cached update warning command failed: ${result.stderr || result.stdout}`);
  assert(result.stderr.includes('web-uplift 999.0.0 is available'), `cached update warning was not printed:\n${result.stderr}`);
  assert(result.stderr.includes('npx -y web-uplift@latest update --agent all'), `cached update warning missed update command:\n${result.stderr}`);
}

async function testPreNavigationEmulation() {
  const html =
    '<!doctype html><script>' +
    "window.initialReduce = matchMedia('(prefers-reduced-motion: reduce)').matches;" +
    '</script>';
  const value = await gather(
    'evaluate',
    `data:text/html,${encodeURIComponent(html)}`,
    {
      quiet: true,
      wait: 0,
      emulateMedia: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      expr:
        "({ initial: window.initialReduce, current: matchMedia('(prefers-reduced-motion: reduce)').matches })",
    },
  );
  assert(value.initial === true, `emulated media was not visible during load: ${JSON.stringify(value)}`);
  assert(value.current === true, `emulated media was not visible after load: ${JSON.stringify(value)}`);
}

// The axe primitive must work where the audit was previously blind: a site
// with a strict script-src refuses CDN fetches and injected <script src>, so
// axe through the evaluate primitive silently returned nothing. The primitive
// reads the VENDORED axe-core from disk and enables Page.setBypassCSP scoped to
// itself. If either regresses this test finds no violations on a page that
// provably has them.
async function testAxePrimitiveBypassesStrictCsp() {
  const html =
    '<!doctype html><html><head><title>strict csp</title></head><body>' +
    '<h1>Title</h1><h3>Skipped level</h3>' +
    '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">' +
    '<button></button>' +
    '</body></html>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Security-Policy': "script-src 'self'; default-src 'self'",
    });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const result = await gather('axe', `http://127.0.0.1:${server.address().port}/`, { quiet: true, wait: 200 });
    const all = Object.values(result.violations).flat();
    const ids = all.map((v) => v.id);
    assert(result.toolVersion, `axe: toolVersion missing (injection failed?): ${JSON.stringify(result)}`);
    assert(ids.includes('image-alt'), `axe: image-alt not found under strict CSP: ${ids.join(', ')}`);
    assert(ids.includes('heading-order'), `axe: heading-order not found under strict CSP: ${ids.join(', ')}`);
    assert(ids.includes('button-name'), `axe: button-name not found under strict CSP: ${ids.join(', ')}`);
    assert(result.violations.critical.some((v) => v.id === 'image-alt'),
      'axe: violations must be grouped by impact (image-alt is critical)');
    for (const v of all) {
      assert(v.nodeCount >= v.nodes.length, `axe: ${v.id} node cap must be announced, not silent`);
      assert(v.nodes.length > 0 && v.nodes[0].target, `axe: ${v.id} should carry node targets`);
    }
    assert(result.counts.passes > 0, 'axe: counts should include concluded passes');
  } finally {
    server.close();
  }
}

async function testHarRedirects() {
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/final' });
      res.end('redirecting');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>ok</title><link rel="icon" href="data:,">ok');
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'network.har');
    const result = await gather('har', `http://127.0.0.1:${port}/start`, {
      quiet: true,
      wait: 250,
      out,
    });
    assert(result.statusBreakdown['302'] === 1, `HAR status breakdown missed redirect: ${JSON.stringify(result.statusBreakdown)}`);

    const summary = JSON.parse(readFileSync(join(tmp, 'network-summary.json'), 'utf8'));
    assert(
      summary.hygiene.redirects.some((r) => r.status === 302 && r.location === '/final'),
      `HAR summary missed redirect hygiene entry: ${JSON.stringify(summary.hygiene.redirects)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// web-uplift-1s8: a cap that drops evidence must say so, in the JSON and on
// stderr. The dom primitive's 200000-character CSS/HTML cap is the dangerous
// one: a model grepping the returned css for "@container" cannot otherwise tell
// "the site does not use container queries" from "the evidence was cut off".
async function testEvidenceTruncationReporting() {
  const filler = 'z'.repeat(1000);
  const bigCss = Array.from({ length: 300 }, (_, i) => `.pad${i}{--filler-${i}:"${filler}"}`).join('\n');
  const pixel = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='), (c) => c.charCodeAt(0));

  const server = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/pixel.gif') {
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(pixel);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (path === '/over-cap') {
      res.end(`<!doctype html><title>over</title><style>${bigCss}</style><h1>over</h1>`);
      return;
    }
    if (path === '/under-cap') {
      res.end('<!doctype html><title>under</title><style>.a{color:#123}</style><h1>under</h1>');
      return;
    }
    if (path === '/many-images') {
      const imgs = Array.from({ length: 40 }, (_, i) => `<img src="/pixel.gif?i=${i}" alt="pixel ${i}" width="1" height="1">`).join('');
      res.end(`<!doctype html><title>images</title>${imgs}`);
      return;
    }
    if (path === '/many-cookies') {
      res.end("<!doctype html><title>cookies</title><script>for (let i = 0; i < 51; i++) document.cookie = 'cap' + i + '=1;path=/';</script>");
      return;
    }
    res.end('<!doctype html><title>empty</title>');
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    // Over the cap, through the real CLI: the JSON reports what was cut, stderr
    // says it out loud, and the shown text is exactly the cap.
    const cli = await runAsync(process.execPath, ['evidence/cli.mjs', 'dom', `${base}/over-cap`, '--wait', '250']);
    assert(cli.status === 0, `truncation: dom CLI failed:\n${cli.stderr}\n${cli.stdout}`);
    const over = JSON.parse(cli.stdout);
    assert(
      over.page.cssTruncated === true && over.page.cssChars > 200000 && over.page.css.length === 200000,
      `truncation: the 200KB CSS cap was not reported: ${JSON.stringify({ cssChars: over.page.cssChars, shown: over.page.css.length, truncated: over.page.cssTruncated })}`,
    );
    assert(
      over.page.outerHTML.length === Math.min(over.page.outerHTMLChars, 200000),
      'truncation: outerHTML length does not match its reported total',
    );
    assert(
      /WARNING: dom\.css/.test(cli.stderr),
      `truncation: the CLI did not warn about the cut CSS:\n${cli.stderr}`,
    );

    // Under the cap the same fields have to prove completeness: not truncated,
    // and the shown text is the whole text.
    const under = await gather('dom', `${base}/under-cap`, { quiet: true, wait: 250 });
    assert(
      under.page.cssTruncated === false && under.page.cssChars === under.page.css.length && under.page.css.length > 0,
      `truncation: a complete CSS sample was not reported as complete: ${JSON.stringify({ cssChars: under.page.cssChars, shown: under.page.css.length, truncated: under.page.cssTruncated })}`,
    );

    // The list caps report the same way: 40 images on the page, 30 listed.
    const images = await gather('images', `${base}/many-images`, { quiet: true, wait: 250 });
    assert(images.totalImages === 40, `truncation: images total is wrong: ${images.totalImages}`);
    assert(
      images.imagesInspected === 40 && images.imagesInspectedTruncated === false,
      `truncation: images inspection cap misreported: ${JSON.stringify({ inspected: images.imagesInspected, truncated: images.imagesInspectedTruncated })}`,
    );
    assert(
      images.imagesTruncated === true && images.images.length === 30,
      `truncation: images listing cap misreported: ${JSON.stringify({ listed: images.images.length, truncated: images.imagesTruncated })}`,
    );

    // 51 cookies set, 50 listed.
    const cookies = await gather('cookies', `${base}/many-cookies`, { quiet: true, wait: 250 });
    assert(cookies.totalCookies === 51, `truncation: cookies total is wrong: ${cookies.totalCookies}`);
    assert(
      cookies.cookiesTruncated === true && cookies.cookies.length === 50,
      `truncation: cookies listing cap misreported: ${JSON.stringify({ listed: cookies.cookies.length, truncated: cookies.cookiesTruncated })}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function testBatchDryRunUsesRetainedDirs() {
  const reports = join(tmp, 'reports');
  const result = run(process.execPath, [
    'runner/run-batch.mjs',
    '--dry-run',
    '--agent',
    'codex',
    '--out',
    reports,
    'https://example.com',
  ]);
  assert(result.status === 0, `batch dry-run failed: ${result.stderr || result.stdout}`);
  assert(
    result.stdout.includes(`${reports}/example_com/<timestamp>`),
    `batch dry-run did not use retained run dir:\n${result.stdout}`,
  );
  assert(!result.stdout.includes(`${reports}/codex/`), `batch dry-run still used old agent prefix:\n${result.stdout}`);
}

function testBatchFlowDryRun() {
  const reports = join(tmp, 'reports-flow');
  const flowPath = join(tmp, 'flow.json');
  writeFileSync(flowPath, JSON.stringify({
    title: 'Signup',
    steps: [{ type: 'navigate', url: 'https://example.com/' }, { type: 'click', selectors: [['#go']] }],
  }));
  const result = run(process.execPath, [
    'runner/run-batch.mjs', '--dry-run', '--agent', 'claude', '--out', reports, '--flow', flowPath, 'https://example.com',
  ]);
  assert(result.status === 0, `batch --flow dry-run failed: ${result.stderr || result.stdout}`);
  assert(result.stdout.includes('would replay') && result.stdout.includes('Signup'), `batch --flow dry-run did not announce the replay:\n${result.stdout}`);
  assert(result.stdout.includes('already replayed for you'.toLowerCase()) || result.stdout.includes('ALREADY replayed'), `batch --flow dry-run did not pass flow guidance to the agent:\n${result.stdout}`);
}

function packTarball() {
  const packDir = join(tmp, 'pack');
  mkdirSync(packDir, { recursive: true });
  const result = run('npm', ['pack', '--quiet', '--pack-destination', packDir]);
  assert(result.status === 0, `npm pack failed:\n${result.stderr || result.stdout}`);
  const file = result.stdout.trim().split('\n').filter(Boolean).pop();
  assert(file, `npm pack did not print a tarball name:\n${result.stdout}`);
  return join(packDir, file);
}

function readJson(path) {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
}

function noUpdateEnv() {
  return { ...process.env, WEB_UPLIFT_NO_UPDATE_CHECK: '1' };
}

function validateJson(ajv, schema, path) {
  const validate = ajv.compile(schema);
  const data = readJson(path);
  if (!validate(data)) {
    throw new Error(`${path} failed schema validation:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`);
  }
}

function listFiles(dir, predicate, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) listFiles(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}
