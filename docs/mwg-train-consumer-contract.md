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
  `"json: recursive lexicographic key sort; array order preserved; compact (no insignificant whitespace); UTF-8; sha256 hex; object keys are emitted in JS property-enumeration order (integer-like keys sort ascending numeric, not lexicographic); tests/mwg-artefact.mjs is the normative implementation"`.
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
`mwg-train` pins `catalogSha256`, `guideIdsSha256`, `guideCount`, `analysedVersion`, and `appliedRulesVersion`. The catalog snapshot and the state descriptor are committed directly in the consumer repository.

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
4. Encode the serialized JSON string as UTF-8 bytes.
5. Compute the SHA-256 cryptographic digest of the UTF-8 bytes and format as 64 lowercase hexadecimal characters.
6. Compare the computed hex digest against the pinned `catalogSha256`.

Any mismatch between the computed hash and the pin, or any failure during reading or parsing, must immediately abort the pipeline with an error.

The reference implementation for this procedure is provided in `tests/mwg-artefact.mjs`:
```bash
# Compute canonical sha256 of the catalog
node tests/mwg-artefact.mjs compute

# Verify state file catalogSha256 against catalog
node tests/mwg-artefact.mjs verify

# Update state file catalogSha256 from catalog
node tests/mwg-artefact.mjs update
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
- Until `web-uplift-ddf` lands, the pin in `knowledge/mwg-state.json` covers `web-uplift`'s catalog exactly as committed in this repository; when it lands, `tests/mwg-artefact.mjs update` refreshes the pin. No value is hardcoded to either side's count.
- Cross-extractor consensus tracking remains assigned to bead `web-uplift-968`.
