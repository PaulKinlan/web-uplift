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
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRATCH_SUBDIR, allowedRootsFor, escapedChanges } from '../runner/write-scope.mjs';

// Paths resolve from this file, never from cwd, so the guard gives the same
// answer whether CI or a human runs it from anywhere in the tree.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const SKILL_CONTRACT_PHRASE = `<report directory>/${SCRATCH_SUBDIR}/`;

// Machine-local path checks (web-uplift-069l, web-uplift-0jpc): skills are shared doctrine and must not hard-code
// machine-local paths (/home/..., /Users/..., ~/.gemini/..., ~/.config/..., C:\Users\..., /opt/homebrew/..., /mnt/c/Users/...,
// file:///home/...) which make them non-portable and silently fail or run arbitrary code elsewhere.
export function skillMachineLocalPathViolations(skillText) {
  const violations = [];
  const patterns = [
    /(?:file:\/\/|\/mnt\/[a-z])?(?:\/home\/[^\s)\]`'"]+)/g,
    /(?:file:\/\/|\/mnt\/[a-z])?(?:\/Users\/[^\s)\]`'"]+)/g,
    /(?:^|[^\w./-])(~(?:\/|\\[\w.-]+)[^\s)\]`'"]*)/g,
    /(?:^|[^\w./-])([A-Za-z]:\\[Uu]sers\\[^\s)\]`'"]+)/g,
    /(?:\/opt\/homebrew\/[^\s)\]`'"]+)/g,
    /(?:\/opt\/local\/[^\s)\]`'"]+)/g,
  ];
  for (const pat of patterns) {
    for (const match of skillText.matchAll(pat)) {
      const p = match[1] || match[0];
      violations.push(`SKILL.md contains machine-local path "${p}" - resolve relative to the skill root or declare tool by name (web-uplift-069l, web-uplift-0jpc)`);
    }
  }
  return violations;
}

export function findSkillFiles(dir, seenDirs = new Set()) {
  const results = [];
  let realDir;
  try {
    realDir = realpathSync(dir);
  } catch {
    return results;
  }
  if (seenDirs.has(realDir)) return results;
  seenDirs.add(realDir);

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'evidence-out' || entry === 'reports') continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        results.push(...findSkillFiles(full, seenDirs));
      } else if (st.isFile() && entry === 'SKILL.md') {
        results.push(full);
      }
    } catch {}
  }
  return results.sort();
}

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
  // allowedRoots can never contain. The qualifier only exempts the contract
  // phrase itself (stripped above); every other `scratch/` token counts,
  // however it is spelled — bare, relative (./scratch/), absolute (/scratch/),
  // or composed ($(pwd)/scratch/) — because all of them land outside the run
  // directory. Prose uses of the word without a trailing slash ("from
  // scratch") are not write paths and must not trip the guard; a control below
  // pins that.
  const withoutContractPhrase = skillText.split(SKILL_CONTRACT_PHRASE).join('');
  const stray = withoutContractPhrase.match(/(^|[^A-Za-z0-9_-])scratch\//gm);
  if (stray) {
    violations.push(
      `SKILL.md still instructs write paths outside the run directory: ${stray.map((s) => s.trim()).join(', ')}`,
    );
  }
  // The .gitignore half, line-based so pattern variants (scratch, /scratch/,
  // scratch/*) cannot slip past a single exact-string form; comment lines are
  // documentation, not reservations, and a negation (!scratch/) un-ignores
  // rather than reserves, so neither counts.
  const reserved = gitignoreText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .filter((line) => /^\/?scratch\/?\*?$/.test(line));
  if (reserved.length) {
    violations.push(
      `.gitignore reserves a top-level scratch path (${reserved.join(', ')}) — the instructed-write half of the contract lives inside the run directory now`,
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
// Spelling variants a narrower pattern once missed (review of web-uplift-16f):
// relative, absolute and composed scratch paths are all outside the run
// directory and must be flagged; every .gitignore reservation form must be too.
for (const spelled of ['Put helpers in ./scratch/ before judging.', 'Write frames to /scratch/frames/.', 'Cache guidance under $(pwd)/scratch/guidance/.']) {
  if (skillWriteContractViolations(spelled, gitignoreText).length === 0) {
    problems.push(`mutation control: an instructed path spelled as in ${JSON.stringify(spelled)} must violate the contract`);
  }
}
for (const reserved of ['scratch', '/scratch/', 'scratch/*']) {
  if (skillWriteContractViolations(skillText, `${reserved}\n`).length === 0) {
    problems.push(`mutation control: a .gitignore reserving ${JSON.stringify(reserved)} must violate the contract`);
  }
}
// False-positive control: prose that merely contains the word must NOT violate,
// or the guard would punish unrelated SKILL edits into deleting the check.
const benign = `Keep everything under ${SKILL_CONTRACT_PHRASE}. Reports may say a page was built from scratch by its author.`;
if (skillWriteContractViolations(benign, gitignoreText).length !== 0) {
  problems.push('false-positive control: prose \'from scratch\' beside the contract phrase must not violate the contract');
}

// Machine-local path audit (web-uplift-069l, web-uplift-gmd4): every SKILL.md in the repository must be portable
const skillFiles = findSkillFiles(repoRoot);
if (skillFiles.length < 3) {
  problems.push(`skill search found fewer than 3 SKILL.md files (${skillFiles.length} found): directory traversal broke or missed symlinks`);
}
for (const sf of skillFiles) {
  const content = readFileSync(sf, 'utf8');
  for (const v of skillMachineLocalPathViolations(content)) {
    problems.push(`${relative(repoRoot, sf)}: ${v}`);
  }
}

// Mutation controls for machine-local paths (web-uplift-069l, web-uplift-0jpc):
for (const sample of [
  'Run ~/.gemini/config/plugins/chrome-devtools-plugin/skills/memory-leak-debugging/SKILL.md for details.',
  'See /home/exedev/tools/plugin for config.',
  'Load from /Users/paul/Library/Application Support/agent.',
  'Config at C:\\Users\\exedev\\AppData\\Local\\skills',
  'Load from /opt/homebrew/lib/node_modules/x',
  'file:///home/exedev/x/SKILL.md',
  '/mnt/c/Users/exedev/x',
]) {
  if (skillMachineLocalPathViolations(sample).length === 0) {
    problems.push(`mutation control: machine-local path in ${JSON.stringify(sample)} must violate portability check`);
  }
}
// False-positive control: relative paths, URLs, and innocent prose must NOT violate
for (const sample of [
  'Run ./scripts/scan.py or use node_modules/@foo/bar.',
  'Visit https://github.com/ChromeDevTools/chrome-devtools-mcp for docs.',
  'Relative skill path: ../skills/audit/SKILL.md',
]) {
  if (skillMachineLocalPathViolations(sample).length !== 0) {
    problems.push(`false-positive control: innocent path in ${JSON.stringify(sample)} must NOT violate portability check`);
  }
}

if (problems.length) {
  console.error('skill-write-contract: FAIL');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('skill-write-contract: every SKILL-instructed write path stays inside the runner allowed roots and all SKILL.md files are portable');
