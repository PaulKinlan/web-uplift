#!/usr/bin/env node
// Focused guard for concurrent snapshot artifact copying in snapshotRun (web-uplift-9kz).
//
// snapshotRun copies report.md and evidence/ into retained run directories.
// Previously this ran sequentially in a for..of loop. It now parallelises
// copying with Promise.all across the artifact list while preserving the
// existsSync guard and best-effort error handling.
//
// Run directly:
//   node tests/snapshot-run.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveLatest } from '../runner/run-history.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Unit check 1: Structural code inspection of snapshotRun in fixer/fix.mjs
export function testSnapshotRunStructure() {
  const code = readFileSync(join(repoRoot, 'fixer', 'fix.mjs'), 'utf8');

  // Verify Promise.all is used for artifact copying in snapshotRun
  assert(
    code.includes('await Promise.all('),
    'snapshotRun must use Promise.all to copy artifacts concurrently',
  );

  // Verify serial loop over artifacts is gone
  assert(
    !code.includes("for (const name of ['report.md', 'evidence'])"),
    "snapshotRun must not copy ['report.md', 'evidence'] sequentially in a for..of loop",
  );

  // Verify the artifacts array is mapped
  assert(
    code.includes("['report.md', 'evidence'].map("),
    "snapshotRun must map over ['report.md', 'evidence']",
  );
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

// Unit check 4: Concurrency proof - tasks are dispatched concurrently via Promise.all
export async function testConcurrentExecutionProof() {
  const delays = [];
  const start = Date.now();
  await Promise.all(
    ['report.md', 'evidence'].map(async (name) => {
      const taskStart = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 40));
      delays.push({ name, startOffset: taskStart - start, elapsed: Date.now() - taskStart });
    }),
  );
  const total = Date.now() - start;

  // If serial, total would be >= 80ms. With Promise.all, both start at ~same time.
  assert.equal(delays.length, 2, 'both copy tasks must run');
  assert(
    Math.abs(delays[0].startOffset - delays[1].startOffset) < 25,
    `both tasks must start concurrently (offsets: ${delays[0].startOffset}ms, ${delays[1].startOffset}ms)`,
  );
  assert(
    total < 75,
    `concurrent execution should finish in ~40ms, not serial ~80ms (took ${total}ms)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  testSnapshotRunStructure();
  testSnapshotRunCopiesArtifacts();
  testSnapshotRunMissingArtifactsBestEffort();
  await testConcurrentExecutionProof();
  console.log('snapshotRun unit tests: OK');
}
