// Write-scope accounting for fix mode.
//
// WHY this exists: fix mode drives an agent whose prompt context carries
// untrusted page content (the audited page's text, console output and evidence
// all flow into the same model that holds file-write tools), and the fixer's own
// report reader says plainly that a report is untrusted input. A successful
// prompt injection can therefore redirect the agent's writes outside the site
// source it was pointed at. The fixer can never un-write a file, so the
// defensible behaviour is: make the boundary explicit, snapshot around every
// iteration, hand the operator a per-iteration diff, and refuse to continue the
// climb once a change lands outside the declared scope.
//
// DELIBERATELY NOT DONE HERE: rooting the child's working directory at --target.
// The canonical skill tells the agent to run `node .web-uplift/evidence/cli.mjs`,
// a path relative to the PROJECT ROOT, and `web-uplift install` vendors
// .web-uplift/ into the project root (bin/web-uplift.mjs), while the documented
// fix invocation points --target at a source SUBdirectory (`fix --target ./src`).
// Rooting the child at --target would break that lookup, so the child keeps the
// project-root cwd and the boundary is enforced by snapshot + refusal instead of
// by the filesystem.
//
// Snapshot stamps are size+mtime, not content hashes: the question is "did this
// iteration touch that path", and a same-size, same-mtime content rewrite is not
// a realistic injection escape. Symlinks are recorded by target and never
// followed, so a link cannot pull the walk out of the tree.
//
// This is deliberately fail-closed: a stray scratch file the model drops outside
// --target also refuses the run. That is the intended trade (a named list of
// paths and a stopped climb, not a silent write), and the noisy trees that would
// make it unusable - the dependency tree, .git, the vendored tool and `reports/`
// where the tool's own output lands - are excluded from the walk.

import { readdirSync, readlinkSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// Trees never worth walking for a scope snapshot: version control, installed
// dependencies, the vendored tool, and the tool's own report output.
export const DEFAULT_EXCLUDE = new Set(['.git', 'node_modules', '.web-uplift', 'reports']);

// relPath -> `${size}:${mtimeMs}` for files, `link:${target}` for symlinks.
export function snapshotTree(root, { exclude = DEFAULT_EXCLUDE } = {}) {
  const entries = new Map();
  const walk = (dir) => {
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: nothing to record
    }
    for (const child of children) {
      if (exclude.has(child.name)) continue;
      const abs = join(dir, child.name);
      if (child.isSymbolicLink()) {
        try {
          entries.set(relative(root, abs), `link:${readlinkSync(abs)}`);
        } catch {
          /* raced away */
        }
        continue;
      }
      if (child.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!child.isFile()) continue;
      try {
        const st = statSync(abs);
        entries.set(relative(root, abs), `${st.size}:${st.mtimeMs}`);
      } catch {
        /* raced away */
      }
    }
  };
  walk(root);
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
// declared source tree and its own report directory, and nothing else.
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
