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
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitEnv, repoRoot, run, runSuite } from './test-helpers.mjs';

function makeRepo(fileName) {
  const dir = mkdtempSync(join(tmpdir(), 'tax6-git-env-'));
  const git = (args, env, opts) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv(env ?? {}, opts) });
  const init = git(['init', '-q']);
  if (init.status !== 0) throw new Error(`git init failed in ${dir}: ${init.stderr}`);
  writeFileSync(join(dir, fileName), `${fileName}\n`);
  const add = git(['add', '--', fileName]);
  if (add.status !== 0) throw new Error(`git add failed in ${dir}: ${add.stderr}`);
  return dir;
}

function listFiles(dir, env, opts) {
  const res = spawnSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8', env: gitEnv(env ?? {}, opts) });
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
    // variable matters and why passing an explicit cwd is not enough on its own. Carrying a GIT_* is asked for
    // EXPLICITLY here (allowGitDir), because a deliberate override must be visible rather than inferred from a
    // spread - the same reasoning that made the scrub sanitise the final environment.
    const leaked = listFiles(a, { GIT_DIR: join(b, '.git') }, { allowGitDir: true });
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
    // A caller that genuinely needs a variable must ASK for it. A bare argument is not enough any more, and
    // that is deliberate: the scrub is applied to the merged result, so intent cannot be inferred from an object
    // that may simply be a spread of process.env - which is how the scrub was defeated in the first place.
    if (gitEnv({ GIT_DIR: join(b, '.git') }).GIT_DIR !== undefined) {
      throw new Error('a bare GIT_* argument must NOT survive: a spread of process.env must not be able to restore it');
    }
    if (gitEnv({ GIT_DIR: join(b, '.git') }, { allowGitDir: true }).GIT_DIR !== join(b, '.git')) {
      throw new Error('an explicitly requested GIT_* must survive, or the helper cannot express a deliberate choice');
    }
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    if (savedTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = savedTrace;
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}

export const gitEnvIsolationCases = [
  testASpreadEnvCannotRestoreGitDir,
  testEveryGitSpawnInTestsGoesThroughTheScrub,
  testGitDirOverridesCwdSoTheLeakIsReal,
  testInheritedGitDirIsStrippedByTheHarness,
];

// Same shape as every suite here: the harness returns immediately unless this file IS argv[1], so being imported
// by the registry does not re-run these cases, and running this file directly does.
await runSuite(gitEnvIsolationCases, import.meta.url, { timeoutMs: 60000, concurrency: 1 });

// The reviewer's measurement, as a test: the scrub used to be defeated by the CALLER. gitEnv deleted GIT_* from
// process.env and then spread the caller's env over the result, so a caller passing { ...process.env } - the real
// pattern at tests/test-fast.mjs and tests/runner-agents.test.mjs - restored the inherited GIT_DIR and pointed
// the spawn at another repository again. Sanitising the FINAL merged environment is what stops that, and this
// case is the proof: it deliberately spreads process.env into the call.
function testASpreadEnvCannotRestoreGitDir() {
  const a = makeRepo('in-a.txt');
  const b = makeRepo('in-b.txt');
  const saved = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = join(b, '.git');
    const viaRun = run('git', ['ls-files'], { cwd: a, env: { ...process.env } });
    if (viaRun.status !== 0) throw new Error(`harness spawn failed: ${viaRun.stderr}`);
    const answered = viaRun.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (answered.length !== 1 || answered[0] !== 'in-a.txt') {
      throw new Error(
        `a caller spreading process.env must NOT be able to restore a GIT_DIR: asked about a and got ${JSON.stringify(answered)}`,
      );
    }
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}

// An ENUMERATION rather than a count, because a count is what let a missed site through: the first pass fixed 13
// spawns and the reviewer found more (web-uplift-rmhf measured the fixture helper in tests/test-fast.mjs). This
// walks every module under tests/ that spawns git, extracts the WHOLE call for each one by balancing parentheses,
// and requires the scrub in that call. It fails by naming the file and line, and it asserts a floor on the number
// of sites so it cannot pass by finding none at all.
function testEveryGitSpawnInTestsGoesThroughTheScrub() {
  const dir = join(repoRoot, 'tests');
  const spawnPattern = /(?:execFileSync|execFile|execSync|spawnSync|spawn|exec)\(\s*['"]git['"]/g;
  const files = readdirSync(dir).filter((name) => name.endsWith('.mjs'));
  const sites = [];
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const match of text.matchAll(spawnPattern)) {
      // Balance parentheses from the opening call to its close, so the statement checked is this call's.
      let depth = 0;
      let index = match.index + match[0].length - 1;
      let end = index;
      for (; index < text.length; index += 1) {
        if (text[index] === '(') depth += 1;
        else if (text[index] === ')') {
          depth -= 1;
          if (depth === 0) { end = index; break; }
        }
      }
      const call = text.slice(match.index, end + 1);
      const line = text.slice(0, match.index).split('\n').length;
      sites.push({ file, line, scrubbed: call.includes('gitEnv(') });
    }
  }
  const unscrubbed = sites.filter((site) => !site.scrubbed);
  assert(
    unscrubbed.length === 0,
    `every git spawn under tests/ must pass env: gitEnv(...), and these do not: ${unscrubbed.map((s) => `${s.file}:${s.line}`).join(', ')}`,
  );
  assert(
    sites.length >= 10,
    `this control must actually find the git spawns it is guarding: it found ${sites.length}, which is too few to be the real set`,
  );
  console.log(`\u2714 all ${sites.length} git spawn(s) under tests/ scrub GIT_* through gitEnv()`);
}
