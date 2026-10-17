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
