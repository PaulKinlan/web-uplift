#!/usr/bin/env node
// Versioned-artefact hash contract CLI for Modern Web Guidance (MWG).
// Computes, verifies, and updates the canonical sha256 hash of the catalog
// recorded in knowledge/mwg-state.json.
//
// Dependency-free: Node builtins only (node:fs, node:crypto, node:path, node:url).
//
//
// Canonicalisation rule: see CANONICALISATION_RULE below (the single source of
// truth; the same string is recorded in knowledge/mwg-state.json and quoted in
// docs/mwg-train-consumer-contract.md).
//
// Usage:
//   node tests/mwg-artefact.mjs compute    # print a JSON object {catalogSha256, guideIdsSha256, guideCount}
//   node tests/mwg-artefact.mjs verify     # recompute all three and compare to the state file
//   node tests/mwg-artefact.mjs update     # recompute and write all three into the state file (2-space pretty JSON + trailing newline, preserving other keys)
//   node tests/mwg-artefact.mjs update --accept-rules-revision "<why the applied rules are unchanged>"
//   node tests/mwg-artefact.mjs update --accept-legacy-split "<why the recorded rules are still the intended ones>"
//
// Exit codes:
//    0: Success (exact match on verify, successful compute, successful update).
//    1: Failure (verify mismatch, unreadable/unparseable files, missing or invalid
//       catalogSha256/guideIdsSha256/guideCount in state). Fail-closed: never
//       exits 0 when it cannot verify.
//    4: LEGACY-UNVERIFIED (verify only, its own condition: not a pass and not a hard failure).
//       The state carries no usable rulesSha256/basisSha256 digest pair, so the applied-rules axis
//       cannot be SPLIT-verified - the RULES and their quoted EVIDENCE cannot be told apart - which
//       is the only thing that makes a same-version evidence-only re-record assertable (web-uplift-7bld,
//       p71b). State recorded before that split is therefore exempt from the check unless it is migrated
//       deliberately: `update --accept-legacy-split "<reason>"`, which is refused when the combined
//       ruleBasisSha256 has moved since the state was recorded (web-uplift-nlem).
//   64: Usage error (unknown command, invalid argument count).
//
// Set identity: alongside catalogSha256 the artefact carries guideIdsSha256
// (sha256 of the sorted guide ids joined by single LF newlines, UTF-8, hex;
// the same construction the catalog itself declares) and guideCount, because
// a count is not an identity: consumers compare SETS.
//
// Environment variable overrides:
//   MWG_DRIFT_STATE: Path to state JSON (default: knowledge/mwg-state.json).
//   MWG_DRIFT_CATALOG: Path to catalog JSON (default: knowledge/mwg-catalog.json).

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const CANONICALISATION_RULE =
  'json: recursive lexicographic key sort; array order preserved; compact (no insignificant whitespace); UTF-8; sha256 hex; object keys are emitted in JS property-enumeration order (integer-like keys sort ascending numeric, not lexicographic); tests/mwg-artefact.mjs is the normative implementation; non-ASCII characters are emitted as literal UTF-8, never as \\uXXXX escapes (a serialiser that escapes them computes a different digest for the same catalog - the committed catalog contains U+2014; web-uplift-rxbh)';

export function canonicalise(val) {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalise);
  }
  const sorted = {};
  for (const key of Object.keys(val).sort()) {
    sorted[key] = canonicalise(val[key]);
  }
  return sorted;
}

export function computeSha256(data) {
  const canon = canonicalise(data);
  const compact = JSON.stringify(canon);
  const encoded = new TextEncoder().encode(compact);
  return createHash('sha256').update(encoded).digest('hex');
}

// Set identity, not just a count: the sha256 (UTF-8, hex) of the catalog's
// guide ids sorted lexicographically and joined by single LF newlines (no
// trailing newline). This is the SAME construction as the catalog's own
// guideIdsSha256 declaration: one construction, one hash, no competing
// set-hashes. A count alone cannot tell "same set" from "same size" (the
// count-vs-set defect behind web-uplift-968).
export function computeGuideIds(catalog) {
  const ids = catalog.guides.map((g) => g.id).sort();
  const joined = new TextEncoder().encode(ids.join('\n'));
  return { guideIdsSha256: createHash('sha256').update(joined).digest('hex'), guideCount: ids.length };
}

function readCatalogFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`FAIL: cannot read catalog at ${path}: ${err.message}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`FAIL: cannot parse catalog at ${path}: ${err.message}`);
    process.exit(1);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`FAIL: catalog at ${path} is not a valid JSON object`);
    process.exit(1);
  }
  if (!Array.isArray(parsed.guides) || parsed.guides.some((g) => !g || typeof g.id !== 'string')) {
    console.error(`FAIL: catalog at ${path} has no valid guides array (every entry needs a string id)`);
    process.exit(1);
  }
  return parsed;
}

function readStateFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`FAIL: cannot read state file at ${path}: ${err.message}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`FAIL: cannot parse state file at ${path}: ${err.message}`);
    process.exit(1);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`FAIL: state file at ${path} is not a valid JSON object`);
    process.exit(1);
  }
  return parsed;
}

// A catalog may declare its own set identity (guideIds / guideIdsSha256 /
// guideCount). The declarations must match the values derived from its guides
// array; disagreement is an extractor defect and must fail closed (the
// count-vs-set defect class behind web-uplift-968). Returns mismatch strings.
function declarationMismatches(catalog, derivedIds, ids) {
  const mismatches = [];
  if (catalog.guideIds !== undefined) {
    const declared = catalog.guideIds;
    const valid = Array.isArray(declared) && declared.every((x) => typeof x === 'string');
    if (!valid || declared.length !== derivedIds.length || declared.some((v, i) => v !== derivedIds[i])) {
      mismatches.push('catalog guideIds declaration does not match the sorted ids of its guides array');
    }
  }
  if (catalog.guideIdsSha256 !== undefined && catalog.guideIdsSha256 !== ids.guideIdsSha256) {
    mismatches.push(`catalog guideIdsSha256 declaration (${catalog.guideIdsSha256}) does not match the derived set hash (${ids.guideIdsSha256})`);
  }
  if (catalog.guideCount !== undefined && catalog.guideCount !== ids.guideCount) {
    mismatches.push(`catalog guideCount declaration (${catalog.guideCount}) does not match its guides array length (${ids.guideCount})`);
  }
  return mismatches;
}

// THE APPLIED-RULES AXIS (web-uplift-s52q). analysedVersion is tied to the catalog it was analysed from,
// but the APPLIED rules are a second axis - what the engine actually applied - and nothing tied them to
// anything. A change to knowledge/mwg-rule-basis.json or knowledge/principles.json that skipped the manual
// version bump left verify, npm test, catalogSha256 and the consumer pin all green, so a consumer kept
// trusting a pin that no longer described the applied rules. Two instruments close that: the version is
// DERIVED from the rules themselves, and the rules are HASHED so a change is visible even when the version is
// not bumped. The version stays a deliberate, reviewed edit - update refuses to absorb a rules change under
// an unchanged version rather than bumping it for you.
function readJsonObject(path, what) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`FAIL: cannot read ${what} at ${path}: ${err.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`FAIL: cannot parse ${what} at ${path}: ${err.message}`);
    process.exit(1);
  }
}

function readRuleSources() {
  const ruleBasisPath = process.env.MWG_RULE_BASIS
    ? resolve(process.cwd(), process.env.MWG_RULE_BASIS)
    : join(repoRoot, 'knowledge', 'mwg-rule-basis.json');
  const principlesPath = process.env.MWG_PRINCIPLES
    ? resolve(process.cwd(), process.env.MWG_PRINCIPLES)
    : join(repoRoot, 'knowledge', 'principles.json');
  const ruleBasis = readJsonObject(ruleBasisPath, 'the applied rule basis');
  const principles = readJsonObject(principlesPath, 'the principles file');
  // THE TWO AXES ARE SEPARATE (web-uplift-a1vf, correcting my own conflation in this branch). The ANALYSED
  // catalogue axis is catalog.version + catalogSha256 + principles.guidanceCatalogVersion, and the contract
  // says it MAY advance on its own when upstream guide text moves without applied-rule changes, keeping
  // appliedRulesVersion. So the applied-rules hash must not cover that pin: it hashes the rule basis plus the
  // principles content EXCLUDING guidanceCatalogVersion, and the guard never compares the analysed pin to the
  // rule basis.
  const { guidanceCatalogVersion: _analysedCataloguePin, ...appliedPrinciples } = principles;
  // THE APPLIED-RULES AXIS IS TWO DIGESTS, NOT ONE (web-uplift-p71b). A single hash over rules+anchors cannot
  // tell "the quoted EVIDENCE moved" from "the RULE moved", so any caller-supplied justification for a
  // same-version re-record was an assertion the tool could not check - and a rewritten rule summary passed it.
  // Splitting the derivation is what makes the property assertable instead of claimed:
  //   rulesSha256   the rules themselves: ids, their guide and where, and the applied principles content.
  //                 Nothing in it quotes guide text, so re-pointing an anchor cannot move it.
  //   basisSha256   the quoted anchors only - the evidence each rule rests on.
  // ruleBasisSha256 stays as the combined digest so existing verify paths keep their meaning.
  const stripAnchors = (rules) => rules.map(({ anchors: _anchors, ...rest }) => rest);
  const rulesSha256 = computeSha256({ rules: stripAnchors(ruleBasis.rules), appliedPrinciples });
  const basisSha256 = computeSha256({ anchors: ruleBasis.rules.map((rule) => [rule.id, rule.anchors]) });
  return {
    catalogueVersion: ruleBasis.catalogueVersion,
    ruleBasisSha256: computeSha256({ ruleBasis, appliedPrinciples }),
    rulesSha256,
    basisSha256,
  };
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const args = process.argv.slice(2);
  // update may carry an explicit, reasoned re-record of the applied-rules axis (web-uplift-7bld). A rules
  // revision that leaves appliedRulesVersion alone is refused by default - see the guard below - because it is
  // indistinguishable from the missed bump s52q exists to catch. This flag is how a caller says, in words that
  // are recorded in the state file, that the rules themselves did not change.
  //
  // web-uplift-nlem: --accept-legacy-split is the same kind of request for state recorded BEFORE the split
  // existed: it asks to establish rulesSha256/basisSha256 on an artefact whose only evidence is the combined
  // ruleBasisSha256. Both flags are verified, never trusted (see the guards below).
  const takeFlag = (name) => {
    const at = args.indexOf(name);
    if (at === -1) return null;
    const value = args[at + 1] ?? '';
    args.splice(at, 2);
    return value;
  };
  const revisionReason = takeFlag('--accept-rules-revision');
  const legacyReason = takeFlag('--accept-legacy-split');
  const commandArgs = args;
  if (commandArgs.length !== 1) {
    console.error(`FAIL: expected exactly one command (compute|verify|update), got ${commandArgs.length} arguments`);
    console.error(
      'Usage:\n' +
      '  node tests/mwg-artefact.mjs compute\n' +
      '  node tests/mwg-artefact.mjs verify\n' +
      '  node tests/mwg-artefact.mjs update [--accept-rules-revision "<why the applied rules are unchanged>"] [--accept-legacy-split "<why the recorded rules are still the intended ones>"]'
    );
    process.exit(64);
  }

  const command = commandArgs[0];
  if (command !== 'compute' && command !== 'verify' && command !== 'update') {
    console.error(`FAIL: unrecognized command "${command}"`);
    console.error(
      'Usage:\n' +
      '  node tests/mwg-artefact.mjs compute\n' +
      '  node tests/mwg-artefact.mjs verify\n' +
      '  node tests/mwg-artefact.mjs update'
    );
    process.exit(64);
  }
  if (command !== 'update' && (revisionReason !== null || legacyReason !== null)) {
    console.error('FAIL: --accept-rules-revision and --accept-legacy-split only apply to update; verify and compute never record anything');
    process.exit(64);
  }

  const statePath = process.env.MWG_DRIFT_STATE
    ? resolve(process.cwd(), process.env.MWG_DRIFT_STATE)
    : join(repoRoot, 'knowledge', 'mwg-state.json');

  const catalogPath = process.env.MWG_DRIFT_CATALOG
    ? resolve(process.cwd(), process.env.MWG_DRIFT_CATALOG)
    : join(repoRoot, 'knowledge', 'mwg-catalog.json');

  if (command === 'compute') {
    const catalog = readCatalogFile(catalogPath);
    // compute also prints the applied-rules axis, because update deliberately refuses to ESTABLISH it (a
    // rules change is indistinguishable from a first run, so recording it must be a reviewed human step).
    // This is how the field is bootstrapped: run compute, put the value in knowledge/mwg-state.json, review
    // that the rules at this revision are the ones you intend (web-uplift-s52q).
    console.log(JSON.stringify({
      catalogSha256: computeSha256(catalog),
      ...computeGuideIds(catalog),
      appliedRulesVersion: readRuleSources().catalogueVersion,
      ruleBasisSha256: readRuleSources().ruleBasisSha256,
    }));
    process.exit(0);
  }

  if (command === 'verify') {
    const state = readStateFile(statePath);
    if (typeof state.catalogSha256 !== 'string' || !SHA256_PATTERN.test(state.catalogSha256)) {
      console.error(
        `FAIL: state file at ${statePath} has missing or invalid catalogSha256 (expected 64-char hex, got ${JSON.stringify(state.catalogSha256 ?? null)})`
      );
      process.exit(1);
    }
    if (typeof state.guideIdsSha256 !== 'string' || !SHA256_PATTERN.test(state.guideIdsSha256)) {
      console.error(
        `FAIL: state file at ${statePath} has missing or invalid guideIdsSha256 (expected 64-char hex, got ${JSON.stringify(state.guideIdsSha256 ?? null)})`
      );
      process.exit(1);
    }
    if (!Number.isInteger(state.guideCount) || state.guideCount < 0) {
      console.error(
        `FAIL: state file at ${statePath} has missing or invalid guideCount (got ${JSON.stringify(state.guideCount ?? null)})`
      );
      process.exit(1);
    }

    // The applied-rules axis, checked rather than trusted (web-uplift-s52q).
    const rules = readRuleSources();
    if (typeof state.appliedRulesVersion !== 'string' || state.appliedRulesVersion.trim() === '') {
      console.error(
        `FAIL: state file at ${statePath} has missing or invalid appliedRulesVersion (got ${JSON.stringify(state.appliedRulesVersion ?? null)}); it is the field a consumer trusts when guide text has not moved, so it cannot be absent`
      );
      process.exit(1);
    }
    if (typeof rules.catalogueVersion !== 'string' || rules.catalogueVersion === '') {
      console.error(
        'FAIL: knowledge/mwg-rule-basis.json declares no catalogueVersion, so appliedRulesVersion cannot be checked against the rules it claims to describe'
      );
      process.exit(1);
    }
    if (state.appliedRulesVersion !== rules.catalogueVersion) {
      console.error(
        `FAIL: appliedRulesVersion (${JSON.stringify(state.appliedRulesVersion)}) does not match the applied rules' catalogueVersion (${JSON.stringify(rules.catalogueVersion)}); the rules and the version they are recorded under have diverged`
      );
      process.exit(1);
    }
    if (typeof state.ruleBasisSha256 !== 'string' || !SHA256_PATTERN.test(state.ruleBasisSha256)) {
      console.error(
        `FAIL: state file at ${statePath} has missing or invalid ruleBasisSha256 (expected 64-char hex, got ${JSON.stringify(state.ruleBasisSha256 ?? null)}); run node tests/mwg-artefact.mjs update to record the applied rules`
      );
      process.exit(1);
    }

    // THE SPLIT MUST BIND ON RECORDED STATE, not only on state written after it (web-uplift-nlem). A state
    // recorded before 7bld carries the combined ruleBasisSha256 and NEITHER split digest, so it used to verify
    // green through the old single-hash path while the check that makes a same-version evidence-only re-record
    // assertable simply did not run - the p71b escape hatch, one layer down: an artefact is exempt from the
    // check introduced to make its own claim true. It is a DISTINCT condition rather than a plain failure
    // because nothing is known to be wrong with the artefact; what is known is that it cannot be split-verified
    // until someone migrates it deliberately, so a gate must be able to tell it apart from both a pass and a
    // mismatch (exit 4, the repository's convention for its own condition, as the drift check uses for
    // anchor-broken).
    const missingSplit = [
      ['rulesSha256', state.rulesSha256],
      ['basisSha256', state.basisSha256],
    ].filter(([, value]) => typeof value !== 'string' || !SHA256_PATTERN.test(value));
    if (missingSplit.length > 0) {
      for (const [field, value] of missingSplit) {
        console.error(
          `LEGACY-UNVERIFIED: state file at ${statePath} has missing or invalid ${field} (got ${JSON.stringify(value ?? null)}), so the applied-rules axis cannot be SPLIT-verified: whether the RULES moved or only their quoted EVIDENCE did cannot be told apart (web-uplift-nlem)`
        );
      }
      console.error(
        'This artefact was recorded before the two-digest split (web-uplift-7bld/p71b), so the check that exists to make an evidence-only re-record assertable does not apply to it. MIGRATE it deliberately: `node tests/mwg-artefact.mjs update --accept-legacy-split "<why the recorded rules are still the intended ones>"`, which is refused if the combined ruleBasisSha256 has moved since the state was recorded (in that case bump appliedRulesVersion and re-record through the reviewed path). Otherwise treat this artefact as unverified on purpose and keep it out of a gate. Exiting 4: not a pass, and not a mismatch.'
      );
      process.exit(4);
    }

    const catalog = readCatalogFile(catalogPath);
    const computed = computeSha256(catalog);
    const ids = computeGuideIds(catalog);

    const mismatches = [];
    if (computed !== state.catalogSha256) {
      mismatches.push(`catalogSha256 mismatch (state: ${state.catalogSha256}, computed: ${computed})`);
    }
    if (ids.guideIdsSha256 !== state.guideIdsSha256) {
      mismatches.push(`guideIdsSha256 mismatch (state: ${state.guideIdsSha256}, computed: ${ids.guideIdsSha256})`);
    }
    if (ids.guideCount !== state.guideCount) {
      mismatches.push(`guideCount mismatch (state: ${state.guideCount}, computed: ${ids.guideCount})`);
    }

    // If the catalog declares its own set identity, cross-check the declaration
    // against the values derived from its guides array.
    const derivedIds = catalog.guides.map((g) => g.id).sort();
    mismatches.push(...declarationMismatches(catalog, derivedIds, ids));
    if (rules.ruleBasisSha256 !== state.ruleBasisSha256) {
      mismatches.push(
        `ruleBasisSha256 mismatch (state: ${state.ruleBasisSha256}, computed: ${rules.ruleBasisSha256}): the APPLIED RULES changed and were not re-recorded. If the version should move, bump appliedRulesVersion in knowledge/mwg-state.json, make knowledge/mwg-rule-basis.json and knowledge/principles.json agree, and run update; if it should not, revert the rules edit`
      );
    }
    // The split digests are checked HERE, one axis at a time, not just written by update: a state that carries
    // them and is never compared against them would leave the split decorative in the very command whose job is
    // verification (web-uplift-nlem). Each mismatch names the axis, which is the property the split was
    // introduced for - "the quoted evidence moved" and "the rule changed" are different repairs.
    if (rules.rulesSha256 !== state.rulesSha256) {
      mismatches.push(
        `rulesSha256 mismatch (state: ${state.rulesSha256}, computed: ${rules.rulesSha256}): the RULES changed (an id, guide, where, or the applied principles), not just their quoted evidence. Re-record deliberately with a bumped appliedRulesVersion, or revert the rule edit`
      );
    }
    if (rules.basisSha256 !== state.basisSha256) {
      mismatches.push(
        `basisSha256 mismatch (state: ${state.basisSha256}, computed: ${rules.basisSha256}): the quoted EVIDENCE moved while the RULES did not. That is legitimate only as a recorded re-record: node tests/mwg-artefact.mjs update --accept-rules-revision "<why the applied rules are unchanged>"`
      );
    }
    if (mismatches.length > 0) {
      for (const m of mismatches) console.error(`FAIL: ${m}`);
      process.exit(1);
    }

    console.log(`OK: catalogSha256, guideIdsSha256 and guideCount match (${computed}, ${ids.guideCount} guides), and the applied-rules axis is pinned (appliedRulesVersion ${state.appliedRulesVersion}, ruleBasisSha256 ${state.ruleBasisSha256})`);
    process.exit(0);
  }

  if (command === 'update') {
    const catalog = readCatalogFile(catalogPath);
    const state = readStateFile(statePath);
    const computed = computeSha256(catalog);
    const ids = computeGuideIds(catalog);

    // Never write a state that verify would then reject: refuse to update from
    // a catalog whose own declared set identity disagrees with its guides array.
    const derivedIds = catalog.guides.map((g) => g.id).sort();
    const declMismatches = declarationMismatches(catalog, derivedIds, ids);
    if (declMismatches.length > 0) {
      for (const m of declMismatches) console.error(`FAIL: ${m}`);
      console.error('FAIL: refusing to update the state from a catalog whose declarations are inconsistent');
      process.exit(1);
    }

    // The rules changed while the version stood still: that IS the missed bump this bead is about, so update
    // refuses and names it instead of silently recording a new hash under the old version (web-uplift-s52q).
    const rules = readRuleSources();
    if (typeof rules.catalogueVersion !== 'string' || rules.catalogueVersion === '') {
      console.error('FAIL: knowledge/mwg-rule-basis.json declares no catalogueVersion, so the applied-rules axis cannot be recorded');
      process.exit(1);
    }
    // Strict on purpose, with no first-run allowance: this commit records the hash in the committed state
    // file, so after it lands the field always exists, and an allowance would simply absorb the case this
    // bead exists to catch - a rules change that nobody bumped (found by measuring: my first cut let a
    // verified rules edit through because the restored state had no recorded hash).
    const previousRulesSha = state.ruleBasisSha256;
    if (typeof previousRulesSha !== 'string' || !SHA256_PATTERN.test(previousRulesSha)) {
      console.error(
        `FAIL: knowledge/mwg-state.json carries no usable ruleBasisSha256 (got ${JSON.stringify(previousRulesSha ?? null)}), so a rules change cannot be told from a first run; record it deliberately (node tests/mwg-artefact.mjs update on a tree you have actually reviewed)`
      );
      process.exit(1);
    }
    const rulesRevisionUnderSameVersion = previousRulesSha !== rules.ruleBasisSha256 && state.appliedRulesVersion === rules.catalogueVersion;
    // web-uplift-nlem: a state recorded before the split must not have its split digests RESTORED by a plain
    // update - that is the silent establishment of a claim, which is exactly what p71b refused for the flag.
    // The migration is a separate, recorded act with THREE distinguishable outcomes (web-uplift-6ls5, the
    // review finding on this branch: my first cut refused the changed-basis case and offered no way forward, so
    // an operator with a legacy artefact whose axis had moved was STRANDED - worse than the silent exit 0):
    //   1. legacy + combined digest unchanged -> BACKFILL. The single hash still matches, which proves neither
    //      axis moved since the artefact was recorded, so establishing the pair asserts nothing new.
    //   2. legacy + appliedRulesVersion moved    -> VERSION-BUMP RE-RECORD. The axis genuinely changed under a
    //      version the operator moved deliberately, so the honest record is the NEW version's digests; the
    //      acceptance, both versions and the reason are stored. This is the reachable exit 6ls5 asked for.
    //   3. legacy + same version + digest moved  -> REFUSE. That is s52q's missed bump and the single hash
    //      cannot say which axis moved, so the caller is told exactly how to move the version (see below).
    // Both accepted routes require the flag and a reason; silence is never a route.
    const migratesLegacySplit = typeof state.rulesSha256 !== 'string' || !SHA256_PATTERN.test(state.rulesSha256) ||
      typeof state.basisSha256 !== 'string' || !SHA256_PATTERN.test(state.basisSha256);
    let legacyRoute = null;
    if (migratesLegacySplit) {
      const versionMoved = state.appliedRulesVersion !== rules.catalogueVersion;
      const digestUnchanged = previousRulesSha === rules.ruleBasisSha256;
      if (legacyReason === null) {
        console.error(
          `FAIL: knowledge/mwg-state.json at ${statePath} carries no usable rulesSha256/basisSha256, so the applied-rules axis cannot be split-verified (web-uplift-nlem). Refusing to establish the split digests as a side effect of update: that would record a claim nobody verified. Two deliberate routes, both taking --accept-legacy-split "<reason>": (1) if the combined ruleBasisSha256 still matches (nothing moved since recording) it backfills the pair; (2) if the applied-rules version moved, it records the NEW version's digests. If neither holds, move the version first (see the refusal below)`
        );
        process.exit(1);
      }
      if (legacyReason.trim() === '') {
        console.error('FAIL: --accept-legacy-split needs a non-empty reason: it is recorded in the state file as the justification for establishing the split digests on an artefact that predates them (web-uplift-nlem)');
        process.exit(1);
      }
      if (!versionMoved && !digestUnchanged) {
        console.error(
          `FAIL: refusing --accept-legacy-split. This artefact predates the split and the applied-rules axis has moved under an UNCHANGED version: state.ruleBasisSha256=${JSON.stringify(previousRulesSha)} computed=${JSON.stringify(rules.ruleBasisSha256)} at appliedRulesVersion ${JSON.stringify(state.appliedRulesVersion)}. A single hash cannot say whether the RULES or only their EVIDENCE moved, so this is the missed bump (web-uplift-s52q) and no reason string can make it safe. MOVE THE VERSION and re-run: bump catalogueVersion in knowledge/mwg-rule-basis.json (and keep knowledge/principles.json in step), then re-run this update with the same flag - update writes the rule basis's catalogueVersion into the state for you, and the version-bump route then establishes the new digests. If the rules did not genuinely change, revert the edit instead (web-uplift-nlem, web-uplift-6ls5)`
        );
        process.exit(1);
      }
      // Reached when the operator is entitled to record: either nothing moved (backfill), or the version moved
      // deliberately (version-bump). A version that moved BACKWARDS lands here too, which is intentional and
      // matches how update already treats a non-legacy state whose recorded version lags the rules': the tool
      // records the applied rules' version rather than arbitrating which one is newer, and the edit is a git
      // diff someone reviews.
      legacyRoute = versionMoved ? 'version-bump' : 'backfill';
      state.lastLegacySplitAcceptance = {
        at: new Date().toISOString(),
        route: legacyRoute,
        fromAppliedRulesVersion: state.appliedRulesVersion,
        toAppliedRulesVersion: rules.catalogueVersion,
        fromRuleBasisSha256: previousRulesSha,
        rulesSha256: rules.rulesSha256,
        basisSha256: rules.basisSha256,
        reason: legacyReason.trim(),
      };
    } else if (legacyReason !== null) {
      console.error('FAIL: --accept-legacy-split was given but this state already carries the split digests; the flag exists only to establish them on an artefact recorded before web-uplift-7bld (web-uplift-nlem)');
      process.exit(1);
    }
    // DERIVED, NOT TRUSTED (web-uplift-p71b). --accept-rules-revision is not a permission: it is a request the
    // tool then verifies. A re-record is allowed only if the RULE digest is provably unchanged and only the
    // ANCHOR digest moved, which is the one thing the flag claims. A rewritten rule summary moves rulesSha256,
    // so it is refused no matter what the reason string says.
    const previousRulesDigest = state.rulesSha256;
    const previousBasisDigest = state.basisSha256;
    const canProveEvidenceOnly =
      typeof previousRulesDigest === 'string' && SHA256_PATTERN.test(previousRulesDigest) &&
      typeof previousBasisDigest === 'string' && SHA256_PATTERN.test(previousBasisDigest) &&
      previousRulesDigest === rules.rulesSha256 &&
      previousBasisDigest !== rules.basisSha256;
    if (rulesRevisionUnderSameVersion && revisionReason === null) {
      console.error(
        `FAIL: the applied rules changed (ruleBasisSha256 ${rules.ruleBasisSha256}) but appliedRulesVersion is unchanged at ${JSON.stringify(state.appliedRulesVersion)}; bump the version deliberately in knowledge/mwg-state.json AND knowledge/mwg-rule-basis.json AND knowledge/principles.json, or revert the rules edit - update will not absorb a rules change under an unchanged version (web-uplift-s52q)`
      );
      console.error(
        'If the RULES did not change and only their EVIDENCE did - an anchor re-pointed at a sentence upstream has not rewritten - re-run with --accept-rules-revision "<why the applied rules are unchanged>"; the reason is recorded in the state file so the decision is auditable rather than absorbed'
      );
      process.exit(1);
    }
    if (rulesRevisionUnderSameVersion && revisionReason.trim() === '') {
      console.error('FAIL: --accept-rules-revision needs a non-empty reason: it is recorded in knowledge/mwg-state.json as the justification for re-recording the applied-rules axis under an unchanged version (web-uplift-7bld)');
      process.exit(1);
    }
    if (rulesRevisionUnderSameVersion && !canProveEvidenceOnly) {
      console.error(
        `FAIL: refusing --accept-rules-revision. The flag may only re-record a revision in which the RULES are unchanged and only their EVIDENCE moved, and this tool cannot prove that here: state.rulesSha256=${JSON.stringify(previousRulesDigest ?? null)} computed=${JSON.stringify(rules.rulesSha256)}, state.basisSha256=${JSON.stringify(previousBasisDigest ?? null)} computed=${JSON.stringify(rules.basisSha256)}. If the rules genuinely changed - a summary, a principle, a rule added or removed - bump appliedRulesVersion deliberately in knowledge/mwg-state.json AND knowledge/mwg-rule-basis.json AND knowledge/principles.json, or revert the edit. A reason string cannot make a rules change safe (web-uplift-p71b)`
      );
      process.exit(1);
    }

    if (rulesRevisionUnderSameVersion) {
      state.lastRulesRevision = {
        at: new Date().toISOString(),
        appliedRulesVersion: rules.catalogueVersion,
        fromRuleBasisSha256: previousRulesSha,
        toRuleBasisSha256: rules.ruleBasisSha256,
        reason: revisionReason.trim(),
      };
    }
    state.appliedRulesVersion = rules.catalogueVersion;
    state.ruleBasisSha256 = rules.ruleBasisSha256;
    state.rulesSha256 = rules.rulesSha256;
    state.basisSha256 = rules.basisSha256;
    state.catalogSha256 = computed;
    state.guideIdsSha256 = ids.guideIdsSha256;
    state.guideCount = ids.guideCount;

    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.error(`FAIL: cannot write state file at ${statePath}: ${err.message}`);
      process.exit(1);
    }

    console.log(
      `OK: updated catalogSha256, guideIdsSha256, guideCount and the applied-rules axis (appliedRulesVersion ${rules.catalogueVersion}, ruleBasisSha256 ${rules.ruleBasisSha256}) in ${statePath}`
    );
    if (legacyRoute === 'backfill') {
      console.log(
        `MIGRATED: this state predated the rules/evidence digest split, and the combined ruleBasisSha256 was unchanged, so neither axis had moved. Established rulesSha256 and basisSha256 and recorded the acceptance (and its reason) as lastLegacySplitAcceptance (web-uplift-nlem)`
      );
    } else if (legacyRoute === 'version-bump') {
      console.log(
        `MIGRATED: this state predated the split and its applied-rules version moved (${state.lastLegacySplitAcceptance.fromAppliedRulesVersion} -> ${rules.catalogueVersion}), so the axis genuinely changed and the NEW version's digests are recorded. The acceptance, both versions and the reason are stored as lastLegacySplitAcceptance (web-uplift-nlem, web-uplift-6ls5)`
      );
    }
    process.exit(0);
  }
}
