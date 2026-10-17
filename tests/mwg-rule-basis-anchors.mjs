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
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

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

// The re-record contract, DERIVED rather than trusted (web-uplift-p71b). --accept-rules-revision is a request
// the tool verifies, not a permission it grants: it may only re-record a revision in which the RULE digest is
// provably unchanged and only the ANCHOR digest moved. The regression below is p71b's exact finding - a real
// rule rewritten while claiming "only evidence changed" - which the previous, trust-the-string version accepted.
//
// It runs against a throwaway copy because the committed tree has no revision left to accept, and because the
// point is to mutate rules and anchors freely. Nothing in the repo is touched; the copy goes in a finally.
export function testRulesRevisionRequiresProvableEvidenceOnly() {
  console.log('Testing that a same-version rules re-record must PROVE only the evidence moved...');
  const makeCopy = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwg-revision-'));
    cpSync(join(repoRoot, 'knowledge'), join(dir, 'knowledge'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    cpSync(join(repoRoot, 'tests', 'mwg-artefact.mjs'), join(dir, 'tests', 'mwg-artefact.mjs'));
    return dir;
  };
  const runUpdate = (dir, extra) => {
    try {
      return { status: 0, output: execFileSync(process.execPath, [join(dir, 'tests', 'mwg-artefact.mjs'), 'update', ...extra], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (err) {
      return { status: err.status, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };
  const editJson = (dir, rel, mutate) => {
    const path = join(dir, 'knowledge', rel);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    mutate(value);
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  };

  // (A) p71b's repro: a real RULE changes, the caller claims only the evidence did. Must be REFUSED.
  const ruleDir = makeCopy();
  try {
    editJson(ruleDir, 'principles.json', (principles) => {
      principles.principles[0].description = 'Never honor prefers-color-scheme; force light mode only.';
    });
    const rewritten = runUpdate(ruleDir, ['--accept-rules-revision', 'Only evidence changed']);
    assert.notEqual(rewritten.status, 0, 'rewriting a rule and claiming evidence-only must FAIL');
    assert(
      rewritten.output.includes('refusing --accept-rules-revision'),
      `the refusal must name the flag and the derived digests, got: ${rewritten.output.slice(0, 300)}`,
    );
    assert(rewritten.output.includes('rulesSha256'), 'the refusal must show the rule digest evidence it derived');
  } finally {
    rmSync(ruleDir, { recursive: true, force: true });
  }

  // (B) The legitimate case the flag exists for: only a quoted anchor moves. Must be ACCEPTED and recorded.
  const anchorDir = makeCopy();
  try {
    editJson(anchorDir, 'mwg-rule-basis.json', (basis) => {
      basis.rules[0].anchors = [`${basis.rules[0].anchors[0]} (re-pointed)`, ...basis.rules[0].anchors.slice(1)];
    });
    const evidenceOnly = runUpdate(anchorDir, ['--accept-rules-revision', 'test: the rule is unchanged, only its evidence moved']);
    assert.equal(evidenceOnly.status, 0, `an evidence-only re-record must be accepted, got: ${evidenceOnly.output.slice(0, 300)}`);
    const state = JSON.parse(readFileSync(join(anchorDir, 'knowledge', 'mwg-state.json'), 'utf8'));
    assert(state.lastRulesRevision && state.lastRulesRevision.reason.includes('only its evidence moved'), 'the reason must be recorded');
    assert(state.lastRulesRevision.fromRuleBasisSha256 !== state.lastRulesRevision.toRuleBasisSha256, 'the record must name both hashes');
    assert.equal(state.rulesSha256, JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'mwg-state.json'), 'utf8')).rulesSha256, 'an evidence-only revision must leave the RULE digest identical');
  } finally {
    rmSync(anchorDir, { recursive: true, force: true });
  }

  console.log('\u2714 a rules re-record is refused unless the tool can prove only the evidence moved');
}
