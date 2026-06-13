#!/usr/bin/env node
/**
 * Batch web-uplift audits: one headless agent run per URL.
 *
 *   npm run batch -- [urls...] [--urls <file>] [--agent claude]
 *                    [--concurrency 2] [--out reports]
 *                    [--max-turns 80] [--dry-run] [--verbose]
 *
 * URLs come from positional arguments, a --urls file, or both; with neither,
 * urls/sample.txt is used if present. Invalid URLs are warned about and
 * skipped; ending up with zero URLs is an error.
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
 * Reports land in <out>/<agent>/<site-slug>/ so the same URL list can be run
 * through several agents and compared. Resumable: a URL is skipped if its
 * report.json already exists. Each audit drives its own headless Chrome through
 * the repo's evidence primitives (node evidence/cli.mjs, raw CDP), launched per
 * run with an ephemeral profile, so concurrent runs don't share state. This
 * runner ORCHESTRATES the fan-out; it contains no checks.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENTS } from './agents.mjs';

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

const urls = await collectUrls();
if (!urls.length) {
  console.error(
    'No URLs to audit. Pass them as arguments or via a file:\n' +
    '  npm run batch -- https://example.com https://example.org\n' +
    '  npm run batch -- --urls urls/sample.txt\n' +
    '(with neither, urls/sample.txt is used if it exists)'
  );
  process.exit(1);
}

console.log(`${urls.length} URLs via ${agentName}, concurrency ${concurrency}, output -> ${outDir}/${agentName}/`);

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
    const siteDir = join(outDir, agentName, slugify(url));

    if (await exists(join(siteDir, 'report.json'))) {
      console.log(`skip (exists)  ${url}`);
      continue;
    }
    if (args['dry-run']) {
      const prompt = agent.prompt(url, siteDir);
      console.log(`would run      ${agent.bin} ${agent.args(prompt, { maxTurns }).join(' ')}`);
      continue;
    }

    await mkdir(siteDir, { recursive: true });
    console.log(`auditing       ${url}`);
    try {
      const result = await runAgent(url, siteDir);
      await writeFile(join(siteDir, 'run.json'), result);
      const ok = await exists(join(siteDir, 'report.json'));
      console.log(`${ok ? 'done' : 'NO REPORT'}     ${url}`);
      if (!ok) failures.push({ url, reason: 'finished without report.json' });
    } catch (err) {
      failures.push({ url, reason: String(err) });
      console.error(`failed         ${url}: ${err}`);
    }
  }
}

function runAgent(url, siteDir) {
  const prompt = agent.prompt(url, siteDir);
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
  const urlsFile = args.urls ?? (candidates.length ? null : 'urls/sample.txt');
  if (urlsFile) {
    let content = '';
    try {
      content = await readFile(urlsFile, 'utf8');
    } catch (err) {
      // The implicit sample.txt fallback is allowed to be absent;
      // an explicitly requested file is not.
      if (args.urls) {
        console.error(`Could not read --urls file "${urlsFile}": ${err.message}`);
        process.exit(1);
      }
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
  return new URL(url).host.replace(/[^a-z0-9.-]/gi, '_');
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

function parseArgs(argv) {
  const out = { _: [] };
  const valueFlags = new Set(['urls', 'agent', 'concurrency', 'out', 'max-turns']);
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
