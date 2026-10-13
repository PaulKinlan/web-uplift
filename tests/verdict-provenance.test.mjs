#!/usr/bin/env node
/**
 * tests/verdict-provenance.test.mjs - the control for scripts/check-verdict.mjs (web-uplift-ebvj).
 *
 * The check exists because fleet-check sources the machine-global ~/.fleet/check.conf for ANY repository on
 * this VM, and a cached verdict names no config file. These cases pin the decision, and they use FIXTURES
 * rather than the live cache: a test that read ~/.fleet/checks would depend on machine state and on other
 * lanes' runs, which turns a change red for everyone else (docs/speed.md). The live-cache demonstration,
 * positive case first, is recorded on the bead as evidence instead.
 *
 * Order matters: the POSITIVE case runs first, because the first version of the checker failed it on a
 * lookup bug while both changed paths passed - a refusal with no positive control is a check that might
 * fire always.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSuite } from './test-helpers.mjs';
import { judgeVerdict, findRecord, PROJECT_COMMANDS } from '../scripts/check-verdict.mjs';

const repoRoot = process.cwd();
const scratch = () => mkdtempSync(join(tmpdir(), 'ebvj-verdict-'));
const record = (extra) => ({ kind: 'fast', state: 'PASS', tree: 'a'.repeat(40), ...extra });

function testThisProjectsVerdictIsAccepted() {
  // POSITIVE CASE FIRST. If this one cannot pass, every refusal below is worthless.
  const verdict = judgeVerdict(record({ cmd: 'npm run test:fast', repo: repoRoot }));
  assert.equal(verdict.ok, true, `this project's own verdict must be accepted (got: ${verdict.why})`);
  assert(verdict.why.includes('npm run test:fast'), `the acceptance must name the command it compared (got: ${verdict.why})`);
  assert(!verdict.why.includes('no repo'), 'a record that carries repo must not print the absent-repo caveat');
  console.log(`✔ accepted this project's verdict: ${verdict.why}`);
}

function testForeignCommandIsRefused() {
  // The machine-global config currently holds agents-factory's commands; that is the record shape being judged.
  const verdict = judgeVerdict(record({ cmd: 'bash tools/fast-gate.sh', repo: repoRoot }));
  assert.equal(verdict.ok, false, 'a command this project did not choose must be refused');
  assert(verdict.why.includes('bash tools/fast-gate.sh'), `the refusal must NAME the recorded command (got: ${verdict.why})`);
  for (const cmd of PROJECT_COMMANDS) {
    assert(verdict.why.includes(cmd), `the refusal must name the commands this project chose, including '${cmd}' (got: ${verdict.why})`);
  }
  console.log(`✔ refused a foreign command, naming it: ${verdict.why}`);
}

function testForeignProjectIsRefused() {
  // A second, real git repository in a temp dir: project identity is git's common dir, not a path, so this
  // must refuse even though the COMMAND is ours.
  const other = scratch();
  try {
    execFileSync('git', ['init', '-q'], { cwd: other, stdio: 'ignore' });
    const verdict = judgeVerdict(record({ cmd: 'npm run test:fast', repo: other }));
    assert.equal(verdict.ok, false, `a verdict produced in another project must be refused even with our command (got: ${verdict.why})`);
    assert(verdict.why.includes('different project'), `the refusal must say it is a different project (got: ${verdict.why})`);
    console.log(`✔ refused the same command in another project: ${verdict.why}`);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
}

function testAnotherWorktreeOfThisProjectIsAccepted() {
  // Coord's trap: six worktrees of this repository exist on this VM, and a PATH-keyed refusal would refuse
  // the merger's legitimate verdict. A second worktree of THIS repo must be accepted.
  const wt = scratch();
  try {
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, 'HEAD'], { cwd: repoRoot, stdio: 'ignore' });
    const verdict = judgeVerdict(record({ cmd: 'npm run test:fast', repo: wt }));
    assert.equal(verdict.ok, true, `another worktree of this project must be accepted, not refused by path (got: ${verdict.why})`);
    console.log(`✔ accepted a verdict from another worktree of this project: ${verdict.why}`);
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot, stdio: 'ignore' });
    } catch { /* already gone */ }
    rmSync(wt, { recursive: true, force: true });
  }
}

function testRecordWithNoRepoIsAcceptedWithTheCaveat() {
  // repo is present in only about 47% of the 328 real records (52 of 132 full records), so the check must
  // still work without it AND say that the project was not checked.
  const verdict = judgeVerdict(record({ cmd: 'npm run test:fast' }));
  assert.equal(verdict.ok, true, `a record with no repo must be judged on the command alone (got: ${verdict.why})`);
  assert(verdict.why.includes('no repo'), `the message must SAY the project was not checked (got: ${verdict.why})`);
  console.log(`✔ accepted a record with no repo and said so: ${verdict.why}`);
}

function testRecordWithNoCommandIsRefused() {
  const verdict = judgeVerdict(record({ repo: repoRoot }));
  assert.equal(verdict.ok, false, 'a record naming no command identifies nothing and must be refused');
  assert(verdict.why.includes('no command'), `the refusal must say what is missing (got: ${verdict.why})`);
  console.log(`✔ refused a record with no command: ${verdict.why}`);
}

function testFindRecordMatchesTheRealCacheNaming() {
  // The lookup bug that made the POSITIVE case fail: the cache writes <tree>.<kind>.json, and the first
  // version assumed <tree>.json.
  const dir = scratch();
  const tree = 'b'.repeat(40);
  try {
    writeFileSync(join(dir, `${tree}.fast.json`), '{}');
    assert.equal(findRecord(dir, tree), join(dir, `${tree}.fast.json`), 'a <tree>.<kind>.json record must be found');
    writeFileSync(join(dir, `${tree}.json`), '{}');
    assert.equal(findRecord(dir, tree), join(dir, `${tree}.json`), 'the exact name must win when both exist');
    assert.equal(findRecord(dir, 'c'.repeat(40)), null, 'an unknown tree must be reported as absent, not guessed at');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    console.log('✔ <tree>.<kind>.json is found, the exact name wins, and an unknown tree is absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const verdictProvenanceTests = [
  testThisProjectsVerdictIsAccepted,
  testForeignCommandIsRefused,
  testForeignProjectIsRefused,
  testAnotherWorktreeOfThisProjectIsAccepted,
  testRecordWithNoRepoIsAcceptedWithTheCaveat,
  testRecordWithNoCommandIsRefused,
  testFindRecordMatchesTheRealCacheNaming,
];

export {
  testThisProjectsVerdictIsAccepted,
  testForeignCommandIsRefused,
  testForeignProjectIsRefused,
  testAnotherWorktreeOfThisProjectIsAccepted,
  testRecordWithNoRepoIsAcceptedWithTheCaveat,
  testRecordWithNoCommandIsRefused,
  testFindRecordMatchesTheRealCacheNaming,
};

await runSuite(verdictProvenanceTests, import.meta.url, { timeoutMs: 30000, concurrency: 1 });
