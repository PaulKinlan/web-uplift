#!/usr/bin/env node
// A/B PERMISSION PROBE for web-uplift-7tj (real-engine evidence, step 6).
//
// CLAIM UNDER TEST: the NEW derived allowlist (SKILL_REQUIRED_COMMANDS ->
// headlessBashRules, commit 5a04a88) admits all six command forms the OLD
// allowlist (the scoped list from e2138c9, as of 5a04a88^) denied, and the old
// one denies them - proven through the REAL `claude` CLI spawned with the SAME
// production argv shape runner/run-batch.mjs uses:
//
//   claude -p <prompt> --output-format json --max-turns N \
//     --allowedTools 'Read,Write,Edit,Glob,Grep,<rules>'   (cwd = project root)
//
// The probe asks the model to attempt each of the six commands with Bash
// exactly once (no retries, no other tools). Verdict sources:
//   1. the model's own six-line report (ALLOWED/DENIED per command), and
//   2. the machine-recorded `permission_denials` array in the result JSON.
// A usage message or nonzero exit is EXECUTED (= allowed by the sandbox);
// only a permission/approval error is DENIED.
//
// Run: node evidence-out/web-uplift-7tj/ab-probe.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from '../../runner/agents.mjs';

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

// The OLD allowlist, verbatim from 5a04a88^ (git show 5a04a88^:runner/agents.mjs).
const OLD_RULES = [
  'Read,Write,Edit,Glob,Grep',
  'Bash(node evidence/cli.mjs:*)',
  'Bash(node .web-uplift/evidence/cli.mjs:*)',
  'Bash(npx -y --ignore-scripts modern-web-guidance@0.0.172:*)',
  'Bash(mkdir:*)',
  'Bash(ffmpeg:*)',
].join(',');

// The six previously-denied forms: the five scripts the old list simply did
// not name (validator, compare, scorecard, baseline oracle, journey replay),
// plus the ABSOLUTE-PATH spelling of the evidence CLI the old prefix rules
// missed. All are harmless with these args (usage output / clean error).
const ABS_CLI = join(repoRoot, 'evidence/cli.mjs');
const COMMANDS = [
  `node schema/validate-report.mjs knowledge/principles.json`,
  `node aggregate/compare.mjs example.invalid`,
  `node aggregate/scorecard.mjs example.invalid`,
  `node knowledge/baseline.mjs --json`,
  `node runner/flow.mjs --help`,
  `node ${ABS_CLI} --help`,
];

const prompt =
  'You are verifying Bash tool permissions. Attempt each of the following ' +
  'six commands with the Bash tool, exactly as written, one Bash call per ' +
  'command, in order. Do not run anything else, do not retry a command, do ' +
  'not use any other tool. A usage message, a missing-file error or a nonzero ' +
  'exit code still counts as EXECUTED; ONLY a permission/approval error (the ' +
  'tool was not allowed to run the command) counts as DENIED. After the sixth ' +
  'attempt, reply with exactly six lines, one per command in order, each of ' +
  'the form `N: ALLOWED` or `N: DENIED`, and nothing else.\n\n' +
  COMMANDS.map((c, i) => `${i + 1}. ${c}`).join('\n');

function run(label, allowedTools) {
  // Production argv shape: AGENTS.claude.args(prompt, { maxTurns, root }) as
  // called by runner/run-batch.mjs (cwd = projectRoot), with the --allowedTools
  // value swapped for the arm under test. maxTurns only bounds turns, not
  // permission semantics.
  const argv = AGENTS.claude.args(prompt, { maxTurns: 30, root: repoRoot });
  const i = argv.indexOf('--allowedTools');
  const argvArm = [...argv.slice(0, i), '--allowedTools', allowedTools, ...argv.slice(i + 2)];
  const t0 = Date.now();
  const r = spawnSync('claude', argvArm, { encoding: 'utf8', cwd: repoRoot, timeout: 5 * 60_000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.error) throw new Error(`${label}: claude failed to spawn: ${r.error.message}`);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* keep raw stdout below */ }
  return {
    label,
    argv: argvArm.join(' '),
    exitCode: r.status,
    seconds: Number(secs),
    numTurns: parsed?.num_turns ?? null,
    result: parsed?.result ?? r.stdout,
    permissionDenials: parsed?.permission_denials ?? null,
    isError: parsed?.is_error ?? null,
    raw: parsed ? undefined : (r.stdout + r.stderr),
  };
}

mkdirSync(join(repoRoot, 'evidence-out/web-uplift-7tj'), { recursive: true });

const oldArm = run('OLD allowlist (5a04a88^)', OLD_RULES);
writeFileSync('evidence-out/web-uplift-7tj/ab-old-allowlist.json', JSON.stringify(oldArm, null, 2));

// The NEW allowlist exactly as production derives it for this root.
const prodArgs = AGENTS.claude.args('x', { maxTurns: 30, root: repoRoot });
const NEW_RULES = prodArgs[prodArgs.indexOf('--allowedTools') + 1];
const newArm = run('NEW allowlist (5a04a88, derived)', NEW_RULES);
writeFileSync('evidence-out/web-uplift-7tj/ab-new-allowlist.json', JSON.stringify(newArm, null, 2));

function verdicts(arm) {
  const lines = String(arm.result).split('\n').filter((l) => /^\s*\d:\s*(ALLOWED|DENIED)/.test(l));
  return lines.map((l) => l.trim());
}

console.log('=== OLD allowlist arm ===');
console.log('exit=%s turns=%s secs=%s', oldArm.exitCode, oldArm.numTurns, oldArm.seconds);
console.log('permission_denials:', JSON.stringify(oldArm.permissionDenials));
console.log(verdicts(oldArm).join('\n'));
console.log('=== NEW allowlist arm ===');
console.log('exit=%s turns=%s secs=%s', newArm.exitCode, newArm.numTurns, newArm.seconds);
console.log('permission_denials:', JSON.stringify(newArm.permissionDenials));
console.log(verdicts(newArm).join('\n'));

const oldV = verdicts(oldArm);
const newV = verdicts(newArm);
const pass =
  oldV.length === 6 && oldV.every((l) => l.endsWith('DENIED')) &&
  newV.length === 6 && newV.every((l) => l.endsWith('ALLOWED')) &&
  Array.isArray(oldArm.permissionDenials) && oldArm.permissionDenials.length > 0 &&
  Array.isArray(newArm.permissionDenials) && newArm.permissionDenials.length === 0;
console.log(pass ? 'A/B RESULT: PASS (old denies all six, new admits all six)' : 'A/B RESULT: SEE OUTPUTS ABOVE');
process.exitCode = pass ? 0 : 1;
