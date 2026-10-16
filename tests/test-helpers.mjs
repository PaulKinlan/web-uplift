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
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
export { assert, test, after };
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, lstatSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const SKIP_DIRS = new Set(['.git', 'node_modules', 'reports', 'scratch']);

// Scratch paths the HARNESS creates inside the repository and skips by name (web-uplift-rn7w). They must
// live under schema/ - the installer has to walk them to hit the depth and symlink guards - so they cannot
// be moved to a tmpdir, and a walk of the repository then races them while another process builds or removes
// them. Skipping them by prefix makes the walk deterministic without weakening it: the guard test in
// tests/syntax-core.test.mjs asserts that no TRACKED path matches a prefix here, so a real file can never be
// hidden by this list. The deeper fix is that the fixtures are now unique per process, so two gates in one
// worktree cannot collide in the first place.
export const SKIP_DIR_PREFIXES = ['install-depth-fixture', 'install-symlink-cycle', 'install-symlink-escape'];

export const tmp = mkdtempSync(join(tmpdir(), 'web-uplift-regression-'));
process.on('exit', () => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// GIT_DIR and its siblings OVERRIDE cwd, so a git call that sets an explicit cwd can still operate on a
// DIFFERENT repository when the environment carries a GIT_* from a wrapper, a lane's shell, or a nested run: the
// paths look right while the answers come from somewhere else (web-uplift-tax6). Measured on this VM: the gate's
// children inherit GIT_EDITOR/GIT_PAGER/GIT_SEQUENCE_EDITOR/GIT_MERGE_AUTOEDIT/GIT_TERMINAL_PROMPT from the
// surrounding shell, so inherited GIT_* is the normal case here rather than a hypothetical, and GIT_DIR alone
// would be enough to redirect every spawn below. Every git spawn in this harness therefore passes an env with
// GIT_* REMOVED instead of inheriting process.env. A caller that genuinely needs a GIT_* sets it explicitly
// through `extra`, which is the only way one can appear in a child spawned by this file.
export function gitEnv(extra = {}, options = {}) {
  // The GIT_* removal happens LAST, on the merged result, and that ordering is the whole point: deleting from
  // process.env and then spreading a caller's env back over it (env: { ...process.env }) RESTORES the inherited
  // variable and silently defeats the scrub, which is a real pattern in this repository rather than a
  // hypothetical - tests/test-fast.mjs and tests/runner-agents.test.mjs both spread process.env into a spawn.
  // Sanitising the final object means no caller can reintroduce GIT_* by accident, whatever it passes.
  const env = { ...process.env, ...extra };
  // A caller that genuinely wants to carry a GIT_* must say so explicitly, because intent cannot be inferred
  // from a spread that happens to include process.env: that is exactly how the scrub was defeated before.
  if (options.allowGitDir !== true) {
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_')) delete env[key];
    }
  }
  return env;
}

export function run(command, args, opts = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...opts,
    env: gitEnv(opts.env),
  });
}

// Async variant: spawnSync would block this process's event loop, so an
// in-process test server could not answer the child's browser. Bounded so a
// hung browser fails the suite instead of hanging it.
export function runAsync(command, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: repoRoot, timeout: 120000, ...opts, env: gitEnv(opts.env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // The SIGNAL travels with the status (web-uplift-z3b8). A child killed by a signal reports status null,
    // which is also what a child that never started reports, so a caller that sees only the status cannot
    // tell 'killed' from 'no spawn at all'. The batch isolation case prints both fields when its stub agent
    // left no trace and it exists to tell those fates apart, but every one of them read as signal=undefined
    // (Node reports null rather than undefined for a child that exited on its own, so the distinction is
    // between a signal name and an absence of one).
    child.on('close', (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
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

// Walks `dir` and returns the paths the predicate accepts. This FOLLOWS symlinks and bounds recursion by
// DIRECTORY IDENTITY (web-uplift-k63b): a cycle is by definition a directory reached twice on the same
// path, so identity is what bounds it, and a legitimately symlinked directory is still traversed. It
// replaces a version that skipped symlinks outright (web-uplift-lql5), which removed the ELOOP crash but
// traded one silent coverage loss for another - a symlinked directory containing .mjs would have been
// dropped from the census without a word. A link whose target cannot be resolved at all - dangling, or one
// the kernel refuses - is skipped, because there is no target to walk.
//
// PRECONDITION, because following links has a consequence the skipping version did not: a link pointing
// OUTSIDE the walk root is followed out of it. The repository has one such link today,
// schema/install-symlink-escape.txt, and it is not .mjs so the syntax census is unaffected; a symlinked
// directory containing .mjs outside the repository would be pulled INTO the census, which is the price of
// preferring reachability to confinement and is stated rather than discovered later.
const directoryIdentity = (path) => {
  const st = statSync(path);
  return `${st.dev}:${st.ino}`;
};

// A directory being created or removed by another process cannot be walked exactly, so an entry that
// disappears between being listed and being stat'd is treated as ABSENT rather than as a failure
// (web-uplift-rn7w). This does not weaken the census: a declared module that is genuinely missing is a
// different outcome from an entry vanishing mid-walk, and the declared-membership assertion still fails
// loudly for it - what this removes is the spurious ENOENT a concurrently-built fixture produced.
const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

export function listFiles(dir, predicate, out = [], path = new Set([directoryIdentity(dir)])) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    if (SKIP_DIR_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const full = join(dir, name);
    const st = lstatOrNull(full);
    if (st === null) continue; // vanished between the readdir and the stat: another process is building a fixture
    if (st.isSymbolicLink()) {
      let target;
      try {
        target = statSync(full);
      } catch {
        continue;
      }
      const key = `${target.dev}:${target.ino}`;
      if (target.isDirectory()) {
        if (path.has(key)) continue;
        listFiles(full, predicate, out, new Set([...path, key]));
      } else if (predicate(full)) {
        out.push(full);
      }
    } else if (st.isDirectory()) {
      let identity;
      try {
        identity = directoryIdentity(full);
      } catch {
        continue; // the directory vanished as we descended into it
      }
      listFiles(full, predicate, out, new Set([...path, identity]));
    } else if (predicate(full)) {
      out.push(full);
    }
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
// The lines of a probe that can actually RUN. A neutralised sample keeps its request
// COMMENTED OUT, so every inertness check has to read executable lines only - and it
// has to be the same definition everywhere, or a per-file check and a directory sweep
// can disagree about what inert means (web-uplift-auxp).
export function executableLines(text) {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

export function assertProbeFileInert(file, { forbid }) {
  const text = readFileSync(file, 'utf8');
  const live = executableLines(text);
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

// Re-exported for the suites that already import it from here (web-uplift-dipf): the parser now lives in
// its own module so a flag change no longer touches the shared helper every suite names.
export { parseFilterArgs } from './filter-args.mjs';

import { parseFilterArgs } from './filter-args.mjs';

export async function runSuite(tests, metaUrl, options = {}) {
  const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl);
  if (!isDirect) return;

  const { filters: testFilters, list: listTests } = parseFilterArgs(process.argv.slice(2));

  if (listTests) {
    for (const fn of tests) {
      console.log(fn.name);
    }
    // NOT process.exit(0). process.exit() terminates without flushing ASYNCHRONOUS stdout, which is what a pipe
    // is, so when this list is long the tail of it was written into the buffer and never drained: the reader got
    // a shorter list from a run that exited 0 with nothing on stderr. That is how the registry's aggregate lost
    // its last two suites' cases about 8% of the time (web-uplift-ecif), which is the same shape as the merger's
    // 178-of-194 in web-uplift-k81u - an enumeration reading fewer names than the tree has, intermittently and
    // independent of the tree. Setting the exit code and returning lets the stream drain; the process still ends
    // with the same status once it is idle.
    process.exitCode = 0;
    return;
  }

  const selectedTests = testFilters.length === 0
    ? tests
    : tests.filter((fn) =>
        testFilters.some((f) => fn.name.toLowerCase().includes(f.toLowerCase()))
      );

  if (selectedTests.length === 0) {
    console.error(`no tests matched filter: ${testFilters.join(', ')}`);
    // Same reason as the list path above: this is a write followed by an exit, so on a pipe the message could be
    // lost even though the status is right. The code carries the failure; the return lets the write drain.
    process.exitCode = 1;
    return;
  }

  let failed = false;
  const timeoutMs = options.timeoutMs || 120000;
  const concurrency = options.concurrency !== undefined ? options.concurrency : 1;

  for (const fn of selectedTests) {
    test(fn.name, { timeout: timeoutMs, concurrency }, async (t) => {
      let completed = false;
      t.signal?.addEventListener('abort', () => {
        if (!completed) failed = true;
      });
      try {
        await fn(t);
        completed = true;
      } catch (err) {
        failed = true;
        throw err;
      }
    });
  }

  after(() => {
    if (!failed && process.exitCode !== 1) {
      if (selectedTests.length < tests.length) {
        console.log(`ran ${selectedTests.length}/${tests.length} tests matching [${testFilters.join(', ')}]: OK`);
      }
      console.log('tests OK');
    }
  });
}
