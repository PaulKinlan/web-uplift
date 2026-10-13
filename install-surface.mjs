// What `web-uplift install` vendors, declared ONCE.
//
// The installer copies these files and directories into the consumer's
// `.web-uplift/` tree, and tests/cdp-copy-sync.mjs byte-compares every tracked copy
// against its source. Those two lists used to be maintained separately - the
// installer hard-coded its plan, the guard hard-coded its pairs - so a directory
// could be vended and never compared, or compared while no longer being vended, with
// nothing able to notice. Both now read this module, and tests/regression.mjs drives
// a real dry-run install and asserts the destinations match what is declared here,
// so the set cannot fall behind silently (web-uplift-7mr).

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, lstatSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename));

// Directories copied whole into `.web-uplift/`.
export const VENDORED_DIRS = [
  { source: 'evidence', dest: 'evidence', what: 'evidence primitives (raw-CDP CLI)' },
  { source: 'aggregate', dest: 'aggregate', what: 'scorecard + compare + aggregate' },
  { source: 'runner', dest: 'runner', what: 'run history + user-flow record/replay' },
  { source: 'schema', dest: 'schema', what: 'findings + config schema' },
];

// Individual files vendored into `.web-uplift/`. `knowledge/` is listed file by file
// because the directory holds notes the install does not copy.
export const VENDORED_FILES = [
  { source: '.claude/skills/web-audit/SKILL.md', dest: 'skill/SKILL.md', what: 'canonical web-audit SKILL.md' },
  { source: 'knowledge/principles.json', dest: 'knowledge/principles.json', what: 'principles spec' },
  { source: 'knowledge/baseline.mjs', dest: 'knowledge/baseline.mjs', what: 'baseline oracle' },
  { source: 'knowledge/guidance.md', dest: 'knowledge/guidance.md', what: 'guidance lookup protocol' },
];

// Tracked copies outside `.web-uplift/` that a per-agent install also writes, and
// that the guard compares for the same byte-identity reason.
export const TRACKED_COPY_FILES = [
  { source: '.claude/skills/web-audit/SKILL.md', dest: '.pi/skills/web-audit/SKILL.md' },
];

// Top-level runtime dependencies the installer vendors into
// `.web-uplift/node_modules/` by walking each package's `dependencies` to copy the
// full transitive closure. The closure is recorded name+version in the install
// manifest as `vendoredDependencies` and verified for completeness by
// tests/install-copy-symlink.mjs; it is NOT a byte-identity pair in
// tests/cdp-copy-sync.mjs because `.web-uplift/node_modules/` is generated at
// install time, not a tracked repo file (there is no in-repo copy to compare).
export const VENDORED_DEPENDENCIES = ['chrome-remote-interface', 'web-features'];

// Deliberately NOT part of this surface, with the reason:
//
//   `.web-uplift/node_modules`  packages copied out of this package's own dependency
//                               tree, recorded in the install manifest as
//                               `vendoredDependencies`; they are not tracked repo
//                               files, so there is no source to compare them to.
//   `.web-uplift/manifest.json` written at install time from the package version,
//                               not copied from a source file.
//   per-agent wrappers and the `<!-- web-uplift:install -->` managed block
//                               generated per agent rather than copied, and the
//                               guard has no source to compare them against.

function copyDir(from, to, depth = 1) {
  if (depth > 64) return;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    const st = lstatSync(src);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) copyDir(src, dst, depth + 1);
    else copyFileSync(src, dst);
  }
}

// A tracked copy is one whose destination git actually tracks - the .pi skill copy, unlike the
// gitignored .web-uplift/ tree. Replacing one that carries its own uncommitted edits destroys work
// while reporting success, so both the generator and the sync ask this first (web-uplift-xym1).
//
// The predicate is `git diff --quiet HEAD --`, NOT `git status --porcelain`: porcelain reports an
// untracked path as "?? path", indistinguishable from a modification without parsing status codes,
// and an untracked destination is not someone's uncommitted work. Exit 1 means "differs from HEAD"
// ONLY when git could answer - outside a repository git also exits 1, with "Could not access 'HEAD'"
// on stderr, which must read as unknown rather than edited or every non-repository fixture breaks.
export function trackedCopyHasLocalEdits(targetRepoAbs, targetRel) {
  const res = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', targetRel], { cwd: targetRepoAbs, encoding: 'utf8' });
  if (res.status !== 0 && res.status !== 1) return { state: 'unknown', detail: (res.stderr || '').trim() };
  if (res.status === 1 && (res.stderr || '').trim()) return { state: 'unknown', detail: (res.stderr || '').trim() };
  return { state: res.status === 1 ? 'edited' : 'clean' };
}

// Does any component of `dst`, from the target root down, already exist as a SYMLINK? Returns the
// offending component, or null when the whole path is symlink-free.
//
// The WALK is private and asked through refusedDestination below, so every writer makes the same
// question rather than repeating it: tests/cdp-copy-sync.mjs - which IS `npm run sync:vendored` and the
// first half of both `npm test` and `npm run test:fast` - had no check of its own because this was not
// exported (web-uplift-sfbp).
//
// This generator writes with copyFileSync / writeFileSync, both of which FOLLOW a destination
// symlink (O_CREAT|O_TRUNC), and with mkdirSync(dirname(dst), { recursive: true }), which follows a
// symlinked DIRECTORY component. A tree that pre-plants a symlink therefore had this generator write
// outside its own root (web-uplift-7caa, measured on master before the fix):
//   * an intermediate directory component - `.web-uplift/knowledge` -> a victim directory - put
//     knowledge/principles.json INSIDE the victim directory;
//   * a leaf destination - `.web-uplift/manifest.json` -> a victim file - overwrote the victim file
//     with the generated manifest, and `.web-uplift/skill/SKILL.md` likewise with the SKILL.md copy.
// The reachable instance is the TRACKED copy: `.pi/skills/web-audit/SKILL.md` is a destination git
// tracks, so a branch can replace that tracked file with a symlink (this repo already tracks
// `.codex/skills/web-audit` as one), and `npm install` (the prepare script), `npm run sync:vendored`
// or the test suite then writes through it on a checkout of that branch.
//
// The question is asked of EVERY component rather than of the leaf, because an lstat of the leaf
// cannot see an intermediate symlink, and because a DANGLING leaf symlink is reported absent by
// existsSync while still being a symlink the write would follow. bin/web-uplift.mjs got the same
// guard for its own install writes in web-uplift-yel3; install-surface.mjs was omitted then, which
// is the omission this closes.
function symlinkComponent(dst, rootDir) {
  const root = resolve(rootDir);
  const target = resolve(dst);
  const rel = relative(root, target);
  // A destination outside the root by construction is refused for the same reason: nothing this
  // generator writes belongs there.
  if (rel.startsWith('..') || isAbsolute(rel)) return target;
  let current = root;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return current;
  }
  return null;
}

// THE guarded-destination check, and the ONLY name every writer of a vendored destination calls.
//
// EXPORTED for web-uplift-sfbp: this walk used to be private to this module, so the other writer -
// tests/cdp-copy-sync.mjs, which IS `npm run sync:vendored` and the first half of both `npm test` and
// `npm run test:fast` - could not reuse it and had no check of its own. With a symlink planted at the
// TRACKED destination `.pi/skills/web-audit/SKILL.md` and committed, the sync read the drift diff
// THROUGH the link, judged the pair drifted, wrote through it and clobbered an outside-root victim
// with exit 0 - on a fresh clone, on `npm test`. The vector is PR-reachable: `.web-uplift/` is
// gitignored, but that destination is a tracked file a branch can replace with a link.
//
// Returns null when the destination is safe, or { path, symlinkComponent, reason } describing the
// refusal in root-relative terms, so both writers report the same two facts and neither re-derives
// them (a second spelling of a refusal is how the two would drift apart again).
export function refusedDestination(dst, rootDir) {
  const component = symlinkComponent(dst, rootDir);
  if (!component) return null;
  return {
    path: relative(resolve(rootDir), resolve(dst)) || dst,
    symlinkComponent: relative(resolve(rootDir), resolve(component)) || component,
    reason: 'refusing to write through a symlink',
  };
}

// Publish a staged tree into place WITHOUT ever leaving a path the new content STILL HAS absent
// (web-uplift-c6i1, the
// `nz68` half of docs/adr-0003-mutable-repository-root.md). This
// generator used to delete each destination directory whole and recopy it, so a reader that listed a path and
// then read it - which is exactly what the syntax census does to this repository - could hold a path that no
// longer existed. Measured before this change, over a republished tree: 5407 list-then-read cycles produced
// one ENOENT on .web-uplift/runner/c.mjs; reproduced independently for this change with a two-process reader
// over a 60-module tree, 10 republishes: 336 ENOENT in 394617 reads before, 0 in 461465 reads after.
// Every file is now moved into place with a single rename, which is
// atomic within a filesystem, and OBSOLETE entries are removed only AFTER the new content is present, so a
// path the new content STILL HAS can only be observed as stale, never as absent.
//
// THE SCOPE OF THAT GUARANTEE, stated because the absolute version of it was wrong (web-uplift-c7pg): it is a
// property of paths present in BOTH versions, which is what the acceptance covers. A path the source has
// REMOVED is still a disappearance: it survives the publish phase as stale content and pruneObsoleteEntries
// deletes it afterwards, so a reader that listed it before the prune and reads after it will see ENOENT. That
// is reconciliation of a path that no longer exists in the source, not a hole in the surface, and it is
// asserted as such in tests/install-copy-symlink.mjs (the obsolete entry must survive the publish phase and be
// gone only after prune). The same applies to the type-change transitions below, which remove the old entry
// before publishing the new one.
//
// This is NOT cross-file atomicity and does not claim to be: per-file rename means a reader can still observe
// a MIX of new and old files. That is a strictly better failure mode than ENOENT, and it is the limitation.
//
// WHAT THIS DOES AND DOES NOT COVER (web-uplift-c6i1):
//   - initial creation: there is no delete on this path at all; a destination that does not exist is created.
//   - a changed source: the path goes from old bytes to new bytes in one rename, so it is never absent. A
//     single vendored FILE is staged beside its destination and renamed for the same reason, because
//     copyFileSync truncates its destination first.
//   - a removed source: the entry survives the publish phase as stale content and is deleted by
//     pruneObsoleteEntries afterwards, so a reader that listed it can then see it disappear. See the scope
//     note above: the no-hole property belongs to paths present in both versions.
//   - a whole-tree mixed version: possible, and stated rather than assumed.
//   - a type change (a source file replacing a destination directory, or the reverse): handled explicitly,
//     because a rename cannot cross types; those two transitions remove the old entry first, so they are a
//     disappearance for that path rather than a stale read.
//   - a crash mid-publish: the staging tree under `.web-uplift/scratch/` can be left behind. On a run that
//     finishes it is removed after the prune, in that same run; after a crash it is normally NOT removed at
//     all, because the path is keyed by pid (`.stage-<pid>-<dest>`) and the only cleanup a later run performs
//     is the removal of that same key for its OWN pid, so an orphaned `.stage-*` directory stays in
//     `.web-uplift/scratch/` until a later run happens to reuse the pid. Nothing sweeps it (web-uplift-x7ym),
//     and it is invisible to the syntax census because that walk skips a directory named `scratch`.
//     What the destination has lost by then depends on which paths were already published: the create and
//     rename paths have deleted nothing, while a path whose type changed has had its old entry removed
//     already, and that removal is not undone.
//   - the staging tree is invisible to the syntax census because that walk skips a directory named `scratch`
//     (tests/test-helpers.mjs SKIP_DIRS). That coupling is asserted from the test side too: the fixture walks
//     with the census's own listFiles and fails if a staged path becomes visible.
//   - COST, measured rather than assumed: regenerating this repository measured medians of 64ms before and
//     70ms after over three paired runs each; on a synthetic 80-file tree, medians of 6.8ms before and 8.5ms
//     after over five paired runs. The staging write plus the rename is the difference, so it is milliseconds
//     per prepare against a gate budget measured in tens of seconds.
//
// The two phases are exported SEPARATELY, and that is the seam the interleaving test drives step by step
// (web-uplift-c6i1). The order is the whole property: publish first, remove obsolete entries after, so for a
// path the new content STILL HAS, whose TYPE it also still has, the only thing a reader can see is STALE
// content, never a hole - a path whose type changed is removed during publish instead, so it can be absent
// for that moment (web-uplift-x7ym). A path the
// source REMOVED is reconciled away by the prune, so a reader that listed it can see it disappear; the full
// scope note sits with the publish/remove bullets above. A single function that did both would leave the
// ordering untestable except by racing it, which is what the acceptance criteria rule out.
export function publishStagedTree(staged, dest) {
  const files = new Set();
  const dirs = new Set(['']);
  const walk = (from, to, rel = '') => {
    // An entry can change TYPE between two runs (a directory replaced by a file, or the reverse). The old
    // delete-then-recopy never noticed; a rename cannot cross types. Those two transitions are the only ones
    // that remove a destination first, and they are stated here rather than discovered as a crash.
    if (existsSync(to) && !lstatSync(to).isDirectory()) rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      const src = join(from, name);
      const dst = join(to, name);
      const key = rel ? `${rel}/${name}` : name;
      if (lstatSync(src).isDirectory()) {
        dirs.add(key);
        walk(src, dst, key);
      } else {
        if (existsSync(dst) && lstatSync(dst).isDirectory()) rmSync(dst, { recursive: true, force: true });
        renameSync(src, dst);
        files.add(key);
      }
    }
  };
  walk(staged, dest);
  return { files, dirs };
}

// Remove entries the new content does not have, and only after it is in place. A directory is removed only
// when it is empty AND the new content does not declare it, so an empty source directory survives (the old
// copyDir created it and kept it, and silently dropping it would be a different change from this one).
export function pruneObsoleteEntries(dest, published) {
  const prune = (dir, rel = '') => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      if (lstatSync(full).isDirectory()) {
        prune(full, key);
        if (readdirSync(full).length === 0 && !published.dirs.has(key)) rmSync(full, { recursive: true, force: true });
      } else if (!published.files.has(key)) {
        rmSync(full, { force: true });
      }
    }
  };
  prune(dest);
}

export function generateVendoredSurface({ targetRoot = repoRoot } = {}) {
  // Refusals are collected rather than thrown, so one planted symlink does not hide the rest, and so
  // the direct run below can fail the command after reporting every one of them. The message is
  // printed HERE rather than by a caller because `npm run prepare` imports this function and ignores
  // its return value, so a caller-side report would be silent in the one path that runs on every
  // `npm install` (web-uplift-7caa).
  const skippedSymlinks = [];
  const refusesSymlink = (dst) => {
    const refused = refusedDestination(dst, targetRoot);
    if (!refused) return false;
    skippedSymlinks.push({ path: refused.path, symlinkComponent: refused.symlinkComponent });
    console.error(
      `web-uplift: ${refused.reason}: ${refused.path} (${refused.symlinkComponent} is a symlink). `
      + 'Nothing was written for it, so the vendored surface is incomplete; remove or replace the symlink and run again.',
    );
    return true;
  };

  const vendorRoot = join(targetRoot, '.web-uplift');
  // The root of the whole surface: if `.web-uplift` is itself a symlink then every destination below
  // it is one component away from escaping, so the run refuses once instead of repeating itself.
  if (refusesSymlink(vendorRoot)) return { skippedTrackedCopies: [], skippedIdentical: [], skippedSymlinks };
  mkdirSync(vendorRoot, { recursive: true });

  for (const dir of VENDORED_DIRS) {
    const src = join(targetRoot, dir.source);
    const dst = join(vendorRoot, dir.dest);
    if (refusesSymlink(dst)) continue;
    // Staged OUTSIDE everything a repository walk can see: the staging directory is named `scratch`, which the
    // walk skips by name anywhere in the tree, so a census running concurrently cannot observe the staged copy
    // as an extra set of source files (web-uplift-c6i1).
    const staged = join(vendorRoot, 'scratch', `.stage-${process.pid}-${dir.dest}`);
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(staged, { recursive: true });
    if (existsSync(src)) copyDir(src, staged);
    pruneObsoleteEntries(dst, publishStagedTree(staged, dst));
    rmSync(staged, { recursive: true, force: true });
  }

  for (const file of VENDORED_FILES) {
    const src = join(targetRoot, file.source);
    const dst = join(vendorRoot, file.dest);
    if (refusesSymlink(dst)) continue;
    if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      // A single file is published by rename too: copyFileSync truncates the destination first, so a reader
      // could see a partially written module. Renamed from a sibling temp name in the same directory, which
      // keeps it on one filesystem (web-uplift-c6i1).
      const temp = `${dst}.tmp-${process.pid}`;
      copyFileSync(src, temp);
      renameSync(temp, dst);
    }
  }

  // These destinations are TRACKED, so unlike the vendored tree above they can hold work that exists
  // nowhere else. Generating over one that has uncommitted edits would destroy it while the run
  // reported success - the hazard web-uplift-xym1 records, found by the 0zcd review. The copy is
  // skipped and reported instead; callers decide whether that is fatal.
  const skippedTrackedCopies = [];
  const skippedIdentical = [];
  for (const file of TRACKED_COPY_FILES) {
    const src = join(targetRoot, file.source);
    const dst = join(targetRoot, file.dest);
    if (refusesSymlink(dst)) continue;
    if (existsSync(src)) {
      if (trackedCopyHasLocalEdits(targetRoot, file.dest).state === 'edited') {
        skippedTrackedCopies.push(file.dest);
        continue;
      }
      // A destination whose bytes ALREADY match the source is not rewritten. The write would change
      // nothing but the file's ctime, and this destination is one git TRACKS, so rewriting it on
      // every `npm run prepare` - which `npm pack` runs, and which the installer tests run through
      // npm pack - churns the working tree of every checkout. That churn is not cosmetic: it moves
      // the fast gate's worktree witness, which fingerprints `stat %n %s %z` for every tracked file,
      // so the gate recorded STALE on a tree nobody had edited and a change whose targets include
      // the installer tests could never obtain a PASS (web-uplift-7caa, measured: `npm run prepare`
      // on a copy that already matched advanced .pi/skills/web-audit/SKILL.md's nanosecond ctime with
      // identical content). A destination that genuinely differs is still refreshed, which is the
      // behaviour web-uplift-xym1's control pins.
      const dstStat = lstatSync(dst, { throwIfNoEntry: false });
      if (dstStat?.isFile() && readFileSync(src).equals(readFileSync(dst))) {
        skippedIdentical.push(file.dest);
        continue;
      }
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }

  // Write .web-uplift/manifest.json
  let pkg = { name: 'web-uplift', version: '0.5.0' };
  try {
    pkg = JSON.parse(readFileSync(join(targetRoot, 'package.json'), 'utf8'));
  } catch {}

  const manifestPath = join(vendorRoot, 'manifest.json');
  const manifestRefused = refusesSymlink(manifestPath);
  let installedAt = new Date().toISOString();
  if (existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (existing.version === pkg.version && existing.installedAt) {
        installedAt = existing.installedAt;
      }
    } catch {}
  }

  const vendoredDeps = [];
  for (const dep of ['chrome-remote-interface', 'commander', 'web-features', 'ws']) {
    try {
      const depPkgPath = join(targetRoot, 'node_modules', dep, 'package.json');
      if (existsSync(depPkgPath)) {
        const depPkg = JSON.parse(readFileSync(depPkgPath, 'utf8'));
        vendoredDeps.push({ name: dep, version: depPkg.version });
      }
    } catch {}
  }
  if (vendoredDeps.length === 0) {
    vendoredDeps.push(
      { name: 'chrome-remote-interface', version: '0.33.3' },
      { name: 'commander', version: '2.11.0' },
      { name: 'web-features', version: '3.40.0' },
      { name: 'ws', version: '7.5.11' },
    );
  }

  const manifest = {
    package: pkg.name || 'web-uplift',
    version: pkg.version || '0.5.0',
    installedAt,
    agents: ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'opencode', 'pi'],
    vendoredDependencies: vendoredDeps.sort((a, b) => a.name.localeCompare(b.name)),
    updateCommand: 'npx -y web-uplift@latest update --agent all',
  };
  if (!manifestRefused) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return { skippedTrackedCopies, skippedIdentical, skippedSymlinks };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { skippedSymlinks = [] } = generateVendoredSurface();
  if (skippedSymlinks.length > 0) {
    // A refusal that still exited 0 would let a caller treat an incomplete surface as a generated
    // one, which is the failure mode the refusal exists to prevent.
    console.error(`web-uplift: ${skippedSymlinks.length} destination(s) refused because a symlink was in the way; the vendored surface was NOT generated.`);
    process.exitCode = 1;
  } else {
    console.log('web-uplift: vendored surface generated under .web-uplift/');
  }
}
