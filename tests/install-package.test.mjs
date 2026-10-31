#!/usr/bin/env node
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assert,
  run,
  runAsync,
  repoRoot,
  tmp,
  runSuite,
  readJson,
  validateJson,
  listFiles,
  assertProbeFileInert,
  assertUnknownRawSurface,
  cleanStaleNpxRegressionTrees,
  packTarball,
  noUpdateEnv,
  SKIP_DIRS, gitEnv } from './test-helpers.mjs';
import {
  testInstallSkipsSymlinksInVendoredSource,
  testInstallFixturesTolerateLeftoversFromAKilledRun,
  testInstallCopyDepthGuard,
  testInstallVendorsCompleteClosure,
  testInstallRefusesDestinationSymlinks,
  testInstallNormalDestinationWrites,
  testGenerateVendoredSurfaceRefusesDestinationSymlinks,
  testSyncRefusesCommittedSymlinkDestination,
  testSyncRefusesEqualByteSymlinkDestination,
  testInstallAsksTheSharedSymlinkGuard,
  testInstallIncompleteExitControl,
  testV167ControlShimNeverWritesIntoTheRepository,
  testEveryDestinationRefusalCarriesTheMarker,
  testGenerateVendoredSurfaceKeepsListedPathsReadable,
  testRepublishReaderInstrumentDetectsDeleteThenCopy,
  testPublishOrderLeavesObsoleteEntriesUntilAfterPublish,
  testRepublishKeepsListedPathsReadableForAConcurrentReader,
  testCrashLeftStagedTreeIsSweptByTheNextRun,
  testSweepLeavesALiveRunsStagedTreeAlone,
  testSweepRemovesAMalformedStageNameOnlyWhenItIsOld,
} from './install-copy-symlink.mjs';

// The in-tree vendored copies under .web-uplift/ must stay 100% byte-identical
// to their canonical sources (web-uplift-6ha1). Run tests/cdp-copy-sync.mjs as a
// gate assertion so one-sided edits cannot ship on master.
export function testCdpCopySyncGuard() {
  const guard = spawnSync(process.execPath, [join(repoRoot, 'tests', 'cdp-copy-sync.mjs')], { encoding: 'utf8' });
  assert(guard.status === 0, `cdp-copy-sync guard must pass:\n${guard.stderr || guard.stdout}`);
}


export function testCdpCopySyncMutationGuard() {
  const tmpFixture = mkdtempSync(join(tmp, 'cdp-sync-fixture-'));
  const srcDir = join(tmpFixture, 'schema');
  const dstDir = join(tmpFixture, '.web-uplift', 'schema');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(dstDir, { recursive: true });
  writeFileSync(join(srcDir, 'foo.json'), '{"version": 1}\n');
  writeFileSync(join(dstDir, 'foo.json'), '{"version": 2}\n');
  writeFileSync(join(srcDir, 'new-file.json'), '{"new": true}\n');

  // Verify that drift fails the guard (both modified content and missing vendored copy)
  const failRun = spawnSync(process.execPath, [
    join(repoRoot, 'tests', 'cdp-copy-sync.mjs'),
    '--repo', tmpFixture,
  ], { encoding: 'utf8' });
  assert(failRun.status !== 0, `cdp-copy-sync must fail on drifted fixture:\n${failRun.stdout}\n${failRun.stderr}`);
  assert(failRun.stderr.includes('vendored copy has drifted'), `error output must explain drift: ${failRun.stderr}`);
  assert(failRun.stderr.includes('vendored copy is missing'), `error output must report missing copy: ${failRun.stderr}`);

  // Verify that --dry-run reports drift, exits non-zero (1), and does not write changes
  const dryRun = spawnSync(process.execPath, [
    join(repoRoot, 'tests', 'cdp-copy-sync.mjs'),
    '--repo', tmpFixture,
    '--dry-run',
  ], { encoding: 'utf8' });
  assert(dryRun.status === 1, `cdp-copy-sync --dry-run must exit 1 on drifted fixture:\n${dryRun.stdout}\n${dryRun.stderr}`);
  assert(dryRun.stderr.includes('drifted copies would be synced'), `error output must indicate drifted copies: ${dryRun.stderr}`);
  assert(
    dryRun.stdout.includes('dry-run: would sync schema/foo.json -> .web-uplift/schema/foo.json'),
    `stdout must report each drifted pair: ${dryRun.stdout}`
  );
  assert(
    readFileSync(join(dstDir, 'foo.json'), 'utf8') === '{"version": 2}\n',
    '--dry-run must not modify drifted files'
  );
  assert(
    !existsSync(join(dstDir, 'new-file.json')),
    '--dry-run must not create missing files'
  );

  // Verify that --sync restores byte identity and creates missing copies
  const syncRun = spawnSync(process.execPath, [
    join(repoRoot, 'tests', 'cdp-copy-sync.mjs'),
    '--repo', tmpFixture,
    '--sync',
  ], { encoding: 'utf8' });
  assert(syncRun.status === 0, `cdp-copy-sync --sync must succeed:\n${syncRun.stdout}\n${syncRun.stderr}`);
  assert(
    readFileSync(join(srcDir, 'foo.json'), 'utf8') === readFileSync(join(dstDir, 'foo.json'), 'utf8'),
    'source and vendored copies must match after --sync'
  );
  assert(
    readFileSync(join(srcDir, 'new-file.json'), 'utf8') === readFileSync(join(dstDir, 'new-file.json'), 'utf8'),
    'missing vendored copy must be created after --sync'
  );
}


// web-uplift-03lo. `.web-uplift/` is a GENERATED mirror, and it keeps entries whose source has gone: switch
// a worktree from a branch that has a file to one that does not and the mirror still holds the vendored copy.
// `--sync` used to FAIL on that ("cannot sync ...: source is missing"), which killed the fast gate before it
// ran a single test and read like a test failure ("coverage UNKNOWN: the gate log names no executed suite").
// A stale entry should be DROPPED, because it can be compared to nothing and is executed by nothing.
//
// The three cases that must NOT be conflated with that one are asserted here too, since the cheap version of
// this fix is ";just delete whatever does not have a source":
//   - a check-only run still fails and still writes nothing,
//   - an UNREADABLE source is a broken tree, not a leftover name, and stays a loud failure,
//   - the tracked destinations (.pi/skills/...) are never deleted: they are repo files, not mirror entries.
export function testCdpCopySyncDropsStaleVendoredEntries() {
  const fixture = mkdtempSync(join(tmp, 'cdp-sync-stale-'));
  const srcDir = join(fixture, 'schema');
  const dstDir = join(fixture, '.web-uplift', 'schema');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(dstDir, { recursive: true });
  writeFileSync(join(srcDir, 'kept.json'), '{"version": 1}\n');
  writeFileSync(join(dstDir, 'kept.json'), '{"version": 1}\n');
  // The stale entry: a vendored copy whose source is not on this branch at all.
  writeFileSync(join(dstDir, 'orphan.json'), '{"stale": true}\n');
  const sync = (...args) => spawnSync(process.execPath, [join(repoRoot, 'tests', 'cdp-copy-sync.mjs'), '--repo', fixture, ...args], { encoding: 'utf8' });

  // Check-only: an inconsistent mirror is still drift, and a check never writes.
  const check = sync();
  assert(check.status !== 0, `a stale entry must still fail a check-only run:\n${check.stdout}\n${check.stderr}`);
  assert(existsSync(join(dstDir, 'orphan.json')), 'a check-only run must not delete anything');

  // Dry-run names the removal and writes nothing.
  const dry = sync('--dry-run');
  assert(dry.status === 1, `--dry-run must still exit 1 while the mirror is inconsistent:\n${dry.stdout}\n${dry.stderr}`);
  assert(
    dry.stdout.includes('dry-run: would remove .web-uplift/schema/orphan.json'),
    `--dry-run must report the removal it would make:\n${dry.stdout}`,
  );
  assert(existsSync(join(dstDir, 'orphan.json')), '--dry-run must not remove anything');

  // --sync repairs the mirror, says what it dropped, and exits 0.
  const syncRun = sync('--sync');
  assert(syncRun.status === 0, `--sync must repair a stale mirror rather than fail:\n${syncRun.stdout}\n${syncRun.stderr}`);
  assert(!existsSync(join(dstDir, 'orphan.json')), 'the stale vendored entry must be removed by --sync');
  assert(
    syncRun.stdout.includes('removed stale vendored copy: .web-uplift/schema/orphan.json'),
    `--sync must say what it removed, on one line:\n${syncRun.stdout}`,
  );
  assert(!/FAILED to sync/.test(syncRun.stderr), `a repair is not a failure:\n${syncRun.stderr}`);
  const after = sync();
  assert(after.status === 0, `after the repair the guard must pass:\n${after.stdout}\n${after.stderr}`);

  // CONTROL 1: an unreadable SOURCE is still a loud failure. Skipped as root, where chmod 0o000 does not
  // stop a read and the fixture would assert nothing.
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const locked = join(srcDir, 'locked.json');
    writeFileSync(locked, '{"version": 3}\n');
    writeFileSync(join(dstDir, 'locked.json'), '{"version": 4}\n');
    chmodSync(locked, 0o000);
    const unreadable = sync('--sync');
    chmodSync(locked, 0o644);
    assert(unreadable.status !== 0, `an unreadable source must still fail:\n${unreadable.stdout}\n${unreadable.stderr}`);
    assert(/source is unreadable/.test(unreadable.stderr), `the failure must name the unreadable source:\n${unreadable.stderr}`);
    assert(existsSync(join(dstDir, 'locked.json')), 'an unreadable source must not get its vendored copy deleted');
  }

  // CONTROL 2: a TRACKED destination is never deleted, even with no source. `.pi/skills/web-audit/SKILL.md`
  // is a tracked repo file; removing it is not this script's job.
  const trackedRel = join('.pi', 'skills', 'web-audit', 'SKILL.md');
  mkdirSync(dirname(join(fixture, trackedRel)), { recursive: true });
  writeFileSync(join(fixture, trackedRel), '# skill\nvendored copy with no source\n');
  const trackedRun = sync('--sync');
  assert(
    existsSync(join(fixture, trackedRel)),
    `a tracked destination must never be deleted by --sync:\n${trackedRun.stdout}\n${trackedRun.stderr}`,
  );
  assert(trackedRun.status !== 0, `a tracked destination with no source stays the failure it was:\n${trackedRun.stdout}\n${trackedRun.stderr}`);
}


// The installed tree is built ON DEMAND rather than by a case that must run first (web-uplift-3yns). Two
// cases need it, and before this change the second one asserted that the first had already run - "this
// check reuses the target installed by testInstalledEvidenceCli, which must run first" - which held only
// because cases inside a file run serially in list order. That made the case unrunnable on its own and
// blocked making cases concurrent inside a file. Building it here means either case can run first, or
// alone, and the pack and install are still paid exactly once per process.
let installedTargetDir = null;
function installedTarget() {
  if (installedTargetDir !== null) return installedTargetDir;
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
  installedTargetDir = target;
  return target;
}

export function testInstalledEvidenceCli() {
  const target = installedTarget();

  const manifest = JSON.parse(readFileSync(join(target, '.web-uplift/manifest.json'), 'utf8'));
  const pkg = readJson('package.json');
  assert(manifest.package === pkg.name, `installed manifest package mismatch: ${JSON.stringify(manifest)}`);
  assert(manifest.version === pkg.version, `installed manifest version mismatch: ${JSON.stringify(manifest)}`);
  assert(manifest.agents.includes('codex'), `installed manifest missed selected agent: ${JSON.stringify(manifest)}`);

  // The install vendors a dependency tree into the consumer's project, and those
  // packages are in no consumer lockfile, so the manifest is the only place that
  // says which versions are on disk. The record has to be TRUE, not just present:
  // every version it names must match what was actually copied (web-uplift-92b).
  const vendored = manifest.vendoredDependencies;
  assert(
    Array.isArray(vendored) && vendored.length > 0,
    `installed manifest must record the vendored dependency versions: ${JSON.stringify(manifest)}`,
  );
  const names = vendored.map((entry) => entry.name);
  assert(
    names.includes('chrome-remote-interface') && names.includes('web-features'),
    `both vendored roots must be recorded: ${JSON.stringify(names)}`,
  );
  assert(
    [...names].sort().join(',') === names.join(','),
    `the vendored record must be sorted by name so the manifest is stable: ${JSON.stringify(names)}`,
  );
  assert(new Set(names).size === names.length, `the vendored record must not repeat a package: ${JSON.stringify(names)}`);
  for (const entry of vendored) {
    const manifestPath = join(target, '.web-uplift', 'node_modules', ...entry.name.split('/'), 'package.json');
    const copied = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert(
      copied.version === entry.version,
      `recorded version for ${entry.name} must match the installed tree: manifest says ${entry.version}, on disk ${copied.version}`,
    );
  }

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


export function testNpxCacheDoesNotAccumulate() {
  const npxDir = join(homedir(), '.npm', '_npx');
  if (!existsSync(npxDir)) return;

  const tarball = packTarball();
  // Ensure the content-addressed npx cache directory is populated
  const first = run('npm', [
    'exec',
    '--yes',
    '--package',
    tarball,
    '--',
    'web-uplift',
    '--help',
  ], { env: noUpdateEnv() });
  assert(first.status === 0, `initial stable exec failed: ${first.stderr || first.stdout}`);

  function findWorktreeEntries(dirs) {
    return dirs.filter((d) => {
      try {
        const p = JSON.parse(readFileSync(join(npxDir, d, 'package.json'), 'utf8'));
        const pkgs = p._npx?.packages || [];
        const dep = p.dependencies?.['web-uplift'] || '';
        return (
          pkgs.some((pkg) => typeof pkg === 'string' && pkg.includes(tarball)) ||
          dep.includes(tarball)
        );
      } catch {
        return false;
      }
    });
  }

  const dirsBefore = readdirSync(npxDir);
  const matched = findWorktreeEntries(dirsBefore);
  assert(matched.length === 1, `expected exactly one matching npx cache entry for ${tarball}, found ${matched.length}`);

  // Re-pack and execute a second time with the same unchanged source
  const tarball2 = packTarball();
  assert(tarball2 === tarball, `content-addressed tarball path must be stable when source is unchanged: ${tarball2} !== ${tarball}`);
  const second = run('npm', [
    'exec',
    '--yes',
    '--package',
    tarball2,
    '--',
    'web-uplift',
    '--help',
  ], { env: noUpdateEnv() });
  assert(second.status === 0, `repeated stable exec failed: ${second.stderr || second.stdout}`);

  const dirsAfter = readdirSync(npxDir);
  const matchedAfter = findWorktreeEntries(dirsAfter);
  assert(
    matchedAfter.length === 1 && matchedAfter[0] === matched[0],
    `repeated pack/exec must reuse the existing cache entry without adding a new tree for ${tarball}: before=${JSON.stringify(matched)}, after=${JSON.stringify(matchedAfter)}`,
  );
}


// The installed vendored tree is where a packaging defect shows up and the source tree
// cannot. A module that imports across the vended directories has to resolve inside the
// installed copy, because that is the shape that broke a shipped copy once already - the
// CLI imported a module the package did not carry. The scorecard load asserted above
// already exercises one such import transitively; this asserts the general class and says
// which modules it exercised. It shares the target installed by testInstalledEvidenceCli
// rather than paying for a second pack+install, and now builds it on demand if it is not
// there (web-uplift-uz9, web-uplift-3yns).
export function testInstalledTreeRelativeImportsResolve() {
  // Builds the tree itself if the other case has not already done so, so it is order-free and can be run
  // alone (web-uplift-3yns).
  const target = installedTarget();
  const vendoredRoot = join(target, '.web-uplift');
  const vendoredModules = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? vendoredModules(join(dir, entry.name))
        : entry.name.endsWith('.mjs')
          ? [join(dir, entry.name)]
          : [],
    );
  const dangling = [];
  const crossDirectory = [];
  for (const file of vendoredModules(vendoredRoot)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!existsSync(resolve(dirname(file), specifier))) dangling.push(`${relative(vendoredRoot, file)} -> ${specifier}`);
      if (specifier.startsWith('../')) crossDirectory.push({ file, specifier });
    }
  }
  assert(
    dangling.length === 0,
    `installed tree: every relative import must resolve inside the vendored tree, dangling: ${JSON.stringify(dangling)}`,
  );
  assert(
    crossDirectory.length > 0,
    'installed tree: expected at least one import crossing the vendored directories, otherwise this check exercises nothing',
  );
  for (const { file, specifier } of crossDirectory.slice(0, 5)) {
    const loaded = run(process.execPath, [
      '-e',
      `import(${JSON.stringify(pathToFileURL(file).href)}).catch((e) => { console.error('LOADFAIL ' + e.code); process.exit(3); })`,
    ]);
    // Not `status === 0`: several of these modules are entry points whose own main logic
    // prints usage and exits non-zero when there is nothing to do, which says nothing
    // about packaging. The discriminator is a MODULE-RESOLUTION failure, the same one the
    // scorecard assertion above uses.
    assert(
      !String(loaded.stderr).includes('ERR_MODULE_NOT_FOUND') &&
        !String(loaded.stderr).includes('LOADFAIL') &&
        !String(loaded.stderr).includes('Cannot find package'),
      `installed tree: ${relative(vendoredRoot, file)} imports ${specifier} across directories and must load, got: ${loaded.stderr || loaded.stdout}`,
    );
  }
}


export function testUpdateDryRunReadsInstallManifest() {
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


export function testCachedUpdateWarning() {
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
      // The check is opt-in (web-uplift-wgy): the cached warning only prints
      // when the operator explicitly enabled it.
      WEB_UPLIFT_UPDATE_CHECK: '1',
    },
  });
  assert(result.status === 0, `cached update warning command failed: ${result.stderr || result.stdout}`);
  assert(result.stderr.includes('web-uplift 999.0.0 is available'), `cached update warning was not printed:\n${result.stderr}`);
  assert(result.stderr.includes('npx -y web-uplift@latest update --agent all'), `cached update warning missed update command:\n${result.stderr}`);
}


// web-uplift-wgy: the update check makes network egress to the npm registry, so
// it is OPT-IN (WEB_UPLIFT_UPDATE_CHECK) - by default NO fetch may happen at
// all, proven with a preload shim that turns any fetch into a loud exit.
// Opt-outs (CI / WEB_UPLIFT_NO_UPDATE_CHECK) still win over the opt-in, and a
// registry version string that is not a strict version shape is dropped
// (the response is unauthenticated input).
export function testUpdateCheckIsOptInAndUntrusted() {
  const shim = join(tmp, 'poison-fetch.cjs');
  writeFileSync(
    shim,
    'globalThis.fetch = (...a) => { console.error(\'FETCH-CALLED\', String(a[0])); process.exit(42); };\n',
  );
  const baseEnv = {
    ...process.env,
    XDG_CACHE_HOME: join(tmp, 'update-cache-optin'),
    CI: '',
    WEB_UPLIFT_NO_UPDATE_CHECK: '',
    NODE_OPTIONS: `--require ${shim}`,
  };
  const dryRun = (env) => run(process.execPath, [
    'bin/web-uplift.mjs',
    'install',
    '--agent',
    'codex',
    '--target',
    join(tmp, 'update-optin-target'),
    '--dry-run',
  ], { env });

  // Default: no opt-in env var, so no fetch may happen (the shim would exit 42).
  const off = dryRun(baseEnv);
  assert(off.status === 0, `default update check must not fetch (shim would exit 42): ${off.status}\n${off.stderr}`);
  assert(!off.stderr.includes('FETCH-CALLED'), `default update check fetched: ${off.stderr}`);

  // Opt-in present: the shim proves a fetch IS attempted (exit 42 with the marker).
  const on = dryRun({ ...baseEnv, WEB_UPLIFT_UPDATE_CHECK: '1' });
  assert(on.status === 42 && on.stderr.includes('FETCH-CALLED'), `opt-in update check must fetch: ${on.status}\n${on.stderr}`);

  // Opt-out still wins over the opt-in.
  const vetoed = dryRun({ ...baseEnv, WEB_UPLIFT_UPDATE_CHECK: '1', WEB_UPLIFT_NO_UPDATE_CHECK: '1' });
  assert(vetoed.status === 0 && !vetoed.stderr.includes('FETCH-CALLED'), `opt-out must veto the opt-in: ${vetoed.status}\n${vetoed.stderr}`);

  // A registry version string that is not a strict shape must never be printed
  // (seeded cache with a malicious payload; the advisory shape-checks it).
  const badCache = join(tmp, 'update-cache-bad');
  mkdirSync(join(badCache, 'web-uplift'), { recursive: true });
  writeFileSync(join(badCache, 'web-uplift/update-check.json'), JSON.stringify({
    latest: '999.0.0\u001b[2J\u001b[H malicious',
    checkedAt: Date.now(),
  }, null, 2) + '\n');
  const bad = dryRun({ ...baseEnv, XDG_CACHE_HOME: badCache, WEB_UPLIFT_UPDATE_CHECK: '1' });
  assert(bad.status === 0, `malformed cached version must not break the run: ${bad.stderr}`);
  assert(!bad.stderr.includes('malicious'), `malformed registry version string must never reach the terminal:\n${bad.stderr}`);
}


// The installer vendors a set of files, and tests/cdp-copy-sync.mjs byte-compares
// each tracked copy against its source. Both lists now come from
// install-surface.mjs, and this drives a REAL install and compares what actually
// appeared against what is declared - so a copy step nobody declared, or a
// declaration the install no longer produces, fails here instead of quietly
// escaping the byte-identity guard. The comparison runs one way against the
// install's own output, not against the guard, so it cannot be circular
// (web-uplift-7mr).
export async function testInstallSurfaceMatchesWhatInstallVendors() {
  const { VENDORED_DIRS, VENDORED_FILES, TRACKED_COPY_FILES } = await import('../install-surface.mjs');
  const target = join(tmp, 'surface-target');
  const install = spawnSync(process.execPath, [join(repoRoot, 'bin/web-uplift.mjs'), 'install', '--agent', 'codex', '--target', target], { encoding: 'utf8' });
  assert(install.status === 0, `surface: install failed: ${install.stderr || install.stdout}`);

  const declared = [...VENDORED_DIRS.map((dir) => dir.dest), ...VENDORED_FILES.map((file) => file.dest)];
  const walk = (dir, base = '') =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walk(join(dir, entry.name), rel) : [rel];
    });
  const actual = walk(join(target, '.web-uplift')).filter(
    (rel) => rel !== 'manifest.json' && !rel.startsWith('node_modules/'),
  );
  assert(actual.length > 0, 'surface: the fixture install produced no vendored files');

  const declaredCovers = (rel) => declared.some((dest) => rel === dest || rel.startsWith(`${dest}/`));
  const undeclared = actual.filter((rel) => !declaredCovers(rel));
  assert(
    undeclared.length === 0,
    `surface: install vendored ${JSON.stringify(undeclared)} without declaring it, so the byte-identity guard does not cover it`,
  );
  const notVendored = declared.filter((dest) => !actual.some((rel) => rel === dest || rel.startsWith(`${dest}/`)));
  assert(
    notVendored.length === 0,
    `surface: ${JSON.stringify(notVendored)} is declared but the install did not produce it`,
  );

  // Tracked copies outside .web-uplift/ are compared by the guard too, so a
  // declaration pointing at nothing has to fail just as loudly.
  for (const copy of TRACKED_COPY_FILES) {
    assert(existsSync(join(repoRoot, copy.dest)), `surface: tracked copy ${copy.dest} is declared but missing from the tree`);
  }
}


// The MCP skills server (mcp/skills-server.mjs) is a production entry point
// registered into agent CLIs via .mcp.json and friends, and it had NO test
// (web-uplift-2ca): an SDK bump or edit could break the handshake silently.
// This drives the REAL server over stdio with the JSON-RPC handshake an MCP
// host performs: initialize -> serverInfo, prompts/list -> web-audit,
// resources/list -> skill://web-audit/SKILL.md, and a clean stderr.
export async function testMcpSkillsServerStdio() {
  const child = spawn(process.execPath, [join(repoRoot, 'mcp', 'skills-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolveReq, rejectReq) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rejectReq(new Error(`MCP ${method}: no response within 10s`));
        }
      }, 10000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveReq(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'web-uplift-regression', version: '0' },
    });
    assert(init.result?.serverInfo?.name === 'web-uplift', `initialize must name the server: ${JSON.stringify(init)}`);
    assert(init.result?.serverInfo?.version === '0.1.0', `initialize must carry the server version: ${JSON.stringify(init)}`);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const prompts = await request('prompts/list', {});
    assert(
      prompts.result?.prompts?.some((p) => p.name === 'web-audit'),
      `prompts/list must carry the web-audit prompt: ${JSON.stringify(prompts)}`,
    );
    const resources = await request('resources/list', {});
    assert(
      resources.result?.resources?.some((r) => r.uri === 'skill://web-audit/SKILL.md'),
      `resources/list must carry the skill resource: ${JSON.stringify(resources)}`,
    );
    // Listing alone would pass even if the SKILL.md went missing; READ it.
    const read = await request('resources/read', { uri: 'skill://web-audit/SKILL.md' });
    const skillContent = read.result?.contents?.[0]?.text;
    assert(
      typeof skillContent === 'string' && skillContent.length > 1000 && skillContent.includes('web-uplift'),
      `resources/read must return the actual SKILL.md text, got: ${JSON.stringify(read ?? null).slice(0, 200)}`,
    );
    const got = await request('prompts/get', { name: 'web-audit', arguments: { url: 'https://example.com' } });
    const promptText = got.result?.messages?.[0]?.content?.text;
    assert(
      typeof promptText === 'string' && promptText.includes('https://example.com'),
      `prompts/get must render the skill with the url argument: ${JSON.stringify(got ?? null).slice(0, 200)}`,
    );
    assert(stderr.trim() === '', `the server must keep stderr clean through the handshake: ${stderr.slice(-300)}`);
  } finally {
    child.kill('SIGKILL');
  }
}








// web-uplift-s5bj: a symlink in a vendored source directory is not a vendored copy - install skips it, and the
// byte-identity guard has nothing to compare - so the walk must not FOLLOW it. It did, and a directory symlink
// pointing at its own parent recursed until the kernel said 'ELOOP: too many symbolic links', which is how a
// killed test run's leftover fixture turned the NEXT run's guard red with an error naming no fixture at all.
export function testCdpCopySyncIgnoresSymlinkCyclesInTheVendoredTree() {
  const fixture = mkdtempSync(join(tmp, 'cdp-sync-symlink-'));
  const srcDir = join(fixture, 'schema');
  const dstDir = join(fixture, '.web-uplift', 'schema');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(dstDir, { recursive: true });
  writeFileSync(join(srcDir, 'kept.json'), '{"version": 1}\n');
  writeFileSync(join(dstDir, 'kept.json'), '{"version": 1}\n');
  // A cycle, exactly like the fixture a killed install-copy-symlink run leaves behind, plus an escaping file
  // symlink, both inside a VENDORED_DIR.
  const cycleDir = join(srcDir, 'install-symlink-cycle.999999.dead');
  mkdirSync(cycleDir);
  symlinkSync(cycleDir, join(cycleDir, 'loop'));
  const escape = join(srcDir, 'install-symlink-escape.999999.dead.txt');
  symlinkSync(join(tmp, 'does-not-exist'), escape);
  try {
    const run = spawnSync(process.execPath, [join(repoRoot, 'tests', 'cdp-copy-sync.mjs'), '--repo', fixture], { encoding: 'utf8', timeout: 120000 });
    assert(run.status === 0, `a symlink cycle in a vendored source dir must not fail the guard:\n${run.stdout}\n${run.stderr}`);
    assert(!/ELOOP/.test(run.stderr), `the walk must not follow a symlink cycle:\n${run.stderr}`);
    assert(/all \d+ vendored copies identical/.test(run.stdout), `the guard still compares the real files:\n${run.stdout}`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

export const installPackageTests = [
  testCrashLeftStagedTreeIsSweptByTheNextRun,
  testSweepLeavesALiveRunsStagedTreeAlone,
  testSweepRemovesAMalformedStageNameOnlyWhenItIsOld,
  testCdpCopySyncGuard,
  testCdpCopySyncMutationGuard,
  testCdpCopySyncDropsStaleVendoredEntries,
  testCdpCopySyncIgnoresSymlinkCyclesInTheVendoredTree,
  testInstalledEvidenceCli,
  testNpxCacheDoesNotAccumulate,
  testInstalledTreeRelativeImportsResolve,
  testUpdateDryRunReadsInstallManifest,
  testCachedUpdateWarning,
  testUpdateCheckIsOptInAndUntrusted,
  testInstallSurfaceMatchesWhatInstallVendors,
  testInstallSkipsSymlinksInVendoredSource,
  testInstallFixturesTolerateLeftoversFromAKilledRun,
  testInstallCopyDepthGuard,
  testInstallVendorsCompleteClosure,
  testInstallRefusesDestinationSymlinks,
  testInstallNormalDestinationWrites,
  testGenerateVendoredSurfaceRefusesDestinationSymlinks,
  testSyncRefusesCommittedSymlinkDestination,
  testSyncRefusesEqualByteSymlinkDestination,
  testInstallAsksTheSharedSymlinkGuard,
  testInstallIncompleteExitControl,
  testV167ControlShimNeverWritesIntoTheRepository,
  testEveryDestinationRefusalCarriesTheMarker,
  testMcpSkillsServerStdio,
  // DECLARED LATER IN THIS FILE and registered here too (web-uplift-o4ec). These two used to live
  // only in tests/regression.mjs's ALL_TESTS, so `node --test tests/*.test.mjs` - the alternative
  // gate AGENTS.md documents - ran 142 of 147 cases and was green while omitting both. Both are
  // integrity guards, and a suite that cannot run as a suite is not a suite.
  testCdpCopySyncRefusesToOverwriteTrackedEdits,
  testGenerateVendoredSurfaceLeavesTrackedEditsAlone,
  testGenerateVendoredSurfaceKeepsListedPathsReadable,
  testRepublishReaderInstrumentDetectsDeleteThenCopy,
  testPublishOrderLeavesObsoleteEntriesUntilAfterPublish,
  testRepublishKeepsListedPathsReadableForAConcurrentReader,
];

export {
  testInstallSkipsSymlinksInVendoredSource,
  testInstallFixturesTolerateLeftoversFromAKilledRun,
  testInstallCopyDepthGuard,
  testInstallVendorsCompleteClosure,
  testInstallRefusesDestinationSymlinks,
  testInstallNormalDestinationWrites,
  testGenerateVendoredSurfaceRefusesDestinationSymlinks,
  testSyncRefusesCommittedSymlinkDestination,
  testSyncRefusesEqualByteSymlinkDestination,
  testInstallAsksTheSharedSymlinkGuard,
  testInstallIncompleteExitControl,
  testV167ControlShimNeverWritesIntoTheRepository,
  testEveryDestinationRefusalCarriesTheMarker,
};

await runSuite(installPackageTests, import.meta.url, { timeoutMs: 60000, concurrency: 1 });

// web-uplift-0zcd. cdp-copy-sync --sync rewrites TRACKED_COPY_FILES as well as the gitignored
// .web-uplift/ tree, and the gates now run that sync before testing. If a tracked destination
// carries its own uncommitted edits, syncing overwrites the only copy of that work while the gate
// reports green. The sync must refuse instead, and the legitimate case - the SOURCE moved, so the
// destination is stale - must still sync, or the guard would break the DX fix it was added for.
//
// Built in a throwaway git repository: the behaviour depends on git status, and a test that
// reproduced it against this checkout would have to dirty a real tracked file to do so.
export function testCdpCopySyncRefusesToOverwriteTrackedEdits() {
  const fixture = mkdtempSync(join(tmp, 'cdp-sync-tracked-'));
  const srcRel = '.claude/skills/web-audit/SKILL.md';
  const dstRel = '.pi/skills/web-audit/SKILL.md';
  mkdirSync(dirname(join(fixture, srcRel)), { recursive: true });
  mkdirSync(dirname(join(fixture, dstRel)), { recursive: true });
  writeFileSync(join(fixture, srcRel), '# skill\noriginal content\n');
  writeFileSync(join(fixture, dstRel), '# skill\noriginal content\n');

  const git = (...args) => spawnSync('git', args, { cwd: fixture, encoding: 'utf8', env: gitEnv() });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '-q', '-m', 'fixture');

  const guard = (...args) => spawnSync(process.execPath, [join(repoRoot, 'tests', 'cdp-copy-sync.mjs'), '--repo', fixture, ...args], { encoding: 'utf8' });

  // (a) a tracked destination with its own uncommitted edit must be refused, and must survive
  appendFileSync(join(fixture, dstRel), 'LOCAL WORK THAT MUST SURVIVE\n');
  const refused = guard('--sync');
  assert(refused.status !== 0, `sync must fail rather than overwrite a tracked file with local edits:\n${refused.stdout}\n${refused.stderr}`);
  assert(refused.stderr.includes('REFUSING to sync'), `refusal must name the reason: ${refused.stderr}`);
  assert(refused.stderr.includes(dstRel), `refusal must name the path it refused: ${refused.stderr}`);
  assert(
    readFileSync(join(fixture, dstRel), 'utf8').includes('LOCAL WORK THAT MUST SURVIVE'),
    'the local edit must still be there after the refusal - that is the whole point',
  );

  // (b) the CONTROL, which is the reason the refusal keys on local edits rather than on drift:
  // a destination that is clean but stale because the SOURCE moved is exactly what sync is for.
  git('checkout', '--', dstRel);
  appendFileSync(join(fixture, srcRel), 'SOURCE MOVED\n');
  const synced = guard('--sync');
  // Assert on the refusal and the content, not on the exit code: this fixture holds only the two
  // files this behaviour needs, while the pair list is the repository's whole list, so unrelated
  // pairs report "source is missing" and make the code non-zero for reasons this test is not about.
  assert(
    !synced.stderr.includes('REFUSING'),
    `a destination that is merely stale must not be refused:\n${synced.stderr}`,
  );
  assert(
    readFileSync(join(fixture, dstRel), 'utf8').includes('SOURCE MOVED'),
    'a clean destination must pick up the source edit, or the sync no longer serves its purpose',
  );
}

// web-uplift-xym1. generateVendoredSurface copies TRACKED_COPY_FILES - destinations git tracks, unlike
// the gitignored .web-uplift/ tree - and it used to do so unconditionally. In a worktree that has no
// .web-uplift/ yet, tests/cdp-copy-sync.mjs auto-invokes it, so an edit to .pi/skills/web-audit/SKILL.md
// was overwritten by the GENERATOR before the sync's own refusal could ever be reached. The generator
// now skips a destination with uncommitted edits and reports it, and its caller decides if that is fatal.
export async function testGenerateVendoredSurfaceLeavesTrackedEditsAlone() {
  const { generateVendoredSurface } = await import('../install-surface.mjs');
  const fixture = mkdtempSync(join(tmp, 'vendored-tracked-'));
  const srcRel = '.claude/skills/web-audit/SKILL.md';
  const dstRel = '.pi/skills/web-audit/SKILL.md';
  mkdirSync(dirname(join(fixture, srcRel)), { recursive: true });
  mkdirSync(dirname(join(fixture, dstRel)), { recursive: true });
  writeFileSync(join(fixture, srcRel), '# skill\noriginal content\n');
  writeFileSync(join(fixture, dstRel), '# skill\noriginal content\n');

  const git = (...args) => spawnSync('git', args, { cwd: fixture, encoding: 'utf8', env: gitEnv() });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '-q', '-m', 'fixture');

  // (a) the tracked destination carries work that exists nowhere else: the generator must leave it.
  appendFileSync(join(fixture, dstRel), 'LOCAL WORK THAT MUST SURVIVE\n');
  const generated = generateVendoredSurface({ targetRoot: fixture });
  assert(
    readFileSync(join(fixture, dstRel), 'utf8').includes('LOCAL WORK THAT MUST SURVIVE'),
    'generateVendoredSurface must not overwrite a tracked destination that has uncommitted edits',
  );
  assert(
    (generated.skippedTrackedCopies || []).includes(dstRel),
    `the generator must report what it left alone, got ${JSON.stringify(generated && generated.skippedTrackedCopies)}`,
  );

  // (b) CONTROL: a destination that is merely stale, because the SOURCE moved, must still be refreshed.
  // Without this, "skip the copy" could be implemented as "never copy", which would break installation.
  git('checkout', '--', dstRel);
  appendFileSync(join(fixture, srcRel), 'SOURCE MOVED\n');
  const second = generateVendoredSurface({ targetRoot: fixture });
  assert(
    readFileSync(join(fixture, dstRel), 'utf8').includes('SOURCE MOVED'),
    'a clean tracked destination must still be refreshed from its source, or the generator no longer installs',
  );
  assert(
    (second.skippedTrackedCopies || []).length === 0,
    'a clean destination must not be reported as skipped',
  );
}
