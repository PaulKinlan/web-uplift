#!/usr/bin/env node
/**
 * Batch web-uplift audits: one headless agent run per URL.
 *
 *   npm run batch -- [urls...] [--urls <file>] [--agent claude]
 *                    [--concurrency 2] [--out reports] [--flow <flow.json>] [--resume]
 *                    [--max-turns 80] [--dry-run] [--verbose]
 *
 * URLs come from positional arguments, a --urls file, or both. Invalid URLs are
 * warned about and skipped; ending up with zero URLs is an error.
 *
 * --flow replays a user journey (web-uplift `flow record` output, a Chrome
 * DevTools Recorder export, or a hand-authored flow.json) into each run's
 * evidence/flow/ BEFORE the agent audits, and tells the agent to judge the
 * journey's per-step states as additional paths.
 *
 * Audits run in report mode (critique only). Fix mode is interactive and
 * source-bound (--fix --source <dir>), so it is intentionally not exposed as
 * a fan-out batch flag here.
 *
 * --verbose streams agent stdout/stderr live, each line prefixed with the
 * site slug (output is still captured to run.json either way), and echoes
 * the exact command being spawned.
 *
 * Agents: claude (default) | codex | gemini | antigravity | copilot | opencode.
 * Every agent is ONE entry in the AGENTS map below: {bin, prompt, args}. All of
 * them invoke the SAME canonical skill (.claude/skills/web-audit/SKILL.md)
 * against the URL. Adding an agent = adding one entry to that map (see
 * runner/README.md, "How to add an agent"). No agent needs a browser-automation
 * MCP server: the audit shells out to `node evidence/cli.mjs ...` (raw CDP), so
 * any agent that can run shell commands and read the skill works. --dry-run
 * prints the exact command per agent so the wiring can be validated even when a
 * given CLI is not installed.
 *
 * Reports land in retained run directories: <out>/<site-slug>/<runId>/ with a
 * <out>/<site-slug>/latest pointer. Each audit drives its own headless Chrome
 * through the repo's evidence primitives (node evidence/cli.mjs, raw CDP),
 * launched per run with an ephemeral profile, so concurrent runs don't share
 * state. This runner ORCHESTRATES the fan-out; it contains no checks.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile, access } from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, buildAgentEnv, parseAgentEnvFlag } from './agents.mjs';
import { hostSlug, makeRunId, runDir, updateLatest } from './run-history.mjs';
import { loadFlow, replayFlow } from './flow.mjs';
import { snapshotTree, diffTrees, escapedChanges, summariseChanges, allowedRootsFor, EXECUTABLE_HASH_ROOTS, executableIntegrity } from './write-scope.mjs';
import { launchChrome, newSession, recordLaunch } from '../evidence/cdp.mjs';

const PKG_ROOT = resolvePath(fileURLToPath(new URL('..', import.meta.url)));

// The one canonical methodology is .claude/skills/web-audit/SKILL.md. Agents
// that surface it as a slash command invoke /web-audit; the rest are pointed at
// the SKILL.md file directly, which is plain markdown any agent can follow. The
// audit needs NO browser-automation MCP server: it shells out to
// `node evidence/cli.mjs ...` (raw CDP). So every agent below only needs to run
// shell + read the repo.
//
// The runner ORCHESTRATES; it contains no checks. It fans out one fully-agentic
// audit per URL. The agent (the model) follows SKILL.md: it gathers evidence
// with evidence/cli.mjs, decides which tools to run, reasons, and judges the
// checks. Judgement remains agentic; exact catalog coverage is validated deterministically before a run can become `latest`.
//
// HEADLESS / CI / BATCH PATH (uses API tokens). The per-agent invocation map is
// the single source of truth in runner/agents.mjs; ADDING AN AGENT = ADDING ONE
// ENTRY THERE. For an INDIVIDUAL, the default subscription-friendly path is to
// run /web-audit inside your own agent session instead (see README).

const args = parseArgs(process.argv.slice(2));
const agentName = args.agent ?? 'claude';
const agent = AGENTS[agentName];
if (!agent) {
  console.error(`Unknown agent "${agentName}". Choose one of: ${Object.keys(AGENTS).join(', ')}`);
  process.exit(1);
}

const outDir = args.out ?? 'reports';

// The agent child's environment is an explicit ALLOWLIST (web-uplift-l6d), built
// once here and handed to every spawn - never a process.env spread. The child
// ingests untrusted page text with network egress; the operator's shell
// credentials stay out, and --agent-env KEY=VALUE is the explicit opt-in for
// anything a specific run genuinely needs.
const agentEnv = buildAgentEnv({ extra: parseAgentEnvFlag(args['agent-env']) });

// Write scope for a batch audit. The agent that audits a URL ingests untrusted
// page content and holds write tools, so each spawn is snapshotted and refused if
// a change lands outside the audit's ONE legitimate output root: --out. The child's
// cwd is set EXPLICITLY to the invocation directory rather than inherited, so the
// spawn directory and the snapshot boundary are the same stated fact (and the
// skill's `node .web-uplift/evidence/cli.mjs` still resolves, because install
// vendors .web-uplift/ into the project root).
const projectRoot = resolvePath(process.cwd());
const outRoot = resolvePath(outDir);

// Concurrency: the snapshot/spawn/diff window is SERIALIZED (see withScopeWindow), so
// another worker's writes cannot land inside it. Without that, one agent's
// out-of-scope write appeared in a clean neighbour's diff and refused it too - a guard
// that fails clean work. The throughput cost is stated in the batch banner and the
// README (this runner has no --help output of its own).
function snapshotScope() {
  // --out is a walked root even when its name is one the generic exclusion skips
  // (the DEFAULT is `reports`), so the audit's own output is recorded as an allowed
  // change instead of being invisible in both directions. The executed first-party
  // trees are hash-stamped (web-uplift-dzd), so a same-size+mtime rewrite of the
  // vendored CLI or the schema validator is still a detected change.
  return snapshotTree(projectRoot, { extraRoots: [outRoot], walkUnder: [outRoot], hashUnder: EXECUTABLE_HASH_ROOTS });
}

// P1c: with two workers in flight, each agent's writes land inside the other's
// snapshot window, so one agent's out-of-scope write can refuse a CLEAN URL (it loses
// completion and its latest promotion). A guard that fails clean work is worse than
// no guard, so the scope-accounted spawns are serialized: one snapshot -> spawn ->
// diff at a time. The cost is stated in the batch banner and the README: a run with
// --concurrency > 1 is effectively serial while auditing.
// URLs THIS PROCESS SUCCESSFULLY PUBLISHED take precedence from this set, and no file can
// influence the set itself. That is a precedence rule about what this process already knows it
// did - NOT a claim that completion is decided in memory for every URL, because a URL that is
// not in the set is still looked up on disk. The completion check below states the rule and its
// residual in one place.
const completedThisBatch = new Set();
let scopeWindow = Promise.resolve();
function withScopeWindow(fn) {
  const run = scopeWindow.then(fn, fn);
  scopeWindow = run.then(() => undefined, () => undefined);
  return run;
}

// PRE-SPAWN INTEGRITY GATE state (web-uplift-dzd). The batch executes code from
// .web-uplift/, evidence/, runner/, schema/ and the dependency tree on EVERY URL
// (the agent spawns `node evidence/cli.mjs` per primitive; the runner spawns the
// schema validator after each audit). A refusal for the tampering run alone would
// still let the NEXT URL execute the tampered tree - the old refusal path
// continues the batch - so the executed set is hashed at batch start and
// re-verified before every spawn: any drift refuses that spawn and aborts the
// remaining URLs. Hash cost is milliseconds (see EXECUTABLE_HASH_ROOTS).
const integrityBaseline = executableIntegrity(projectRoot);
let integrityAbort = false;
function executableDrift() {
  const d = diffTrees(integrityBaseline, executableIntegrity(projectRoot));
  return [...d.added, ...d.modified, ...d.deleted];
}

function writeScopeFor(url, siteDir, scopeBefore, agentError) {
  const changes = diffTrees(scopeBefore, snapshotScope());
  return {
    url,
    allowedRoots: allowedRootsFor(outRoot),
    changed: changes,
    escapedOutsideScope: escapedChanges(changes, projectRoot, allowedRootsFor(outRoot)),
    agentError: agentError ? String(agentError.message || agentError) : null,
    recordWrittenTo: siteDir,
  };
}
const concurrency = Number(args.concurrency ?? 2);
const maxTurns = Number(args['max-turns'] ?? 80);
const verbose = Boolean(args.verbose);
// --flow <path>: a user journey (web-uplift flow record output, a Chrome
// DevTools Recorder export, or a hand-authored flow.json) is replayed into each
// run before the agent audits, so the model judges the journey's per-step states.
const flowPath = args.flow;
const flow = flowPath ? loadFlow(flowPath) : null;

const urls = await collectUrls();
if (!urls.length) {
  console.error(
    'No URLs to audit. Pass them as arguments or via a file:\n' +
    '  npm run batch -- https://example.com https://example.org\n' +
    '  npm run batch -- --urls ./urls.txt'
  );
  process.exit(1);
}

console.log(`${urls.length} URLs via ${agentName}, concurrency ${concurrency}, output -> ${outDir}/`);
if (concurrency > 1) {
  console.log('note: agent runs are scope-accounted one at a time, so a batch audit is effectively');
  console.log('      serial while auditing - the snapshot/spawn/diff window cannot overlap, or one');
  console.log('      run would refuse a clean URL that happened to be auditing beside it.');
}

const queue = [...urls];
const failures = [];
await Promise.all(Array.from({ length: concurrency }, worker));

console.log(`Done. ${failures.length} failure(s).`);
if (failures.length) {
  console.log(failures.map((f) => `  ${f.url}: ${f.reason}`).join('\n'));
  process.exitCode = 1;
}

async function worker() {
  while (queue.length) {
    const url = queue.shift();
    // After an integrity failure the remaining URLs are drained as named skips,
    // not silently dropped: every URL the operator asked for gets an accounting
    // line, and the batch still exits non-zero.
    if (integrityAbort) {
      failures.push({ url, reason: 'skipped: batch aborted after an executable-tree integrity failure' });
      console.error(`skipped        ${url}: batch aborted after an executable-tree integrity failure`);
      continue;
    }
    if (args.resume && hasCompletedLatest(url)) {
      console.log(`resume skip    ${url} (latest report passed atomic coverage)`);
      continue;
    }
    let planned;
    let siteDir;
    try {
      planned = args['dry-run'] ? dryRunDir(url) : runDir(outDir, url, makeRunId());
      siteDir = planned.dir;
    } catch (err) {
      // Preparing the next URL used to sit outside the per-URL guard, so a failure here
      // aborted the whole batch. Fold it in: one URL cannot take the others down.
      failures.push({ url, reason: `could not prepare a run directory: ${err.message}` });
      console.error(`failed         ${url}: ${err.message}`);
      continue;
    }

    if (args['dry-run']) {
      const extra = flow ? flowExtra(siteDir) : '';
      const prompt = agent.prompt(url, siteDir, extra);
      if (flow) console.log(`would replay   flow "${flow.title}" (${flow.steps.length} steps) into ${join(siteDir, 'evidence', 'flow')}`);
      console.log(`would run      ${agent.bin} ${agent.args(prompt, { maxTurns }).join(' ')}`);
      continue;
    }

    await mkdir(siteDir, { recursive: true });
    console.log(`auditing       ${url}`);
    // ONE scope window at a time (see withScopeWindow): the snapshot, the spawn and
    // the diff are a single critical section, so no other worker's writes can land
    // inside this window and refuse a clean URL. The diff is still computed when the
    // agent dies - an agent that writes out of scope and exits non-zero must not hide
    // the write.
    let recordFailed = false;
    const { scope, result, agentError, integrityDrift } = await withScopeWindow(async () => {
      // Gate FIRST (web-uplift-dzd): if the executed tree drifted since batch
      // start, this agent is never spawned - see executableDrift's declaration
      // for why a post-run refusal alone is not enough.
      const drift = executableDrift();
      if (drift.length) return { integrityDrift: drift };
      const scopeBefore = snapshotScope();
      let scopedError = null;
      let scopedResult = null;
      let extra = '';
      try {
        if (flow) {
          console.log(`replaying flow ${flow.title} (${flow.steps.length} steps)`);
          const res = await replayFlowIntoRun(url, siteDir);
          const failed = res.steps.filter((s) => !s.ok).length;
          console.log(`flow replayed  ${res.steps.length} step(s), ${failed} failed`);
          extra = flowExtra(siteDir);
        }
        scopedResult = await runAgent(url, siteDir, extra);
      } catch (err) {
        scopedError = err;
      }
      return { scope: writeScopeFor(url, siteDir, scopeBefore, scopedError), result: scopedResult, agentError: scopedError };
    });

    if (integrityDrift) {
      integrityAbort = true;
      const shown = integrityDrift.slice(0, 8).join(', ') + (integrityDrift.length > 8 ? ', ...' : '');
      failures.push({ url, reason: `executable tree changed since batch start: ${shown}` });
      console.error(
        `INTEGRITY FAILURE ${url}: the executed tree changed since the batch started:\n  ${integrityDrift.join('\n  ')}\n` +
        'Every audit runs code from these paths (the agent spawns the evidence CLI per primitive; the runner\n' +
        'spawns the schema validator), so every remaining URL would execute attacker-influenced code. Refusing\n' +
        'to spawn this agent and aborting the remaining URLs. Nothing is reverted automatically; review the\n' +
        'paths above and the earlier runs\u2019 write-scope.json before re-running.',
      );
      continue;
    }

    // The agent shares this tree, so it can delete the run directory out from under us.
    // Writing the record must then fail THIS URL cleanly instead of rejecting out of the
    // worker and taking the whole batch down with an ENOENT stack.
    try {
      if (!isRealUnderOutput(siteDir)) throw new Error('the run directory (or an ancestor of it) was replaced before the scope record could be written');
      await writeFile(join(siteDir, 'write-scope.json'), JSON.stringify(scope, null, 2) + '\n');
    } catch (err) {
      // FAIL CLOSED FOR THIS URL. The record is part of the accounting contract, so a
      // URL whose record cannot be written is not completed, not published and not
      // counted. The refusal below is still reported if there was one - that is the
      // security-relevant fact and must not be hidden by a bookkeeping failure.
      recordFailed = true;
      failures.push({ url, reason: `run directory unusable when the scope record was written: ${err.code || err.message}` });
      console.error(`record failed  ${url}: ${err.message}`);
    }
    console.log(`  changed: ${summariseChanges(scope.changed)}`);
    if (scope.escapedOutsideScope.length) {
      failures.push({ url, reason: `wrote outside --out: ${scope.escapedOutsideScope.join(', ')}` });
      // Quarantine the run: rename its report out of the way and leave a record.
      //
      // ADVISORY EVIDENCE AND DEFENCE IN DEPTH: it improves the odds against a resumed run
      // resolving to a refused result, and it is not what makes the refusal stick. The
      // completion check below is the single place where the guarantee and its residual are
      // stated - read that before relying on anything here.
      const quarantineProblem = await quarantineRefusedRun(siteDir, { url, escapedOutsideScope: scope.escapedOutsideScope });
      if (quarantineProblem) failures.push({ url, reason: quarantineProblem });
      console.error(
        `CONFINEMENT FAILURE ${url}: this audit changed ${scope.escapedOutsideScope.length} path(s) outside ` +
        `${outRoot}:\n  ${scope.escapedOutsideScope.join('\n  ')}\n` +
        'The agent auditing an untrusted page held write tools, so this is a refusal, not a warning. Nothing is ' +
        `reverted automatically; review ${join(siteDir, 'write-scope.json')}.`,
      );
      continue;
    }
    if (agentError) {
      failures.push({ url, reason: String(agentError) });
      console.error(`failed         ${url}: ${agentError}`);
      continue;
    }
    if (recordFailed) {
      // Already recorded as a failure above; do not publish or count this URL.
      continue;
    }

    try {
      await writeFile(join(siteDir, 'run.json'), result);
      const ok = await exists(join(siteDir, 'report.json'));
      if (ok) {
        await annotateReport(siteDir, { agent: agentName, runId: planned.runId });
        const validation = validateAtomicReport(join(siteDir, 'report.json'));
        if (validation.ok) {
          try {
            updateLatest(planned.hostRoot, planned.runId);
          } catch (err) {
            // Publication failed, so this URL is NOT complete. Adding it to the in-memory
            // set before this point meant a DUPLICATE url later in the same resume batch
            // was skipped even though nothing was ever published for it.
            failures.push({ url, reason: `completion could not be published: ${err.message}` });
            console.error(`failed         ${url}: could not publish completion: ${err.message}`);
            continue;
          }
          completedThisBatch.add(url);
          console.log(`done (coverage complete)     ${url}`);
        } else {
          failures.push({ url, reason: `atomic coverage validation failed: ${validation.detail}` });
          console.error(`INVALID REPORT ${url}: ${validation.detail}`);
        }
      } else {
        console.log(`NO REPORT     ${url}`);
        failures.push({ url, reason: 'finished without report.json' });
      }
    } catch (err) {
      failures.push({ url, reason: String(err) });
      console.error(`failed         ${url}: ${err}`);
    }
  }
}

function dryRunDir(url) {
  const host = hostSlug(url);
  const hostRoot = join(outDir, host);
  const runId = '<timestamp>';
  return { dir: join(hostRoot, runId), hostRoot, host, runId };
}

// Quarantine a refused run: rename its report and leave a marker. Both steps are ADVISORY -
// see the completion check for the guarantee and its residual. RENAME rather than delete
// because a rename cannot be half-done: the earlier
// version wrote a marker and deleted the report inside ONE try block, so an agent could
// plant a dangling symlink at the marker path, make that write fail, and suppress the
// deletion - leaving a resumable report behind. The steps are independently guarded and the
// rename goes first, so a failing marker cannot suppress it.
//
// The run directory is verified to be a real path below the output root before anything
// touches it: the agent shares this tree and could replace its run directory (or an
// ancestor) with a symlink to another run, and anything following that path would act on
// the wrong run.
async function quarantineRefusedRun(siteDir, { url, escapedOutsideScope }) {
  const realDir = isRealUnderOutput(siteDir);
  if (!realDir) {
    console.error(`Refused run at ${siteDir} is not a real path below the output root (a link in the chain?): not touching anything through it.`);
    return `could not quarantine: ${siteDir} is not a real path below ${outRoot}`;
  }
  // EVERY failure below is loud and NAMED, and the two steps are independent: an
  // impossible rename records its problem but still attempts the advisory marker, so one
  // failing step cannot suppress the other.
  let problem = null;
  try {
    await rename(join(siteDir, 'report.json'), join(siteDir, 'report.refused.json'));
  } catch (err) {
    // ENOENT means there was no report to quarantine, which is a fine outcome.
    if (err?.code !== 'ENOENT') {
      console.error(`NOT QUARANTINED: could not rename the refused report in ${siteDir} (${err.code || err.message}). For THIS batch the refusal stands; see the completion check for what a resumed lookup can still do.`);
      problem = `could not quarantine the refused report (${err.code || err.message}): the report is still on disk`;
    }
  }
  try {
    await writeFile(join(siteDir, 'run-refused.json'), JSON.stringify({ url, reason: 'wrote outside --out', escapedOutsideScope, at: new Date().toISOString() }, null, 2) + '\n');
  } catch (err) {
    console.error(`Could not write the refusal marker: ${err.message}`);
    if (!problem) problem = `could not write the refusal marker: ${err.message}`;
  }
  return problem;
}

// COMPLETION CHECK - WHAT THIS ACTUALLY GUARANTEES. Read this before trusting it. It is the
// single place these limits are stated; the comments at the refusal and quarantine sites
// point here rather than repeating them.
//
//  * URLs THIS PROCESS SUCCESSFULLY PUBLISHED take precedence from completedThisBatch, an
//    in-memory set that no file can influence. That is a precedence rule about what this
//    process already knows it did, NOT a blanket statement that a batch run's completion is
//    decided in memory: a URL that is not in the set is still looked up below.
//  * EVERY OTHER resume lookup has only disk to read - the pointer this tool wrote, or
//    latest.txt - and that disk is writable by the agent being audited. A planted pointer
//    naming a run whose report looks valid can therefore make a later --resume skip that
//    URL. That is a REAL RESIDUAL, not a guarantee: the honest boundary for it is
//    operator-provided external isolation (the fixer's --isolation flag; THIS batch runner
//    has no isolation flag of its own), because a tool that shares a writable tree with its
//    adversary cannot authenticate what it reads from that tree.
//    resolveLatest() in run-history.mjs now contains the pointer's TARGET, so it cannot name
//    a directory outside the host root; that bounds WHERE a pointer points and cannot
//    authenticate WHICH run it names, which is exactly why this residual stands.
//  * The refusal quarantine (a renamed report, a marker) is therefore ADVISORY EVIDENCE and
//    defence in depth. It is worth having and it is never what makes a decision correct.
// What it deliberately does NOT do is fall back to "the newest directory containing a
// report": that is a decision the adversary could make for us, and removing it was the point
// of this change. (resolveLatest() in run-history.mjs keeps that fallback for reporting
// consumers such as the scorecard, where it is a presentation convenience; the batch
// deliberately does not call it.)
function latestPointerTarget(hostRoot) {
  const link = join(hostRoot, 'latest');
  try {
    if (lstatSync(link).isSymbolicLink()) return resolvePath(hostRoot, readlinkSync(link));
  } catch {
    /* no symlink: fall through to the text form */
  }
  try {
    const txt = readFileSync(join(hostRoot, 'latest.txt'), 'utf8').trim();
    if (txt) return join(hostRoot, txt);
  } catch {
    /* no pointer at all */
  }
  return null;
}

function hasCompletedLatest(url) {
  if (completedThisBatch.has(url)) return true; // our own state, this batch
  const hostRoot = join(outDir, hostSlug(url));
  const latestDir = latestPointerTarget(hostRoot);
  if (!latestDir) return false; // no pointer: nothing this tool published is current
  if (!isRealDir(latestDir)) return false;
  return validateAtomicReport(join(latestDir, 'report.json')).ok;
}

// Validate a path immediately before EVERY use rather than once, early: the agent
// shares this tree and can replace its run directory with a symlink between the check
// and the write, which would make a write land in another run - or outside the output
// tree entirely, escaping the accounting.
function isRealDir(p) {
  try {
    return lstatSync(p).isDirectory() && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Validate EVERY segment below the output root, not just the leaf: validating the leaf
// alone misses an ancestor swapped for a symlink, through which the same writes land
// somewhere else entirely. (outDir itself is the operator's choice and is not checked.)
function isRealUnderOutput(p) {
  const base = resolvePath(outDir);
  const target = resolvePath(p);
  if (target !== base && !target.startsWith(base + sep)) return false;
  let cur = base;
  for (const segment of relative(base, target).split(sep).filter(Boolean)) {
    cur = join(cur, segment);
    if (!isRealDir(cur)) return false;
  }
  return true;
}

function validateAtomicReport(reportPath) {
  const validator = join(PKG_ROOT, 'schema', 'validate-report.mjs');
  const catalog = join(PKG_ROOT, 'knowledge', 'principles.json');
  const result = spawnSync(process.execPath, [validator, catalog, reportPath], { encoding: 'utf8' });
  const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim().replace(/\s+/g, ' ').slice(0, 1000);
  return { ok: result.status === 0, detail: detail || `validator exited ${result.status}` };
}

async function annotateReport(siteDir, meta) {
  const reportPath = join(siteDir, 'report.json');
  try {
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    report.agent = report.agent ?? meta.agent;
    report.runId = report.runId ?? meta.runId;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  } catch {
    // If the model wrote an invalid report, keep the original file so the
    // failure can be inspected instead of hiding it behind runner metadata.
  }
}

// Replay the flow into <siteDir>/evidence/flow/ (per-step screenshots +
// flow-result.json) before the agent audits, so the model has the journey's
// concrete states to judge.
async function replayFlowIntoRun(url, siteDir) {
  const flowDir = join(siteDir, 'evidence', 'flow');
  await mkdir(flowDir, { recursive: true });
  const log = verbose ? (m) => console.error(m) : () => {};
  const chrome = await launchChrome({ log });
  // The runner's own browser is attributed to the same run-level launches.jsonl
  // the agent's CLI invocations write (web-uplift-4wx).
  recordLaunch({ primitive: 'flow-replay', url, chrome, launchesFile: join(siteDir, 'launches.jsonl') });
  try {
    const session = await newSession(chrome.port, { log });
    try {
      const res = await replayFlow(session.client, flow, { startUrl: url, outDir: flowDir, log });
      writeFileSync(join(flowDir, 'flow-result.json'), JSON.stringify(res, null, 2) + '\n');
      return res;
    } finally {
      await session.close();
    }
  } finally {
    await chrome.close();
  }
}

// Prompt addendum telling the model the journey was already replayed and where
// its evidence is, so it audits the flow steps as additional paths.
function flowExtra(siteDir) {
  const rel = relative(resolvePath(siteDir), resolvePath(join(siteDir, 'evidence', 'flow')));
  return `# A user journey ("${flow.title}", ${flow.steps.length} steps) was ALREADY replayed for you: ` +
    `per-step screenshots and flow-result.json are in ${rel}/ under the run dir. Treat each step's state as an ` +
    `additional audited path - judge the per-page principles across the journey and record the flow in report paths.`;
}

function runAgent(url, siteDir, extra = '') {
  const prompt = agent.prompt(url, siteDir, extra);
  // `root` is passed so the derived absolute-path Bash rules name the SAME
  // directory the child is spawned with as cwd (the write-scope anchor).
  const cliArgs = agent.args(prompt, { maxTurns, root: projectRoot });
  const slug = slugify(url);
  if (verbose) console.log(`[${slug}] $ ${agent.bin} ${cliArgs.join(' ')}`);
  return new Promise((resolve, reject) => {
    // cwd is the project root, set explicitly rather than inherited: the skill
    // finds the vendored tool at .web-uplift/evidence/cli.mjs relative to this
    // directory, and it is the same directory the write-scope snapshot is anchored
    // to, so the boundary is a stated fact instead of an inherited default.
    // WEB_UPLIFT_LAUNCH_LOG points every evidence-CLI chrome the agent launches
    // at the run-level launches.jsonl, so an in-flight primitive is attributable
    // post-mortem (web-uplift-4wx); the runner's own flow replay records there too.
    const child = spawn(agent.bin, cliArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: projectRoot,
      env: { ...agentEnv, WEB_UPLIFT_LAUNCH_LOG: join(siteDir, 'launches.jsonl') },
    });
    let out = '';
    let err = '';
    const echoOut = verbose ? linePrinter(`[${slug}] `, process.stdout) : null;
    const echoErr = verbose ? linePrinter(`[${slug}!] `, process.stderr) : null;
    child.stdout.on('data', (d) => { out += d; echoOut?.(d); });
    child.stderr.on('data', (d) => { err += d; echoErr?.(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      echoOut?.flush();
      echoErr?.flush();
      code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err.slice(-500)}`));
    });
  });
}

// Buffers chunks into whole lines so concurrent agents' output doesn't
// interleave mid-line, prefixing each line for attribution.
function linePrinter(prefix, stream) {
  let buffer = '';
  const print = (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) stream.write(`${prefix}${line}\n`);
  };
  print.flush = () => {
    if (buffer) stream.write(`${prefix}${buffer}\n`);
    buffer = '';
  };
  return print;
}

async function collectUrls() {
  const candidates = [...args._];
  const urlsFile = args.urls ?? null;
  if (urlsFile) {
    let content = '';
    try {
      content = await readFile(urlsFile, 'utf8');
    } catch (err) {
      console.error(`Could not read --urls file "${urlsFile}": ${err.message}`);
      process.exit(1);
    }
    candidates.push(
      ...content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    );
  }
  return candidates.filter((candidate) => {
    if (URL.canParse(candidate)) return true;
    console.warn(`skipping invalid URL: ${candidate}`);
    return false;
  });
}

function slugify(url) {
  return hostSlug(url);
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

function parseArgs(argv) {
  const out = { _: [] };
  const valueFlags = new Set(['urls', 'agent', 'concurrency', 'out', 'max-turns', 'flow', 'agent-env']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (valueFlags.has(key) && next !== undefined) {
        // Accumulate repeated value flags (e.g. multiple --agent-env) into an array.
        out[key] = out[key] === undefined ? next : [].concat(out[key], next);
        i++;
      } else out[key] = true;
    } else {
      out._.push(argv[i]);
    }
  }
  return out;
}
