# Speed record: the gates, their budget, and what the fast gate does not run

This is the project's own speed record: what the two gates cost, what the affected-only fast gate is
allowed to skip, and what a lane does when the gate refuses a change. The fleet's cross-project copy is
`~/fleet/docs/speed.md` (host-owned); this file is the part that belongs to this repo, so it can be read
without the fleet checkout and reviewed beside the code it describes.

Two things about this file are deliberate. The routing policy and the omissions are **data**: the reason
column below is the rule's own `reason` string, and `tests/test-fast.mjs` PARSES this table and compares
each row's reason to `OMITTED_RULES`, so a wrong-but-plausible reason with a right rule id fails. And the
measurements carry their provenance, because the VM is shared and a busy hour moves wall time more than the
code does.

## The two gates

| gate | command | who runs it | budget |
| --- | --- | --- | --- |
| full union gate | `npm test` (`npm run sync:vendored && node --test --test-concurrency=6 tests/*.test.mjs`, 14 suites) | the merger, once per landing on the merged union | 282s measured over 145 runs to 2026-10-11; 66.2s median re-measured 2026-10-13 (web-uplift-f5mb), see "What the gate's wall time is made of" below |
| affected-only fast gate | `npm run test:fast` (`npm run sync:vendored && node scripts/test-fast.mjs`) | every implementer, while iterating | median under 60s (the fleet's ceiling for this repo); 13s direct and 14-20s cached on changes to the gate itself (2026-10-13, web-uplift-5i9a) |

Neither gate is run without naming this project's own command on a shared VM, because
`~/.fleet/check.conf` is machine-global and an installer from another checkout can overwrite it
(web-uplift-ebvj):

```sh
FLEET_CHECK_CONF=/home/exedev/.fleet/conf.d/web-uplift.conf fleet-check --fast
```

Note what the full gate does NOT run: `npm test` runs `tests/*.test.mjs`. The guarded standalone suites
here are covered only when those files invoke their tests (directly or transitively); import alone does not
run these guarded tests. A module registering `node:test` cases at import time can instead run them on
import. A path not exercised by the full-gate tests, including an unimported standalone suite or one
imported only for helpers, is not covered even if the fast gate does not map it.

## What the gate's wall time is made of (2026-10-13, web-uplift-f5mb)

`npm test` runs each `tests/*.test.mjs` in its own `node:test` process and runs at most
`--test-concurrency=N` of those processes at once. Two consequences decide the wall time:

1. A **file** is the unit of parallelism. The cases inside one file run serially, so one case-heavy file
   is a critical-path block that no number of extra slots can shorten.
2. **`node --test` sorts the file list alphabetically and ignores the order the paths are given in.**
   Verified on this VM: passing `c.test.mjs a.test.mjs b.test.mjs` runs a, b, c, and passing a
   much-smaller alphabetically-first file with a much-larger alphabetically-later one still runs the
   small one first, so it is a path sort rather than a size sort. The schedule is deterministic, and a
   heavy suite that happens to sort late starts late.

### The per-suite measurement the shape was chosen from

Measured serially on a quiet VM, one file at a time, before the split
(`node --test --test-concurrency=1 <file>`, 2026-10-13):

| suite | cases | wall |
| --- | --- | --- |
| `tests/evidence-network.test.mjs` | 8 | 36.9s |
| `tests/evidence.test.mjs` | 9 | 31.7s |
| `tests/chrome-cdp.test.mjs` | 25 | 31.2s |
| `tests/syntax-core.test.mjs` | 27 | 26.2s |
| `tests/evidence-content.test.mjs` | 11 | 23.5s |
| `tests/redaction.test.mjs` | 15 | 12.3s |
| `tests/runner-agents.test.mjs` | 29 | 11.8s |
| `tests/install-package.test.mjs` | 23 | 11.3s |
| `tests/mwg-principles.test.mjs` | 11 | 6.7s |
| `tests/fixture-sites.test.mjs` | 2 | 0.2s |
| **total work W** | **160** | **191.8s** |

At concurrency 3 the floor is W/3 = 63.9s and the alphabetical schedule reached 75.6s on those numbers,
about 12s of tail: the slot that frees first (chrome-cdp, 31.2s, alphabetically first) then serially eats
the whole remaining queue. A longest-first order would reach 66.5s, but there is no supported way to set
it, and renaming suites to game the sort is a trap that breaks the next time a suite's cost changes. The
mechanism that would take the tail is sharding, tracked as `web-uplift-jgkj`; it is not claimed here.

### What was split

Two suites carried most of that serial block, and `tests/evidence.test.mjs` additionally held the three
heaviest single cases in the whole gate (console 47.6s, throttling 42.4s, locale-timezone 34.8s in a
loaded merger run). Both were split into per-subject files, with the cases moved unchanged:

| before | after |
| --- | --- |
| `tests/evidence.test.mjs` (9 cases) | `evidence-axe` (2), `evidence-conditions` (4), `evidence-console` (3) |
| `tests/evidence-network.test.mjs` (8 cases) | `evidence-network-headers` (2), `evidence-network-har` (3), `evidence-network-resilience` (3) |

Nothing was dropped, relaxed or reordered: the union of the suite lists is byte-identical before and after
(160 case names, diffed), and `testSuiteListsMatchRegressionRegistry` pins it at 14 suite files. The split
changed no case. The count is 161 on master because web-uplift-lql5 later added one regression case to
`tests/install-package.test.mjs`; that is a different change, and the numbers above are the split's own.
`tests/evidence.test.mjs` was also a real collision hotspot, at 12 of the 30-day `--first-parent` changes
under `tests/`, so the split reduces the file every evidence change has to edit as well as the critical path.

### The paired measurement, and the setting it chose

Every arm sampled run by run in ONE window, load recorded beside every run, 3 samples per arm, each arm
in its own tree. This is the authority; the model above is not.

| arm | median | runs | failed runs | peak job-tree RSS | load at start |
| --- | --- | --- | --- | --- | --- |
| 10 files, concurrency 3 (before the split) | 99.1s | 105.1, 99.1, 96.4 | 0/3 | 490-530 MB | 12.96, 14.58, 13.51 |
| 14 files, concurrency 3 | 82.6s | 82.6, 96.0, 80.6 | 0/3 | 497-708 MB | 10.43, 9.07, 7.74 |
| 14 files, concurrency 6 | **66.2s** | 67.9, 60.8, 66.2 | 0/3 | 863-914 MB | 9.86, 8.74, 19.83 |
| 14 files, concurrency 8 | 74.3s | 74.3, 56.5, 80.8 | **2/3** | 961-1033 MB | 13.75, 13.42, 19.08 |

`npm test` therefore runs at **concurrency 6**: 33.0s (33%) below the 99.1s it was, and 16.4s below the
split tree at concurrency 3. Concurrency 8 is rejected on BOTH counts: slower than 6, and 2 of its 3 runs
failed on `testOversizedBodyDoesNotEarnACleanVerdict` (`web-uplift-wo80`, a case that asserts on the
reader's scheduling by relying on two socket writes not coalescing). The extra slots buy nothing and cost
a flake.

The model predicted 3 -> 76s, 6 -> 45s, 8 -> 37s and the measurements were 82.6s, 66.2s, 74.3s, which is
the useful lesson: per-file wall times do NOT survive N-way contention on browser-and-parser-bound
suites, so a list-schedule is a hypothesis and paired runs are the evidence.

The ceiling that matters for the reaper is the JOB TREE's RSS, not the host's: 863-914 MB at concurrency
6 against the reaper's 3 GB limb, with `MemAvailable` never below 12.6 GB. Memory was never the binding
constraint at any setting tried.

`docs/adr-0002` records this as superseding ADR 0001 decision 3's `--test-concurrency=1` mandate, whose
2-vCPU premise is not this host.

### The fast gate did not move

`scripts/test-fast.mjs` dispatches its targets in a serial loop (`runTarget` inside a `for`), and the
`evidence` subsystem's targets are `--only` REGRESSION FILTERS rather than whole suite files, so splitting
a suite file changes neither the target set nor its order, and `npm test`'s concurrency is not read by
`npm run test:fast` at all. The one edit is that `TEST_SUPPORT_MODULES` names
`tests/evidence-console.test.mjs` as the consumer of `tests/console-evidence-redaction.mjs`, because that
is the file that imports and uses it after the split; the target it selects is smaller than the one it
replaced.

## Scheduling the suite files does not pay at fleet load (2026-10-13, web-uplift-jgkj)

The gate runs a whole suite file per process, so the FILE is the unit of parallelism. `node --test` sorts
its file list **alphabetically and ignores the order the paths are given in** (passing
`c.test.mjs a.test.mjs b.test.mjs` runs a, b, c, and a control where the alphabetically-first file was also
the largest still ran it first, so it is a path sort and not a size sort). The slot that frees first takes
the whole remaining queue, so the run ends on a tail that is scheduling rather than work.

**Measured.** Per-file costs, `node --test --test-concurrency=1 <file>` one file at a time on a quiet VM:
total work W = 168.7s over 160 cases in 14 files, so the floor at 6 slots is 168.7/6 = 28.1s.

**Modelled, not measured.** Everything in the next table is what a schedule would cost on an idle box. It is
a list-schedule simulation over those measured per-file costs, and it assumes the files run at full speed
with no contention between them. This project's record with that model is that it is optimistic in exactly
one direction: it predicted 37s for concurrency 8 where the machine measured 74.3s, and it predicted a 6.2s
win for the launcher described below where the machine measured 1.5s slower. Read this table as a ceiling
and the paired table after it as the result.

| N | floor W/N | alphabetical, modelled | longest-first, modelled |
| --- | --- | --- | --- |
| 3 | 56.2s | 63.9s | 56.8s |
| 5 | 33.7s | 41.1s | 35.2s |
| 6 | 28.1s | **35.8s** | **29.6s** |
| 7 | 24.1s | 30.6s | 28.9s |
| 8 | 21.1s | 28.9s | 28.9s |

**It was built, then measured against the landed gate, and NOT adopted.** `scripts/run-full-gate.mjs` on
branch `fleet/jgkj-shards` partitions the suite files longest-first into 6 groups and runs one
`node --test --test-concurrency=1` per group concurrently. It works: exit 0, 160/160 cases, every file in
exactly one group, groups finishing together rather than staggered. **Measured**, paired against the landed
command, alternating, three samples per arm, load recorded per run:

| arm | walls | median | exits | peak job-tree RSS |
| --- | --- | --- | --- | --- |
| alphabetical (the landed gate) | 44.1s, 46.3s, 47.1s | 46.3s | 1, 0, 1 | 842-895 MB |
| longest-first (the launcher) | 39.1s, 48.1s, 47.8s | 47.8s | 0, 0, 0 | 1.10-1.13 GB |

The launcher is 1.5s **slower** at the median and uses about 28% more memory (far under the reaper's 3 GB).

The `exits` column carries a second finding. Arm A is the command the gate runs, and it failed two of its
three runs on `testBatchIsolationGate`; the launcher passed three of three, which at n=3 is suggestive
rather than proof. That failure is filed as `web-uplift-y741`, and under fleet load it matters more than
the 6.2s ever did: a case that fails two runs in three turns an unrelated landing red, and a red gate the
fleet learns to treat as noise is expensive.

The reason is the thing worth remembering: **at that load the gate is contention-bound, not work-bound.**
Both arms ran at about 1.6x the 28.1s floor, so a schedule can only redistribute work that is not the
binding constraint. Holding peak concurrency for a whole run costs about what balancing the queue saves,
and the launcher never idles a slot while node's dynamic scheduling does so naturally in the tail. The 6.2s
is an idle-box number; both arms were stretched about 1.6x over this window (load 13.4-18.8 on 8 vCPU).

The levers that move this gate under fleet load are therefore **fewer concurrent browser processes, shorter
cases, and a quieter box**, not a better schedule. This is the same shape as the concurrency-8 result in
"### The paired measurement, and the setting it chose" above.

The clearest single number for that, and it is not a full-gate number at all: the SAME four fast-gate
targets on the same docs-only change ran in **0.94s at 15:07 and 27.38s at 15:08**, one minute apart, with
the heavy slot free both times. `testSyntaxChecks` alone went from 217ms to 6996ms. Nothing changed but the
load other lanes were putting on the box, which is why a wall time quoted without the load beside it is not
a measurement of anything.

`--test-shard=i/N` is not a candidate either: it is ROUND-ROBIN over that same sorted list, so it inherits
the arbitrary order. Simulated the same way on this 14-file set, six shards produce
49.1s/38.0s/14.0s/20.2s/27.9s/19.5s, a 49.1s makespan against the 28.1s floor, worse than the alphabetical
schedule it would replace.

**Do not rename the suites so the alphabet happens to be a good schedule.** It looks like a fix, it stops
being one the moment a file is added or shrinks, and it makes the file names lie about what they contain.

## The fast gate routes by changed path, and refuses what it cannot route

`scripts/test-fast.mjs` compares the working tree to the merge-base of `HEAD` and `origin/master`, then
adds untracked files; `--diff <ref>` uses the merge-base with that ref. This keeps master-only landings out
of a stale branch's fast gate, while staged/unstaged changes still count. If a merge-base cannot be found
(shallow or unrelated history), it falls back to the old ref-based diff, which may over-select but does
not silently drop changes. Measured before this fix on the same four-file branch (web-uplift-s3pq): 4
targets/51s when master equalled the merge-base, versus 22 targets/217s after master advanced one landing;
the extra 18 targets were master-only work. These are before-fix observations, not a promised runtime.
The new local-git stale-branch control adds no test target; the existing fast-gate self-test measured
7.41s standalone after the change on this VM (2026-10-13, `node tests/test-fast.mjs`), with no paired
before sample under the same load, so no per-run speedup is claimed from that number.

### The diff is reported, not implied (web-uplift-5e9s)

The selection is a WORKING-TREE diff, and `fleet-check` caches a verdict under the COMMITTED tree it ran
on, so the run now says what it compared and which of the selected paths are not in that tree:

- the first line names the BASE it diffed against, the ref that base came from, and the distance:
  `Detected 5 changed file(s) vs base 7583e22 (merge-base of master); branch 1 ahead / 1 behind master`.
  `vs origin/master` named the one thing this comparison is not, which is why a stale branch's inflated
  target list took a manual `git` A/B to explain (web-uplift-s3pq, web-uplift-1a6q).
- every selected path that is not in HEAD is marked in the file list (`[uncommitted: modified]`,
  `[uncommitted: untracked]`) and listed again in an `UNCOMMITTED (K of N)` block, followed by one line
  stating that this run selects and executes against the WORKING TREE and its result is not a verdict for
  HEAD alone. A clean worktree prints neither, which is the negative control pinned in
  `tests/test-fast.mjs`.

The selection itself is unchanged. The gate still tests work in progress, because dropping those paths
would be a change to what the gate RUNS, and a green over a narrowed selection is a worse hole than a
green whose provenance is stated; a commit-only selection is a separate decision (web-uplift-5e9s).

Cost: two extra git spawns per diff run (`git status --porcelain --untracked-files=all` and one
`git rev-list --left-right --count <ref>...HEAD`). A paired 5+5 sample, alternating both variants in one
synthetic repo in one window (2026-10-13, tip c59485a, load ~27), measured medians of 116ms before and
98ms after for `--dry-run`, inside the 68-170ms run-to-run spread: no cost is claimed and none was
removed.

`scripts/test-fast.mjs` maps every changed path to the suite that covers it. Two rules decide the plan:

1. **A path a `SUBSYSTEMS` entry maps** (or a runnable suite, which maps to itself) selects that suite.
2. **A path no entry maps** is either omitted by one of the named `OMITTED_RULES` below, or it is
   **refused**: the gate prints `fast-gate: unmapped: <path>` per path, `fast-gate: FAIL - N changed
   file(s) map to no suite:` plus a `NEXT ACTION` block on stderr, and exits 1 **before running any test**.
   It refuses in `--dry-run` too, so a preview cannot look greener than the run.

A refusal is the point: a gate that quietly ran a subset would report a pass for a change whose suite never
ran, which is the defect class this project keeps having to correct. An unmapped executable can instead
**auto-map only to a runnable suite changed in the same diff** when a quoted import specifier, subprocess
argument or path string in that suite names the complete module path. The gate reads each changed suite at
most once and prints `[test:fast] auto-mapped <path> -> <suite>` on every occurrence, including a pass or a
mixed diff that still refuses another path. It prints the count of changed suites and source characters
scanned; it never searches unchanged tests or guesses from the whole tree. If no changed suite names it,
the existing refusal remains. A name is **not proof the suite executes the module**: the printed pair is
what a reviewer checks against the suite's actual test behavior; otherwise a named-but-unused fixture
could still yield a false green. A path under a mapped subsystem is not eligible for this fallback.

Cost: a synthetic 1,000-plan comparison on this VM (2026-10-13, same tree, one changed suite source with
one import) took 10.5ms for the suite-only plan and 15.9ms for the module-plus-suite auto-map plan; that
5.4ms difference across 1,000 iterations includes processing the extra changed path and is **not** a
prediction for large suites. The `tests/test-fast.mjs` focused suite measured 2.78s standalone on this tree;
there is no paired before sample for its added CLI cases. Scope is bounded by changed test files, not the
repo's total test count. An unmapped **executable** path is
never omitted by a tree, doc or data rule; only a rule that sets `mayOmitExecutable` can see one, and
exactly two do (`deleted`, `recorded-artefacts`).

### The omission rules (data, with the reason each path is skipped)

| rule | what it omits | reason |
| --- | --- | --- |
| `deleted` | a path the change removes | deleted by this change: there is no file left in the tree to run |
| `docs` | `*.md`, `*.txt`, `LICENSE`, `NOTICE`, `AUTHORS` | documentation or prose: no executable behaviour to test |
| `media-and-markup` | `*.png`, `*.jpg`, `*.gif`, `*.svg`, `*.webp`, `*.mp4`, `*.webm`, `*.har`, `*.css`, `*.html`, `*.ico`, `*.woff2` | media or markup asset, not a module |
| `data-and-config` | `*.json`, `*.jsonl`, `*.yaml`, `*.yml`, `*.toml`, `*.conf`, `*.lock`, `*.keep`, `*.gitkeep`, `*.gitignore` | data or config file, not a module |
| `recorded-artefacts` | `evidence-out/**`, `.pi-subagents/**` | recorded run artefact: an audit or agent output that no suite imports, regenerated by the run that produced it |
| `agent-and-ci-config` | `.beads/**`, `.github/**`, `.gemini/**`, `.claude-plugin/**`, `.mcp.json`, `opencode.json` | agent or CI tooling config: the workflow or agent that consumes it is the check |
| `fixture-and-demo-trees` | non-executable files under `tests/fixtures/**`, `playground/**`, `eval/**`, `examples/**` | non-executable file in a fixture or demo tree: no fast-tier suite of its own (unmapped executable files here are refused, never omitted) |

Executable files in the fixture/demo trees are **not** omitted: `playground/**/*.js` and
`eval/fixtures/seeded-issues/site/**/*.js` map to `tests/fixture-sites.test.mjs`. It reads exactly 18 JavaScript
modules for syntax/local imports and loads each scenario index to check metadata; it does **not** drive the
DOM. This is syntax-and-structure-only fast-tier coverage. For a behaviour change, drive the affected site
in a browser and use `.github/workflows/audit-playground.yml`, which serves and probes both sites in CI.
Other unmapped executable fixture/demo paths are refused rather than silently skipped. The new suite took
0.21s standalone on this VM (2026-10-13, `node tests/fixture-sites.test.mjs`, after replacing 18 Node
syntax-check spawns with one parser child); only changed site JavaScript or the suite itself selects it,
so unrelated fast-gate paths gain no work.

## When the fast gate refuses: the escape

Extend the map in `scripts/test-fast.mjs`, then re-run `npm run test:fast`. Which entry depends on the file:

- **a module with a suite**: add it to the `SUBSYSTEMS` entry for that suite. The refusal prints a
  paste-able skeleton for the path it refused, for example:

  ```js
  { id: 'new-tool', match: (f) => f === 'scripts/new-tool.mjs', targets: [{ type: 'node', path: 'tests/new-tool.test.mjs', label: '...' }] },
  ```

- **a runnable standalone suite under `tests/`**: add it to `KNOWN_STANDALONE_TESTS`, the explicit
  allowlist of suites that run with no arguments (a `tests/*.test.mjs` file needs no entry: it maps to
  itself).
- **documentation, data or a fixture with genuinely no suite**: add an `OMITTED_RULES` entry with the
  reason it is skipped, so the next reader can see the policy rather than infer it. Do not add an entry
  whose only purpose is to make the gate green.
- **if the map cannot be extended right now**: the full gate is NOT evidence on its own for a refused path
  its tests do not exercise. `npm test` runs `tests/*.test.mjs`; the guarded standalone suites here are
  covered only if those files invoke their tests. Import alone does not run these guarded tests; a module
  registering `node:test` cases at import time can instead run them on import. An unimported suite is not
  covered either. Run the suite covering a path not exercised by those files explicitly (for a refused
  `tests/*.mjs`, `node <path>`), then
  `FLEET_CHECK_CONF=/home/exedev/.fleet/conf.d/web-uplift.conf fleet-check`, and name the command that
  produced the evidence in your hand-off.

Do not make a refusal pass by pointing it at the baseline: a baseline run is not evidence that the changed
module was tested. The guarded-import negative and invoked positive controls added for web-uplift-igc9
cost 0.11s and 0.20s as separate Node processes on this VM (2026-10-13); the fast-tier self-test gains
these two probes, not a browser or a full-suite run.

## Measured cost of this policy (2026-10-13, web-uplift-5i9a)

- The policy changed no target for any mapped path: the dry-run plan for 8 representative paths
  (`evidence/cdp.mjs`, `runner/flow.mjs`, `package.json`, `fixer/fix.mjs`, `mcp/skills-server.mjs`,
  `tests/safe-fetch.mjs`, `runner/agents.mjs`, `tests/census-targets.mjs`) is identical before and after.
- The one cost is in the gate's own self-test target, `tests/test-fast.mjs`: 7.2s direct (tip a709eb9), 8.3s
  direct on a busy VM (tip bbb8ce0), and 11.0s in the cached merger-slot run at 11:38Z the same hour, when
  that run's Syntax-checks target took 7.8s against 5.2s direct. It contained six bounded
  `node` spawns at that tip (three in the refusal controls, two in the actionability/policy test, one in
  the marker test): +2.2s over the 5.3s it took before this change. It now contains eight bounded `node` spawns:
  the provenance control added by web-uplift-5e9s (tip c59485a) adds two `--dry-run` runs in a
  synthetic repo, measured at 0.09-0.15s each on this VM, so the self-test's own spread dominates it
  (5.19s and 8.03s on the same tree seconds apart, load 27). The tracked-path census inside it was 494
  paths at that tip and measures 0.15s.
- A refusal is cheaper than a run: it stops before dispatching any target.
- Whole fast-gate samples for this branch: 13s direct, and 13-20s in the cached records (tips 8bbab61,
  1cf6e36, a709eb9, dda63b0). The 51 web-uplift fast records before 11:00Z that day have median 66s, but
  that is which diff was gated, not this policy.
- Fast records now carry coverage: the gate emits the fleet's `fast-gate: running|passed|failed: <suite>`
  markers, so a cached fast record reads `coverage: KNOWN` with the executed suite list instead of
  `UNKNOWN` (fleet docs/speed.md R15). The eleven web-uplift fast records before this change all read
  `UNKNOWN`, `coverage_verified: false`, `suites: 0`. It is the MARKERS ALONE that fix that; the
  `FLEET_CHECK_CONF` override is only about running this project's command on a shared VM.

## Measured cost of sharing one browser per case (2026-10-13, web-uplift-t2mr)

`gather()` used to launch and close a browser per call; it now takes an optional `browser` the caller owns and
does not close, so a case that drives several primitives pays one launch instead of N. The default path is
unchanged (no `browser` supplied = launch and close as before), and every call still creates its own
session/target, so per-target CDP state (emulated network, CPU rate, viewport, locale, timezone) cannot leak
between primitives. Browser-PROFILE state (cookies, storage, service workers, HTTP cache) is shared, so a case
only opts in when it does not depend on a fresh profile: a launch is ~0.45s on an idle VM but 0.6-1.4s inside
the gate, and the CPU it costs is the reason this matters (the fleet's scarcest resource), not just the wall.

NOTHING IS MEASURED LESS. Every assertion is unchanged, and the two converted cases carry their own
functional check that the sharing is clean: `testConsoleEvidence` asserts the `/clean` load reports zero
console entries after the `/noisy` load, and it still does. Paired measurement (same VM, same command,
`tests/regression.mjs --only`, one browser per call vs one per case), each pair measured back-to-back on
the conversion's own branch before it landed - the throttling pair on base `8588171`, not on this tip's base -
one figure with its context, rather than a range across runs:

| case | before | after | saved | launches |
| --- | --- | --- | --- | --- |
| `testFetchDeadlineAndRawComparison` | 30949ms | 25382ms | -5.6s | 5 -> 1 |
| `testConsoleEvidence` | 12558ms | 9673ms | -2.9s | 6 -> 1 |
| `testThrottlingConditions` | 15840ms | 9181ms | -6.7s | 8 -> 1 |

`testThrottlingConditions` converts ALL EIGHT of its `gather` calls, not the seven that do the measuring
(web-uplift-qsqp). Its final assertion rejects an unknown network profile, and `gather` launches the browser
before the primitive validates the option, so that call paid a full Chrome start only to throw - which is why
this reads 8 -> 1 rather than 7 -> 1. Its assertions are also the functional check that the sharing is clean,
and every one of them still passes under a single browser: a run with no device-metrics override reports no
viewport, an unthrottled run carries no conditions block at all, mobile-lighthouse implies 4x CPU + 150ms
RTT, and the slow-3g probe is really more than 1000ms slower than the plain one. The rejected call's launch is
removed separately and NOT yet landed: web-uplift-3mrg validates the declarative conditions before
`launchChrome`, which makes that eighth launch cost nothing for every caller rather than only in this case.
That branch is awaiting its clearance, so read this as the direction of travel, not as a landed fact; what is
landed and measured here is the row above.

Still to convert (the seam is in place): the other multi-`gather` cases. Do NOT share a browser in `testCdpDeadline` (it deliberately points Chrome at a blackhole server),
`testNoOrphanBrowser` (it asserts teardown) or `testResiliencePrimitive` (service workers).

## Syntax census child (web-uplift-epad, 2026-10-13)

`testSyntaxChecks` keeps the same `listFiles(repoRoot, .mjs)` walk and parses each path independently in
one bounded Node child. This worktree walked 139 files, including 40 generated vendored copies and five
nested test fixtures; the earlier 99-file count was a different worktree, not a fixed allowlist. In a
back-to-back focused run on this VM (`node tests/regression.mjs --only testSyntaxChecks`), before changing
the parser the case took 5429ms (5.62s command wall), and after changing it plus adding source/test/nested
invalid-syntax and shebang controls it took 230ms (0.43s command wall). Those are measured runs under a
shared host, not a promised per-landing saving. No files or test cases were omitted, and the full suite
still belongs to the merger.
