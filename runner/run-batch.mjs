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
import { mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from './agents.mjs';
import { hostSlug, makeRunId, runDir, updateLatest, resolveLatest } from './run-history.mjs';
import { loadFlow, replayFlow } from './flow.mjs';
import { snapshotTree, diffTrees, escapedChanges, summariseChanges } from './write-scope.mjs';
import { launchChrome, newSession } from '../evidence/cdp.mjs';

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

// Write scope for a batch audit. The agent that audits a URL ingests untrusted
// page content and holds write tools, so each spawn is snapshotted and refused if
// a change lands outside the audit's ONE legitimate output root: --out. The child's
// cwd is set EXPLICITLY to the invocation directory rather than inherited, so the
// spawn directory and the snapshot boundary are the same stated fact (and the
// skill's `node .web-uplift/evidence/cli.mjs` still resolves, because install
// vendors .web-uplift/ into the project root).
const projectRoot = resolvePath(process.cwd());
const outRoot = resolvePath(outDir);

// NOTE on concurrency: each run is snapshotted around its own spawn, so with
// --concurrency > 1 a diff can include another in-flight run's writes. That does
// not weaken the refusal - anything outside --out is refused no matter which
// worker wrote it - it only means the per-run diff is not a pristine attribution
// when runs overlap.
function snapshotScope() {
  // --out is a walked root even when its name is one the generic exclusion skips
  // (the DEFAULT is `reports`), so the audit's own output is recorded as an allowed
  // change instead of being invisible in both directions.
  return snapshotTree(projectRoot, { extraRoots: [outRoot], walkUnder: [outRoot] });
}

// P1c: with two workers in flight, each agent's writes land inside the other's
// snapshot window, so one agent's out-of-scope write can refuse a CLEAN URL (it loses
// completion and its latest promotion). A guard that fails clean work is worse than
// no guard, so the scope-accounted spawns are serialized: one snapshot -> spawn ->
// diff at a time. The cost is stated in --help and the README: a batch run with
// --concurrency > 1 that includes agent runs is effectively serial while auditing.
let scopeWindow = Promise.resolve();
function withScopeWindow(fn) {
  const run = scopeWindow.then(fn, fn);
  scopeWindow = run.then(() => undefined, () => undefined);
  return run;
}

function writeScopeFor(url, siteDir, scopeBefore, agentError) {
  const changes = diffTrees(scopeBefore, snapshotScope());
  return {
    url,
    allowedRoots: [outRoot],
    changed: changes,
    escapedOutsideScope: escapedChanges(changes, projectRoot, [outRoot]),
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
    if (args.resume && hasCompletedLatest(url)) {
      console.log(`resume skip    ${url} (latest report passed atomic coverage)`);
      continue;
    }
    const planned = args['dry-run']
      ? dryRunDir(url)
      : runDir(outDir, url, makeRunId());
    const siteDir = planned.dir;

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
    const { scope, result, agentError } = await withScopeWindow(async () => {
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

    await writeFile(join(siteDir, 'write-scope.json'), JSON.stringify(scope, null, 2) + '\n');
    console.log(`  changed: ${summariseChanges(scope.changed)}`);
    if (scope.escapedOutsideScope.length) {
      failures.push({ url, reason: `wrote outside --out: ${scope.escapedOutsideScope.join(', ')}` });
      // Mark the run AND remove its report: latest resolution falls back to the newest
      // run directory that CONTAINS a report when there is no pointer, so leaving one
      // behind would let a refused run become what a later --resume treats as current
      // for this URL - and that URL would then be skipped. The refusal record
      // (write-scope.json + this marker) is what survives, not the agent's claim.
      try {
        await writeFile(join(siteDir, 'run-refused.json'), JSON.stringify({ url, reason: 'wrote outside --out', escapedOutsideScope: scope.escapedOutsideScope, at: new Date().toISOString() }, null, 2) + '\n');
        await rm(join(siteDir, 'report.json'), { force: true });
      } catch (err) {
        console.error(`Could not mark the refused run: ${err.message}`);
      }
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

    try {
      await writeFile(join(siteDir, 'run.json'), result);
      const ok = await exists(join(siteDir, 'report.json'));
      if (ok) {
        await annotateReport(siteDir, { agent: agentName, runId: planned.runId });
        const validation = validateAtomicReport(join(siteDir, 'report.json'));
        if (validation.ok) {
          updateLatest(planned.hostRoot, planned.runId);
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

function hasCompletedLatest(url) {
  const hostRoot = join(outDir, hostSlug(url));
  const latestDir = resolveLatest(hostRoot);
  if (!latestDir) return false;
  // Belt and braces beside removing the report: a run marked as refused is never the
  // current result, however resolution reached it.
  if (existsSync(join(latestDir, 'run-refused.json'))) return false;
  return validateAtomicReport(join(latestDir, 'report.json')).ok;
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
  const cliArgs = agent.args(prompt, { maxTurns });
  const slug = slugify(url);
  if (verbose) console.log(`[${slug}] $ ${agent.bin} ${cliArgs.join(' ')}`);
  return new Promise((resolve, reject) => {
    // cwd is the project root, set explicitly rather than inherited: the skill
    // finds the vendored tool at .web-uplift/evidence/cli.mjs relative to this
    // directory, and it is the same directory the write-scope snapshot is anchored
    // to, so the boundary is a stated fact instead of an inherited default.
    const child = spawn(agent.bin, cliArgs, { stdio: ['ignore', 'pipe', 'pipe'], cwd: projectRoot });
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
  const valueFlags = new Set(['urls', 'agent', 'concurrency', 'out', 'max-turns', 'flow']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (valueFlags.has(key) && next !== undefined) { out[key] = next; i++; }
      else out[key] = true;
    } else {
      out._.push(argv[i]);
    }
  }
  return out;
}
