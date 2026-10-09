#!/usr/bin/env node
// A basis registry with no rules must be refused, not verified (web-uplift-uxr).
//
// Every downstream check passes over an empty registry: `--verify-basis` used to answer "OK ...
// (0 rule(s) verified, all anchors intact)", and classification then re-filed a reversed guide as
// an ordinary CHANGE, because an empty registry has no anchors to notice that a rule's text has
// gone from upstream. docs/mwg-drift-check.md promises that a stale registry can never silently
// disable reversal detection; this pins that an empty one cannot either.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const here = fileURLToPath(import.meta.url);
const CLI = join(repoRoot, 'tests', 'mwg-drift-classify.mjs');
const FIXTURES = join(repoRoot, 'tests', 'fixtures', 'mwg-drift');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const runCli = (args) => new Promise((resolveRun) => {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  child.once('close', (code) => resolveRun({ code, out, err }));
});

export async function testMwgDriftBasisFloor() {
  const tmp = mkdtempSync(join(tmpdir(), 'web-uplift-uxr-'));
  const corpusOld = join(FIXTURES, 'corpus-old.json');
  const reversal = join(FIXTURES, 'corpus-new-reversal.json');
  const goodBasis = join(FIXTURES, 'basis-fixture.json');
  const empty = join(tmp, 'basis-empty.json');
  const missing = join(tmp, 'basis-missing-rules.json');
  writeFileSync(empty, `${JSON.stringify({ catalogueVersion: '1.0.0', rules: [] }, null, 2)}\n`, 'utf8');
  writeFileSync(missing, `${JSON.stringify({ catalogueVersion: '1.0.0' }, null, 2)}\n`, 'utf8');
  try {
    // 1. THE CONTROL: with the fixture registry the reversal IS detected, so the refusal below is
    // not simply "classification always fails".
    const control = await runCli(['--verify-basis', corpusOld, '--basis', goodBasis]);
    assert(control.code === 0, `the fixture registry must still verify: ${control.code} ${control.err}`);
    assert(/1 rule\(s\) verified/.test(control.out), `verification must report the rule it checked: ${control.out}`);
    const controlClassify = await runCli(['--old-corpus', corpusOld, '--new-corpus', reversal, '--basis', goodBasis, '--json']);
    assert(controlClassify.code === 2, `the fixture registry must report the delta: ${controlClassify.code} ${controlClassify.err}`);
    const summary = JSON.parse(controlClassify.out.trim().split('\n').slice(-1)[0]);
    assert(summary.reversed.length === 1, `the fixture registry must detect the reversal: ${JSON.stringify(summary.reversed)}`);

    // 2. An empty registry is refused by verification...
    const emptyVerify = await runCli(['--verify-basis', corpusOld, '--basis', empty]);
    assert(emptyVerify.code === 1, `an empty registry must not verify OK: exit ${emptyVerify.code} ${emptyVerify.out}`);
    assert(/declares no rules/.test(emptyVerify.err) && /REVERSED/.test(emptyVerify.err),
      `the refusal must name the empty registry and what it disables: ${emptyVerify.err}`);

    // 3. ...and by classification, which is the one that mattered: refusing here is what stops a
    // reversal from being silently reported as an ordinary change.
    const emptyClassify = await runCli(['--old-corpus', corpusOld, '--new-corpus', reversal, '--basis', empty, '--json']);
    assert(emptyClassify.code === 1,
      `classification must refuse an empty registry rather than downgrade the reversal: exit ${emptyClassify.code} ${emptyClassify.out}`);
    assert(!/CHANGED \(1\)/.test(emptyClassify.out), `no classification output may be produced: ${emptyClassify.out}`);

    // 4. THE SAME SILENT LOSS, ONE LEVEL UP: a rule whose guide is missing from the baseline
    // cannot notice that guide's text moving upstream. Verification failed loud over this while
    // classification ran on and re-filed the reversal as a change, so both are pinned here.
    const absent = join(tmp, 'basis-absent-guide.json');
    writeFileSync(absent, `${JSON.stringify({
      catalogueVersion: '1.0.0',
      rules: [{ id: 'r-absent', guide: 'a-guide-that-is-not-in-the-corpus', where: 'nowhere', anchors: ['any anchor text'] }],
    }, null, 2)}\n`, 'utf8');
    const absentVerify = await runCli(['--verify-basis', corpusOld, '--basis', absent]);
    assert(absentVerify.code === 1 && /does not exist in corpus/.test(absentVerify.err),
      `verification must refuse a rule whose guide is missing: ${absentVerify.code} ${absentVerify.err}`);
    const absentClassify = await runCli(['--old-corpus', corpusOld, '--new-corpus', reversal, '--basis', absent, '--json']);
    assert(absentClassify.code === 1 && /basis-vs-corpus violation/.test(absentClassify.err),
      `classification must refuse it too instead of downgrading the reversal to a change: ${absentClassify.code} ${absentClassify.out}${absentClassify.err}`);
    assert(!/CHANGED \(1\)/.test(absentClassify.out), `no classification output may be produced: ${absentClassify.out}`);

    // 5. A registry with no rules field at all is refused too, and the message distinguishes the
    // two cases rather than lumping them together.
    const noField = await runCli(['--verify-basis', corpusOld, '--basis', missing]);
    assert(noField.code === 1 && /rules field must be an array/.test(noField.err),
      `a registry without a rules field must be refused by name: ${noField.code} ${noField.err}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`${here.split('/').slice(-2).join('/')}: tests OK`);
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  await testMwgDriftBasisFloor();
}
