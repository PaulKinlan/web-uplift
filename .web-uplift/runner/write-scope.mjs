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
// Consumers and their allowed roots:
//   fixer/fix.mjs        --target, --out and any --allow-write root: a fix may
//                        legitimately edit source and write a report.
//   runner/run-batch.mjs --out only: an audit's one legitimate write is its own run
//                        directory, which is what makes this module reusable for the
//                        batch path at all.
// The module lives under runner/ because runner/ is vendored into .web-uplift/ by
// `web-uplift install`, so anything the batch runner imports has to travel with it;
// fixer/ is not vendored, which is why it is not there.
//
// THIS IS DETECTION, NOT CONFINEMENT, and saying so is the point. The child still
// holds its agent CLI's write tools, and a determined agent can reach outside the
// walked roots, so the walk is a tripwire on the realistic paths, not a sandbox.
// An earlier version of this comment claimed a child cwd rooted at --target was
// impossible because the skill resolves its tool at `.web-uplift/evidence/cli.mjs`
// relative to the PROJECT root. That was wrong and is corrected here: the skill
// documents an invocation that works from any cwd, and the tool path can simply be
// passed absolute. But do not repeat the opposite mistake either - rooting the
// child's cwd at --target only scopes RELATIVE writes; an agent holding write tools
// can still name an absolute path. It is not an enforcement boundary, and neither is
// this module. The boundary is whatever the OPERATOR supplies and declares with
// --isolation; this tool does not verify it, and this walk is the second layer that
// catches realistic escapes when it fails or is absent.
//
// Covered: creates, edits, deletes and symlink changes anywhere under the walked
// roots, including `.git/hooks` and `.git/config` (the persistence vectors for an
// injected agent) and the `--target` tree when it sits outside the invocation
// directory.
//
// Coverage of the EXECUTED trees (web-uplift-dzd). This module used to skip any
// path with a `node_modules` or `.web-uplift` segment - which are exactly the
// trees the tool executes from: the skill spawns `node .web-uplift/evidence/cli.mjs`
// as a fresh process on every primitive, later batch URLs and fix iterations run
// that vendored code, and the runner itself spawns `schema/validate-report.mjs`
// after each audit. An injected page could overwrite the vendored CLI or a
// dependency without the tripwire seeing it, and the next run would execute the
// attacker's code. Now: the executed first-party set (EXECUTABLE_HASH_ROOTS -
// evidence/, runner/, fixer/, aggregate/, schema/, knowledge/, bin/,
// install-surface.mjs and the whole vendored .web-uplift/ tree including its
// node_modules) is stamped with CONTENT HASHES (sha256), so even a rewrite that
// preserves size and mtime is a detected change; the project-level dependency
// tree (`node_modules/`) re-enters the walk at stat-strength stamps, which catches
// every realistic injection (created, resized or rewritten files, swapped links)
// at the cost of one stat per dependency file per snapshot. Only `reports`
// remains a blanket-excluded segment (the fixer must not trip over its own
// report output; callers that WANT the output tree walked pass it as `walkUnder`).
// `run-batch.mjs` layers a pre-spawn integrity gate on top of the hashes: the
// executed set is compared against a batch-start baseline BEFORE each agent
// spawn, and any drift refuses the spawn and aborts the remaining URLs - because
// a refusal for the tampering run alone would still let the NEXT URL execute the
// tampered tree. Because the segment test runs first, a target that lives beneath
// a `reports` directory is skipped wholesale unless named in `walkUnder`.
//
// NOT covered, stated rather than implied: writes outside the walked roots
// (`$HOME`, `/tmp`, another checkout); writes THROUGH a symlink that already
// points outside the roots (the link itself is unchanged, so nothing is
// recorded); writes to an external inode through a hard link that already exists
// inside a walked root; metadata-only changes (the stamps - stat or hash - do not
// see a chmod); empty-directory creation and removal; and, at STAT strength only
// (everything outside EXECUTABLE_HASH_ROOTS, i.e. the project `node_modules/`
// tree), content rewrites that preserve both size and mtime. Hashed roots have no
// such rewrite blind spot. And a file created and deleted inside one run remains
// invisible to the surrounding snapshots.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// The only blanket-excluded segment left: the tool's own report output (excluding
// reports/ is what stops the fixer tripping its own detector when the agent
// writes report.json under --out). `node_modules` and `.web-uplift` were removed
// from this set by web-uplift-dzd: they are executed trees, and excluding them
// made the tripwire blind to exactly the paths whose unobserved change matters
// most. See the header for the strength each covered tree now gets.
const EXCLUDE_SEGMENTS = new Set(['reports']);

// Executed first-party trees, relative to the snapshot base: every file here is
// run or imported by a LATER step of the same pipeline (the agent's next
// primitive, the next batch URL, the next fix iteration, or the runner's own
// post-audit validation), so they are stamped by CONTENT HASH rather than stat.
// `.web-uplift` is listed wholesale: its vendored node_modules (the dependency
// closure the vendored CLI actually imports) and its manifest are part of the
// executed surface and small enough to hash every snapshot.
export const EXECUTABLE_HASH_ROOTS = [
  'evidence', 'runner', 'fixer', 'aggregate', 'schema', 'knowledge', 'bin',
  'install-surface.mjs', '.web-uplift',
];

// sha256 stamp for one file, or null when it raced away.
function hashFile(abs) {
  try {
    return `sha256:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`;
  } catch {
    return null;
  }
}

// Integrity snapshot of the executed first-party set ONLY (no project
// node_modules walk): rel-path -> sha256 stamp, symlinks recorded as link:target
// (a swap to a symlink IS the attack). Callers compare two snapshots with
// diffTrees; run-batch does this before every agent spawn against a batch-start
// baseline and refuses to spawn on any drift.
export function executableIntegrity(base) {
  const baseAbs = resolve(base);
  const entries = new Map();
  const record = (abs, stamp) => { if (stamp !== null) entries.set(relative(baseAbs, abs), stamp); };
  const walkDir = (abs) => {
    let children;
    try {
      children = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const p = join(abs, child.name);
      if (child.isSymbolicLink()) {
        try {
          record(p, `link:${readlinkSync(p)}`);
        } catch { /* raced away */ }
      } else if (child.isDirectory()) walkDir(p);
      else if (child.isFile()) record(p, hashFile(p));
    }
  };
  for (const root of EXECUTABLE_HASH_ROOTS) {
    const abs = resolve(baseAbs, root);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // root absent in this project: nothing to stamp
    }
    if (st.isDirectory()) walkDir(abs);
    else if (st.isFile()) record(abs, hashFile(abs));
  }
  return entries;
}

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
//
// `hashUnder` names roots (relative to `base`, or absolute) that are FORCE-walked
// like `walkUnder` AND whose files are stamped `sha256:<hex>` instead of
// size:mtime - the content-hash strength for executed code (web-uplift-dzd),
// where a rewrite preserving size and mtime must still be a visible change. A
// hashUnder entry may name a single file. Both snapshots being diffed must use
// the same options, or every file whose stamp KIND changed counts as modified.
export function snapshotTree(base, { extraRoots = [], exclude = isExcludedPath, walkUnder = [], hashUnder = [] } = {}) {
  const entries = new Map();
  const baseAbs = resolve(base);
  const wanted = [baseAbs, ...extraRoots.filter(Boolean).map((r) => resolve(r))];
  // Roots that must be traversed even when the exclusion predicate would skip them,
  // and whose ANCESTORS must be descended through to reach them. The batch runner's
  // default output is the reports directory, which the generic exclusion exists to
  // avoid tripping over - but that also made the default output tree invisible in
  // both directions, so the caller names it here and the walk covers it deliberately.
  const forcedRoots = walkUnder.filter(Boolean).map((w) => resolve(w));
  const hashedRoots = hashUnder.filter(Boolean).map((h) => (isAbsolute(h) ? resolve(h) : resolve(baseAbs, h)));
  for (const h of hashedRoots) forcedRoots.push(h);
  const isHashed = (abs) => hashedRoots.some((h) => abs === h || abs.startsWith(h + sep));
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
      const forced = forcedRoots.some((w) => abs === w || abs.startsWith(w + sep) || w.startsWith(abs + sep));
      if (!forced && exclude(key)) continue;
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
      // Executed trees get content hashes; everything else keeps the cheap stat
      // stamp (web-uplift-dzd: the hash is what closes the same-size+mtime
      // rewrite blind spot exactly where the next iteration runs the code).
      if (isHashed(abs)) {
        const stamp = hashFile(abs);
        if (stamp !== null) entries.set(key, stamp);
        continue;
      }
      try {
        const st = statSync(abs);
        entries.set(key, `${st.size}:${st.mtimeMs}`);
      } catch {
        /* raced away */
      }
    }
  };

  for (const root of roots) walk(root, root);
  // A hashUnder entry may name a single FILE (e.g. install-surface.mjs); the
  // directory walk above never reaches it when it sits directly at a root edge.
  for (const h of hashedRoots) {
    let st;
    try {
      st = statSync(h);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const key = relative(baseAbs, h);
    if (key && !entries.has(key)) {
      const stamp = hashFile(h);
      if (stamp !== null) entries.set(key, stamp);
    }
  }
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

// The headless-audit write contract, both halves in one place (web-uplift-16f):
// an agent auditing an untrusted page may write ANYTHING, but only under its
// run's --out directory, and its ad-hoc scratch work (helper scripts, fetched
// reference material) belongs in `<run dir>/scratch` — the placement SKILL.md's
// artifact rule must teach verbatim. WHY scratch lives INSIDE the run directory
// instead of a repo-root scratch/: the run directory is already the one allowed
// root, so the contract needs no second root and confinement never widens;
// scratch beside the run keeps every artifact a reader needs with the run that
// produced it (SKILL's own justification); and a repo-root scratch/ would
// persist across runs — helper code written under one site's influence would
// survive into the next site's audit, outside every run's accounting. The drift
// this prevents is real: run 4 of web-uplift-ies completed a full 58/58 audit
// and was then refused because SKILL said `scratch/` while allowedRoots said
// `reports/` only. tests/skill-write-contract.mjs fails when either half moves.
export const SCRATCH_SUBDIR = 'scratch';
export const allowedRootsFor = (outRoot) => [outRoot];

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
