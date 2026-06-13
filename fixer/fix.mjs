#!/usr/bin/env node
// web-uplift fixer: the automated fix + PR engine (the hill-climb).
//
//   npm run fix -- --target <path> [--audit-url <url>] [--pr] [options]
//
// Options:
//   --target <path>     Source dir to fix (e.g. a working copy of playground/)
//   --audit-url <url>   URL the running target is served at (for re-audit).
//                       Defaults to http://localhost:8080/ .
//   --before <file>     Where to write the before (issues) report base name.
//   --after <file>      Where to write the after report base name.
//   --out <dir>         Report output dir (default: reports/fix-<host>).
//   --max-passes <n>    Max hill-climb passes (default 3).
//   --pr                After fixing, create a branch + open a demo PR via gh.
//   --pr-title <t>      PR title.
//   --pr-base <b>       PR base branch (default: master).
//   --dry-run           Compute fixes but do not write files.
//
// Flow:
//   1. Audit the target as served (the "before" report).
//   2. For each finding, find a registered transform for its scenario and apply
//      it to the target source (deterministic path). The architecture leaves a
//      seam for an LLM transform to handle classes the deterministic path does
//      not cover.
//   3. Re-audit (hill-climb): repeat until no findings remain or no further
//      progress is made or max passes is hit.
//   4. Emit before/after reports and, with --pr, open a demo PR.
//
// Re-auditing requires the target to be SERVED at --audit-url. For the
// playground this means `npm run playground` (serve playground/ on :8080).
// When fixing a *copy*, point a server at the copy and pass its URL. The fixer
// will (re)write files in --target; serve --target.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runAudit } from '../auditor/audit.mjs';
import { renderMarkdown } from '../auditor/report.mjs';
import { TRANSFORMS } from './transforms.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { _: [], maxPasses: 3, prBase: 'master' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') args.target = argv[++i];
    else if (a === '--audit-url') args.auditUrl = argv[++i];
    else if (a === '--before') args.before = argv[++i];
    else if (a === '--after') args.after = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--max-passes') args.maxPasses = Number(argv[++i]);
    else if (a === '--pr') args.pr = true;
    else if (a === '--pr-title') args.prTitle = argv[++i];
    else if (a === '--pr-base') args.prBase = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--quiet') args.quiet = true;
    else args._.push(a);
  }
  return args;
}

// Apply the deterministic transform for a finding to the target source.
// Returns { applied, file, note }.
function applyDeterministicFix(finding, target, { dryRun, log }) {
  const entry = TRANSFORMS[finding.scenario];
  if (!entry) {
    return { applied: false, note: `no deterministic transform for "${finding.scenario}"` };
  }
  const filePath = join(target, entry.file);
  if (!existsSync(filePath)) {
    return { applied: false, note: `target file missing: ${entry.file}` };
  }
  const before = readFileSync(filePath, 'utf8');
  const { text, changed } = entry.transform(before);
  if (!changed) {
    return { applied: false, file: entry.file, note: 'transform did not match (already fixed?)' };
  }
  if (!dryRun) writeFileSync(filePath, text);
  log(`[fix] ${dryRun ? '[dry-run] would apply' : 'applied'} ${finding.scenario} -> ${entry.file}`);
  return { applied: true, file: entry.file, note: 'deterministic transform applied' };
}

async function audit(url, name, outDir, quiet) {
  const { report, markdown } = await runAudit(url, { quiet, noGuidance: true });
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(outDir, `${name}.md`), markdown);
  }
  return report;
}

export async function runFix(opts) {
  const log = opts.quiet ? () => {} : (m) => console.error(m);
  const target = resolve(opts.target);
  const auditUrl = opts.auditUrl || 'http://localhost:8080/';
  let host = 'target';
  try {
    host = new URL(auditUrl).host.replace(/[:.]/g, '_');
  } catch {
    // ignore
  }
  const outDir = opts.out ? resolve(opts.out) : join(repoRoot, 'reports', `fix-${host}`);

  log(`[fix] target: ${target}`);
  log(`[fix] audit url: ${auditUrl}`);

  // 1. Before report.
  const before = await audit(auditUrl, opts.before || 'before', outDir, opts.quiet);
  log(`[fix] before: ${before.findings.length} finding(s)`);

  // 2 + 3. Hill-climb.
  const applied = [];
  let pass = 0;
  let current = before;
  while (current.findings.length > 0 && pass < opts.maxPasses) {
    pass++;
    log(`[fix] --- pass ${pass} (${current.findings.length} open) ---`);
    let madeProgress = false;
    for (const finding of current.findings) {
      const res = applyDeterministicFix(finding, target, { dryRun: opts.dryRun, log });
      if (res.applied) {
        madeProgress = true;
        applied.push({ scenario: finding.scenario, file: res.file, findingId: finding.id });
      }
    }
    if (!madeProgress) {
      log('[fix] no further progress this pass; stopping.');
      break;
    }
    if (opts.dryRun) {
      log('[fix] dry-run: skipping re-audit.');
      break;
    }
    // Re-audit against the live target (caller serves --target).
    current = await audit(auditUrl, `pass-${pass}`, outDir, opts.quiet);
    log(`[fix] after pass ${pass}: ${current.findings.length} finding(s)`);
  }

  // 4. After report (final state).
  const after = opts.dryRun
    ? current
    : await audit(auditUrl, opts.after || 'after', outDir, opts.quiet);

  const summary = {
    target,
    auditUrl,
    passes: pass,
    before: { findings: before.findings.length, scenarios: before.findings.map((f) => f.scenario) },
    after: { findings: after.findings.length, scenarios: after.findings.map((f) => f.scenario) },
    applied,
    outDir,
  };
  return { before, after, summary };
}

function openPr(opts, summary, log) {
  const branch = `demo/fix-engine-playground-${Date.now()}`;
  const title = opts.prTitle || '[demo] fix engine: playground hill-climb';
  const body = buildPrBody(summary);
  const bodyFile = join(repoRoot, 'reports', `.pr-body-${Date.now()}.md`);
  mkdirSync(dirname(bodyFile), { recursive: true });
  writeFileSync(bodyFile, body);

  const git = (...a) => execFileSync('git', a, { cwd: repoRoot, stdio: 'pipe' }).toString();
  log(`[fix] creating branch ${branch}`);
  git('checkout', '-b', branch);
  // Stage only the target source changes (the playground), not reports.
  git('add', 'playground');
  git(
    'commit',
    '-m',
    'demo: fix engine applies playground hill-climb fixes\n\nDemo only - do not merge. The fixer applied deterministic, guidance-backed\nfixes to the playground scenarios so the auditor goes from issues to clean.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>',
  );
  git('push', '-u', 'origin', branch);
  const url = execFileSync(
    'gh',
    [
      'pr',
      'create',
      '--title',
      title,
      '--body-file',
      bodyFile,
      '--base',
      opts.prBase,
      '--head',
      branch,
    ],
    { cwd: repoRoot, stdio: 'pipe' },
  )
    .toString()
    .trim();
  log(`[fix] PR: ${url}`);
  // Return to base branch and leave master's playground untouched.
  git('checkout', opts.prBase);
  return url;
}

function buildPrBody(s) {
  return `**Demo PR - do not merge.** This shows the web-uplift fix engine taking the seeded playground from "issues" to "clean" via the audit -> fix -> re-audit hill-climb. master's playground stays in issues mode on purpose.

## Before -> after (real auditor numbers)

| | Findings | Scenarios |
|---|---|---|
| Before | ${s.before.findings} | ${s.before.scenarios.join(', ') || 'none'} |
| After | ${s.after.findings} | ${s.after.scenarios.join(', ') || 'none'} |

- Hill-climb passes: ${s.passes}
- Fixes applied (deterministic, guidance-backed):
${s.applied.map((a) => `  - \`${a.scenario}\` in \`${a.file}\``).join('\n')}

The auditor drives the system Chrome headless purely over the Chrome DevTools Protocol (\`chrome-remote-interface\`): emulating prefers-color-scheme / prefers-reduced-motion, narrow viewport metrics, and a layout-shift PerformanceObserver. Each fix mirrors the Modern Web Guidance technique for its issue class (light-dark(), prefers-reduced-motion gate, fluid max-width, :focus-visible, reserved min-height, @container).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target) {
    console.error('Usage: npm run fix -- --target <path> [--audit-url <url>] [--pr] [--dry-run]');
    process.exit(1);
  }
  const { summary } = await runFix(args);
  console.error('[fix] summary:', JSON.stringify(summary, null, 2));

  if (args.pr && !args.dryRun) {
    const log = (m) => console.error(m);
    const url = openPr(args, summary, log);
    console.error(`[fix] opened PR: ${url}`);
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
