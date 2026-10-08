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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Run directly (node tests/install-copy-symlink.mjs), not when imported by the
// regression suite, which calls the exported functions itself.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  testInstallSkipsSymlinksInVendoredSource();
  testInstallCopyDepthGuard();
  testInstallVendorsCompleteClosure();
  console.log('tests OK');
}
