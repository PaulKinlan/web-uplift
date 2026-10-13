#!/usr/bin/env node
// WHY the vendored copies must match: `web-uplift install` copies the evidence
// CLIs, the scorecard/compare/aggregate scripts, the flow runner, the canonical
// skill, the knowledge files and the schemas into a consumer project's
// .web-uplift/ tree (the copy-dir / copy-file steps in bin/web-uplift.mjs), and
// this repo generates that installed tree via `node install-surface.mjs` (the npm
// prepare script) so an in-session agent can call .web-uplift/evidence/cli.mjs directly.
// The .web-uplift/ tree is gitignored (web-uplift-diaq). This guard fails on any byte
// difference, or a file present on only one side, between each source and its vendored copy.
//
// The filename is historical: it started as a single evidence/cdp.mjs sync
// check and now covers every in-tree vendored path that `web-uplift install`
// copies byte-for-byte. `manifest.json` is WRITTEN (not copied) at install time
// with a fresh timestamp, and `.web-uplift/node_modules/` is copied from
// installed dependencies at install time, so neither is a byte-identical
// in-tree pair and both are deliberately out of scope here.
//
// Usage: node tests/cdp-copy-sync.mjs [options]
// Exit 0 when every pair is identical, 1 when any differ or one side is missing.
// Node builtins only: no npm install is needed to run it.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDORED_DIRS, VENDORED_FILES, TRACKED_COPY_FILES, generateVendoredSurface, refusedDestination, trackedCopyHasLocalEdits } from '../install-surface.mjs';

// Paths resolve from this file, never from cwd, so the guard gives the same
// answer whether CI or a human runs it from anywhere in the tree.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_DIFF_LINES = 40;
const DIFF_CONTEXT = 3;

const args = process.argv.slice(2);
let syncMode = false;
let fromVendored = false;
let dryRun = false;
let targetRepo = repoRoot;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--sync' || arg === '--write') {
    syncMode = true;
  } else if (arg === '--from-vendored' || arg === '--reverse') {
    fromVendored = true;
    syncMode = true;
  } else if (arg === '--dry-run') {
    dryRun = true;
    syncMode = true;
  } else if (arg === '--repo') {
    if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
      targetRepo = resolve(args[++i]);
    } else {
      console.error('error: missing argument for --repo');
      process.exit(1);
    }
  } else if (arg.startsWith('--repo=')) {
    const val = arg.slice('--repo='.length);
    if (!val) {
      console.error('error: missing value for --repo=');
      process.exit(1);
    }
    targetRepo = resolve(val);
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
Usage: node tests/cdp-copy-sync.mjs [options]

Options:
  --sync, --write          Sync drifted files from canonical source to vendored copies
  --from-vendored          Sync drifted files from vendored copies back to canonical source
  --dry-run                Show what would be synced without writing (exits 1 on drift)
  --repo <dir>             Target repository root (default: current repository)
  --help, -h               Show this help message
`);
    process.exit(0);
  } else {
    console.error(`error: unrecognised argument ${arg}`);
    console.error('Run node tests/cdp-copy-sync.mjs --help for usage.');
    process.exit(1);
  }
}

// copy-dir steps in bin/web-uplift.mjs: the whole source directory is vendored,
// so the guard compares the full recursive trees (including missing entries).
//
// Both lists below are BUILT from install-surface.mjs, which is also what the
// installer reads, so the set the guard compares cannot fall behind the set the
// installer copies. They used to be two hand-maintained lists (web-uplift-7mr).
const COPY_DIRS = VENDORED_DIRS.map((dir) => [dir.source, `.web-uplift/${dir.dest}`]);

// copy-file steps in bin/web-uplift.mjs: only these specific files are vendored.
// knowledge/ may hold other files that install does NOT copy, so it is listed
// file-by-file rather than as a copy-dir. The .pi skill-copy is a real tracked
// copy (the .codex entry is a symlink and .claude is the source itself).
const COPY_FILES = [
  ...VENDORED_FILES.map((file) => [file.source, `.web-uplift/${file.dest}`]),
  ...TRACKED_COPY_FILES.map((file) => [file.source, file.dest]),
];


// Auto-generate .web-uplift/ if absent so fresh worktrees without prior npm install
// do not false-fail on missing vendored directories (web-uplift-diaq).
if (targetRepo === repoRoot && !existsSync(join(targetRepo, '.web-uplift'))) {
  const generated = generateVendoredSurface({ targetRoot: targetRepo }) || {};
  const skipped = generated.skippedTrackedCopies || [];
  const skippedSymlinks = generated.skippedSymlinks || [];
  if (skipped.length > 0) {
    for (const rel of skipped) {
      console.error(`REFUSING to overwrite ${rel}: it is a tracked file with uncommitted local changes, so generating the vendored surface left it alone. Commit, stash or discard that change first.`);
    }
    console.error(`FAILED: ${skipped.length} tracked file(s) were left alone while generating .web-uplift/. Their contents are intact. The vendored tree itself was generated.`);
    process.exit(1);
  }
  // A refusal for a symlinked destination is FATAL here, exactly like the tracked-edits refusal above.
  // This block used to ignore it and carry on, so the generator's 'refusing to write through a symlink'
  // line was printed to stderr and then this script overwrote the victim through the very link it had just
  // refused, exiting 0 - a report that has not refused, only commented (web-uplift-sfbp). The generator's
  // own direct run fails the command the same way, so the two entry points now agree.
  if (skippedSymlinks.length > 0) {
    for (const entry of skippedSymlinks) {
      console.error(`REFUSING to generate ${entry.path}: ${entry.symlinkComponent} is a symlink, so writing the vendored surface would write through it and outside ${targetRepo}.`);
    }
    console.error(`FAILED: ${skippedSymlinks.length} destination(s) were refused while generating .web-uplift/. Nothing was written for those, so the vendored tree is incomplete. Remove or replace the symlink and run again.`);
    process.exit(1);
  }
}

// Only these destinations are tracked by contract; the gitignored .web-uplift/ tree and
// non-repo fixtures are never candidates for this protection.
const TRACKED_DESTS = new Set(TRACKED_COPY_FILES.map((file) => file.dest));

const pairs = buildPairs(targetRepo);
if (targetRepo !== repoRoot && pairs.length === 0) {
  console.error(`error: no comparable vendored files found under ${targetRepo}`);
  process.exit(1);
}
const failures = [];
// Destinations refused because a symlink was in the way, kept SEPARATE from `refusals` (tracked copies with
// uncommitted edits) so each failure says which reason it was and neither message has to be read as the
// other (web-uplift-sfbp). Collected at the TOP of the pair loop (web-uplift-rt1y), so the answer exists on
// every path, including the ones that write nothing.
const symlinkRefusals = [];

for (const pair of pairs) {
  // THE destination question, asked ONCE per pair and BEFORE any shortcut (web-uplift-rt1y). It used to be
  // asked in the write path, which only DRIFTED pairs reach: a symlinked destination whose target happened to
  // hold the SAME bytes hit the equality fast path just below, printed 'copies identical' and let the command
  // exit 0 with no refusal at all - the protection was absent exactly where it looked present. Asking it here
  // means a fast path added later cannot shadow it, because the guard is reached before every one of them: a
  // guard that can only be reached after a fast path is one the next fast path bypasses.
  const destAbs = fromVendored ? pair.srcAbs : pair.dstAbs;
  // A pair with no destination path at all (an empty copy-dir on our own tree) has nothing to ask about or
  // write to; asking refusedDestination about null would throw where the old code merely compared nothing.
  const refused = destAbs ? refusedDestination(destAbs, targetRepo) : null;
  if (refused) {
    symlinkRefusals.push(refused.path);
    console.error(`web-uplift sync: ${refused.reason}: ${refused.path} (${refused.symlinkComponent} is a symlink). Nothing was written for it; remove or replace the symlink and run again.`);
    continue;
  }
  const source = readCopy(pair.srcAbs);
  const vendored = readCopy(pair.dstAbs);

  if (source.state === 'ok' && vendored.state === 'ok' && sameBytes(source.bytes, vendored.bytes)) {
    console.log(
      `copies identical: ${pair.srcRel} == ${pair.dstRel} (sha256 ${source.sha}, ${source.bytes.length} bytes)`,
    );
    continue;
  }

  failures.push(pair);
  const lines = [];
  const srcIssue = source.state === 'ok' ? null : source.state;
  const dstIssue = vendored.state === 'ok' ? null : vendored.state;

  if (srcIssue || dstIssue) {
    if (srcIssue && dstIssue) {
      const issue = srcIssue === dstIssue ? srcIssue : 'missing or unreadable';
      lines.push(`vendored copy is ${issue} on both sides: ${pair.srcRel} and ${pair.dstRel}`);
    } else if (srcIssue) {
      lines.push(`vendored copy has drifted: source is ${srcIssue} (${pair.srcRel} -> ${pair.dstRel})`);
    } else {
      lines.push(`vendored copy has drifted: vendored copy is ${dstIssue} (${pair.srcRel} -> ${pair.dstRel})`);
    }
    lines.push(`  ${copySummary(source, pair.srcRel)}`);
    lines.push(`  ${copySummary(vendored, pair.dstRel)}`);
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

if (failures.length === 0 && symlinkRefusals.length === 0) {
  console.log(`all ${pairs.length} vendored copies identical`);
  process.exit(0);
}

// A symlinked destination fails the command in EVERY mode, including a check-only run that would have written
// nothing: the contract is that such a destination is REFUSED, not that it is refused once something else has
// already gone wrong. This is the single failure point for it - the write path below no longer asks again,
// because a pair that reaches it was already answered here (web-uplift-rt1y).
if (symlinkRefusals.length > 0) {
  const unique = [...new Set(symlinkRefusals)];
  console.error(`FAILED: refused to write through ${unique.length} symlinked destination(s): ${unique.join(', ')}. Nothing was written for those, and the vendored tree is incomplete. Remove or replace the symlink and run again.`);
  process.exit(1);
}

if (syncMode) {
  if (dryRun) {
    for (const pair of failures) {
      const targetRel = fromVendored ? pair.srcRel : pair.dstRel;
      const sourceRel = fromVendored ? pair.dstRel : pair.srcRel;
      console.log(`dry-run: would sync ${sourceRel} -> ${targetRel}`);
    }
    console.error(`dry-run: ${failures.length} drifted copies would be synced (no changes written)`);
    process.exit(1);
  }
  let syncedCount = 0;
  let errorCount = 0;
  const refusals = [];
  for (const pair of failures) {
    const targetRel = fromVendored ? pair.srcRel : pair.dstRel;
    const targetAbs = join(targetRepo, targetRel);
    const sourceObj = fromVendored ? readCopy(pair.dstAbs) : readCopy(pair.srcAbs);
    const sourceRel = fromVendored ? pair.dstRel : pair.srcRel;

    // Never overwrite a TRACKED copy that carries its own uncommitted edits: the gate would
    // report success while destroying the only copy of that work (web-uplift-0zcd). A tracked
    // copy whose destination is clean is normally stale because the SOURCE moved, which is
    // exactly what this sync is for, so that case still syncs.
    const protection = TRACKED_DESTS.has(targetRel)
      ? trackedCopyHasLocalEdits(targetRepo, targetRel)
      : { state: 'clean' };
    if (protection.state === 'edited') {
      refusals.push(targetRel);
      console.error(`REFUSING to sync ${sourceRel} -> ${targetRel}: it is a tracked file with uncommitted local changes, and overwriting it would destroy work. Commit, stash or discard that change first, or run with --dry-run to see what would move.`);
      continue;
    }
    if (sourceObj.state === 'ok') {
      // No destination question here any more: the pair loop answered it before any shortcut, so a pair that
      // reaches this write has already been checked (web-uplift-rt1y). Keeping a second call here is how the
      // two would drift apart again.
      mkdirSync(dirname(targetAbs), { recursive: true });
      writeFileSync(targetAbs, sourceObj.bytes);
      const sourceAbs = fromVendored ? pair.dstAbs : pair.srcAbs;
      if (sourceAbs && existsSync(sourceAbs)) {
        try {
          chmodSync(targetAbs, statSync(sourceAbs).mode);
        } catch {
          // Best-effort mode preservation
        }
      }
      syncedCount++;
      console.log(`synced: ${sourceRel} -> ${targetRel}`);
    } else {
      console.error(`cannot sync ${sourceRel} -> ${targetRel}: source is ${sourceObj.state}`);
      errorCount++;
    }
  }
  if (errorCount > 0) {
    console.error(`FAILED to sync ${errorCount} file(s) (source was missing or unreadable)`);
    process.exit(1);
  }
  if (refusals.length > 0) {
    console.error(`FAILED: refused to overwrite ${refusals.length} tracked file(s) with uncommitted local changes: ${refusals.join(', ')}. Nothing was written for those. Your edits are intact.`);
    process.exit(1);
  }
  console.log(`successfully synced ${syncedCount} drifted copy/copies`);
  process.exit(0);
}

console.error(`FAIL: ${failures.length} of ${pairs.length} vendored copies have drifted`);
console.error('Resync the vendored tree with: npm run sync:vendored (or node tests/cdp-copy-sync.mjs --sync)');
process.exit(1);

// Turns the copy-dir / copy-file mappings above into a flat, deterministic list
// of { srcRel, dstRel, srcAbs, dstAbs }. srcAbs/dstAbs are null when that side
// is absent (a file the other side has but this one does not).
function buildPairs(root = targetRepo) {
  const out = [];
  for (const [src, dst] of COPY_FILES) {
    const srcAbs = join(root, src);
    const dstAbs = join(root, dst);
    if (root !== repoRoot && !existsSync(srcAbs) && !existsSync(dstAbs)) continue;
    out.push({
      srcRel: src,
      dstRel: dst,
      srcAbs,
      dstAbs,
    });
  }
  for (const [srcDir, dstDir] of COPY_DIRS) {
    const srcFiles = walkDir(join(root, srcDir));
    const dstFiles = walkDir(join(root, dstDir));
    const rels = [...new Set([...srcFiles.keys(), ...dstFiles.keys()])].sort();
    if (rels.length === 0) {
      if (root === repoRoot) {
        out.push({ srcRel: srcDir, dstRel: dstDir, srcAbs: null, dstAbs: null });
      }
      continue;
    }
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

// Returns one of three states so a file that exists but cannot be read is
// reported as unreadable rather than missing. A null/absent path or an ENOENT
// read is missing; any other read error (e.g. EACCES) is unreadable. Both fail
// the guard the same way - only the message differs.
function readCopy(file) {
  if (!file) return { state: 'missing' };
  let bytes;
  try {
    bytes = new Uint8Array(readFileSync(file));
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  return {
    state: 'ok',
    bytes,
    sha: createHash('sha256').update(bytes).digest('hex'),
    text: new TextDecoder().decode(bytes),
  };
}

// Formats one side of a pair for the drift report; non-'ok' states print their
// reason (<missing> or <unreadable>) instead of a hash.
function copySummary(copy, rel) {
  if (copy.state === 'ok') return `${rel.padEnd(40)} sha256 ${copy.sha}  ${copy.bytes.length} bytes`;
  return `${rel.padEnd(40)} <${copy.state}>`;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// A minimal unified diff (DIFF_CONTEXT lines of context) built from an LCS over
// lines. It is not a byte-for-byte GNU `diff -u` replica: on ambiguous inputs
// (duplicate or similar lines) the LCS tie-break can order body lines
// differently from GNU's Myers algorithm, and the lines come from
// `text.split('\n')`, whose phantom trailing empty element shifts hunk headers
// by one for any change that touches EOF. Neither affects the pass/fail
// verdict, the sha256 hashes or the byte sizes. The vendored files are a few
// hundred lines, so the O(n*m) table is free and the guard stays
// dependency-free.
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
