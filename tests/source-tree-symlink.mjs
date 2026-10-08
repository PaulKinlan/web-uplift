#!/usr/bin/env node
// Focused guard for the source-tree symlink escape (web-uplift-etp).
//
// readSourceTree used to classify entries with statSync, which FOLLOWS symlinks
// after checking only the link's own base name. An innocuous-named symlink with
// a text extension (notes.txt -> ~/.ssh/id_rsa) was therefore read and inlined
// into evidence, and a symlink to a directory (vendor -> /etc) made
// st.isDirectory() true so the walk recursed out of the --source tree with no
// depth or cycle guard. The fix is lstatSync plus skipping every symlink
// outright (recorded in skippedFiles with reason 'symlink') and a depth guard so
// a cycle that somehow survives is a recorded refusal, not unbounded recursion.
//
// This file is the fast, browser-free foreground check. Run it directly:
//   node tests/source-tree-symlink.mjs
// It is also imported by tests/regression.mjs so the full gate covers it.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSourceTree } from '../evidence/cli.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Fixture 1: symlink FILE escape. An innocuous name with a text extension
// pointing at a secret OUTSIDE the source tree must not be read.
export function testSourceTreeSkipsSymlinkFileEscape() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-symlink-file-'));
  const outside = mkdtempSync(join(tmpdir(), 'web-uplift-symlink-file-outside-'));
  try {
    const secret = 'AKIA' + 'SYMLINKFILEESCAPE';
    const outsideSecret = join(outside, 'id_rsa');
    writeFileSync(outsideSecret, `-----BEGIN OPENSSH PRIVATE KEY-----\n${secret}\n-----END OPENSSH PRIVATE KEY-----\n`);
    symlinkSync(outsideSecret, join(root, 'notes.txt'));

    const tree = readSourceTree(root);
    const serialised = JSON.stringify(tree);
    assert(!serialised.includes(secret), `a symlink file escape must not inline the target secret: ${serialised.slice(0, 200)}`);
    assert(
      !tree.files.some((f) => f.path === 'notes.txt'),
      `the symlink FILE must not be read: ${JSON.stringify(tree.files.map((f) => f.path))}`,
    );
    const symlinkSkips = tree.skippedFiles.filter((s) => s.reason === 'symlink').map((s) => s.path);
    assert(symlinkSkips.includes('notes.txt'), `the symlink FILE must be recorded, not followed: ${JSON.stringify(symlinkSkips)}`);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

// Fixture 2: symlink DIR escape. A directory symlink pointing OUTSIDE the tree
// must not be recursed (a following walk would inline everything under it).
export function testSourceTreeSkipsSymlinkDirEscape() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-symlink-dir-'));
  const outside = mkdtempSync(join(tmpdir(), 'web-uplift-symlink-dir-outside-'));
  try {
    const secret = 'AKIA' + 'SYMLINKDIRESCAPE';
    const vendorDir = join(outside, 'vendor-src');
    mkdirSync(vendorDir, { recursive: true });
    writeFileSync(join(vendorDir, 'db-passwords.txt'), `password=${secret}\n`);
    symlinkSync(vendorDir, join(root, 'vendor'), 'dir');

    const tree = readSourceTree(root);
    const serialised = JSON.stringify(tree);
    assert(!serialised.includes(secret), `a symlink dir escape must not inline the target contents: ${serialised.slice(0, 200)}`);
    assert(
      !tree.files.some((f) => f.path.startsWith('vendor')),
      `the symlink DIR must not be recursed: ${JSON.stringify(tree.files.map((f) => f.path))}`,
    );
    const symlinkSkips = tree.skippedFiles.filter((s) => s.reason === 'symlink').map((s) => s.path);
    assert(symlinkSkips.includes('vendor'), `the symlink DIR must be recorded, not followed: ${JSON.stringify(symlinkSkips)}`);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

// Fixture 3: symlink cycle. A self-referential link must be a recorded refusal,
// not a thrown ELOOP (the old statSync path) or an unbounded recursion.
export function testSourceTreeSkipsSymlinkCycle() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-symlink-cycle-'));
  try {
    symlinkSync('loop', join(root, 'loop'));

    let tree;
    let thrown = null;
    try {
      tree = readSourceTree(root);
    } catch (error) {
      thrown = error;
    }
    assert(thrown === null, `a symlink cycle must be a recorded refusal, not a thrown error: ${thrown ? thrown.message : ''}`);
    const symlinkSkips = tree.skippedFiles.filter((s) => s.reason === 'symlink').map((s) => s.path);
    assert(symlinkSkips.includes('loop'), `the symlink cycle must be recorded, not followed: ${JSON.stringify(symlinkSkips)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The depth guard that backs the symlink skip: a path deeper than the limit is
// refused with reason 'depth-limit', never recursed unboundedly.
export function testSourceTreeDepthGuard() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-symlink-depth-'));
  try {
    let dir = root;
    for (let i = 0; i < 70; i++) {
      dir = join(dir, 'd');
      mkdirSync(dir);
    }
    writeFileSync(join(dir, 'leaf.txt'), 'leaf\n');

    const tree = readSourceTree(root);
    const depthSkips = tree.skippedFiles.filter((s) => s.reason === 'depth-limit').map((s) => s.path);
    assert(depthSkips.length > 0, `an over-deep tree must be refused, not recursed: ${JSON.stringify(depthSkips)}`);
    assert(
      !tree.files.some((f) => f.path.includes('leaf.txt')),
      `nothing past the depth limit may be read: ${JSON.stringify(tree.files.map((f) => f.path))}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Run directly (node tests/source-tree-symlink.mjs), not when imported by the
// regression suite, which calls the exported functions itself.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  testSourceTreeSkipsSymlinkFileEscape();
  testSourceTreeSkipsSymlinkDirEscape();
  testSourceTreeSkipsSymlinkCycle();
  testSourceTreeDepthGuard();
  console.log('tests OK');
}
