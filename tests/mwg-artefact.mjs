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
//
// Exit codes:
//    0: Success (exact match on verify, successful compute, successful update).
//    1: Failure (verify mismatch, unreadable/unparseable files, missing or invalid
//       catalogSha256/guideIdsSha256/guideCount in state). Fail-closed: never
//       exits 0 when it cannot verify.
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
  const revisionFlagAt = args.indexOf('--accept-rules-revision');
  const revisionReason = revisionFlagAt === -1 ? null : (args[revisionFlagAt + 1] ?? '');
  const commandArgs = revisionFlagAt === -1 ? args : args.filter((_, i) => i !== revisionFlagAt && i !== revisionFlagAt + 1);
  if (commandArgs.length !== 1) {
    console.error(`FAIL: expected exactly one command (compute|verify|update), got ${commandArgs.length} arguments`);
    console.error(
      'Usage:\n' +
      '  node tests/mwg-artefact.mjs compute\n' +
      '  node tests/mwg-artefact.mjs verify\n' +
      '  node tests/mwg-artefact.mjs update [--accept-rules-revision "<why the applied rules are unchanged>"]'
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

    console.log(`OK: updated catalogSha256, guideIdsSha256, guideCount and the applied-rules axis (appliedRulesVersion ${rules.catalogueVersion}, ruleBasisSha256 ${rules.ruleBasisSha256}) in ${statePath}`);
    process.exit(0);
  }
}
