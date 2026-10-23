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
- `lastCheckResult` (string): Outcome of the last check run. One of `"never-run"`, `"in-sync"`, `"delta"`, or `"anchor-broken"` (the registry no longer verifies against the upstream guide text; its own condition, exit `4`).
- `lastAnchorCheck` (object, written with `--write`): `upstreamVersion`, `result` (`"ok"` or `"anchor-broken"`), `rules`, `anchors`, `checkedAt` and the `source` of the guide text. It records that the anchors were actually read against that release, so "the versions match" and "the basis was checked" are separate facts in the state.
- `lastAnalysis` (object): What the last full reanalysis FOUND, not just when it ran (`web-uplift-b1p5`). `fromVersion` and `toVersion` name the releases the analysis crossed (and `toVersion` must equal `analysedVersion`), `analysedAt` is when the analysis completed, `catalogDelta` records the guide additions and removals with arithmetic that has to land on `guideCount` and ids that have to exist in the catalog, `guideTextChanges` records how many EXISTING guide bodies changed between the two releases, and `pins` records what the analysis did to the rule basis and the principles. `tests/mwg-principles.test.mjs` case 12 requires the record and checks it against the committed catalog, so a version bump with no analysis behind it fails the suite instead of reading as `in-sync`. The distinction matters because a version comparison cannot see a text change: 0.0.194 added 9 guides and ALSO rewrote 31 existing guide bodies, one of which our rule basis quoted.

Note: the artefact fields (`artifactId`, `catalogSha256`, `guideIdsSha256`, `guideCount`, `canonicalisation`, `appliedRulesVersion`) landed in web-uplift-vbv; the three derived values (`catalogSha256`, `guideIdsSha256`, `guideCount`) are refreshed by `tests/mwg-artefact.mjs update` at reanalysis time.

## Exit Code Contract

`tests/mwg-drift-check.mjs` returns the following status codes:

- `0`: In sync (upstream version matches `analysedVersion`) **and** every rule-basis anchor is still verbatim in that upstream release, or (in `--freshness-only` mode) the recorded heartbeat is fresh and the last check did not record a broken anchor. A version match alone is no longer sufficient (web-uplift-m9o3): see the anchor verification below.
- `1`: Check failure (loud sabotage/absence signal). The check itself could not run or sanity checks failed: state file missing/unparseable, catalog missing/unparseable, state `analysedVersion` does not match catalog `version`, upstream registry unreachable or timed out, upstream payload empty/unparseable/missing a semver string, or the guide text under test is not bound to the release this run resolved (`corpus-version-mismatch`: a `MWG_DRIFT_UPSTREAM_CORPUS` labelled with another version, a corpus with no version identity, or a tarball whose own `package.json` names a different version than the registry document did). A blind check must never exit 0, and evidence from another release is not evidence about this one.
- `2`: Version delta detected (upstream version differs from `analysedVersion`). Output indicates whether upstream is newer or older. This exit code serves as the signal to trigger full reanalysis.
- `3`: Freshness guard failed (`--freshness-only` mode only): `lastCheckAt` is missing, null, unparseable, implausibly future-dated, or older than `--max-age`. A never-run state has no heartbeat, so it counts as stale. Also reported in two further cases, which are deliberately NOT the same. A detected delta that nobody actioned: the recorded upstream version differs from `analysedVersion` (or a delta is recorded with no usable upstream version at all) and `analysedAt` is unreadable, implausibly future-dated, or older than `--max-age` - there the age that matters is the analysis's, so a fresh heartbeat cannot rescue it. And a claim that cannot be substantiated: the state says `in-sync` while the two versions cannot be shown to agree, which is REJECTED OUTRIGHT and never age-gated, because a corrupt or hand-edited claim is not a recently-detected change and a fresh `analysedAt` must not buy it a grace window.
- `4`: **Anchor-broken** (its own condition, deliberately not folded into 1, 2 or 3). The check ran, the versions may even agree, and the rule basis (`knowledge/mwg-rule-basis.json`) no longer verifies against the upstream guide text: a registered guide is absent, a rule declares no usable anchors (empty or missing `anchors`, or an anchor that is empty or not a string), or one of its verbatim anchors is gone. The output names the rule, the guide and the anchor, and `--write` records `lastCheckResult: "anchor-broken"` plus a `lastAnchorCheck` block. In `--freshness-only` mode the same condition exits 4 with an `ANCHOR-BROKEN` line and never as `STALE`, because the repair is re-anchoring the registry, not refreshing a heartbeat or reanalysing a version.
- `64`: Usage error (unrecognized CLI flags or invalid duration formats).

## Anchor Verification (Every Run)

Comparing versions cannot see a release that rewrites guide bodies without moving any version this repository tracks, and that is not hypothetical: `0.0.194` rewrote 31 existing guide bodies, one of which our rule basis quoted, so the check reported `in-sync` for three days while the registry no longer verified against upstream (`web-uplift-m9o3`). Every run therefore:

1. reads the rule basis from `MWG_DRIFT_BASIS` (default `knowledge/mwg-rule-basis.json`) and fails closed if it declares no rules, or if any rule declares no usable anchors (an empty or absent `anchors` list, or an anchor that is empty or not a string). A rule that cannot fail is not a rule: before this, `anchors: []` was satisfied vacuously and the check printed `IN-SYNC ... all 0 rule-basis anchor(s) across 1 rule(s)` and exited `0` (`web-uplift-m4ae`), and a missing `anchors` key threw an internal `TypeError` rather than naming the defect;
2. obtains the guide text of the SAME upstream version it resolved - by downloading that version's published tarball and extracting only `skills/modern-web-guidance/guides` (the multi-megabyte model shards are never written), or from `MWG_DRIFT_UPSTREAM_CORPUS` when a corpus file is supplied. The text is BOUND to the resolved version before it is used as evidence (`web-uplift-kapa`): a corpus must declare a usable `version` and it must equal the version this run resolved, and a downloaded tarball's own `package/package.json` must name the version the registry document claimed. A mismatch, or a corpus with no version identity, fails closed with exit `1` and the condition named `corpus-version-mismatch`; it is never `IN-SYNC`, it is deliberately not folded into `anchor-broken` (re-anchoring the registry would be the wrong repair for evidence from the wrong release), and it writes no state, because a run that could not bind its evidence did not produce a result. Before this, `corpus.version` was parsed and discarded: a corpus labelled `0.0.192` paired with upstream `0.0.193` reported `IN-SYNC` with every anchor "verified" against another release's text, and the shipped `corpus-old.json` (`1.0.0`) passed the same way;
3. requires every anchor in every rule to be verbatim present in its guide, using the same implementation the classifier uses (`tests/mwg-basis.mjs`), so the two can never disagree about whether an anchor resolves;
4. reports `anchor-broken` (exit `4`) as its own result when any anchor does not resolve, or when a rule declares no usable anchor to resolve against.

Fixture mode (`MWG_DRIFT_UPSTREAM_FILE`) must supply `MWG_DRIFT_UPSTREAM_CORPUS`; without guide text the check FAILS rather than skipping the verification, because a check that runs only when an optional input is present is the false green `web-uplift-70im` removed.

The workflow gives this condition its own voice (web-uplift-6f8x). `.github/workflows/mwg-drift.yml`:

- **persists the state on exit `4` as well as `0`/`2`**, so `lastCheckAt` keeps advancing and the freshness job cannot age a known condition into a stale-heartbeat alert. A broken anchor is work to do (re-anchoring), tracked by its own issue, not a reason to stop recording that the check ran.
- **files an issue titled from the condition itself**, e.g. `MWG rule-basis anchor broken: defensive-browser-policies-trusted-types (guide trusted-types)`, with the stable tag `MWG rule-basis anchor broken` used for dedupe. The subject is derived by `tests/mwg-drift-anchor-subject.mjs` from the guard's own `ANCHOR-BROKEN` wording, parsed field by field, so a fixture can drive the classification and no title can be invented from a message the guard did not print.
- **treats exit `4` as work to do rather than a guard failure**, like the delta outcome: the check job passes so the freshness job (`needs: check`) still runs against the state this job just persisted, the issue carries the alert, and the freshness job then fails its own status because the recorded condition is still anchor-broken - so the overall run stays RED while the heartbeat advances honestly and the alert has its own subject. Exit `1` (the guard could not run) keeps the check job itself red.
- **classifies the anchor condition FIRST in the freshness job**, before every `STALE` branch, so an anchor problem can never be read out as a stale heartbeat or an unactioned delta. There are two `ANCHOR-BROKEN` shapes and both are matched anchored end to end: the check pass lists a problem count, and the freshness pass repeats the recorded condition without one.

## The Trigger: Delta-Gated, Not Clock-Driven

Full reanalysis is triggered strictly by a version delta (exit code 2), never by the passage of time alone. Catalog regeneration and principles coverage re-verification involve extensive review; running them on a pure clock schedule when upstream has not moved produces redundant work and noise.

The clock exists to bound latency: running the cheap check on a schedule guarantees that when an upstream release occurs, the delta is detected within hours rather than waiting for an audit failure.

## Schedule Decision and Justification

The automated check runs via GitHub Actions (`.github/workflows/mwg-drift.yml`):
- Check schedule: every 6 hours (`23 */6 * * *`, offset minute).
- Freshness heartbeat check: runs on the same 6-hour schedule, after the check job, asserting `lastCheckAt` is no older than 30h (`--freshness-only --max-age 30h`). It additionally ages `analysedAt` for a recorded delta: when `lastCheckUpstreamVersion` differs from `analysedVersion`, or a delta is recorded with no usable upstream version (missing, empty or not a string), the age that matters is the ANALYSIS's rather than the heartbeat's, so re-running the check cannot refresh a delta nobody has actioned. A delta younger than `--max-age` is still fresh, and the `FRESH` line says so explicitly rather than reporting freshness with no qualification. A state claiming `in-sync` that cannot be shown to agree is handled differently: it is rejected outright, with no aging and no grace period, because a fresh `analysedAt` does not make an unsubstantiated claim current.

Justification:
- Dependency-free: Node builtins only, running in seconds with no `npm ci` overhead.
- Foreign-host: Evaluated outside local machines on public infrastructure.
- High visibility: Commits state updates directly and files trackable GitHub issues on deltas or check failures.

Documented limitation: GitHub Actions automatically disables scheduled workflows for repositories with no commit activity for 60 consecutive days. Therefore, in-repo CI freshness checks can become inactive if the repository is quiet. A fleet-level VM systemd timer has been recommended as the authoritative absence guard and escalated to the hub via `web-uplift-coord`.

## Total-Absence Guard Design

A recurring monitor must never fail silently. The total-absence guard uses a two-layer defense:

1. Loud failure on blind checks (Exit code 1): If network requests fail, registry responses are malformed, or the state file drifts from `knowledge/mwg-catalog.json`, the script immediately exits 1 without updating `lastCheckAt`. A failing check never appears fresh.
2. Heartbeat persistence and freshness verification (Exit code 3): When running with `--write`, successful checks (exit codes 0 and 2) write `lastCheckAt = now` to `knowledge/mwg-state.json`, which CI commits back to the repository. The companion freshness job inspects `lastCheckAt`, and it also inspects the state's own record of a detected delta. Its detection scope is precise, and covers two distinct states. Because the freshness job runs after the check job in the same workflow (`needs: check`), it catches a heartbeat that stops advancing while the check itself keeps succeeding (for example `--write` being dropped from the check invocation, or a hand-edited or future-dated timestamp). And because `--write` advances `lastCheckAt` for the delta outcome as well as the in-sync one, it separately ages `analysedAt` for a recorded delta whose versions disagree, or for a recorded delta with no usable upstream version, so a delta that was DETECTED but never ACTIONED can no longer keep its own freshness green by being re-detected every six hours; and it rejects outright a state claiming `in-sync` without being able to show agreement, which is a different repair for a different fault - an unsubstantiable claim is corrupt rather than merely stale, so a fresh `analysedAt` does not make it current (web-uplift-yh6o). The heartbeat's meaning for an in-sync state is deliberately unchanged: there it is still `lastCheckAt` alone, and an old analysis with no detected delta is not treated as stale. The residual this does not close is the state file's own honesty, in two shapes that are worth stating exactly rather than generally. A state edited to claim `lastCheckUpstreamVersion` equals `analysedVersion` reads as fresh, whatever `lastCheckResult` says.

Only two shapes reach `lastCheckAt` alone. Either the two versions agree, whatever the result flag; or the result flag is `never-run` or an unrecognised value AND the state records no usable upstream version to compare against, so it asserts no check outcome at all. That second shape - `never-run` with a missing upstream version, judged on a fresh heartbeat - is deliberately left FRESH rather than rejected, because it is the shape the existing freshness case asserts and rejecting it would be a behaviour change rather than a fail-closed fix.

The boundary matters and is easy to misstate: a `never-run` or unrecognised flag does NOT escape the age rule when it carries a NONEMPTY upstream version that differs from `analysedVersion`. The flag then says no check ran while the versions say otherwise, the versions are what the age rule reads, and such a state is aged from `analysedAt` exactly like a delta - a fresh heartbeat does not rescue it. Both of these residuals are hand-edits rather than conditions the check itself can produce, both are the same class the future-dated guards can only partly cover, and they are why the loud exit-1 blind-check signal and the VM-level absence timer remain the outer layers. A failed state COMMIT fails the check job instead, alerting through the red run (for delta or check-failure exits the issue steps run with `always()`, so a persistence failure cannot suppress those issues; an in-sync persistence failure produces the red run only), with freshness skipped by the dependency. A wholly dead schedule (GitHub disabling the cron after ~60 days of repo inactivity) is exactly what CI cannot self-detect, which is why the VM-level timer is the authoritative absence guard.

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
- `64`: Usage error (unknown flags, missing arguments, or incompatible mode options). An OMITTED `--catalog` with `--verify-basis` is one of these, not a skipped check: without the catalog the registry cannot be verified against its guide set, and the run used to answer `OK: basis verified` anyway (web-uplift-70im).

### Maintaining the Rule Basis Registry

The reanalysis lane maintains `knowledge/mwg-rule-basis.json` to keep reversal detection accurate:

1. Whenever guidance is distilled into `knowledge/principles.json` check summaries or asserted in `tests/regression.mjs`, identify the source guide ID.
2. Select 1 to 3 verbatim anchor excerpts from the guide text that back the implemented rule.
3. Append the rule entry to `knowledge/mwg-rule-basis.json` (`id`, `guide`, `where`, and `anchors`).
4. Run `--verify-basis` against the baseline corpus AND the committed catalog to confirm all anchors exist verbatim, every registered guide id exists in the catalog's guide set, and the registry's `catalogueVersion` matches both the corpus and the catalog version:
   ```sh
   node tests/mwg-drift-classify.mjs --verify-basis corpus-<version>.json --catalog knowledge/mwg-catalog.json
   ```
   `--catalog` is required, not optional: it is the input the registry-vs-catalog comparison needs, so leaving it out is a usage error (exit 64) rather than a verification that silently skips that half of the check.
   The registry is bound to one catalog version: classifying or verifying with a registry whose `catalogueVersion` differs from the baseline corpus version fails loud (exit 1), and so does a registry that declares no rules at all, so a stale or empty registry can never silently disable reversal detection. On a version bump, set `catalogueVersion` to the new catalog version as part of the reanalysis commit.

