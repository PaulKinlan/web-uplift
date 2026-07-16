#!/usr/bin/env node
import http from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { gather } from '../evidence/cli.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), 'web-uplift-regression-'));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'reports', 'scratch']);

try {
  testSyntaxChecks();
  testPackageRootImportIsSideEffectFree();
  testSchemaValidation();
  testAtomicCoverageValidator();
  testGuidanceUsage();
  testInstalledEvidenceCli();
  testUpdateDryRunReadsInstallManifest();
  testCachedUpdateWarning();
  await testPreNavigationEmulation();
  await testHarRedirects();
  testBatchDryRunUsesRetainedDirs();
  testBatchFlowDryRun();
  await testScorecardScoringAndRender();
  await testDiscoverabilityHelpers();
  await testFlowNormalize();
  console.log('tests OK');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// Modern Web Guidance is mandatory: a report with issue-findings must record the
// guides it consulted, and every issue-finding must cite a guidanceId drawn from
// that list. This is what stops the "audit judged from memory, never called MWG"
// failure users reported — a report that skipped guidance fails validation here.
function testAtomicCoverageValidator() {
  const validator = join(repoRoot, 'schema', 'validate-report.mjs');
  const catalog = join(repoRoot, 'knowledge', 'principles.json');
  const valid = run(process.execPath, [validator, catalog, join(repoRoot, 'examples', 'playground-report.json')]);
  assert(valid.status === 0, `atomic coverage: valid fixture failed:\n${valid.stderr}\n${valid.stdout}`);

  const incomplete = JSON.parse(readFileSync(join(repoRoot, 'examples', 'playground-report.json'), 'utf8'));
  incomplete.checkOutcomes = incomplete.checkOutcomes.slice(1);
  incomplete.status = 'partial';
  incomplete.coverage = { ...incomplete.coverage, recorded: incomplete.checkOutcomes.length, judged: incomplete.checkOutcomes.length, missing: 1, complete: false };
  delete incomplete.overallScore;
  const incompletePath = join(tmp, 'incomplete-report.json');
  writeFileSync(incompletePath, JSON.stringify(incomplete));
  const rejected = run(process.execPath, [validator, catalog, incompletePath]);
  assert(rejected.status !== 0, `atomic coverage: missing check was not rejected:\n${rejected.stderr}\n${rejected.stdout}`);
}

function testGuidanceUsage() {
  const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));
  const findings = report.findings || [];
  assert(findings.length > 0, 'guidance: fixture should have issue-findings to check');
  const consulted = report.guidanceConsulted || [];
  assert(Array.isArray(consulted) && consulted.length > 0,
    'guidance: a report with issue-findings must populate guidanceConsulted (MWG was not called)');
  const consultedSet = new Set(consulted);
  for (const f of findings) {
    assert(typeof f.guidanceId === 'string' && f.guidanceId.length > 0,
      `guidance: finding ${f.id} is missing a guidanceId (its fix is not backed by Modern Web Guidance)`);
    assert(consultedSet.has(f.guidanceId),
      `guidance: finding ${f.id} cites guidanceId "${f.guidanceId}" that is not in guidanceConsulted`);
  }
  // The clean/fixed report may have no findings, but if it lists guidance it must be an array.
  const fixed = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  assert(fixed.guidanceConsulted === undefined || Array.isArray(fixed.guidanceConsulted),
    'guidance: fixed report guidanceConsulted must be an array when present');
}

async function testScorecardScoringAndRender() {
  const { scoreReport, renderScorecard, renderTextScorecard, scorecardSummary, evaluateGates, OUTCOMES } = await import('../aggregate/scorecard.mjs');
  const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));

  const scored = scoreReport(report);
  const incomplete = structuredClone(report);
  incomplete.coverage.complete = false;
  let refusedIncomplete = false;
  try { scoreReport(incomplete); } catch (error) { refusedIncomplete = /Refusing to score/.test(error.message); }
  assert(refusedIncomplete, 'scorecard: incomplete atomic coverage must be refused');
  // The 9-finding playground should not be perfect, and must not exceed 100.
  assert(typeof scored.overall === 'number', 'scorecard: overall should be numeric for the playground report');
  assert(scored.overall > 0 && scored.overall < 100, `scorecard: expected an imperfect overall, got ${scored.overall}`);
  assert(scored.outcomes.length === OUTCOMES.length, 'scorecard: every outcome should be represented');
  for (const o of scored.outcomes) {
    assert(o.score === null || (o.score >= 0 && o.score <= 100), `scorecard: ${o.key} score out of range: ${o.score}`);
  }
  // A clean report scores 100 with no findings.
  const fixed = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  assert(scoreReport(fixed).overall === 100, 'scorecard: a findings-free report should score 100');

  // The rendered page must be self-contained and well-formed enough to open.
  report.__runId = 'r1';
  const html = renderScorecard({
    host: 'example',
    generatedAt: '2026-01-01 00:00',
    runs: [{ runId: 'r1', dir: join(repoRoot, 'examples'), report, compare: null, ...scored }],
    latest: { runId: 'r1', dir: join(repoRoot, 'examples'), report, compare: null, ...scored },
  });
  assert(html.startsWith('<!doctype html>'), 'scorecard: HTML should start with a doctype');
  assert(!html.includes('${'), 'scorecard: HTML contains an unresolved template placeholder');
  assert(!/>\s*undefined\s*</.test(html), 'scorecard: HTML contains a literal undefined');
  const openDialogs = (html.match(/<dialog /g) || []).length;
  const closeDialogs = (html.match(/<\/dialog>/g) || []).length;
  assert(openDialogs === closeDialogs && openDialogs >= report.findings.length, 'scorecard: dialog tags are unbalanced');

  // The inline text scorecard leads with the overall + a link, same numbers.
  const text = renderTextScorecard(
    { host: 'example', latest: { runId: 'r1', dir: join(repoRoot, 'examples'), report, ...scored } },
    { htmlPath: 'reports/example/scorecard.html' },
  );
  assert(text.includes(`Overall: ${scored.overall}/100`), 'scorecard text: overall line missing/mismatched');
  assert(text.includes('reports/example/scorecard.html'), 'scorecard text: HTML link missing');
  assert(text.includes('Do these first:'), 'scorecard text: top-3 section missing');

  // CI gate: machine summary + threshold evaluation.
  const data = { host: 'example', generatedAt: 'now', latest: { runId: 'r1', dir: join(repoRoot, 'examples'), report, ...scored } };
  const summary = scorecardSummary(data);
  assert(summary.overall === scored.overall, 'scorecardSummary: overall mismatch');
  assert(summary.findingsTotal === report.findings.length, 'scorecardSummary: findings total mismatch');
  assert(typeof summary.outcomes.discoverable !== 'undefined', 'scorecardSummary: outcomes map missing keys');

  // An impossible bar fails; a trivially-met bar passes.
  const fail = evaluateGates(summary, { min: {}, minOverall: 100, maxCritical: 0 });
  assert(fail.passed === false && fail.checks.some((c) => !c.ok), 'gate: overall=100 should fail an imperfect report');
  const pass = evaluateGates(summary, { min: {}, minOverall: 1, maxHigh: 999 });
  assert(pass.passed === true, 'gate: trivial thresholds should pass');
  // A not-applicable outcome never fails its gate.
  const naGate = evaluateGates({ overall: 50, outcomes: { memory: null }, findingsBySeverity: { critical: 0, high: 0 } }, { min: { memory: 90 } });
  assert(naGate.passed === true, 'gate: a null (N/A) outcome must not fail its gate');
}

async function testDiscoverabilityHelpers() {
  const { stripHtmlToText, contentTokens, detectEmptyMounts } = await import('../evidence/cli.mjs');

  // stripHtmlToText drops scripts/styles/markup, keeps visible text.
  const text = stripHtmlToText('<html><head><style>.x{color:red}</style></head><body><h1>Hello There</h1><script>var a=1</script><p>Body &amp; content</p></body></html>');
  assert(text.includes('Hello There') && text.includes('Body & content'), `stripHtmlToText missed content: ${text}`);
  assert(!text.includes('color:red') && !text.includes('var a'), `stripHtmlToText leaked script/style: ${text}`);

  // contentTokens keeps >=4-char words, lowercased, de-duped.
  const toks = contentTokens('The Thylakoid MEMBRANE membrane a to');
  assert(toks.has('thylakoid') && toks.has('membrane'), 'contentTokens missing expected words');
  assert(!toks.has('the') && !toks.has('to'), 'contentTokens should skip short words');
  assert(toks.size === 2, `contentTokens should de-dupe case-insensitively, got ${toks.size}`);

  // detectEmptyMounts flags an empty SPA root but not a filled one.
  assert(detectEmptyMounts('<div id="root"></div>').includes('#root'), 'should detect empty #root');
  assert(detectEmptyMounts('<div id="root"><h1>hi</h1></div>').length === 0, 'should not flag a filled #root');
  assert(detectEmptyMounts('<div id="__next">   </div>').includes('#__next'), 'should detect empty #__next');
}

async function testFlowNormalize() {
  const { normalizeFlow } = await import('../runner/flow.mjs');

  // A Chrome DevTools Recorder export normalises cleanly (same shape we use).
  const recorderJson = {
    title: 'Search',
    steps: [
      { type: 'setViewport', width: 1200, height: 800 },
      { type: 'navigate', url: 'https://example.com/' },
      { type: 'click', selectors: [['aria/Search'], ['#go']], target: 'main' },
      null, // stray/empty entries are dropped
    ],
  };
  const flow = normalizeFlow(recorderJson);
  assert(flow.title === 'Search', 'flow: title should carry through');
  assert(flow.steps.length === 3, `flow: empty steps should be dropped, got ${flow.steps.length}`);
  assert(flow.steps[2].selectors[0][0] === 'aria/Search', 'flow: selectors preserved');

  // Not-a-flow inputs throw.
  let threw = false;
  try { normalizeFlow({ nope: true }); } catch { threw = true; }
  assert(threw, 'flow: an object without steps[] must throw');
}

function run(command, args, opts = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...opts,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function testSyntaxChecks() {
  for (const file of listFiles(repoRoot, (p) => p.endsWith('.mjs'))) {
    const result = run(process.execPath, ['--check', file]);
    assert(result.status === 0, `syntax check failed for ${file}:\n${result.stderr || result.stdout}`);
  }
}

function testPackageRootImportIsSideEffectFree() {
  const result = run(process.execPath, [
    '--input-type=module',
    '-e',
    "import 'web-uplift'; console.log('import-ok')",
  ]);
  assert(result.status === 0, `package root import failed:\n${result.stderr || result.stdout}`);
  assert(result.stdout.trim() === 'import-ok', `package root import produced side effects:\n${result.stdout}`);
}

function testSchemaValidation() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const configSchema = readJson('schema/config.schema.json');
  const findingsSchema = readJson('schema/findings.schema.json');
  ajv.compile(configSchema);
  ajv.compile(findingsSchema);

  validateJson(ajv, configSchema, 'web-uplift.json');
  validateJson(ajv, configSchema, 'web-uplift.example.json');
  validateJson(ajv, findingsSchema, 'examples/playground-report.json');
  validateJson(ajv, findingsSchema, 'examples/playground-report-fixed.json');
}

function testInstalledEvidenceCli() {
  const target = join(tmp, 'installed-target');
  const tarball = packTarball();
  const install = run('npm', [
    'exec',
    '--yes',
    '--package',
    tarball,
    '--',
    'web-uplift',
    'install',
    '--agent',
    'codex',
    '--target',
    target,
  ], { env: noUpdateEnv() });
  assert(install.status === 0, `install failed: ${install.stderr || install.stdout}`);

  const manifest = JSON.parse(readFileSync(join(target, '.web-uplift/manifest.json'), 'utf8'));
  const pkg = readJson('package.json');
  assert(manifest.package === pkg.name, `installed manifest package mismatch: ${JSON.stringify(manifest)}`);
  assert(manifest.version === pkg.version, `installed manifest version mismatch: ${JSON.stringify(manifest)}`);
  assert(manifest.agents.includes('codex'), `installed manifest missed selected agent: ${JSON.stringify(manifest)}`);

  const evidenceUsage = run(process.execPath, ['.web-uplift/evidence/cli.mjs'], {
    cwd: target,
  });
  assert(evidenceUsage.status === 1, 'evidence CLI without args should print usage and exit 1');
  assert(
    evidenceUsage.stderr.includes('Usage: node evidence/cli.mjs') &&
      !evidenceUsage.stderr.includes('ERR_MODULE_NOT_FOUND'),
    `installed evidence CLI did not load cleanly:\n${evidenceUsage.stderr}`,
  );

  // The scorecard must be vendored too (aggregate/ + the runner/ it imports), so
  // an installed project can generate the interactive scorecard. A clean load
  // prints its usage; a missing aggregate/ or runner/ would throw at import.
  const scorecardUsage = run(process.execPath, ['.web-uplift/aggregate/scorecard.mjs'], { cwd: target });
  assert(
    !scorecardUsage.stderr.includes('ERR_MODULE_NOT_FOUND') && scorecardUsage.stderr.includes('scorecard'),
    `installed scorecard did not load (aggregate/ or runner/ not vendored?):\n${scorecardUsage.stderr}`,
  );
}

function testUpdateDryRunReadsInstallManifest() {
  const target = join(tmp, 'update-target');
  mkdirSync(join(target, '.web-uplift'), { recursive: true });
  writeFileSync(join(target, '.web-uplift/manifest.json'), JSON.stringify({
    package: 'web-uplift',
    version: '0.0.1',
    installedAt: '2026-01-01T00:00:00.000Z',
    agents: ['codex'],
  }, null, 2) + '\n');

  const pkg = readJson('package.json');
  const result = run(process.execPath, [
    'bin/web-uplift.mjs',
    'update',
    '--agent',
    'codex',
    '--target',
    target,
    '--dry-run',
  ], { env: noUpdateEnv() });
  assert(result.status === 0, `update dry-run failed: ${result.stderr || result.stdout}`);
  assert(result.stdout.includes('Existing web-uplift install found: 0.0.1'), `update did not read old manifest:\n${result.stdout}`);
  assert(result.stdout.includes(`Updating to: ${pkg.version}`), `update did not print target version:\n${result.stdout}`);
  assert(result.stdout.includes('.web-uplift/manifest.json'), `update dry-run did not include manifest write:\n${result.stdout}`);
}

function testCachedUpdateWarning() {
  const cacheRoot = join(tmp, 'update-cache');
  mkdirSync(join(cacheRoot, 'web-uplift'), { recursive: true });
  writeFileSync(join(cacheRoot, 'web-uplift/update-check.json'), JSON.stringify({
    latest: '999.0.0',
    checkedAt: Date.now(),
  }, null, 2) + '\n');

  const result = run(process.execPath, [
    'bin/web-uplift.mjs',
    'install',
    '--agent',
    'codex',
    '--target',
    join(tmp, 'cached-update-target'),
    '--dry-run',
  ], {
    env: {
      ...process.env,
      XDG_CACHE_HOME: cacheRoot,
      CI: '',
      WEB_UPLIFT_NO_UPDATE_CHECK: '',
    },
  });
  assert(result.status === 0, `cached update warning command failed: ${result.stderr || result.stdout}`);
  assert(result.stderr.includes('web-uplift 999.0.0 is available'), `cached update warning was not printed:\n${result.stderr}`);
  assert(result.stderr.includes('npx -y web-uplift@latest update --agent all'), `cached update warning missed update command:\n${result.stderr}`);
}

async function testPreNavigationEmulation() {
  const html =
    '<!doctype html><script>' +
    "window.initialReduce = matchMedia('(prefers-reduced-motion: reduce)').matches;" +
    '</script>';
  const value = await gather(
    'evaluate',
    `data:text/html,${encodeURIComponent(html)}`,
    {
      quiet: true,
      wait: 0,
      emulateMedia: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      expr:
        "({ initial: window.initialReduce, current: matchMedia('(prefers-reduced-motion: reduce)').matches })",
    },
  );
  assert(value.initial === true, `emulated media was not visible during load: ${JSON.stringify(value)}`);
  assert(value.current === true, `emulated media was not visible after load: ${JSON.stringify(value)}`);
}

async function testHarRedirects() {
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/final' });
      res.end('redirecting');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>ok</title><link rel="icon" href="data:,">ok');
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'network.har');
    const result = await gather('har', `http://127.0.0.1:${port}/start`, {
      quiet: true,
      wait: 250,
      out,
    });
    assert(result.statusBreakdown['302'] === 1, `HAR status breakdown missed redirect: ${JSON.stringify(result.statusBreakdown)}`);

    const summary = JSON.parse(readFileSync(join(tmp, 'network-summary.json'), 'utf8'));
    assert(
      summary.hygiene.redirects.some((r) => r.status === 302 && r.location === '/final'),
      `HAR summary missed redirect hygiene entry: ${JSON.stringify(summary.hygiene.redirects)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function testBatchDryRunUsesRetainedDirs() {
  const reports = join(tmp, 'reports');
  const result = run(process.execPath, [
    'runner/run-batch.mjs',
    '--dry-run',
    '--agent',
    'codex',
    '--out',
    reports,
    'https://example.com',
  ]);
  assert(result.status === 0, `batch dry-run failed: ${result.stderr || result.stdout}`);
  assert(
    result.stdout.includes(`${reports}/example_com/<timestamp>`),
    `batch dry-run did not use retained run dir:\n${result.stdout}`,
  );
  assert(!result.stdout.includes(`${reports}/codex/`), `batch dry-run still used old agent prefix:\n${result.stdout}`);
}

function testBatchFlowDryRun() {
  const reports = join(tmp, 'reports-flow');
  const flowPath = join(tmp, 'flow.json');
  writeFileSync(flowPath, JSON.stringify({
    title: 'Signup',
    steps: [{ type: 'navigate', url: 'https://example.com/' }, { type: 'click', selectors: [['#go']] }],
  }));
  const result = run(process.execPath, [
    'runner/run-batch.mjs', '--dry-run', '--agent', 'claude', '--out', reports, '--flow', flowPath, 'https://example.com',
  ]);
  assert(result.status === 0, `batch --flow dry-run failed: ${result.stderr || result.stdout}`);
  assert(result.stdout.includes('would replay') && result.stdout.includes('Signup'), `batch --flow dry-run did not announce the replay:\n${result.stdout}`);
  assert(result.stdout.includes('already replayed for you'.toLowerCase()) || result.stdout.includes('ALREADY replayed'), `batch --flow dry-run did not pass flow guidance to the agent:\n${result.stdout}`);
}

function packTarball() {
  const packDir = join(tmp, 'pack');
  mkdirSync(packDir, { recursive: true });
  const result = run('npm', ['pack', '--quiet', '--pack-destination', packDir]);
  assert(result.status === 0, `npm pack failed:\n${result.stderr || result.stdout}`);
  const file = result.stdout.trim().split('\n').filter(Boolean).pop();
  assert(file, `npm pack did not print a tarball name:\n${result.stdout}`);
  return join(packDir, file);
}

function readJson(path) {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
}

function noUpdateEnv() {
  return { ...process.env, WEB_UPLIFT_NO_UPDATE_CHECK: '1' };
}

function validateJson(ajv, schema, path) {
  const validate = ajv.compile(schema);
  const data = readJson(path);
  if (!validate(data)) {
    throw new Error(`${path} failed schema validation:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`);
  }
}

function listFiles(dir, predicate, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) listFiles(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}
