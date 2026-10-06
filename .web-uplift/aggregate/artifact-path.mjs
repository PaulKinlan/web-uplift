// Containment for report-supplied artifact paths.
//
// A report is untrusted input: it is written by an agent whose context includes
// untrusted page content, so every string in it must be treated as
// attacker-influenceable. Artifact paths in particular are resolved against a
// run directory, and `join` silently collapses `..`, so a crafted
// `artifacts[].path` could make a renderer read any file the process can read
// (`../../../../home/<user>/.ssh/id_rsa.png`) and inline it - or its bytes - into
// a published artifact (scorecard.html, compare.md). The schema says the path is
// "relative to the report directory"; these checks enforce that.
//
// Two checks, so a call site can use the half it needs:
//
//   isSafeArtifactPath(relPath)    shape only: non-empty, no NUL, not absolute,
//                                  no `..` segment. Use before emitting a
//                                  relative src/link the browser or Markdown
//                                  renderer will resolve on its own.
//   containedArtifactPath(dir, p)  shape plus a resolved containment check. Use
//                                  before any readFileSync. Returns the absolute
//                                  path, or null when the path is unsafe.
//
// Residual, stated rather than implied: the containment check is lexical, so a
// symlink already inside the run directory that points outside it still
// resolves. Creating one requires write access to the run directory, which the
// same agent already has, so this is not a new trust boundary.

import { isAbsolute, resolve, sep } from 'node:path';

export function isSafeArtifactPath(relPath) {
  return typeof relPath === 'string'
    && relPath !== ''
    && !relPath.includes('\0')
    && !isAbsolute(relPath)
    && !relPath.split(/[\\/]/).includes('..');
}

export function containedArtifactPath(dir, relPath) {
  if (!isSafeArtifactPath(relPath)) return null;
  const base = resolve(dir);
  const abs = resolve(base, relPath);
  // The resolved check is authoritative: it also catches shapes the character
  // checks do not enumerate.
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}
