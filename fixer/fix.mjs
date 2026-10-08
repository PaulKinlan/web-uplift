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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AGENTS, AGENT_NAMES, buildAgentEnv, parseAgentEnvFlag } from '../runner/agents.mjs';
import { runDir, updateLatest, makeRunId } from '../runner/run-history.mjs';
import { countOutstanding, completionState, remaining } from '../runner/remaining-work.mjs';
import { compareReports, renderCompareMd } from '../aggregate/compare.mjs';
import { buildScorecardData, renderScorecard, scoreReport, evaluateGates } from '../aggregate/scorecard.mjs';
import { snapshotTree, diffTrees, escapedChanges, summariseChanges, EXECUTABLE_HASH_ROOTS } from '../runner/write-scope.mjs';

const args = parseArgs(process.argv.slice(2));

// The agent child's environment is an explicit ALLOWLIST (web-uplift-l6d) built
// once, here - never a process.env spread. See buildAgentEnv in runner/agents.mjs
// for what passes (PATH/HOME/locale, the child's own provider auth, WEB_UPLIFT_*)
// and what is withheld (warned by name).
const agentEnv = buildAgentEnv({ agentName: args.agent ?? 'claude', extra: parseAgentEnvFlag(args['agent-env']) });

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
// The write boundary for a fix run. The child's cwd is set EXPLICITLY to this
// same directory (see runAgent) rather than inherited from whoever launched the
// fixer, so "the agent's relative writes land here" and "the snapshot boundary is
// here" are the same stated fact. The snapshot is anchored at the invocation
// directory - the project root, which is also where `web-uplift install` vendors
// .web-uplift/ - while the only scope a fix may legitimately edit is --target.
const projectRoot = resolve(process.cwd());
const scopeRoot = target ? resolve(target) : null;
const outRoot = resolve(outDir);
// Extra roots the operator explicitly allows a run to touch (build output, a
// generated lockfile). Without this, a legitimate `npm run build` under a fix
// iteration would refuse the run - fail-closed with no way forward. Repeatable,
// and each value may itself be a comma-separated list.
const allowWrite = [].concat(args['allow-write'] ?? [])
  .flatMap((v) => String(v).split(','))
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => resolve(p));
const allowedRoots = [scopeRoot, outRoot, ...allowWrite];
let escapedOutsideScope = false;
let agentFailure = null;

// The walk covers the invocation directory, the target when it sits outside it,
// and any operator-allowed root, so an out-of-tree path still gets a per-run diff.
// The executed first-party trees are hash-stamped (web-uplift-dzd): a fix
// iteration that tampers with .web-uplift/ or evidence/ is an escape this diff
// can SEE, and the climb's existing break-on-escape then stops the next
// iteration executing the tampered code.
const snapshotScope = () => snapshotTree(projectRoot, { extraRoots: [scopeRoot, ...allowWrite], hashUnder: EXECUTABLE_HASH_ROOTS });

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
  console.log(`write scope   : ${scopeRoot ?? '<target>'} (a change outside this refuses the run)`);
  if (allowWrite.length) console.log(`also allowed  : ${allowWrite.join(', ')}`);
  console.log(`agent isolation: ${args.isolation && args.isolation !== true ? `operator-supplied (${args.isolation}), unverified` : 'REQUIRED - refuses before any spawn without --isolation <mechanism>'}`);
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

// --- Operator-supplied isolation, asserted BEFORE any agent spawn --------------
// This tool does NOT provide a sandbox. Fix mode drives an agent that holds write
// tools while its context carries untrusted page content, and the honest position is
// that the operator must supply the boundary. So: no assertion, no spawn. With an
// assertion the run proceeds, but the tool says loudly that it did NOT verify it and
// records that in the run's security record. See the "running it safely" example in
// README.md for the invocation this expects.
const isolationAssertion = args.isolation && args.isolation !== true ? String(args.isolation).trim() : '';
const willSpawnAgent = maxIterations > 0 || !args.findings;
let isolationRecord;

function writeRunSecurity(dir, record) {
  // A RECORD, not an attestation: it lives in the directory the agent can write, so
  // it states what the operator asserted and that the tool could not verify it. It
  // is evidence for a human, never proof of a boundary. Returns false when it could
  // not be written - the caller REFUSES to spawn in that case, because a run that
  // proceeds without the record defeats the point of demanding the assertion.
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run-security.json'), JSON.stringify({ ...record, recordedAt: new Date().toISOString(), tool: 'web-uplift fix' }, null, 2) + '\n');
    return true;
  } catch (err) {
    console.error(`Could not record the isolation state: ${err.message}`);
    return false;
  }
}

if (!willSpawnAgent) {
  isolationRecord = { isolation: 'not-required', reason: 'this run spawns no agent (--findings supplied and --max-iterations 0)' };
  writeRunSecurity(outDir, isolationRecord);
} else if (!isolationAssertion) {
  isolationRecord = {
    isolation: 'refused',
    reason: 'no --isolation assertion was given, so the tool cannot know what boundary is protecting the agent',
    required: '--isolation <mechanism> naming the boundary you are providing (docker, bwrap, vm, host-permission-model, ...)',
  };
  writeRunSecurity(outDir, isolationRecord);
  console.error(
    [
      'REFUSED: no isolation assertion, and NO AGENT WAS STARTED.',
      'Fix mode drives a write-capable agent whose context carries untrusted page content, and this tool does NOT sandbox it.',
      `Say which boundary you are providing: --isolation <mechanism> (docker, bwrap, vm, host-permission-model, ...).`,
      `Recorded in ${join(outDir, 'run-security.json')}. The tool cannot verify the boundary - it records only what you assert.`,
    ].join('\n'),
  );
  process.exit(1);
} else {
  isolationRecord = {
    isolation: `operator-supplied:${isolationAssertion}`,
    unverified: true,
    reason: 'declared by the operator; the tool did not and cannot verify it',
  };
  if (!writeRunSecurity(outDir, isolationRecord)) {
    console.error(
      `REFUSED: the isolation assertion could not be recorded in ${outDir}, and NO AGENT WAS STARTED.\n` +
      'Recording what was asserted is the point of requiring the assertion, so a run that cannot be recorded does not proceed.',
    );
    process.exit(1);
  }
  console.error(
    `\nWARNING: proceeding on an UNVERIFIED isolation assertion: --isolation ${isolationAssertion}.\n` +
    'This tool does not sandbox the agent and cannot check your boundary. If the agent escapes it, the snapshot/diff\n' +
    'tripwire is the only remaining detection - and its documented gaps still apply. Recorded as unverified in ' +
    `${join(outDir, 'run-security.json')}.\n`,
  );
}

// 1. Validation of a supplied report. NOTE ON ORDER: the isolation assertion is
// resolved ABOVE this point, so a run with no assertion refuses before a malformed
// report is even read. That is deliberate - the assertion gates whether the tool will
// run at all, while report shape is about the input - but it does mean an operator
// with both problems hears about the isolation first. A run carrying --findings with
// --max-iterations 0 never spawns, needs no assertion, and reaches this validation
// (which is what the malformed/unscoreable report tests exercise).
let suppliedBaseline = null;
if (args.findings) {
  try {
    suppliedBaseline = await readReport(args.findings);
  } catch (err) {
    console.error(`Cannot start the climb: ${err.message || err} (write-scope records: ${scopeRecordPaths()} in ${outDir})`);
    process.exit(1);
  }
}

// 1. Findings: supplied, or run an audit + aggregate first. The baseline audit
// spawns the same write-capable agent under the same untrusted context, so it is
// scoped exactly like an iteration - otherwise an injection during iteration 0
// would write unmonitored AND be baked into iteration 1's "clean" baseline.
let findingsPath = args.findings;
if (!findingsPath) {
  console.log(`No --findings supplied; running a baseline audit of ${auditUrl} first.`);
  findingsPath = await baselineAudit();
}
if (escapedOutsideScope) {
  // Nothing below can be trusted: the tree the hill-climb would start from is
  // already outside the declared scope, and the report may not exist at all.
  console.error(
    'CONFINEMENT: refusing to continue - the baseline audit wrote outside ' +
      `${scopeRoot ?? '<target>'} (records: ${scopeRecordPaths()} in ${outDir}).`,
  );
  process.exit(1);
}
if (agentFailure) {
  console.error(
    `The baseline audit failed before it produced a report: ${agentFailure.message || agentFailure} ` +
      `(records: ${scopeRecordPaths()} in ${outDir})`,
  );
  process.exit(1);
}
let baseline = suppliedBaseline;
try {
  baseline = baseline ?? (await readReport(findingsPath));
} catch (err) {
  // The same named failure the iteration loop reports: a baseline the fixer cannot
  // read is a run it cannot score, not a stack trace.
  console.error(`Cannot start the climb: ${err.message || err} (write-scope records: ${scopeRecordPaths()} in ${outDir})`);
  process.exit(1);
}
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
// NOTE: the baseline run dir is NOT created and `latest` is NOT moved here. Both
// are deferred to the publish step at the end of this file, which is skipped when
// the climb is refused or an agent failed. Publishing earlier meant a REFUSED run
// still replaced that host's previous newest result (and left a run dir nothing
// referred to). Until a run completes, a caller must see no change at all.

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
  const scopeBefore = snapshotScope();
  // An agent that writes out of scope and THEN exits non-zero must not hide the
  // write: a rejected runAgent would otherwise abort the process before the diff
  // and the escape diagnosis were ever computed.
  let iterationError = null;
  try {
    await runAgent(prompt, i);
  } catch (err) {
    iterationError = err;
  }
  // A fix iteration may edit --target and write its own report under --out, and
  // nothing else. Record the diff either way, so an operator can review what the
  // model changed instead of trusting the model's own summary.
  const changes = diffTrees(scopeBefore, snapshotScope());
  const escaped = escapedChanges(changes, projectRoot, allowedRoots);
  const iterationDiff = { iteration: i, projectRoot, target: scopeRoot, allowedRoots, changed: changes, escapedOutsideScope: escaped, agentError: iterationError ? String(iterationError.message || iterationError) : null };
  await writeFile(join(outDir, `iter-${i}-diff.json`), JSON.stringify(iterationDiff, null, 2) + '\n');
  console.log(`  changed: ${summariseChanges(changes)}`);
  if (escaped.length) {
    escapedOutsideScope = true;
    await writeFile(join(outDir, 'confinement-escape.json'), JSON.stringify(iterationDiff, null, 2) + '\n');
    console.error(confinementFailure(`iteration ${i}`, escaped));
    break;
  }
  if (iterationError) {
    agentFailure = iterationError;
    await writeFile(join(outDir, `iter-${i}-error.json`), JSON.stringify(iterationDiff, null, 2) + '\n');
    console.error(`\nThe fix agent failed in iteration ${i}: ${iterationError.message || iterationError}`);
    break;
  }

  let report = null;
  try {
    report = await readReport(join(outDir, 'report.json'));
  } catch (err) {
    // A crash here would be a raw stack after the scope checks, and the report is
    // the one thing this iteration was asked to produce. Name it and stop.
    agentFailure = err;
    await writeFile(join(outDir, `iter-${i}-error.json`), JSON.stringify({ ...iterationDiff, reportError: String(err.message || err) }, null, 2) + '\n');
    console.error(`\nIteration ${i} produced no usable report: ${err.message || err}`);
    break;
  }
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
if (escapedOutsideScope) {
  console.log(
    'CONFINEMENT: an iteration wrote outside --target; the run is refused and exits non-zero ' +
      `(records: ${scopeRecordPaths()} in ${outDir}).`,
  );
}
console.log(
  `agent isolation: ${isolationRecord?.isolation ?? 'unresolved'}` +
    (isolationRecord?.unverified ? ' - DECLARED BY THE OPERATOR, NOT VERIFIED BY THIS TOOL' : ''),
);
if (agentFailure) {
  console.log(
    `AGENT FAILURE: an iteration did not complete (${agentFailure.message || agentFailure}); ` +
      `the run exits non-zero (records: ${scopeRecordPaths()} in ${outDir}).`,
  );
}

// 3. Snapshot the final state into a RETAINED `after` run and emit the
// before -> after comparison automatically (audit -> fix -> re-audit -> compare).
// If no iteration ran (e.g. the goal was already met at baseline), the working
// report was never written; fall back to the baseline as the final state.
//
// SKIPPED when the run was refused or an agent failed: recording a retained run,
// moving the host's `latest` pointer and rebuilding the scorecard would publish a
// tampered (or half-finished) tree as the newest result for that host.
if (escapedOutsideScope || agentFailure) {
  console.log(
    '\nNot recording a retained run or scorecard: the climb was refused, so there is no valid result ' +
      `to publish (records: ${scopeRecordPaths()} in ${outDir}).`,
  );
} else {
  try {
    const finalReport = existsSync(join(outDir, 'report.json'))
      ? await readReport(join(outDir, 'report.json'))
      : baseline;
    // Only now, with a completed and in-scope climb, is anything published: the
    // preserved baseline, the retained after run, and the `latest` pointer. Both
    // run dirs are created here rather than before the climb, so a refused run
    // leaves no run dir and no moved pointer behind.
    const beforeRun = runDir(reportsRoot, auditUrl, `${makeRunId()}-before`);
    await snapshotRun(dirOf(findingsPath), beforeRun.dir, baseline);
    updateLatest(beforeRun.hostRoot, beforeRun.runId);
    console.log(`Preserved baseline run at ${beforeRun.dir}`);
    const afterRun = runDir(reportsRoot, auditUrl, `${makeRunId()}-after`);
    await snapshotRun(outDir, afterRun.dir, finalReport);
    // The isolation record travels with the retained result, so a reader of the run
    // can see exactly what was asserted (and that it was not verified).
    await writeFile(join(afterRun.dir, 'run-security.json'), JSON.stringify(isolationRecord, null, 2) + '\n');
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
}

process.exitCode = passed && !escapedOutsideScope && !agentFailure ? 0 : 1;

// --- helpers ---------------------------------------------------------------

async function baselineAudit() {
  // Drive the model in REPORT mode once to produce report.json, then use it as
  // the findings input. Reuses the same agent map. Scoped exactly like an
  // iteration: this spawn runs under the same untrusted page context and holds
  // the same write tools, so an injection here would otherwise write unmonitored
  // AND be baked into iteration 1's "clean" baseline snapshot.
  const prompt = agent.prompt(auditUrl, outDir, `--source ${target}`);
  const scopeBefore = snapshotScope();
  try {
    await runAgent(prompt, 0);
  } catch (err) {
    agentFailure = err;
  }
  const changes = diffTrees(scopeBefore, snapshotScope());
  const escaped = escapedChanges(changes, projectRoot, allowedRoots);
  const record = {
    iteration: 0,
    phase: 'baseline-audit',
    projectRoot,
    target: scopeRoot,
    allowedRoots,
    changed: changes,
    escapedOutsideScope: escaped,
    agentError: agentFailure ? String(agentFailure.message || agentFailure) : null,
  };
  await writeFile(join(outDir, 'iter-0-diff.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(`  baseline audit changed: ${summariseChanges(changes)}`);
  if (escaped.length) {
    escapedOutsideScope = true;
    await writeFile(join(outDir, 'confinement-escape.json'), JSON.stringify(record, null, 2) + '\n');
    console.error(confinementFailure('the baseline audit', escaped));
  }
  return join(outDir, 'report.json');
}

// Every write-scope record written so far, for a refusal message that says where
// to look instead of leaving the operator to guess.
function scopeRecordPaths() {
  const names = [];
  for (let n = 0; n <= Math.max(maxIterations, 0); n++) {
    if (existsSync(join(outDir, `iter-${n}-diff.json`))) names.push(`iter-${n}-diff.json`);
  }
  if (existsSync(join(outDir, 'confinement-escape.json'))) names.push('confinement-escape.json');
  return names.join(', ') || 'none';
}

function confinementFailure(where, escaped) {
  return (
    `\nCONFINEMENT FAILURE: ${where} changed ${escaped.length} path(s) outside ` +
    `${scopeRoot ?? '<target>'} and ${outRoot}:\n  ${escaped.join('\n  ')}\n` +
    'The fix agent\'s context carries untrusted page content, so this is a refusal, not a warning: the climb ' +
    'stops here and the run exits non-zero. The changes are NOT reverted automatically - review ' +
    `${join(outDir, 'confinement-escape.json')} and the per-iteration diff, then decide. ` +
    'If the path is a legitimate build or scratch output, re-run with --allow-write <dir> to allow it.'
  );
}

function runAgent(prompt, iteration) {
  // `root` is passed so the derived absolute-path Bash rules name the SAME
  // directory the child is spawned with as cwd (the write-scope anchor).
  const cliArgs = agent.args(prompt, { maxTurns: 120, root: projectRoot });
  if (verbose) console.log(`[iter ${iteration}] $ ${agent.bin} ${cliArgs.join(' ')}`);
  return new Promise((resolve, reject) => {
    // cwd is the project root, set explicitly rather than inherited: the skill finds
    // the vendored tool at .web-uplift/evidence/cli.mjs relative to this directory.
    const child = spawn(agent.bin, cliArgs, { stdio: ['ignore', 'pipe', 'pipe'], cwd: projectRoot, env: agentEnv });
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

// A report file is untrusted input: fix mode reads reports written by other
// runs, other tools, and older versions. Validate the shape once, here, so a
// malformed report fails with a named error instead of a TypeError from
// whichever helper touches the bad field first. Before web-uplift-rj2 a
// non-array principleOutcomes or findings died inside countOutstanding
// ("outcomes.filter is not a function"), which runs BEFORE the score safety
// net, so the run crashed with a stack instead of saying what was wrong; a
// non-array checkOutcomes was silently ignored, so completionState saw no
// checks at all and a zero-findings run could claim every check concluded.
function reportShapeError(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return `expected a JSON object, got ${jsonType(report)}`;
  }
  // Only fields whose consumers call array methods on them. Absent and null stay
  // legal: a report written before a field existed must keep working, and every
  // consumer already reads these fields through `?? []`.
  for (const field of ['principleOutcomes', 'findings', 'checkOutcomes', 'artifacts']) {
    const value = report[field];
    if (value != null && !Array.isArray(value)) {
      return `"${field}" must be an array when present, got ${jsonType(value)}`;
    }
  }
  return null;
}

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

async function readReport(path) {
  let report;
  try {
    report = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read findings/report JSON at ${path}: ${err.message}`);
  }
  const shapeError = reportShapeError(report);
  if (shapeError) throw new Error(`Invalid report at ${path}: ${shapeError}.`);
  return report;
}

// The directory a report.json lives in (its artifacts are relative to it).
function dirOf(reportPath) {
  return reportPath.replace(/[/\\][^/\\]*$/, '') || '.';
}

// Copy a report dir's report.json + report.md + evidence/ into a retained run
// dir so the comparison can reference the run's own before/after artifacts.
// Writing report.json is mandatory and throws on failure; auxiliary artifacts
// (report.md and evidence/) are copied best-effort so a failure copying auxiliary
// files does not abort an otherwise successful fix run.
async function snapshotRun(fromDir, toDir, report) {
  await mkdir(toDir, { recursive: true });
  await writeFile(join(toDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await Promise.all(
    ['report.md', 'evidence'].map(async (name) => {
      const src = join(fromDir, name);
      if (existsSync(src)) {
        try {
          await cp(src, join(toDir, name), { recursive: true });
        } catch {
          /* best effort: artifacts may be elsewhere */
        }
      }
    }),
  );
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
    'goal-overall', 'goal-min', 'goal-max-critical', 'goal-max-high', 'allow-write', 'isolation', 'agent-env',
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
  --allow-write <dirs>    Extra roots a run may modify, on top of --target and
                          --out (e.g. a build output dir). Repeatable, and each
                          value may be comma-separated.
  --isolation <mechanism>
                          REQUIRED before any agent spawn. Names the boundary YOU
                          are providing (docker, bwrap, vm, host-permission-model,
                          ...). The tool does not sandbox the agent and cannot
                          verify your boundary; it records the assertion as
                          unverified and warns. See "Running it safely" in
                          README.md for a worked example.
  --agent-env KEY=VALUE   Extra variable for the agent child's allowlisted
                          environment (repeatable). The child never inherits the
                          operator's shell env; its own provider auth, PATH, HOME,
                          locale and WEB_UPLIFT_* pass by default, and withheld
                          sensitive-looking variables are warned on by name.
  --dry-run               Print the per-iteration command for each agent; do not run.
  --verbose               Stream agent stdout/stderr live.
  -h, --help              This help.

DEFAULT (subscription) path for an individual: run the fix loop INSIDE your own
agent session by following .claude/skills/web-audit/SKILL.md section 7. This CLI
is the HEADLESS / CI path and uses API tokens.`);
}
