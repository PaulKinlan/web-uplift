#!/usr/bin/env node
/**
 * scripts/test-fast.mjs - Targeted fast test gate for web-uplift.
 *
 * Runs only the tests affected by changed files (via git diff vs origin/master
 * or passed file paths), drastically reducing the test run time from 4-18 minutes
 * to a few seconds for focused changes.
 *
 * Usage:
 *   node scripts/test-fast.mjs                     # diff against origin/master
 *   node scripts/test-fast.mjs --diff <ref>        # diff against specific ref
 *   node scripts/test-fast.mjs <file...>           # test affected by explicit files
 *   node scripts/test-fast.mjs --all               # run all fast test targets
 *   node scripts/test-fast.mjs --dry-run           # print planned test targets without running
 *   node scripts/test-fast.mjs --list              # list known subsystems
 *
 * Wired via package.json "test:fast" and ~/.fleet/check.conf:
 *   CHECK_FAST_CMD="npm run test:fast"
 *   CHECK_FAST_TIMEOUT=300
 */

import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, '..');

/**
 * Explicit allowlist of standalone test files runnable directly with Node (no arguments needed).
 * Excludes CLI tools that require subcommands (mwg-catalog, mwg-artefact, mwg-drift-classify, mwg-drift-check)
 * and test fixtures (tests/fixtures/**).
 */
export const KNOWN_STANDALONE_TESTS = new Set([
  'tests/flow.mjs',
  'tests/flow-shadow-browser.mjs',
  'tests/safe-fetch.mjs',
  'tests/source-tree-symlink.mjs',
  'tests/install-copy-symlink.mjs',
  'tests/snapshot-run.mjs',
  'tests/batch-resume-isolation.mjs',
  'tests/skill-write-contract.mjs',
  'tests/cdp-copy-sync.mjs',
  'tests/changelog-version-check.mjs',
  'tests/test-fast.mjs',
  'tests/credential-redaction.mjs',
  'tests/log-redaction.mjs',
  'tests/secrets-coverage.mjs',
  'tests/mwg-catalog-extract.mjs',
  'tests/launch-loop.mjs',
  'tests/no-orphan-browser.mjs',
]);

/**
 * Determine whether a relative path represents a direct-runnable standalone test.
 */
export function isDirectRunnableTest(relPath) {
  if (relPath.startsWith('tests/fixtures/')) return false;
  if (relPath === 'tests/regression.mjs' || relPath === 'scripts/test-fast.mjs' || relPath === 'tests/test-helpers.mjs') return false;
  if (KNOWN_STANDALONE_TESTS.has(relPath)) return true;
  if (relPath.endsWith('.test.mjs') || /^tests\/test-[^/]+\.mjs$/.test(relPath)) return true;
  return false;
}

/**
 * Known subsystems and their mapped test targets.
 */
export const SUBSYSTEMS = [
  {
    id: 'flow',
    description: 'User flow recording, normalization, and browser replay',
    match: (f) => /^runner\/flow(-record)?\.mjs$/.test(f) || /^tests\/flow(-shadow-browser)?\.mjs$/.test(f),
    targets: [
      { type: 'node', path: 'tests/cdp-copy-sync.mjs', label: 'CDP copy sync byte check' },
      { type: 'node', path: 'tests/flow.mjs', label: 'Flow unit test suite' },
      { type: 'node', path: 'tests/flow-shadow-browser.mjs', label: 'Flow shadow DOM browser test' },
      { type: 'regression', filter: 'Flow', label: 'Regression: Flow tests' },
    ],
  },
  {
    id: 'safe-fetch',
    description: 'DNS rebinding protection, content decoding, and safe-fetch guards',
    match: (f) => f === 'tests/safe-fetch.mjs' || (f.startsWith('evidence/') && f.includes('safe-fetch')),
    targets: [
      { type: 'node', path: 'tests/safe-fetch.mjs', label: 'Safe-fetch DNS rebinding and decoding' },
      { type: 'regression', filter: 'SafeFetch', label: 'Regression: SafeFetch guards' },
      { type: 'regression', filter: 'PageDerivedFetch', label: 'Regression: Page-derived fetch guards' },
    ],
  },
  {
    id: 'symlink-guards',
    description: 'Source tree and install copy symlink escape and depth guards',
    match: (f) =>
      f === 'tests/source-tree-symlink.mjs' ||
      f === 'tests/install-copy-symlink.mjs' ||
      f === 'tests/snapshot-run.mjs' ||
      f === 'runner/write-scope.mjs',
    targets: [
      { type: 'node', path: 'tests/source-tree-symlink.mjs', label: 'Source-tree symlink escape tests' },
      { type: 'node', path: 'tests/install-copy-symlink.mjs', label: 'Install copy symlink escape tests' },
      { type: 'node', path: 'tests/snapshot-run.mjs', label: 'Snapshot run unit tests' },
      { type: 'regression', filter: 'Symlink', label: 'Regression: Symlink tests' },
      { type: 'regression', filter: 'WriteScope', label: 'Regression: Write-scope tests' },
      { type: 'regression', filter: 'Snapshot', label: 'Regression: Snapshot run tests' },
    ],
  },
  {
    id: 'install-and-package',
    description: 'Packaging, version agreement, install surface, and CLI manifest checks',
    match: (f) =>
      f === 'install-surface.mjs' ||
      f === 'bin/web-uplift.mjs' ||
      f === 'package.json' ||
      f === 'package-lock.json' ||
      f === 'CHANGELOG.md' ||
      f === 'tests/changelog-version-check.mjs' ||
      f === 'tests/cdp-copy-sync.mjs',
    targets: [
      { type: 'node', path: 'tests/cdp-copy-sync.mjs', label: 'CDP copy sync byte check' },
      { type: 'node', path: 'tests/changelog-version-check.mjs', label: 'Changelog and version agreement' },
      { type: 'node', path: 'tests/install-copy-symlink.mjs', label: 'Install copy symlink tests' },
      { type: 'regression', filter: 'InstallSurface', label: 'Regression: Install surface tests' },
      { type: 'regression', filter: 'Installed', label: 'Regression: Installed evidence CLI tests' },
      { type: 'regression', filter: 'Update', label: 'Regression: Update check tests' },
    ],
  },
  {
    id: 'mwg',
    description: 'Modern Web Guidance catalog, drift checking, and principles sync',
    match: (f) =>
      f.startsWith('knowledge/') ||
      f.startsWith('docs/mwg-') ||
      /^tests\/mwg-.*\.mjs$/.test(f),
    targets: [
      { type: 'node', path: 'tests/cdp-copy-sync.mjs', label: 'CDP copy sync byte check' },
      { type: 'node', path: 'tests/mwg-artefact.mjs', args: ['verify'], label: 'MWG artifact verification' },
      { type: 'node', path: 'tests/mwg-catalog-extract.mjs', label: 'MWG catalog extract test' },
      { type: 'regression', filter: 'Mwg', label: 'Regression: MWG catalog and drift tests' },
      { type: 'regression', filter: 'Principles', label: 'Regression: Principles sync tests' },
      { type: 'regression', filter: 'Guidance', label: 'Regression: Guidance usage tests' },
      { type: 'regression', filter: 'Baseline', label: 'Regression: Baseline oracle tests' },
    ],
  },
  {
    id: 'schema',
    description: 'Report schema validation and atomic coverage',
    match: (f) => f.startsWith('schema/') || (f.startsWith('examples/') && f.endsWith('.json')),
    targets: [
      { type: 'node', path: 'tests/cdp-copy-sync.mjs', label: 'CDP copy sync byte check' },
      { type: 'regression', filter: 'SchemaValidation', label: 'Regression: Schema validation tests' },
      { type: 'regression', filter: 'AtomicCoverageValidator', label: 'Regression: Atomic coverage validator' },
    ],
  },
  {
    id: 'aggregate',
    description: 'Report comparison, aggregation, and scorecard rendering',
    match: (f) => f.startsWith('aggregate/'),
    targets: [
      { type: 'node', path: 'tests/cdp-copy-sync.mjs', label: 'CDP copy sync byte check' },
      { type: 'regression', filter: 'Scorecard', label: 'Regression: Scorecard tests' },
      { type: 'regression', filter: 'Compare', label: 'Regression: Compare tests' },
    ],
  },
  {
    id: 'fixer',
    description: 'Model-driven fix loop and report updates',
    match: (f) => f.startsWith('fixer/'),
    targets: [
      { type: 'regression', filter: 'Fix', label: 'Regression: Fix mode tests' },
    ],
  },
  {
    id: 'mcp',
    description: 'Model Context Protocol skills server',
    match: (f) => f.startsWith('mcp/'),
    targets: [
      { type: 'regression', filter: 'Mcp', label: 'Regression: MCP skills server tests' },
    ],
  },
  {
    id: 'runner',
    description: 'Batch runner, agent dispatch, and execution history',
    match: (f) =>
      (f.startsWith('runner/') && !/^runner\/flow(-record)?\.mjs$/.test(f)) ||
      f === 'tests/batch-resume-isolation.mjs',
    targets: [
      { type: 'node', path: 'tests/cdp-copy-sync.mjs', label: 'CDP copy sync byte check' },
      { type: 'node', path: 'tests/batch-resume-isolation.mjs', label: 'Batch resume isolation tests' },
      { type: 'node', path: 'tests/skill-write-contract.mjs', label: 'Skill write contract tests' },
      { type: 'regression', filter: 'Batch', label: 'Regression: Batch isolation and scope tests' },
      { type: 'regression', filter: 'Agent', label: 'Regression: Agent environment allowlist tests' },
    ],
  },
  {
    id: 'skills',
    description: 'Agent skill definitions and headless bash rules',
    match: (f) =>
      f.includes('skills/') ||
      f.startsWith('.claude/') ||
      f.startsWith('.pi/') ||
      f.startsWith('.codex/') ||
      f.startsWith('.opencode/') ||
      f === 'tests/skill-write-contract.mjs',
    targets: [
      { type: 'node', path: 'tests/cdp-copy-sync.mjs', label: 'CDP copy sync byte check' },
      { type: 'node', path: 'tests/skill-write-contract.mjs', label: 'Skill write contract tests' },
      { type: 'regression', filter: 'HeadlessAllowlist', label: 'Regression: Headless allowlist and skill contract' },
    ],
  },
  {
    id: 'evidence',
    description: 'Evidence collection CLI, CDP transport, and observation primitives',
    match: (f) => f.startsWith('evidence/') || f === 'tests/launch-loop.mjs' || f === 'tests/no-orphan-browser.mjs',
    targets: [
      { type: 'node', path: 'tests/cdp-copy-sync.mjs', label: 'CDP copy sync byte check' },
      { type: 'node', path: 'tests/safe-fetch.mjs', label: 'Safe-fetch DNS rebinding and decoding' },
      { type: 'node', path: 'tests/source-tree-symlink.mjs', label: 'Source-tree symlink escape tests' },
      { type: 'regression', filter: 'Evidence', label: 'Regression: Evidence primitives' },
      { type: 'regression', filter: 'Chrome', label: 'Regression: Chrome candidate and sandbox policy' },
      { type: 'regression', filter: 'Har', label: 'Regression: HAR redaction and redirects' },
      { type: 'regression', filter: 'Axe', label: 'Regression: Axe primitive tests' },
      { type: 'regression', filter: 'Secrets', label: 'Regression: Secrets scan tests' },
      { type: 'regression', filter: 'Console', label: 'Regression: Console evidence tests' },
      { type: 'regression', filter: 'CdpDeadline', label: 'Regression: CDP deadline test' },
      { type: 'regression', filter: 'AwaitCensus', label: 'Regression: Await census' },
    ],
  },
  {
    id: 'fast-gate-self',
    description: 'Fast test gate script, test helpers, and self-verification test suite',
    match: (f) =>
      f === 'scripts/test-fast.mjs' ||
      f === 'tests/test-fast.mjs' ||
      f === 'tests/test-helpers.mjs' ||
      f === 'tests/regression.mjs',
    targets: [
      { type: 'node', path: 'tests/test-fast.mjs', label: 'Fast gate unit and integration tests' },
      { type: 'regression', filter: 'testSyntaxChecks', label: 'Regression: Syntax checks' },
    ],
  },
];

/**
 * Baseline test targets run when no changes or documentation-only changes are detected.
 */
export const BASELINE_TARGETS = [
  { type: 'node', path: 'tests/cdp-copy-sync.mjs', label: 'CDP copy sync byte check' },
  { type: 'node', path: 'tests/changelog-version-check.mjs', label: 'Changelog and version agreement' },
  { type: 'regression', filter: 'testSyntaxChecks', label: 'Regression: Syntax checks' },
  { type: 'regression', filter: 'testPackageRootImportIsSideEffectFree', label: 'Regression: Package root import' },
];

/**
 * Resolve git ref to diff against.
 */
export function resolveDiffRef(repo = repoRoot, preferred = 'origin/master') {
  const candidates = preferred ? [preferred, 'origin/main', 'master', 'main', 'HEAD~1', 'HEAD'] : ['origin/master', 'origin/main', 'master', 'main', 'HEAD~1', 'HEAD'];
  for (const ref of candidates) {
    const res = spawnSync('git', ['rev-parse', '--verify', ref], { cwd: repo, encoding: 'utf8' });
    if (res.status === 0) return ref;
  }
  return null;
}

/**
 * Get changed files using git diff and untracked status.
 */
export function getChangedFiles(repo = repoRoot, diffRef = 'origin/master') {
  const resolvedRef = resolveDiffRef(repo, diffRef);
  const files = new Set();

  if (resolvedRef) {
    const diff = spawnSync('git', ['diff', '--name-only', resolvedRef], { cwd: repo, encoding: 'utf8' });
    if (diff.status === 0 && diff.stdout) {
      for (const line of diff.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) files.add(trimmed);
      }
    }
  }

  // Untracked new files
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8' });
  if (untracked.status === 0 && untracked.stdout) {
    for (const line of untracked.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  }

  return { files: Array.from(files), resolvedRef };
}

/**
 * Inspect git diff on tests/regression.mjs to discover changed test function names.
 */
export function getChangedRegressionTests(repo = repoRoot, diffRef = 'origin/master') {
  const resolvedRef = resolveDiffRef(repo, diffRef);
  if (!resolvedRef) return [];
  const diff = spawnSync('git', ['diff', '-U1', resolvedRef, '--', 'tests/regression.mjs'], { cwd: repo, encoding: 'utf8' });
  if (diff.status !== 0 || !diff.stdout) return [];

  const testNames = new Set();
  // Match added/modified function lines: +function testFoo or +async function testBar
  const addedMatches = diff.stdout.matchAll(/^\+[ \t]*(?:async[ \t]+)?function[ \t]+(test[A-Za-z0-9_]+)/gm);
  for (const m of addedMatches) {
    if (m[1]) testNames.add(m[1]);
  }

  // Match function names in hunk headers (covers edits to existing test function bodies)
  const hunkMatches = diff.stdout.matchAll(/^@@[ \t\S]+@@[ \t]*(?:async[ \t]+)?function[ \t]+(test[A-Za-z0-9_]+)/gm);
  for (const m of hunkMatches) {
    if (m[1]) testNames.add(m[1]);
  }

  return Array.from(testNames);
}

/**
 * Target deduplication key.
 */
function targetKey(target) {
  return `${target.type}:${target.path || ''}:${target.filter || ''}:${(target.args || []).join(' ')}`;
}

/**
 * Map list of changed file paths to affected test targets.
 */
export function mapFilesToTests(filePaths, options = {}) {
  const matchedSubsystems = new Set();
  const targetsByKey = new Map();
  const unmappedFiles = [];

  for (const rawPath of filePaths) {
    const normalized = rawPath.startsWith('/') ? relative(repoRoot, rawPath) : rawPath;

    let matched = false;

    // Check if path is a direct runnable standalone test (must be in KNOWN_STANDALONE_TESTS or outside fixtures)
    if (isDirectRunnableTest(normalized)) {
      const absPath = rawPath.startsWith('/') ? rawPath : join(repoRoot, normalized);
      if (existsSync(absPath)) {
        const timeoutMs = normalized.endsWith('.test.mjs') ? 240000 : 120000;
        const target = { type: 'node', path: rawPath, label: `Direct test: ${normalized}`, timeoutMs };
        targetsByKey.set(targetKey(target), target);
        matched = true;
      }
    }

    // Check tests/regression.mjs itself
    if (normalized === 'tests/regression.mjs') {
      const changedTests = getChangedRegressionTests(repoRoot, options.diffRef);
      if (changedTests.length > 0) {
        for (const testName of changedTests) {
          const target = { type: 'regression', filter: testName, label: `Regression: ${testName}` };
          targetsByKey.set(targetKey(target), target);
        }
      } else {
        const target = { type: 'regression', filter: 'testSyntaxChecks', label: 'Regression: Syntax checks' };
        targetsByKey.set(targetKey(target), target);
      }
      matched = true;
    }

    // Match against known subsystems
    for (const sub of SUBSYSTEMS) {
      if (sub.match(normalized)) {
        matchedSubsystems.add(sub.id);
        matched = true;
        for (const t of sub.targets) {
          targetsByKey.set(targetKey(t), t);
        }
      }
    }

    if (!matched) {
      unmappedFiles.push(normalized);
    }
  }

  // If no files or only unmapped files, include baseline targets
  const isBaseline = targetsByKey.size === 0;
  if (isBaseline) {
    for (const t of BASELINE_TARGETS) {
      targetsByKey.set(targetKey(t), t);
    }
  }

  return {
    matchedSubsystems: Array.from(matchedSubsystems),
    targets: Array.from(targetsByKey.values()),
    unmappedFiles,
    isBaseline,
  };
}

/**
 * Execute a single test target.
 */
export function runTarget(target, repo = repoRoot) {
  let cmd;
  let args;

  if (target.type === 'node') {
    const testPath = target.path.startsWith('/') ? target.path : join(repo, target.path);
    if (!existsSync(testPath)) {
      console.log(`\n⤼ [test:fast] SKIPPED: ${target.label} (${target.path} does not exist)`);
      return { ok: true, duration: '0.00', skipped: true };
    }
    cmd = process.execPath;
    args = [testPath, ...(target.args || [])];
  } else if (target.type === 'regression') {
    cmd = process.execPath;
    args = [join(repo, 'tests', 'regression.mjs'), '--only', target.filter];
  } else {
    throw new Error(`Unknown target type: ${target.type}`);
  }

  console.log(`\n▶ [test:fast] RUNNING: ${target.label}`);
  console.log(`  $ ${cmd} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);

  const envTimeout = process.env.TEST_FAST_TARGET_TIMEOUT_MS ? Number(process.env.TEST_FAST_TARGET_TIMEOUT_MS) : null;
  const targetTimeoutMs = envTimeout || target.timeoutMs || 120000;
  const startTime = Date.now();
  const res = spawnSync(cmd, args, { cwd: repo, stdio: 'inherit', timeout: targetTimeoutMs });
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  if (res.error?.code === 'ETIMEDOUT') {
    console.error(`✖ [test:fast] TIMED OUT (exceeded ${targetTimeoutMs}ms): ${target.label} (${duration}s)`);
    return { ok: false, status: 124, duration };
  }

  if (res.status === 0) {
    console.log(`✔ [test:fast] PASSED: ${target.label} (${duration}s)`);
    return { ok: true, duration };
  } else {
    console.error(`✖ [test:fast] FAILED (exit ${res.status}): ${target.label} (${duration}s)`);
    return { ok: false, status: res.status ?? 1, duration };
  }
}

/**
 * CLI Entry point
 */
export function main(argv = process.argv.slice(2)) {
  const explicitFiles = [];
  let diffRef = 'origin/master';
  let dryRun = false;
  let runAll = false;
  let listSubsystems = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
scripts/test-fast.mjs - Targeted fast test gate for web-uplift

Usage:
  node scripts/test-fast.mjs                     # diff against origin/master
  node scripts/test-fast.mjs --diff <ref>        # diff against specific ref
  node scripts/test-fast.mjs <file...>           # test affected by explicit files
  node scripts/test-fast.mjs --all               # run all fast test targets
  node scripts/test-fast.mjs --dry-run           # print planned test targets without running
  node scripts/test-fast.mjs --list              # list known subsystems
`);
      process.exit(0);
    } else if (arg === '--list') {
      listSubsystems = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--all') {
      runAll = true;
    } else if (arg === '--diff') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        diffRef = argv[++i];
      } else {
        console.error('error: missing argument for --diff');
        process.exit(1);
      }
    } else if (arg.startsWith('--diff=')) {
      diffRef = arg.slice('--diff='.length);
      if (!diffRef) {
        console.error('error: missing value for --diff=');
        process.exit(1);
      }
    } else if (!arg.startsWith('-')) {
      explicitFiles.push(arg);
    }
  }

  if (listSubsystems) {
    console.log('Known subsystems and fast targets:');
    for (const sub of SUBSYSTEMS) {
      console.log(`\n• ${sub.id}: ${sub.description}`);
      for (const t of sub.targets) {
        console.log(`  - ${t.label} (${t.type}: ${t.path || t.filter})`);
      }
    }
    process.exit(0);
  }

  let filesToTest = explicitFiles;
  let resolvedRefLabel = '';

  if (runAll) {
    const allTargetsByKey = new Map();
    // Include baseline targets
    for (const t of BASELINE_TARGETS) {
      allTargetsByKey.set(targetKey(t), t);
    }
    // Include all subsystem targets
    for (const sub of SUBSYSTEMS) {
      for (const t of sub.targets) {
        allTargetsByKey.set(targetKey(t), t);
      }
    }
    const targets = Array.from(allTargetsByKey.values());
    console.log(`[test:fast] Running all ${targets.length} fast test targets`);
    if (dryRun) {
      targets.forEach((t) => console.log(`  - ${t.label}`));
      process.exit(0);
    }
    for (const target of targets) {
      const res = runTarget(target);
      if (!res.ok) process.exit(res.status || 1);
    }
    console.log(`\n✔ [test:fast] ALL ${targets.length} test targets PASSED.`);
    process.exit(0);
  }

  if (filesToTest.length === 0) {
    const changed = getChangedFiles(repoRoot, diffRef);
    filesToTest = changed.files;
    resolvedRefLabel = changed.resolvedRef || diffRef;
    console.log(`[test:fast] Detected ${filesToTest.length} changed file(s) vs ${resolvedRefLabel}`);
    if (filesToTest.length > 0) {
      for (const f of filesToTest.slice(0, 10)) console.log(`  • ${f}`);
      if (filesToTest.length > 10) console.log(`  ... and ${filesToTest.length - 10} more`);
    }
  } else {
    console.log(`[test:fast] Testing affected targets for ${filesToTest.length} explicit file(s):`);
    for (const f of filesToTest) console.log(`  • ${f}`);
  }

  const plan = mapFilesToTests(filesToTest, { diffRef });

  if (plan.matchedSubsystems.length > 0) {
    console.log(`[test:fast] Matched subsystem(s): ${plan.matchedSubsystems.join(', ')}`);
  }
  if (plan.unmappedFiles.length > 0) {
    console.log(`[test:fast] Unmapped / broad file(s): ${plan.unmappedFiles.join(', ')}`);
  }
  if (plan.isBaseline) {
    console.log('[test:fast] No subsystem-specific changes; running fast baseline tests.');
  }

  console.log(`[test:fast] Selected ${plan.targets.length} test target(s):`);
  for (const t of plan.targets) {
    console.log(`  → ${t.label}`);
  }

  if (dryRun) {
    console.log('\n[test:fast] Dry-run complete. Exiting without execution.');
    process.exit(0);
  }

  const startTime = Date.now();
  for (const target of plan.targets) {
    const res = runTarget(target);
    if (!res.ok) {
      console.error(`\n✖ [test:fast] STOPPED: ${target.label} failed.`);
      process.exit(res.status || 1);
    }
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n✔ [test:fast] ALL ${plan.targets.length} test target(s) PASSED in ${totalDuration}s.`);
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
