// One implementation of "does the rule basis still hold against this guide text".
//
// The rule basis (knowledge/mwg-rule-basis.json) exists to notice that guidance we depend on
// has been REVERSED upstream: each rule pins verbatim anchor excerpts from its guide, so if the
// guide stops containing them, something moved and a human must look. Two callers ask that
// question - the classifier/verifier (tests/mwg-drift-classify.mjs) and the scheduled drift
// check (tests/mwg-drift-check.mjs) - and they must answer it the same way. This module exists
// because two copies of a guard drift apart and then disagree about the same file, which has
// bitten this repository before (web-uplift-lsn3); web-uplift-m9o3 is the check gaining the
// question, not the question gaining a second answer.
//
// Deliberately NOT here: version binding (basis.catalogueVersion vs a corpus/catalog version).
// The verifier enforces that because verifying a registry against the WRONG release is
// meaningless. The drift check must NOT: its whole job is to look at a release we have not
// analysed yet, and reporting "an anchor in our registry no longer resolves in the new release"
// is the early warning, not a reason to refuse the comparison.

/**
 * @param {{rules: Array<{id: string, guide: string, anchors: string[]}>}} basis
 * @param {Record<string, string>} guides  guide id -> guide text
 * @returns {string[]} violations; empty means every anchor is still verbatim
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

export function basisAnchorViolations(basis, guides) {
  const violations = [];
  for (const rule of basis.rules) {
    if (!Object.prototype.hasOwnProperty.call(guides, rule.guide)) {
      violations.push(`Rule "${rule.id}": registered guide "${rule.guide}" does not exist in corpus`);
      continue;
    }
    const guideText = guides[rule.guide];
    for (const anchor of rule.anchors) {
      if (!guideText.includes(anchor)) {
        violations.push(`Rule "${rule.id}" for guide "${rule.guide}": anchor not found in guide text: ${JSON.stringify(anchor)}`);
      }
    }
  }
  return violations;
}

/**
 * Read a guide tree (the extracted `.../guides` directory of a published package) into
 * guide id -> text.
 *
 * Guide ids are BASENAMES, because that is how the catalog, the corpus and the basis name guides.
 * That flattening is only safe while the basenames are unique, so a collision is REFUSED rather
 * than letting one guide silently overwrite another: an anchor could then be verified against the
 * WRONG guide's text, or a guide that vanished upstream could be masked by a same-named sibling.
 * Both are this repository's least favourite failure - a check that passes for the wrong reason
 * (reviewer finding on web-uplift-m9o3). The classifier's extraction keeps a PROVENANCE-based
 * precedence instead (USE_CASES entry before disk scan); refusing is the right answer here because
 * anchor verification has no provenance to prefer one candidate over another.
 *
 * @param {string} guidesRoot
 * @returns {Record<string, string>}
 * @throws when two guide files share a basename, or when the tree holds no guides
 */
export function guidesFromTree(guidesRoot) {
  const found = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const id = basename(entry.name, '.md');
        const previous = found.get(id);
        if (previous !== undefined) {
          throw new Error(
            `two guide files share the id "${id}" (${previous} and ${full}); guide ids are basenames, so one would silently overwrite the other and an anchor could be verified against the wrong text`,
          );
        }
        found.set(id, full);
      }
    }
  };
  walk(guidesRoot);
  if (found.size === 0) throw new Error(`no guide markdown found under ${guidesRoot}`);
  const guides = {};
  for (const [id, file] of found) guides[id] = readFileSync(file, 'utf8');
  return guides;
}
