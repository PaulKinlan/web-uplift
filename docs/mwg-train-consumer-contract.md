# Modern Web Guidance Versioned Artefact: mwg-train Consumer Contract

## Purpose and Scope

This document specifies the contract between `web-uplift` and downstream consumer `mwg-train` for consuming the Modern Web Guidance (MWG) catalog.

The contract establishes a deterministic, fail-closed interface with decoupled lineage tracking, eliminating runtime cross-VM dependencies while guaranteeing catalog integrity across evaluation runs.

## The Versioned Artefact

The single authoritative versioned artefact is `knowledge/mwg-state.json`.

The artefact interface consists of:
- `artifactId`: The canonical artefact identifier (`"web-uplift/mwg-catalog"`).
- `catalogSha256`: The full 64-character lowercase hex SHA-256 digest of the canonicalised catalog (`knowledge/mwg-catalog.json`).
- `canonicalisation`: The exact deterministic canonicalisation rule string:
  `"json: recursive lexicographic key sort; array order preserved; compact (no insignificant whitespace); UTF-8; sha256 hex; object keys are emitted in JS property-enumeration order (integer-like keys sort ascending numeric, not lexicographic); tests/mwg-artefact.mjs is the normative implementation; non-ASCII characters are emitted as literal UTF-8, never as \uXXXX escapes (a serialiser that escapes them computes a different digest for the same catalog - the committed catalog contains U+2014; web-uplift-rxbh)"`.
- `analysedVersion`: The upstream package version analysed during the snapshot (matching the version pinned in knowledge/principles.json).
- `appliedRulesVersion`: The upstream package version that the rules actually applied correspond to.

One artefact, one hash, one version pair: that is the complete interface.

## analysedVersion vs appliedRulesVersion

The contract explicitly distinguishes `analysedVersion` from `appliedRulesVersion`:

- `analysedVersion`: The upstream package version the catalog snapshot was extracted and analysed against (the version pinned in knowledge/principles.json).
- `appliedRulesVersion`: The upstream package version corresponding to the rules actively applied in the evaluation / uplift engine.

"Behind upstream" and "our rules are wrong" are fundamentally different states. Consumers must not collapse them into a single version number:

1. When upstream documentation or guide text changes without altering applied rules, `analysedVersion` advances. The artefact changes, generating a new SHA-256 pin that consumers record.
2. The artefact MUST change whenever applied rules change, and it also changes whenever upstream text moves without altering rules.
3. Every change to either version field or to catalog content constitutes a new pin that must be explicitly reviewed and committed.

## Consumer Behaviour for mwg-train

Downstream consumer `mwg-train` must observe the following operational constraints:

### Pinning Discipline
`mwg-train` pins `catalogSha256`, `guideIdsSha256`, `guideCount`, `analysedVersion`, `appliedRulesVersion`, and the applied-rules axis. That axis is TWO digests, not one (web-uplift-7bld, p71b): `rulesSha256` covers the rules themselves (ids, their guide and where, and the applied principles content) and `basisSha256` covers only the quoted anchors. `ruleBasisSha256` remains as the combined digest, so an existing pin keeps its meaning. The split is what makes a same-version evidence-only re-record ASSERTABLE: `update --accept-rules-revision` may re-record the axis only when the tool can prove that `rulesSha256` is unchanged and only `basisSha256` moved. `node tests/mwg-artefact.mjs verify` fails closed on a missing, mismatched or unrecorded value - web-uplift-s52q - and it now CHECKS both split digests, naming the axis that moved. The catalog snapshot and the state descriptor are committed directly in the consumer repository.

### Legacy Artefacts (recorded before the digest split)
A state recorded before `web-uplift-7bld` carries the combined digest and neither split digest, so the split cannot verify it. Such an artefact is **not** reported as verified: `verify` exits `4` with a `LEGACY-UNVERIFIED` line naming the missing digests, deliberately distinct from `1` (a mismatch or a check that could not run) so a gate can act on it. There are exactly two defined dispositions, and doing nothing is not one of them (web-uplift-nlem):

- **Migrate it deliberately**: `node tests/mwg-artefact.mjs update --accept-legacy-split "<why the recorded rules are still the intended ones>"`. This is only accepted while the combined `ruleBasisSha256` still equals the computed one, because that is the only available proof that NEITHER axis moved since the artefact was recorded; the acceptance and its reason are stored in the state as `lastLegacySplitAcceptance`. If the combined digest has moved, the flag is REFUSED - a single hash cannot say which axis moved - and the artefact has to be re-recorded through the reviewed path instead (bump `appliedRulesVersion` in the state, the rule basis and the principles together, then `update`). A plain `update` never establishes the split digests, because that would record a claim nobody verified.
- **Mark it unverified on purpose**: keep it out of the gate and say so where the pin is consumed.

### Set Identity, Not Count
A guide count is not an identity: two catalog versions can share a count while holding different guide sets (this exact defect hid the `prompt-api` divergence tracked in `web-uplift-968`). The artefact therefore carries `guideIdsSha256`, the sha256 (UTF-8, hex) of the catalog's guide ids sorted lexicographically and joined by single LF newlines with no trailing newline, alongside `guideCount`. This is deliberately the SAME construction the catalog itself declares in its own `guideIdsSha256` field: one construction, one hash; two different values must never claim to identify the same set. Consumers must compare SETS: recompute `guideIdsSha256` from the committed catalog snapshot and fail closed on any mismatch, then use the catalog's own `guides[].id` list as the set to diff against their extractor's set. Never accept a bare count match as proof of identity.

### No Live Cross-VM Coupling
There is NO live cross-VM coupling:
- No runtime cross-VM network calls.
- No shared filesystem or shared volume mounts.
- No push coordination through the hub during pipeline execution.

The artefact file and its hash are transferred solely at pin-update time through version control and committed on the consumer side. Evaluation runs in `mwg-train` rely strictly on local, committed assets.

### Fail-Closed Execution
`mwg-train` must FAIL CLOSED:
- If `catalogSha256` or `guideIdsSha256` does not match the recomputed hashes of the catalog, or `guideCount` does not match its guide array length, the pipeline STOPS immediately. It must never proceed with a warning or fallback.
- If the artefact file is missing, empty, or unparseable, the pipeline STOPS immediately.
- A blind or unverified execution is an audit failure.

This mirrors `mwg-train`'s existing pattern in `docs/eval/rules.json` (`rule_set_hash` checked with recompute-or-fail `RULE_HASH_MISMATCH` in `src/eval/prereg.mjs`). To support this catalog contract, an `uplift_artifact` block added to that structure carries:
```json
{
  "sha256": "<64-character-hex-digest>",
  "guideIdsSha256": "<64-character-hex-digest>",
  "guideCount": 0,
  "analysedVersion": "<version-string>",
  "appliedRulesVersion": "<version-string>",
  "url": "<provenance-reference-or-local-path>"
}
```

## Verification Recipe for the Consumer

To verify the catalog against the pin, the consumer executes the following canonicalisation and hashing procedure:

1. Read and parse the catalog JSON file.
2. Canonicalise the data structure recursively:
   - For primitive values (strings, numbers, booleans, null), keep value as-is.
   - For arrays, preserve element order and recursively canonicalise each element.
   - For objects, sort all own property keys lexicographically, recursively canonicalise each value, and construct the sorted key-value mapping. Note the normative refinement in the rule string: object keys are emitted in JS property-enumeration order, so integer-like keys sort ascending numeric rather than lexicographic; `tests/mwg-artefact.mjs` is the normative implementation.
3. Serialize to compact JSON without indentation or whitespace between tokens (`JSON.stringify(canon)`).
   - **String escaping is part of the rule.** Serialise with non-ASCII characters kept LITERAL: no `\uXXXX` escapes. `JSON.stringify` does this by default, but Python's `json.dumps` does NOT - it escapes non-ASCII unless you pass `ensure_ascii=False`. The committed catalog contains U+2014, so a consumer using the default escaper computes a digest that will never match the pin (web-uplift-rxbh).
4. Encode the serialized JSON string as UTF-8 bytes.
5. Compute the SHA-256 cryptographic digest of the UTF-8 bytes and format as 64 lowercase hexadecimal characters.
6. Compare the computed hex digest against the pinned `catalogSha256`.

Any mismatch between the computed hash and the pin, or any failure during reading or parsing, must immediately abort the pipeline with an error.

The reference implementation for this procedure is provided in `tests/mwg-artefact.mjs`:
```bash
# Compute canonical sha256 of the catalog
node tests/mwg-artefact.mjs compute

# Verify state file catalogSha256 against catalog (exit 4 = a pre-split artefact that cannot be
# split-verified, see 'Legacy Artefacts' above; never a silent pass)
node tests/mwg-artefact.mjs verify

# Update state file catalogSha256 from catalog
node tests/mwg-artefact.mjs update

# Record a same-version re-record whose RULE digest is provably unchanged (evidence moved only)
node tests/mwg-artefact.mjs update --accept-rules-revision "<why the applied rules are unchanged>"

# Migrate a state recorded before the two-digest split
node tests/mwg-artefact.mjs update --accept-legacy-split "<why the recorded rules are still the intended ones>"
```

## Pin Handover Process

When a new catalog version is analysed or catalog contents change:

1. The `web-uplift` lane computes the canonical hash and updates `knowledge/mwg-state.json`.
2. The `web-uplift` lane reports the new pin (artefact identifier, `catalogSha256`, `guideIdsSha256`, `guideCount`, `analysedVersion`, `appliedRulesVersion`) to `web-uplift-coord`.
3. `web-uplift-coord` relays the pin to the hub.
4. The hub coordinates and files/updates the corresponding downstream bead in `mwg-train`.
5. The `mwg-train` side bead is NOT opened directly by this repository.

## Open Divergence (web-uplift-968)

A historical extractor SET divergence existed between `web-uplift` and `mwg-train` over the `prompt-api` guide:

- Bead `web-uplift-968` records that the two extractors disagreed on guide set membership: `mwg-train`'s set contained `prompt-api`, while `web-uplift`'s USE_CASES-derived catalog omitted it.
- On the `web-uplift` side this is resolved by bead `web-uplift-ddf` (branch `fleet/mwg-catalog-fix`), which adds `prompt-api` to the catalog together with a top-level sorted `guideIds` array and the catalog's own `guideIdsSha256` declaration.
- This contract compares SETS, not counts: `guideIdsSha256` (and the sorted `guideIds` list the catalog carries) is the identity. `tests/mwg-artefact.mjs verify` cross-checks any declared `guideIds`/`guideIdsSha256`/`guideCount` in the catalog against the values derived from its `guides` array and fails closed on disagreement, so a recurrence of this defect class is loud.
- RESOLVED, and this paragraph used to claim otherwise (web-uplift-ic6a): the `web-uplift` side carries its catalog's declared guide count INCLUDING `prompt-api`, its catalog declares the sorted `guideIds`/`guideIdsSha256`/`guideCount` trio, and the pin in `knowledge/mwg-state.json` is the one those declarations derive from. A refresh is still `tests/mwg-artefact.mjs update`, and `verify` still fails closed on disagreement - so the mechanism the paragraph described is current; only its precondition was stale. No value is hardcoded to either side's count.
- Cross-extractor consensus tracking remains assigned to bead `web-uplift-968`.
