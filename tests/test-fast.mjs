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
 * 14. A refusal is actionable (the next action, a paste-able map entry, and the qualified full-gate escape);
 *     AGENTS.md names the escape and the rules, docs/speed.md's omission table is parsed and compared to
 *     the OMITTED_RULES reasons verbatim, and --list prints each rule with its reason from that data.
 * 15. The diff provenance is reported, not implied (web-uplift-5e9s): the run names the comparison BASE
 *     and how far the branch is ahead/behind the ref, names every UNCOMMITTED path it selected with why
 *     it is not in HEAD, and prints no uncommitted block on a clean worktree (the negative control).
 * 16. Paths survive Git's own quoting (web-uplift-4bqu): a non-ASCII or otherwise quotable path is
 *     recorded literally by every source, so it is marked as uncommitted like any other and a rename is
 *     reported at its destination rather than losing its source.
 * 17. Every shared module under tests/ that a suite imports either runs a suite that imports it or is
 *     REFUSED with its importing suites named - the control that would have caught tests/test-helpers.mjs
 *     running only the gate's own self-tests while 8 consumer suites were omitted (web-uplift-5y2w).
 */

import { strict as assert } from 'node:assert';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
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
  getChangedFiles,
  getChangedRegressionTests,
  getDiffDistance,
  getUncommittedChanges,
  printAutoMappings,
  importingSuitesOf,
  UNWIRED_SHARED_MODULES,
  repoRoot,
  buildSelectionManifest,
} from '../scripts/test-fast.mjs';
import { parseFilterArgs } from './test-helpers.mjs';

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

  // The names come from the registry AT RUNTIME (web-uplift-jyyq): the registry discovers the suite files
  // and aggregates the list each suite owns, so `--list` is the authority that a filter actually selects
  // against. Reading the source was the old check, and it quietly assumed the registry named every case.
  const listed = spawnSync(process.execPath, [join(repoRoot, 'tests/regression.mjs'), '--list'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert(listed.status === 0, `tests/regression.mjs --list must exit 0:\n${listed.stdout}\n${listed.stderr}`);
  const testNames = listed.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^test[A-Za-z0-9_]+$/.test(l));

  assert(testNames.length >= 100, `Expected at least 100 tests in the registry, found ${testNames.length}`);

  // The rule this guards (web-uplift-jyyq): adding a case must not require a registry edit, so the registry
  // must not NAME cases - neither by importing test functions nor by listing them in an array.
  const regressionSrc = readFileSync(join(repoRoot, 'tests/regression.mjs'), 'utf8');
  const namedImports = [...regressionSrc.matchAll(/import[ \t]*\{([^}]*)\}[ \t]*from/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()))
    .filter((name) => /^test[A-Za-z0-9_]+$/.test(name));
  assert(
    namedImports.length === 0,
    `tests/regression.mjs imports cases by name (${namedImports.join(', ')}): each suite owns its list, so the registry must not name cases (web-uplift-jyyq)`,
  );
  const bareEntries = [...regressionSrc.matchAll(/^[ \t]+(test[A-Za-z0-9_]+),[ \t]*$/gm)].map((m) => m[1]);
  assert(
    bareEntries.length === 0,
    `tests/regression.mjs names ${bareEntries.length} case(s) in an array (${bareEntries.slice(0, 5).join(', ')}): a new case must not need a registry edit (web-uplift-jyyq)`,
  );

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

function testChangedFilesUseMergeBase() {
  console.log('Testing stale-branch merge-base changed-file selection...');
  const repo = mkdtempSync(join(tmpdir(), 'test-fast-merge-base-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    git('init', '-q', '-b', 'master');
    git('config', 'user.email', 'gate@test.invalid');
    git('config', 'user.name', 'gate');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');

    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    // Both branches touch the registry; the feature's test names must not include master's additions.
    const regression = join(repo, 'tests', 'regression.mjs');
    mkdirSync(join(repo, 'tests'));
    writeFileSync(regression, 'function testFeature() {}\n');
    git('add', '.');
    git('commit', '-qm', 'feature');

    git('checkout', '-q', 'master');
    writeFileSync(join(repo, 'master-only.txt'), 'master\n');
    mkdirSync(join(repo, 'tests'));
    writeFileSync(regression, 'function testMaster() {}\n');
    git('add', '.');
    git('commit', '-qm', 'master');
    git('checkout', '-q', 'feature');

    const changed = getChangedFiles(repo, 'master');
    assert.equal(changed.base, base, 'compare against the common ancestor, not master tip');
    assert.deepEqual(changed.files.sort(), ['feature.txt', 'tests/regression.mjs']);
    assert.deepEqual(getChangedRegressionTests(repo, 'master'), ['testFeature'], 'master-only regression cases must not be selected');
    // A CLEAN worktree has nothing to disclaim, and the distance is stated so a large diff can be
    // attributed to the comparison point rather than to the branch (web-uplift-5e9s (2)).
    assert.deepEqual(changed.uncommitted, [], 'a clean worktree must report no uncommitted paths');
    assert.deepEqual(getDiffDistance(repo, 'master'), { ahead: 1, behind: 1 }, 'the distance must count each side of the fork');

    writeFileSync(join(repo, 'base.txt'), 'base\nuncommitted\n');
    writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');
    const local = getChangedFiles(repo, 'master');
    assert(local.files.includes('base.txt') && local.files.includes('untracked.txt'), 'tracked edits and untracked files must still count');
    // WHAT THE RUN SELECTS vs WHAT A COMMITTED-TREE VERDICT COVERS (web-uplift-5e9s (1)): the working-tree
    // paths are still selected, and they are named with why they are not in HEAD.
    assert.deepEqual(
      local.uncommitted,
      [
        { path: 'base.txt', kind: 'modified' },
        { path: 'untracked.txt', kind: 'untracked' },
      ],
      'every selected path that is not in HEAD must be named with its kind'
    );
    assert(!local.uncommitted.some((u) => u.path === 'feature.txt'), 'a committed branch path is not uncommitted');
    assert.equal(getUncommittedChanges(repo).get('tests/regression.mjs'), undefined, 'an untouched committed path has no status entry');

    // GIT'S DEFAULT C-QUOTING MUST NOT HIDE A PATH (web-uplift-4bqu). With core.quotePath at its default,
    // `git status --porcelain` escaped this name as \303\251 space.txt while `git diff --name-only`
    // escaped it differently, so the two sources disagreed, the uncommitted set came out EMPTY and the
    // provenance warning never printed for a path the run had selected. Every source now reads -z output,
    // where paths are raw and byte-identical.
    const unicodeName = 'é space.txt';
    writeFileSync(join(repo, unicodeName), 'unicode\n');
    const quoted = getChangedFiles(repo, 'master');
    assert(
      quoted.files.includes(unicodeName),
      `a non-ASCII path must be selected literally, not C-quoted: ${JSON.stringify(quoted.files)}`
    );
    assert.deepEqual(
      quoted.uncommitted.find((u) => u.path === unicodeName),
      { path: unicodeName, kind: 'untracked' },
      'a non-ASCII untracked path must still be named as uncommitted (web-uplift-4bqu)'
    );
    assert(
      !quoted.files.some((p) => p.includes('\\303') || p.startsWith('"')),
      `no selected path may retain a C-quote or C-escape: ${JSON.stringify(quoted.files)}`
    );

    git('mv', 'base.txt', 'renamed.txt');
    const renamed = getChangedFiles(repo, 'master');
    assert.deepEqual(
      renamed.uncommitted.find((u) => u.path === 'renamed.txt'),
      { path: 'renamed.txt', kind: 'modified' },
      'a rename must be reported at its destination path'
    );
    assert(
      !renamed.uncommitted.some((u) => u.path === 'base.txt'),
      'the rename SOURCE is a field of the status entry, not a second uncommitted path'
    );
    assert(getChangedFiles(repo, 'HEAD~1').files.includes('feature.txt'), 'an ancestor --diff ref must still select feature changes');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  console.log('✔ Stale branch selects only feature changes, plus working-tree edits');
}

/**
 * The diff provenance a lane READS: base sha, distance, and the uncommitted paths the run selected. The
 * unit-level classification is pinned in testChangedFilesUseMergeBase; this is the printed form, in an
 * isolated copy of the gate with its own git repo, so no lane's worktree is touched. The clean second run
 * is the negative control: the block must not appear when there is nothing to disclaim.
 */
function testDiffProvenanceIsReported() {
  console.log('Testing that the diff provenance names the base, the distance and the uncommitted paths...');
  const temp = mkdtempSync(join(tmpdir(), 'test-fast-provenance-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: temp, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    mkdirSync(join(temp, 'scripts'));
    copyFileSync(join(repoRoot, 'scripts', 'test-fast.mjs'), join(temp, 'scripts', 'test-fast.mjs'));
    writeFileSync(join(temp, 'package.json'), '{"type":"module"}\n');
    git('init', '-q', '-b', 'master');
    git('config', 'user.email', 'gate@test.invalid');
    git('config', 'user.name', 'gate');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(temp, 'base.txt'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const fork = git('rev-parse', '--short', 'HEAD');

    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(temp, 'feature.txt'), 'feature\n');
    git('add', '.');
    git('commit', '-qm', 'feature');
    git('checkout', '-q', 'master');
    writeFileSync(join(temp, 'master-only.txt'), 'master\n');
    git('add', '.');
    git('commit', '-qm', 'master');
    git('checkout', '-q', 'feature');

    writeFileSync(join(temp, 'base.txt'), 'base\nuncommitted\n');
    writeFileSync(join(temp, 'untracked.txt'), 'untracked\n');
    // A quotable path (Git's default core.quotePath escapes this one) must be reported like any other:
    // before web-uplift-4bqu it was selected but silently absent from the uncommitted block.
    writeFileSync(join(temp, 'é space.txt'), 'unicode\n');

    const fast = join(temp, 'scripts', 'test-fast.mjs');
    const dirty = spawnSync(process.execPath, [fast, '--dry-run'], { cwd: temp, encoding: 'utf8', timeout: 20000 });
    assert.equal(dirty.status, 0, `a dirty-tree dry run must succeed: ${dirty.stderr}`);
    assert(
      dirty.stdout.includes(`vs base ${fork} (merge-base of master); branch 1 ahead / 1 behind master`),
      `the run must name the BASE it compared against and the distance, not the ref alone:\n${dirty.stdout}`
    );
    assert(dirty.stdout.includes('base.txt  [uncommitted: modified]'), 'a modified working-tree path must be marked in the file list');
    assert(dirty.stdout.includes('untracked.txt  [uncommitted: untracked]'), 'an untracked selected path must be marked too');
    assert(
      dirty.stdout.includes('é space.txt  [uncommitted: untracked]'),
      'a quotable non-ASCII path must be marked like any other (web-uplift-4bqu)'
    );
    assert(dirty.stdout.includes('UNCOMMITTED (3 of 4)'), 'the block must count the uncommitted share of the selection');
    assert(
      dirty.stdout.includes('base.txt [modified]') && dirty.stdout.includes('untracked.txt [untracked]'),
      'the block must list each path and kind'
    );
    assert(dirty.stdout.includes('é space.txt [untracked]'), 'the block must list the quotable path too');
    assert(
      dirty.stdout.includes('This run selects and executes against the WORKING TREE. Its result is not a verdict for HEAD alone'),
      'the run must state that a committed-tree verdict does not describe this selection'
    );

    // NEGATIVE CONTROL: nothing uncommitted -> no block, and the same honest base line.
    git('checkout', '-q', '--', 'base.txt');
    rmSync(join(temp, 'untracked.txt'));
    rmSync(join(temp, 'é space.txt'));
    const clean = spawnSync(process.execPath, [fast, '--dry-run'], { cwd: temp, encoding: 'utf8', timeout: 20000 });
    assert.equal(clean.status, 0, `a clean-tree dry run must succeed: ${clean.stderr}`);
    assert(clean.stdout.includes(`vs base ${fork} (merge-base of master); branch 1 ahead / 1 behind master`), 'the base and distance must be stated on a clean tree too');
    assert(!clean.stdout.includes('UNCOMMITTED'), 'a clean worktree must not print an uncommitted block');
    assert(!clean.stdout.includes('[uncommitted:'), 'a clean worktree must mark no path as uncommitted');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  console.log('✔ Base, distance and uncommitted paths are reported, and the clean control stays quiet');
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

  // AN UNKNOWN FLAG MUST REFUSE, NOT RUN (web-uplift-rpc9). This is the control for that fix: on the
  // unfixed implementation `--help` matched no branch, was dropped, and the aggregator started every case,
  // so the assertion below fails on the behaviour rather than on the exit code alone. The spawns are
  // bounded because that is what the unfixed path does: it runs until it is killed.
  const helpRes = spawnSync(process.execPath, [regScript, '--help'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(helpRes.status, 0, '--help must print usage and exit 0, not start a run');
  assert(/usage: node <suite-file>\.mjs/.test(helpRes.stdout), '--help must print the usage line');
  assert(!helpRes.stdout.includes('tests OK'), '--help must not run any case');

  const unknownRes = spawnSync(process.execPath, [regScript, '--definitely-not-a-flag'], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(unknownRes.status, 0, 'an unknown flag must exit non-zero');
  assert(
    unknownRes.stderr.includes('unknown flag: --definitely-not-a-flag'),
    'an unknown flag must be named on stderr (this is the assertion the unfixed implementation fails)',
  );
  assert(!unknownRes.stdout.includes('tests OK'), 'an unknown flag must not run cases to completion');

  // The guard must not have redefined the default: no flags still selects every case rather than refusing.
  assert.deepEqual(parseFilterArgs([]), { filters: [], list: false }, 'no flags must still mean every case');

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

function testChangedSuiteAutoMap() {
  console.log('Testing changed-suite-only auto-map and visible refusal (web-uplift-tp77)...');
  const module = 'scripts/new-tool.mjs';
  const suite = 'tests/syntax-core.test.mjs';
  const otherSuite = 'tests/evidence.test.mjs';
  const sources = {
    [suite]: "import '../scripts/new-tool.mjs'; const fixture = 'scripts/new-tool.mjs';",
    [otherSuite]: "const command = ['scripts/new-tool.mjs'];",
  };
  let reads = 0;
  const options = { exists: () => true, readSuite: (path) => { reads++; return sources[path]; } };

  const named = mapFilesToTests([module, suite], options);
  // web-uplift-h68z deliberately re-narrows web-uplift-tp77 here. The auto-map still runs the naming suite
  // and still prints it, but it no longer reaches a GREEN verdict on its own: the mapping answers 'was this
  // diff tested?' and not 'does main carry a rule for this executable?', and it was the second question that
  // web-uplift-ebvj slipped past. So the file stays refused until the map names it.
  assert.deepEqual(named.unmappedFiles, [module], 'an auto-mapped executable is still refused until the map carries a rule for it');
  assert.deepEqual(named.autoMappedFiles, [{ path: module, suite }], 'mapping identifies its actual changed suite');
  assert(named.targets.some((target) => target.path === suite), 'the naming suite must run');
  assert.equal(reads, 1, 'only the changed suite source is inspected once');
  const printed = [];
  printAutoMappings(named, (line) => printed.push(line));
  assert(printed.some((line) => line.includes(`auto-mapped ${module} -> ${suite}`)), 'successful auto-maps must be printed');
  assert(printed.some((line) => line.includes('1 changed suite(s)')), 'scan boundary must be printed');

  const both = mapFilesToTests([module, suite, otherSuite], options);
  assert.deepEqual(both.autoMappedFiles, [{ path: module, suite: otherSuite }, { path: module, suite }], 'every changed naming suite is recorded');
  const bothPrinted = [];
  printAutoMappings(both, (line) => bothPrinted.push(line));
  assert.equal(bothPrinted.filter((line) => line.includes(`auto-mapped ${module} ->`)).length, 2, 'print every mapping occurrence');
  assert.equal(both.autoMapScan.suites, 2, 'only two changed suite sources are scanned');

  const unnamed = mapFilesToTests(['scripts/unknown.mjs', suite], options);
  assert.deepEqual(unnamed.unmappedFiles, ['scripts/unknown.mjs'], 'an unnamed executable must STILL refuse');
  assert.equal(unnamed.autoMappedFiles.length, 0, 'a changed suite does not imply coverage by itself');
  assert.deepEqual(mapFilesToTests([module], options).unmappedFiles, [module], 'an unchanged naming suite cannot auto-map');
  const wrongPath = mapFilesToTests(['other/new-tool.mjs', suite], options);
  assert.deepEqual(wrongPath.unmappedFiles, ['other/new-tool.mjs'], 'a basename collision must not auto-map');
  const mixed = mapFilesToTests([module, 'scripts/unknown.mjs', suite], options);
  const mixedPrinted = [];
  printAutoMappings(mixed, (line) => mixedPrinted.push(line));
  assert(mixedPrinted.some((line) => line.includes(`auto-mapped ${module} -> ${suite}`)) && mixed.unmappedFiles.includes('scripts/unknown.mjs'),
    'a successful mapping must be printed even when another executable still refuses');
  // Exercise the actual CLI, including a successful test run, in an isolated tiny copy of this gate.
  // No suite or fixture is written into another lane's worktree.
  const temp = mkdtempSync(join(tmpdir(), 'test-fast-auto-map-'));
  try {
    mkdirSync(join(temp, 'scripts'));
    mkdirSync(join(temp, 'tests'));
    copyFileSync(join(repoRoot, 'scripts', 'test-fast.mjs'), join(temp, 'scripts', 'test-fast.mjs'));
    writeFileSync(join(temp, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(temp, module), 'export const value = 1;\n');
    writeFileSync(join(temp, 'scripts', 'orphan.mjs'), 'export const orphan = 1;\n');
    writeFileSync(join(temp, 'tests', 'new-tool.test.mjs'), "import { value } from '../scripts/new-tool.mjs'; if (value !== 1) throw Error('bad');\n");
    const fast = join(temp, 'scripts', 'test-fast.mjs');
    const suitePath = 'tests/new-tool.test.mjs';
    const success = spawnSync(process.execPath, [fast, module, suitePath], { cwd: temp, encoding: 'utf8', timeout: 15000 });
    // web-uplift-h68z re-narrows tp77 at the CLI level too: the auto-map is recorded and printed, but the run
    // REFUSES, because the mapping proves this diff exercised the file and not that main carries a rule for it.
    // The refusal returns before any target runs, so the naming suite does not execute - that is the friction
    // tp77 removed and this restores, deliberately and with the reason named.
    assert.notEqual(success.status, 0, 'an auto-mapped module with no map rule must still refuse');
    assert(success.stderr.includes('fast-gate: FAIL'), 'the refusal must say FAIL');
    assert(success.stdout.includes(`auto-mapped ${module} -> ${suitePath}`), 'successful CLI run must print the map');
    assert(success.stdout.includes(`fast-gate: unmapped: ${module}`), 'the refusal must name the executable and the missing rule');
    const dry = spawnSync(process.execPath, [fast, '--dry-run', module, suitePath], { cwd: temp, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(dry.status, 0, 'the dry run must refuse the same pair, so the verdict cannot be a green dry run either');
    assert(dry.stdout.includes(`auto-mapped ${module} -> ${suitePath}`), 'dry run must print the map too');
    const refusal = spawnSync(process.execPath, [fast, 'scripts/orphan.mjs', suitePath], { cwd: temp, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(refusal.status, 0, 'unnamed module must still refuse in a mixed diff');
    assert(refusal.stdout.includes('fast-gate: unmapped: scripts/orphan.mjs'), 'refusal must name the unmapped path');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  console.log('✔ Auto-map names only changed suites, prints every occurrence, and refuses unnamed paths');
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
 * A refusal must be ACTIONABLE (web-uplift-coord, the condition on this bead) and the policy must be
 * readable without running the gate and checked against the code. Three artefacts, all walked here:
 *   - AGENTS.md: where a lane looks first, and it must name the ESCAPE as well as the rules (a lane that
 *     cannot see the way forward adds an omission rule to make the gate green);
 *   - docs/speed.md: the readable record, whose omission table is PARSED and compared to OMITTED_RULES
 *     verbatim, so a wrong-but-plausible reason with a right rule id fails (round-3 finding P2 - an
 *     id-presence check would have passed exactly that);
 *   - `--list`: the executable half, printing each rule AND its reason from the single source of truth.
 */
function testRefusalIsActionableAndDocumented() {
  console.log('Testing that a refusal names the next action and that the policy is documented...');

  const docs = {
    'AGENTS.md': readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8'),
    'docs/speed.md': readFileSync(join(repoRoot, 'docs', 'speed.md'), 'utf8'),
  };
  for (const [name, doc] of Object.entries(docs)) {
    assert(doc.includes('fast-gate: unmapped:'), `${name} must name the marker a lane will see`);
    assert(/NEXT ACTION/.test(doc), `${name} must carry the one next action, not only the policy`);
    assert(doc.includes('KNOWN_STANDALONE_TESTS') && doc.includes('OMITTED_RULES'), `${name} must name both mapping routes`);
    assert(/FLEET_CHECK_CONF=\S+\s+fleet-check/.test(doc), `${name} must name the escape with its config override`);
    // Import alone does not execute a guarded standalone suite: its importer must invoke its tests.
    const normalizedDoc = doc.replace(/\s+/g, ' ');
    assert(
      /`npm test` runs `tests\/\*\.test\.mjs`/.test(normalizedDoc)
        && /guarded standalone suites/i.test(normalizedDoc) && /unimported/i.test(normalizedDoc)
        && /only (?:if|when)(?:\*\*)? .*invoke/i.test(normalizedDoc)
        && /import alone/i.test(normalizedDoc) && /registering `node:test` cases at import time/i.test(normalizedDoc)
        && /not evidence on its own/i.test(normalizedDoc),
      `${name} must qualify coverage on invocation, not merely import, and distinguish unimported paths`
    );
    for (const rule of OMITTED_RULES) {
      assert(doc.includes(`\`${rule.id}\``), `${name} must name the omission rule ${rule.id}`);
    }
  }

  // The readable record's table is DATA: parse the rows and compare the reason cell to the rule's own reason
  // string, and fail on a row for a rule that no longer exists.
  const tableRows = new Map();
  for (const line of docs['docs/speed.md'].split('\n')) {
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
  // The claimed cost is a number with provenance, and the spawn count is the kind of detail that rots
  // silently when a test is added (round-3 finding P2). web-uplift-opyk: a hand-pinned literal rotted to
  // six while the guarded functions held eight, and the guard then REJECTED the corrected value, so a
  // lane that fixed the number turned the gate red. The count is now DERIVED from this file's guarded
  // test functions and the document is required to state it, so adding a probe fails here with the
  // number to write rather than pinning a stale one.
  const selfSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const guardedFunctions = [
    'testUnmappedExecutablePathsFailClosed',
    'testRefusalIsActionableAndDocumented',
    'testSuiteExecutionMarkers',
    'testDiffProvenanceIsReported',
  ];
  const guardedSpawns = guardedFunctions.map((name) => {
    const start = selfSource.indexOf(`\nfunction ${name}()`);
    assert.notEqual(start, -1, `the guarded spawn census must find ${name}`);
    const end = selfSource.indexOf('\n}\n', start);
    assert.notEqual(end, -1, `the guarded spawn census must find the end of ${name}`);
    return { name, count: (selfSource.slice(start, end).match(/spawnSync\(process\.execPath/g) || []).length };
  });
  const guardedSpawnCount = guardedSpawns.reduce((sum, fn) => sum + fn.count, 0);
  assert(guardedSpawns.every((fn) => fn.count > 0), `every guarded function must spawn a bounded node: ${JSON.stringify(guardedSpawns)}`);
  const census = guardedSpawns.map((fn) => `${fn.name}=${fn.count}`).join(', ');
  assert(
    docs['docs/speed.md'].includes(`guarded spawn count is ${guardedSpawnCount}`),
    `docs/speed.md must state the live guarded spawn count (${guardedSpawnCount}) derived from this file: ${census}`
  );
  assert(/7\.2s direct/.test(docs['docs/speed.md']) && /11\.0s in the cached/.test(docs['docs/speed.md']), 'docs/speed.md must give each timing sample with its provenance');

  // The executable half: `--list` prints every rule and its reason from the data.
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
      res.stderr.includes('the guarded standalone suites here are covered ONLY if those files invoke their tests. Import alone does not run them.')
        && res.stderr.includes('A module that registers node:test cases at import time can instead run them on import'),
      'the refusal must qualify guarded coverage on invocation and acknowledge import-time registration'
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

  // The actual guarded standalone module does no test work when imported. Its exported function
  // produces the observable census result only when the importing process invokes it.
  const guardedSuite = join(repoRoot, 'tests', 'census-targets.mjs');
  const importOnly = spawnSync(process.execPath, ['--input-type=module', '-e',
    'await import(process.argv[2])', 'importer', guardedSuite], { encoding: 'utf8', timeout: 10000 });
  assert.equal(importOnly.status, 0, `guarded import should succeed: ${importOnly.stderr}`);
  assert.equal(importOnly.stdout, '', 'importing the guarded standalone suite alone must not run its tests');
  const invoked = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const suite = await import(process.argv[2]); await suite.testCensusTargetsAreTracked()', 'importer', guardedSuite],
  { encoding: 'utf8', timeout: 10000 });
  assert.equal(invoked.status, 0, `invoked guarded test should pass: ${invoked.stderr}`);
  assert.match(invoked.stdout, /census targets OK:/, 'invoking the exported test must produce the census verdict');

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

  // The two browser-site trees now select the suite that reads all their JavaScript modules;
  // non-executable files beside them remain omitted, not silently included in this mapping.
  const fixture = mapFilesToTests(
    ['playground/app.js', 'eval/fixtures/seeded-issues/site/scenarios/motion.js', 'playground/README.md', 'playground/expected-findings.json'],
    existsAlways
  );
  assert.deepEqual(fixture.unmappedFiles, [], 'both site JavaScript trees must map to a real suite');
  assert(fixture.matchedSubsystems.includes('fixture-sites'), 'both sites must select the fixture-sites subsystem');
  assert(fixture.targets.some((target) => target.path === 'tests/fixture-sites.test.mjs'), 'the selected suite must read the site modules');
  assert.equal(fixture.omittedFiles.length, 2, 'the non-executable files beside it are omitted');
  const unrelatedFixtureCode = mapFilesToTests(['eval/other-script.js'], existsAlways);
  assert.deepEqual(unrelatedFixtureCode.unmappedFiles, ['eval/other-script.js'], 'other executable fixture paths must still be refused');
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
  // No authored executable may remain unmapped after web-uplift-5r7z.
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
  assert.deepEqual(unmappedExecutables, [], 'every authored tracked executable must be mapped or covered by a named rule');
  assert(CODE_EXTENSIONS.has('.mjs'), 'the executable-extension set must describe this repo\'s modules');

  console.log(
    `✔ ${OMITTED_RULES.length} named omission rules; ${tracked.length} tracked paths classified (${unmappedExecutables.length} unmapped executables, ${omittedExecutables.length} recorded-artefact executables declared)`
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

function testSharedModulesAreWiredOrRefused() {
  console.log('Testing that a shared test module cannot select only the gate\'s self-tests...');

  // COMPUTED FROM THE TREE, not from the declarations in the gate: the point of this control is that it
  // fails when a module a suite imports is wired to something that cannot exercise it, which is exactly
  // what tests/test-helpers.mjs did while running only the gate's own self-tests (web-uplift-5y2w).
  const suitesDir = join(repoRoot, 'tests');
  const sharedModules = readdirSync(suitesDir)
    .filter((entry) => entry.endsWith('.mjs'))
    .map((entry) => `tests/${entry}`)
    .filter((rel) => rel !== 'tests/regression.mjs' && !isDirectRunnableTest(rel))
    .filter((rel) => importingSuitesOf(rel).length > 0)
    .sort();

  assert(sharedModules.length >= 8,
    `this control must see the shared modules it is meant to police (found ${sharedModules.length}: ${sharedModules.join(', ')})`);

  const problems = [];
  // A target covers a module when it IS the module, when it is a suite that imports it, or when its own
  // source imports it - a runnable check that imports the changed module can fail for it, which is the
  // property the wiring is for. Compared against the tree, so this cannot pass by agreeing with itself.
  const reaches = (targetPath, module) => {
    if (targetPath === module) return true;
    let source;
    try {
      source = readFileSync(join(repoRoot, targetPath), 'utf8');
    } catch {
      return false;
    }
    return source.includes(module.split('/').pop());
  };
  for (const module of sharedModules) {
    const consumers = importingSuitesOf(module);
    const plan = mapFilesToTests([module], { exists: () => true });
    const selected = plan.targets.map((t) => t.path).filter(Boolean);
    const wired = plan.refusedFiles.length === 1 || selected.some((p) => p === module || consumers.includes(p) || reaches(p, module));

    const exempt = UNWIRED_SHARED_MODULES.find((entry) => entry.file === module);
    if (exempt) {
      // A declared exemption must stay TRUE: wiring one without removing it would leave the declaration
      // lying about the map, which is the failure this whole control exists to catch (web-uplift-ev2u).
      assert(!wired,
        `${module} is declared unwired (${exempt.reason}) but now reaches a target that can fail for it - remove the exemption instead of leaving the declaration stale`);
      continue;
    }

    if (plan.refusedFiles.length === 1) {
      // A refusal is a valid answer ONLY with its consumers named: an unexplained refusal is the same
      // invisible basis this control exists to prevent.
      const named = plan.refusedFiles[0].consumers;
      const missing = consumers.filter((c) => !named.includes(c));
      if (missing.length > 0) {
        problems.push(`${module}: refuses but does not name ${missing.join(', ')} (named: ${named.join(', ') || 'nothing'})`);
      }
      continue;
    }
    if (!wired) {
      problems.push(`${module}: imported by ${consumers.join(', ')} but selects ${selected.join(', ') || 'nothing'}`);
    }
  }
  assert(problems.length === 0,
    `a shared module must run a suite that imports it, or refuse and name its consumers:\n  ${problems.join('\n  ')}`);

  // The exemptions are policed INDEPENDENTLY of the derived list: a declaration about the map must not
  // become stale just because a text scan stopped seeing the module's import (web-uplift-ev2u).
  for (const exempt of UNWIRED_SHARED_MODULES) {
    const consumers = importingSuitesOf(exempt.file);
    const plan = mapFilesToTests([exempt.file], { exists: () => true });
    const selected = plan.targets.map((t) => t.path).filter(Boolean);
    const nowWired = plan.refusedFiles.length === 1 || selected.some((p) => p === exempt.file || consumers.includes(p) || reaches(p, exempt.file));
    assert(!nowWired,
      `${exempt.file} is declared unwired (${exempt.reason}) but its plan now reaches a target that can fail for it - remove the exemption`);
  }

  // The two shapes this bead had to fix, pinned by name so a future rewiring cannot quietly undo them.
  const helperPlan = mapFilesToTests(['tests/test-helpers.mjs'], { exists: () => true });
  assert(helperPlan.refusedFiles.length === 1,
    'tests/test-helpers.mjs must REFUSE: its 8 consumer suites are most of the fast tier, so a subset would read as coverage');
  assert(helperPlan.refusedFiles[0].consumers.includes('tests/runner-agents.test.mjs'),
    `the refusal must name the suites that import it (named: ${helperPlan.refusedFiles[0].consumers.join(', ')})`);
  for (const module of ['tests/log-redaction.mjs', 'tests/credential-redaction.mjs']) {
    const plan = mapFilesToTests([module], { exists: () => true });
    const paths = plan.targets.map((t) => t.path);
    assert(paths.includes('tests/redaction.test.mjs') && plan.refusedFiles.length === 0,
      `${module} must select its one consumer suite tests/redaction.test.mjs instead of refusing (selected: ${paths.join(', ') || 'nothing'})`);
  }
  console.log(`✔ ${sharedModules.length} shared module(s) either run an importing suite or refuse with their consumers named`);
}

function runAll() {
  testSubsystemMappings();
  testNonTestExclusion();
  testAllRegressionFiltersAreValid();
  testDeduplicationAndFallback();
  testChangedFilesUseMergeBase();
  testDiffProvenanceIsReported();
  testCliDryRunAndListAndAll();
  testRegressionFilterCli();
  testMissingTargetSkippedCleanly();
  testFailingTargetExitsNonZero();
  testSlowTargetTimesOutWithExit124();
  testUnmappedExecutablePathsFailClosed();
  testChangedSuiteAutoMap();
  testH68zAutoMappedExecutableIsRefusedAndRunsTheControls();
  testSelectionManifestRefusesToCertifyIncompleteRuns();
  testSelectionManifestTreeAndPathFidelity();
  testSkippedTargetNeverCertifies();
  testOmittedRulesAreNamedAndNarrow();
  testRefusalIsActionableAndDocumented();
  testSuiteExecutionMarkers();
  testSharedModulesAreWiredOrRefused();
  console.log('\nAll fast gate unit and integration tests passed successfully.');
}

runAll();

function testH68zAutoMappedExecutableIsRefusedAndRunsTheControls() {
  console.log('Testing that an auto-mapped executable is still refused and pulls in the gate controls (web-uplift-h68z)...');
  // The suite must be one the gate ALREADY knows, or the fixture would refuse the suite too and the assertions
  // below would be measuring two things at once. The sources are injected, so what the real file contains is
  // irrelevant here - this case is about how the MODULE path is classified.
  const module = 'scripts/h68z-new-tool.mjs';
  const suite = 'tests/syntax-core.test.mjs';
  const sources = { [suite]: "import '../scripts/h68z-new-tool.mjs';" };
  const options = { exists: () => true, readSuite: (path) => sources[path] };
  const controlLabel = 'Fast gate unit and integration tests';

  // POSITIVE: a changed suite names the new executable, so the auto-map fires and that suite runs...
  const named = mapFilesToTests([module, suite], options);
  assert.deepEqual(named.autoMappedFiles, [{ path: module, suite }], 'the auto-map must record the naming suite');
  assert(named.targets.some((t) => t.path === suite), 'the plan must select the suite the auto-map identified');
  // ...but the file is STILL refused: the auto-map answers "was this diff tested?", not "does main carry a rule
  // for this executable?", and it was the second question web-uplift-ebvj slipped past (the h68z re-narrowing).
  assert.deepEqual(named.unmappedFiles, [module], 'an auto-mapped executable must still be refused until the map names it');
  // ...and the gate's own map/completeness controls are selected, which is the half that failed for ebvj.
  assert(named.targets.some((t) => t.label === controlLabel), 'an auto-map must select the map/completeness controls');

  // NEGATIVE 1: drop the naming suite and nothing fires, so both positives above are caused by the auto-map.
  const unnamed = mapFilesToTests([module], options);
  assert.equal(unnamed.autoMappedFiles.length, 0, 'nothing names the executable, so nothing is auto-mapped');
  assert.deepEqual(unnamed.unmappedFiles, [module], 'it is refused whether or not it is named');
  assert(!unnamed.targets.some((t) => t.label === controlLabel), 'no auto-map, no control run');

  // NEGATIVE 2: a module the map already carries never auto-maps, so it must not drag the control suite in.
  const mapped = mapFilesToTests(['tests/filter-args.mjs'], options);
  assert.equal(mapped.autoMappedFiles.length, 0, 'a mapped module does not auto-map');
  assert.deepEqual(mapped.unmappedFiles, [], 'a mapped module is not refused');
  assert(!mapped.targets.some((t) => t.label === controlLabel), 'a mapped module does not pull in the gate self-test');

  console.log('\u2714 auto-mapped executables are refused and run the completeness controls');
}

// web-uplift-5jwc / ADR web-uplift-tdg4: a fast verdict must distinguish EXECUTION from CERTIFIED COVERAGE of one
// exact committed tree. The producer is a pure function, so the certifying rule is exercised directly, with no
// git, no clock and no machine state - and the negatives below are the cases that make the positive mean
// something: each one is a run that exits 0 and must still refuse to certify.
function testSelectionManifestRefusesToCertifyIncompleteRuns() {
  console.log('Testing that the selection manifest refuses to certify incomplete or non-exact-tree runs (web-uplift-5jwc)...');
  const helper = 'tests/log-redaction.mjs';
  const consumer = 'tests/redaction.test.mjs';
  const changed = { files: [helper], uncommitted: [], base: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', resolvedRef: 'origin/master' };
  const tree = 'b'.repeat(40);
  const head = 'a'.repeat(40);
  const planOf = (files) => mapFilesToTests(files, { diffRef: 'origin/master', exists: () => true });
  const build = (plan, over = {}) => buildSelectionManifest({
    plan, changed, mode: 'execute', diffRef: 'origin/master', head, tree,
    executed: plan.targets.map((t) => ({ label: t.label, ok: true })),
    ...over,
  });

  // POSITIVE FIRST: a clean execute run with every naming consumer selected certifies, and says so with no reasons.
  const full = planOf([helper]);
  assert(full.targets.some((t) => t.path === consumer), 'the fixture must select the consumer suite, or the rest of this case is vacuous');
  const certified = build(full);
  assert.equal(certified.certifiable, true, `a clean execute run with every consumer selected must certify (reasons: ${certified.nonCertifyingReasons.join('; ')})`);
  assert.deepEqual(certified.nonCertifyingReasons, [], 'a certifying manifest carries no reasons');
  assert.equal(certified.tree, tree, 'the manifest names the exact tree it certifies');

  // THE 5y2w SHAPE: the helper is mapped, a suite that NAMES it is not selected. Tests exit 0 and it must refuse.
  const partial = { ...full, targets: full.targets.filter((t) => t.path !== consumer) };
  const underselected = build(partial);
  assert.equal(underselected.certifiable, false, 'a mapped helper whose naming consumer was omitted must not certify');
  assert(underselected.requiredConsumersMissing.some((m) => m.path === helper && m.consumer === consumer),
    'the manifest must name the omitted pair, not merely flag a problem');
  assert(underselected.nonCertifyingReasons.some((r) => r.includes(consumer)), 'the reason must name the omitted consumer');

  // A DIRTY TREE is iteration evidence: it observed the working tree, not the tree a cached verdict is keyed to.
  const dirty = build(full, { changed: { ...changed, uncommitted: [{ path: helper, kind: 'modified' }] } });
  assert.equal(dirty.certifiable, false, 'a run over uncommitted changes must not certify the committed tree');
  assert(dirty.nonCertifyingReasons.some((r) => r.includes(helper) && r.includes('uncommitted')),
    'the reason must name the uncommitted path and say why that matters');

  // NO TREE: a verdict is keyed to a tree, so a run that cannot name one cannot certify one.
  const noTree = build(full, { tree: null, head: null });
  assert.equal(noTree.certifiable, false, 'a run that cannot read a committed tree must not certify');
  assert(noTree.nonCertifyingReasons.some((r) => r.includes('no committed tree')), 'the reason must say the tree could not be read');

  // A DRY RUN executed nothing, and an EXPLICIT-FILE selection is not a complete selection for the tree.
  assert.equal(build(full, { mode: 'dry-run', executed: [] }).certifiable, false, 'a dry run certifies nothing');
  assert.equal(build(full, { explicitSelection: true }).certifiable, false, 'an explicit-file selection cannot certify the tree');

  // Unmapped and refused paths keep a run non-certifying even though the suites that ran exited 0.
  assert.equal(build({ ...full, unmappedFiles: ['scripts/orphan.mjs'] }).certifiable, false, 'an unmapped changed executable must not certify');
  assert.equal(build({ ...full, refusedFiles: [{ path: helper, consumers: [consumer] }] }).certifiable, false, 'a full-gate-only refusal must not certify');
  // A target that reported failure, or never reported, is not a pass either.
  assert.equal(build(full, { executed: [{ label: 'x', ok: false, status: 1 }] }).certifiable, false, 'a failed target must not certify');
  assert.equal(build(full, { executed: [] }).certifiable, false, 'a target with no reported status must not certify');

  console.log('\u2714 the selection manifest certifies only a clean, complete execute run on one exact tree');
}

// The git-facing half: the manifest must name a real tree, the merge-base it compared against, both commits of a
// multi-commit branch (the web-uplift-1rwo mechanism), and a Unicode untracked path exactly (web-uplift-4bqu).
function testSelectionManifestTreeAndPathFidelity() {
  console.log('Testing that the manifest names the real tree, the merge-base, and untracked paths exactly (web-uplift-5jwc)...');
  const temp = mkdtempSync(join(tmpdir(), 'test-fast-manifest-'));
  const git = (...args) => execFileSync('git', args, { cwd: temp, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'master');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    mkdirSync(join(temp, 'scripts'));
    mkdirSync(join(temp, 'docs'));
    writeFileSync(join(temp, 'package.json'), '{"type":"module"}\n');
    copyFileSync(join(repoRoot, 'scripts', 'test-fast.mjs'), join(temp, 'scripts', 'test-fast.mjs'));
    writeFileSync(join(temp, 'docs', 'base.md'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    // A BRANCH two commits ahead of master: this is the shape web-uplift-1rwo documents, where a base resolved
    // as a single commit lists only the last commit's files instead of the whole delta.
    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(temp, 'docs', 'first.md'), 'one\n');
    git('add', '-A'); git('commit', '-qm', 'first');
    writeFileSync(join(temp, 'docs', 'second.md'), 'two\n');
    git('add', '-A'); git('commit', '-qm', 'second');

    // A Unicode untracked path must survive the git boundary EXACTLY - a NUL-safe read, not a line split.
    const unicodeName = 'docs/&#252;nicode \u2014 dash.md';
    writeFileSync(join(temp, unicodeName), 'x\n');

    const out = join(temp, 'manifest.json');
    const run = spawnSync(process.execPath, [join(temp, 'scripts', 'test-fast.mjs'), '--manifest', out], { cwd: temp, encoding: 'utf8', timeout: 30000 });
    const manifest = JSON.parse(readFileSync(out, 'utf8'));

    assert.equal(manifest.tree, git('rev-parse', 'HEAD^{tree}'), 'the manifest must carry the real committed tree id');
    assert.equal(manifest.comparisonBase, git('rev-parse', 'master'), 'the comparison base must be the MERGE-BASE of the branch, not the last commit (web-uplift-1rwo)');
    for (const f of ['docs/first.md', 'docs/second.md']) {
      assert(manifest.changed.includes(f), `a multi-commit branch must list ${f}, not just the last commit's files`);
    }
    assert(manifest.uncommitted.some((u) => u.path === unicodeName), `the untracked Unicode path ${JSON.stringify(unicodeName)} must survive exactly`);
    assert.equal(manifest.certifiable, false, 'an untracked path means the run observed a working tree, so it cannot certify');
    assert(manifest.nonCertifyingReasons.some((r) => r.includes('uncommitted')), 'the reason must be the uncommitted working tree');

    // NEGATIVE on the same repo: once the path is committed the tree part of the reason is GONE. What this copy
    // cannot show is a fully certifying CLI run: a temp copy has no real suite tree, so its baseline targets
    // genuinely fail and the manifest is right to refuse. The certifying positive is asserted above against the
    // pure function with injected clean facts, which is the same rule and needs no repository at all.
    git('add', '-A'); git('commit', '-qm', 'third');
    const cleanOut = join(temp, 'manifest-clean.json');
    spawnSync(process.execPath, [join(temp, 'scripts', 'test-fast.mjs'), '--manifest', cleanOut], { cwd: temp, encoding: 'utf8', timeout: 30000 });
    const cleanManifest = JSON.parse(readFileSync(cleanOut, 'utf8'));
    assert.deepEqual(cleanManifest.uncommitted, [], 'a committed tree has no uncommitted paths');
    assert(!cleanManifest.nonCertifyingReasons.some((r) => r.includes('uncommitted')),
      `the uncommitted reason must be gone once the path is committed (reasons now: ${cleanManifest.nonCertifyingReasons.join('; ')})`);
    assert.equal(cleanManifest.tree, git('rev-parse', 'HEAD^{tree}'), 'and the tree id must follow the new HEAD');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  console.log('\u2714 the manifest names the tree, the merge-base and untracked paths exactly');
}

// A target whose path does not exist is reported by runTarget as ok:true with skipped:true, so that a renamed or
// deleted suite cannot crash the gate. The certifying rule used to test only !entry.ok, which meant such a target
// certified the tree and the '(skipped)' note in its message was dead code (web-uplift-um6b). That is the same
// gap this manifest exists to close, one level down: a run that looks complete while part of its own selection
// was never executed. The second half of this case is the control that keeps the first half honest - it asserts
// the same manifest WITHOUT the skip does not raise that reason, so the case cannot pass merely because
// certifiable happens to be false for some unrelated precondition.
function testSkippedTargetNeverCertifies() {
  const plan = {
    targets: [{ type: 'node', path: 'tests/missing.test.mjs', label: 'Missing test' }],
    unmappedFiles: [], omittedFiles: [], refusedFiles: [], autoMappedFiles: [],
  };
  const args = {
    plan,
    changed: { files: ['foo.js'], uncommitted: [] },
    mode: 'execute',
    head: 'a'.repeat(40),
    tree: 'b'.repeat(40),
  };
  const skipped = buildSelectionManifest({ ...args, executed: [{ label: 'Missing test', path: 'tests/missing.test.mjs', ok: true, skipped: true }] });
  assert.equal(skipped.certifiable, false, 'a target that was skipped must not certify the tree');
  assert(
    skipped.nonCertifyingReasons.some((r) => /SKIPPED/.test(r)),
    `the reason must name the skip rather than being non-empty for some other cause: ${JSON.stringify(skipped.nonCertifyingReasons)}`,
  );
  const ran = buildSelectionManifest({ ...args, executed: [{ label: 'Missing test', path: 'tests/missing.test.mjs', ok: true, skipped: false }] });
  assert(
    !ran.nonCertifyingReasons.some((r) => /SKIPPED/.test(r)),
    `a target that ran must not be reported as skipped: ${JSON.stringify(ran.nonCertifyingReasons)}`,
  );
}
