#!/usr/bin/env node
// Focused guard for the installer copy-path symlink follow (web-uplift-z34).
//
// bin/web-uplift.mjs copyDir() used to classify entries with statSync, which
// FOLLOWS symlinks. A symlinked file or directory inside a vendored source tree
// was therefore copied out of its tree (or recursed unboundedly through a
// cycle), and the vendored dependency closure was copied implicitly from each
// package's `dependencies` with no completeness check. The fix is lstatSync plus
// skipping every symlink outright (recorded in skippedFiles with reason
// 'symlink'), a depth guard so a cycle that somehow survives is a recorded
// refusal rather than unbounded recursion, and a closure-integrity assertion
// that the vendored node_modules is exactly the transitive closure of the
// declared runtime deps, byte-for-byte.
//
// This file is the fast, browser-free foreground check. Run it directly:
//   node tests/install-copy-symlink.mjs
// It is also imported by tests/regression.mjs so the full gate covers it.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VENDORED_DEPENDENCIES, VENDORED_DIRS, VENDORED_FILES, TRACKED_COPY_FILES, generateVendoredSurface } from '../install-surface.mjs';
import { Worker } from 'node:worker_threads';
import { listFiles } from './test-helpers.mjs';

const require = createRequire(import.meta.url);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
// schema/ is a declared VENDORED_DIR, so a symlink planted here is copied by the
// installer's copy-dir path and is a real, observable fixture for the fix.
const SCHEMA_DIR = join(repoRoot, 'schema');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runInstall(target) {
  return spawnSync(process.execPath, [join(repoRoot, 'bin/web-uplift.mjs'), 'install', '--agent', 'codex', '--target', target], { encoding: 'utf8' });
}

// Resolve a package's package.json without tripping ERR_PACKAGE_PATH_NOT_EXPORTED:
// packages such as web-features export only specific subpaths, not ./package.json.
function resolvePackageJson(name) {
  try {
    return require.resolve(`${name}/package.json`);
  } catch {
    const entry = require.resolve(name);
    let cur = dirname(entry);
    while (cur && cur !== dirname(cur)) {
      const candidate = join(cur, 'package.json');
      if (existsSync(candidate)) return candidate;
      cur = dirname(cur);
    }
    throw new Error(`Cannot resolve package.json for dependency ${name}`);
  }
}

// The transitive closure of VENDORED_DEPENDENCIES, sorted, exactly as the
// installer walks it (bin/web-uplift.mjs dependencyCopySteps).
function closureNames() {
  const names = new Set();
  const visit = (name) => {
    if (names.has(name)) return;
    names.add(name);
    const pkg = JSON.parse(readFileSync(resolvePackageJson(name), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep);
  };
  for (const dep of VENDORED_DEPENDENCIES) visit(dep);
  return [...names].sort();
}

// Map of relative file path -> absolute path for every regular file under `dir`,
// skipping symlinks (the installer must skip them, so the closure check must not
// count one as present).
function walkFiles(dir) {
  const files = new Map();
  if (!existsSync(dir)) return files;
  const visit = (current, base) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(join(current, entry.name), rel);
      else files.set(rel, join(current, entry.name));
    }
  };
  visit(dir, '');
  return files;
}

// Fixture 1: a file symlink pointing OUTSIDE the vendored tree and a directory
// symlink cycle must both be recorded refusals, never followed or copied.
export function testInstallSkipsSymlinksInVendoredSource() {
  const outside = mkdtempSync(join(tmpdir(), 'web-uplift-install-symlink-outside-'));
  const target = mkdtempSync(join(tmpdir(), 'web-uplift-install-symlink-target-'));
  const fileLink = join(SCHEMA_DIR, 'install-symlink-escape.txt');
  const cycleDir = join(SCHEMA_DIR, 'install-symlink-cycle');
  try {
    // Purge BEFORE building, not only in the finally: a killed run (reaper, timeout, preempted heavy
    // slot) never reaches finally, and the leftovers then make the FIRST non-recursive mkdir/symlink
    // below throw EEXIST, poisoning every later run in the same worktree (web-uplift-qx4i).
    rmSync(fileLink, { recursive: true, force: true });
    rmSync(cycleDir, { recursive: true, force: true });
    const secret = 'AKIA' + 'INSTALLSYMLINKFILEESCAPE';
    const outsideSecret = join(outside, 'id_rsa');
    writeFileSync(outsideSecret, secret);
    symlinkSync(outsideSecret, fileLink);
    mkdirSync(cycleDir);
    symlinkSync(cycleDir, join(cycleDir, 'loop'));

    const install = runInstall(target);
    assert(install.status === 0, `install with symlinks failed:\n${install.stderr || install.stdout}`);
    assert(install.stdout.includes('install-symlink-escape.txt (symlink)'), `install did not record skipping the file symlink:\n${install.stdout}`);
    assert(install.stdout.includes('loop (symlink)'), `install did not record skipping the directory symlink:\n${install.stdout}`);
    assert(!existsSync(join(target, '.web-uplift/schema/install-symlink-escape.txt')), 'the symlink FILE must not be copied');
    assert(!existsSync(join(target, '.web-uplift/schema/install-symlink-cycle/loop')), 'the symlink DIR must not be copied');

    const copied = JSON.stringify([...walkFiles(join(target, '.web-uplift')).keys()]);
    assert(!copied.includes(secret), 'the symlink FILE target content must not be copied');
  } finally {
    rmSync(fileLink, { force: true });
    rmSync(cycleDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

// Fixture 2: a real directory deeper than the copy depth limit is a recorded
// refusal; nothing past the limit may be copied (defence-in-depth against a
// cycle that somehow survives the symlink skip).
export function testInstallCopyDepthGuard() {
  const target = mkdtempSync(join(tmpdir(), 'web-uplift-install-depth-target-'));
  const fixture = join(SCHEMA_DIR, 'install-depth-fixture');
  try {
    // Same start-of-run purge as fixture 1, and for the same reason: the descent below uses a
    // NON-recursive mkdir, so an `install-depth-fixture/d` left by a killed run makes this throw
    // EEXIST before it tests anything (web-uplift-qx4i). The fixture must stay under SCHEMA_DIR -
    // that is what makes the install walk it and hit the depth guard - so it cannot be a tmpdir.
    rmSync(fixture, { recursive: true, force: true });
    let dir = fixture;
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 70; i++) {
      dir = join(dir, 'd');
      mkdirSync(dir);
    }
    writeFileSync(join(dir, 'leaf.txt'), 'leaf\n');

    const install = runInstall(target);
    assert(install.status === 0, `install with deep tree failed:\n${install.stderr || install.stdout}`);
    assert(install.stdout.includes('depth-limit'), `install did not record the depth guard refusal:\n${install.stdout}`);

    const copied = walkFiles(join(target, '.web-uplift', 'schema'));
    assert(
      ![...copied.keys()].some((rel) => rel.includes('leaf.txt')),
      `nothing past the depth limit may be copied:\n${[...copied.keys()].join('\n')}`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

// Control for web-uplift-qx4i: both fixtures above must pass WITH the leftovers a killed run leaves
// behind already on disk. Without the start-of-run purges this fails with EEXIST on the first
// non-recursive mkdir/symlink, which is precisely how the merger's union gate was poisoned by an
// unrelated change. The leftovers are created here rather than assumed, so the control cannot pass
// because the paths happened to be clean.
export function testInstallFixturesTolerateLeftoversFromAKilledRun() {
  const fileLink = join(SCHEMA_DIR, 'install-symlink-escape.txt');
  const cycleDir = join(SCHEMA_DIR, 'install-symlink-cycle');
  const fixture = join(SCHEMA_DIR, 'install-depth-fixture');
  rmSync(fileLink, { recursive: true, force: true });
  rmSync(cycleDir, { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(join(cycleDir, 'loop'), { recursive: true });
  writeFileSync(fileLink, 'leftover\n');
  mkdirSync(join(fixture, 'd', 'd'), { recursive: true });
  writeFileSync(join(fixture, 'd', 'd', 'leaf.txt'), 'leftover leaf\n');

  assert(existsSync(join(cycleDir, 'loop')), 'the control must create the cycle leftover before testing');
  assert(existsSync(join(fixture, 'd')), 'the control must create the depth leftover before testing');

  testInstallSkipsSymlinksInVendoredSource();
  testInstallCopyDepthGuard();
}

// Fixture 3: the vendored dependency closure is complete. There is no lockfile
// for `.web-uplift/node_modules`, so the closure is the only record of what must
// be on disk; a missing, extra, or byte-different package is a defect.
export function testInstallVendorsCompleteClosure() {
  const target = mkdtempSync(join(tmpdir(), 'web-uplift-install-closure-'));
  try {
    const expected = closureNames();
    assert(expected.length > 0, 'closure integrity: VENDORED_DEPENDENCIES resolved to an empty closure');

    const install = runInstall(target);
    assert(install.status === 0, `install failed:\n${install.stderr || install.stdout}`);

    const vendoredRoot = join(target, '.web-uplift', 'node_modules');
    const actual = readdirSync(vendoredRoot).sort();
    assert(
      JSON.stringify(actual) === JSON.stringify(expected),
      `closure drift: vendored ${JSON.stringify(actual)} but expected ${JSON.stringify(expected)}`,
    );

    for (const name of expected) {
      const srcDir = dirname(resolvePackageJson(name));
      const srcFiles = walkFiles(srcDir);
      const dstFiles = walkFiles(join(vendoredRoot, name));
      const rels = [...new Set([...srcFiles.keys(), ...dstFiles.keys()])].sort();
      for (const rel of rels) {
        const srcAbs = srcFiles.get(rel);
        const dstAbs = dstFiles.get(rel);
        assert(srcAbs && dstAbs, `closure drift: ${name}/${rel} is missing on one side`);
        assert(
          readFileSync(srcAbs).equals(readFileSync(dstAbs)),
          `closure drift: ${name}/${rel} differs from its source`,
        );
      }
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

// Fixture 4: pre-planted destination symlinks must be refused and skipped,
// never followed or clobbered (web-uplift-yel3). We plant symlinks for every
// installer action (write, copy-file, copy-dir file and dir, append) pointing
// to victim files outside the target project, run install, and verify all
// victims are untouched and the skips are reported in stdout.
export function testInstallRefusesDestinationSymlinks() {
  const outside = mkdtempSync(join(tmpdir(), 'web-uplift-dest-symlink-outside-'));
  const target = mkdtempSync(join(tmpdir(), 'web-uplift-dest-symlink-target-'));
  try {
    const victimManifest = join(outside, 'victim-manifest.json');
    const victimSkill = join(outside, 'victim-skill.md');
    const victimSchema = join(outside, 'victim-schema.json');
    const victimAgents = join(outside, 'victim-agents.md');
    const victimDir = join(outside, 'victim-dir');

    writeFileSync(victimManifest, 'VICTIM-MANIFEST-SECRET\n');
    writeFileSync(victimSkill, 'VICTIM-SKILL-SECRET\n');
    writeFileSync(victimSchema, 'VICTIM-SCHEMA-SECRET\n');
    writeFileSync(victimAgents, 'VICTIM-AGENTS-SECRET\n');
    mkdirSync(victimDir);
    writeFileSync(join(victimDir, 'safe.txt'), 'VICTIM-DIR-SECRET\n');

    // Pre-plant destination symlinks covering every install write action:
    // 1. write: .web-uplift/manifest.json
    mkdirSync(join(target, '.web-uplift'), { recursive: true });
    symlinkSync(victimManifest, join(target, '.web-uplift', 'manifest.json'));

    // 2. copy-file: .codex/skills/web-audit/SKILL.md
    mkdirSync(join(target, '.codex', 'skills', 'web-audit'), { recursive: true });
    symlinkSync(victimSkill, join(target, '.codex', 'skills', 'web-audit', 'SKILL.md'));

    // 3. copy-dir (file): .web-uplift/schema/findings.schema.json
    mkdirSync(join(target, '.web-uplift', 'schema'), { recursive: true });
    symlinkSync(victimSchema, join(target, '.web-uplift', 'schema', 'findings.schema.json'));

    // 4. copy-dir (directory): .web-uplift/knowledge
    symlinkSync(victimDir, join(target, '.web-uplift', 'knowledge'));

    // 5. append: AGENTS.md
    symlinkSync(victimAgents, join(target, 'AGENTS.md'));

    const install = runInstall(target);
    // web-uplift-v167: an install that refused a destination is INCOMPLETE and must not report success. It used
    // to print these same skips, print 'Installed' and exit 0, so a user or a CI script saw success for an
    // install with five files missing - the same condition the vendored sync already refuses AND fails on.
    assert(install.status !== 0,
      `install with destination symlinks must FAIL, not exit 0, got ${install.status}:\n${install.stdout}`);
    assert(!/^Installed\./m.test(install.stdout),
      `an incomplete install must NOT print the success line:\n${install.stdout}`);
    assert(/FAILED: refused to write \d+ destination/.test(install.stdout + install.stderr),
      `the failure must be loud rather than a silent refusal:\n${install.stdout}${install.stderr}`);

    // Assert that all victims remain completely untouched
    assert(readFileSync(victimManifest, 'utf8') === 'VICTIM-MANIFEST-SECRET\n', 'victim manifest must not be clobbered');
    assert(readFileSync(victimSkill, 'utf8') === 'VICTIM-SKILL-SECRET\n', 'victim skill must not be clobbered');
    assert(readFileSync(victimSchema, 'utf8') === 'VICTIM-SCHEMA-SECRET\n', 'victim schema must not be clobbered');
    assert(readFileSync(victimAgents, 'utf8') === 'VICTIM-AGENTS-SECRET\n', 'victim agents must not be clobbered');
    assert(readFileSync(join(victimDir, 'safe.txt'), 'utf8') === 'VICTIM-DIR-SECRET\n', 'victim dir must not be clobbered');
    assert(readdirSync(victimDir).length === 1, 'victim dir must not have files copied into it');

    // Assert that skipped symlinks are reported in output
    assert(install.stdout.includes('manifest.json (symlink)'), `install did not record skipping manifest symlink:\n${install.stdout}`);
    assert(install.stdout.includes('SKILL.md (symlink)'), `install did not record skipping skill symlink:\n${install.stdout}`);
    assert(install.stdout.includes('findings.schema.json (symlink)'), `install did not record skipping schema symlink:\n${install.stdout}`);
    assert(install.stdout.includes('knowledge (symlink)'), `install did not record skipping knowledge dir symlink:\n${install.stdout}`);
    assert(install.stdout.includes('AGENTS.md (symlink)'), `install did not record skipping agents symlink:\n${install.stdout}`);

    // Positive check: unsymlinked files in the same install were still written normally
    assert(existsSync(join(target, '.web-uplift', 'schema', 'config.schema.json')), 'unpoisoned schema file must be written');
    assert(existsSync(join(target, '.web-uplift', 'evidence', 'cli.mjs')), 'unpoisoned evidence CLI must be written');
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

// Fixture 5: normal clean destination writes succeed and create regular files,
// with no symlink skips reported.
export function testInstallNormalDestinationWrites() {
  const target = mkdtempSync(join(tmpdir(), 'web-uplift-dest-normal-target-'));
  try {
    const install = runInstall(target);
    assert(install.status === 0, `clean install failed:\n${install.stderr || install.stdout}`);
    assert(!install.stdout.includes('(symlink)'), `clean install must not report any symlinks skipped:\n${install.stdout}`);
    // The other half of web-uplift-v167: a complete install must still succeed AND still say so. Without this the
    // stricter exit could be satisfied by a CLI that failed everything.
    assert(/^Installed\./m.test(install.stdout), `a clean install must still report success:\n${install.stdout}`);

    const manifestPath = join(target, '.web-uplift', 'manifest.json');
    const skillPath = join(target, '.codex', 'skills', 'web-audit', 'SKILL.md');
    const schemaPath = join(target, '.web-uplift', 'schema', 'findings.schema.json');
    const agentsPath = join(target, 'AGENTS.md');

    assert(existsSync(manifestPath) && !lstatSync(manifestPath).isSymbolicLink(), 'manifest must be a regular file');
    assert(existsSync(skillPath) && !lstatSync(skillPath).isSymbolicLink(), 'skill must be a regular file');
    assert(existsSync(schemaPath) && !lstatSync(schemaPath).isSymbolicLink(), 'schema must be a regular file');
    assert(existsSync(agentsPath) && !lstatSync(agentsPath).isSymbolicLink(), 'agents marker must be a regular file');
    assert(readFileSync(agentsPath, 'utf8').includes('<!-- web-uplift:install -->'), 'agents snippet must be present');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

// Fixture 6: generateVendoredSurface (install-surface.mjs) must refuse to write THROUGH a
// pre-planted destination symlink (web-uplift-7caa). bin/web-uplift.mjs got this guard for its own
// install writes in web-uplift-yel3 and install-surface.mjs was omitted, so the paths that run on
// every install - `npm run prepare`, `npm run sync:vendored`, and the test suite's auto-generate -
// still followed a planted link out of the tree. Measured on master before the fix, with the same
// fixture this test builds: the manifest symlink and the SKILL.md symlink were both CLOBBERED with
// generated content, and `.web-uplift/knowledge` -> a victim DIRECTORY received principles.json.
//
// The two halves coord asked to be answered separately, and both are asserted here:
//   (a) the DESTINATION itself is a symlink (manifest.json, skill/SKILL.md, and the TRACKED copy);
//   (b) an INTERMEDIATE DIRECTORY component is a symlink (`.web-uplift/knowledge` -> victimDir),
//       which lstat of the leaf cannot see and which the report must name as the component.
// The tracked copy is the reachable half: `.pi/skills/web-audit/SKILL.md` is a destination git
// tracks, so a branch can replace that tracked file with a symlink (this repo already tracks
// `.codex/skills/web-audit` as one) and the install paths above write through it on a checkout of
// that branch. The fixture plants exactly that, with the tracked file replaced the way a branch
// would replace it.
export function testGenerateVendoredSurfaceRefusesDestinationSymlinks() {
  const outside = mkdtempSync(join(tmpdir(), 'web-uplift-gen-dest-symlink-outside-'));
  const target = mkdtempSync(join(tmpdir(), 'web-uplift-gen-dest-symlink-target-'));
  const control = mkdtempSync(join(tmpdir(), 'web-uplift-gen-dest-control-'));
  try {
    writeVendoredSurfaceSources(target);
    writeVendoredSurfaceSources(control);

    const victimManifest = join(outside, 'victim-manifest.json');
    const victimSkill = join(outside, 'victim-skill.md');
    const victimTracked = join(outside, 'victim-bashrc');
    const victimDir = join(outside, 'victim-knowledge');
    writeFileSync(victimManifest, 'VICTIM-MANIFEST-SECRET\n');
    writeFileSync(victimSkill, 'VICTIM-SKILL-SECRET\n');
    writeFileSync(victimTracked, 'VICTIM-BASHRC-SECRET\n');
    mkdirSync(victimDir);
    writeFileSync(join(victimDir, 'safe.txt'), 'VICTIM-DIR-SECRET\n');

    mkdirSync(join(target, '.web-uplift'), { recursive: true });
    // (a) leaf destinations, one per write call the generator makes: writeFileSync (manifest) and
    // copyFileSync (a VENDORED_FILES file), plus the TRACKED_COPY_FILES destination.
    symlinkSync(victimManifest, join(target, '.web-uplift', 'manifest.json'));
    mkdirSync(join(target, '.web-uplift', 'skill'), { recursive: true });
    symlinkSync(victimSkill, join(target, '.web-uplift', 'skill', 'SKILL.md'));
    rmSync(join(target, '.pi', 'skills', 'web-audit', 'SKILL.md'), { force: true });
    const trackedRel = '.pi/skills/web-audit/SKILL.md';
    symlinkSync(victimTracked, join(target, ...trackedRel.split('/')));
    // (b) an INTERMEDIATE DIRECTORY component, on the VENDORED_FILES path (no rmSync runs before it).
    symlinkSync(victimDir, join(target, '.web-uplift', 'knowledge'));

    const run = runVendoredSurfaceGenerator(target);
    assert(run.status === 0, `the generator must not crash on a planted symlink:\n${run.stderr}`);
    const report = JSON.parse(run.stdout.split('REPORT=').pop().trim());

    // Every victim must be byte-identical, and nothing may be created inside the victim directory.
    assert(readFileSync(victimManifest, 'utf8') === 'VICTIM-MANIFEST-SECRET\n', 'the manifest symlink must not be written through');
    assert(readFileSync(victimSkill, 'utf8') === 'VICTIM-SKILL-SECRET\n', 'the copy-file symlink must not be written through');
    assert(readFileSync(victimTracked, 'utf8') === 'VICTIM-BASHRC-SECRET\n', 'the TRACKED destination symlink must not be written through');
    assert(readFileSync(join(victimDir, 'safe.txt'), 'utf8') === 'VICTIM-DIR-SECRET\n', 'the victim directory must keep its file');
    assert(!existsSync(join(victimDir, 'principles.json')), 'no file may be created through a symlinked directory component');
    assert(readdirSync(victimDir).length === 1, `the victim directory must receive nothing: ${readdirSync(victimDir).join(', ')}`);
    assert(lstatSync(join(target, ...trackedRel.split('/'))).isSymbolicLink(), 'the refusal must leave the planted symlink alone rather than replacing it');

    // The refusal must be REPORTED, both as data (so a caller can fail on it) and as a message (so
    // `npm run prepare`, which ignores the return value, is not silent).
    const refused = new Map((report.skippedSymlinks || []).map((s) => [s.path, s.symlinkComponent]));
    for (const [path, component] of [
      ['.web-uplift/manifest.json', '.web-uplift/manifest.json'],
      ['.web-uplift/skill/SKILL.md', '.web-uplift/skill/SKILL.md'],
      [trackedRel, trackedRel],
      // The leaf is principles.json; the offending component is its directory. Naming the component
      // is the whole reason the walk is over components rather than the leaf.
      ['.web-uplift/knowledge/principles.json', '.web-uplift/knowledge'],
    ]) {
      assert(refused.get(path) === component, `the report must name ${path} as refused at ${component}, got ${JSON.stringify([...refused])}`);
    }
    assert(run.stderr.includes('refusing to write through a symlink'), `the refusal must be printed for the npm prepare path, which ignores the report:\n${run.stderr}`);
    assert(run.stderr.includes('.web-uplift/knowledge is a symlink'), `the message must name the symlinked COMPONENT:\n${run.stderr}`);

    // CONTROL: without the plants the same fixture generates the whole surface and refuses nothing.
    // Without this half, "refuse the write" could be implemented as "never write" and still pass.
    const clean = runVendoredSurfaceGenerator(control);
    assert(clean.status === 0, `a clean generation must succeed:\n${clean.stderr}`);
    const cleanReport = JSON.parse(clean.stdout.split('REPORT=').pop().trim());
    assert((cleanReport.skippedSymlinks || []).length === 0, `a clean generation must refuse nothing: ${JSON.stringify(cleanReport)}`);
    assert(!clean.stderr.includes('refusing'), `a clean generation must not print a refusal:\n${clean.stderr}`);
    assert(existsSync(join(control, '.web-uplift', 'manifest.json')), 'a clean generation must write the manifest');
    assert(existsSync(join(control, '.web-uplift', 'evidence', 'cli.mjs')), 'a clean generation must copy a vendored directory');
    assert(existsSync(join(control, '.web-uplift', 'schema', 'config.schema.json')), 'a clean generation must copy a vendored directory');
    assert(existsSync(join(control, '.web-uplift', 'skill', 'SKILL.md')), 'a clean generation must copy a vendored file');
    const trackedAbs = join(control, ...trackedRel.split('/'));
    assert(existsSync(trackedAbs), 'a clean generation must write the tracked copy');
    // The write is not merely content-correct, it is ABSENT when the bytes already match: an
    // identical rewrite changes only the ctime, and a tracked file whose ctime moves is what made
    // fleet-check record this tree STALE on a run nobody had edited (its witness fingerprints
    // `stat %n %s %z` for every tracked file). Asserted on the ctime itself, because content is
    // identical either way and cannot distinguish "wrote the same bytes" from "did not write".
    const ctimeBefore = lstatSync(trackedAbs, { bigint: true }).ctimeNs;
    const second = runVendoredSurfaceGenerator(control);
    assert(second.status === 0, `a second generation must succeed:\n${second.stderr}`);
    const secondReport = JSON.parse(second.stdout.split('REPORT=').pop().trim());
    assert((secondReport.skippedSymlinks || []).length === 0, `a second generation must refuse nothing: ${JSON.stringify(secondReport)}`);
    assert((secondReport.skippedIdentical || []).includes(trackedRel),
      `the second generation must report the identical tracked copy as unwritten: ${JSON.stringify(secondReport)}`);
    assert(lstatSync(trackedAbs, { bigint: true }).ctimeNs === ctimeBefore,
      'an identical tracked copy must not be rewritten: the write changes only its ctime, and that is what turned the fast gate STALE');
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
}

// The source tree generateVendoredSurface copies FROM (it reads sources from the target root as
// well as writing destinations into it), kept to the files this fixture's assertions need.
function writeVendoredSurfaceSources(root) {
  const put = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  put('.claude/skills/web-audit/SKILL.md', '# skill\n');
  put('.pi/skills/web-audit/SKILL.md', '# skill\n');
  put('schema/config.schema.json', '{}\n');
  put('knowledge/principles.json', '{}\n');
  put('evidence/cli.mjs', '// cli\n');
}

// The REAL generator, run in its own process so the printed refusal (which is what an `npm install`
// actually shows) is observable alongside the returned report.
function runVendoredSurfaceGenerator(target) {
  const driver = join(target, 'generate-driver.mjs');
  writeFileSync(driver, [
    `import { generateVendoredSurface } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'install-surface.mjs')).href)};`,
    `console.log('REPORT=' + JSON.stringify(generateVendoredSurface({ targetRoot: ${JSON.stringify(target)} })));`,
    '',
  ].join('\n'));
  return spawnSync(process.execPath, [driver], { encoding: 'utf8' });
}

// Fixture 6: the SYNC writer's destination guard (web-uplift-sfbp). tests/cdp-copy-sync.mjs IS
// `npm run sync:vendored` and the first half of BOTH `npm test` and `npm run test:fast`, and it kept its own
// bare writeFileSync with no symlink check: the walk was private to install-surface.mjs so it could not be
// reused even though it existed, and its auto-generate block read skippedTrackedCopies but ignored
// skippedSymlinks. With a link planted at the TRACKED destination `.pi/skills/web-audit/SKILL.md` and
// COMMITTED - the vector a pull request can carry, since .web-uplift/ is gitignored while that destination is
// a tracked path - the sync read the drift diff THROUGH the link, wrote through it and clobbered an
// outside-root victim with exit 0.
//
// Both readers of the refusal are exercised on this one fixture, and the EXIT STATUS is asserted in both,
// because the status is the half that was wrong: the fresh-clone case (no .web-uplift/, so the auto-generate
// block runs) and the already-generated case (the write path itself, with the block skipped entirely).
function buildSyncFixture() {
  const fixture = mkdtempSync(join(tmpdir(), 'web-uplift-sync-symlink-', ));
  mkdirSync(join(fixture, 'tests'), { recursive: true });
  // The two scripts under test, at the paths their own repoRoot resolution expects.
  for (const rel of ['install-surface.mjs', 'tests/cdp-copy-sync.mjs']) {
    cpSync(join(repoRoot, rel), join(fixture, rel));
  }
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'web-uplift-sync-fixture', version: '0.0.0' }, null, 2) + '\n');
  // The real vendored surface, SAMPLED: two files per declared copy-dir keep the pair structure (and every
  // destination the sync writes) exactly as it is, without copying ~700 KB twice per fixture - the guard
  // under test is the same whatever the tree weighs. The sorted order keeps the fixture deterministic.
  for (const dir of VENDORED_DIRS) {
    const src = join(repoRoot, dir.source);
    let copied = 0;
    for (const entry of readdirSync(src).sort()) {
      if (copied >= 2) break;
      const from = join(src, entry);
      if (!lstatSync(from).isFile()) continue;
      mkdirSync(join(fixture, dir.source), { recursive: true });
      cpSync(from, join(fixture, dir.source, entry));
      copied += 1;
    }
    assert(copied > 0, `the fixture needs at least one file under ${dir.source} to compare`);
  }
  for (const file of VENDORED_FILES) {
    mkdirSync(dirname(join(fixture, file.source)), { recursive: true });
    cpSync(join(repoRoot, file.source), join(fixture, file.source));
  }
  return fixture;
}

function git(fixture, args) {
  const run = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
  assert(run.status === 0, `fixture git ${args.join(' ')} failed: ${run.stderr || run.stdout}`);
  return run;
}

// One fixture for the symlink-destination cases below: the real (sampled) vendored surface in a COMMITTED git
// repository, with the tracked destination replaced by a mode-120000 symlink pointing at an OUTSIDE victim.
// Committing it is what makes this the PR-reachable vector rather than a local edit - the assertion below
// reads the mode back out of the index - and it is also what makes the tracked-copy edit protection read
// 'clean', so the run reaches the destination question instead of stopping at that one.
function committedSymlinkFixture({ withGeneratedSurface, victimContent }) {
  const tracked = TRACKED_COPY_FILES[0];
  assert(tracked, 'the tracked-copy list must name a destination for this fixture to plant a link at');
  const victimDir = mkdtempSync(join(tmpdir(), 'web-uplift-sync-victim-'));
  const fixture = buildSyncFixture();
  const victim = join(victimDir, 'victim-skill.md');
  writeFileSync(victim, victimContent);
  if (withGeneratedSurface) {
    runVendoredSurfaceGenerator(fixture);
    rmSync(join(fixture, 'generate-driver.mjs'), { force: true });
  }
  const destAbs = join(fixture, tracked.dest);
  rmSync(destAbs, { force: true });
  mkdirSync(dirname(destAbs), { recursive: true });
  symlinkSync(victim, destAbs);
  git(fixture, ['init', '-q']);
  git(fixture, ['add', '-A']);
  git(fixture, ['-c', 'user.email=fixture@test.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']);
  const lsFiles = spawnSync('git', ['ls-files', '-s', tracked.dest], { cwd: fixture, encoding: 'utf8' });
  assert(lsFiles.stdout.startsWith('120000'),
    `the fixture must commit the symlink as a tracked link, else it is not the PR-reachable vector: ${lsFiles.stdout}`);
  return { fixture, victimDir, victim, destAbs, victimContent };
}

function dropSyncFixture({ fixture, victimDir }) {
  rmSync(fixture, { recursive: true, force: true });
  rmSync(victimDir, { recursive: true, force: true });
}

// Run the REAL sync over such a fixture and assert the whole contract: the command FAILS, the victim outside
// the root is byte-identical, the destination is still a symlink, and the tracked copy is never reported as
// synced. Returns the output so a case can additionally assert what the refusal said.
function assertSyncRefusesSymlinkDestination({ fixture, victim, destAbs, victimContent }, label) {
  const tracked = TRACKED_COPY_FILES[0];
  const run = spawnSync(process.execPath, [join(fixture, 'tests/cdp-copy-sync.mjs'), '--sync'], { cwd: fixture, encoding: 'utf8', timeout: 120000 });
  const output = `${run.stdout}${run.stderr}`;
  assert(run.status !== 0,
    `sync:vendored over a committed symlink destination must FAIL, not exit 0 (${label} case), got ${run.status}: ${output}`);
  assert(output.includes('refusing to write through a symlink'),
    `the refusal must say what it refused (${label} case): ${output}`);
  assert(output.includes(tracked.dest),
    `the refusal must name the destination it refused (${label} case): ${output}`);
  assert(readFileSync(victim, 'utf8') === victimContent,
    `the victim outside the root must be byte-identical after the run (${label} case)`);
  assert(lstatSync(destAbs).isSymbolicLink(),
    `the destination must still be the symlink, not a regular file written over it (${label} case)`);
  assert(!output.includes(`synced: ${tracked.source} -> ${tracked.dest}`),
    `the tracked copy must not be reported as synced through the link (${label} case): ${output}`);
  return output;
}

// Fixture 6: the SYNC writer's destination guard (web-uplift-sfbp). tests/cdp-copy-sync.mjs IS
// `npm run sync:vendored` and the first half of BOTH `npm test` and `npm run test:fast`, and it kept its own
// bare writeFileSync with no symlink check: the walk was private to install-surface.mjs so it could not be
// reused even though it existed, and its auto-generate block read skippedTrackedCopies but ignored
// skippedSymlinks. With a link planted at the TRACKED destination `.pi/skills/web-audit/SKILL.md` and
// COMMITTED - the vector a pull request can carry, since .web-uplift/ is gitignored while that destination is
// a tracked path - the sync read the drift diff THROUGH the link, wrote through it and clobbered an
// outside-root victim with exit 0.
//
// Both readers of the refusal are exercised on this one fixture, and the EXIT STATUS is asserted in both,
// because the status is the half that was wrong: the fresh-clone case (no .web-uplift/, so the auto-generate
// block runs) and the already-generated case (the write path itself, with the block skipped entirely).
export function testSyncRefusesCommittedSymlinkDestination() {
  const victimContent = 'VICTIM-SKILL-CONTENT that the vendored SKILL.md must never replace\n';
  for (const withGeneratedSurface of [false, true]) {
    const fixtureCase = committedSymlinkFixture({ withGeneratedSurface, victimContent });
    try {
      const output = assertSyncRefusesSymlinkDestination(fixtureCase, withGeneratedSurface ? 'already-generated' : 'fresh-clone');
      if (!withGeneratedSurface) {
        // The refusal is TARGETED: the run got through generation and failed on the link, which is what stops
        // this passing for the wrong reason (an early crash would also exit non-zero).
        assert(existsSync(join(fixtureCase.fixture, '.web-uplift', 'schema')),
          `the rest of the surface must still have been generated before the refusal (fresh-clone case): ${output}`);
      }
    } finally {
      dropSyncFixture(fixtureCase);
    }
  }
}

// Fixture 7: the case that BYPASSED the guard (web-uplift-rt1y). Same fixture, but the victim holds EXACTLY
// the bytes of the tracked copy's source, so the pair compares EQUAL: the sync's equality fast path printed
// 'copies identical' and the command exited 0 while the destination was a symlink, so the agreed contract - a
// symlinked destination is refused and the command fails - did not hold on the path that writes nothing. The
// victim was not clobbered in that case, which is exactly why the TEST has to assert the exit status: the
// protection was absent exactly where it looked present, and only the status shows that.
export function testSyncRefusesEqualByteSymlinkDestination() {
  const tracked = TRACKED_COPY_FILES[0];
  const sourceBytes = readFileSync(join(repoRoot, tracked.source), 'utf8');
  const fixtureCase = committedSymlinkFixture({ withGeneratedSurface: true, victimContent: sourceBytes });
  try {
    const output = assertSyncRefusesSymlinkDestination(fixtureCase, 'equal-byte');
    // The bypass's own signature, asserted so a regression cannot pass by merely printing something: with
    // equal bytes the old code reported THIS pair as identical.
    assert(!output.includes(`copies identical: ${tracked.source} == ${tracked.dest}`),
      `the equal-byte pair must be refused BEFORE the equality fast path, so it must not be reported as identical: ${output}`);
  } finally {
    dropSyncFixture(fixtureCase);
  }
}

// Fixture 8 (web-uplift-o7et): the CLI must ASK the shared guard rather than keep its own copy of the walk.
// A source scan cannot prove that - a differently named private walk passes any scan - so this OBSERVES it: a
// module load hook serves a wrapper for install-surface.mjs that records every refusedDestination call to a
// log file, and the real CLI is then driven over a target with a planted destination symlink. The assertion is
// that the guard was INVOKED for the planted path, not merely that a refusal was reported: the harness in
// fixture 4 would still pass if the CLI answered the question locally, which is exactly the defect this bead
// removes. The source scan is the belt, kept because it names the shape that must not come back.
export function testInstallAsksTheSharedSymlinkGuard() {
  const outside = mkdtempSync(join(tmpdir(), 'web-uplift-guard-probe-outside-'));
  const target = mkdtempSync(join(tmpdir(), 'web-uplift-guard-probe-target-'));
  const probeDir = mkdtempSync(join(tmpdir(), 'web-uplift-guard-probe-hook-'));
  try {
    const victim = join(outside, 'victim-manifest.json');
    writeFileSync(victim, 'VICTIM-MANIFEST\n');
    mkdirSync(join(target, '.web-uplift'), { recursive: true });
    const planted = join(target, '.web-uplift', 'manifest.json');
    symlinkSync(victim, planted);

    const log = join(probeDir, 'guard-calls.log');
    const sharedUrl = pathToFileURL(join(repoRoot, 'install-surface.mjs')).href;
    writeFileSync(join(probeDir, 'wrapper.mjs'), [
      `export * from ${JSON.stringify(`${sharedUrl}?probe=1`)};`,
      `import { refusedDestination as real } from ${JSON.stringify(`${sharedUrl}?probe=1`)};`,
      "import { appendFileSync } from 'node:fs';",
      'export function refusedDestination(dst, rootDir) { try { appendFileSync(' + JSON.stringify(log) + ', String(dst) + String.fromCharCode(10)); } catch {} return real(dst, rootDir); }',
      '',
    ].join('\n'));
    writeFileSync(join(probeDir, 'bootstrap.mjs'), [
      "import { registerHooks } from 'node:module';",
      "import { readFileSync } from 'node:fs';",
      `const REAL = ${JSON.stringify(sharedUrl)};`,
      `const WRAPPER = readFileSync(${JSON.stringify(join(probeDir, 'wrapper.mjs'))}, 'utf8');`,
      'registerHooks({ load(url, context, nextLoad) { if (url === REAL) return { format: "module", source: WRAPPER, shortCircuit: true }; return nextLoad(url, context); } });',
      '',
    ].join('\n'));

    const run = spawnSync(process.execPath, [
      '--import', pathToFileURL(join(probeDir, 'bootstrap.mjs')).href,
      join(repoRoot, 'bin/web-uplift.mjs'), 'install', '--agent', 'codex', '--target', target,
    ], { encoding: 'utf8', cwd: repoRoot, timeout: 120000 });
    assert(run.status !== 0,
      `an install that refused a destination must now FAIL (web-uplift-v167), got ${run.status} while the guard was asked: ${run.stdout}${run.stderr}`);
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    assert(calls.includes(planted),
      `the CLI must ASK the shared guard about the planted destination (${planted}), and the probe recorded ${calls.length} call(s): ${JSON.stringify(calls.slice(0, 6))}\n${run.stdout}`);
    assert(run.stdout.includes('manifest.json (symlink)'),
      `the refusal must still be reported to the operator, and reported by the plan rather than swallowed: ${run.stdout}`);
    assert(readFileSync(victim, 'utf8') === 'VICTIM-MANIFEST\n', 'the victim must stay untouched in the probe run');

    const cliSource = readFileSync(join(repoRoot, 'bin/web-uplift.mjs'), 'utf8');
    // Scan the CODE, not the prose: the comment above the adapter deliberately names the walk this bead
    // deleted, and a belt that a comment can trip is a belt that reports the wrong thing - the same lesson
    // the authority-detector guard in tests/credential-redaction.mjs records.
    const cliCode = cliSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(!cliCode.includes('findSymlinkComponent'),
      'the CLI must not define the private component walk again: one implementation, in install-surface.mjs (web-uplift-o7et)');
    assert(!/rel\.split\(\/\[/i.test(cliCode),
      'the CLI must not carry its own component-walk loop: it must ask refusedDestination');
    assert(/refusedDestination/.test(cliCode), 'the CLI must import and call the shared guard');
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(probeDir, { recursive: true, force: true });
  }
}

// THE NAME THE V167 CONTROL COPY IS WRITTEN INTO, inside the shim root. It is RESERVED: the mirror step
// refuses to link an entry of this name, which is what makes the collision impossible rather than unlikely
// (web-uplift-lql5).
export const V167_SCRATCH_ENTRY = '.v167-scratch';

// Compares RESOLVED paths, not lexical ones. A string-prefix check on the path about to be written cannot
// see through a symlink, and not seeing through a symlink is exactly how the first version of this fix
// could have written into the repository: a lexical guard passed while the write traversed a link.
function assertOutsideRepository(resolvedPath, resolvedRoot, what) {
  assert(resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + sep),
    `${what} must not resolve to a path inside the repository: a concurrent suite walking the repository root would find a transient .mjs and fail to read it (web-uplift-lql5), got ${resolvedPath} against root ${resolvedRoot}`);
}

function listTree(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    out.push(rel);
    // Returns an ARRAY. It returned a joined string at first, and `...listTree(...)` then spread it one
    // character at a time, which still compared consistently and so still passed, but made every failure
    // message unreadable.
    if (entry.isDirectory()) out.push(...listTree(join(dir, entry.name), rel));
  }
  return out;
}

// Builds the repo-shaped parent the v167 control copy needs, OUTSIDE the repository it mirrors, and returns
// the directory the copy must be written into. The copy has to sit one level below something where
// '../runner/agents.mjs' and '../install-surface.mjs' resolve to the real files, so the parent is a temp
// directory whose entries are symlinks to the repository's own entries.
//
// WHY THE RESERVED NAME IS LOAD-BEARING: the first version of this fix mirrored EVERY top-level entry and
// then created `<shim>/control`. On a repository containing a directory named `control`, that symlink made
// `<shim>/control` resolve to `<repo>/control`, so mkdirSync and writeFileSync traversed it and wrote the
// control copy INTO the repository while the lexical guard still passed and teardown then unlinked only the
// symlink, leaving the file behind. Skipping the reserved entry removes the doorway; the resolved-path
// guard below is the second line of defence, for the case where a link appears anyway.
export function createControlShim(sourceRoot) {
  const resolvedSource = realpathSync(sourceRoot);
  const shimRoot = mkdtempSync(join(tmpdir(), 'web-uplift-v167-shim-'));
  try {
    for (const entry of readdirSync(sourceRoot)) {
      if (entry === '.git' || entry === V167_SCRATCH_ENTRY) continue;
      symlinkSync(join(sourceRoot, entry), join(shimRoot, entry));
    }
    const controlDir = join(shimRoot, V167_SCRATCH_ENTRY);
    mkdirSync(controlDir, { recursive: true });
    assertOutsideRepository(realpathSync(controlDir), resolvedSource, 'the control directory');
    assertOutsideRepository(realpathSync(shimRoot), resolvedSource, 'the shim root');
    return { shimRoot, controlDir };
  } catch (error) {
    rmSync(shimRoot, { recursive: true, force: true });
    throw error;
  }
}

// Removes a shim without any chance of touching what it points at: each symlink is unlinked first, because
// this tree sits beside the real source and a mistake here would delete the source it mirrors.
export function removeControlShim(shimRoot) {
  for (const entry of readdirSync(shimRoot)) {
    const entryPath = join(shimRoot, entry);
    if (lstatSync(entryPath).isSymbolicLink()) rmSync(entryPath, { force: true });
  }
  rmSync(shimRoot, { recursive: true, force: true });
}

// Fixture 9 (web-uplift-v167): the CONTROL, on the pre-fix decision. The exit status is the half that was
// wrong, and a test that only asserts the new status would pass just as well against code that never had the
// defect - so this runs the SAME fixture against a copy of the CURRENT CLI with the single decision line
// mutated back to the old answer and asserts the OLD outcome: exit 0, and 'Installed' printed over a refused
// destination. That is what makes fixture 4's assertion discriminating rather than merely true. The copy is
// written one level below a shim root so every '../x' import resolves to the very file the real CLI imports,
// and the mutation is asserted to have applied, so this control cannot quietly become a no-op if the source
// moves.
//
// THE SHIM ROOT IS OUTSIDE THE REPOSITORY (web-uplift-lql5). It used to be the repository root itself:
// this fixture wrote `.v167-control-${pid}/web-uplift.mjs` INTO repoRoot and removed it in the finally
// below. At --test-concurrency=6 that raced tests/syntax-core.test.mjs, which walks repoRoot via listFiles
// looking for *.mjs; the walk would find the transient file and then get ENOENT reading it once this
// finally had removed it, failing testSyntaxChecks. A real gate went red on it. The shim root built by
// createControlShim keeps every '../x' import resolving to the real file while never writing into the
// repository.
export function testInstallIncompleteExitControl() {
  const outside = mkdtempSync(join(tmpdir(), 'web-uplift-v167-control-outside-'));
  const target = mkdtempSync(join(tmpdir(), 'web-uplift-v167-control-target-'));
  const { shimRoot, controlDir } = createControlShim(repoRoot);
  try {
    const source = readFileSync(join(repoRoot, 'bin', 'web-uplift.mjs'), 'utf8');
    const mutated = source.replace('  return refusedDestinationCount > 0;', '  return false; // PRE-FIX CONTROL');
    assert(mutated !== source,
      'the control must mutate the decision line; if the source moved, this control is a no-op and must fail loudly rather than pass vacuously');
    const controlCli = join(controlDir, 'web-uplift.mjs');
    writeFileSync(controlCli, mutated);

    const victim = join(outside, 'victim-manifest.json');
    writeFileSync(victim, 'VICTIM-MANIFEST\n');
    mkdirSync(join(target, '.web-uplift'), { recursive: true });
    symlinkSync(victim, join(target, '.web-uplift', 'manifest.json'));

    const run = spawnSync(process.execPath, [controlCli, 'install', '--agent', 'codex', '--target', target], { encoding: 'utf8', cwd: repoRoot });
    assert(run.status === 0,
      `control: the PRE-FIX decision must exit 0 on this fixture, or fixture 4's assertion is not about the fix: ${run.stdout}${run.stderr}`);
    assert(/^Installed\./m.test(run.stdout),
      `control: the pre-fix decision printed 'Installed' over a refused destination, which is exactly the defect the fix removes: ${run.stdout}`);
    assert(run.stdout.includes('manifest.json (symlink)'),
      `control: and it still reported the skip, so the defect was the status rather than a silent refusal: ${run.stdout}`);
    assert(readFileSync(victim, 'utf8') === 'VICTIM-MANIFEST\n',
      'the control run must leave the victim untouched too: the refusal was never the broken half, the exit status was');
  } finally {
    removeControlShim(shimRoot);
    rmSync(outside, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

// THE REGRESSION CONTROL FOR THE SHIM ITSELF (web-uplift-lql5). A guard that compares the STRING PREFIX of
// the path it is about to write cannot see through a symlink, which is exactly how the first version of the
// shim fix could have written into the repository it was supposed to stay out of: the mirror step linked
// every top-level entry, so a repository directory sharing the scratch entry's name made the scratch path a
// link back into the repository. This builds a DISPOSABLE repository root that contains such a directory,
// runs the same construction against it, and asserts the repository gained nothing, kept everything, and
// that teardown leaves nothing behind. It is a case rather than a note because it has to keep failing if
// anyone reinstates the blanket mirror or a lexical guard.
export function testV167ControlShimNeverWritesIntoTheRepository() {
  const synthetic = mkdtempSync(join(tmpdir(), 'web-uplift-v167-synthetic-repo-'));
  const colliding = join(synthetic, V167_SCRATCH_ENTRY);
  mkdirSync(colliding, { recursive: true });
  writeFileSync(join(colliding, 'sentinel.txt'), 'SENTINEL\n');
  mkdirSync(join(synthetic, 'bin'), { recursive: true });
  writeFileSync(join(synthetic, 'bin', 'web-uplift.mjs'), '// synthetic source\n');
  const before = listTree(synthetic).join('\n');
  let shimRoot = null;
  try {
    const shim = createControlShim(synthetic);
    shimRoot = shim.shimRoot;
    // The write that this fixture performs on the real repository, done here against the disposable one.
    writeFileSync(join(shim.controlDir, 'web-uplift.mjs'), '// control copy\n');
    assert(listTree(synthetic).join('\n') === before,
      `the shim must not write into the repository it mirrors, even when that repository has an entry named ${V167_SCRATCH_ENTRY} (web-uplift-lql5): before=${JSON.stringify(before)} after=${JSON.stringify(listTree(synthetic).join('\n'))}`);
    assert(readFileSync(join(colliding, 'sentinel.txt'), 'utf8') === 'SENTINEL\n',
      'the colliding repository directory must be untouched');
    // And the shim must still do its job: a fix that stopped mirroring would pass everything above.
    assert(existsSync(join(shimRoot, 'bin', 'web-uplift.mjs')),
      'the shim must still mirror the entries the control copy imports through, or the fix traded a collision for a broken control');
    assert(!lstatSync(shim.controlDir).isSymbolicLink(), 'the scratch directory must be a real directory, not a link');
    removeControlShim(shimRoot);
    assert(!existsSync(shimRoot), 'teardown must remove the shim root');
    assert(listTree(synthetic).join('\n') === before,
      `teardown must leave the mirrored repository exactly as it was (web-uplift-lql5): before=${JSON.stringify(before)} after=${JSON.stringify(listTree(synthetic).join('\n'))}`);
  } finally {
    if (shimRoot && existsSync(shimRoot)) removeControlShim(shimRoot);
    rmSync(synthetic, { recursive: true, force: true });
  }
}

// Fixture 10 (web-uplift-arpp): every DESTINATION refusal carries the marker the exit decision counts, and the
// only pushes that do not are the two skips that are NOT refusals.
//
// THIS TEST IS STRUCTURAL, NOT BEHAVIOURAL, and that is stated here so no reviewer mistakes it for end-to-end
// evidence. The site it pins - copyDir's copy of a file whose destination is swapped for a symlink between
// copyDir's own lstat and safeCopyFileSync's re-lstat/open - is race-only and cannot be driven from outside the
// process without inventing a production seam for the test's benefit, which is a worse trade than an honest
// structural assertion. The non-race path is covered end-to-end by fixture 4, which plants five destination
// symlinks and asserts the non-zero status, the absence of the success line and byte-identical victims.
//
// The invariant is the CLASS rather than the one line: a push that records "a destination was refused" must be
// marked, and the only unmarked pushes must be the two that are legitimately not refusals - a source symlink
// (the vendored tree simply has no symlinked sources, so skipping one is normal) and the source-tree depth
// limit. That is what catches a new unmarked site, which is precisely how web-uplift-arpp was filed.
export function testEveryDestinationRefusalCarriesTheMarker() {
  const cliSource = readFileSync(join(repoRoot, 'bin', 'web-uplift.mjs'), 'utf8');
  const pushes = [...cliSource.matchAll(/skippedFiles\.push\(\{([^}]*)\}\)/g)].map((m) => m[1].trim());
  assert(pushes.length >= 10, `the scan expected the CLI's skip pushes and found ${pushes.length}: it must be reading the file it thinks it is`);

  const unmarked = pushes.filter((body) => !body.includes('refused: true'));
  assert(unmarked.length === 2,
    `exactly two skip pushes may omit refused: true - a source symlink and the depth limit - and ${unmarked.length} do: ${JSON.stringify(unmarked)}. An unmarked DESTINATION refusal makes the CLI exit 0 with 'Installed' over a destination it refused (web-uplift-arpp)`);
  assert(unmarked.some((b) => /reason: 'depth-limit'/.test(b)),
    `the depth limit is a source-tree property rather than a destination refusal, so it must stay unmarked: ${JSON.stringify(unmarked)}`);
  assert(unmarked.some((b) => /path: src\b/.test(b) && /reason: 'symlink'/.test(b)),
    `a skipped SOURCE symlink is normal and must stay unmarked, or an ordinary install would fail: ${JSON.stringify(unmarked)}`);

  // Every safe* result is a destination refusal by construction (each returns 'symlink' only when the
  // destination is one), so every push of one must be marked - the rule the one gap violated.
  const resultPushes = pushes.filter((body) => body.includes('reason: res.reason'));
  assert(resultPushes.length >= 4, `expected the four safe* result pushes (three in applyStep, one in copyDir), found ${resultPushes.length}`);
  for (const body of resultPushes) {
    assert(body.includes('refused: true'),
      `a safe* refusal is a refused DESTINATION and must be counted: ${body}`);
  }
}

// Run directly (node tests/install-copy-symlink.mjs), not when imported by the
// regression suite, which calls the exported functions itself.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  testInstallSkipsSymlinksInVendoredSource();
  testInstallCopyDepthGuard();
  testInstallVendorsCompleteClosure();
  testInstallRefusesDestinationSymlinks();
  testInstallNormalDestinationWrites();
  testGenerateVendoredSurfaceRefusesDestinationSymlinks();
  testSyncRefusesCommittedSymlinkDestination();
  testSyncRefusesEqualByteSymlinkDestination();
  testInstallAsksTheSharedSymlinkGuard();
  testInstallIncompleteExitControl();
  testV167ControlShimNeverWritesIntoTheRepository();
  testEveryDestinationRefusalCarriesTheMarker();
  console.log('tests OK');
}

// Fixture 7: the generator must keep every path a reader could have listed READABLE across a republish
// (web-uplift-c6i1). The old generator deleted each destination directory whole and recopied it, so a reader
// that listed a path and then read it - which is exactly what the syntax census does to this repository -
// could hold a path that no longer existed. These cases use the census's OWN walk (listFiles from
// tests/test-helpers.mjs, which skips .git/node_modules/reports/scratch) so they measure the reader's view
// rather than an easier one, and they drive the two publish phases step by step instead of racing a timer, so
// the result is deterministic rather than a rate.
export function testGenerateVendoredSurfaceKeepsListedPathsReadable() {
  const target = mkdtempSync(join(tmpdir(), 'web-uplift-republish-target-'));
  const put = (rel, content) => {
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    writeFileSync(join(target, rel), content);
  };
  try {
    put('evidence/a.mjs', '// a1\n');
    put('evidence/b.mjs', '// b1\n');
    put('runner/x.mjs', '// x1\n');
    put('knowledge/baseline.mjs', '// baseline1\n');

    let run = runVendoredSurfaceGenerator(target);
    assert(run.status === 0, `initial generation over an empty tree must succeed:\n${run.stderr || run.stdout}`);
    const vendorRoot = join(target, '.web-uplift');
    const listed = listFiles(vendorRoot, (p) => p.endsWith('.mjs'));
    assert(listed.length === 4, `the census walk must see the four generated modules, saw ${listed.length}: ${listed.join(', ')}`);
    // The staging tree must be invisible to the census's OWN walk, asserted on the walk's output rather than
    // read off the skip list: a fix that widened the population would trade one silent change for another.
    assert(listed.every((p) => !p.includes(`${sep}scratch${sep}`)), 'the census walk must not see the staging tree');

    // One stable path changes, one stays identical, one is added, one source is removed.
    put('evidence/a.mjs', '// a2 changed bytes\n');
    put('evidence/c.mjs', '// c1 added\n');
    rmSync(join(target, 'runner', 'x.mjs'));

    run = runVendoredSurfaceGenerator(target);
    assert(run.status === 0, `republishing over a populated tree must succeed:\n${run.stderr || run.stdout}`);

    const lost = [];
    for (const path of listed) {
      if (relative(vendorRoot, path) === 'runner/x.mjs') continue; // its SOURCE was removed: reconciliation, not a hole
      try {
        readFileSync(path, 'utf8');
      } catch (err) {
        lost.push(`${relative(vendorRoot, path)} (${err.code || err.message})`);
      }
    }
    assert(lost.length === 0, `a path the reader had listed must not vanish across a republish: ${lost.join(', ')}`);
    assert(readFileSync(join(vendorRoot, 'evidence/a.mjs'), 'utf8') === '// a2 changed bytes\n', 'a stable path must hold the new bytes after publish, not stale ones');
    assert(readFileSync(join(vendorRoot, 'evidence/b.mjs'), 'utf8') === '// b1\n', 'an unchanged path must still hold its bytes');
    assert(existsSync(join(vendorRoot, 'evidence/c.mjs')), 'a newly added source must be published');
    assert(!existsSync(join(vendorRoot, 'runner/x.mjs')), 'a removed source must be reconciled after the new content is present');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

// The control for the case above, and it stays in the suite: it reproduces the OLD algorithm's window (delete
// the destination directory whole, then recopy it) and asserts the SAME list-then-read loop detects it.
// Without this, a green above could mean the instrument never reads anything.
export function testRepublishReaderInstrumentDetectsDeleteThenCopy() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-republish-control-'));
  try {
    const src = join(root, 'src');
    const dst = join(root, 'dst');
    mkdirSync(src, { recursive: true });
    for (const name of ['a.mjs', 'b.mjs', 'c.mjs']) writeFileSync(join(src, name), `// ${name}\n`);
    cpSync(src, dst, { recursive: true });
    const listed = listFiles(dst, (p) => p.endsWith('.mjs'));
    assert(listed.length === 3, `the control fixture must list its three modules, saw ${listed.length}`);
    // The delete half and the copy half are driven SEPARATELY, because a single sequential delete-then-copy
    // cannot be caught: the recopy restores every path before the read happens. The hole is a WINDOW, and that
    // is exactly why the real defect needed a concurrent reader rather than a slower one.
    rmSync(dst, { recursive: true, force: true });
    const absent = listed.filter((p) => !existsSync(p));
    cpSync(src, dst, { recursive: true });
    assert(absent.length === listed.length, `the delete-then-copy window must make listed paths absent (saw ${absent.length} of ${listed.length})`);
    assert(listed.every((p) => existsSync(p)), 'the copy half restores the paths, which is what makes the hole transient rather than a permanent loss');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Fixture 8: the ORDER is the property, and it is driven directly here rather than raced. Publish first,
// prune obsolete entries after, so the worst a reader can observe is stale content, never a hole
// (web-uplift-c6i1). The two phases are exported for exactly this: a single function would leave the order
// untestable except by racing it, which the acceptance criteria rule out.
export async function testPublishOrderLeavesObsoleteEntriesUntilAfterPublish() {
  // Imported HERE rather than at module scope (web-uplift-ckly): if the fix is reverted these two exports are
  // gone, and a module-scope import would take the whole suite down with an ESM error before any case ran. This
  // way each case fails on its own terms - this one with a missing export, the interleaving case below
  // behaviourally, with the ENOENT the revert reintroduces.
  const { publishStagedTree, pruneObsoleteEntries } = await import('../install-surface.mjs');
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-publish-order-'));
  const put = (dir, rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  try {
    const staged = join(root, 'staged');
    const dest = join(root, 'dest');
    put(staged, 'keep.mjs', '// new\n');
    put(staged, 'nested/added.mjs', '// added\n');
    mkdirSync(join(staged, 'emptydir'), { recursive: true });
    put(dest, 'keep.mjs', '// old\n');
    put(dest, 'obsolete.mjs', '// obsolete\n');
    put(dest, 'nested/old-only.mjs', '// old only\n');

    const published = publishStagedTree(staged, dest);
    assert(existsSync(join(dest, 'obsolete.mjs')), 'an obsolete entry must still exist after the publish phase; only prune removes it');
    assert(existsSync(join(dest, 'nested/old-only.mjs')), 'an obsolete entry below a surviving directory must also survive publish');
    assert(readFileSync(join(dest, 'keep.mjs'), 'utf8') === '// new\n', 'a stable path must hold the new bytes before prune runs');
    assert(existsSync(join(dest, 'nested/added.mjs')), 'a new entry must be published');
    assert(existsSync(join(dest, 'emptydir')), 'an empty source directory must be created, as copyDir created it');

    pruneObsoleteEntries(dest, published);
    assert(!existsSync(join(dest, 'obsolete.mjs')), 'prune must remove an obsolete file');
    assert(!existsSync(join(dest, 'nested/old-only.mjs')), 'prune must remove an obsolete file below a surviving directory');
    assert(existsSync(join(dest, 'keep.mjs')) && existsSync(join(dest, 'nested/added.mjs')), 'prune must not remove published content');
    assert(existsSync(join(dest, 'emptydir')), 'prune must not remove an empty directory the new content declares');

    // A destination FILE where the source now has a DIRECTORY, and the reverse. The old delete-then-recopy
    // handled these by accident; a rename cannot cross types, so they are explicit transitions.
    put(staged, 'swap/inner.mjs', '// inner\n');
    writeFileSync(join(dest, 'swap'), 'was a file\n');
    publishStagedTree(staged, dest);
    assert(lstatSync(join(dest, 'swap')).isDirectory() && existsSync(join(dest, 'swap', 'inner.mjs')), 'a source directory replacing a destination file must be published as a directory');

    put(staged, 'gone.mjs', '// now a file\n');
    mkdirSync(join(dest, 'gone.mjs'), { recursive: true });
    writeFileSync(join(dest, 'gone.mjs', 'inner.mjs'), '// inner\n');
    publishStagedTree(staged, dest);
    assert(lstatSync(join(dest, 'gone.mjs')).isFile(), 'a source file replacing a destination directory must be published as a file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Fixture 9: the interleaving fixture of web-uplift-ckly, and the reason it exists as well as fixture 7. Every
// read in the cases above happens AFTER generation returns, so on the old delete-then-recopy generator the paths
// exist again by the time the case reads them and it still passes. This one keeps a reader running WHILE the
// real generator republishes a populated tree, which is the event the acceptance criteria name. The reader is a
// worker thread, so it reads on a second thread while the synchronous generator runs on this one, and it keeps
// the census's own skip list so it cannot see the staging tree. Reverting the fix must make THIS case fail, with
// the vanished path printed rather than only a count.
export async function testRepublishKeepsListedPathsReadableForAConcurrentReader() {
  const target = mkdtempSync(join(tmpdir(), 'web-uplift-republish-concurrent-'));
  const put = (rel, content) => {
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    writeFileSync(join(target, rel), content);
  };
  let worker;
  let readyTimer;
  try {
    for (const dir of ['evidence', 'runner', 'schema']) {
      for (let i = 0; i < 4; i++) put(`${dir}/m${i}.mjs`, `// ${dir} ${i} v1\n`);
    }
    generateVendoredSurface({ targetRoot: target });
    const vendorRoot = join(target, '.web-uplift');

    worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { existsSync, lstatSync, readdirSync, readFileSync } = require('node:fs');
      const { join } = require('node:path');
      const SKIP = new Set(['scratch', 'node_modules', 'reports', '.git']);
      const root = workerData.root;
      let reads = 0, enoent = 0, lists = 0, announced = false;
      const vanished = [];
      const walk = (dir, out = []) => {
        for (const name of readdirSync(dir)) {
          if (SKIP.has(name)) continue;
          const full = join(dir, name);
          let st;
          try { st = lstatSync(full); } catch { continue; }
          if (st.isDirectory()) walk(full, out); else out.push(full);
        }
        return out;
      };
      parentPort.on('message', (m) => {
        if (m === 'stop') parentPort.postMessage({ reads, enoent, lists, vanished: vanished.slice(0, 6) });
      });
      const tick = () => {
        if (existsSync(root)) {
          let listed = [];
          try { listed = walk(root); } catch { listed = []; }
          if (listed.length > 0) {
            lists++;
            for (const f of listed) {
              reads++;
              try { readFileSync(f); } catch (err) {
                if (err.code === 'ENOENT') { enoent++; if (vanished.length < 6) vanished.push(f.slice(root.length + 1)); }
              }
            }
            if (!announced) { announced = true; parentPort.postMessage('ready'); }
          }
        }
        setImmediate(tick);
      };
      tick();
    `, { eval: true, workerData: { root: vendorRoot } });

    // Wait for the reader to be genuinely looping before republishing, so the window is not missed because the
    // worker had not started. The timeout is a failure, not a skip: a reader that never reads cannot certify this.
    await Promise.race([
      new Promise((resolve) => worker.once('message', () => resolve(true))),
      new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('the reader never listed the tree')), 10000); }),
    ]);
    clearTimeout(readyTimer); // or the pending timer keeps the runner alive for its full 10s after the case passes
    const stopped = new Promise((resolve) => worker.once('message', resolve));

    // Twelve republishes: at a single republish the unfixed generator reports ENOENT in most runs, so this makes
    // a missed window improbable rather than merely unlikely, while a fixed generator has no window to hit.
    for (let i = 0; i < 12; i++) {
      for (const dir of ['evidence', 'runner', 'schema']) {
        for (let k = 0; k < 4; k++) put(`${dir}/m${k}.mjs`, `// ${dir} ${k} v${i + 2}\n`);
      }
      generateVendoredSurface({ targetRoot: target });
    }
    worker.postMessage('stop');
    const report = await stopped;
    assert(report.reads > 50, `the reader must actually have read the tree, saw ${report.reads} reads over ${report.lists} listings`);
    assert(report.enoent === 0, `a reader running during a republish must not see a path vanish; ${report.enoent} of ${report.reads} reads failed with ENOENT, vanished: ${JSON.stringify(report.vanished)}`);
    console.log(`concurrent republish OK: ${report.reads} list-then-read cycles over ${report.lists} listings, ENOENT 0, vanished []`);

    // Post-conditions, so "publish nothing" cannot satisfy the assertion above: the last write wins and the tree
    // is whole afterwards.
    assert(listFiles(vendorRoot, (p) => p.endsWith('.mjs')).length === 12, 'every module must be present after the republishes');
    assert(readFileSync(join(vendorRoot, 'evidence', 'm0.mjs'), 'utf8') === '// evidence 0 v13\n', 'the published tree must hold the last written bytes');
  } finally {
    clearTimeout(readyTimer);
    if (worker) await worker.terminate();
    rmSync(target, { recursive: true, force: true });
  }
}
