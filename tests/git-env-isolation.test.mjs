// A gate's children inherit the surrounding shell's environment, and GIT_DIR OVERRIDES cwd: an inherited GIT_*
// can point a git call at a DIFFERENT repository while every path in the call looks correct, so a census or a
// tracked-file check can answer about someone else's tree and still look authoritative (web-uplift-tax6).
//
// Measured on this VM, the gate's children really do inherit GIT_EDITOR/GIT_PAGER/GIT_SEQUENCE_EDITOR/
// GIT_MERGE_AUTOEDIT/GIT_TERMINAL_PROMPT from the shell that started the lane, so inherited GIT_* is the normal
// case here rather than a hypothetical. For that reason tests/test-helpers.mjs passes env: gitEnv() - the
// process environment with every GIT_* removed - to each spawn it makes, and the direct call sites in this
// directory do the same.
//
// These cases hold both halves of that claim, because either half alone is worthless: that the leak is real and
// would otherwise misdirect a lookup, and that a spawn through the harness is immune to it. The second case is
// the one that fails if the scrub is reverted, which is how the fix was proven rather than asserted.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitEnv, run, runSuite } from './test-helpers.mjs';

function makeRepo(fileName) {
  const dir = mkdtempSync(join(tmpdir(), 'tax6-git-env-'));
  const git = (args, env) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: env || gitEnv() });
  const init = git(['init', '-q']);
  if (init.status !== 0) throw new Error(`git init failed in ${dir}: ${init.stderr}`);
  writeFileSync(join(dir, fileName), `${fileName}\n`);
  const add = git(['add', '--', fileName]);
  if (add.status !== 0) throw new Error(`git add failed in ${dir}: ${add.stderr}`);
  return dir;
}

function listFiles(dir, env) {
  const res = spawnSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8', env: env || gitEnv() });
  if (res.status !== 0) throw new Error(`git ls-files failed in ${dir}: ${res.stderr}`);
  return res.stdout.split('\n').filter(Boolean);
}

function testGitDirOverridesCwdSoTheLeakIsReal() {
  const a = makeRepo('in-a.txt');
  const b = makeRepo('in-b.txt');
  try {
    // Sanity: each repo answers about itself when nothing leaks.
    for (const [dir, expected] of [[a, 'in-a.txt'], [b, 'in-b.txt']]) {
      const own = listFiles(dir);
      if (own.length !== 1 || own[0] !== expected) {
        throw new Error(`expected ${dir} to list only ${expected} but it listed ${JSON.stringify(own)}`);
      }
    }
    // The leak: cwd points at a, the environment points at b, and git answers about b. This is why removing the
    // variable matters and why passing an explicit cwd is not enough on its own.
    const leaked = listFiles(a, { ...process.env, GIT_DIR: join(b, '.git') });
    if (leaked.length !== 1 || leaked[0] !== 'in-b.txt') {
      throw new Error(
        `GIT_DIR must override cwd or this control proves nothing: asked about a while the environment pointed at b, ` +
          `and got ${JSON.stringify(leaked)}`,
      );
    }
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}

function testInheritedGitDirIsStrippedByTheHarness() {
  const a = makeRepo('in-a.txt');
  const b = makeRepo('in-b.txt');
  const saved = process.env.GIT_DIR;
  const savedTrace = process.env.GIT_TRACE2_EVENT;
  try {
    // Exactly the shape that breaks a gate: the surrounding environment carries a GIT_* that points elsewhere.
    // A spawn through the harness must not be able to see it.
    process.env.GIT_DIR = join(b, '.git');
    process.env.GIT_TRACE2_EVENT = '1';
    if (Object.keys(gitEnv()).some((k) => k.startsWith('GIT_'))) {
      throw new Error('gitEnv() must contain no GIT_* keys at all, or the leak can still reach a child');
    }
    const viaHarness = run('git', ['ls-files'], { cwd: a });
    if (viaHarness.status !== 0) throw new Error(`harness spawn failed: ${viaHarness.stderr}`);
    const answered = viaHarness.stdout.split('\n').filter(Boolean);
    if (answered.length !== 1 || answered[0] !== 'in-a.txt') {
      throw new Error(
        `an inherited GIT_DIR must NOT redirect a harness spawn: asked about a and got ${JSON.stringify(answered)}`,
      );
    }
    // A caller that genuinely needs a variable still gets it through the explicit argument - the strip is of the
    // INHERITED environment, not of the caller's stated intent.
    if (gitEnv({ GIT_DIR: join(b, '.git') }).GIT_DIR !== join(b, '.git')) {
      throw new Error('an explicitly passed GIT_* must survive, or the helper cannot express a deliberate choice');
    }
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    if (savedTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = savedTrace;
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}

export const gitEnvIsolationCases = [
  testGitDirOverridesCwdSoTheLeakIsReal,
  testInheritedGitDirIsStrippedByTheHarness,
];

// Same shape as every suite here: the harness returns immediately unless this file IS argv[1], so being imported
// by the registry does not re-run these cases, and running this file directly does.
await runSuite(gitEnvIsolationCases, import.meta.url, { timeoutMs: 60000, concurrency: 1 });
