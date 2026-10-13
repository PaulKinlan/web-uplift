#!/usr/bin/env node
// Fast-tier coverage of playground/ and the seeded-issues fixture is SYNTAX AND STRUCTURE ONLY.
// Browser behaviour is exercised by .github/workflows/audit-playground.yml. If behaviour changes,
// drive the affected site in a browser and use that CI workflow; a green fast gate cannot prove it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSuite } from './test-helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sites = ['playground', 'eval/fixtures/seeded-issues/site'];
const expectedIds = ['fixed-layout', 'no-dark-mode', 'poor-focus', 'layout-shift', 'motion', 'no-container-queries'];
const expectedModules = ['app.js', 'scenarios/index.js', 'scenarios/util.js', ...expectedIds.map((id) => `scenarios/${id}.js`)].sort();

// One Node child parses ES module syntax without executing DOM code; no browser, network, or per-file spawns.
const parseModules = (modules) => spawnSync(process.execPath, [
  '--experimental-vm-modules', '--no-warnings', '--input-type=module', '-e',
  'import { SourceTextModule } from "node:vm"; for (const [name, source] of JSON.parse(await new Promise((resolve) => { let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => resolve(s)); }))) { try { new SourceTextModule(source, { identifier: name }); } catch (error) { console.error(`${name}: ${error.message}`); process.exitCode = 1; } }',
], { input: JSON.stringify(modules), encoding: 'utf8', timeout: 5000 });

function jsFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `${path}: symlink cannot be checked as a site module`);
    return entry.isDirectory() ? jsFiles(path) : entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  });
}

function assertModuleSet(files, siteDir, site) {
  assert.deepEqual(files.map((file) => relative(siteDir, file)).sort(), expectedModules, `${site}: unexpected or missing JS module`);
}

export async function testFixtureSitesAreStructured() {
  const modules = [];
  for (const site of sites) {
    const siteDir = join(root, site);
    const html = readFileSync(join(siteDir, 'index.html'), 'utf8');
    assert.match(html, /<script\s+type="module"\s+src="\.\/app\.js"/, `${site}: entry script`);

    const files = jsFiles(siteDir);
    assertModuleSet(files, siteDir, site);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      modules.push([relative(root, file), source]);
      for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
        const dependency = resolve(dirname(file), match[1]);
        assert(files.includes(dependency), `${file}: local import ${match[1]} is outside the checked site graph`);
      }
    }

    const { scenarios } = await import(pathToFileURL(join(siteDir, 'scenarios', 'index.js')).href);
    assert.deepEqual(scenarios.map((scenario) => scenario.id), expectedIds, `${site}: scenario set and order`);
    for (const scenario of scenarios) {
      for (const field of ['principleId', 'principleCheckId', 'guidanceQuery']) {
        assert.equal(typeof scenario[field], 'string', `${site}: ${scenario.id}.${field}`);
        assert(scenario[field].length > 0, `${site}: ${scenario.id}.${field} must not be empty`);
      }
    }
  }
  assert.equal(modules.length, 18, 'both sites must provide exactly nine modules');
  const parsed = parseModules(modules);
  assert.equal(parsed.status, 0, `site module syntax failed: ${parsed.stderr}`);
}

export function testFixtureSiteChecksRejectBrokenModules() {
  const broken = parseModules([['broken.js', 'export const broken = ;']]);
  assert.equal(broken.status, 1, 'parser must reject invalid module syntax');
  assert.match(broken.stderr, /broken\.js:/, 'failure must identify the bad file');
  const siteDir = join(root, sites[0]);
  const missing = jsFiles(siteDir).filter((file) => file !== join(siteDir, 'app.js'));
  assert.throws(() => assertModuleSet(missing, siteDir, sites[0]), /unexpected or missing JS module/, 'missing app.js must fail the same set check');
}

export const fixtureSiteTests = [testFixtureSitesAreStructured, testFixtureSiteChecksRejectBrokenModules];
await runSuite(fixtureSiteTests, import.meta.url, { timeoutMs: 10000, concurrency: 1 });
