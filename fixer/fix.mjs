#!/usr/bin/env node
/**
 * web-uplift fix: the MODEL-DRIVEN hill-climb. NOT canned transforms.
 *
 *   npm run fix -- --target <dir> --audit-url <url> [--agent claude]
 *                  [--max-iterations 4] [--goal-overall 80] [--findings <path>] [--out <dir>]
 *                  [--dry-run] [--verbose]
 *
 * Mirrors the audit runner's design (runner/run-batch.mjs): it ORCHESTRATES,
 * it contains no transforms. Each iteration shells out to the SAME agent map
 * (runner/agents.mjs) and asks the model to follow .claude/skills/web-audit/
 * SKILL.md in FIX mode. The model reads the aggregated findings + task list,
 * retrieves Modern Web Guidance, writes the edits into --target itself, then
 * re-audits. We loop, reading report.json after each pass, until the audit
 * passes (no outstanding `issues` AND every check concluded;
 * `not-applicable`/`opted-out` are fine) or --max-iterations is hit.
 * Per-iteration finding and unconcluded-check counts are printed so the
 * hill-climb is visible.
 *
 * HEADLESS / CI PATH (uses API tokens). For an INDIVIDUAL the subscription
 * default is to run the fix loop INSIDE your own agent session by following
 * SKILL.md section 7 (see README "Run it in your agent"); this orchestrator is
 * for unattended runs.
 *
 * Flow:
 *   1. Get findings: use --findings if supplied, else run/aggregate an audit of
 *      --audit-url first (report mode) and aggregate it.
 *   2. Hill-climb: per iteration, drive the model (FIX mode) over --target, then
 *      re-audit --audit-url and read the fresh report.json.
 *   3. Stop when issues == 0 AND atomic coverage is complete, or when
 *      --max-iterations is reached. Honour web-uplift.json opt-outs /
 *      not-applicable (those never count as outstanding issues). A run carrying
 *      blocked or not-run checks is PARTIAL and cannot pass on findings alone -
 *      the atomic coverage contract calls unconcluded checks incomplete work,
 *      never a pass.
 *   4. Snapshot the baseline (`<runId>-before`) and final (`<runId>-after`) into
 *      RETAINED run dirs under reports/<host>/ and emit the before -> after
 *      comparison automatically (audit -> fix -> re-audit -> compare), so a fix
 *      run shows the measurable before->after (status/finding/metric/network
 *      deltas + paired screenshots) in compare.md / compare.json.
 *
 * --dry-run prints the exact per-iteration command for the chosen agent (and,
 * with --agent all is NOT a thing here, you pass one agent) without spawning.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS, AGENT_NAMES } from '../runner/agents.mjs';
import { runDir, updateLatest, makeRunId } from '../runner/run-history.mjs';
import { compareReports, renderCompareMd } from '../aggregate/compare.mjs';
import { buildScorecardData, renderScorecard, scoreReport, evaluateGates } from '../aggregate/scorecard.mjs';

const args = parseArgs(process.argv.slice(2));

// --goal defines a SCORE target to hill-climb to, an alternative stop condition
// to "every issue fixed". Same shape as the CI gate:
//   --goal-overall <n>  --goal-min <outcome>=<n>  --goal-max-critical <n>  --goal-max-high <n>
// With no --goal-* flags the loop behaves as before (stop at zero issues).
function parseGoal(a) {
  const goal = { min: {} };
  let active = false;
  if (a['goal-overall'] != null) { goal.minOverall = Number(a['goal-overall']); active = true; }
  if (a['goal-max-critical'] != null) { goal.maxCritical = Number(a['goal-max-critical']); active = true; }
  if (a['goal-max-high'] != null) { goal.maxHigh = Number(a['goal-max-high']); active = true; }
  for (const g of [].concat(a['goal-min'] ?? [])) {
    const [key, n] = String(g).split('=');
    if (key && n != null) { goal.min[key] = Number(n); active = true; }
  }
  return { goal, active };
}

// Score summary for one report (single-report analogue of scorecardSummary).
//
// scoreReport REFUSES to score a report whose atomic coverage is incomplete,
// and that refusal is correct: the coverage contract says a partial run must
// never produce a score. But an unscoreable report is a legitimate INPUT to the
// hill-climb, not a crash. A run that is still partial (blocked or not-run
// checks), and every report written before the coverage contract existed (no
// `coverage` field at all), both land here. So we catch the refusal and report
// the report as unscoreable rather than letting it kill the fix run.
//
// Returns { scoreable, reason, summary }. `summary` is always the shape
// evaluateGates expects; when unscoreable its overall is null and its outcomes
// are empty. Severity counts come straight off the findings and stay accurate
// either way, because counting findings needs no coverage guarantee.
function reportSummarySafe(report) {
  const sev = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of report?.findings ?? []) if (sev[f.severity] != null) sev[f.severity]++;
  try {
    const s = scoreReport(report);
    return {
      scoreable: true,
      reason: null,
      summary: {
        overall: s.overall,
        outcomes: Object.fromEntries(s.outcomes.map((o) => [o.key, o.score])),
        findingsBySeverity: sev,
      },
    };
  } catch (err) {
    return {
      scoreable: false,
      reason: err.message,
      summary: { overall: null, outcomes: {}, findingsBySeverity: sev },
    };
  }
}

if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

const agentName = args.agent ?? 'claude';
const agent = AGENTS[agentName];
if (!agent) {
  console.error(`Unknown agent "${agentName}". Choose one of: ${AGENT_NAMES.join(', ')}`);
  process.exit(1);
}

const target = args.target;
const auditUrl = args['audit-url'];
const maxIterations = Number(args['max-iterations'] ?? 4);
const outDir = args.out ?? `reports/fix-${slugify(auditUrl ?? 'site')}`;
const verbose = Boolean(args.verbose);
const dryRun = Boolean(args['dry-run']);
const { goal, active: goalActive } = parseGoal(args);

if (!dryRun && (!target || !auditUrl)) {
  console.error(
    'fix requires --target <dir> and --audit-url <url>.\n' +
    'Run `web-uplift fix --help` for usage.'
  );
  process.exit(1);
}

// The model is the fixer. We build a FIX-mode prompt per iteration that points
// at the SAME canonical skill and passes the source + findings so the model has
// the task list and applies guidance-backed edits itself. `extra` is appended
// to the skill arguments by the shared prompt builders.
function fixExtra(findingsPath, iteration) {
  return (
    `--source ${target} --fix --findings ${findingsPath} ` +
    `--max-iterations 1 ` +
    `# hill-climb iteration ${iteration}: apply the highest-leverage ` +
    `guidance-backed fixes to the source under ${target} (you write the edits; ` +
    `no canned transforms), then re-audit ${auditUrl} and write report.json to ${outDir}`
  );
}

function iterationPrompt(findingsPath, iteration) {
  return agent.prompt(auditUrl ?? '<audit-url>', outDir, fixExtra(findingsPath ?? '<findings>', iteration));
}

if (dryRun) {
  console.log(`fix hill-climb (dry-run) via ${agentName}, max ${maxIterations} iteration(s)`);
  console.log(`target source : ${target ?? '<target>'}`);
  console.log(`audit url     : ${auditUrl ?? '<audit-url>'}`);
  console.log(`report out    : ${outDir}`);
  console.log('');
  console.log('Per-iteration command the model is driven with:');
  for (let i = 1; i <= maxIterations; i++) {
    const prompt = iterationPrompt(args.findings, i);
    const cliArgs = agent.args(prompt, { maxTurns: 120 });
    console.log(`  [iter ${i}] ${agent.bin} ${cliArgs.join(' ')}`);
  }
  console.log('');
  console.log('Equivalent commands for every agent (so adding one stays one entry):');
  for (const name of AGENT_NAMES) {
    const a = AGENTS[name];
    const prompt = a.prompt(auditUrl ?? '<audit-url>', outDir, fixExtra(args.findings ?? '<findings>', 1));
    console.log(`  ${name.padEnd(12)} ${a.bin} ${a.args(prompt, { maxTurns: 120 }).join(' ')}`);
  }
  process.exit(0);
}

await mkdir(outDir, { recursive: true });

// 1. Findings: supplied, or run an audit + aggregate first.
let findingsPath = args.findings;
if (!findingsPath) {
  console.log(`No --findings supplied; running a baseline audit of ${auditUrl} first.`);
  findingsPath = await baselineAudit();
}
const baseline = await readReport(findingsPath);
const startIssues = countOutstanding(baseline);
const baselineRemaining = remaining(baseline);
const goalOf = (report) => {
  if (!goalActive) return null;
  // Coverage first. A partial run must not meet a score goal, however good the
  // score on the checks it did manage to conclude.
  const completion = completionState(report);
  if (!completion.complete) return { passed: false, checks: [{ name: 'atomic coverage complete', ok: false, detail: completion.reasons.join(', ') }] };
  const { scoreable, reason, summary } = reportSummarySafe(report);
  // An unscoreable report can never MEET a score goal either. This has to be an
  // explicit failed check rather than a call into evaluateGates, because
  // evaluateGates reads a null outcome as not-applicable and PASSES it - so an
  // all-null summary from a partial report would otherwise satisfy every
  // --goal-min and let the climb stop on a target it never measured.
  if (!scoreable) return { passed: false, checks: [{ name: 'scoreable report', ok: false, detail: reason }] };
  return evaluateGates(summary, goal);
};
const scoreOf = (report) => reportSummarySafe(report).summary.overall;
console.log(`Baseline: ${startIssues} outstanding issue-findings to climb down.`);
if (!baselineRemaining.completion.complete) {
  console.log(`Coverage INCOMPLETE: ${baselineRemaining.completion.reasons.join(', ')}.`);
  console.log('This run is PARTIAL. It cannot pass on findings alone; the unconcluded checks are outstanding work.');
}
const baselineScore = reportSummarySafe(baseline);
if (!baselineScore.scoreable) {
  console.log(`Score unavailable: ${baselineScore.reason}`);
  console.log('Climbing on outstanding findings; scores read N/A until atomic coverage is complete.');
}
if (goalActive) {
  const g = goalOf(baseline);
  console.log(`Goal: hill-climb until met -> ${g.checks.map((c) => c.name).join(', ')}. Baseline score ${scoreOf(baseline) ?? 'N/A'}, goal ${g.passed ? 'ALREADY met' : 'not met'}.`);
}

// Snapshot the baseline into a RETAINED `before` run under reports/<host>/ so
// the final compare has the pre-fix state with its artifacts. The live working
// report stays at outDir/report.json for the iterations; we just preserve a copy.
const reportsRoot = args['reports-root'] ?? 'reports';
const beforeRun = runDir(reportsRoot, auditUrl, `${makeRunId()}-before`);
await snapshotRun(dirOf(findingsPath), beforeRun.dir, baseline);
updateLatest(beforeRun.hostRoot, beforeRun.runId);
console.log(`Preserved baseline run at ${beforeRun.dir}`);

// 2. Hill-climb. Stop condition is zero outstanding issues OR, when --goal is
// set, the score goal being met (so you can climb to "overall>=80, no critical"
// without chasing every last low-severity issue).
let lastRemaining = baselineRemaining;
const goalReached = (report) => goalActive && goalOf(report).passed;
// A clean climb needs BOTH: no outstanding findings, and every check concluded.
// Findings alone cannot see a check that never ran.
let passed = (startIssues === 0 && baselineRemaining.completion.complete) || goalReached(baseline);
let stoppedOnGoal = goalReached(baseline);
const history = [{ iteration: 0, ...baselineRemaining, score: scoreOf(baseline) }];

for (let i = 1; i <= maxIterations && !passed; i++) {
  console.log(`\n--- iteration ${i}/${maxIterations} ---`);
  const prompt = iterationPrompt(findingsPath, i);
  await runAgent(prompt, i);

  const report = await readReport(join(outDir, 'report.json'));
  const r = remaining(report);
  const score = scoreOf(report);
  history.push({ iteration: i, ...r, score });
  console.log(`iteration ${i}: outstanding issue-findings = ${r.outstanding} (was ${lastRemaining.outstanding}), ` +
    `unconcluded checks = ${r.completion.blocked + r.completion.notRun} (was ${lastRemaining.completion.blocked + lastRemaining.completion.notRun}), ` +
    `score = ${score ?? 'N/A'}`);
  if (!r.completion.complete) console.log(`  coverage incomplete: ${r.completion.reasons.join(', ')}`);

  if (goalActive) {
    const g = goalOf(report);
    console.log(`  goal: ${g.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name} (${c.detail})`).join(', ')}`);
    if (g.passed) { passed = true; stoppedOnGoal = true; }
  }
  if (r.outstanding === 0 && r.completion.complete) {
    passed = true;
  } else if (!passed && r.total >= lastRemaining.total && i > 1) {
    // Progress is measured on findings AND unconcluded checks, so concluding a
    // blocked check counts as progress even when no finding was resolved.
    console.log('No further progress this iteration; stopping the climb.');
    lastRemaining = r;
    break;
  }
  // Re-aggregate so the next iteration works from the fresh findings.
  findingsPath = join(outDir, 'report.json');
  lastRemaining = r;
}

console.log('\nHill-climb summary:');
for (const h of history) {
  const unconcluded = h.completion.blocked + h.completion.notRun;
  console.log(`  iteration ${h.iteration}: ${h.outstanding} outstanding, ` +
    `${unconcluded} unconcluded check(s), score ${h.score ?? 'N/A'}`);
}
console.log(
  stoppedOnGoal
    ? 'PASS: score goal met.'
    : passed
      ? 'PASS: no outstanding issues remain and every check concluded.'
      : `STOPPED with ${lastRemaining.outstanding} outstanding issue(s)` +
        (lastRemaining.completion.complete ? '' : ` and INCOMPLETE coverage (${lastRemaining.completion.reasons.join(', ')})`) +
        `${goalActive ? ' (goal not met)' : ''}.`,
);

// 3. Snapshot the final state into a RETAINED `after` run and emit the
// before -> after comparison automatically (audit -> fix -> re-audit -> compare).
// If no iteration ran (e.g. the goal was already met at baseline), the working
// report was never written; fall back to the baseline as the final state.
try {
  const finalReport = existsSync(join(outDir, 'report.json'))
    ? await readReport(join(outDir, 'report.json'))
    : baseline;
  const afterRun = runDir(reportsRoot, auditUrl, `${makeRunId()}-after`);
  await snapshotRun(outDir, afterRun.dir, finalReport);
  updateLatest(afterRun.hostRoot, afterRun.runId);

  const cmp = compareReports(baseline, finalReport, { dirA: beforeRun.dir, dirB: afterRun.dir });
  const md = renderCompareMd(cmp, {
    hostName: beforeRun.host,
    runAId: beforeRun.runId,
    runBId: afterRun.runId,
    dirA: beforeRun.dir,
    dirB: afterRun.dir,
  });
  await writeFile(join(afterRun.dir, 'compare.json'), JSON.stringify({ host: beforeRun.host, runA: beforeRun.runId, runB: afterRun.runId, ...cmp }, null, 2) + '\n');
  await writeFile(join(afterRun.dir, 'compare.md'), md);
  // A copy at the working outDir too, for convenience.
  await writeFile(join(outDir, 'compare.md'), md);
  console.log(`\nBefore -> after comparison written to ${join(afterRun.dir, 'compare.md')}`);
  console.log(`  outstanding ${cmp.summary.outstandingBefore} -> ${cmp.summary.outstandingAfter}, ` +
    `resolved ${cmp.summary.resolved}, new ${cmp.summary.newlyIntroduced}, persisting ${cmp.summary.persisting}`);
  // Roll the retained runs into the interactive scorecard.html (gauges, top-3,
  // deep-dive, history, before/after) so a fix run leaves a shareable summary.
  try {
    const data = buildScorecardData(beforeRun.hostRoot, beforeRun.host, new Date().toISOString().slice(0, 16).replace('T', ' '));
    await writeFile(join(beforeRun.hostRoot, 'scorecard.html'), renderScorecard(data));
    console.log(`Scorecard written to ${join(beforeRun.hostRoot, 'scorecard.html')}`);
  } catch (err) {
    console.error(`Could not emit scorecard: ${err.message}`);
  }
} catch (err) {
  console.error(`Could not emit before/after comparison: ${err.message}`);
}

process.exitCode = passed ? 0 : 1;

// --- helpers ---------------------------------------------------------------

async function baselineAudit() {
  // Drive the model in REPORT mode once to produce report.json, then use it as
  // the findings input. Reuses the same agent map.
  const prompt = agent.prompt(auditUrl, outDir, `--source ${target}`);
  await runAgent(prompt, 0);
  return join(outDir, 'report.json');
}

function runAgent(prompt, iteration) {
  const cliArgs = agent.args(prompt, { maxTurns: 120 });
  if (verbose) console.log(`[iter ${iteration}] $ ${agent.bin} ${cliArgs.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(agent.bin, cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; if (verbose) process.stdout.write(d); });
    child.stderr.on('data', (d) => { err += d; if (verbose) process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', async (code) => {
      try {
        await writeFile(join(outDir, `run-iter-${iteration}.json`), out);
      } catch { /* best effort */ }
      code === 0 ? resolve(out) : reject(new Error(`agent exit ${code}: ${err.slice(-500)}`));
    });
  });
}

async function readReport(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read findings/report JSON at ${path}: ${err.message}`);
  }
}

// The directory a report.json lives in (its artifacts are relative to it).
function dirOf(reportPath) {
  return reportPath.replace(/[/\\][^/\\]*$/, '') || '.';
}

// Copy a report dir's report.json + report.md + evidence/ into a retained run
// dir so the comparison can reference the run's own before/after artifacts.
async function snapshotRun(fromDir, toDir, report) {
  await mkdir(toDir, { recursive: true });
  await writeFile(join(toDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  for (const name of ['report.md', 'evidence']) {
    const src = join(fromDir, name);
    if (existsSync(src)) {
      try {
        await cp(src, join(toDir, name), { recursive: true });
      } catch {
        /* best effort: artifacts may be elsewhere */
      }
    }
  }
}

// The atomic coverage contract says a run carrying blocked or not-run checks is
// PARTIAL, never completed. Counting findings cannot see that: a report with
// zero findings and five checks that never concluded looks exactly like a clean
// audit, which is the absence-of-evidence failure the contract exists to stop.
//
// The checkOutcomes ROWS are the authority here, not `coverage.complete`. A
// report can declare complete: true while still carrying blocked rows, and that
// shape is precisely the one that must not be allowed to claim a pass. Where the
// rows and the declared accounting disagree we take the WORSE answer, so a
// wrong self-declaration can only ever cost a run its pass, never grant one.
function completionState(report) {
  const rows = Array.isArray(report?.checkOutcomes) ? report.checkOutcomes : [];
  const coverage = report?.coverage ?? null;
  const count = (n) => Number(n ?? 0) || 0;

  const blocked = Math.max(rows.filter((r) => r.status === 'blocked').length, count(coverage?.blocked));
  const notRun = Math.max(rows.filter((r) => r.status === 'not-run').length, count(coverage?.notRun));
  const missing = count(coverage?.missing);
  const unknown = count(coverage?.unknown);
  const duplicates = count(coverage?.duplicates);

  const reasons = [];
  if (blocked) reasons.push(`${blocked} blocked`);
  if (notRun) reasons.push(`${notRun} not-run`);
  if (missing) reasons.push(`${missing} missing`);
  if (unknown) reasons.push(`${unknown} unknown`);
  if (duplicates) reasons.push(`${duplicates} duplicate`);
  // No coverage accounting at all (a pre-contract report) is unverifiable, not
  // clean. It cannot claim a completed run either.
  if (!coverage) reasons.push('no coverage accounting in the report');
  else if (coverage.complete !== true && !reasons.length) reasons.push('coverage.complete is not true');

  return { complete: reasons.length === 0, blocked, notRun, missing, unknown, duplicates, reasons };
}

// The work left in a run: findings still to fix PLUS checks still to conclude.
// `total` is the hill-climb's progress metric, so concluding a blocked check
// registers as progress even when it resolves no finding.
function remaining(report) {
  const outstanding = countOutstanding(report);
  const completion = completionState(report);
  return { outstanding, completion, total: outstanding + completion.blocked + completion.notRun };
}

// "Outstanding" = findings tied to a principle the report did NOT mark
// not-applicable or opted-out. A clean audit (only pass / n-a / opted-out)
// returns 0 even though contextual principles exist. We read principleOutcomes
// to know which principles are out of scope, then count findings that are not
// against those principles. This counts FINDINGS only; see completionState for
// the checks that never concluded.
function countOutstanding(report) {
  const outcomes = report.principleOutcomes ?? [];
  const excused = new Set(
    outcomes
      .filter((o) => o.status === 'not-applicable' || o.status === 'opted-out')
      .map((o) => o.principleId)
  );
  const findings = report.findings ?? [];
  return findings.filter((f) => !excused.has(f.principleId)).length;
}

function slugify(s) {
  try {
    return new URL(s).host.replace(/[^a-z0-9.-]/gi, '_');
  } catch {
    return String(s).replace(/[^a-z0-9.-]/gi, '_').slice(0, 40) || 'site';
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  const valueFlags = new Set([
    'target', 'audit-url', 'agent', 'max-iterations', 'findings', 'out', 'reports-root',
    'goal-overall', 'goal-min', 'goal-max-critical', 'goal-max-high',
  ]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (valueFlags.has(key) && next !== undefined && !next.startsWith('--')) {
        // Accumulate repeated value flags (e.g. multiple --goal-min) into an array.
        out[key] = out[key] === undefined ? next : [].concat(out[key], next);
        i++;
      } else out[key] = true;
    } else if (argv[i].startsWith('-') && argv[i].length === 2) {
      out[argv[i].slice(1)] = true;
    } else {
      out._.push(argv[i]);
    }
  }
  return out;
}

function printHelp() {
  console.log(`web-uplift fix - model-driven hill-climb (NOT canned transforms)

Usage:
  npm run fix -- --target <dir> --audit-url <url> [options]
  web-uplift fix --target <dir> --audit-url <url> [options]

The model (via the same agent map as the audit runner) reads the aggregated
audit findings, applies Modern-Web-Guidance-backed fixes to the source under
--target ITSELF, re-audits, and loops until the audit passes or --max-iterations
is hit. There are no hard-coded transforms; the model writes every edit.

Options:
  --target <dir>          Local source to edit (required).
  --audit-url <url>       URL the audit + re-audit run against (required).
  --agent <name>          ${AGENT_NAMES.join(' | ')} (default: claude).
  --max-iterations <n>    Hill-climb cap (default: 4).
  --goal-overall <n>      Stop when the overall score reaches n (score target,
                          instead of only stopping at zero issues).
  --goal-min <key>=<n>    Stop-condition: an outcome must reach n (repeatable).
                          keys: speed memory usability inclusive discoverable trust
  --goal-max-critical <n> / --goal-max-high <n>  Ceilings that must be met to stop.
  --findings <path>       Pre-aggregated findings/report.json (skip baseline audit).
  --out <dir>             Report directory (default: reports/fix-<host>/).
  --reports-root <dir>    Root for retained before/after run dirs (default: reports).
  --dry-run               Print the per-iteration command for each agent; do not run.
  --verbose               Stream agent stdout/stderr live.
  -h, --help              This help.

DEFAULT (subscription) path for an individual: run the fix loop INSIDE your own
agent session by following .claude/skills/web-audit/SKILL.md section 7. This CLI
is the HEADLESS / CI path and uses API tokens.`);
}
