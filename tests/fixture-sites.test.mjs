import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sites = ['playground', 'eval/fixtures/seeded-issues/site'];
const expectedIds = ['fixed-layout', 'no-dark-mode', 'poor-focus', 'layout-shift', 'motion', 'no-container-queries'];

function jsFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `${path}: symlink cannot be checked as a site module`);
    return entry.isDirectory() ? jsFiles(path) : entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  });
}

for (const site of sites) {
  const siteDir = join(root, site);
  const html = readFileSync(join(siteDir, 'index.html'), 'utf8');
  assert.match(html, /<script\s+type="module"\s+src="\.\/app\.js"/, `${site}: entry script`);

  const files = jsFiles(siteDir);
  for (const file of files) {
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${file}: invalid JavaScript: ${check.stderr}`);
    const source = readFileSync(file, 'utf8');
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
  console.log(`fixture-site: checked ${site} (${files.length} JavaScript modules, six scenarios)`);
}
