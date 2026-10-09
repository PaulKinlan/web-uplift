# Modern Web Guidance Upstream Drift Check

## Purpose

The Modern Web Guidance (MWG) catalog forms the foundation of web-uplift's audit principles and guidance pointers. The upstream package (`modern-web-guidance`) publishes updates periodically on npm.

The drift check (`tests/mwg-drift-check.mjs`) is a lightweight, recurring, dependency-free check that detects when the upstream npm package moves relative to the version analysed in-repo. It operates with a distinct exit code contract so automated runners only trigger expensive full catalog reanalysis when a real version delta exists, while failing loudly if the check itself cannot run.

## State File Schema (`knowledge/mwg-state.json`)

The state file tracks both the last in-depth analysis and recurring upstream checks:

- `$comment` (string): Description of the state file role and coordination rules.
- `artifactId` (string): Stable artefact name, `web-uplift/mwg-catalog`.
- `catalogSha256` (string): Full 64-character sha256 of the canonicalised catalog (see `canonicalisation`).
- `guideIdsSha256` (string): sha256 (UTF-8, hex) of the catalog's guide ids sorted lexicographically and joined by single LF newlines, no trailing newline (the same construction as the catalog's own `guideIdsSha256` declaration). Set identity: a count alone is not an identity, so consumers compare sets via this hash plus the catalog's guide list. When the catalog declares its own `guideIds`, `guideIdsSha256`, or `guideCount`, `tests/mwg-artefact.mjs verify` cross-checks the declarations against the values derived from the catalog's `guides` array and fails closed on disagreement.
- `guideCount` (integer): Number of guides in the catalog. Derived from `knowledge/mwg-catalog.json`, never hardcoded.
- `canonicalisation` (string): The exact canonicalisation rule the hashes are computed with.
- `appliedRulesVersion` (string): The upstream version the APPLIED rules correspond to. Kept distinct from `analysedVersion` (see `docs/mwg-train-consumer-contract.md`).
- `analysedVersion` (string): Semantic version of `modern-web-guidance` from the last full catalog reanalysis. Must match `version` in `knowledge/mwg-catalog.json` and the version pinned in `knowledge/principles.json`.
- `analysedAt` (string, ISO 8601): Timestamp of the last full reanalysis. Must match `retrievedAt` in `knowledge/mwg-catalog.json`.
- `lastCheckAt` (string or null, ISO 8601): Timestamp of the most recent drift check execution that ran with `--write`. Null before the first check run.
- `lastCheckUpstreamVersion` (string or null): Upstream version observed during the most recent check run.
- `lastCheckSource` (string or null): URL or file path queried during the last check run (for example, the npm registry URL or a local fixture path).
- `lastCheckResult` (string): Outcome of the last check run. One of `"never-run"`, `"in-sync"`, or `"delta"`.

Note: the artefact fields (`artifactId`, `catalogSha256`, `guideIdsSha256`, `guideCount`, `canonicalisation`, `appliedRulesVersion`) landed in web-uplift-vbv; the three derived values (`catalogSha256`, `guideIdsSha256`, `guideCount`) are refreshed by `tests/mwg-artefact.mjs update` at reanalysis time.

## Exit Code Contract

`tests/mwg-drift-check.mjs` returns the following status codes:

- `0`: In sync (upstream version matches `analysedVersion`), or (in `--freshness-only` mode) the recorded heartbeat is fresh.
- `1`: Check failure (loud sabotage/absence signal). The check itself could not run or sanity checks failed: state file missing/unparseable, catalog missing/unparseable, state `analysedVersion` does not match catalog `version`, upstream registry unreachable or timed out, or upstream payload empty/unparseable/missing a semver string. A blind check must never exit 0.
- `2`: Version delta detected (upstream version differs from `analysedVersion`). Output indicates whether upstream is newer or older. This exit code serves as the signal to trigger full reanalysis.
- `3`: Freshness guard failed (`--freshness-only` mode only): `lastCheckAt` is missing, null, unparseable, implausibly future-dated, or older than `--max-age`. A never-run state counts as stale.
- `64`: Usage error (unrecognized CLI flags or invalid duration formats).

## The Trigger: Delta-Gated, Not Clock-Driven

Full reanalysis is triggered strictly by a version delta (exit code 2), never by the passage of time alone. Catalog regeneration and principles coverage re-verification involve extensive review; running them on a pure clock schedule when upstream has not moved produces redundant work and noise.

The clock exists to bound latency: running the cheap check on a schedule guarantees that when an upstream release occurs, the delta is detected within hours rather than waiting for an audit failure.

## Schedule Decision and Justification

The automated check runs via GitHub Actions (`.github/workflows/mwg-drift.yml`):
- Check schedule: every 6 hours (`23 */6 * * *`, offset minute).
- Freshness heartbeat check: runs on the same 6-hour schedule, after the check job, asserting `lastCheckAt` is no older than 30h (`--freshness-only --max-age 30h`).

Justification:
- Dependency-free: Node builtins only, running in seconds with no `npm ci` overhead.
- Foreign-host: Evaluated outside local machines on public infrastructure.
- High visibility: Commits state updates directly and files trackable GitHub issues on deltas or check failures.

Documented limitation: GitHub Actions automatically disables scheduled workflows for repositories with no commit activity for 60 consecutive days. Therefore, in-repo CI freshness checks can become inactive if the repository is quiet. A fleet-level VM systemd timer has been recommended as the authoritative absence guard and escalated to the hub via `web-uplift-coord`.

## Total-Absence Guard Design

A recurring monitor must never fail silently. The total-absence guard uses a two-layer defense:

1. Loud failure on blind checks (Exit code 1): If network requests fail, registry responses are malformed, or the state file drifts from `knowledge/mwg-catalog.json`, the script immediately exits 1 without updating `lastCheckAt`. A failing check never appears fresh.
2. Heartbeat persistence and freshness verification (Exit code 3): When running with `--write`, successful checks (exit codes 0 and 2) write `lastCheckAt = now` to `knowledge/mwg-state.json`, which CI commits back to the repository. The companion freshness job inspects `lastCheckAt`. Its detection scope is precise: because the freshness job runs after the check job in the same workflow (`needs: check`), it catches a heartbeat that stops advancing while the check itself keeps succeeding (for example `--write` being dropped from the check invocation, or a hand-edited or future-dated timestamp). A failed state COMMIT fails the check job instead, alerting through the red run (for delta or check-failure exits the issue steps run with `always()`, so a persistence failure cannot suppress those issues; an in-sync persistence failure produces the red run only), with freshness skipped by the dependency. A wholly dead schedule (GitHub disabling the cron after ~60 days of repo inactivity) is exactly what CI cannot self-detect, which is why the VM-level timer is the authoritative absence guard.

## Responding to an Upstream Delta

When exit code 2 fires (or an issue titled "MWG upstream moved: reanalysis needed" is created), the assigned lane performs the following procedure:

1. Regenerate catalog: Run the committed generator (`node tests/mwg-catalog.mjs --package-dir <unpacked package> --version <x.y.z> --out knowledge/mwg-catalog.json`) to extract the new guidance taxonomy and update `knowledge/mwg-catalog.json`. The recipe it replaces (`eval` of the package's `USE_CASES` table) is gone: the generator parses that table as data and refuses anything that is not a literal, because the package is downloaded code (web-uplift-w0y). See "How to Regenerate" in `knowledge/mwg-catalog.md`.
2. Re-verify principles coverage: Check `docs/principles-analysis.md` and `knowledge/principles.json` against the updated catalog (ensure all new or changed guides are mapped to principles and retired guides are reconciled).
3. Update state file: Bump `analysedVersion` and `analysedAt` in `knowledge/mwg-state.json` to match the newly regenerated `knowledge/mwg-catalog.json`, then run `node tests/mwg-artefact.mjs update` to refresh `catalogSha256`, `guideIdsSha256` and `guideCount`.
4. Run regression suite: Verify all guards pass and commit the reanalysed baseline.

Reanalysis is agentic and bead-triggered, never run by CI: the scheduled workflow only DETECTS the delta and files the issue; a coordinator turns that into a bead and a lane performs the reanalysis.

## Relationship to Sibling Beads

- `web-uplift-0o6`: Implements the delta classifier (categorizing changes as NEW, CHANGED, or REVERSED guides) and consumes the trigger from this check.
- `web-uplift-vbv`: The artefact fields (hash, canonicalisation, appliedRulesVersion) have landed in `knowledge/mwg-state.json` and the contract lives in `docs/mwg-train-consumer-contract.md`.
- `web-uplift-6ov`: Extends the fixture catalog with reversal and positive-control fixtures used to test the delta classifier.

## Delta Classification (NEW / CHANGED / REVERSED)

When an upstream version delta is detected, `tests/mwg-drift-classify.mjs` categorizes differences into three deterministic classes:

- **REVERSED**: An implemented rule's textual basis was modified or removed upstream. Because the implemented rule may now be incorrect or actively generating improper repairs, this class is reported first and loudest. Severity is determined by class, not guide count.
- **CHANGED**: Upstream guide text moved, but all verbatim anchors for implemented rules remain intact, or an unregistered guide was modified or withdrawn.
- **NEW**: A new guide ID was introduced upstream that was not present in the baseline.

### Corpus Format and Reconstructability

Corpora act as the normalized intermediate representation:

```json
{
  "version": "x.y.z",
  "guides": {
    "<id>": "<full guide text>"
  }
}
```

Because published npm packages are immutable, both baseline and upstream corpora can be reconstructed deterministically at any time:

1. Download and unpack the immutable npm package tarball:
   ```sh
   npm pack modern-web-guidance@<version>
   tar -xzf modern-web-guidance-<version>.tgz
   ```
2. Extract the normalized corpus JSON:
   ```sh
   node tests/mwg-drift-classify.mjs --extract package --version <version> -o corpus-<version>.json
   ```
   Extraction parses the package's USE_CASES table declaratively (never evaluates package code) and UNIONs it with a scan of the package's guides directories, so a guide file that lacks a table entry (the prompt-api defect class, web-uplift-968) is still included. Extraction of 0.0.193 yields the same 178-id set as knowledge/mwg-catalog.json, but the divergence is now EXPLICIT rather than implicit: the corpus JSON carries a per-guide `provenance` map (`use_cases` when the table located the guide, `scan` when only the disk scan found it), and `--extract` prints the split to stderr. For the current upstream version that split is 177 via USE_CASES plus 1 via scan only (`prompt-api`), totalling 178. Extraction fails loud (exit 1) when no guide text is found at all.

### Anchor-Based Reversal Rule

Reversal detection is deterministic and anchor-based:

`knowledge/mwg-rule-basis.json` stores verbatim anchor excerpts from the analyzed guide text that each implemented rule relies on. When guide text moves:

- If every anchor of every implemented rule for that guide remains present as a verbatim substring in the new text, the delta is classified as **CHANGED** (the rule's verbatim anchor basis is intact; substring presence is a floor, and a human still reads the changed text during the reanalysis).
- If any anchor is missing, the delta is classified as **REVERSED**. The output explicitly identifies the affected rule IDs and lists the missing anchor substrings.

### Withdrawn Guide Rule

When a guide ID exists in the baseline corpus but is absent in the upstream corpus:

- If the basis registry has any implemented rule referencing that guide, the delta is classified as **REVERSED** (reason: withdrawn while implemented rules depend on it).
- If no implemented rules reference it, the delta is classified as **CHANGED** (reason: withdrawn, no implemented rules).

### Empty Corpus Refusal (Sabotage Guard)

If the new corpus has an empty `guides` object while the baseline corpus is non-empty, the classifier refuses to diff against nothing. It fails loudly with exit code 1. A blind or empty upstream unpack must never be interpreted as "all guides withdrawn".

### Classifier Exit Codes

`tests/mwg-drift-classify.mjs` enforces the following exit codes:

- `0`: No delta detected between old and new corpora, or successful `--verify-basis` / `--extract` execution.
- `1`: Classifier is blind or inputs are invalid: missing or unparseable files, invalid corpus schema, invalid semver strings, empty target corpus against non-empty baseline, zero guides extracted, or failed basis verification.
- `2`: Version delta detected and classified (one or more REVERSED, CHANGED, or NEW guides).
- `64`: Usage error (unknown flags, missing arguments, or incompatible mode options).

### Maintaining the Rule Basis Registry

The reanalysis lane maintains `knowledge/mwg-rule-basis.json` to keep reversal detection accurate:

1. Whenever guidance is distilled into `knowledge/principles.json` check summaries or asserted in `tests/regression.mjs`, identify the source guide ID.
2. Select 1 to 3 verbatim anchor excerpts from the guide text that back the implemented rule.
3. Append the rule entry to `knowledge/mwg-rule-basis.json` (`id`, `guide`, `where`, and `anchors`).
4. Run `--verify-basis` against the baseline corpus AND the committed catalog to confirm all anchors exist verbatim, every registered guide id exists in the catalog's guide set, and the registry's `catalogueVersion` matches both the corpus and the catalog version:
   ```sh
   node tests/mwg-drift-classify.mjs --verify-basis corpus-<version>.json --catalog knowledge/mwg-catalog.json
   ```
   The registry is bound to one catalog version: classifying or verifying with a registry whose `catalogueVersion` differs from the baseline corpus version fails loud (exit 1), so a stale registry can never silently disable reversal detection. On a version bump, set `catalogueVersion` to the new catalog version as part of the reanalysis commit.

