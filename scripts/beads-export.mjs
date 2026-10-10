#!/usr/bin/env node
// Publish the tracked passive export of the beads database, with provider-secret-shaped tokens
// redacted on the way out (web-uplift-ffum).
//
// Why a script rather than a one-off edit: `.beads/issues.jsonl` is a PASSIVE EXPORT - it is
// regenerated from the Dolt database, so any correction applied by hand to the file alone is
// undone by the next export. The redaction has to live at the point of generation or it does not
// exist. Run this instead of `bd export` whenever the tracked copy is refreshed:
//
//   node scripts/beads-export.mjs
//
// The rule itself lives in evidence/credential-terms.mjs, beside the name-based redaction, so this
// step and the guard that checks its output cannot disagree about what a token looks like.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactTokenShapesInText, findTokenShapesInText } from '../evidence/credential-terms.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(repoRoot, '.beads', 'issues.jsonl');

const scratch = mkdtempSync(join(tmpdir(), 'beads-export-'));
const raw = join(scratch, 'raw.jsonl');

const exported = spawnSync('bd', ['export', '--output', raw], { cwd: repoRoot, encoding: 'utf8' });
if (exported.status !== 0) {
  // Fall back to stdout for bd versions whose flag is spelled differently; either way the bytes are
  // redacted below, so the fallback cannot publish an unredacted copy.
  const viaStdout = spawnSync('bd', ['export'], { cwd: repoRoot, encoding: 'utf8' });
  if (viaStdout.status !== 0) {
    console.error(`beads-export: bd export failed (${exported.status}/${viaStdout.status}): ${(viaStdout.stderr || exported.stderr || '').trim()}`);
    process.exit(1);
  }
  writeFileSync(raw, viaStdout.stdout);
}

const before = readFileSync(raw, 'utf8');
const after = redactTokenShapesInText(before);

// The redaction must not break the format: the replacement is plain text with no quote or
// backslash, so every line must still parse. If it does not, publishing would be worse than failing.
let lines = 0;
for (const [i, line] of after.split('\n').entries()) {
  if (!line.trim()) continue;
  try {
    JSON.parse(line);
  } catch (err) {
    console.error(`beads-export: line ${i + 1} is not valid JSON after redaction (${err.message}); refusing to publish`);
    process.exit(1);
  }
  lines += 1;
}

writeFileSync(target, after);

// Report by shape and count. Never the values: this output can end up in a log, a bead or a commit.
const redacted = countShapeOccurrences(before);
console.log(`beads-export: wrote ${lines} line(s) to .beads/issues.jsonl; redacted ${redacted} provider-secret-shaped token(s)`);
if (redacted > 0) {
  console.log('beads-export: the tokens were replaced with [redacted] in place. Consider editing the offending bead so the shape never exists in the database either.');
}

function countShapeOccurrences(text) {
  // The same matcher the guard and the redactor use; no second copy of the pattern to drift.
  return findTokenShapesInText(text).length;
}
