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
| full union gate | `npm test` (`npm run sync:vendored && node --test --test-concurrency=3 tests/*.test.mjs`, 9 suites) | the merger, once per landing on the merged union | 282s measured; the full gate runs once |
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

`scripts/test-fast.mjs` maps every changed path to the suite that covers it. Two rules decide the plan:

1. **A path a `SUBSYSTEMS` entry maps** (or a runnable suite, which maps to itself) selects that suite.
2. **A path no entry maps** is either omitted by one of the named `OMITTED_RULES` below, or it is
   **refused**: the gate prints `fast-gate: unmapped: <path>` per path, `fast-gate: FAIL - N changed
   file(s) map to no suite:` plus a `NEXT ACTION` block on stderr, and exits 1 **before running any test**.
   It refuses in `--dry-run` too, so a preview cannot look greener than the run.

A refusal is the point: a gate that quietly ran a subset would report a pass for a change whose suite never
ran, which is the defect class this project keeps having to correct. An unmapped **executable** path is
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
  that run's Syntax-checks target took 7.8s against 5.2s direct. It contains six bounded `node` spawns (three
  in the refusal controls, two in the actionability/policy test, one in the marker test): +2.2s over the 5.3s
  it took before this change. The 494-file tracked-path census inside it measures 0.15s.
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
`tests/regression.mjs --only`, one browser per call vs one per case):

| case | before | after | saved | launches |
| --- | --- | --- | --- | --- |
| `testFetchDeadlineAndRawComparison` | 30949ms | 25382ms | -5.6s | 5 -> 1 |
| `testConsoleEvidence` | 12558ms | 9673ms | -2.9s | 6 -> 1 |

Still to convert (the seam is in place): `testThrottlingConditions` (7 -> 1) and the other multi-`gather`
cases. Do NOT share a browser in `testCdpDeadline` (it deliberately points Chrome at a blackhole server),
`testNoOrphanBrowser` (it asserts teardown) or `testResiliencePrimitive` (service workers).
