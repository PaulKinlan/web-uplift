#!/usr/bin/env node
// web-uplift-4m2: the refusal is flag-based, not pointer authentication.
// A host-slug-correct planted pointer must be consulted in the isolated path,
// demonstrating the exact residual that the refusal and help text disclose.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  testBatchResumeIsolation();
  console.log('batch resume isolation: ok');
}
