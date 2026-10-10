#!/usr/bin/env node
// SUITE CONVENTION, learned the expensive way (web-uplift-17o): a test that needs a local
// server must drive the CLI IN-PROCESS via gather() - NOT by running the CLI as a child with
// an in-process server. spawnSync blocks the parent's event loop, so the in-process server
// never answers the child's browser (observed directly: zero server hits and a 30s timeout
// on a HEALTHY page, for trace and dom alike). Worse, that failure mode MIMICS a starvation
// defect: a healthy page simply times out, indistinguishable from the behaviour under test,
// so a harness built that way cannot observe the behaviour it exists to check. The --out
// argument-validation tests are the exception: they exit before any browser launches, so a
// child run with an in-process server is safe there.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const SKIP_DIRS = new Set(['.git', 'node_modules', 'reports', 'scratch']);

export const tmp = mkdtempSync(join(tmpdir(), 'web-uplift-regression-'));
process.on('exit', () => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function run(command, args, opts = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...opts,
  });
}

// Async variant: spawnSync would block this process's event loop, so an
// in-process test server could not answer the child's browser. Bounded so a
// hung browser fails the suite instead of hanging it.
export function runAsync(command, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: repoRoot, timeout: 120000, ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

export function readJson(path) {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
}

export function noUpdateEnv() {
  return { ...process.env, WEB_UPLIFT_NO_UPDATE_CHECK: '1' };
}

export function validateJson(ajv, schema, path) {
  const validate = ajv.compile(schema);
  const data = readJson(path);
  if (!validate(data)) {
    throw new Error(`${path} failed schema validation:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`);
  }
}

export function listFiles(dir, predicate, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) listFiles(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

export function cleanStaleNpxRegressionTrees(currentTarball = '') {
  try {
    const npxDir = join(homedir(), '.npm', '_npx');
    if (!existsSync(npxDir)) return;
    const worktreeId = createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);
    const worktreeTag = `web-uplift-pack-${worktreeId}`;

    for (const entry of readdirSync(npxDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgJsonPath = join(npxDir, entry.name, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        const pkgs = pkg._npx?.packages || [];
        const dep = pkg.dependencies?.['web-uplift'] || '';
        const isOurWorktreeTree =
          pkgs.some((p) => typeof p === 'string' && p.includes(worktreeTag)) ||
          dep.includes(worktreeTag);
        if (!isOurWorktreeTree) continue;

        // Keep only the current active tarball for this worktree, sweep any older hashes
        const isCurrent =
          currentTarball &&
          (pkgs.some((p) => typeof p === 'string' && p.includes(currentTarball)) ||
            dep.includes(currentTarball));
        if (!isCurrent) {
          rmSync(join(npxDir, entry.name), { recursive: true, force: true });
        }
      } catch {
        /* ignore unparseable packages */
      }
    }
  } catch {
    /* ignore sweep errors */
  }
}

export function packTarball() {
  // Use a content-hashed tarball path scoped to the worktree so npm exec
  // reuses its ~/.npm/_npx cache tree when source is unchanged (saving ~42MB and
  // execution time), while automatically invalidating when the source changes
  // to avoid stale-package false passes (web-uplift-vvz).
  const worktreeId = createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);
  const packDir = join(tmpdir(), `web-uplift-pack-${worktreeId}`);
  mkdirSync(packDir, { recursive: true });

  const result = run('npm', ['pack', '--quiet', '--pack-destination', packDir]);
  assert(result.status === 0, `npm pack failed:\n${result.stderr || result.stdout}`);
  const file = result.stdout.trim().split('\n').filter(Boolean).pop();
  assert(file, `npm pack did not print a tarball name:\n${result.stdout}`);

  const rawPath = join(packDir, file);
  const content = readFileSync(rawPath);
  const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const stableTarball = join(packDir, `web-uplift-${contentHash}.tgz`);

  if (!existsSync(stableTarball)) {
    renameSync(rawPath, stableTarball);
  } else if (rawPath !== stableTarball) {
    rmSync(rawPath, { force: true });
  }

  // Remove older builds for this worktree to prevent pack directory bloat
  for (const f of readdirSync(packDir)) {
    const full = join(packDir, f);
    if (f !== `web-uplift-${contentHash}.tgz`) {
      try { rmSync(full, { force: true }); } catch {}
    }
  }

  cleanStaleNpxRegressionTrees(stableTarball);
  return stableTarball;
}

// Committed probes (evidence-out/**/submit.js, flow-probe.js) were created during
// interactive testing and committed as provenance of what was run, but their presence
// in the repo risked being executed by an unsuspecting agent or operator with live
// side-effects (e.g. form submission, lead creation, network requests against real targets)
// plus copy-pasteable sample personal data. The committed provenance files keep
// their names (write-scope.json:46/50 references them) and must stay INERT: the
// side-effecting line commented out as the record, the payload replaced with
// RFC 2606 placeholders. flow-probe.js keeps its read-only GET survey
// executable - GETs are not the defect class; the POST is. The negative
// control proves the checks FIRE on a live probe shape rather than vacuously
// passing.
export function assertProbeFileInert(file, { forbid }) {
  const text = readFileSync(file, 'utf8');
  const live = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  for (const re of forbid) {
    assert(!re.test(live), `${file} must stay inert (${re}) in executable lines:\n${live}`);
  }
  for (const pii of ['Jo Bloggs', 'jo@example.com']) {
    assert(!text.includes(pii), `${file}: sample personal data must be a placeholder, found ${JSON.stringify(pii)}`);
  }
  assert(text.includes('user@example.invalid'), `${file}: the sample email must be an RFC 2606 placeholder`);
}

// THE WHOLE RAW-DERIVED SURFACE (17o rev8): every raw-derived fact about the audited
// origin that a caller can inspect must be UNKNOWN (null) when the raw document could
// not be fetched (a 404, DNS failure, timeout or connection refused), so a consumer
// checking a field on an exchange failure cannot mistake a null/missing raw response
// for a valid page property.
//
// THE GUARANTEE, STATED AT ITS ACTUAL WIDTH: the walk covers top-level keys and the
// immediate members of the raw group. Allowlisted OBJECTS (rendered, screenshots) are NOT
// recursed into - recursing buys little (render facts exist regardless of the raw fetch)
// and a stated guarantee must match what is actually walked, since an over-broad guarantee
// is the same defect as a false value.
export function assertUnknownRawSurface(summary, routeLabel, assertFn = assert) {
  const meaningfulWithoutRaw = new Map([
    ['type', 'the primitive name - a fact about the run'],
    ['url', 'the audited URL - an input fact'],
    ['finalUrl', 'the REQUESTED URL when the exchange failed (it is assigned only once the exchange resolves), the final URL otherwise - a run fact, not a comparison'],
    ['fetchedStatus', 'the recorded status when one arrived (null when none did) - a run fact'],
    ['fetchError', 'the record of the failure - not a claim about the page'],
    ['crawlerUserAgent', 'the user agent used - a run fact'],
    ['rawComparisonUsable', 'the gate itself'],
    ['rawComparisonNote', 'the explanation of why the comparison is absent'],
    ['renderedEmpty', 'describes the RENDER, which exists regardless of the raw fetch'],
    ['rendered', 'rendered-page facts - the render exists regardless of the raw fetch'],
    ['screenshots', 'captured from the render, same reason'],
    ['console', 'what the page logged while rendering - browser-side runtime behavior, exists regardless of the raw fetch (the walk caught this key unclassified on the 404 route, which is the mechanism working)'],
    ['signalsFor', 'static metadata'],
    ['note', 'static documentation'],
  ]);
  const notUnknown = [];
  for (const [k, v] of Object.entries(summary)) {
    if (meaningfulWithoutRaw.has(k)) continue;
    if (k === 'raw') {
      if (v && typeof v === 'object' && Object.values(v).every((x) => x === null)) continue;
      notUnknown.push(`raw=${JSON.stringify(v)}`);
      continue;
    }
    if (v !== null) notUnknown.push(`${k}=${JSON.stringify(v)}`);
  }
  assertFn(
    notUnknown.length === 0,
    `discoverability (${routeLabel} route): with no raw document, EVERY raw-derived key must be unknown; these are not - null them or classify them with a reason: ${notUnknown.join(', ')}`,
  );
}

export function parseFilterArgs(argv) {
  const filters = [];
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list' || arg === '-l') {
      list = true;
    } else if (arg === '--only' || arg === '-o' || arg === '--filter' || arg === '-f' || arg === '--grep' || arg === '-g') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        filters.push(argv[++i]);
      } else {
        console.error(`missing argument for filter flag: ${arg}`);
        process.exit(1);
      }
    } else if (arg.startsWith('--only=')) {
      const val = arg.slice('--only='.length);
      if (!val) { console.error('missing value for --only='); process.exit(1); }
      filters.push(val);
    } else if (arg.startsWith('--filter=')) {
      const val = arg.slice('--filter='.length);
      if (!val) { console.error('missing value for --filter='); process.exit(1); }
      filters.push(val);
    } else if (arg.startsWith('--grep=')) {
      const val = arg.slice('--grep='.length);
      if (!val) { console.error('missing value for --grep='); process.exit(1); }
      filters.push(val);
    } else if (!arg.startsWith('-')) {
      filters.push(arg);
    }
  }
  return { filters, list };
}

export async function runSuite(tests, metaUrl) {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl)) {
    const { filters: testFilters, list: listTests } = parseFilterArgs(process.argv.slice(2));

    if (listTests) {
      for (const fn of tests) {
        console.log(fn.name);
      }
      process.exit(0);
    }

    const selectedTests = testFilters.length === 0
      ? tests
      : tests.filter((fn) =>
          testFilters.some((f) => fn.name.toLowerCase().includes(f.toLowerCase()))
        );

    if (selectedTests.length === 0) {
      console.error(`no tests matched filter: ${testFilters.join(', ')}`);
      process.exit(1);
    }

    for (const testFn of selectedTests) {
      await testFn();
    }
    if (selectedTests.length < tests.length) {
      console.log(`ran ${selectedTests.length}/${tests.length} tests matching [${testFilters.join(', ')}]: OK`);
    }
    console.log('tests OK');
  }
}
