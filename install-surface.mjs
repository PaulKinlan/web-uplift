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

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, lstatSync, existsSync, rmSync } from 'node:fs';
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
    if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    if (existsSync(src)) copyDir(src, dst);
  }

  for (const file of VENDORED_FILES) {
    const src = join(targetRoot, file.source);
    const dst = join(vendorRoot, file.dest);
    if (refusesSymlink(dst)) continue;
    if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
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
