#!/usr/bin/env node
// Focused guard for snapshot artifact copying in snapshotRun (web-uplift-9kz / web-uplift-lde).
//
// snapshotRun preserves report.json and copies optional auxiliary artifacts
// (report.md and evidence/) into retained run directories. Auxiliary artifact
// copying is best-effort and independent: missing or failed auxiliary copies
// do not prevent report.json or other valid artifacts from being preserved.
//
// Run directly:
//   timeout -k 30 15 node tests/snapshot-run.mjs
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveLatest } from '../runner/run-history.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Unit check 1: Behavioural structure verification of snapshotRun in fixer/fix.mjs.
// Asserts that partial auxiliary artifact sets (only report.md, or only evidence/)
// structure the retained run directory correctly without cross-artifact dependencies.
export function testSnapshotRunStructure() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-snapshot-struct-'));
  try {
    const baseReport = JSON.parse(readFileSync(join(repoRoot, 'examples', 'playground-report.json'), 'utf8'));

    // Case A: source has only report.md (no evidence/ directory)
    const srcA = join(root, 'src-a');
    mkdirSync(srcA, { recursive: true });
    writeFileSync(join(srcA, 'report.json'), JSON.stringify(baseReport, null, 2) + '\n');
    writeFileSync(join(srcA, 'report.md'), '# Markdown only\n');

    const reportsA = join(root, 'reports-a');
    spawnSync(
      process.execPath,
      [
        join(repoRoot, 'fixer', 'fix.mjs'),
        '--target', join(root, 'target-a'),
        '--audit-url', 'http://example.test/',
        '--findings', join(srcA, 'report.json'),
        '--max-iterations', '0',
        '--out', join(root, 'out-a'),
        '--reports-root', reportsA,
      ],
      { encoding: 'utf8' },
    );

    const hostA = join(reportsA, 'example_test');
    assert(existsSync(hostA), `Expected host dir ${hostA} to exist`);
    const beforeA = join(hostA, readdirSync(hostA).find((d) => d.endsWith('-before')));
    assert(existsSync(join(beforeA, 'report.json')), 'report.json must exist in run dir');
    assert(existsSync(join(beforeA, 'report.md')), 'report.md must exist in run dir');
    assert.equal(readFileSync(join(beforeA, 'report.md'), 'utf8'), '# Markdown only\n');
    assert(!existsSync(join(beforeA, 'evidence')), 'evidence must not exist when absent in source');

    // Case B: source has only evidence/ directory (no report.md)
    const srcB = join(root, 'src-b');
    mkdirSync(join(srcB, 'evidence'), { recursive: true });
    writeFileSync(join(srcB, 'report.json'), JSON.stringify(baseReport, null, 2) + '\n');
    writeFileSync(join(srcB, 'evidence', 'probe.txt'), 'probe-data');

    const reportsB = join(root, 'reports-b');
    spawnSync(
      process.execPath,
      [
        join(repoRoot, 'fixer', 'fix.mjs'),
        '--target', join(root, 'target-b'),
        '--audit-url', 'http://example.test/',
        '--findings', join(srcB, 'report.json'),
        '--max-iterations', '0',
        '--out', join(root, 'out-b'),
        '--reports-root', reportsB,
      ],
      { encoding: 'utf8' },
    );

    const hostB = join(reportsB, 'example_test');
    assert(existsSync(hostB), `Expected host dir ${hostB} to exist`);
    const beforeB = join(hostB, readdirSync(hostB).find((d) => d.endsWith('-before')));
    assert(existsSync(join(beforeB, 'report.json')), 'report.json must exist in run dir');
    assert(existsSync(join(beforeB, 'evidence', 'probe.txt')), 'evidence/probe.txt must exist in run dir');
    assert.equal(readFileSync(join(beforeB, 'evidence', 'probe.txt'), 'utf8'), 'probe-data');
    assert(!existsSync(join(beforeB, 'report.md')), 'report.md must not exist when absent in source');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Unit check 2: Functional end-to-end execution of snapshotRun via fixer/fix.mjs
export function testSnapshotRunCopiesArtifacts() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-snapshot-run-'));
  try {
    const srcDir = join(root, 'source-report');
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(join(srcDir, 'evidence'), { recursive: true });

    // Populate source directory with a real playground report, report.md, and evidence files
    const baseReport = JSON.parse(readFileSync(join(repoRoot, 'examples', 'playground-report.json'), 'utf8'));
    writeFileSync(join(srcDir, 'report.json'), JSON.stringify(baseReport, null, 2) + '\n');
    writeFileSync(join(srcDir, 'report.md'), '# Sample Audit Report\nEvidence summary.\n');
    writeFileSync(join(srcDir, 'evidence', 'screenshot.png'), 'fake-png-data');
    writeFileSync(join(srcDir, 'evidence', 'network.json'), '{"requests": []}');

    const targetDir = join(root, 'target-src');
    mkdirSync(targetDir, { recursive: true });
    const outDir = join(root, 'out');
    const reportsDir = join(root, 'reports');

    // Run fixer/fix.mjs with --findings and --max-iterations 0
    // This directly invokes snapshotRun for both before and after runs without spawning agents.
    spawnSync(
      process.execPath,
      [
        join(repoRoot, 'fixer', 'fix.mjs'),
        '--target', targetDir,
        '--audit-url', 'http://example.test/',
        '--findings', join(srcDir, 'report.json'),
        '--max-iterations', '0',
        '--out', outDir,
        '--reports-root', reportsDir,
      ],
      { encoding: 'utf8' },
    );

    // Check that reports/example_test exists and has retained runs
    const hostDir = join(reportsDir, 'example_test');
    assert(existsSync(hostDir), `Expected host dir ${hostDir} to exist`);

    // snapshotRun preserves baseline at <runId>-before from srcDir
    const runDirs = readdirSync(hostDir);
    const beforeRunName = runDirs.find((d) => d.endsWith('-before'));
    assert(beforeRunName, `Expected a -before run dir in ${JSON.stringify(runDirs)}`);
    const beforeRunDir = join(hostDir, beforeRunName);

    assert(
      existsSync(join(beforeRunDir, 'report.json')),
      'baseline run must contain report.json',
    );
    assert(
      existsSync(join(beforeRunDir, 'report.md')),
      'baseline run must contain report.md copied by snapshotRun',
    );
    assert(
      existsSync(join(beforeRunDir, 'evidence', 'screenshot.png')),
      'baseline run must contain evidence/screenshot.png copied by snapshotRun',
    );
    assert(
      existsSync(join(beforeRunDir, 'evidence', 'network.json')),
      'baseline run must contain evidence/network.json copied by snapshotRun',
    );

    // Verify file contents match
    assert.equal(
      readFileSync(join(beforeRunDir, 'report.md'), 'utf8'),
      '# Sample Audit Report\nEvidence summary.\n',
      'report.md content must match source',
    );
    assert.equal(
      readFileSync(join(beforeRunDir, 'evidence', 'screenshot.png'), 'utf8'),
      'fake-png-data',
      'evidence/screenshot.png content must match source',
    );
    assert.equal(
      readFileSync(join(beforeRunDir, 'evidence', 'network.json'), 'utf8'),
      '{"requests": []}',
      'evidence/network.json content must match source',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Unit check 3: Missing artifacts handled gracefully (best effort)
export function testSnapshotRunMissingArtifactsBestEffort() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-snapshot-missing-'));
  try {
    const srcDir = join(root, 'source-report-bare');
    mkdirSync(srcDir, { recursive: true });

    // ONLY report.json, no report.md and no evidence directory
    const baseReport = JSON.parse(readFileSync(join(repoRoot, 'examples', 'playground-report.json'), 'utf8'));
    writeFileSync(join(srcDir, 'report.json'), JSON.stringify(baseReport, null, 2) + '\n');

    const targetDir = join(root, 'target-src');
    mkdirSync(targetDir, { recursive: true });
    const outDir = join(root, 'out');
    const reportsDir = join(root, 'reports');

    spawnSync(
      process.execPath,
      [
        join(repoRoot, 'fixer', 'fix.mjs'),
        '--target', targetDir,
        '--audit-url', 'http://example.test/',
        '--findings', join(srcDir, 'report.json'),
        '--max-iterations', '0',
        '--out', outDir,
        '--reports-root', reportsDir,
      ],
      { encoding: 'utf8' },
    );

    const hostDir = join(reportsDir, 'example_test');
    assert(existsSync(hostDir), `Expected host dir ${hostDir} to exist`);
    const latestRunDir = resolveLatest(hostDir);
    assert(latestRunDir, 'resolveLatest should resolve the latest run directory');

    assert(
      existsSync(join(latestRunDir, 'report.json')),
      'retained run must still write report.json even when optional artifacts are absent',
    );
    assert(
      !existsSync(join(latestRunDir, 'report.md')),
      'report.md should not exist in destination if not in source',
    );
    assert(
      !existsSync(join(latestRunDir, 'evidence')),
      'evidence should not exist in destination if not in source',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Unit check 4: Auxiliary copy error tolerance (swallowed by design)
export function testSnapshotRunCopyErrorTolerance() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-snapshot-err-'));
  const lockedFile = join(root, 'source-report', 'evidence', 'locked.bin');
  try {
    const srcDir = join(root, 'source-report');
    mkdirSync(join(srcDir, 'evidence'), { recursive: true });

    const baseReport = JSON.parse(readFileSync(join(repoRoot, 'examples', 'playground-report.json'), 'utf8'));
    writeFileSync(join(srcDir, 'report.json'), JSON.stringify(baseReport, null, 2) + '\n');
    writeFileSync(join(srcDir, 'report.md'), '# Tolerant Report\n');
    writeFileSync(lockedFile, 'unreadable');
    chmodSync(lockedFile, 0o000);

    const targetDir = join(root, 'target-src');
    mkdirSync(targetDir, { recursive: true });
    const outDir = join(root, 'out');
    const reportsDir = join(root, 'reports');

    spawnSync(
      process.execPath,
      [
        join(repoRoot, 'fixer', 'fix.mjs'),
        '--target', targetDir,
        '--audit-url', 'http://example.test/',
        '--findings', join(srcDir, 'report.json'),
        '--max-iterations', '0',
        '--out', outDir,
        '--reports-root', reportsDir,
      ],
      { encoding: 'utf8' },
    );

    const hostDir = join(reportsDir, 'example_test');
    assert(existsSync(hostDir), `Expected host dir ${hostDir} to exist`);
    const runDirs = readdirSync(hostDir);
    const beforeRunName = runDirs.find((d) => d.endsWith('-before'));
    assert(beforeRunName, `Expected a -before run dir in ${JSON.stringify(runDirs)}`);
    const beforeRunDir = join(hostDir, beforeRunName);

    // report.json and report.md must be preserved despite evidence copy failure
    assert(existsSync(join(beforeRunDir, 'report.json')), 'baseline run must contain report.json');
    assert(existsSync(join(beforeRunDir, 'report.md')), 'report.md must still be copied despite evidence error');
    assert.equal(readFileSync(join(beforeRunDir, 'report.md'), 'utf8'), '# Tolerant Report\n');

    // The consequence of swallowing the auxiliary copy error is that the climb
    // completes: the retained -after run and its before -> after comparison exist.
    // If the error propagated, snapshotRun would throw on the baseline snapshot and
    // the -after run (created only after it) would never be written.
    const afterRunName = runDirs.find((d) => d.endsWith('-after'));
    assert(afterRunName, `Expected a -after run dir in ${JSON.stringify(runDirs)}`);
    assert(
      existsSync(join(hostDir, afterRunName, 'compare.md')),
      'the -after run must contain compare.md, proving the evidence copy error did not abort the climb',
    );
  } finally {
    try { chmodSync(lockedFile, 0o644); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  testSnapshotRunStructure();
  testSnapshotRunCopiesArtifacts();
  testSnapshotRunMissingArtifactsBestEffort();
  testSnapshotRunCopyErrorTolerance();
  console.log('snapshotRun unit tests: OK');
}
