# ADR 0001: Decomposition of Monolithic Evidence and Test Architecture

- **Status**: Accepted (in implementation)
- **Date**: 2026-10-10
- **Authors**: web-uplift fleet architecture & implementation lanes
- **Deciders**: `web-uplift-arch-1`, `web-uplift-arch-tests`, `web-uplift-coord`, `web-uplift-factory`
- **Related Beads**: `web-uplift-n93i`, `web-uplift-eezy`, `web-uplift-ypds`, `web-uplift-6ha1`, `web-uplift-zeu4`, `web-uplift-diaq`, `web-uplift-hhft`, `web-uplift-d2xu`, `web-uplift-e49w`

---

## Context

The `web-uplift` project operates with multiple autonomous agent lanes working concurrently on feature implementation, vulnerability remediation, performance optimization, and reviews. 

As the codebase evolved, three structural bottlenecks emerged that constrained developer and fleet throughput on 2-vCPU virtual machines:

1. **The Evidence Monolith (`evidence/cli.mjs`)**:
   `evidence/cli.mjs` expanded to 4,285 lines (195 KB), housing 20 distinct Chrome DevTools Protocol (CDP) evidence primitives (screenshot, video, heap, layout, dom, evaluate, axe, trace, har, discoverability, secrets, headers, cookies, trackers, images, console, targets, features, resilience, a11ytree), shared networking utilities, credential redaction, and CLI argument parsing. It was modified 38 times in a single 30-day period, becoming a frequent collision point for parallel lanes.

2. **The Test Monolith and Gate Starvation (`tests/regression.mjs`)**:
   `tests/regression.mjs` grew into an 8,392-line monolith (measured 2026-10-10, previously ~8,177 lines) containing over 115 tests, cited in review findings as touched by over half of all weekly commits (`web-uplift-n93i`). The file lacked a filterable CLI entrypoint, and `package.json` provided only `npm test` running the entire monolithic suite. Because full test execution requires 4 to 18 minutes of browser and CDP automation, implementers running the full suite queued behind the merger lane in the VM's single heavy job slot (`fleet-heavy`), reducing fleet landing throughput to roughly one change per hour.

3. **Duplicated Vendored Trees (`.web-uplift/`)**:
   The repository committed a full copy of all evidence, runner, schema, knowledge, and aggregate files under `.web-uplift/` so that per-project agent sessions could execute `.web-uplift/evidence/cli.mjs` directly. Because these copies were tracked in git but not automatically synchronized, changes made to source files were frequently omitted from the vendored mirror (and vice versa), shipping stale code and causing duplicate merge conflicts (`web-uplift-6ha1`).

---

## Decisions

To eliminate these bottlenecks while strictly preserving all CLI surfaces, public API contracts, and security boundaries, we adopted a five-part architectural decomposition:

### 1. Evidence CLI Modularization (`web-uplift-ypds`)
*Status: In review / queued*
- Extract each of the 20 evidence primitives into its own self-contained module under `evidence/primitives/<primitive>.mjs`.
- Separate cross-cutting helper logic into dedicated modules under `evidence/`:
  - `evidence/common.mjs`: Network emulation profiles, conditions application, formatting, artifact naming, base64 decoding, and stdout emission.
  - `evidence/redaction.mjs`: Credential terms, URL/query-string redaction, structured JSON value replacement, and body pattern matching.
  - `evidence/fetch.mjs`: Server-Side Request Forgery (SSRF) safe fetch (`safeFetch`), DNS rebinding protection, streaming body cap, and fetch deadlines.
  - `evidence/html-text.mjs`: Pure HTML parsing, content token extraction, and host/cookie relationship checkers.
- Retain `evidence/cli.mjs` as a thin CLI argument dispatcher and public API barrel re-exporting all 23 historical functions. Existing external callers (`index.mjs`, `fixer/fix.mjs`, `runner/run-batch.mjs`, tests) require zero modifications.

### 2. Multi-Tier Fast Gate and Dependency Mapping (`web-uplift-eezy`)
*Status: Landed on master*
- Implement `scripts/test-fast.mjs` backing `CHECK_FAST_CMD='npm run test:fast'` in `~/.fleet/check.conf`.
- Inspect git status and diffs against `origin/master` (`mapFilesToTests`) to determine changed files and map them to affected subsystem targets (e.g. runner, flow, safe-fetch, evidence, schema, mwg).
- Add `--only <name>`, `--filter <regex>`, and `--list` flags to `tests/regression.mjs` backed by an authoritative `ALL_TESTS` array.
- Enforce the fleet operational rule: implementers run `fleet-check --fast` (completing in 10 to 30 seconds for typical changes), while the full regression suite runs once per landing on the merger's integrated tree.

### 3. Native Test Runner Adoption (`web-uplift-hhft` & `web-uplift-d2xu`)
*Status: Planned / queued*
- Migrate test suites from hand-rolled `assert(cond, msg)` loops to Node.js native test runner (`node:test` and `node:assert/strict`).
- Enforce strict concurrency controls:
  - Heavy browser and CDP tests (which launch Chromium instances or connect to loopback debug ports) execute with `concurrency: 1` to prevent port collisions and RAM starvation on 2-vCPU VMs.
  - Pure unit tests (schema validation, redaction logic, URL parsing, syntax checks) execute concurrently.
- Replace custom argument parsing with native `node --test --test-name-pattern=<pattern>` filtering and leverage per-test timeout options.

### 4. Modular Suite Partitioning (`web-uplift-e49w`)
*Status: Planned / queued*
- Decompose the 115 tests in `tests/regression.mjs` into 7 thematic suite files under `tests/*.test.mjs`:
  1. `tests/evidence.test.mjs` (CDP evidence primitives, conditions, await census)
  2. `tests/redaction.test.mjs` (HAR redaction, credential terms, inlined source tree scrubbing)
  3. `tests/chrome-cdp.test.mjs` (Chrome candidate discovery, sandbox policy, launch retry, endpoint exposure)
  4. `tests/mwg-principles.test.mjs` (Modern Web Guidance, principles specs, drift detection)
  5. `tests/install-package.test.mjs` (Install surfaces, relative import resolution, update checks, sync guards)
  6. `tests/runner-agents.test.mjs` (Batch runner, agent allowlists, skill contracts, write-scope boundaries)
  7. `tests/syntax-core.test.mjs` (Repository-wide syntax checks, schema conformance, side-effect checks)
- Maintain `tests/regression.mjs` as an aggregator that executes all suites during the transition, ensuring `npm test` remains fully functional at every intermediate commit.

### 5. Vendored Surface Lifecycle and Generation (`web-uplift-zeu4` & `web-uplift-diaq`)
*Status: Planned / queued (sequenced behind ypds)*
- Remove `.web-uplift/` from git tracking and add `/.web-uplift/` to `.gitignore`.
- Add `"prepare": "node install-surface.mjs"` to `package.json` scripts so that `.web-uplift/` is generated automatically upon `npm install` or `npm pack`.
- Update `AGENTS.md` and `RELEASING.md` checklists as part of `web-uplift-diaq` to replace manual file mirroring instructions with the automated `prepare` lifecycle.
- Retain `tests/cdp-copy-sync.mjs` as an automated gate to verify that generated on-disk vendored copies remain 100% byte-identical to their canonical source files.

---

## Consequences

### Positive
- **Drastically Reduced Merge Conflicts**: Parallel implementers modifying different evidence primitives or test suites touch distinct files, eliminating the single largest source of merge aborts.
- **Fast Developer Feedback**: Fast gate execution drops from 15-25 minutes to 10-30 seconds, allowing implementers to verify changes locally without monopolizing the merger's heavy slot.
- **Improved Code Maintainability**: Primitives and test clusters have clear, isolated boundaries and explicit dependencies.
- **Safe Single Source of Truth**: Removing `.web-uplift/` from version control prevents one-sided drift and silent desynchronization, while postinstall generation guarantees runtime availability for agent sessions.
- **Diagnostic Clarity**: `node:test` provides standard structured reporting (TAP/spec), per-test timing, and full failure summaries without aborting the entire suite on the first failed assertion.

### Negative & Neutral
- **File Proliferation**: The repository gains approximately 25 new module files under `evidence/primitives/` and `tests/`.
- **Sequenced Landing Requirements**: Architectural changes to `.web-uplift/` tracking (`diaq`) must be strictly sequenced behind in-flight feature branches that modify vendored files to avoid rebase churn.
- **Discipline Required for Census**: The CDP await census (`testAwaitCensus`) must track await calls across all 24 individual evidence modules instead of a single file.

---

## Alternatives Considered and Rejected

1. **Add CLI Filtering Flags to `regression.mjs` Without Splitting Files**:
   While `--only` and `--filter` enabled the fast gate in `web-uplift-eezy`, leaving 8,000+ lines in a single file does not address the git merge conflict problem. Every lane landing a test continues to touch the same lines.
2. **Big-Bang Test Suite Rewrite**:
   Attempting to rewrite the entire test suite into new files in a single pull request would disrupt all active feature branches and create unresolvable merge conflicts. An incremental, cluster-by-cluster extraction was chosen instead.
3. **Delete `.web-uplift/` Completely Without a Generator**:
   Per-project agent sessions (`claude -p /web-audit`) and agent configuration files (`.claude/skills/web-audit/SKILL.md`) rely on finding executable tools at `.web-uplift/evidence/cli.mjs`. Removing the path would break external agent compatibility. Generating the directory on install preserves compatibility without committing duplicate code.
4. **Permit Unbounded Concurrency in Node Test Runner**:
   Running browser tests concurrently across multiple child processes causes port exhaustion and CPU starvation on 2-vCPU VMs, resulting in flaky timeout failures. Enforcing sequential execution for browser workloads while parallelizing unit tests struck the necessary balance.
