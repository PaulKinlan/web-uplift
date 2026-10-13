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

import { existsSync, lstatSync } from 'node:fs';
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
 * Extensions that make a changed path EXECUTABLE. This set is IDENTICAL to the fleet's coverage checker
 * (fleet remote/check-coverage.py, `code_exts`), so the project gate and the hub's published coverage
 * block agree about which changed files must be covered by a suite. A changed path with one of these
 * extensions that no subsystem maps is a FAILURE, never a baseline-only pass.
 *
 * Do not add an extension here to make something fail: an unmatched path already fails BY DEFAULT, and
 * this set only decides which paths are too executable to be omitted by a tree, doc or data rule. The
 * first version of this change carried .mts, .cts and .bash and claimed to mirror the fleet while it did
 * not (review finding P2, web-uplift-5i9a); an extra entry changed no outcome, which is exactly why the
 * claim had to be true rather than convenient.
 */
export const CODE_EXTENSIONS = new Set([
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.rs',
  '.go',
  '.c',
  '.cpp',
  '.sh',
]);

/** True when this path's extension makes it executable by CODE_EXTENSIONS. */
export function hasCodeExtension(relPath) {
  const dot = relPath.lastIndexOf('.');
  return dot > 0 && CODE_EXTENSIONS.has(relPath.slice(dot));
}

/**
 * True when the tree HAS an entry at this path. `lstatSync`, not `existsSync`: existsSync follows the link
 * and reports false for a dangling symlink, so a tracked path whose link broke would be read as DELETED and
 * quietly omitted by the deleted rule while the entry is still right there (review finding P2 on 1cf6e36).
 * A present-but-dangling entry is a change to an executable path, so it is refused like any other.
 */
export function pathEntryExists(relPath, repo = repoRoot) {
  try {
    lstatSync(join(repo, relPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Named omission rules (web-uplift-5i9a). A changed path that no subsystem maps may only be left out
 * of the plan when one of these rules names it, and the rule's reason is printed with the path. This
 * is the other half of "fail closed": the gate refuses to guess about an executable path, and it also
 * refuses to omit one silently. Ordered, first match wins.
 *
 * AN EXECUTABLE PATH IS NEVER OMITTED unless the rule says so in `mayOmitExecutable` (exactly two do:
 * `deleted`, where there is no file left to run, and `recorded-artefacts`, which are outputs of a run
 * that no suite imports). Without that flag a rule only sees non-executable paths, so a tree rule can
 * never be the reason a changed module went untested - that was the contradiction a reviewer found in
 * the first version of this change: `playground/app.js` was reported as deliberately omitted while the
 * same docs promised that an unmapped executable path fails. Executable files in those trees now fail
 * with their paths named, and mapping them is filed as web-uplift-5r7z.
 *
 * The rest of the rule set mirrors the exemptions the fleet's own coverage checker already uses
 * (remote/check-coverage.py: `exempt_prefixes = docs/, .fleet/, .beads/, .github/, systemd/` and
 * `exempt_exts` for documentation, data and media), so `fast-gate: unmapped:` means the same thing in
 * this repo's log as it does in the hub's record.
 */
export const OMITTED_RULES = [
  {
    id: 'deleted',
    reason: 'deleted by this change: there is no file left in the tree to run',
    mayOmitExecutable: true,
    match: (f, ctx) => !ctx.exists(f),
  },
  {
    id: 'docs',
    reason: 'documentation or prose: no executable behaviour to test',
    match: (f) => /\.(md|txt)$/.test(f) || /^(LICENSE|NOTICE|AUTHORS)$/.test(f),
  },
  {
    id: 'media-and-markup',
    reason: 'media or markup asset, not a module',
    match: (f) => /\.(png|jpe?g|gif|svg|webp|mp4|webm|har|css|html|ico|woff2?)$/.test(f),
  },
  {
    id: 'data-and-config',
    reason: 'data or config file, not a module',
    match: (f) => /\.(json|jsonl|ya?ml|toml|conf|lock|keep|gitkeep|gitignore)$/.test(f),
  },
  {
    id: 'recorded-artefacts',
    reason: 'recorded run artefact: an audit or agent output that no suite imports, regenerated by the run that produced it',
    // The one declared exception to "executable paths are never omitted": these trees hold the .mjs
    // probe scripts a run left behind, so a change usually regenerates a record. Nothing imports them,
    // and refusing would leave the author with no suite to map to.
    mayOmitExecutable: true,
    match: (f) => f.startsWith('evidence-out/') || f.startsWith('.pi-subagents/'),
  },
  {
    id: 'agent-and-ci-config',
    reason: 'agent or CI tooling config: the workflow or agent that consumes it is the check',
    match: (f) =>
      f.startsWith('.beads/') ||
      f.startsWith('.github/') ||
      f.startsWith('.gemini/') ||
      f.startsWith('.claude-plugin/') ||
      f === '.mcp.json' ||
      f === 'opencode.json',
  },
  {
    id: 'fixture-and-demo-trees',
    reason: 'non-executable file in a fixture or demo tree: no fast-tier suite of its own (unmapped executable files here are refused, never omitted)',
    match: (f) =>
      f.startsWith('tests/fixtures/') ||
      f.startsWith('playground/') ||
      f.startsWith('eval/') ||
      f.startsWith('examples/'),
  },
];

/**
 * Classify a changed path that no subsystem mapped. Returns exactly one of:
 *   { omitted: { path, rule, reason } } - a named rule covers it, nothing runs for it, exit stays 0
 *   { unknown: path }                   - an executable path with no rule, which FAILS the gate
 */
export function classifyUnmappedPath(relPath, repo = repoRoot, exists = (p) => pathEntryExists(p, repo)) {
  const ctx = { exists };
  const executable = hasCodeExtension(relPath);
  for (const rule of OMITTED_RULES) {
    if (executable && !rule.mayOmitExecutable) continue;
    if (rule.match(relPath, ctx)) {
      return { omitted: { path: relPath, rule: rule.id, reason: rule.reason } };
    }
  }
  return { unknown: relPath };
}

/**
 * Test-support modules and the suite that IMPORTS each one. A module imported by a suite is covered by
 * that suite, so a change to it must run the consumer; before this table existed a change to one of
 * these selected no test target at all (it fell through to the baseline), which is the same silent
 * green the unmapped-path rule now refuses.
 */
const TEST_SUPPORT_MODULES = [
  { file: 'tests/cdp-endpoint-exposure.mjs', consumer: 'tests/chrome-cdp.test.mjs' },
  { file: 'tests/cdp-pipe-transport.mjs', consumer: 'tests/chrome-cdp.test.mjs' },
  { file: 'tests/console-evidence-redaction.mjs', consumer: 'tests/evidence.test.mjs' },
  { file: 'tests/evidence-cli-source-containment.mjs', consumer: 'tests/evidence-content.test.mjs' },
];

/**
 * Known subsystems and their mapped test targets.
 */
export const SUBSYSTEMS = [
  {
    id: 'fixture-sites',
    description: 'Browser demo and seeded-issue fixture JavaScript syntax, import graph, and scenario metadata',
    match: (f) => /^playground\/.*\.js$/.test(f) || /^eval\/fixtures\/seeded-issues\/site\/.*\.js$/.test(f),
    targets: [{ type: 'node', path: 'tests/fixture-sites.test.mjs', label: 'Fixture and demo site module checks' }],
  },
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
    id: 'agent-dispatch',
    description: 'Agent invocation, environment allowlist, and proxy credential sanitisation',
    // Name the FILE rather than leaning on the runner/ prefix. This is the one target that runs the
    // agent-environment suite DIRECTLY, and the defect (web-uplift-b2q5) was that a change to
    // runner/agents.mjs selected no direct target at all: its tests ran only because the runner
    // subsystem's 'Agent' name filter happened to match testAgentChildEnvProxyCredentials and
    // testAgentChildEnvAllowlist. That is coverage by accident of naming, and a rename dropping
    // 'Agent' would have dropped the whole suite from the gate with no other signal.
    match: (f) => f === 'runner/agents.mjs',
    targets: [
      { type: 'node', path: 'tests/runner-agents.test.mjs', label: 'Agent env, proxy and write-scope tests' },
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
    id: 'census-targets',
    description: 'The baseline census module and the guard that keeps its targets tracked',
    // Name the FILE, not a directory: a prefix match would pull the census guard into unrelated changes
    // under tests/, and tests/test-fast.mjs pins that with a negative control. Before this entry existed,
    // changing this file selected only the BASELINE targets and never the guard that reads it, so a green
    // fast gate could report success without ever running the check the file exists to feed.
    match: (f) => f === 'tests/census-targets.mjs',
    targets: [
      { type: 'regression', filter: 'CensusTargetsAreTracked', label: 'Regression: Baseline census targets are tracked' },
    ],
  },
  {
    id: 'beads-export',
    description: 'Tracked passive beads export, its generator, and the guard that keeps provider tokens out of it',
    // Name the FILES, not the .beads/ directory: a prefix match here would put the export guard into every
    // beads change, and tests/test-fast.mjs pins that with a negative control on .beads/config.yaml.
    match: (f) =>
      f === '.beads/issues.jsonl' ||
      f === 'scripts/beads-export.mjs' ||
      f === 'tests/beads-export-redaction.mjs',
    targets: [
      { type: 'regression', filter: 'TrackedBeadsExportHasNoSecretShapes', label: 'Regression: Tracked beads export has no secret shapes' },
      { type: 'regression', filter: 'BeadsExportRedactionRuleCanFire', label: 'Regression: Beads export redaction rule can fire' },
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
  {
    id: 'package-root',
    description: 'The package root barrel (index.mjs), covered by the side-effect-free import guard',
    // Name the FILE: index.mjs is in package.json `files` and `exports['.']`, and its only guard is the
    // root-import regression test. Before this entry a change to it selected the baseline four instead of
    // that guard, so a green fast gate never ran the one test that reads it.
    match: (f) => f === 'index.mjs',
    targets: [
      { type: 'regression', filter: 'testPackageRootImportIsSideEffectFree', label: 'Regression: Package root import' },
    ],
  },
  // One entry per test-support module, generated from the table above: a change to the module selects the
  // consumer suite, and nothing else. A directory- or prefix-wide match here would pull a browser suite
  // into every tests/ change.
  ...TEST_SUPPORT_MODULES.map(({ file, consumer }) => ({
    id: `test-support-${file.replace(/^tests\//, '').replace(/\.mjs$/, '')}`,
    description: `Test-support module ${file} (imported by ${consumer})`,
    match: (f) => f === file,
    targets: [
      { type: 'node', path: consumer, timeoutMs: 240000, label: `Consumer of ${file}: ${consumer}` },
    ],
  })),
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
  const omittedFiles = [];
  const exists = options.exists || ((p) => pathEntryExists(p, repoRoot));

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
      // Fail closed (web-uplift-5i9a): an unmapped path is either named by an omission rule (nothing
      // runs, and the log says so) or it is UNKNOWN, which the CLI refuses to run to a green verdict.
      const decision = classifyUnmappedPath(normalized, repoRoot, exists);
      if (decision.omitted) {
        omittedFiles.push(decision.omitted);
      } else {
        unmappedFiles.push(normalized);
      }
    }
  }

  // Only a diff with nothing to map at all falls back to the baseline suite. A diff that contains an
  // UNKNOWN path must not look like a baseline run: that was the false green this gate now refuses.
  const isBaseline = targetsByKey.size === 0 && unmappedFiles.length === 0;
  if (isBaseline) {
    for (const t of BASELINE_TARGETS) {
      targetsByKey.set(targetKey(t), t);
    }
  }

  return {
    matchedSubsystems: Array.from(matchedSubsystems),
    targets: Array.from(targetsByKey.values()),
    unmappedFiles,
    omittedFiles,
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

  // The suite is named with the fleet's anchored marker vocabulary (fleet remote/check-coverage.py
  // accepts ^fast-gate:\s*(?:running|ran|passed|completed|failed):\s*(.*)$), which is what lets the
  // cached fast record carry a coverage block instead of UNKNOWN. The value is the suite FILE, because
  // that is the unit the hub matches against the diff; for a regression target the named filter is in the
  // human lines around this one.
  const suiteName = target.type === 'node' ? target.path : 'tests/regression.mjs';
  console.log(`fast-gate: running: ${suiteName}`);

  const envTimeout = process.env.TEST_FAST_TARGET_TIMEOUT_MS ? Number(process.env.TEST_FAST_TARGET_TIMEOUT_MS) : null;
  const targetTimeoutMs = envTimeout || target.timeoutMs || 120000;
  const startTime = Date.now();
  const res = spawnSync(cmd, args, { cwd: repo, stdio: 'inherit', timeout: targetTimeoutMs });
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  if (res.error?.code === 'ETIMEDOUT') {
    console.log(`fast-gate: failed: ${suiteName}`);
    console.error(`✖ [test:fast] TIMED OUT (exceeded ${targetTimeoutMs}ms): ${target.label} (${duration}s)`);
    return { ok: false, status: 124, duration };
  }

  if (res.status === 0) {
    console.log(`fast-gate: passed: ${suiteName}`);
    console.log(`✔ [test:fast] PASSED: ${target.label} (${duration}s)`);
    return { ok: true, duration };
  } else {
    console.log(`fast-gate: failed: ${suiteName}`);
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
    console.log('\nChanged paths omitted by a named rule (no suite runs for these):');
    for (const rule of OMITTED_RULES) {
      console.log(`  • ${rule.id}: ${rule.reason}`);
    }
    console.log('\nAny other changed path with an executable extension that no subsystem maps FAILS the gate.');
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
  if (plan.omittedFiles.length > 0) {
    console.log(`[test:fast] Omitted ${plan.omittedFiles.length} changed file(s) by named rule (no suite runs for them):`);
    for (const o of plan.omittedFiles) {
      console.log(`  - ${o.path} [${o.rule}] ${o.reason}`);
    }
  }
  if (plan.isBaseline) {
    console.log('[test:fast] No subsystem-specific changes; running fast baseline tests.');
  }

  // FAIL CLOSED (web-uplift-5i9a). An executable changed path that no rule names means the plan cannot
  // cover the diff, so NOTHING is run and the run is a FAILURE: a green verdict here would be a record
  // that a change was tested when no suite for it ran (fleet docs/speed.md R5 and R14). This is checked
  // before any target starts, including in --dry-run, so a preview cannot look greener than the run.
  //
  // The output names the ONE next action rather than only the problem: a lane under time pressure that
  // gets an unexplained red either reaches for the baseline or skips the gate (web-uplift-coord, on the
  // condition for this bead), and both of those are a false green. The same instruction is in
  // docs/speed.md under "When the fast gate refuses", which is where a lane looks without reading an
  // error, and per-path skeletons are printed here because the map entry is the fix.
  if (plan.unmappedFiles.length > 0) {
    for (const f of plan.unmappedFiles) {
      console.log(`fast-gate: unmapped: ${f}`);
    }
    console.error(`fast-gate: FAIL - ${plan.unmappedFiles.length} changed file(s) map to no suite:`);
    for (const f of plan.unmappedFiles) {
      console.error(`  ${f}`);
    }
    console.error('[test:fast] NEXT ACTION: extend the map in scripts/test-fast.mjs, then re-run npm run test:fast:');
    for (const f of plan.unmappedFiles) {
      if (f.startsWith('tests/') && f.endsWith('.mjs')) {
        console.error(`  * ${f}: add it to KNOWN_STANDALONE_TESTS if it is a suite that runs with no arguments,`);
        console.error('    or to the SUBSYSTEMS entry of the suite that imports it.');
      } else {
        console.error(`  * ${f}: add it to the SUBSYSTEMS entry of the suite that covers it, e.g.`);
        console.error(`      { id: '<id>', match: (candidate) => candidate === '${f}', targets: [{ type: 'node', path: 'tests/<suite>.test.mjs' }] },`);
        console.error('    or add it to KNOWN_STANDALONE_TESTS if it is a suite that runs with no arguments.');
      }
    }
    console.error('  * documentation/data/fixture with genuinely no suite: add an OMITTED_RULES entry carrying the reason it is skipped.');
    console.error('  * cannot extend the map right now? The full gate is NOT evidence on its own for an unimported refused path:');
    console.error('    npm test runs tests/*.test.mjs and suites they import (directly or transitively); an imported suite IS covered, but an unimported suite is not.');
    console.error('    Run the suite that covers an unimported path explicitly, then run the full gate:');
    for (const f of plan.unmappedFiles) {
      if (f.startsWith('tests/') && f.endsWith('.mjs')) {
        console.error(`      node ${f}   # the refused path is itself a runnable suite`);
      }
    }
    console.error('      FLEET_CHECK_CONF=/home/exedev/.fleet/conf.d/web-uplift.conf fleet-check');
    console.error('    and name the command that produced the evidence in your hand-off.');
    console.error('[test:fast] No test target was executed. A baseline run is not evidence that the changed file was tested.');
    process.exit(1);
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
