#!/usr/bin/env node
/**
 * tests/test-fast.mjs - Unit and integration tests for the fast test gate (scripts/test-fast.mjs).
 *
 * Verifies:
 * 1. File-to-test mapping accurately selects relevant test files and regression filters per subsystem.
 * 2. Non-test files (tests/fixtures/**) and CLI helper tools (tests/mwg-catalog.mjs, etc.) are never direct-run (P1-1).
 * 3. Self-testing: scripts/test-fast.mjs maps to tests/test-fast.mjs (P2-6).
 * 4. Deduplication ensures targets are not run redundantly when multiple files change in the same subsystem.
 * 5. A documentation/data-only or deleted-file diff is omitted by a NAMED rule and still falls back to
 *    the fast baseline suite; an unmapped EXECUTABLE path fails the gate before any target runs
 *    (web-uplift-5i9a), and an executable path is never omitted by a tree, doc or data rule.
 * 6. Every configured regression filter matches at least one declared test in tests/regression.mjs.
 * 7. Missing/deleted mapped files are skipped cleanly in runTarget rather than failing (P2-3).
 * 8. The fast gate exits non-zero when an affected test fails.
 * 9. CLI flags (--dry-run, --list, --all, --diff) operate as specified.
 * 10. tests/regression.mjs supports --only, --filter, --list, and fails when --only is missing an argument (P2-8).
 * 11. Slow/hanging targets are bounded and exit 124 on timeout rather than hanging.
 * 12. An executable changed path that no subsystem maps FAILS the gate, in a mixed diff too, before any
 *     target runs; the failure uses the fleet's anchored `fast-gate: unmapped:` marker and exit 1.
 * 13. Suite execution is published with the fleet's `fast-gate: running|passed|failed:` markers so the
 *     cached fast record can state its coverage instead of UNKNOWN.
 * 14. A refusal is actionable (the next action, a paste-able map entry, and the full-gate fallback) and
 *     the same policy is written in docs/speed.md, walked against the OMITTED_RULES data.
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  mapFilesToTests,
  isDirectRunnableTest,
  classifyUnmappedPath,
  hasCodeExtension,
  pathEntryExists,
  runTarget,
  SUBSYSTEMS,
  BASELINE_TARGETS,
  OMITTED_RULES,
  CODE_EXTENSIONS,
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
  assert(flowPlan.targets.some((t) => t.path === 'tests/cdp-copy-sync.mjs'), 'flow plan must include cdp-copy-sync.mjs');

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
  assert(runnerPlan.targets.some((t) => t.path === 'tests/cdp-copy-sync.mjs'), 'runner plan must include cdp-copy-sync.mjs');

  const runnerDocPlan = mapFilesToTests(['runner/README.md']);
  assert(runnerDocPlan.matchedSubsystems.includes('runner'), 'runner/README.md must map to runner subsystem');
  assert(!runnerDocPlan.isBaseline, 'runner/README.md must not fall back to baseline');
  assert(runnerDocPlan.targets.some((t) => t.path === 'tests/cdp-copy-sync.mjs'), 'runner doc plan must include cdp-copy-sync.mjs');

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

  // 14. Beads export and its redaction guard (web-uplift-0sx0). Before this entry existed, all three of
  // these files selected only the baseline four, so the guard that exists to keep provider tokens out of
  // the tracked export was invisible to the gate that runs when the export changes.
  for (const beadsFile of ['.beads/issues.jsonl', 'scripts/beads-export.mjs', 'tests/beads-export-redaction.mjs']) {
    const beadsPlan = mapFilesToTests([beadsFile]);
    assert(beadsPlan.matchedSubsystems.includes('beads-export'), `${beadsFile} must map to the beads-export subsystem`);
    assert(!beadsPlan.isBaseline, `${beadsFile} must not fall back to the baseline targets`);
    assert(beadsPlan.targets.some((t) => t.filter === 'TrackedBeadsExportHasNoSecretShapes'), `${beadsFile} must select the tracked-export guard`);
    assert(beadsPlan.targets.some((t) => t.filter === 'BeadsExportRedactionRuleCanFire'), `${beadsFile} must select the redaction-rule control`);
  }
  // Control for the other direction, which the assertions above cannot see: a match written as a prefix
  // ('.beads/') would satisfy every one of them while putting the export guard into every beads change.
  // This pins the matcher to the named files rather than to the directory.
  const beadsConfigPlan = mapFilesToTests(['.beads/config.yaml']);
  assert(!beadsConfigPlan.matchedSubsystems.includes('beads-export'), '.beads/config.yaml must NOT match beads-export: the matcher must name files, not the directory');
  assert(beadsConfigPlan.isBaseline, '.beads/config.yaml maps nothing, so it must still fall back to baseline');

  // 15. Agent dispatch and its proxy/env guards (web-uplift-b2q5). Before this entry existed a change to
  // runner/agents.mjs selected no DIRECT test target: its suite ran only because the runner subsystem's
  // 'Agent' name filter matched testAgentChildEnvProxyCredentials and testAgentChildEnvAllowlist. The
  // assertion below names the target FILE, which is what lets it tell a direct selection from the
  // incidental one - an assertion on the filter would have passed BEFORE the fix and proved nothing.
  const agentPlan = mapFilesToTests(['runner/agents.mjs']);
  assert(agentPlan.matchedSubsystems.includes('agent-dispatch'), 'runner/agents.mjs must map to the agent-dispatch subsystem');
  assert(!agentPlan.isBaseline, 'runner/agents.mjs must not fall back to the baseline targets');
  assert(
    agentPlan.targets.some((t) => t.type === 'node' && t.path === 'tests/runner-agents.test.mjs'),
    'runner/agents.mjs must select its own test file DIRECTLY, not only through a name filter',
  );
  // Control for the other direction, which the assertion above cannot see: a match written as a prefix
  // or as the runner/ directory would satisfy it while pulling the agent suite into every runner change.
  // This pins the entry to the one named file, so the fix cannot quietly become a blanket.
  for (const otherRunnerFile of ['runner/run-batch.mjs', 'runner/write-scope.mjs', 'runner/README.md']) {
    const otherPlan = mapFilesToTests([otherRunnerFile]);
    assert(
      !otherPlan.matchedSubsystems.includes('agent-dispatch'),
      `${otherRunnerFile} must NOT match agent-dispatch: the entry names one file, not the directory`,
    );
  }
  
  // 16. A changed census module must select the guard that READS it (web-uplift-iwof). Measured before this
  // entry existed: changing tests/census-targets.mjs selected four targets - CDP copy sync byte check,
  // Changelog and version agreement, Regression: Syntax checks and Regression: Package root import - and
  // NONE of them was the census guard, so a green fast gate could report success without ever running the
  // check that file feeds. That is the clean-versus-blind shape: the gate looks the same either way.
  // Both assertions below are stated so they FAIL before the fix, and deliberately name the subsystem and the
  // guard's own filter rather than a target count, because a count-based check would also have passed against
  // the four baseline targets.
  const censusPlan = mapFilesToTests(['tests/census-targets.mjs']);
  assert(censusPlan.matchedSubsystems.includes('census-targets'),
    'tests/census-targets.mjs must map to the census-targets subsystem, not only to the default targets');
  assert(censusPlan.targets.some((t) => t.type === 'regression' && t.filter === 'CensusTargetsAreTracked'),
    'and it must select the guard that reads the census, named by its own filter: a green gate that never ran that guard looks like a green gate that did');
  // Negative direction: the entry names ONE file, so an unrelated changed file must not pull the census
  // guard into its plan. Without this the entry could silently become a directory- or prefix-wide match.
  const unrelatedPlan = mapFilesToTests(['evidence/cdp.mjs']);
  assert(!unrelatedPlan.matchedSubsystems.includes('census-targets'),
    'an unrelated changed file must NOT select the census subsystem: the entry names one file, not tests/');
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

  // A changed path that no suite maps is only allowed to be left out of the plan when a NAMED rule
  // covers it (web-uplift-5i9a). 'unknown-doc.txt' is documentation, so it is omitted with the docs
  // rule and the plan still falls back to the baseline; an unmapped EXECUTABLE path is a failure.
  // `exists: () => true` states the intent directly: this is a changed file, not a deletion.
  const unknownPlan = mapFilesToTests(['unknown-doc.txt'], { exists: () => true });
  assert(unknownPlan.isBaseline, 'a documentation-only diff must still trigger the baseline');
  assert.deepEqual(unknownPlan.unmappedFiles, [], 'documentation must never be reported as unmapped');
  assert.equal(unknownPlan.omittedFiles.length, 1, 'the documentation path must be recorded as omitted');
  assert.equal(unknownPlan.omittedFiles[0].rule, 'docs', 'the omission must name the docs rule');

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
    assert(
      runRes.stdout.includes(`fast-gate: failed: ${failingTestPath}`),
      'a suite that ran and failed must be published with the fleet failed marker'
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log('✔ Failing target exits non-zero test passed');
}

function testSlowTargetTimesOutWithExit124() {
  console.log('Testing that slow targets time out with exit 124 rather than hanging...');

  const tmp = mkdtempSync(join(tmpdir(), 'test-fast-timeout-'));
  // Named *.test.mjs so the CLI maps it to itself and actually dispatches it. As `hanging-test.mjs` it
  // mapped to nothing, so the CLI half of this test used to pass because the forced 200ms timeout killed a
  // BASELINE target instead of the hanging one (web-uplift-5i9a: with the unmapped path now failing closed,
  // the old name exited 1 and exposed that the assertion had never exercised the target under test).
  const hangingTestPath = join(tmp, 'hanging-test.test.mjs');

  try {
    writeFileSync(
      hangingTestPath,
      `#!/usr/bin/env node\nawait new Promise(r => setTimeout(r, 5000));\n`,
      { mode: 0o755 }
    );

    const hangingTarget = {
      type: 'node',
      path: hangingTestPath,
      label: 'Hanging test suite',
      timeoutMs: 200,
    };

    const res = runTarget(hangingTarget);
    assert.equal(res.ok, false, 'runTarget on timed out process must return ok: false');
    assert.equal(res.status, 124, 'runTarget on timed out process must return status: 124');

    // Also assert CLI end-to-end exit code propagation
    const fastScript = join(repoRoot, 'scripts/test-fast.mjs');
    const cliRes = spawnSync(process.execPath, [fastScript, hangingTestPath], {
      encoding: 'utf8',
      env: { ...process.env, TEST_FAST_TARGET_TIMEOUT_MS: '200' },
    });
    assert.equal(cliRes.status, 124, `CLI invocation must exit 124 on timeout, got ${cliRes.status}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log('✔ Slow target timeout test passed');
}

/**
 * The fleet's marker contract, copied from fleet remote/check-coverage.py so this test fails if the gate
 * starts emitting a marker the consumer cannot read (R15: a producer outside the vocabulary reads
 * UNKNOWN, never zero).
 */
const FLEET_SUITE_MARKER = /^fast-gate:\s*(?:running|ran|passed|completed|failed):\s*(.*)$/;
const FLEET_UNMAPPED_MARKER = /^fast-gate:\s*unmapped:\s*(.*)$/;

function markerValues(stdout, pattern) {
  return stdout
    .split('\n')
    .map((line) => line.match(pattern))
    .filter(Boolean)
    .map((m) => m[1]);
}

function testUnmappedExecutablePathsFailClosed() {
  console.log('Testing that unmapped executable paths fail closed (web-uplift-5i9a)...');

  // Pure mapping, with every path stated to exist so the assertion is about the MAP, not about whether
  // the file happens to be on disk. An unmapped executable path is UNKNOWN, never a baseline pass.
  const existsAlways = { exists: () => true };

  const unknownOnly = mapFilesToTests(['scripts/brand-new-tool.mjs'], existsAlways);
  assert.deepEqual(unknownOnly.unmappedFiles, ['scripts/brand-new-tool.mjs'], 'an unmapped executable path must be reported as unmapped');
  assert.equal(unknownOnly.isBaseline, false, 'an unmapped executable path must NOT fall back to the baseline');
  assert.equal(unknownOnly.targets.length, 0, 'an unmapped executable path selects no target');

  // The exact defect this bead names: a MIXED diff. Before the fix this returned the evidence targets
  // with the unknown path recorded in unmappedFiles and the process still exited 0.
  const mixed = mapFilesToTests(['evidence/cdp.mjs', 'scripts/brand-new-tool.mjs'], existsAlways);
  assert(mixed.targets.length > 0, 'the known half of a mixed diff must still select its targets');
  assert.deepEqual(mixed.unmappedFiles, ['scripts/brand-new-tool.mjs'], 'the unknown half of a mixed diff must be reported');
  assert.equal(mixed.isBaseline, false, 'a mixed diff must never fall back to the baseline');

  // Fails closed by DEFAULT: the omission list is a set of NAMED trees and rules, so a code path outside
  // every one of them is unmapped. This is the control that stops a rule from becoming a blanket.
  for (const codePath of [
    'scripts/brand-new-tool.mjs',
    'tests/new-support-module.mjs',
    'bin/other-cli.mjs',
  ]) {
    assert(
      mapFilesToTests([codePath], existsAlways).unmappedFiles.includes(codePath),
      `${codePath} must fail closed: it is executable and no rule names it`
    );
  }

  // CLI, end to end. The probe is an absolute path in a temp dir: it exists (so it is not a deletion),
  // it is executable, and no subsystem maps it.
  const fastScript = join(repoRoot, 'scripts/test-fast.mjs');
  const probeDir = mkdtempSync(join(tmpdir(), 'test-fast-unmapped-'));
  const probePath = join(probeDir, 'unmapped-probe.mjs');
  try {
    writeFileSync(probePath, '#!/usr/bin/env node\nconsole.log("probe");\n', { mode: 0o755 });

    const res = spawnSync(process.execPath, [fastScript, probePath], { encoding: 'utf8' });
    assert.notEqual(res.status, 0, 'the gate must exit non-zero for an unmapped executable path');
    assert.equal(markerValues(res.stdout, FLEET_UNMAPPED_MARKER).length, 1, 'the gate must print exactly one fleet unmapped marker');
    assert(res.stderr.includes('map to no suite'), 'the gate must say why on stderr');
    assert(res.stderr.includes('SUBSYSTEMS'), 'the failure must tell the author where to add the mapping');
    assert(!res.stdout.includes('PASSED'), 'no target may be reported as passing when the plan is unmapped');
    // A --dry-run preview must show the same refusal: a preview that looks green while the real run
    // fails is the trap this check exists to close.
    const dry = spawnSync(process.execPath, [fastScript, '--dry-run', probePath], { encoding: 'utf8' });
    assert.notEqual(dry.status, 0, '--dry-run must report an unmapped plan as a failure, not a green preview');
    assert(dry.stdout.includes('fast-gate: unmapped:'), '--dry-run must print the unmapped marker');

    // Mixed diff through the CLI: the mapped half must not buy a green verdict for the unmapped half.
    const mixedRes = spawnSync(process.execPath, [fastScript, 'evidence/cdp.mjs', probePath], { encoding: 'utf8' });
    assert.notEqual(mixedRes.status, 0, 'a mixed known+unknown diff must exit non-zero');
    assert.equal(markerValues(mixedRes.stdout, FLEET_UNMAPPED_MARKER).length, 1, 'the unknown half must be published as unmapped');
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }

  console.log('✔ Unmapped executable paths fail closed');
}

/**
 * A refusal must be ACTIONABLE (web-uplift-coord, the condition on this bead). Two halves: the error names
 * the ONE next action with a paste-able map entry, and the same policy plus the same action is written in
 * docs/speed.md, where a lane looks without being in an error state. This test walks the rule DATA against
 * that document so the two cannot drift, and runs the CLI to read the instruction the operator would.
 */
function testRefusalIsActionableAndDocumented() {
  console.log('Testing that a refusal names the next action and that the policy is documented...');

  const docPath = join(repoRoot, 'docs', 'speed.md');
  assert(existsSync(docPath), 'docs/speed.md must exist: the routing policy has to be readable without running the gate');
  const doc = readFileSync(docPath, 'utf8');
  assert(doc.includes('fast-gate: unmapped:'), 'docs/speed.md must name the marker a lane will see');
  assert(/NEXT ACTION|one next action/i.test(doc), 'docs/speed.md must carry the one next action, not only the policy');
  assert(doc.includes('KNOWN_STANDALONE_TESTS') && doc.includes('OMITTED_RULES'), 'docs/speed.md must name both mapping routes');
  assert(/FLEET_CHECK_CONF=\S+\s+fleet-check/.test(doc), 'docs/speed.md must name the full-gate escape hatch with its config override');
  // The full gate is not evidence for a path `npm test` does not run, so the fallback has to say so rather
  // than presenting `fleet-check` alone as proof (review finding P1 on a709eb9).
  assert(
    /runs `tests\/\*\.test\.mjs` only/.test(doc) && /NOT evidence on its own/.test(doc),
    'docs/speed.md must qualify the full-gate fallback: npm test only runs tests/*.test.mjs'
  );
  // The omission table is DATA and the document must carry every entry of it, VERBATIM: parsing the rows and
  // comparing the reason cell to the rule data is what makes a wrong-but-plausible "why" cell fail
  // (review finding P2 on a709eb9 - an id-presence check would have passed that).
  const tableRows = new Map();
  for (const line of doc.split('\n')) {
    const parsed = line.match(/^\|\s*`([a-z-]+)`\s*\|(.*)\|\s*$/);
    if (parsed) tableRows.set(parsed[1], parsed[2].split('|').map((cell) => cell.trim()));
  }
  for (const rule of OMITTED_RULES) {
    assert(tableRows.has(rule.id), `docs/speed.md must have a table row for the omission rule ${rule.id}`);
    const cells = tableRows.get(rule.id);
    assert.equal(
      cells[cells.length - 1],
      rule.reason,
      `the reason cell for ${rule.id} must be the rule's own reason string, not a paraphrase`
    );
    assert(cells.length === 2 && cells[0].length > 0, `the row for ${rule.id} must also say what it omits`);
  }
  for (const id of tableRows.keys()) {
    assert(OMITTED_RULES.some((rule) => rule.id === id), `docs/speed.md documents an omission rule that does not exist: ${id}`);
  }
  // The claimed cost has to be a number with its provenance, not an adjective, and the spawn count is the
  // kind of detail that silently rots when a test is added (review finding P2 on a709eb9).
  assert(/six bounded\s+`node` spawns/.test(doc), 'docs/speed.md must state the measured spawn count, so adding a test forces the doc to be updated');
  assert(/7\.2s direct/.test(doc) && /11\.0s in the cached/.test(doc), 'docs/speed.md must give each timing sample with its provenance');
  // ...and `--list` prints the same rules from the single source of truth, so a lane can read the policy
  // from the tool rather than from prose.
  const listRes = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'test-fast.mjs'), '--list'], { encoding: 'utf8' });
  assert.equal(listRes.status, 0, '--list must exit 0');
  for (const rule of OMITTED_RULES) {
    assert(listRes.stdout.includes(rule.id), `--list must print the omission rule ${rule.id}`);
    assert(listRes.stdout.includes(rule.reason), `--list must print the reason for ${rule.id}`);
  }

  // The instruction a lane actually reads. It must name the next action, show the map entry to paste with
  // this path in it, and offer the honest route when the map cannot be extended now.
  const fastScript = join(repoRoot, 'scripts', 'test-fast.mjs');
  const probeDir = mkdtempSync(join(tmpdir(), 'test-fast-actionable-'));
  const probePath = join(probeDir, 'brand-new-module.mjs');
  try {
    writeFileSync(probePath, '#!/usr/bin/env node\n', { mode: 0o755 });
    const res = spawnSync(process.execPath, [fastScript, probePath], { encoding: 'utf8' });
    assert.notEqual(res.status, 0, 'the gate must still refuse');
    assert(res.stderr.includes('NEXT ACTION'), 'the refusal must lead with the next action');
    assert(
      res.stderr.includes(`candidate === '${relative(repoRoot, probePath)}'`),
      'the refusal must print a paste-able SUBSYSTEMS entry for THIS path, not a generic instruction'
    );
    assert(res.stderr.includes('KNOWN_STANDALONE_TESTS'), 'the refusal must name the standalone-suite route');
    assert(res.stderr.includes('OMITTED_RULES'), 'the refusal must name the declared-omission route');
    assert(
      res.stderr.includes('npm test runs tests/*.test.mjs only'),
      'the refusal must qualify the full gate: it does not run a path no tests/*.test.mjs suite covers'
    );
    assert(
      /FLEET_CHECK_CONF=\S+ fleet-check/.test(res.stderr),
      'the refusal must still give the full-gate command, after the qualification'
    );
    assert(
      res.stderr.includes('baseline run is not evidence'),
      'the refusal must say why pointing the path at the baseline is not a fix'
    );
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }

  console.log('✔ Refusal is actionable and documented');
}

function testOmittedRulesAreNamedAndNarrow() {
  console.log('Testing that omitted paths are named by a rule and cannot rot silently...');

  const existsAlways = { exists: () => true };

  // Every rule states a reason, which is what makes an omission readable instead of an absence.
  for (const rule of OMITTED_RULES) {
    assert(rule.id && rule.reason && typeof rule.match === 'function', `omission rule ${rule.id} must name itself and its reason`);
  }

  const docOnly = mapFilesToTests(
    ['README.md', 'AGENTS.md', 'docs/adr-0001-test-and-evidence-decomposition.md', 'examples/playground-report.md'],
    existsAlways
  );
  assert.deepEqual(docOnly.unmappedFiles, [], 'documentation must not be reported as unmapped');
  assert.equal(docOnly.omittedFiles.length, 4, 'each documentation path must be recorded as omitted');
  assert(docOnly.omittedFiles.every((o) => o.rule === 'docs'), 'the documentation paths must be omitted by the docs rule');
  assert(docOnly.isBaseline, 'a documentation-only diff still runs the baseline suite');

  // An EXECUTABLE file inside a named fixture/demo tree is NOT omitted: the tree rules only see
  // non-executable paths, so playground/app.js is refused like any other unmapped executable. This is
  // the review finding (P1) on the first version of this change, which omitted it and thereby skipped a
  // changed module; mapping those trees is filed as web-uplift-5r7z. The non-executable files beside it
  // are still omitted, by their own rules.
  const fixture = mapFilesToTests(
    ['playground/app.js', 'playground/README.md', 'playground/expected-findings.json'],
    existsAlways
  );
  assert.deepEqual(
    fixture.unmappedFiles,
    ['playground/app.js'],
    'an executable file in a fixture/demo tree must be REFUSED, not omitted: a tree rule may not skip a changed module'
  );
  assert.equal(fixture.omittedFiles.length, 2, 'the non-executable files beside it are omitted');
  assert(
    fixture.omittedFiles.every((o) => o.rule === 'docs' || o.rule === 'data-and-config'),
    'those omissions must be named by the doc/data rules that cover them'
  );
  // The other direction: no rule that omits an executable path may exist without saying so. Exactly two
  // do (deleted, recorded-artefacts), and each carries the flag that makes it explicit.
  const executableOmitters = OMITTED_RULES.filter((rule) => rule.mayOmitExecutable === true).map((rule) => rule.id);
  assert.deepEqual(
    executableOmitters.sort(),
    ['deleted', 'recorded-artefacts'],
    'only the deletion and recorded-artefact rules may omit an executable path; adding a third must be a deliberate, reviewed change'
  );
  // The declared exception, exercised: a probe script recorded by a run is omitted, with its rule named.
  const recordedProbe = mapFilesToTests(['evidence-out/fb6-stuck/fb6-probe.mjs'], existsAlways);
  assert.deepEqual(recordedProbe.unmappedFiles, [], 'a recorded artefact probe is the declared exception, not a failure');
  assert.equal(recordedProbe.omittedFiles[0].rule, 'recorded-artefacts', 'the record rule must be the one that omitted it');

  // A deleted path has nothing left to run, so it is OMITTED with its own rule rather than reported as an
  // unmapped executable (runTarget already skips a mapped target whose file is gone, P2-3). "Deleted" means
  // the tree has no entry there, which is NOT the same as existsSync returning false: a dangling symlink is
  // a present entry and must be refused, not read as a deletion (review finding P2 on 1cf6e36).
  const deleted = mapFilesToTests(['scripts/removed-tool.mjs'], { exists: () => false });
  assert.deepEqual(deleted.unmappedFiles, [], 'a deleted path is not an unmapped executable');
  assert.equal(deleted.omittedFiles.length, 1, 'a deleted path must be recorded as omitted');
  assert.equal(deleted.omittedFiles[0].rule, 'deleted', 'a deleted path must be omitted by the deleted rule');
  assert(deleted.isBaseline, 'an unmatched deleted path falls back to the baseline');
  // A deleted path a SUBSYSTEM maps is not baseline: the subsystem wins and runTarget skips the missing
  // file, which is why the baseline claim has to be about UNMAPPED deletions only (review finding P2).
  const deletedMapped = mapFilesToTests(['tests/flow.mjs'], { exists: () => false });
  assert(
    deletedMapped.matchedSubsystems.includes('flow') && !deletedMapped.isBaseline,
    'a deleted file that a subsystem maps selects that subsystem, not the baseline'
  );
  assert(classifyUnmappedPath('docs/gone.md', repoRoot, () => false).omitted.rule === 'deleted', 'classifyUnmappedPath must expose the same decision');

  // The default predicate both halves of that decision rest on: an absent entry is gone, a present entry is
  // not - INCLUDING a dangling symlink, which existsSync calls absent.
  const linkDir = mkdtempSync(join(tmpdir(), 'test-fast-lstat-'));
  try {
    symlinkSync(join(linkDir, 'missing-target.mjs'), join(linkDir, 'dangling.mjs'));
    writeFileSync(join(linkDir, 'present.mjs'), '#!/usr/bin/env node\n');
    assert.equal(pathEntryExists('dangling.mjs', linkDir), true, 'a dangling symlink is a PRESENT entry, not a deleted path');
    assert.equal(pathEntryExists('present.mjs', linkDir), true, 'a real file is a present entry');
    assert.equal(pathEntryExists('absent.mjs', linkDir), false, 'a path with no entry is deleted');
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
  }

  // The invariants that keep the rule list honest. The gate refuses an unmapped executable path at run
  // time; these pin the two ways a rule could quietly defeat that:
  //   1. NO AUTHORED executable tracked path may be omitted by a rule (the record trees and deletions are
  //      the declared exceptions), and
  //   2. every NON-EXECUTABLE tracked path must be mapped or omitted, so nothing is dropped silently.
  // Unmapped tracked executables are allowed only in the two trees whose mapping is filed as
  // web-uplift-5r7z, so a new unmapped module anywhere else fails this test as well as the gate.
  const tracked = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert(tracked.length > 100, `expected a real tracked-file list, got ${tracked.length}`);
  const plans = tracked.map((f) => [f, mapFilesToTests([f])]);
  const recordTrees = ['evidence-out/', '.pi-subagents/'];
  const omittedExecutables = plans
    .filter(([f, p]) => hasCodeExtension(f) && p.omittedFiles.length > 0)
    .map(([f, p]) => `${f} [${p.omittedFiles[0].rule}]`);
  assert.deepEqual(
    omittedExecutables.filter((s) => !recordTrees.some((t) => s.startsWith(t))),
    [],
    'no authored executable path may be omitted by a rule: a tree rule that skips a changed module is the silent narrowing this bead forbids'
  );
  const droppedNonExecutables = plans.filter(([f, p]) => !hasCodeExtension(f) && p.unmappedFiles.length > 0).map(([f]) => f);
  assert.deepEqual(droppedNonExecutables, [], 'every non-executable tracked path must be mapped or omitted by a named rule');
  const unmappedExecutables = plans.filter(([, p]) => p.unmappedFiles.length > 0).map(([f]) => f);
  assert.deepEqual(
    unmappedExecutables.filter((f) => !f.startsWith('playground/') && !f.startsWith('eval/')),
    [],
    'only the trees whose consumer mapping is filed as web-uplift-5r7z may currently be unmapped; anything else must be mapped or covered by a named rule'
  );
  assert(CODE_EXTENSIONS.has('.mjs'), 'the executable-extension set must describe this repo\'s modules');

  console.log(
    `✔ ${OMITTED_RULES.length} named omission rules; ${tracked.length} tracked paths classified (${unmappedExecutables.length} refused pending web-uplift-5r7z, ${omittedExecutables.length} recorded-artefact executables declared)`
  );
}

function testSuiteExecutionMarkers() {
  console.log('Testing that suite execution is published with the fleet coverage markers...');

  const fastScript = join(repoRoot, 'scripts/test-fast.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'test-fast-markers-'));
  const passPath = join(tmp, 'marker-pass.test.mjs');
  try {
    writeFileSync(passPath, '#!/usr/bin/env node\nconsole.log("ok");\n', { mode: 0o755 });

    // THE ORDINARY NEW FILE CONTROL (the likeliest real-world unmapped path): a fresh suite named
    // *.test.mjs maps to ITSELF and simply runs, so fail-closed must not block ordinary work. If this
    // assertion ever needs relaxing, the design question goes back to coord rather than into the gate.
    const plan = mapFilesToTests([passPath]);
    assert.deepEqual(plan.unmappedFiles, [], 'a fresh tests/*.test.mjs must not be refused: it is its own suite');
    assert.equal(plan.targets.length, 1, 'a fresh suite must select exactly itself');

    const res = spawnSync(process.execPath, [fastScript, passPath], { encoding: 'utf8' });
    assert.equal(res.status, 0, 'a passing target must exit 0');
    assert.deepEqual(
      markerValues(res.stdout, FLEET_SUITE_MARKER),
      [passPath, passPath],
      'the suite must be announced (running) and then published (passed), both inside the fleet vocabulary'
    );
    assert(
      res.stdout.includes(`fast-gate: running: ${passPath}`),
      'a dispatched suite must be announced with the fleet running marker'
    );
    assert(
      res.stdout.includes(`fast-gate: passed: ${passPath}`),
      'a suite that executed and passed must be published with the fleet passed marker'
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log('✔ Coverage markers passed');
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
  testSlowTargetTimesOutWithExit124();
  testUnmappedExecutablePathsFailClosed();
  testOmittedRulesAreNamedAndNarrow();
  testRefusalIsActionableAndDocumented();
  testSuiteExecutionMarkers();
  console.log('\nAll fast gate unit and integration tests passed successfully.');
}

runAll();
