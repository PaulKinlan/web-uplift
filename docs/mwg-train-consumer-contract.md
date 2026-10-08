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
  `"json: recursive lexicographic key sort; array order preserved; compact (no insignificant whitespace); UTF-8; sha256 hex"`.
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
`mwg-train` pins `catalogSha256`, `analysedVersion`, and `appliedRulesVersion`. The catalog snapshot and the state descriptor are committed directly in the consumer repository.

### No Live Cross-VM Coupling
There is NO live cross-VM coupling:
- No runtime cross-VM network calls.
- No shared filesystem or shared volume mounts.
- No push coordination through the hub during pipeline execution.

The artefact file and its hash are transferred solely at pin-update time through version control and committed on the consumer side. Evaluation runs in `mwg-train` rely strictly on local, committed assets.

### Fail-Closed Execution
`mwg-train` must FAIL CLOSED:
- If `catalogSha256` does not match the recomputed hash of the catalog, the pipeline STOPS immediately. It must never proceed with a warning or fallback.
- If the artefact file is missing, empty, or unparseable, the pipeline STOPS immediately.
- A blind or unverified execution is an audit failure.

This mirrors `mwg-train`'s existing pattern in `docs/eval/rules.json` (`rule_set_hash` checked with recompute-or-fail `RULE_HASH_MISMATCH` in `src/eval/prereg.mjs`). To support this catalog contract, an `uplift_artifact` block added to that structure carries:
```json
{
  "sha256": "<64-character-hex-digest>",
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
   - For objects, sort all own property keys lexicographically, recursively canonicalise each value, and construct the sorted key-value mapping.
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
2. The `web-uplift` lane reports the new pin (artefact identifier, `catalogSha256`, `analysedVersion`, `appliedRulesVersion`) to `web-uplift-coord`.
3. `web-uplift-coord` relays the pin to the hub.
4. The hub coordinates and files/updates the corresponding downstream bead in `mwg-train`.
5. The `mwg-train` side bead is NOT opened directly by this repository.

## Open Divergence (web-uplift-968)

An open extractor divergence exists between `web-uplift` and `mwg-train`:

- Bead `web-uplift-968` records that `mwg-train`'s guidance extractor discovers 178 guides across 16 categories, whereas `web-uplift`'s catalog extractor records 177 guides (differing on the prompt-api guide).
- This contract explicitly flags this divergence without attempting to resolve it or select a preferred count within this bead.
- Until both extractors achieve consensus, the pin in `knowledge/mwg-state.json` covers `web-uplift`'s catalog exactly as committed in this repository.
- Tracking and resolution remain assigned to bead `web-uplift-968`.
