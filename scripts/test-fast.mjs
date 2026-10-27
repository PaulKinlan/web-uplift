#!/usr/bin/env node
/**
 * scripts/test-fast.mjs - Targeted fast test gate for web-uplift.
 *
 * Runs only the tests affected by changed files (via the merge-base of HEAD and origin/master
 * or passed file paths), drastically reducing the test run time from 4-18 minutes
 * to a few seconds for focused changes.
 *
 * Usage:
 *   node scripts/test-fast.mjs                     # diff from the merge-base with origin/master
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

import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

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
 * Test-support modules and the suite that IMPORTS AND USES each one. The consumer must actually
 * exercise the imported code for coverage; before this table existed a change to one of
 * these selected no test target at all (it fell through to the baseline), which is the same silent
 * green the unmapped-path rule now refuses.
 */
const TEST_SUPPORT_MODULES = [
  { file: 'tests/cdp-endpoint-exposure.mjs', consumer: 'tests/chrome-cdp.test.mjs' },
  { file: 'tests/cdp-pipe-transport.mjs', consumer: 'tests/chrome-cdp.test.mjs' },
  { file: 'tests/console-evidence-redaction.mjs', consumer: 'tests/evidence-console.test.mjs' },
  { file: 'tests/evidence-cli-source-containment.mjs', consumer: 'tests/evidence-content.test.mjs' },
  // Both of these are imported only by the redaction suite, so the fast tier can cover them exactly
  // (web-uplift-5y2w; each previously selected only the gate's own self-tests).
  { file: 'tests/log-redaction.mjs', consumer: 'tests/redaction.test.mjs' },
  { file: 'tests/credential-redaction.mjs', consumer: 'tests/redaction.test.mjs' },
  // These two selected NOTHING at all before 5y2w's control found them: no target, no subsystem and no
  // refusal, so a change fell to the baseline suite while the suite that imports them never ran.
  { file: 'tests/beads-export-redaction.mjs', consumer: 'tests/redaction.test.mjs' },
  { file: 'tests/census-targets.mjs', consumer: 'tests/syntax-core.test.mjs' },
  // web-uplift-yvc4: an authored tracked executable the map covered with NOTHING, so the gate's own control
  // (tests/test-fast.mjs:1061, 'every authored tracked executable must be mapped or covered by a named rule')
  // was failing on main. It landed green inside web-uplift-ebvj only because tp77's auto-map covers a changed
  // executable named by a CHANGED suite - true in that branch, false on main when the suite is not what you
  // are changing - and that control only runs when tests/test-fast.mjs itself changes. Folded here rather than
  // in its own branch because this branch already edits this map for tests/filter-args.mjs.
  { file: 'scripts/check-verdict.mjs', consumer: 'tests/verdict-provenance.test.mjs' },
  // web-uplift-h68z: the shared credential vocabulary the redaction suite exercises directly. web-uplift-yb2a's
  // own gate printed 'COVERAGE WARNING: 1 unmapped changed file(s): evidence/credential-terms.mjs' while
  // claiming a pass, because absence of a rule and absence of coverage read the same in a log line.
  { file: 'evidence/credential-terms.mjs', consumer: 'tests/redaction.test.mjs' },
  // web-uplift-dipf: the parser's own module, covered by the suite that now tests it directly, so a
  // flag change selects that suite rather than refusing on tests/test-helpers.mjs (FULL-GATE-ONLY).
  { file: 'tests/filter-args.mjs', consumer: 'tests/filter-args.test.mjs' },
];

/**
 * Shared modules whose consumers are MOST of the fast tier. There is no honest subset for these: running
 * everything that imports one of them is the full gate wearing the fast gate's name, and picking a
 * representative fraction is a false green with extra steps. So the gate REFUSES, names the importing
 * suites it can see in the tree, and gives one next action instead of choosing for the author.
 *
 * This exists because tests/test-helpers.mjs was mapped to `fast-gate-self`: a change to a helper that ~15
 * files and 8 suites import ran the gate's own two self-tests, and the verdict was PASS (web-uplift-5y2w).
 * The list is deliberately short - a refusal is a tax on every lane that touches the path.
 */
export const FULL_GATE_ONLY_MODULES = ['tests/test-helpers.mjs'];

/**
 * The suites under tests/ that name a module, computed from the tree rather than declared, so a refusal
 * cannot go stale as suites are added or renamed. Only direct-runnable suites count: a shared module is
 * not its own consumer.
 */
export function importingSuitesOf(modulePath, repo = repoRoot) {
  const dir = join(repo, 'tests');
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const base = posix.basename(modulePath);
  const needle = new RegExp(`['"\`][^'"\`]*${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
  // A text REFERENCE to the module path, not a parsed import: it over-approximates on purpose, because
  // naming one consumer too many is safer for a refusal than omitting a suite that exercises the change.
  // Every message below therefore says "named by", which the scan can support.
  const suites = [];
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith('.mjs')) continue;
    const rel = `tests/${entry}`;
    if (rel === modulePath || !isDirectRunnableTest(rel)) continue;
    let source;
    try {
      source = readFileSync(join(dir, entry), 'utf8');
    } catch {
      continue;
    }
    if (needle.test(source)) suites.push(rel);
  }
  return suites;
}

/**
 * Shared modules the control CAN see are not honestly covered, declared with the reason and the tracking
 * bead so the gap is visible rather than skipped (web-uplift-ev2u). The control asserts each entry is
 * STILL unwired, so wiring one without removing the exemption fails the gate instead of silently passing.
 */
export const UNWIRED_SHARED_MODULES = [
  // Emptied by web-uplift-ev2u: the four tests/mwg-drift-*.mjs helpers used to sit here because the
  // mwg subsystem selected three checks that do not import them. The subsystem now also names their
  // only importer (tests/mwg-principles.test.mjs), so they are honestly wired and the declarations
  // were removed rather than left stale - which is exactly what the control below enforces.
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
      // The drift workflow is READ by tests/mwg-principles.test.mjs (case 1f drives its classifier
      // block), so a change to it must select these tests: an unread workflow could otherwise drift
      // away from the conditions it is supposed to file (web-uplift-6f8x).
      f === '.github/workflows/mwg-drift.yml' ||
      /^tests\/mwg-.*\.mjs$/.test(f),
    targets: [
      { type: 'node', path: 'tests/cdp-copy-sync.mjs', label: 'CDP copy sync byte check' },
      { type: 'node', path: 'tests/mwg-artefact.mjs', args: ['verify'], label: 'MWG artifact verification' },
      { type: 'node', path: 'tests/mwg-catalog-extract.mjs', label: 'MWG catalog extract test' },
      // The drift helpers under tests/mwg-drift-*.mjs are imported ONLY by this suite. Without it the
      // plan selected three mwg checks that cannot fail for a change to them, which is why the four
      // were declared unwired (web-uplift-ev2u). Naming the importer makes the coverage honest.
      { type: 'node', path: 'tests/mwg-principles.test.mjs', label: 'MWG principles and drift unit tests' },
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
      // MEASURED BUDGET, not a raised ceiling on a hunch (web-uplift-rsbb). This target took 148.3s idle on
      // 2026-10-27 (testBatchWriteScope alone 76.9s: 52% of it; resume isolation 7.3s; the rest 3.6-4.6s each)
      // and was being killed at the default 120s, so every runner change failed the fast gate on a target that
      // was already over budget before it ran anything new. The bound now matches the measurement with room for
      // a busy VM. The slow path is still the design defect and the real fix is to split testBatchWriteScope
      // (web-uplift-...) - raising this again without splitting it is not free.
      { type: 'regression', filter: 'Batch', label: 'Regression: Batch isolation and scope tests', timeoutMs: 240000 },
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
      // MEASURED BUDGET (web-uplift-91lr), same shape as the Batch bound above: this target took 185.4s on an
      // otherwise idle VM on 2026-10-27 - testInstalledEvidenceCli 74.3s, testEvidenceTruncationReporting 54.0s,
      // testConsoleEvidence 50.1s, the other four 1.2-1.3s each - and was killed at the default 120s, so an
      // evidence/ change could not get a verdict at all. All three slow cases are browser-bound: they pay a
      // Chrome launch per gather() call (measured launch 3.3-4.7s + first session 5.0s). The real fix is to stop
      // paying that per call (web-uplift-91lr), not to keep raising this; once those cases run in ~2.5s instead
      // of ~10s, this bound comes back down with a new measurement.
      { type: 'regression', filter: 'Evidence', label: 'Regression: Evidence primitives', timeoutMs: 240000 },
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
      f === 'tests/regression.mjs',
    targets: [
      // MEASURED BUDGET (web-uplift-rsbb): 130.4s idle on 2026-10-27, against the 120s default, so a change to the
      // gate script itself could not pass the gate - the one target that guards the machinery was itself being
      // killed. The bound matches the measurement with room for a busy VM; the self-test is the slow path to fix
      // (it runs the selection machinery end to end several times over) and this number should come down with it.
      { type: 'node', path: 'tests/test-fast.mjs', label: 'Fast gate unit and integration tests', timeoutMs: 300000 },
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
 * Compare the branch to the common ancestor of HEAD and the selected ref, rather than charging
 * a stale branch for commits that landed on master later. If history is shallow/unrelated, fall
 * back to the old ref-based diff (conservative over-selection, never silent under-selection).
 */
export function resolveDiffBase(repo = repoRoot, diffRef = 'origin/master') {
  const ref = resolveDiffRef(repo, diffRef);
  if (!ref) return { ref: null, base: null };
  const mergeBase = spawnSync('git', ['merge-base', ref, 'HEAD'], { cwd: repo, encoding: 'utf8' });
  return { ref, base: mergeBase.status === 0 && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : ref };
}

/**
 * Split NUL-delimited `git -z` output into raw paths. `-z` is used for every path listing because the
 * default C-quoting is not comparable across commands: with the default `core.quotePath`, `git status
 * --porcelain` returned `\303\251 space.txt` while `git diff --name-only` returned `"\303\251 space.txt"`,
 * so the two sources silently disagreed, the uncommitted set came out empty and the provenance warning
 * vanished for a selected path (web-uplift-4bqu). `-z` never quotes and never escapes, so the paths from
 * every source are byte-identical, including names containing spaces, quotes, control characters or
 * non-ASCII characters.
 */
function splitGitPaths(stdout) {
  if (!stdout) return [];
  return stdout.split('\0').filter((path) => path.length > 0);
}

/**
 * Working-tree changes that are NOT in HEAD, keyed by path: 'untracked' or 'modified'.
 *
 * The changed-file selection is a WORKING-TREE diff (base -> worktree) plus untracked files, while a
 * cached verdict from fleet-check is keyed to the COMMITTED tree it ran on. Those two sets can differ,
 * so the gate names the paths that are in one and not the other instead of letting a green be filed
 * under a sha whose tree does not contain them (web-uplift-5e9s (1)).
 */
export function getUncommittedChanges(repo = repoRoot) {
  const res = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
  const kinds = new Map();
  if (res.status !== 0 || !res.stdout) return kinds;
  const fields = splitGitPaths(res.stdout);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 3) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (!path) continue;
    kinds.set(path, code === '??' ? 'untracked' : 'modified');
    // In -z output a rename/copy entry is followed by its SOURCE path as a separate NUL field. The
    // destination is the changed path; the source is not part of this porcelain line.
    if (code.includes('R') || code.includes('C')) i += 1;
  }
  return kinds;
}

/**
 * How far HEAD and the comparison ref have diverged: `behind` counts commits the ref has that HEAD does
 * not, `ahead` counts commits HEAD has that the ref does not. Printed beside the base so the size of a
 * diff is attributable to the comparison point rather than to the branch (web-uplift-5e9s (2)).
 */
export function getDiffDistance(repo = repoRoot, ref) {
  if (!ref) return { ahead: null, behind: null };
  const res = spawnSync('git', ['rev-list', '--left-right', '--count', `${ref}...HEAD`], { cwd: repo, encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout.trim()) return { ahead: null, behind: null };
  const [behind, ahead] = res.stdout.trim().split(/\s+/);
  return { ahead: Number(ahead), behind: Number(behind) };
}

/**
 * Get changed files using git diff from the merge-base to the working tree, plus untracked status.
 */
export function getChangedFiles(repo = repoRoot, diffRef = 'origin/master') {
  const { ref: resolvedRef, base } = resolveDiffBase(repo, diffRef);
  const files = new Set();

  if (resolvedRef) {
    const diff = spawnSync('git', ['diff', '--name-only', '-z', base], { cwd: repo, encoding: 'utf8' });
    if (diff.status === 0 && diff.stdout) {
      for (const path of splitGitPaths(diff.stdout)) files.add(path);
    }
  }

  // Untracked new files
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8' });
  if (untracked.status === 0 && untracked.stdout) {
    for (const path of splitGitPaths(untracked.stdout)) files.add(path);
  }

  // EVERY path git status reports as dirty, taken straight from getUncommittedChanges and NOT intersected with
  // the changed-path selection above (web-uplift-tdg4). Those two sets are not the same question: 'files' is the
  // merge-base -> working-tree diff, while this is 'does the working tree differ from HEAD'. A path can be dirty
  // against HEAD and absent from the former by an ordinary action - commit a change on a branch, then restore
  // the working tree to the merge-base version, and git status reports it modified while that diff omits it.
  // Intersecting them made 'uncommitted' EMPTY on a demonstrably dirty tree, so certifiable came out true and
  // the run claimed to have observed the exact HEAD tree while the execution saw contents that are not in it.
  const uncommittedKinds = getUncommittedChanges(repo);
  const uncommitted = [...uncommittedKinds].map(([path, kind]) => ({ path, kind }));
  uncommitted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { files: Array.from(files), resolvedRef, base, uncommitted };
}

/**
 * Inspect git diff on tests/regression.mjs to discover changed test function names.
 */
export function getChangedRegressionTests(repo = repoRoot, diffRef = 'origin/master') {
  const { base } = resolveDiffBase(repo, diffRef);
  if (!base) return [];
  const diff = spawnSync('git', ['diff', '-U1', base, '--', 'tests/regression.mjs'], { cwd: repo, encoding: 'utf8' });
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

/** Publish every auto-map, including successful plans and mixed plans that still refuse a path. */
export function printAutoMappings(plan, log = console.log) {
  if (plan.autoMapScan.suites > 0) {
    log(`[test:fast] auto-map scan: ${plan.autoMapScan.suites} changed suite(s), ${plan.autoMapScan.bytes} source characters`);
  }
  for (const { path, suite } of plan.autoMappedFiles) {
    log(`[test:fast] auto-mapped ${path} -> ${suite} (changed suite that names it; verify it exercises the path)`);
  }
}

/**
 * The exact committed tree this run observed, or null when there is none (a non-git tree, or no commits).
 * A cached verdict is keyed to a TREE, so a run that cannot name one cannot certify anything.
 */
export function readHeadTree(repo = repoRoot) {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim();
    return { head, tree };
  } catch {
    return { head: null, tree: null };
  }
}

/**
 * The suites that LITERALLY IMPORT a module: a static import specifier, a dynamic import() or a require().
 * Deliberately narrower than importingSuitesOf, which over-approximates by matching any text reference, and the
 * two directions of error are not symmetric (web-uplift-5jwc): a REFUSAL may name one consumer too many, because
 * the cost is running the full gate, while a CERTIFICATION may not - a rule satisfiable only by avoiding every
 * text reference would report "non-certifying" for essentially every diff, and a boolean that can never be true
 * carries no information. A suite that LOADS the module is the evidence that it exercises it.
 */
export function importingSuiteSpecifiers(modulePath, repo = repoRoot) {
  let entries;
  try {
    entries = readdirSync(join(repo, 'tests'));
  } catch {
    return [];
  }
  const specifierPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"`]([^'"`\r\n]+)['"`]/g;
  const suites = [];
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith('.mjs')) continue;
    const rel = `tests/${entry}`;
    if (rel === modulePath || !isDirectRunnableTest(rel)) continue;
    let source;
    try {
      source = readFileSync(join(repo, rel), 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(specifierPattern)) {
      const spec = match[1];
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
      const resolved = posix.normalize(spec.startsWith('/') ? posix.relative('/', spec) : posix.join(posix.dirname(rel), spec));
      if (resolved === modulePath && !suites.includes(rel)) suites.push(rel);
    }
  }
  return suites;
}

/**
 * The single machine-readable selection/execution manifest (web-uplift-5jwc, per the ADR web-uplift-tdg4).
 * A consumer of a fast verdict reads THIS rather than guessing a changed set from a branch diff or inferring
 * coverage from suite names, and it certifies only when `certifiable` is true and `tree` matches its key.
 *
 * It is a pure function of its inputs - no git, no clock, no filesystem - so the contract controls below can
 * exercise every branch of the certifying rule without a repository and without depending on machine state.
 *
 * `certifiable` is deliberately stricter than "the tests passed":
 *   - only an EXECUTE run on a CLEAN working tree, whose changed set came from the diff and not from explicit
 *     file arguments, can certify - a dirty run is iteration evidence, and tdg4 says so explicitly;
 *   - every changed executable that a suite under tests/ IMPORTS must have that importing suite SELECTED here;
 *     a mapped-but-underselected helper is the web-uplift-5y2w fixture, where a green verdict coexisted with
 *     eight omitted consumers. Literal imports are used rather than the refusal path's text-reference scan,
 *     because over-refusing is harmless for a refusal and useless for a certificate;
 *   - unmapped, refused or omitted executable paths keep the run non-certifying even when the suites that did
 *     run exited 0. That is the whole point: exit status is an execution observation, not coverage completeness.
 */
export function buildSelectionManifest({ plan, changed, mode, diffRef, head, tree, executed = [], explicitSelection = false }) {
  const selected = plan.targets.map((target) => ({
    kind: target.type,
    label: target.label,
    ...(target.path ? { path: target.path } : {}),
    ...(target.filter ? { filter: target.filter } : {}),
  }));
  const selectedPaths = new Set(plan.targets.map((t) => t.path).filter(Boolean));
  const noGitTree = !tree || !head;
  const requiredConsumersMissing = [];
  for (const path of changed.files || []) {
    if (!hasCodeExtension(path) || noGitTree) continue;
    for (const consumer of importingSuiteSpecifiers(path)) {
      if (!selectedPaths.has(consumer)) {
        requiredConsumersMissing.push({ path, consumer });
      }
    }
  }
  const uncommitted = changed.uncommitted || [];
  const reasons = [];
  if (noGitTree) reasons.push('no committed tree could be read (a non-git tree, or no commits): a verdict is keyed to a tree, so this run cannot certify one');
  if (mode !== 'execute') reasons.push(`mode is ${mode}: only an execute run can certify`);
  if (explicitSelection) reasons.push('the changed set came from explicit file arguments, not from the diff, so it is not a complete selection for the tree');
  if (uncommitted.length > 0) {
    reasons.push(`${uncommitted.length} path(s) are uncommitted (${uncommitted.map((u) => `${u.path} [${u.kind}]`).join(', ')}): the run observed the working tree, not the committed tree a cached verdict is keyed to`);
  }
  for (const f of plan.unmappedFiles) reasons.push(`changed executable ${f} maps to no suite, so no evidence exists for it`);
  for (const f of plan.refusedFiles) reasons.push(`changed path ${f.path} needs the full gate, not a fast-tier subset`);
  for (const { path, consumer } of requiredConsumersMissing) {
    reasons.push(`${path} is named by ${consumer}, which this run did not select: a required consumer was omitted`);
  }
  for (const entry of executed) {
    // A target whose path does not exist reports ok:true with skipped:true (runTarget does that so a renamed or
    // deleted suite does not crash the gate), but a target that never ran is NOT evidence. Testing only
    // !entry.ok here let a skipped target certify a tree while the '(skipped)' note below was dead code
    // (web-uplift-um6b), which is the same failure this manifest exists to prevent: a run that looks complete
    // while some of its selection was never executed.
    if (!entry.ok || entry.skipped) {
      reasons.push(entry.skipped
        ? `${entry.label} was SKIPPED: ${entry.path || entry.filter || 'its target'} does not exist, so this run has no evidence for it`
        : `${entry.label} did not pass`);
    }
  }
  if (mode === 'execute' && executed.length < plan.targets.length) {
    reasons.push(`only ${executed.length} of ${plan.targets.length} selected target(s) reported a status`);
  }
  return {
    manifestVersion: 1,
    producer: 'scripts/test-fast.mjs',
    mode,
    diffRef,
    comparisonBase: changed.base || null,
    comparisonRef: changed.resolvedRef || diffRef,
    head: head || null,
    tree: tree || null,
    changed: changed.files || [],
    uncommitted,
    explicitSelection,
    matchedSubsystems: plan.matchedSubsystems,
    isBaseline: plan.isBaseline,
    selected,
    autoMapped: plan.autoMappedFiles,
    omitted: plan.omittedFiles,
    refused: plan.refusedFiles.map((f) => ({ path: f.path, consumers: f.consumers })),
    unmapped: plan.unmappedFiles,
    requiredConsumersMissing,
    executed,
    certifiable: reasons.length === 0,
    nonCertifyingReasons: reasons,
  };
}

/**
 * Map list of changed file paths to affected test targets.
 */
export function mapFilesToTests(filePaths, options = {}) {
  const matchedSubsystems = new Set();
  const targetsByKey = new Map();
  const unmappedFiles = [];
  const omittedFiles = [];
  const refusedFiles = [];
  const autoMappedFiles = [];
  const exists = options.exists || ((p) => pathEntryExists(p, repoRoot));

  for (const rawPath of filePaths) {
    const normalized = rawPath.startsWith('/') ? relative(repoRoot, rawPath) : rawPath;

    // A declared full-gate-only module refuses before any subsystem can claim it, so the verdict cannot
    // be a subset that reads as coverage (web-uplift-5y2w).
    if (FULL_GATE_ONLY_MODULES.includes(normalized)) {
      refusedFiles.push({ path: normalized, consumers: importingSuitesOf(normalized, repoRoot) });
      continue;
    }

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
        // A registry edit that does not add a case (the normal shape now: the registry discovers suites) is
        // checked by the parity guard, which is the case that validates the registry's own invariant
        // (web-uplift-jyyq). Running the broad syntax case instead would spend ~8s to check less.
        const target = { type: 'regression', filter: 'testSuiteListsMatchRegressionRegistry', label: 'Regression: Registry parity' };
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

  // A changed executable can borrow ONLY a suite changed in this same diff that names its path.
  // Read each changed suite once; never search an unchanged suite or the whole tests tree.
  let autoMapScan = { suites: 0, bytes: 0 };
  if (unmappedFiles.length > 0) {
    const readSuite = options.readSuite || ((suite) => readFileSync(join(repoRoot, suite), 'utf8'));
    const suites = [...new Set(filePaths.map((f) => f.startsWith('/') ? relative(repoRoot, f) : f)
      .filter((f) => f.startsWith('tests/') && isDirectRunnableTest(f) && exists(f)))].sort();
    const namedBy = new Map();
    for (const suite of suites) {
      let source;
      try { source = readSuite(suite); } catch { continue; } // unreadable cannot prove a reference
      autoMapScan = { suites: autoMapScan.suites + 1, bytes: autoMapScan.bytes + source.length };
      const names = new Set();
      for (const match of source.matchAll(/(['"`])([^'"`\r\n]+)\1/g)) {
        const literal = match[2];
        if (!literal.includes('/') || literal.includes('${')) continue; // static path strings only
        names.add(posix.normalize(literal)); // repo-relative path or subprocess argument
        names.add(posix.normalize(posix.join(posix.dirname(suite), literal))); // import specifier
      }
      namedBy.set(suite, names);
    }
    const remaining = [];
    for (const file of unmappedFiles) {
      if (!hasCodeExtension(file) || !exists(file)) { remaining.push(file); continue; }
      const namingSuites = [...namedBy].filter(([, names]) => names.has(file)).map(([suite]) => suite);
      if (namingSuites.length === 0) { remaining.push(file); continue; }
      for (const suite of namingSuites) {
        autoMappedFiles.push({ path: file, suite });
        const target = { type: 'node', path: suite, label: `Direct test: ${suite}`, timeoutMs: suite.endsWith('.test.mjs') ? 240000 : 120000 };
        targetsByKey.set(targetKey(target), target);
      }
      // web-uplift-h68z: the auto-map is RECORDED AND PRINTED, and it does not excuse the missing map rule. The
      // refusal returns before any target runs, so the naming suite does not execute either - what the mapping
      // gives a lane is the diagnosis ("this changed suite names that path"), and what it cannot give is a
      // verdict, because the coverage it implies is LOCAL TO THIS DIFF and evaporates on main the moment the
      // suite stops being what you are changing. web-uplift-ebvj landed scripts/check-verdict.mjs exactly
      // that way - named by a changed suite, so every gate stayed green - while main carried no rule for it and
      // the gate's own completeness control was red. That is why the file stays in unmappedFiles and the CLI
      // still REFUSES with the one next action. This deliberately re-narrows web-uplift-tp77, which let an
      // auto-mapped path reach a green verdict to remove map-edit friction; the mapping and its print are kept
      // (the log names the suite and the path), and the requirement is a two-line map edit.
      remaining.push(file);
    }
    unmappedFiles.length = 0;
    unmappedFiles.push(...remaining);
  }

  // web-uplift-h68z (b): whatever the diff touched, an auto-mapped executable means the map/completeness
  // controls must RUN - they live in the gate's own suite, so before this they only executed when
  // tests/test-fast.mjs itself was in the changed set. Selecting the existing subsystem keeps one definition of
  // the target, so the label and the timeout cannot drift from the ones the gate uses normally.
  if (autoMappedFiles.length > 0) {
    const selfTest = SUBSYSTEMS.find((sub) => sub.id === 'fast-gate-self');
    matchedSubsystems.add(selfTest.id);
    for (const target of selfTest.targets) {
      targetsByKey.set(targetKey(target), target);
    }
  }

  // Only a diff with nothing to map at all falls back to the baseline suite. A diff that contains an
  // UNKNOWN path must not look like a baseline run: that was the false green this gate now refuses.
  const isBaseline = targetsByKey.size === 0 && unmappedFiles.length === 0 && refusedFiles.length === 0;
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
    refusedFiles,
    autoMappedFiles,
    autoMapScan,
    isBaseline,
  };
}

/**
 * Execute a single test target.
 */
// The final line a HUMAN reads. Keeping it here rather than inline in main() is deliberate: the machine-readable
// half of this (the manifest) is only consulted by tooling, so a reviewer reading the log needs the same truth,
// and a string built inline in an exit path cannot be tested. A target that was SKIPPED never ran, so it is not
// evidence and the line must not read as total success - which is what it used to say, because the exit path
// tested only res.ok (web-uplift-h6dg).
export function executionSummary(executed, total, duration) {
  const skipped = executed.filter((entry) => entry.skipped);
  const timing = duration ? ` in ${duration}s` : '';
  if (skipped.length === 0) {
    return `\n✔ [test:fast] ALL ${total} test target(s) PASSED${timing}.`;
  }
  const named = skipped.map((entry) => `${entry.label} (${entry.path || entry.filter || 'its target'} does not exist)`).join(', ');
  // Count only the targets that RAN. executed.length includes the skipped ones, so using it here made the same
  // sentence claim both that a target ran and passed and that it was skipped - a contradiction a reader could
  // see, and one the control did not catch because it asserted the absence of a phrase rather than the counts
  // (web-uplift-xgu0).
  const ranAndPassed = executed.length - skipped.length;
  return `\n⚠ [test:fast] ${ranAndPassed} of ${total} test target(s) ran and passed${timing}, but ${skipped.length} was SKIPPED: ${named} - this run is NOT certifying, because a target that never ran is not evidence.`;
}

// A suite scheduled DIRECTLY already runs every case it lists, so a regression FILTER that re-runs some of
// them is duplicate work, not extra coverage (web-uplift-91lr). Measured on a two-file redaction change:
// tests/redaction.test.mjs's browser cases ran under 'Regression: Secrets scan tests' (55.0s), under
// 'Regression: HAR redaction and redirects' (58.2s) AND in the whole-suite direct target, and
// testConsoleEvidence ran under both 'Regression: Evidence primitives' and 'Regression: Console evidence
// tests' - about 110s of pure duplication in a 690s gate.
//
// The direct target is NEVER narrowed: this only tells each regression filter to leave out a suite file that
// is already being run in full, so the union of executed CASE NAMES is unchanged by construction. That is not
// an argument, it is checked: tests/test-fast.mjs compares the two unions from the runner's own --list output.
export function dedupeAgainstDirectSuites(targets) {
  const directSuites = new Set(
    targets
      .filter((t) => t.type === 'node' && typeof t.path === 'string' && /^tests\/[^/]+\.test\.mjs$/.test(t.path))
      .map((t) => t.path),
  );
  if (directSuites.size === 0) return targets;
  return targets.map((t) => (t.type === 'regression' ? { ...t, excludeSuites: [...directSuites] } : t));
}

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
    for (const suite of target.excludeSuites || []) args.push('--exclude-suite', suite);
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
  let manifestPath = null;
  let manifestChanged = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
scripts/test-fast.mjs - Targeted fast test gate for web-uplift

Usage:
  node scripts/test-fast.mjs                     # diff from merge-base with origin/master
  node scripts/test-fast.mjs --diff <ref>        # diff from merge-base with specific ref
  node scripts/test-fast.mjs <file...>           # test affected by explicit files
  node scripts/test-fast.mjs --all               # run all fast test targets
  node scripts/test-fast.mjs --dry-run           # print planned test targets without running
  node scripts/test-fast.mjs --list              # list known subsystems
  node scripts/test-fast.mjs --manifest <path>   # also write the selection/execution manifest as JSON
`);
      process.exit(0);
    } else if (arg === '--list') {
      listSubsystems = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--all') {
      runAll = true;
    } else if (arg === '--manifest') {
      if (i + 1 < argv.length && argv[i + 1] !== '' && !argv[i + 1].startsWith('--manifest')) {
        manifestPath = argv[++i];
      } else {
        console.error('error: missing argument for --manifest');
        process.exit(1);
      }
    } else if (arg.startsWith('--manifest=')) {
      manifestPath = arg.slice('--manifest='.length);
      if (!manifestPath) {
        console.error('error: missing value for --manifest=');
        process.exit(1);
      }
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
    const ranHere = [];
    for (const target of targets) {
      const res = runTarget(target);
      // Record the result rather than discarding it: without this the line below could not tell a skipped target
      // from a passing one, which is exactly how it came to claim total success for a target that never ran.
      ranHere.push({ label: target.label, path: target.path, filter: target.filter, ok: res.ok, skipped: Boolean(res.skipped) });
      if (!res.ok) process.exit(res.status || 1);
    }
    console.log(executionSummary(ranHere, targets.length));
    process.exit(0);
  }

  if (filesToTest.length === 0) {
    const changed = getChangedFiles(repoRoot, diffRef);
    filesToTest = changed.files;
    manifestChanged = changed;
    resolvedRefLabel = changed.resolvedRef || diffRef;
    // Name the comparison BASE and the distance behind the ref, not just the ref: the base decides how
    // large the diff is, and 'vs origin/master' named the one thing this does not compare against
    // (web-uplift-5e9s (2), web-uplift-1a6q).
    const baseShort = changed.base ? changed.base.slice(0, 7) : 'unknown';
    const distance = getDiffDistance(repoRoot, changed.resolvedRef);
    const distanceLabel =
      distance.ahead === null ? '' : `; branch ${distance.ahead} ahead / ${distance.behind} behind ${resolvedRefLabel}`;
    console.log(
      `[test:fast] Detected ${filesToTest.length} changed file(s) vs base ${baseShort} (merge-base of ${resolvedRefLabel})${distanceLabel}`
    );
    const uncommittedKinds = new Map(changed.uncommitted.map((u) => [u.path, u.kind]));
    if (filesToTest.length > 0) {
      for (const f of filesToTest.slice(0, 10)) {
        console.log(`  • ${f}${uncommittedKinds.has(f) ? `  [uncommitted: ${uncommittedKinds.get(f)}]` : ''}`);
      }
      if (filesToTest.length > 10) console.log(`  ... and ${filesToTest.length - 10} more`);
    }
    if (changed.uncommitted.length > 0) {
      console.log(
        `[test:fast] UNCOMMITTED (${changed.uncommitted.length} of ${filesToTest.length}) - not in HEAD, so not in the committed tree a cached verdict is keyed to:`
      );
      for (const u of changed.uncommitted) console.log(`  - ${u.path} [${u.kind}]`);
      console.log(
        '[test:fast] This run selects and executes against the WORKING TREE. Its result is not a verdict for HEAD alone: commit these paths and re-run to gate the committed tree.'
      );
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
  printAutoMappings(plan);

  // web-uplift-5jwc (ADR web-uplift-tdg4): emit the selection/execution manifest on EVERY exit path, the
  // refusals included, so a consumer never has to infer from a log line why a run is not certifying.
  const gitFacts = readHeadTree(repoRoot);
  const emitManifest = (mode, executed) => {
    if (!manifestPath) return;
    const manifest = buildSelectionManifest({
      plan,
      changed: manifestChanged || { files: filesToTest, uncommitted: [], base: null, resolvedRef: null },
      mode,
      diffRef,
      head: gitFacts.head,
      tree: gitFacts.tree,
      executed,
      explicitSelection: manifestChanged === null,
    });
    try {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (err) {
      console.error(`fast-gate: FAIL - could not write the selection manifest to ${manifestPath}: ${err.message}`);
      console.error('[test:fast] A manifest that cannot be written is a FAILURE, not a warning: a consumer that reads a missing manifest as complete is the false green this whole mechanism refuses.');
      process.exit(1);
    }
    if (manifest.certifiable) {
      console.log(`[test:fast] certifiable: this run observed exact tree ${manifest.tree} (manifest written to ${manifestPath})`);
    } else {
      console.error(`[test:fast] NOT CERTIFIABLE (manifest written to ${manifestPath}):`);
      for (const reason of manifest.nonCertifyingReasons) console.error(`  - ${reason}`);
    }
  };
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
  // A full-gate-only module (web-uplift-5y2w) refuses for the opposite reason to an unmapped path: the
  // suite that should run it exists, and running all of it is the full gate. Naming the importing suites
  // and one command keeps the choice with the author instead of hiding it behind a fast-tier subset.
  if (plan.refusedFiles.length > 0) {
    for (const f of plan.refusedFiles) {
      console.log(`fast-gate: refused: ${f.path} (named by ${f.consumers.length} suite(s) under tests/)`);
    }
    console.error(`fast-gate: FAIL - ${plan.refusedFiles.length} changed file(s) need the full gate, not a fast-tier subset:`);
    for (const f of plan.refusedFiles) {
      console.error(`  ${f.path}: a shared module whose consumers are most of the fast tier.`);
      console.error(`    named by ${f.consumers.length} suite(s) under tests/: ${f.consumers.join(', ') || 'none found in the tree'}`);
    }
    console.error('[test:fast] NEXT ACTION: run the full gate for this change, which runs every suite:');
    console.error('    npm test');
    console.error('  The fast tier has no honest subset for a shared helper: a subset would either be the whole');
    console.error('  gate or a green run of cases that do not exercise the change (web-uplift-5y2w).');
    emitManifest('execute', []);
    process.exit(1);
  }

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
    console.error('  * cannot extend the map right now? The full gate is NOT evidence on its own for a refused path its tests do not exercise:');
    console.error('    npm test runs tests/*.test.mjs; the guarded standalone suites here are covered ONLY if those files invoke their tests. Import alone does not run them.');
    console.error('    A module that registers node:test cases at import time can instead run them on import; check what the importing suite actually executes.');
    console.error('    Run the suite covering a path not exercised by those files explicitly, then run the full gate:');
    for (const f of plan.unmappedFiles) {
      if (f.startsWith('tests/') && f.endsWith('.mjs')) {
        console.error(`      node ${f}   # the refused path is itself a runnable suite`);
      }
    }
    console.error('      FLEET_CHECK_CONF=/home/exedev/.fleet/conf.d/web-uplift.conf fleet-check');
    console.error('    and name the command that produced the evidence in your hand-off.');
    console.error('[test:fast] No test target was executed. A baseline run is not evidence that the changed file was tested.');
    emitManifest('execute', []);
    process.exit(1);
  }

  const beforeDedupe = plan.targets;
  plan.targets = dedupeAgainstDirectSuites(plan.targets);
  const directSuites = new Set(plan.targets.filter((t) => t.type === 'node' && /^tests\/[^/]+\.test\.mjs$/.test(t.path || '')).map((t) => t.path));
  if (directSuites.size > 0) {
    const filtersDeduped = plan.targets.filter((t) => (t.excludeSuites || []).length > 0).length;
    console.log(`[test:fast] Dedupe: ${directSuites.size} suite(s) run in full, so ${filtersDeduped} filter target(s) skip ${[...directSuites].join(', ')} (union of case names unchanged)`);
  }
  console.log(`[test:fast] Selected ${plan.targets.length} test target(s):`);
  for (const t of plan.targets) {
    console.log(`  → ${t.label}`);
  }

  if (dryRun) {
    console.log('\n[test:fast] Dry-run complete. Exiting without execution.');
    emitManifest('dry-run', []);
    process.exit(0);
  }

  const startTime = Date.now();
  const executed = [];
  for (const target of plan.targets) {
    const res = runTarget(target);
    executed.push({
      label: target.label,
      ...(target.path ? { path: target.path } : {}),
      ...(target.filter ? { filter: target.filter } : {}),
      ok: res.ok,
      status: res.status ?? null,
      duration: res.duration ?? null,
      skipped: Boolean(res.skipped),
    });
    if (!res.ok) {
      console.error(`\n✖ [test:fast] STOPPED: ${target.label} failed.`);
      emitManifest('execute', executed);
      process.exit(res.status || 1);
    }
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(executionSummary(executed, plan.targets.length, totalDuration));
  emitManifest('execute', executed);
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
