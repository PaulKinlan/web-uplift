#!/usr/bin/env node
// web-uplift auditor: a deterministic, CDP-driven modern-UX check runner.
//
//   npm run audit -- <url> [options]
//   node auditor/audit.mjs <url> [options]
//
// Options:
//   --out <dir>        Output directory (default: reports/<host>)
//   --name <base>      Output file base name (default: report)
//   --expected <file>  Ground-truth file to score against
//                      (default: playground/expected-findings.json when the url
//                      points at the playground)
//   --no-guidance      Skip the Modern Web Guidance feed lookups (offline/fast)
//   --quiet            Less logging
//
// It launches the system Chrome headless, drives it purely over the Chrome
// DevTools Protocol via chrome-remote-interface (Page, Runtime, DOM, CSS,
// Emulation, Network), runs the programmatically-detectable checks implied by
// principles/principles.json, emits findings conforming to
// schema/findings.schema.json plus a markdown report, and (for the playground)
// scores precision/recall against expected-findings.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { launchChrome, newSession } from './browser.mjs';
import { checks } from './checks.mjs';
import { indexPrinciples, enrichWithGuidance } from './guidance.mjs';
import { scoreAgainstExpected } from './score.mjs';
import { buildReport, renderMarkdown } from './report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--expected') args.expected = argv[++i];
    else if (a === '--no-guidance') args.noGuidance = true;
    else if (a === '--quiet') args.quiet = true;
    else args._.push(a);
  }
  return args;
}

export async function runAudit(url, opts = {}) {
  const log = opts.quiet ? () => {} : (m) => console.error(m);
  const principles = JSON.parse(
    readFileSync(join(repoRoot, 'principles', 'principles.json'), 'utf8'),
  );
  const principlesIndex = indexPrinciples(principles);

  // Determine mode-under-test from the URL query for the eval label.
  let modeUnderTest = 'issues';
  try {
    modeUnderTest =
      new URL(url).searchParams.get('mode') === 'fixed' ? 'fixed' : 'issues';
  } catch {
    // non-URL; leave default
  }

  const chrome = await launchChrome({ log });
  const pathResults = [];
  try {
    const session = await newSession(chrome.port, { log });
    try {
      for (const check of checks) {
        log(`[audit] running ${check.name}`);
        const result = await check(session.client, url, log);
        pathResults.push(result);
      }
    } finally {
      await session.close();
    }
  } finally {
    await chrome.close();
  }

  // Enrich findings with guidance ids (best-effort, networked).
  if (!opts.noGuidance) {
    for (const pr of pathResults) {
      for (const f of pr.findings) {
        await enrichWithGuidance(f, principlesIndex, { log });
      }
    }
  }

  // Score against ground truth if available.
  let score = null;
  const expectedPath = resolveExpected(url, opts.expected);
  if (expectedPath) {
    try {
      const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
      const allFindings = pathResults.flatMap((p) => p.findings);
      score = scoreAgainstExpected(allFindings, expected, modeUnderTest);
      log(
        `[audit] eval (${modeUnderTest}): precision ${(score.precision * 100).toFixed(0)}% recall ${(score.recall * 100).toFixed(0)}%`,
      );
    } catch (err) {
      log(`[audit] could not score against ${expectedPath}: ${err.message}`);
    }
  }

  const report = buildReport({ url, mode: modeUnderTest, pathResults, score });
  return { report, markdown: renderMarkdown(report) };
}

function resolveExpected(url, explicit) {
  if (explicit) return resolve(explicit);
  // Auto-attach the playground ground truth when auditing localhost:8080.
  try {
    const u = new URL(url);
    if (
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
      u.port === '8080'
    ) {
      return join(repoRoot, 'playground', 'expected-findings.json');
    }
  } catch {
    // ignore
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args._[0];
  if (!url) {
    console.error('Usage: npm run audit -- <url> [--out dir] [--name base] [--expected file] [--no-guidance] [--quiet]');
    process.exit(1);
  }

  const { report, markdown } = await runAudit(url, args);

  let host = 'site';
  try {
    host = new URL(url).host.replace(/[:.]/g, '_');
  } catch {
    // ignore
  }
  const outDir = args.out ? resolve(args.out) : join(repoRoot, 'reports', host);
  mkdirSync(outDir, { recursive: true });
  const base = args.name || 'report';
  const jsonPath = join(outDir, `${base}.json`);
  const mdPath = join(outDir, `${base}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(mdPath, markdown);

  console.error(`[audit] wrote ${jsonPath}`);
  console.error(`[audit] wrote ${mdPath}`);
  if (report.eval) {
    const e = report.eval;
    if (e.mode === 'fixed') {
      console.error(
        `[audit] fixed-mode: ${e.foundCount} findings (precision ${(e.precision * 100).toFixed(0)}%)`,
      );
    } else {
      console.error(
        `[audit] issues-mode: precision ${(e.precision * 100).toFixed(0)}% recall ${(e.recall * 100).toFixed(0)}% (tp ${e.truePositives}, fn ${e.falseNegatives}, fp ${e.falsePositives})`,
      );
    }
  }
  console.error(`[audit] ${report.findings.length} finding(s)`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
