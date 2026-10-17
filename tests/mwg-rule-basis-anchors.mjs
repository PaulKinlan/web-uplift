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

// The re-record path itself: a same-version rules revision must stay REFUSED unless the caller states, in words
// that are recorded, why the applied rules are unchanged. This cannot be exercised on the committed tree, whose
// state already records the current hash - there would be no revision to accept - so it runs against a throwaway
// copy of the tree with the state rolled back to the hash this re-anchor replaced. Nothing in the repo is
// mutated, which is also why the copy is deleted in a finally (web-uplift-7bld).
export function testRulesRevisionRequiresARecordedReason() {
  console.log('Testing that a rules re-record under an unchanged version requires a recorded reason...');
  const tmp = mkdtempSync(join(tmpdir(), 'mwg-revision-'));
  try {
    cpSync(join(repoRoot, 'knowledge'), join(tmp, 'knowledge'), { recursive: true });
    mkdirSync(join(tmp, 'tests'), { recursive: true });
    cpSync(join(repoRoot, 'tests', 'mwg-artefact.mjs'), join(tmp, 'tests', 'mwg-artefact.mjs'));
    const statePath = join(tmp, 'knowledge', 'mwg-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.ruleBasisSha256 = '11a0f2ee435c3add5890b6c44a6087ce64324eaba526a42f7b5c07f5f9c49cf5'; // the pre-re-anchor hash
    delete state.lastRulesRevision;
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

    const cli = join(tmp, 'tests', 'mwg-artefact.mjs');
    const runUpdate = (extra) => {
      try {
        return { status: 0, output: execFileSync(process.execPath, [cli, 'update', ...extra], { encoding: 'utf8', stdio: 'pipe' }) };
      } catch (err) {
        return { status: err.status, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    };

    const refused = runUpdate([]);
    assert.notEqual(refused.status, 0, 'a rules change under an unchanged version must be refused');
    assert(refused.output.includes('applied rules changed'), `the refusal must say what changed, got: ${refused.output.slice(0, 200)}`);

    const emptyReason = runUpdate(['--accept-rules-revision', '   ']);
    assert.notEqual(emptyReason.status, 0, 'an empty --accept-rules-revision must never be read as consent');
    assert(emptyReason.output.includes('needs a non-empty reason'), `an empty reason must be named, got: ${emptyReason.output.slice(0, 200)}`);

    const accepted = runUpdate(['--accept-rules-revision', 'test: the rule is unchanged, only its evidence moved (web-uplift-7bld)']);
    assert.equal(accepted.status, 0, `a reasoned re-record must be accepted, got: ${accepted.output.slice(0, 300)}`);
    const recorded = JSON.parse(readFileSync(statePath, 'utf8')).lastRulesRevision;
    assert(recorded && recorded.reason.includes('only its evidence moved'), 'the reason must be recorded in the state file');
    assert(recorded.fromRuleBasisSha256 !== recorded.toRuleBasisSha256, 'the record must name both hashes');

    console.log('\u2714 a same-version rules re-record is refused without a reason and auditable with one');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
