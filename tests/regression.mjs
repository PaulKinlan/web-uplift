#!/usr/bin/env node
import http from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
  testInstalledEvidenceCli();
  await testPreNavigationEmulation();
  await testHarRedirects();
  testBatchDryRunUsesRetainedDirs();
  console.log('tests OK');
} finally {
  rmSync(tmp, { recursive: true, force: true });
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
  ]);
  assert(install.status === 0, `install failed: ${install.stderr || install.stdout}`);

  const evidenceUsage = run(process.execPath, ['.web-uplift/evidence/cli.mjs'], {
    cwd: target,
  });
  assert(evidenceUsage.status === 1, 'evidence CLI without args should print usage and exit 1');
  assert(
    evidenceUsage.stderr.includes('Usage: node evidence/cli.mjs') &&
      !evidenceUsage.stderr.includes('ERR_MODULE_NOT_FOUND'),
    `installed evidence CLI did not load cleanly:\n${evidenceUsage.stderr}`,
  );
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
