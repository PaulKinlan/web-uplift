#!/usr/bin/env node
// web-uplift-lp5z: every path-valued READ flag in the evidence CLI is contained inside the
// workspace root (the CLI's working directory - the audited workspace, the only root a legitimate
// caller needs). The flags are agent-supplied: a flow or an agent can point the tool at any file
// on the machine and have its contents read into a committed artifact, so containment is enforced
// at PARSE time (before any browser launch), realpath-based (a symlink inside the root pointing
// out is refused), and the root is stated in the error so a user can fix the invocation.
//
// Enumerated path-valued flags: --source, --expr-file, --interact-file (reads, contained here),
// and --out (a WRITE destination - it does not read machine content into artifacts, so it is not
// this disclosure primitive; refusing operator-chosen absolute out paths would break real use).
// --out is documented rather than contained; the next path-valued READ flag lands in this file.

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const CLI_PATH = fileURLToPath(new URL('../evidence/cli.mjs', import.meta.url));

function runCliAsync(args, cwd, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cp.kill('SIGKILL');
      reject(new Error(`cli execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    cp.stdout.on('data', (chunk) => { stdout += chunk; });
    cp.stderr.on('data', (chunk) => { stderr += chunk; });
    cp.on('error', (err) => { clearTimeout(timer); reject(err); });
    cp.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

const REFUSAL_MARKER = 'must be inside the workspace root';

// One fixture workspace per case: cwd IS the allowed root, so the tests also pin that the
// containment is relative to the caller's workspace, not to any hard-coded path.
function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'web-uplift-pathroot-'));
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'app.js'), 'export const app = "legit";\n');
  return ws;
}

async function expectRefusal(flag, value, label, preparedWs = null) {
  const ws = preparedWs ?? makeWorkspace();
  try {
    // about:blank needs the scheme opt-in to even parse as a target; the containment refusal must
    // fire BEFORE any of that - the CLI must exit with the root-naming error and no browser spin.
    const res = await runCliAsync(['dom', 'about:blank', '--allow-scheme', 'about', flag, value, '--quiet'], ws);
    assert(res.status !== 0, `${label}: the CLI must refuse (exit ${res.status})`);
    assert(res.stderr.includes(REFUSAL_MARKER), `${label}: the refusal must name the workspace root: ${res.stderr.slice(-300)}`);
    assert(res.stderr.includes(flag), `${label}: the refusal must name the flag: ${res.stderr.slice(-300)}`);
  } finally {
    if (!preparedWs) rmSync(ws, { recursive: true, force: true });
  }
}

// 1. Absolute path outside the root.
export async function testAbsoluteOutsideRootRefused() {
  const outside = mkdtempSync(join(tmpdir(), 'web-uplift-pathroot-out-'));
  const secret = join(outside, 'secret.js');
  writeFileSync(secret, 'const stolen = "TOPSECRET";\n');
  try {
    await expectRefusal('--expr-file', secret, 'absolute outside root');
    await expectRefusal('--source', outside, 'absolute outside root (--source)');
    await expectRefusal('--interact-file', secret, 'absolute outside root (--interact-file)');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}

// 2. Relative path escaping with '..'.
export async function testDotDotEscapeRefused() {
  const ws = makeWorkspace();
  try {
    // A relative '..' escape from the workspace: resolve('..') from cwd lands outside the root.
    await expectRefusal('--expr-file', join('..', 'definitely-not-the-workspace', 'secret.js'), "'..' escape");
    await expectRefusal('--source', '../..', "'..' escape (--source)");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

// 3. Symlink INSIDE the root pointing out.
export async function testSymlinkOutRefused() {
  const ws = makeWorkspace();
  const outside = mkdtempSync(join(tmpdir(), 'web-uplift-pathroot-sym-'));
  const secret = join(outside, 'secret.js');
  writeFileSync(secret, 'const stolen = "TOPSECRET";\n');
  symlinkSync(secret, join(ws, 'src', 'innocent.js'));
  try {
    await expectRefusal('--expr-file', join('src', 'innocent.js'), 'symlink inside root pointing out', ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

// 4. A trailing separator must not sneak a path past the containment check.
export async function testTrailingSeparatorRefused() {
  const outside = mkdtempSync(join(tmpdir(), 'web-uplift-pathroot-sep-'));
  try {
    await expectRefusal('--source', `${outside}/`, 'trailing separator outside root');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}

// 5. THE LEGITIMATE USE MUST STILL WORK: an in-root relative source path passes the containment
// gate (the run then fails later at the browser step, which this sandbox has no server for - the
// assertion is that the failure is NOT the containment refusal).
export async function testInRootSourceStillAccepted() {
  const ws = makeWorkspace();
  try {
    const res = await runCliAsync(['dom', 'about:blank', '--allow-scheme', 'about', '--source', 'src', '--quiet'], ws);
    assert(!res.stderr.includes(REFUSAL_MARKER), `an in-root source dir must pass containment: ${res.stderr.slice(-300)}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

const cases = [
  testAbsoluteOutsideRootRefused,
  testDotDotEscapeRefused,
  testSymlinkOutRefused,
  testTrailingSeparatorRefused,
  testInRootSourceStillAccepted,
];

let failed = 0;
for (const testCase of cases) {
  try {
    await testCase();
    console.log(`\u2714 ${testCase.name}`);
  } catch (err) {
    failed += 1;
    console.error(`\u2716 ${testCase.name}`);
    console.error(String(err.message || err));
  }
}
if (failed) {
  console.error(`${failed} case(s) failed`);
  process.exit(1);
}
console.log('all workspace-root containment cases passed');
