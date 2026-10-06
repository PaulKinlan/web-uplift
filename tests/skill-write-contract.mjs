#!/usr/bin/env node
// WHY this guard exists (web-uplift-16f): the two halves of the headless-audit
// write contract drifted apart and nothing failed. SKILL.md told the agent to
// keep ad-hoc work in a repo-root `scratch/` (.gitignore even reserved it),
// while the runner's write scope allowed only the run's --out directory — so
// run 4 of web-uplift-ies completed a full 58/58 audit, published its
// scorecard, and was then REFUSED for 33 paths the skill itself instructed.
// Both halves looked individually correct; only a real headless run could see
// the gap. This guard reads BOTH halves — the skill text an agent follows and
// the allowed roots the runner enforces — and fails when a write path the skill
// instructs falls outside what the runner allows.
//
// The contract itself lives in ONE place: runner/write-scope.mjs exports
// SCRATCH_SUBDIR and allowedRootsFor; the skill must teach
// `<report directory>/scratch/`, and every instructed write path must resolve
// under the run directory. The vendored SKILL copies are kept byte-identical
// by tests/cdp-copy-sync.mjs, so checking the canonical copy checks them all.
//
// Usage: node tests/skill-write-contract.mjs
// Exit 0 when the halves agree, 1 when they drift. Node builtins only: no npm
// install is needed to run it.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRATCH_SUBDIR, allowedRootsFor, escapedChanges } from '../runner/write-scope.mjs';

// Paths resolve from this file, never from cwd, so the guard gives the same
// answer whether CI or a human runs it from anywhere in the tree.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const SKILL_CONTRACT_PHRASE = `<report directory>/${SCRATCH_SUBDIR}/`;

// The pure check, exported so the mutation controls below — and any future
// test — can prove it FAILS on drifted inputs instead of trusting that it
// would. A guard that cannot fail is not a guard (web-uplift-4ux).
export function skillWriteContractViolations(skillText, gitignoreText) {
  const violations = [];
  if (!skillText.includes(SKILL_CONTRACT_PHRASE)) {
    violations.push(
      `SKILL.md never instructs the run-dir scratch placement (${SKILL_CONTRACT_PHRASE}), so an agent's scratch writes land wherever it guesses`,
    );
  }
  // Any scratch path the skill instructs OUTSIDE the run directory is the
  // exact drift that refused web-uplift-ies run 4: a write path the runner's
  // allowedRoots can never contain.
  const withoutContractPhrase = skillText.split(SKILL_CONTRACT_PHRASE).join('');
  const stray = withoutContractPhrase.match(/`scratch\/`|(^|[^/\w.-])scratch\//gm);
  if (stray) {
    violations.push(
      `SKILL.md still instructs write paths outside the run directory: ${stray.map((s) => s.trim()).join(', ')}`,
    );
  }
  if (/^scratch\/$/m.test(gitignoreText)) {
    violations.push(
      '.gitignore reserves a top-level scratch/ — the instructed-write half of the contract lives inside the run directory now',
    );
  }
  return violations;
}

const skillText = readFileSync(join(repoRoot, '.claude/skills/web-audit/SKILL.md'), 'utf8');
const gitignoreText = readFileSync(join(repoRoot, '.gitignore'), 'utf8');

const problems = [...skillWriteContractViolations(skillText, gitignoreText)];

// The runner half: one root — the run's --out directory — and the real refusal
// test must agree with the skill half: a scratch file inside a run directory is
// in scope; the same relative path at the repo root escapes.
const outRoot = join(repoRoot, 'reports');
const roots = allowedRootsFor(outRoot);
if (roots.length !== 1 || roots[0] !== outRoot) {
  problems.push(`allowedRootsFor must be exactly the run's --out root: ${JSON.stringify(roots)}`);
}
const escaped = escapedChanges(
  {
    added: [
      join('reports', 'site', 'run', SCRATCH_SUBDIR, 'helper.mjs'),
      join(SCRATCH_SUBDIR, 'helper.mjs'),
    ],
    modified: [],
    deleted: [],
  },
  repoRoot,
  roots,
);
if (escaped.length !== 1 || escaped[0] !== join(repoRoot, SCRATCH_SUBDIR, 'helper.mjs')) {
  problems.push(
    `run-dir scratch must be inside the write scope and repo-root scratch outside it; escaped = ${JSON.stringify(escaped)}`,
  );
}

// Mutation controls: feed the check the exact pre-fix instruction and require
// violations, so a future edit that neuters the check fails here rather than
// silently passing on drifted halves.
const preFixSentence =
  'Keep artifacts (screenshots, videos, heap summaries, layout JSON, Lighthouse JSON) under the report directory or `scratch/` (gitignored).';
if (skillWriteContractViolations(preFixSentence, gitignoreText).length === 0) {
  problems.push(
    'mutation control: the pre-fix SKILL sentence (bare `scratch/` alternative) must violate the contract',
  );
}
if (skillWriteContractViolations(skillText.split(SKILL_CONTRACT_PHRASE).join(''), gitignoreText).length === 0) {
  problems.push('mutation control: removing the contract phrase from SKILL.md must violate the contract');
}
if (skillWriteContractViolations(skillText, `scratch/\n${gitignoreText}`).length === 0) {
  problems.push('mutation control: a .gitignore reserving top-level scratch/ must violate the contract');
}

if (problems.length) {
  console.error('skill-write-contract: FAIL');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('skill-write-contract: every SKILL-instructed write path stays inside the runner allowed roots');
