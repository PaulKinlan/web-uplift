#!/usr/bin/env node
// WHY the two copies must match: `web-uplift install` copies evidence/ into the
// consumer project's .web-uplift/evidence/ (the copy-dir step in
// bin/web-uplift.mjs), and this repo keeps that installed tree in-repo so an
// in-session agent can call .web-uplift/evidence/cli.mjs directly. Nothing
// regenerates it automatically, so an edit to evidence/cdp.mjs that forgets the
// vendored copy (or vice versa) silently ships a stale launcher. This guard
// fails on any byte difference between the two.
//
// Usage: node tests/cdp-copy-sync.mjs
// Exit 0 when the copies are identical, 1 when they differ or one is missing.
// Node builtins only: no npm install is needed to run it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths resolve from this file, never from cwd, so the guard gives the same
// answer whether CI or a human runs it from anywhere in the tree.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE = join(repoRoot, 'evidence', 'cdp.mjs');
const VENDORED = join(repoRoot, '.web-uplift', 'evidence', 'cdp.mjs');
const MAX_DIFF_LINES = 40;
const DIFF_CONTEXT = 3;

const source = readCopy(SOURCE);
const vendored = readCopy(VENDORED);
const missing = [];
if (!source) missing.push(rel(SOURCE));
if (!vendored) missing.push(rel(VENDORED));

if (missing.length > 0) {
  fail([
    `the vendored cdp.mjs copy is out of sync: missing ${missing.join(' and ')}`,
    'Recreate it with: node bin/web-uplift.mjs install --agent all',
  ]);
}

if (sameBytes(source.bytes, vendored.bytes)) {
  console.log(
    `cdp.mjs copies identical: ${rel(SOURCE)} == ${rel(VENDORED)} (sha256 ${source.sha}, ${source.bytes.length} bytes)`,
  );
  process.exit(0);
}

const diff = unifiedDiff(source.text.split('\n'), vendored.text.split('\n'));
const shown = diff.slice(0, MAX_DIFF_LINES);
fail([
  'the vendored cdp.mjs copy has drifted from its source',
  `  ${rel(SOURCE).padEnd(32)} sha256 ${source.sha}  ${source.bytes.length} bytes`,
  `  ${rel(VENDORED).padEnd(32)} sha256 ${vendored.sha}  ${vendored.bytes.length} bytes`,
  'Resync the vendored tree with: node bin/web-uplift.mjs install --agent all',
  ...shown,
  ...(shown.length < diff.length ? [`... ${diff.length - shown.length} more diff lines suppressed`] : []),
]);

function fail(lines) {
  for (const line of lines) console.error(`FAIL: ${line}`);
  process.exit(1);
}

// Returns null when the file cannot be read, so a deleted vendored copy is
// reported as drift instead of throwing a raw ENOENT at the reader.
function readCopy(file) {
  let bytes;
  try {
    bytes = new Uint8Array(readFileSync(file));
  } catch {
    return null;
  }
  return {
    bytes,
    sha: createHash('sha256').update(bytes).digest('hex'),
    text: new TextDecoder().decode(bytes),
  };
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function rel(file) {
  return relative(repoRoot, file) || file;
}

// A minimal unified diff (DIFF_CONTEXT lines of context) built from an LCS over
// lines. cdp.mjs is a few hundred lines, so the O(n*m) table is free and the
// guard stays dependency-free.
function unifiedDiff(a, b) {
  const lcs = lcsTable(a, b);
  const ops = walkLcs(lcs, a, b);
  const out = [`--- ${rel(SOURCE)}`, `+++ ${rel(VENDORED)}`];
  for (const [from, to] of hunkRanges(ops)) {
    const aStart = nearestLine(ops, from, to, 'aLine');
    const bStart = nearestLine(ops, from, to, 'bLine');
    let aCount = 0;
    let bCount = 0;
    for (let k = from; k <= to; k++) {
      if (ops[k].sign !== '+') aCount++;
      if (ops[k].sign !== '-') bCount++;
    }
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (let k = from; k <= to; k++) out.push(`${ops[k].sign}${ops[k].text}`);
  }
  return out;
}

function lcsTable(a, b) {
  const cols = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * cols + j + 1] + 1
          : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }
  return lcs;
}

// Returns one entry per line: ' ' unchanged, '-' only in the source, '+' only in
// the vendored copy. Each carries its 1-based line number in the file it exists
// in (0 in the other), which is what the @@ headers need.
function walkLcs(lcs, a, b) {
  const cols = b.length + 1;
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ sign: ' ', aLine: i + 1, bLine: j + 1, text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      ops.push({ sign: '-', aLine: i + 1, bLine: 0, text: a[i] });
      i++;
    } else {
      ops.push({ sign: '+', aLine: 0, bLine: j + 1, text: b[j] });
      j++;
    }
  }
  for (; i < a.length; i++) ops.push({ sign: '-', aLine: i + 1, bLine: 0, text: a[i] });
  for (; j < b.length; j++) ops.push({ sign: '+', aLine: 0, bLine: j + 1, text: b[j] });
  return ops;
}

// Group changed lines into [from, to] index ranges padded with context, merging
// two changes whose context windows touch so they share one @@ header.
function hunkRanges(ops) {
  const changed = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].sign !== ' ') changed.push(k);
  }
  const ranges = [];
  for (const change of changed) {
    const from = Math.max(0, change - DIFF_CONTEXT);
    const to = Math.min(ops.length - 1, change + DIFF_CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  return ranges;
}

// A hunk can open on a '+' line (no source number) or a '-' line (no vendored
// number); unified diffs borrow the next line that does have one.
function nearestLine(ops, from, to, key) {
  for (let k = from; k <= to; k++) {
    if (ops[k][key]) return ops[k][key];
  }
  return 0;
}
