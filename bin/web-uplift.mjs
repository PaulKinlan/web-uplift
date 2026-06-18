#!/usr/bin/env node
/**
 * web-uplift CLI.
 *
 *   web-uplift <command> [options]
 *
 * Commands:
 *   install [--agent <name>|all] [--dry-run]   Place the web-audit skill + evidence
 *                                              CLIs into a project for an agent.
 *   update  [--agent <name>|all] [--dry-run]   Refresh an existing project install.
 *   audit  [...]    Passthrough to the headless batch runner (runner/run-batch.mjs).
 *   fix    [...]    Passthrough to the model-driven hill-climb (fixer/fix.mjs).
 *   aggregate [...] Passthrough to the cross-site aggregator (aggregate/aggregate.mjs).
 *   compare <host> [runA] [runB]  Diff two retained runs (aggregate/compare.mjs).
 *   evidence <primitive> <url> [...]  Passthrough to the evidence primitives.
 *
 * The PRIMARY, subscription-friendly path is to `install` the skill and then run
 * `/web-audit <url>` and the fix loop INSIDE your own agent session (Claude Code,
 * Codex, Gemini, Antigravity, Copilot, opencode). audit/fix/aggregate/evidence
 * here are the HEADLESS conveniences; audit and fix shell out to an agent CLI in
 * -p/exec mode, which uses API tokens.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import {
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { AGENT_NAMES } from '../runner/agents.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 800;

const argv = process.argv.slice(2);
const command = argv[0];
const rest = argv.slice(1);

await maybeWarnForUpdate(command, rest);

switch (command) {
  case 'install':
    await install(rest);
    break;
  case 'update':
    await install(rest, { mode: 'update' });
    break;
  case 'audit':
  case 'batch':
    passthrough(join(PKG_ROOT, 'runner', 'run-batch.mjs'), rest);
    break;
  case 'fix':
    passthrough(join(PKG_ROOT, 'fixer', 'fix.mjs'), rest);
    break;
  case 'aggregate':
    passthrough(join(PKG_ROOT, 'aggregate', 'aggregate.mjs'), rest);
    break;
  case 'compare':
    passthrough(join(PKG_ROOT, 'aggregate', 'compare.mjs'), rest);
    break;
  case 'evidence':
    passthrough(join(PKG_ROOT, 'evidence', 'cli.mjs'), rest);
    break;
  case '--help':
  case '-h':
  case 'help':
  case undefined:
    printHelp();
    break;
  case '--version':
  case '-v': {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
    console.log(pkg.version);
    break;
  }
  default:
    console.error(`Unknown command "${command}".`);
    printHelp();
    process.exit(1);
}

// --- install ---------------------------------------------------------------

// Where each agent expects a project-level skill / command file. Every agent is
// ONE entry: { dir, file, kind, content }. `content` builds the thin wrapper
// (which only ever POINTS at the canonical skill so it can't drift). Adding an
// agent = adding one entry here (mirrors runner/agents.mjs).
function agentTargets() {
  const pointAtSkill =
    'Read the file `.web-uplift/skill/SKILL.md` (or `.claude/skills/web-audit/SKILL.md` ' +
    'if present) and follow its instructions exactly, with the arguments the user provides ' +
    '(a URL, plus optional flags like --out <dir>, --source <dir>, --fix, --findings <path>).';
  return {
    claude: [
      { rel: '.claude/skills/web-audit/SKILL.md', kind: 'skill-copy' },
    ],
    codex: [
      { rel: '.codex/skills/web-audit/SKILL.md', kind: 'skill-copy' },
      { rel: 'AGENTS.md', kind: 'append-marker', content: agentsMdSnippet() },
    ],
    gemini: [
      {
        rel: '.gemini/commands/web-audit.toml',
        kind: 'wrapper',
        content:
          'description = "Audit a URL for modern web quality (web-uplift); --fix to hill-climb"\n\n' +
          'prompt = """\n' + pointAtSkill + '\nArguments: {{args}}\n"""\n',
      },
    ],
    antigravity: [
      {
        rel: '.agents/skills/web-audit.md',
        kind: 'wrapper',
        content: '# web-audit\n\n' + pointAtSkill + '\n',
      },
    ],
    copilot: [
      {
        rel: '.github/prompts/web-audit.prompt.md',
        kind: 'wrapper',
        content:
          '---\nmode: agent\ndescription: "web-uplift: audit a URL for modern web quality; --fix to hill-climb."\n---\n\n' +
          pointAtSkill + '\n\nArguments: ${input:args:URL plus optional flags}\n',
      },
      { rel: '.github/copilot-instructions.md', kind: 'append-marker', content: copilotSnippet() },
    ],
    opencode: [
      {
        rel: '.opencode/command/web-audit.md',
        kind: 'wrapper',
        content:
          '---\ndescription: web-uplift - audit a URL for modern web quality; --fix to hill-climb.\n---\n\n' +
          pointAtSkill + '\n\nArguments: $ARGUMENTS\n',
      },
      { rel: 'AGENTS.md', kind: 'append-marker', content: agentsMdSnippet() },
    ],
  };
}

function agentsMdSnippet() {
  return (
    '\n<!-- web-uplift:install -->\n' +
    '## web-uplift (modern-web audit + fix)\n\n' +
    'When asked to web-audit, UX-audit, uplift, modernise, or quality-audit a site, ' +
    'read `.web-uplift/skill/SKILL.md` and follow it exactly. Gather evidence with ' +
    '`node .web-uplift/evidence/cli.mjs <primitive> <url> [options]` (raw CDP). ' +
    '`--fix --source <dir>` runs the model-driven hill-climb.\n'
  );
}

function copilotSnippet() {
  return (
    '\n<!-- web-uplift:install -->\n' +
    '## web-uplift\n\n' +
    'Audit a URL for modern web quality by following `.web-uplift/skill/SKILL.md`. ' +
    'Gather evidence with `node .web-uplift/evidence/cli.mjs <primitive> <url>`.\n'
  );
}

async function install(flags, { mode = 'install' } = {}) {
  const opts = parseFlags(flags, new Set(['agent', 'target']));
  if (opts.help || opts.h) {
    console.log(`web-uplift ${mode} - ${mode === 'update' ? 'refresh' : 'place'} the web-audit skill + evidence CLIs ${mode === 'update' ? 'in' : 'into'} a project.

Usage:
  web-uplift ${mode} [--agent ${AGENT_NAMES.join('|')}|all] [--dry-run] [--target <dir>]

Options:
  --agent <name>   Which agent to wire up (default: all).
  --target <dir>   Project root to install into (default: cwd).
  --dry-run        Print the placement plan without writing anything.

Copies the canonical skill + evidence CLIs under .web-uplift/ with the small
runtime dependency closure needed by the raw-CDP evidence CLI, then writes each
agent's thin command wrapper (which only POINTS at the skill). Idempotent: an
existing instructions snippet is not duplicated. Then run /web-audit <url>
inside your agent session (uses your subscription).`);
    return;
  }
  const dryRun = Boolean(opts['dry-run']);
  const projectRoot = resolve(opts.target ?? process.cwd());
  const pkg = packageInfo();
  let agents = opts.agent ?? 'all';
  const selected = agents === 'all' ? AGENT_NAMES : [agents];
  for (const a of selected) {
    if (!AGENT_NAMES.includes(a)) {
      console.error(`Unknown agent "${a}". Choose one of: ${AGENT_NAMES.join(', ')}, all`);
      process.exit(1);
    }
  }

  const targets = agentTargets();
  const plan = [];

  // The evidence CLIs + skill + principles + schema get vendored under
  // .web-uplift/ in the project so the in-session agent can call them directly
  // without depending on this package's checkout layout.
  const vendorRoot = join(projectRoot, '.web-uplift');
  plan.push({ action: 'copy-dir', from: join(PKG_ROOT, 'evidence'), to: join(vendorRoot, 'evidence'), what: 'evidence primitives (raw-CDP CLI)' });
  plan.push(...dependencyCopySteps(['chrome-remote-interface'], join(vendorRoot, 'node_modules')));
  plan.push({ action: 'copy-file', from: join(PKG_ROOT, '.claude/skills/web-audit/SKILL.md'), to: join(vendorRoot, 'skill', 'SKILL.md'), what: 'canonical web-audit SKILL.md' });
  plan.push({ action: 'copy-file', from: join(PKG_ROOT, 'knowledge/principles.json'), to: join(vendorRoot, 'knowledge', 'principles.json'), what: 'principles spec' });
  plan.push({ action: 'copy-dir', from: join(PKG_ROOT, 'schema'), to: join(vendorRoot, 'schema'), what: 'findings + config schema' });
  plan.push({ action: 'copy-file', from: join(PKG_ROOT, 'knowledge/guidance.md'), to: join(vendorRoot, 'knowledge', 'guidance.md'), what: 'guidance lookup protocol' });
  plan.push({
    action: 'write',
    to: join(vendorRoot, 'manifest.json'),
    content: installManifest({ pkg, selected }),
    what: `install manifest (${pkg.version})`,
  });

  for (const agent of selected) {
    for (const t of targets[agent]) {
      const dest = join(projectRoot, t.rel);
      if (t.kind === 'skill-copy') {
        plan.push({ action: 'copy-file', from: join(PKG_ROOT, '.claude/skills/web-audit/SKILL.md'), to: dest, what: `${agent}: skill` });
      } else if (t.kind === 'wrapper') {
        plan.push({ action: 'write', to: dest, content: t.content, what: `${agent}: command wrapper` });
      } else if (t.kind === 'append-marker') {
        plan.push({ action: 'append', to: dest, content: t.content, what: `${agent}: instructions snippet` });
      }
    }
  }

  console.log(`web-uplift ${mode} -> ${projectRoot}`);
  console.log(`agents: ${selected.join(', ')}${dryRun ? '  (dry-run)' : ''}\n`);
  printExistingInstallNotice(vendorRoot, pkg);
  for (const step of plan) {
    const relTo = relative(projectRoot, step.to) || step.to;
    if (dryRun) {
      console.log(`  would ${step.action.padEnd(9)} ${relTo}   (${step.what})`);
      continue;
    }
    applyStep(step);
    console.log(`  ${step.action.padEnd(9)} ${relTo}   (${step.what})`);
  }
  if (!dryRun) {
    const verb = mode === 'update' ? 'Updated' : 'Installed';
    console.log(`\n${verb}. Now run /web-audit <url> inside your agent session (uses your subscription).`);
  }
}

function packageInfo() {
  return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
}

function installManifest({ pkg, selected }) {
  return JSON.stringify({
    package: pkg.name,
    version: pkg.version,
    installedAt: new Date().toISOString(),
    agents: selected,
    updateCommand: 'npx -y web-uplift@latest update --agent all',
  }, null, 2) + '\n';
}

function readInstallManifest(vendorRoot) {
  const path = join(vendorRoot, 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { invalid: true };
  }
}

function printExistingInstallNotice(vendorRoot, pkg) {
  if (!existsSync(vendorRoot)) return;
  const manifest = readInstallManifest(vendorRoot);
  if (!manifest) {
    console.log(`Existing web-uplift install found without a manifest. Writing ${pkg.version} metadata.\n`);
    return;
  }
  if (manifest.invalid) {
    console.log(`Existing web-uplift manifest is invalid. Rewriting with ${pkg.version} metadata.\n`);
    return;
  }
  if (manifest.version && manifest.version !== pkg.version) {
    console.log(`Existing web-uplift install found: ${manifest.version}`);
    console.log(`Updating to: ${pkg.version}\n`);
    return;
  }
  if (manifest.version) {
    console.log(`Existing web-uplift install found: ${manifest.version} (current)\n`);
  }
}

function applyStep(step) {
  if (step.action === 'copy-dir') {
    copyDir(step.from, step.to);
  } else if (step.action === 'copy-file') {
    mkdirSync(dirname(step.to), { recursive: true });
    copyFileSync(step.from, step.to);
  } else if (step.action === 'write') {
    mkdirSync(dirname(step.to), { recursive: true });
    writeFileSync(step.to, step.content);
  } else if (step.action === 'append') {
    mkdirSync(dirname(step.to), { recursive: true });
    let existing = existsSync(step.to) ? readFileSync(step.to, 'utf8') : '';
    if (existing.includes('<!-- web-uplift:install -->')) return; // idempotent
    writeFileSync(step.to, existing + step.content);
  }
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copyDir(src, dst);
    else copyFileSync(src, dst);
  }
}

function dependencyCopySteps(rootNames, destNodeModules) {
  const seen = new Set();
  const steps = [];
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);

    let pkgJsonPath;
    try {
      pkgJsonPath = require.resolve(`${name}/package.json`);
    } catch {
      throw new Error(
        `Cannot vendor dependency "${name}" because it could not be resolved. ` +
          'Run npm install in the web-uplift package first.',
      );
    }
    const pkgDir = dirname(pkgJsonPath);

    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep);
    steps.push({
      action: 'copy-dir',
      from: pkgDir,
      to: join(destNodeModules, ...name.split('/')),
      what: `evidence runtime dependency: ${name}`,
    });
  };
  for (const name of rootNames) visit(name);
  return steps;
}

// --- passthrough -----------------------------------------------------------

function passthrough(scriptPath, scriptArgs) {
  const child = spawn(process.execPath, [scriptPath, ...scriptArgs], { stdio: 'inherit' });
  child.on('close', (code) => process.exit(code ?? 0));
  child.on('error', (err) => { console.error(err); process.exit(1); });
}

async function maybeWarnForUpdate(cmd, args = []) {
  if (!shouldCheckForUpdate(cmd, args)) return;
  try {
    const pkg = packageInfo();
    const cached = readUpdateCache();
    const now = Date.now();
    if (cached && now - cached.checkedAt < UPDATE_CHECK_TTL_MS) {
      printUpdateWarning(pkg.version, cached.latest);
      return;
    }
    const latest = await fetchLatestVersion(pkg.name);
    writeUpdateCache({ latest, checkedAt: now });
    printUpdateWarning(pkg.version, latest);
  } catch {
    // Update checks should never block normal CLI use.
  }
}

function shouldCheckForUpdate(cmd, args = []) {
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || cmd === '--version' || cmd === '-v') return false;
  if (args.includes('--help') || args.includes('-h')) return false;
  if (process.env.WEB_UPLIFT_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER || process.env.CI) return false;
  return true;
}

function updateCachePath() {
  const root = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(root, 'web-uplift', 'update-check.json');
}

function readUpdateCache() {
  const path = updateCachePath();
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof data.latest !== 'string' || typeof data.checkedAt !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

function writeUpdateCache(data) {
  const path = updateCachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

async function fetchLatestVersion(packageName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
    const data = await response.json();
    if (typeof data.version !== 'string') throw new Error('npm registry response had no version');
    return data.version;
  } finally {
    clearTimeout(timer);
  }
}

function printUpdateWarning(current, latest) {
  if (!latest || compareVersions(latest, current) <= 0) return;
  console.error(
    `web-uplift ${latest} is available. Current: ${current}.\n` +
      'Run: npx -y web-uplift@latest update --agent all\n' +
      'Set WEB_UPLIFT_NO_UPDATE_CHECK=1 to disable this check.',
  );
}

function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function versionParts(version) {
  return String(version)
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function parseFlags(flags, valueFlags) {
  const out = {};
  for (let i = 0; i < flags.length; i++) {
    if (flags[i].startsWith('--')) {
      const key = flags[i].slice(2);
      const next = flags[i + 1];
      if (valueFlags.has(key) && next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

function printHelp() {
  console.log(`web-uplift - fully agentic modern-web quality auditing + fixing

Usage:
  web-uplift <command> [options]

PRIMARY (subscription) path - run it in YOUR agent:
  web-uplift install [--agent ${AGENT_NAMES.join('|')}|all] [--dry-run] [--target <dir>]
                          Place the web-audit skill + evidence CLIs into a project
                          for the chosen agent(s), then run /web-audit <url> and the
                          fix loop INSIDE your own agent session (uses your plan).
  web-uplift update  [--agent ${AGENT_NAMES.join('|')}|all] [--dry-run] [--target <dir>]
                          Refresh an existing project install with the current
                          package's skill, evidence CLI, schemas and knowledge.

HEADLESS / CI path (uses API tokens):
  web-uplift audit [urls...] [--urls <file>] [--agent <name>] [--dry-run]
                                                            Batch fan-out audit.
  web-uplift fix --target <dir> --audit-url <url> [...]      Model-driven hill-climb.
  web-uplift aggregate [--reports <dir>]                     Cross-site summary.
  web-uplift compare <host|url> [runA] [runB]                Diff two retained runs (before/after).
  web-uplift evidence <primitive> <url> [options]            Raw-CDP evidence primitives.

  web-uplift --help | --version

Agents: ${AGENT_NAMES.join(', ')}.
Adding an agent is one entry in runner/agents.mjs (headless) + one in this CLI's
agentTargets() (install). See README.md for the cross-agent install matrix.`);
}
