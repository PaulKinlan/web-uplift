// The anchors in knowledge/mwg-rule-basis.json are the verbatim evidence each rule rests on; appliedRulesVersion
// names the RULE SET. Re-anchoring therefore changes the basis hash without changing which rules were applied,
// and that is legitimate only as a deliberate, recorded act - which is why one appliedRulesVersion must never
// describe two different anchor sets (web-uplift-7bld).
//
// This pins the anchor set to the version it was verified under. Revising an anchor without updating this pin
// fails by name, so a re-baseline is a decision someone records rather than a side effect of a helpful edit.
// When you DO revise anchors: re-verify with
//   node tests/mwg-drift-classify.mjs --verify-basis <corpus> --basis knowledge/mwg-rule-basis.json --catalog knowledge/mwg-catalog.json
// re-record knowledge/mwg-state.json's ruleBasisSha256 (tests/mwg-artefact.mjs update), and update the value below
// in the same commit, saying on the bead why the applied RULES are unchanged.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// appliedRulesVersion -> sha256 of the [[rule id, anchors], ...] pairs as verified.
const PINNED_ANCHOR_SETS = {
  '0.0.194': '25121802a4e9dc188891f7e4d85cf887b45e786c4b4f0d59748c8ef4f392baca',
};

export function testRuleBasisAnchorsArePinnedPerAppliedVersion() {
  console.log('Testing that the rule-basis anchor set is pinned to the appliedRulesVersion describing it...');
  const basis = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'mwg-rule-basis.json'), 'utf8'));
  const state = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'mwg-state.json'), 'utf8'));
  const pairs = basis.rules.map((rule) => [rule.id, rule.anchors]);
  const digest = createHash('sha256').update(JSON.stringify(pairs)).digest('hex');

  assert(
    basis.catalogueVersion === state.appliedRulesVersion,
    `rule-basis catalogueVersion (${basis.catalogueVersion}) must equal appliedRulesVersion (${state.appliedRulesVersion})`,
  );

  const pinned = PINNED_ANCHOR_SETS[state.appliedRulesVersion];
  assert(
    pinned,
    `appliedRulesVersion ${state.appliedRulesVersion} has no pinned anchor set. A rules version must never describe two different anchor sets, so a new version needs its anchors pinned here in the same commit (web-uplift-7bld)`,
  );
  assert.equal(
    digest,
    pinned,
    `the rule-basis anchor set changed under appliedRulesVersion ${state.appliedRulesVersion} (pinned ${pinned.slice(0, 12)}..., got ${digest.slice(0, 12)}...). appliedRulesVersion identifies WHICH RULES were applied; if this revision does not change them, re-verify the basis against the corpus, re-record ruleBasisSha256 with tests/mwg-artefact.mjs update, and update PINNED_ANCHOR_SETS here in the same commit, saying on the bead why the rules are unchanged (web-uplift-7bld)`,
  );

  const anchorCount = pairs.reduce((n, pair) => n + pair[1].length, 0);
  console.log(`\u2714 anchor set pinned for ${state.appliedRulesVersion} (${basis.rules.length} rule(s), ${anchorCount} anchor(s))`);
}
