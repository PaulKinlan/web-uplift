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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VENDORED_DEPENDENCIES } from '../install-surface.mjs';

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
    assert(install.status === 0, `install with destination symlinks failed:\n${install.stderr || install.stdout}`);

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

// Run directly (node tests/install-copy-symlink.mjs), not when imported by the
// regression suite, which calls the exported functions itself.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  testInstallSkipsSymlinksInVendoredSource();
  testInstallCopyDepthGuard();
  testInstallVendorsCompleteClosure();
  testInstallRefusesDestinationSymlinks();
  testInstallNormalDestinationWrites();
  testGenerateVendoredSurfaceRefusesDestinationSymlinks();
  console.log('tests OK');
}
