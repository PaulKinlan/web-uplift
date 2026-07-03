#!/usr/bin/env node
/**
 * Batch web-uplift audits: one headless agent run per URL.
 *
 *   npm run batch -- [urls...] [--urls <file>] [--agent claude]
 *                    [--concurrency 2] [--out reports] [--flow <flow.json>]
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
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import { AGENTS } from './agents.mjs';
import { hostSlug, makeRunId, runDir, updateLatest } from './run-history.mjs';
import { loadFlow, replayFlow } from './flow.mjs';
import { launchChrome, newSession } from '../evidence/cdp.mjs';

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
// principles. Nothing about the audit is deterministic here.
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
    try {
      let extra = '';
      if (flow) {
        console.log(`replaying flow ${flow.title} (${flow.steps.length} steps)`);
        const res = await replayFlowIntoRun(url, siteDir);
        const failed = res.steps.filter((s) => !s.ok).length;
        console.log(`flow replayed  ${res.steps.length} step(s), ${failed} failed`);
        extra = flowExtra(siteDir);
      }
      const result = await runAgent(url, siteDir, extra);
      await writeFile(join(siteDir, 'run.json'), result);
      const ok = await exists(join(siteDir, 'report.json'));
      if (ok) {
        await annotateReport(siteDir, { agent: agentName, runId: planned.runId });
        updateLatest(planned.hostRoot, planned.runId);
      }
      console.log(`${ok ? 'done' : 'NO REPORT'}     ${url}`);
      if (!ok) failures.push({ url, reason: 'finished without report.json' });
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
    const child = spawn(agent.bin, cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
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
