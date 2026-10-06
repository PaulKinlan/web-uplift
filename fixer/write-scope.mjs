// Write-scope accounting for fix mode.
//
// WHY this exists: fix mode drives an agent whose prompt context carries
// untrusted page content (the audited page's text, console output and evidence
// all flow into the same model that holds file-write tools), and the fixer's own
// report reader says plainly that a report is untrusted input. A successful
// prompt injection can therefore redirect the agent's writes outside the site
// source it was pointed at. The fixer can never un-write a file, so the
// defensible behaviour is: make the boundary explicit, snapshot around every
// agent run (the baseline audit included), hand the operator a per-run diff, and
// refuse to continue once a change lands outside the declared scope.
//
// THIS IS DETECTION, NOT CONFINEMENT, and saying so is the point. A determined
// agent can still reach outside the walked roots (see the gaps listed below), so
// the walk is a tripwire on the realistic paths, not a sandbox; true confinement
// needs an OS sandbox or a child cwd rooted at --target, which is not possible
// while the skill resolves its tool at `.web-uplift/evidence/cli.mjs` relative to
// the PROJECT root (see fixer/fix.mjs).
//
// Covered: creates, edits, deletes and symlink changes anywhere under the walked
// roots, including `.git/hooks` and `.git/config` (the persistence vectors for an
// injected agent) and the `--target` tree when it sits outside the invocation
// directory.
//
// NOT covered, stated rather than implied: writes outside the walked roots
// (`$HOME`, `/tmp`, another checkout); content rewrites that preserve size AND
// mtime; hard links created into a walked root; and a file created and deleted
// inside one iteration. Excluding the noisy trees (the dependency tree, vendored
// tool, `reports/` and `.git/objects`) is what makes the walk cheap enough to run
// every iteration, and it is also what leaves those trees uncovered.

import { readdirSync, readlinkSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// Excluded wherever they appear: installed dependencies, the vendored tool, and
// the tool's own report output (excluding reports/ is what stops the fixer
// tripping its own detector when the agent writes report.json under --out).
const EXCLUDE_SEGMENTS = new Set(['node_modules', '.web-uplift', 'reports']);

// .git is walked ONLY where an injected agent could plant persistence. The
// object store, logs and worktree metadata are large, noisy and not a
// persistence vector.
const GIT_KEEP = new Set(['hooks', 'config', 'HEAD', 'info', 'packed-refs']);

export function isExcludedPath(relPath) {
  const parts = relPath.split(sep);
  if (parts.some((p) => EXCLUDE_SEGMENTS.has(p))) return true;
  // `.git` itself must stay walkable (only its noisy children are skipped), or the
  // hook/config tripwire never gets reached. Matching the LAST `.git` segment, not
  // parts[0], is what makes this work for an out-of-tree --target whose keys start
  // with `..` - otherwise that repository's object store would be walked.
  const gitAt = parts.lastIndexOf('.git');
  if (gitAt !== -1) {
    const next = parts[gitAt + 1];
    if (next !== undefined && !GIT_KEEP.has(next)) return true;
  }
  return false;
}

// relPath (relative to `base`) -> `${size}:${mtimeMs}` for files, `link:${target}`
// for symlinks. Symlinks are recorded by target and never followed, so a link
// cannot pull the walk out of the tree.
//
// `extraRoots` are walked as well, with their entries keyed relative to `base` -
// this is how a --target that lives outside the invocation directory still gets a
// diff. A root already covered by another root is skipped, so overlapping roots
// do not double-walk.
export function snapshotTree(base, { extraRoots = [], exclude = isExcludedPath } = {}) {
  const entries = new Map();
  const baseAbs = resolve(base);
  const wanted = [baseAbs, ...extraRoots.filter(Boolean).map((r) => resolve(r))];
  const roots = wanted.filter((r, i) => !wanted.some((other, j) => j !== i && (r === other ? j < i : r.startsWith(other + sep))));

  const walk = (rootAbs, dirAbs) => {
    let children;
    try {
      children = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return; // unreadable directory: nothing to record
    }
    for (const child of children) {
      const abs = join(dirAbs, child.name);
      const key = relative(baseAbs, abs);
      if (exclude(key)) continue;
      if (child.isSymbolicLink()) {
        try {
          entries.set(key, `link:${readlinkSync(abs)}`);
        } catch {
          /* raced away */
        }
        continue;
      }
      if (child.isDirectory()) {
        walk(rootAbs, abs);
        continue;
      }
      if (!child.isFile()) continue;
      try {
        const st = statSync(abs);
        entries.set(key, `${st.size}:${st.mtimeMs}`);
      } catch {
        /* raced away */
      }
    }
  };

  for (const root of roots) walk(root, root);
  return entries;
}

export function diffTrees(before, after) {
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [path, stamp] of after) {
    if (!before.has(path)) added.push(path);
    else if (before.get(path) !== stamp) modified.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) deleted.push(path);
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

// Of the changes in a diff (paths relative to `base`), the ones that resolve
// outside every allowed root. This is the refusal test: a fix run may touch the
// declared source tree, its own report directory, and anything the operator
// explicitly allowed, and nothing else.
export function escapedChanges(changes, base, allowedRoots) {
  const roots = allowedRoots.filter(Boolean).map((r) => resolve(r));
  const inside = (abs) => roots.some((r) => abs === r || abs.startsWith(r + sep));
  const all = [...changes.added, ...changes.modified, ...changes.deleted];
  return all.map((p) => resolve(base, p)).filter((abs) => !inside(abs)).sort();
}

// One bounded line per class of change, so a long iteration cannot flood the
// terminal or an agent-driven run's captured stdout.
export function summariseChanges(changes, { max = 8 } = {}) {
  const parts = [];
  for (const kind of ['added', 'modified', 'deleted']) {
    const list = changes[kind];
    if (!list.length) continue;
    const shown = list.slice(0, max).join(', ');
    parts.push(`${kind} ${list.length}${list.length > max ? ` (${shown}, ...)` : ` (${shown})`}`);
  }
  return parts.join('; ') || 'no file changes';
}
