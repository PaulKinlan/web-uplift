#!/usr/bin/env node
// web-uplift-4m2: the refusal is flag-based, not pointer authentication.
// A host-slug-correct planted pointer must be consulted in the isolated path,
// demonstrating the exact residual that the refusal and help text disclose.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { SymlinkWriteRefused, readFileNoFollow, writeFileNoFollow, writeFileNoFollowSync } from '../runner/safe-write.mjs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function testBatchResumeIsolation() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-batch-resume-isolation-'));
  try {
    const out = join(root, 'reports');
    const hostRoot = join(out, 'forged_example'); // hostSlug('https://forged.example/')
    const runDir = join(hostRoot, 'run-fake');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(hostRoot, 'latest.txt'), 'run-fake\n');
    writeFileSync(join(runDir, 'report.json'), readFileSync(join(repoRoot, 'examples', 'playground-report.json')));

    const binDir = join(root, 'bin');
    mkdirSync(binDir);
    const stub = join(binDir, 'claude');
    writeFileSync(stub, '#!/bin/sh\nexit 17\n');
    chmodSync(stub, 0o755);
    const drive = (...flags) => spawnSync(process.execPath,
      [join(repoRoot, 'runner', 'run-batch.mjs'), 'https://forged.example/', '--out', out,
        '--resume', '--agent', 'claude', '--concurrency', '1', ...flags],
      { cwd: root, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }, encoding: 'utf8' });

    // Positive control: the normal asserted path DOES skip on this planted pointer.
    // If this fails, the fixture no longer tests the live pointer lookup.
    const asserted = drive('--isolation', 'test-suite');
    assert.equal(asserted.status, 0, `asserted resume must skip the planted report: ${asserted.stdout}\n${asserted.stderr}`);
    assert.match(asserted.stdout, /resume skip\s+https:\/\/forged\.example\//);

    // In unisolated mode, reject --resume entirely and state the remaining
    // isolated-path risk plainly rather than claiming the pointer is authenticated.
    const unisolated = drive('--i-know-this-is-unisolated');
    assert.notEqual(unisolated.status, 0, 'unisolated --resume must be refused');
    assert.match(unisolated.stderr, /REFUSED: --resume cannot be used with --i-know-this-is-unisolated/);
    assert.match(unisolated.stderr, /Even with --isolation, --resume still trusts an unauthenticated agent-writable <out>\/<host>\/latest pointer/);
    assert.match(unisolated.stderr, /actual isolation boundary must prevent the agent from writing that pointer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// web-uplift-rsbb: the run tree is agent-writable, so the runner's OWN writes must not follow a leaf
// link an agent left behind. A unit shape first (every arm: async write, sync write, read; plus the
// positive controls that a fresh file is created and an existing REGULAR file is replaced, so a guard
// that simply refused everything cannot pass), then the two end-to-end shapes through the real CLI
// with a hostile stub agent, which is the only way to prove the call sites use the guard.
export async function testSafeWriteRefusesSymlinkLeaf() {
  const dir = mkdtempSync(join(tmpdir(), 'web-uplift-safe-write-'));
  try {
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'ORIGINAL\n');
    const link = join(dir, 'run.json');
    symlinkSync(victim, link);

    const refused = (err) => err instanceof SymlinkWriteRefused && err.code === 'ELOOP';
    // Every arm the module exposes, because a guard on only one of them leaves the other call sites open.
    await assert.rejects(
      () => writeFileNoFollow(link, 'CLOBBERED'),
      refused,
      'the async write through a planted leaf link must be refused as a SymlinkWriteRefused, not followed'
    );
    assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'the async write must not have touched the link target');
    assert.throws(
      () => writeFileNoFollowSync(link, 'CLOBBERED'),
      refused,
      'the sync write through a planted leaf link must be refused as a SymlinkWriteRefused, not followed'
    );
    assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'the sync write must not have touched the link target');
    await assert.rejects(
      () => readFileNoFollow(link),
      refused,
      'a READ through a planted leaf link must be refused too: otherwise someone else\'s file is read as this run\'s report'
    );

    // Positive controls: the guard refuses LINKS, not writes.
    const fresh = join(dir, 'fresh.json');
    writeFileNoFollowSync(fresh, 'first');
    assert.equal(readFileSync(fresh, 'utf8'), 'first', 'a fresh path must still be written');
    writeFileNoFollowSync(fresh, 'second');
    assert.equal(readFileSync(fresh, 'utf8'), 'second', 'a regular file must still be REPLACED, not refused');
    await writeFileNoFollow(fresh, 'third');
    assert.equal(readFileSync(fresh, 'utf8'), 'third', 'the async write must replace a regular file too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Drive the real runner with a stub agent that plants a link and exits 0. The stub finds the run dir
// from WEB_UPLIFT_LAUNCH_LOG, which the runner passes to every agent child (web-uplift-4wx), so this is
// the same position a hostile agent is in: it knows where its own run dir is and can write in it.
function driveHostileStub(root, out, stubBody) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, 'claude');
  writeFileSync(stub, stubBody);
  chmodSync(stub, 0o755);
  return spawnSync(process.execPath,
    [join(repoRoot, 'runner', 'run-batch.mjs'), 'https://forged.example/', '--out', out,
      '--agent', 'claude', '--concurrency', '1', '--isolation', 'test-suite'],
    { cwd: root, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }, encoding: 'utf8' });
}

// `run.json` is written by the RUNNER after the agent exits (run-batch.mjs:482). Pre-fix, writeFile
// followed a planted link and the runner's own record landed outside the run tree.
export function testRunnerRunJsonWriteRefusesPlantedLeafLink() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-rsbb-run-json-'));
  try {
    const out = join(root, 'reports');
    const victim = join(root, 'victim.json');
    writeFileSync(victim, '"SENTINEL-CONTENT"\n');
    const report = join(repoRoot, 'examples', 'playground-report.json');
    const res = driveHostileStub(root, out, [
      '#!/bin/sh',
      'site=$(dirname "$WEB_UPLIFT_LAUNCH_LOG")',
      `cp '${report}' "$site/report.json"`,
      'rm -f "$site/run.json"',
      `ln -s '${victim}' "$site/run.json"`,
      'exit 0',
      '',
    ].join('\n'));
    const output = `${res.stdout}\n${res.stderr}`;
    assert.notEqual(res.status, 0, `a run whose run.json is a planted link must FAIL, got ${res.status}:\n${output}`);
    assert.match(output, /refusing to write .*run\.json/, `the failure must name the refused write:\n${output}`);
    assert.match(output, /symbolic link/, `the failure must say why it refused:\n${output}`);
    assert.equal(readFileSync(victim, 'utf8'), '"SENTINEL-CONTENT"\n', 'the link target must be untouched: the runner did not write through it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// `report.json` is READ and REWRITTEN by annotateReport immediately after, so a planted link there is
// both a disclosure (someone else's JSON read as this run's report) and a write through the link.
export function testRunnerReportJsonWriteRefusesPlantedLeafLink() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-rsbb-report-json-'));
  try {
    const out = join(root, 'reports');
    const victim = join(root, 'victim-report.json');
    const report = join(repoRoot, 'examples', 'playground-report.json');
    writeFileSync(victim, readFileSync(report));
    const res = driveHostileStub(root, out, [
      '#!/bin/sh',
      'site=$(dirname "$WEB_UPLIFT_LAUNCH_LOG")',
      'rm -f "$site/report.json"',
      `ln -s '${victim}' "$site/report.json"`,
      'exit 0',
      '',
    ].join('\n'));
    const output = `${res.stdout}\n${res.stderr}`;
    assert.notEqual(res.status, 0, `a run whose report.json is a planted link must FAIL, got ${res.status}:\n${output}`);
    assert.match(output, /refusing to (read|write) .*report\.json/, `the failure must name the refused access:\n${output}`);
    const after = JSON.parse(readFileSync(victim, 'utf8'));
    assert.equal(after.agent, undefined, 'the annotate step must not have written runner metadata through the link');
    assert.equal(after.runId, undefined, 'the annotate step must not have written a runId through the link');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --list names this suite's cases for DECLARED_SUITE_CASES (web-uplift-yfbk), from the array the runner
// drives, so the list cannot drift from what runs. process.exitCode, not process.exit: exit() does not
// flush asynchronous stdout on a pipe (web-uplift-ecif).
const CASES = [testBatchResumeIsolation, testSafeWriteRefusesSymlinkLeaf, testRunnerRunJsonWriteRefusesPlantedLeafLink, testRunnerReportJsonWriteRefusesPlantedLeafLink];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--list')) {
    for (const fn of CASES) console.log(fn.name);
    process.exitCode = 0;
  } else {
    for (const fn of CASES) await fn();
    console.log('batch resume isolation: ok');
  }
}
