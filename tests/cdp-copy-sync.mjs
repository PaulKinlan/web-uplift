#!/usr/bin/env node
// WHY the vendored copies must match: `web-uplift install` copies the evidence
// CLIs, the scorecard/compare/aggregate scripts, the flow runner, the canonical
// skill, the knowledge files and the schemas into a consumer project's
// .web-uplift/ tree (the copy-dir / copy-file steps in bin/web-uplift.mjs), and
// this repo keeps that installed tree in-repo so an in-session agent can call
// .web-uplift/evidence/cli.mjs directly. Nothing regenerates it automatically,
// so an edit to a source file that forgets the vendored copy (or vice versa)
// silently ships a stale launcher, schema, knowledge file or skill. This guard
// fails on any byte difference, or a file present on only one side, between
// each source and its vendored copy.
//
// The filename is historical: it started as a single evidence/cdp.mjs sync
// check and now covers every in-tree vendored path that `web-uplift install`
// copies byte-for-byte. `manifest.json` is WRITTEN (not copied) at install time
// with a fresh timestamp, and `.web-uplift/node_modules/` is copied from
// installed dependencies at install time, so neither is a byte-identical
// in-tree pair and both are deliberately out of scope here.
//
// Usage: node tests/cdp-copy-sync.mjs
// Exit 0 when every pair is identical, 1 when any differ or one side is missing.
// Node builtins only: no npm install is needed to run it.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths resolve from this file, never from cwd, so the guard gives the same
// answer whether CI or a human runs it from anywhere in the tree.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_DIFF_LINES = 40;
const DIFF_CONTEXT = 3;

// copy-dir steps in bin/web-uplift.mjs: the whole source directory is vendored,
// so the guard compares the full recursive trees (including missing entries).
const COPY_DIRS = [
  ['evidence', '.web-uplift/evidence'],
  ['aggregate', '.web-uplift/aggregate'],
  ['runner', '.web-uplift/runner'],
  ['schema', '.web-uplift/schema'],
];

// copy-file steps in bin/web-uplift.mjs: only these specific files are vendored.
// knowledge/ may hold other files that install does NOT copy, so it is listed
// file-by-file rather than as a copy-dir.
const COPY_FILES = [
  ['knowledge/principles.json', '.web-uplift/knowledge/principles.json'],
  ['knowledge/baseline.mjs', '.web-uplift/knowledge/baseline.mjs'],
  ['knowledge/guidance.md', '.web-uplift/knowledge/guidance.md'],
  ['.claude/skills/web-audit/SKILL.md', '.web-uplift/skill/SKILL.md'],
];

const pairs = buildPairs();
const failures = [];
let identical = 0;

for (const pair of pairs) {
  const source = readCopy(pair.srcAbs);
  const vendored = readCopy(pair.dstAbs);

  if (source && vendored && sameBytes(source.bytes, vendored.bytes)) {
    identical++;
    console.log(
      `${pair.srcRel} copies identical: ${pair.srcRel} == ${pair.dstRel} (sha256 ${source.sha}, ${source.bytes.length} bytes)`,
    );
    continue;
  }

  failures.push(pair);
  const lines = [];
  if (!source && !vendored) {
    lines.push(`vendored copy is missing on both sides: ${pair.srcRel} and ${pair.dstRel}`);
  } else if (!source) {
    lines.push(`vendored copy has drifted: source is missing (${pair.srcRel} -> ${pair.dstRel})`);
    lines.push(`  ${pair.srcRel.padEnd(40)} <missing>`);
    lines.push(`  ${pair.dstRel.padEnd(40)} sha256 ${vendored.sha}  ${vendored.bytes.length} bytes`);
  } else if (!vendored) {
    lines.push(`vendored copy has drifted: vendored copy is missing (${pair.srcRel} -> ${pair.dstRel})`);
    lines.push(`  ${pair.srcRel.padEnd(40)} sha256 ${source.sha}  ${source.bytes.length} bytes`);
    lines.push(`  ${pair.dstRel.padEnd(40)} <missing>`);
  } else {
    lines.push(`vendored copy has drifted from its source (${pair.srcRel} -> ${pair.dstRel})`);
    lines.push(`  ${pair.srcRel.padEnd(40)} sha256 ${source.sha}  ${source.bytes.length} bytes`);
    lines.push(`  ${pair.dstRel.padEnd(40)} sha256 ${vendored.sha}  ${vendored.bytes.length} bytes`);
    const diff = unifiedDiff(source.text.split('\n'), vendored.text.split('\n'), pair.srcRel, pair.dstRel);
    const shown = diff.slice(0, MAX_DIFF_LINES);
    lines.push(...shown);
    if (shown.length < diff.length) {
      lines.push(`... ${diff.length - shown.length} more diff lines suppressed`);
    }
  }
  for (const line of lines) console.error(`FAIL: ${line}`);
}

if (failures.length === 0) {
  console.log(`all ${pairs.length} vendored copies identical`);
  process.exit(0);
}

console.error(`FAIL: ${failures.length} of ${pairs.length} vendored copies have drifted`);
console.error('Resync the vendored tree with: node bin/web-uplift.mjs install --agent all');
process.exit(1);

// Turns the copy-dir / copy-file mappings above into a flat, deterministic list
// of { srcRel, dstRel, srcAbs, dstAbs }. srcAbs/dstAbs are null when that side
// is absent (a file the other side has but this one does not).
function buildPairs() {
  const out = [];
  for (const [src, dst] of COPY_FILES) {
    out.push({
      srcRel: src,
      dstRel: dst,
      srcAbs: join(repoRoot, src),
      dstAbs: join(repoRoot, dst),
    });
  }
  for (const [srcDir, dstDir] of COPY_DIRS) {
    const srcFiles = walkDir(join(repoRoot, srcDir));
    const dstFiles = walkDir(join(repoRoot, dstDir));
    const rels = [...new Set([...srcFiles.keys(), ...dstFiles.keys()])].sort();
    for (const relPath of rels) {
      out.push({
        srcRel: join(srcDir, relPath),
        dstRel: join(dstDir, relPath),
        srcAbs: srcFiles.get(relPath) ?? null,
        dstAbs: dstFiles.get(relPath) ?? null,
      });
    }
  }
  return out;
}

// Returns a Map of repo-relative file path -> absolute path for every regular
// file under `dir`, recursing like bin/web-uplift.mjs copyDir(). An empty map
// means the directory does not exist (or holds no files).
function walkDir(dir) {
  const files = new Map();
  if (!existsSync(dir)) return files;
  const visit = (current, relPrefix) => {
    for (const name of readdirSync(current)) {
      const abs = join(current, name);
      const relPath = relPrefix ? join(relPrefix, name) : name;
      if (statSync(abs).isDirectory()) visit(abs, relPath);
      else files.set(relPath, abs);
    }
  };
  visit(dir, '');
  return files;
}

// Returns null when the file cannot be read, so a deleted vendored copy is
// reported as drift instead of throwing a raw ENOENT at the reader.
function readCopy(file) {
  if (!file) return null;
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

// A minimal unified diff (DIFF_CONTEXT lines of context) built from an LCS over
// lines. Hunk headers and bodies match GNU `diff -u` in the normal case, but on
// ambiguous inputs (duplicate or similar lines) this small LCS tie-break can
// order those body lines differently from GNU's Myers algorithm; it never
// changes the pass/fail verdict, the sha256 hashes or the byte sizes. The
// vendored files are a few hundred lines, so the O(n*m) table is free and the
// guard stays dependency-free.
function unifiedDiff(a, b, srcLabel, dstLabel) {
  const lcs = lcsTable(a, b);
  const ops = walkLcs(lcs, a, b);
  const out = [`--- ${srcLabel}`, `+++ ${dstLabel}`];

  for (const [from, to] of hunkRanges(ops)) {
    const aStart = nearestLine(ops, from, to, 'aLine');
    const bStart = nearestLine(ops, from, to, 'bLine');
    let aCount = 0;
    let bCount = 0;
    for (let k = from; k <= to; k++) {
      if (ops[k].sign !== '+') aCount++;
      if (ops[k].sign !== '-') bCount++;
    }
    out.push(`@@ -${rangeLabel(aStart, aCount)} +${rangeLabel(bStart, bCount)} @@`);
    for (let k = from; k <= to; k++) out.push(`${ops[k].sign}${ops[k].text}`);
  }
  return out;
}

// GNU `diff -u` writes a hunk range as `-start,count`, dropping the `,count`
// when the count is exactly 1 (`-start`), which is the common single-line case.
function rangeLabel(start, count) {
  return count === 1 ? `${start}` : `${start},${count}`;
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
