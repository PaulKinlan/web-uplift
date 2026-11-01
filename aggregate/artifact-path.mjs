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
// Residual, stated rather than implied: this check is LEXICAL, so a symlink that
// already exists inside the run directory and points outside it still resolves.
// Creating one requires write access to the run directory, which the same agent
// already has, so this is not a new READ boundary - but it is a DISCLOSURE
// boundary, because whatever a renderer inlines is published
// (web-uplift-kfkz). A read site therefore uses containedReadPath below, not
// this function.

import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

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

// The READ form: lexical containment first, then the same check on the RESOLVED
// path, so an in-run symlink pointing outside is refused too (web-uplift-kfkz).
//
// The lexical half alone is insufficient in the direction that matters for a
// renderer: `shot.png` is a perfectly safe-looking relative path, and if it is a
// symlink to ~/.ssh/id_rsa the scorecard inlines host bytes into a published
// artifact. The read did not cross a boundary the agent did not already have;
// the PUBLICATION did.
//
// Returns the resolved absolute path, or null when containment cannot be proved
// (unsafe shape, missing file, unreadable link). Callers treat null as 'no
// artifact', which is what they already did for an unreadable file, so refusing
// here cannot be mistaken for a successful read.
export function containedReadPath(dir, relPath) {
  const abs = containedArtifactPath(dir, relPath);
  if (!abs) return null;
  let base;
  let real;
  try {
    base = realpathSync(resolve(dir));
    real = realpathSync(abs);
  } catch {
    return null;
  }
  if (real !== base && !real.startsWith(base + sep)) return null;
  return real;
}
// A DIRECTORY named by one untrusted path segment, resolved inside `base`.
//
// Use this before an untrusted string becomes the BASE for later reads, which is
// a different question from containedArtifactPath: there the base is trusted and
// the relative path is checked against it, while here the base itself is what the
// record supplies. `join(latest.dir, '..', cmp.runA)` normalises the record's `..`
// away before any later check on the resulting path can see it, so a comparison
// record could point the screenshot base at any directory and the path check would
// then happily validate the screenshot against that base. Returns the absolute
// directory, or null when the name does not resolve to a direct child of `base`
// (web-uplift-9li).
//
// The resolved direct-child check is authoritative; the string checks up front
// exist so a name that is obviously a path, an absolute path, or empty is refused
// before any resolution, and so `..` never reaches it.
export function containedChildDir(base, name) {
  if (typeof name !== 'string' || name === '' || name.includes('\0') || isAbsolute(name)) return null;
  if (name.split(/[\\/]/).includes('..') || /[\\/]/.test(name)) return null;
  const root = resolve(base);
  const abs = resolve(root, name);
  if (abs === root || dirname(abs) !== root) return null;
  return abs;
}
