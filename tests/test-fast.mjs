#!/usr/bin/env node
/**
 * tests/test-fast.mjs - Unit and integration tests for the fast test gate (scripts/test-fast.mjs).
 *
 * Verifies:
 * 1. File-to-test mapping accurately selects relevant test files and regression filters per subsystem.
 * 2. Non-test files (tests/fixtures/**) and CLI helper tools (tests/mwg-catalog.mjs, etc.) are never direct-run (P1-1).
 * 3. Self-testing: scripts/test-fast.mjs maps to tests/test-fast.mjs (P2-6).
 * 4. Deduplication ensures targets are not run redundantly when multiple files change in the same subsystem.
 * 5. Unknown or empty file lists safely fall back to the fast baseline test suite.
 * 6. Every configured regression filter matches at least one declared test in tests/regression.mjs.
 * 7. Missing/deleted mapped files are skipped cleanly in runTarget rather than failing (P2-3).
 * 8. The fast gate exits non-zero when an affected test fails.
 * 9. CLI flags (--dry-run, --list, --all, --diff) operate as specified.
 * 10. tests/regression.mjs supports --only, --filter, --list, and fails when --only is missing an argument (P2-8).
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  mapFilesToTests,
  isDirectRunnableTest,
  runTarget,
  SUBSYSTEMS,
  BASELINE_TARGETS,
  repoRoot,
} from '../scripts/test-fast.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function testSubsystemMappings() {
  console.log('Testing subsystem mapping rules...');

  // 1. Flow
  const flowPlan = mapFilesToTests(['runner/flow.mjs']);
  assert(flowPlan.matchedSubsystems.includes('flow'), 'flow.mjs must map to flow subsystem');
  assert(flowPlan.targets.some((t) => t.path === 'tests/flow.mjs'), 'flow plan must include tests/flow.mjs');
  assert(flowPlan.targets.some((t) => t.filter === 'Flow'), 'flow plan must include Flow regression filter');

  // 2. Safe-fetch
  const fetchPlan = mapFilesToTests(['tests/safe-fetch.mjs']);
  assert(fetchPlan.matchedSubsystems.includes('safe-fetch'), 'tests/safe-fetch.mjs must map to safe-fetch subsystem');
  assert(fetchPlan.targets.some((t) => t.path === 'tests/safe-fetch.mjs'), 'must include tests/safe-fetch.mjs');
  assert(fetchPlan.targets.some((t) => t.filter === 'SafeFetch'), 'must include SafeFetch filter');

  // 3. Symlink guards & write scope
  const symlinkPlan = mapFilesToTests(['runner/write-scope.mjs', 'tests/source-tree-symlink.mjs']);
  assert(symlinkPlan.matchedSubsystems.includes('symlink-guards'), 'must map to symlink-guards subsystem');
  assert(symlinkPlan.targets.some((t) => t.path === 'tests/source-tree-symlink.mjs'), 'must include source-tree-symlink');
  assert(symlinkPlan.targets.some((t) => t.filter === 'Symlink'), 'must include Symlink regression');

  // 4. Install surface & package
  const pkgPlan = mapFilesToTests(['package.json']);
  assert(pkgPlan.matchedSubsystems.includes('install-and-package'), 'package.json must map to install-and-package');
  assert(pkgPlan.targets.some((t) => t.path === 'tests/changelog-version-check.mjs'), 'must include changelog check');
  assert(pkgPlan.targets.some((t) => t.filter === 'InstallSurface'), 'must include InstallSurface regression');

  // 5. MWG & Principles
  const mwgPlan = mapFilesToTests(['knowledge/principles.json']);
  assert(mwgPlan.matchedSubsystems.includes('mwg'), 'knowledge/principles.json must map to mwg');
  assert(mwgPlan.targets.some((t) => t.filter === 'Principles'), 'must include Principles regression filter');
  assert(mwgPlan.targets.some((t) => t.filter === 'Mwg'), 'must include Mwg regression filter');

  // 6. Schema
  const schemaPlan = mapFilesToTests(['schema/findings.schema.json']);
  assert(schemaPlan.matchedSubsystems.includes('schema'), 'schema/ must map to schema subsystem');
  assert(schemaPlan.targets.some((t) => t.filter === 'SchemaValidation'), 'must include SchemaValidation');

  // 7. Aggregate
  const aggPlan = mapFilesToTests(['aggregate/scorecard.mjs']);
  assert(aggPlan.matchedSubsystems.includes('aggregate'), 'aggregate/ must map to aggregate subsystem');
  assert(aggPlan.targets.some((t) => t.filter === 'Scorecard'), 'must include Scorecard');

  // 8. Fixer
  const fixPlan = mapFilesToTests(['fixer/fix.mjs']);
  assert(fixPlan.matchedSubsystems.includes('fixer'), 'fixer/ must map to fixer subsystem');
  assert(fixPlan.targets.some((t) => t.filter === 'Fix'), 'must include Fix filter');

  // 9. MCP
  const mcpPlan = mapFilesToTests(['mcp/skills-server.mjs']);
  assert(mcpPlan.matchedSubsystems.includes('mcp'), 'mcp/ must map to mcp subsystem');
  assert(mcpPlan.targets.some((t) => t.filter === 'Mcp'), 'must include Mcp filter');

  // 10. Runner
  const runnerPlan = mapFilesToTests(['runner/run-batch.mjs']);
  assert(runnerPlan.matchedSubsystems.includes('runner'), 'runner/run-batch.mjs must map to runner subsystem');
  assert(runnerPlan.targets.some((t) => t.path === 'tests/batch-resume-isolation.mjs'), 'must include batch isolation');

  // 11. Skills
  const skillPlan = mapFilesToTests(['.claude/skills/web-audit/SKILL.md']);
  assert(skillPlan.matchedSubsystems.includes('skills'), 'SKILL.md must map to skills subsystem');
  assert(skillPlan.targets.some((t) => t.path === 'tests/skill-write-contract.mjs'), 'must include skill-write-contract');

  // 12. Evidence
  const evidencePlan = mapFilesToTests(['evidence/cli.mjs']);
  assert(evidencePlan.matchedSubsystems.includes('evidence'), 'evidence/cli.mjs must map to evidence subsystem');
  assert(evidencePlan.targets.some((t) => t.filter === 'Evidence'), 'must include Evidence filter');

  // 13. Self-testing (P2-6)
  const selfPlan = mapFilesToTests(['scripts/test-fast.mjs']);
  assert(selfPlan.matchedSubsystems.includes('fast-gate-self'), 'scripts/test-fast.mjs must map to fast-gate-self');
  assert(selfPlan.targets.some((t) => t.path === 'tests/test-fast.mjs'), 'must target tests/test-fast.mjs');

  console.log('✔ Subsystem mapping rules passed');
}

function testNonTestExclusion() {
  console.log('Testing non-test file exclusion from direct-run (P1-1)...');

  // Fixtures must NEVER be direct-runnable
  assert(!isDirectRunnableTest('tests/fixtures/mwg-catalog/evil/skills/modern-web-guidance/modern-web.mjs'), 'evil fixture must not be direct runnable');
  assert(!isDirectRunnableTest('tests/fixtures/mwg-catalog/ok/skills/modern-web-guidance/modern-web.mjs'), 'ok fixture must not be direct runnable');
  assert(!isDirectRunnableTest('tests/fixtures/mwg-catalog/traversal/skills/modern-web-guidance/modern-web.mjs'), 'traversal fixture must not be direct runnable');

  // CLI tools requiring args must not be direct-runnable
  assert(!isDirectRunnableTest('tests/mwg-catalog.mjs'), 'mwg-catalog.mjs must not be direct runnable');
  assert(!isDirectRunnableTest('tests/mwg-artefact.mjs'), 'mwg-artefact.mjs must not be direct runnable');
  assert(!isDirectRunnableTest('tests/mwg-drift-classify.mjs'), 'mwg-drift-classify.mjs must not be direct runnable');
  assert(!isDirectRunnableTest('tests/mwg-drift-check.mjs'), 'mwg-drift-check.mjs must not be direct runnable');

  // Real standalone tests must be direct-runnable
  assert(isDirectRunnableTest('tests/flow.mjs'), 'flow.mjs must be direct runnable');
  assert(isDirectRunnableTest('tests/safe-fetch.mjs'), 'safe-fetch.mjs must be direct runnable');
  assert(isDirectRunnableTest('tests/test-fast.mjs'), 'test-fast.mjs must be direct runnable');

  // When mwg-catalog.mjs changes, it should map to mwg subsystem targets, NOT a direct no-arg run
  const mwgCatalogPlan = mapFilesToTests(['tests/mwg-catalog.mjs']);
  assert(!mwgCatalogPlan.targets.some((t) => t.path === 'tests/mwg-catalog.mjs'), 'must not direct-run tests/mwg-catalog.mjs');
  assert(mwgCatalogPlan.targets.some((t) => t.filter === 'Mwg'), 'must run Mwg regression filter');

  console.log('✔ Non-test file exclusion passed');
}

function testAllRegressionFiltersAreValid() {
  console.log('Testing that all configured regression filters match real tests...');

  // Extract all test names from tests/regression.mjs
  const regressionSrc = readFileSync(join(repoRoot, 'tests/regression.mjs'), 'utf8');
  const allTestsMatch = regressionSrc.match(/const ALL_TESTS = \[([\s\S]*?)\];/);
  assert(allTestsMatch, 'ALL_TESTS array must exist in tests/regression.mjs');
  const testNames = allTestsMatch[1]
    .split('\n')
    .map((l) => l.trim().replace(/,$/, ''))
    .filter((l) => l && !l.startsWith('//'));

  assert(testNames.length >= 100, `Expected at least 100 tests in ALL_TESTS, found ${testNames.length}`);

  // Verify ALL_TESTS has exact set equality with declared and imported test functions (P2-B)
  const declaredTests = new Set();
  for (const m of regressionSrc.matchAll(/^[ \t]*(?:async[ \t]+)?function[ \t]+(test[A-Za-z0-9_]+)/gm)) {
    declaredTests.add(m[1]);
  }
  for (const m of regressionSrc.matchAll(/import[ \t]*\{([^}]+)\}[ \t]*from/g)) {
    for (const name of m[1].split(',')) {
      const trimmed = name.trim().split(/\s+as\s+/)[0].trim();
      if (/^test[A-Za-z0-9_]+$/.test(trimmed)) declaredTests.add(trimmed);
    }
  }

  const registeredSet = new Set(testNames);
  for (const dec of declaredTests) {
    assert(registeredSet.has(dec), `Test function "${dec}" is declared/imported in regression.mjs but missing from ALL_TESTS!`);
  }
  for (const reg of registeredSet) {
    assert(declaredTests.has(reg), `Test name "${reg}" in ALL_TESTS is not declared or imported in regression.mjs!`);
  }

  // Collect every filter from SUBSYSTEMS and BASELINE_TARGETS
  const allFilters = new Set();
  for (const sub of SUBSYSTEMS) {
    for (const t of sub.targets) {
      if (t.type === 'regression' && t.filter) allFilters.add(t.filter);
    }
  }
  for (const t of BASELINE_TARGETS) {
    if (t.type === 'regression' && t.filter) allFilters.add(t.filter);
  }

  for (const filter of allFilters) {
    const matches = testNames.filter((name) => name.toLowerCase().includes(filter.toLowerCase()));
    assert(
      matches.length > 0,
      `Configured regression filter "${filter}" does not match ANY test in ALL_TESTS! (Risk of silent exit 1)`
    );
  }

  console.log(`✔ All ${allFilters.size} regression filters match valid tests in ALL_TESTS`);
}

function testDeduplicationAndFallback() {
  console.log('Testing target deduplication and fallback behavior...');

  // Multiple files in same subsystem should not create duplicate targets
  const multiFlow = mapFilesToTests(['runner/flow.mjs', 'runner/flow-record.mjs', 'tests/flow.mjs']);
  const flowTargetLabels = multiFlow.targets.map((t) => t.label);
  const uniqueLabels = new Set(flowTargetLabels);
  assert.equal(flowTargetLabels.length, uniqueLabels.size, 'targets must not contain duplicates');

  // Empty file list falls back to baseline
  const emptyPlan = mapFilesToTests([]);
  assert(emptyPlan.isBaseline, 'empty file list must trigger baseline');
  assert.equal(emptyPlan.targets.length, BASELINE_TARGETS.length, 'baseline targets count must match');

  // Unknown file falls back to baseline
  const unknownPlan = mapFilesToTests(['unknown-doc.txt']);
  assert(unknownPlan.isBaseline, 'unknown file must trigger baseline');
  assert(unknownPlan.unmappedFiles.includes('unknown-doc.txt'), 'unknown file recorded in unmappedFiles');

  console.log('✔ Deduplication and fallback passed');
}

function testCliDryRunAndListAndAll() {
  console.log('Testing CLI --dry-run, --list, --all, and --diff options...');

  const fastScript = join(repoRoot, 'scripts/test-fast.mjs');

  // --list
  const listRes = spawnSync(process.execPath, [fastScript, '--list'], { encoding: 'utf8' });
  assert.equal(listRes.status, 0, '--list must exit 0');
  assert(listRes.stdout.includes('Known subsystems and fast targets:'), '--list output must describe subsystems');
  assert(listRes.stdout.includes('flow:'), '--list must include flow');

  // --dry-run with explicit file
  const dryRes = spawnSync(process.execPath, [fastScript, '--dry-run', 'runner/flow.mjs'], { encoding: 'utf8' });
  assert.equal(dryRes.status, 0, '--dry-run must exit 0');
  assert(dryRes.stdout.includes('Matched subsystem(s): flow'), '--dry-run must report flow matched');
  assert(dryRes.stdout.includes('Dry-run complete'), '--dry-run must complete without executing');

  // --all with --dry-run (P2-4)
  const allRes = spawnSync(process.execPath, [fastScript, '--all', '--dry-run'], { encoding: 'utf8' });
  assert.equal(allRes.status, 0, '--all --dry-run must exit 0');
  assert(allRes.stdout.includes('CDP copy sync byte check'), '--all must include baseline targets');
  assert(allRes.stdout.includes('Regression: Syntax checks'), '--all must include syntax check');

  // --diff with missing argument (P2-5)
  const missingDiffRes = spawnSync(process.execPath, [fastScript, '--diff'], { encoding: 'utf8' });
  assert.notEqual(missingDiffRes.status, 0, '--diff with no argument must exit non-zero');

  console.log('✔ CLI options passed');
}

function testRegressionFilterCli() {
  console.log('Testing tests/regression.mjs --only and --list CLI flags...');

  const regScript = join(repoRoot, 'tests/regression.mjs');

  // --list
  const listRes = spawnSync(process.execPath, [regScript, '--list'], { encoding: 'utf8' });
  assert.equal(listRes.status, 0, 'regression --list must exit 0');
  assert(listRes.stdout.includes('testSyntaxChecks'), 'regression --list must include testSyntaxChecks');
  assert(listRes.stdout.includes('testFlowNormalize'), 'regression --list must include testFlowNormalize');

  // --only matching test
  const onlyRes = spawnSync(process.execPath, [regScript, '--only', 'testSyntaxChecks'], { encoding: 'utf8' });
  assert.equal(onlyRes.status, 0, 'regression --only testSyntaxChecks must exit 0');
  assert(onlyRes.stdout.includes('tests OK'), 'must print tests OK');

  // --only with no match must exit non-zero
  const nonMatchRes = spawnSync(process.execPath, [regScript, '--only', 'nonExistentTestNameXYZ999'], { encoding: 'utf8' });
  assert.notEqual(nonMatchRes.status, 0, 'regression --only with no match must exit non-zero');
  assert(nonMatchRes.stderr.includes('no tests matched filter'), 'must print error message');

  // --only with missing argument must exit non-zero (P2-8)
  const missingArgRes = spawnSync(process.execPath, [regScript, '--only'], { encoding: 'utf8' });
  assert.notEqual(missingArgRes.status, 0, 'regression --only with missing argument must exit non-zero');
  assert(missingArgRes.stderr.includes('missing argument for filter flag'), 'must report missing argument');

  console.log('✔ tests/regression.mjs filter CLI passed');
}

function testMissingTargetSkippedCleanly() {
  console.log('Testing that non-existent/deleted targets are skipped cleanly (P2-3)...');

  const missingTarget = {
    type: 'node',
    path: 'tests/non-existent-deleted-suite.mjs',
    label: 'Deleted test suite',
  };

  const res = runTarget(missingTarget);
  assert.equal(res.ok, true, 'runTarget on non-existent file must not fail the run');
  assert.equal(res.skipped, true, 'runTarget must mark non-existent file as skipped');

  console.log('✔ Missing target skipped cleanly');
}

function testFailingTargetExitsNonZero() {
  console.log('Testing that test-fast exits non-zero on failing affected test...');

  const tmp = mkdtempSync(join(tmpdir(), 'test-fast-fail-'));
  const failingTestPath = join(tmp, 'sample-failure.test.mjs');

  try {
    writeFileSync(
      failingTestPath,
      `#!/usr/bin/env node\nconsole.error('Deliberate test failure for fast gate test');\nprocess.exit(1);\n`,
      { mode: 0o755 }
    );

    const fastScript = join(repoRoot, 'scripts/test-fast.mjs');
    const runRes = spawnSync(process.execPath, [fastScript, failingTestPath], { encoding: 'utf8' });

    assert.notEqual(runRes.status, 0, 'scripts/test-fast.mjs must exit non-zero when a test target fails');
    assert(
      runRes.stderr.includes('STOPPED') || runRes.stderr.includes('FAILED') || runRes.stdout.includes('FAILED'),
      'Output must indicate test failure'
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log('✔ Failing target exits non-zero test passed');
}

function runAll() {
  testSubsystemMappings();
  testNonTestExclusion();
  testAllRegressionFiltersAreValid();
  testDeduplicationAndFallback();
  testCliDryRunAndListAndAll();
  testRegressionFilterCli();
  testMissingTargetSkippedCleanly();
  testFailingTargetExitsNonZero();
  console.log('\nAll fast gate unit and integration tests passed successfully.');
}

runAll();
