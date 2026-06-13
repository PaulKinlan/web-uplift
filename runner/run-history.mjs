// Run history helpers: where a run's report directory lives, and how the
// per-host `latest` pointer is maintained, so runs are RETAINED and comparable
// instead of overwriting reports/<host>/.
//
// Layout:
//   reports/<host>/<runId>/        one directory per run (report.json, report.md,
//                                  evidence/, compare.md, ...). runId is a real
//                                  timestamp (passed in or derived here).
//   reports/<host>/latest          a pointer to the most recent run dir. We try
//                                  a symlink first (convenient on a dev box) and
//                                  fall back to a `latest.txt` file naming the
//                                  run dir where symlinks are not available (CI,
//                                  Windows). Either way `resolveLatest` reads it.
//
// This is plumbing only. The model (SKILL.md) still decides what goes in the
// report; these helpers just compute the paths and keep the pointer current.

import {
  mkdirSync,
  symlinkSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { join, basename } from 'node:path';

// Turn a URL (or arbitrary string) into the host slug used as the per-host
// reports directory name. Mirrors derivedOut() in evidence/cli.mjs and slugify()
// in the runner so the same site lands in the same place everywhere.
export function hostSlug(urlOrHost) {
  try {
    return new URL(urlOrHost).host.replace(/[:.]/g, '_') || 'page';
  } catch {
    // Already a slug or a bare host.
    return String(urlOrHost).replace(/[^a-z0-9._-]/gi, '_') || 'page';
  }
}

// A sortable, filesystem-safe run id from a real timestamp. Date.now() is fine in
// the CLI runtime; callers may also pass an explicit id (env/arg) for reproducible
// before/after pairs (e.g. RUN_ID=before-... / after-...).
export function makeRunId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}

// Compute the run directory for a URL + runId, create it, and return both the
// run dir and the per-host root. Does NOT touch the latest pointer (call
// updateLatest after the run actually writes a report).
export function runDir(reportsRoot, urlOrHost, runId = makeRunId()) {
  const host = hostSlug(urlOrHost);
  const hostRoot = join(reportsRoot, host);
  const dir = join(hostRoot, runId);
  mkdirSync(dir, { recursive: true });
  return { dir, hostRoot, host, runId };
}

// Point reports/<host>/latest at the given run dir. Symlink if possible; else a
// latest.txt naming the run dir. Idempotent.
export function updateLatest(hostRoot, runId) {
  const link = join(hostRoot, 'latest');
  const txt = join(hostRoot, 'latest.txt');
  try {
    if (existsSync(link) || isSymlink(link)) rmSync(link, { recursive: true, force: true });
    symlinkSync(runId, link, 'dir');
  } catch {
    // Symlinks unavailable (e.g. some CI / Windows): record the run id in a file.
    writeFileSync(txt, runId + '\n');
  }
  return link;
}

// Resolve the latest run dir for a host (symlink target or latest.txt content);
// fall back to the most recent run dir by name if no pointer exists.
export function resolveLatest(hostRoot) {
  const link = join(hostRoot, 'latest');
  if (isSymlink(link)) {
    try {
      return join(hostRoot, readlinkSync(link));
    } catch {
      /* dangling */
    }
  }
  const txt = join(hostRoot, 'latest.txt');
  if (existsSync(txt)) {
    const id = readFileSync(txt, 'utf8').trim();
    if (id) return join(hostRoot, id);
  }
  const runs = listRuns(hostRoot);
  return runs.length ? runs[runs.length - 1].dir : null;
}

// List the run directories under a host root, oldest first (sorted by runId,
// which is an ISO timestamp so lexical order == chronological order). Skips the
// `latest` pointer and any non-directory.
export function listRuns(hostRoot) {
  if (!existsSync(hostRoot)) return [];
  const out = [];
  for (const name of readdirSync(hostRoot)) {
    if (name === 'latest' || name === 'latest.txt') continue;
    const dir = join(hostRoot, name);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!existsSync(join(dir, 'report.json'))) continue;
    out.push({ runId: name, dir });
  }
  return out.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

// Pick the two runs to compare: explicit ids if given, else the two most recent.
// Returns { a, b } where a is the OLDER (before) and b the NEWER (after).
export function pickRuns(hostRoot, runA, runB) {
  const runs = listRuns(hostRoot);
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const find = (id) => {
    if (!id) return null;
    if (byId.has(id)) return byId.get(id);
    // Allow passing a path or a basename.
    const base = basename(id);
    return byId.get(base) ?? { runId: base, dir: id };
  };
  if (runA && runB) {
    const a = find(runA);
    const b = find(runB);
    // Order so the older run is `a`.
    return a.runId <= b.runId ? { a, b } : { a: b, b: a };
  }
  if (runs.length < 2) {
    throw new Error(
      `Need two runs to compare under ${hostRoot}; found ${runs.length}. ` +
        'Run two audits (e.g. a baseline then a --fix run) first.',
    );
  }
  return { a: runs[runs.length - 2], b: runs[runs.length - 1] };
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
