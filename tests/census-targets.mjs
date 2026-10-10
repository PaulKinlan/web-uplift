#!/usr/bin/env node
// web-uplift-310q: every target a STATIC CENSUS declares must resolve to a tracked path.
//
// Why this exists. A static census reads source text and asserts an invariant about it, so its
// correctness depends on the files it names being the files it means. web-uplift-v062 fixed one
// instance by hand: the log-url census listed .web-uplift/runner/run-batch.mjs, which lives in a
// generated and gitignored tree, so on any clean checkout the census died with ENOENT instead of
// reporting on the code. This generalises that fix from one census to all of them.
//
// The design follows from how censuses actually declare their targets, which I checked rather than
// assumed. There is exactly ONE literal target list in this repo - tests/log-redaction.mjs's
// `const targets = [...]` - and the await census in tests/evidence.test.mjs does not have one at all;
// it WALKS evidence/ and so cannot name a generated file. A generic sweep of every array literal in
// tests/ would therefore be mostly false positives, so the registry below is explicit.
//
// The failure mode this guard must not have is the one web-uplift-uxr named: a registry that can
// detect nothing is not a registry. If a census is renamed or its list restructured, a lazy guard
// would extract zero targets and pass. So an extraction that yields fewer targets than the registry
// declares is ITSELF a failure, with its own message - the guard fails when it cannot see.
//
// And because "fails when it cannot see" is itself a claim, the guard is tested against a control:
// checkTarget() must REJECT a known-generated path. Without that, the whole file could pass by
// returning success unconditionally, which is the defect class this lane keeps being corrected for.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Each entry names a census, how to find the paths it scans, and how many it must yield. `min` is
// asserted, not advisory: fewer matches than declared means the extraction stopped working.
export const CENSUSES = [
  {
    file: 'tests/log-redaction.mjs',
    // `const targets = ['runner/run-batch.mjs', 'fixer/fix.mjs'];`
    extract: /const targets = \[([^\]]*)\]/,
    min: 2,
  },
];

function extractTargets(source, pattern) {
  const match = source.match(pattern);
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
}

// A path is acceptable when git reports it as tracked. `--error-unmatch` makes git exit non-zero for
// a path it does not know, and that covers both "does not exist" and "exists but is ignored" without
// this guard having to reimplement ignore rules.
export function checkTarget(target, { cwd = repoRoot } = {}) {
  const res = spawn('git', ['ls-files', '--error-unmatch', '--', target], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = [];
  res.stderr.on('data', (chunk) => err.push(String(chunk)));
  return new Promise((resolve) => {
    res.on('error', (e) => resolve({ ok: false, why: `could not run git: ${e.message}` }));
    res.on('close', (code) => resolve(code === 0
      ? { ok: true }
      : { ok: false, why: `git does not track this path: ${err.join('').trim() || `exit ${code}`}` }));
  });
}

export async function testCensusTargetsAreTracked() {
  const problems = [];
  let totalChecked = 0;

  // The registry must be able to fail. If an extractor stops matching, that is a defect in this
  // guard's ability to see, not silence to be reported as success.
  for (const census of CENSUSES) {
    let source;
    try {
      source = readFileSync(join(repoRoot, census.file), 'utf8');
    } catch (err) {
      problems.push(`${census.file}: registered census cannot be read, so its targets are unchecked (${err.message})`);
      continue;
    }
    const targets = extractTargets(source, census.extract);
    if (targets.length < census.min) {
      problems.push(`${census.file}: extracted ${targets.length} target(s) but the registry declares at least ${census.min}. A rename or a restructure has blinded this guard; fix the extractor rather than lowering the number (web-uplift-310q).`);
      continue;
    }
    for (const target of targets) {
      totalChecked += 1;
      const verdict = await checkTarget(target);
      if (!verdict.ok) {
        problems.push(`${census.file}: target '${target}' is not a tracked path, so the census reads a file that may not exist on a clean checkout (${verdict.why}). This is the web-uplift-v062 failure; point the census at a tracked source, or drop the target.`);
      }
    }
  }

  // THE CONTROL. A guard whose checker accepts everything passes every test above while detecting
  // nothing. This asserts the checker can tell a tracked path from a generated one, so a future
  // loosening of checkTarget() fails HERE rather than silently disarming the whole file.
  const tracked = await checkTarget('tests/log-redaction.mjs');
  assert(tracked.ok, 'control: the checker must accept a path that is tracked');
  const generated = await checkTarget('.web-uplift/runner/run-batch.mjs');
  assert(!generated.ok,
    'control: the checker must REJECT a generated/gitignored path, or this guard cannot tell clean from blind');

  assert(problems.length === 0,
    `census target guard: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
  // Report what was actually examined: a guard that checked nothing should be visible as such.
  console.log(`census targets OK: ${totalChecked} target(s) across ${CENSUSES.length} registered census(es) resolve to tracked paths, and the checker rejected a generated path`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await testCensusTargetsAreTracked();
}
