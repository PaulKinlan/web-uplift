#!/usr/bin/env node
/**
 * web-uplift fix: the MODEL-DRIVEN hill-climb. NOT canned transforms.
 *
 *   npm run fix -- --target <dir> --audit-url <url> [--agent claude]
 *                  [--max-iterations 4] [--findings <path>] [--out <dir>]
 *                  [--dry-run] [--verbose]
 *
 * Mirrors the audit runner's design (runner/run-batch.mjs): it ORCHESTRATES,
 * it contains no transforms. Each iteration shells out to the SAME agent map
 * (runner/agents.mjs) and asks the model to follow .claude/skills/web-audit/
 * SKILL.md in FIX mode. The model reads the aggregated findings + task list,
 * retrieves Modern Web Guidance, writes the edits into --target itself, then
 * re-audits. We loop, reading report.json after each pass, until the audit
 * passes (no outstanding `issues`; `not-applicable`/`opted-out` are fine) or
 * --max-iterations is hit. Per-iteration finding counts are printed so the
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
 *   3. Stop when issues == 0 or --max-iterations reached. Honour web-uplift.json
 *      opt-outs / not-applicable (those never count as outstanding issues).
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

const args = parseArgs(process.argv.slice(2));

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
console.log(`Baseline: ${startIssues} outstanding issue-findings to climb down.`);

// Snapshot the baseline into a RETAINED `before` run under reports/<host>/ so
// the final compare has the pre-fix state with its artifacts. The live working
// report stays at outDir/report.json for the iterations; we just preserve a copy.
const reportsRoot = args['reports-root'] ?? 'reports';
const beforeRun = runDir(reportsRoot, auditUrl, `${makeRunId()}-before`);
await snapshotRun(dirOf(findingsPath), beforeRun.dir, baseline);
updateLatest(beforeRun.hostRoot, beforeRun.runId);
console.log(`Preserved baseline run at ${beforeRun.dir}`);

// 2. Hill-climb.
let lastCount = startIssues;
let passed = startIssues === 0;
const history = [{ iteration: 0, outstanding: startIssues }];

for (let i = 1; i <= maxIterations && !passed; i++) {
  console.log(`\n--- iteration ${i}/${maxIterations} ---`);
  const prompt = iterationPrompt(findingsPath, i);
  await runAgent(prompt, i);

  const report = await readReport(join(outDir, 'report.json'));
  const outstanding = countOutstanding(report);
  history.push({ iteration: i, outstanding });
  console.log(`iteration ${i}: outstanding issue-findings = ${outstanding} (was ${lastCount})`);

  if (outstanding === 0) {
    passed = true;
  } else if (outstanding >= lastCount && i > 1) {
    console.log('No further progress this iteration; stopping the climb.');
    break;
  }
  // Re-aggregate so the next iteration works from the fresh findings.
  findingsPath = join(outDir, 'report.json');
  lastCount = outstanding;
}

console.log('\nHill-climb summary:');
for (const h of history) {
  console.log(`  iteration ${h.iteration}: ${h.outstanding} outstanding`);
}
console.log(passed ? 'PASS: no outstanding issues remain.' : `STOPPED with ${lastCount} outstanding issue(s).`);

// 3. Snapshot the final state into a RETAINED `after` run and emit the
// before -> after comparison automatically (audit -> fix -> re-audit -> compare).
try {
  const finalReport = await readReport(join(outDir, 'report.json'));
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

// "Outstanding" = findings tied to a principle the report did NOT mark
// not-applicable or opted-out. A clean audit (only pass / n-a / opted-out)
// returns 0 even though contextual principles exist. We read principleOutcomes
// to know which principles are out of scope, then count findings that are not
// against those principles.
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
  const valueFlags = new Set(['target', 'audit-url', 'agent', 'max-iterations', 'findings', 'out', 'reports-root']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (valueFlags.has(key) && next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
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
