# Speed record: the gates, their budget, and what the fast gate does not run

This is the project's own speed record: what the two gates cost, what the affected-only fast gate is
allowed to skip, and the ONE thing to do when it refuses a change. The fleet's cross-project copy is
`~/fleet/docs/speed.md` (host-owned); this file is the part that belongs to this repo, so it can be read
without the fleet checkout and reviewed beside the code it describes.

## The two gates

| gate | command | who runs it | budget |
| --- | --- | --- | --- |
| full union gate | `npm test` (`node --test --test-concurrency=3 tests/*.test.mjs`, 9 suites) | the merger, once per landing on the merged union | 282s measured; the fleet's ceiling for this repo is 60s for the FAST median, and the full gate runs once |
| affected-only fast gate | `npm run test:fast` (`node scripts/test-fast.mjs`) | every implementer, while iterating | median well under 60s; 13.0s on a change to the gate itself (2026-10-13, web-uplift-5i9a) |

A fast gate is run through the fleet wrapper without touching the machine-global config, which on a shared
VM may belong to another project (web-uplift-ebvj):

```sh
FLEET_CHECK_CONF=/home/exedev/.fleet/conf.d/web-uplift.conf fleet-check --fast
```

`~/.fleet/check.conf` is machine-global and an installer from another checkout can overwrite it, so a bare
`fleet-check --fast` may run another project's command. `FLEET_CHECK_CONF` points the wrapper at a config
this project owns. The config values are `CHECK_CMD="npm test"` and `CHECK_FAST_CMD="npm run test:fast"`.

## The fast gate routes by changed path, and refuses what it cannot route

`scripts/test-fast.mjs` maps every changed path to the suite that covers it. Two rules decide the plan:

1. **A path a `SUBSYSTEMS` entry maps** (or a runnable suite, which maps to itself) selects that suite.
2. **A path no entry maps** is either omitted by one of the named `OMITTED_RULES` below, or it is
   **refused**: the gate prints `fast-gate: unmapped: <path>` per path, `fast-gate: FAIL - N changed
   file(s) map to no suite:` on stderr, and exits 1 **before running any test**. It refuses in `--dry-run`
   too, so a preview cannot look greener than the run.

A refusal is the point: a gate that quietly ran a subset would report a pass for a change whose suite never
ran, which is the defect class this project keeps having to correct. An unmapped **executable** path is
never omitted by a tree, doc or data rule; only a rule that sets `mayOmitExecutable` can see one, and
exactly two do (`deleted`, `recorded-artefacts`).

### The omission rules (data, with the reason each path is skipped)

Each entry is a rule in `OMITTED_RULES` in `scripts/test-fast.mjs`; `node scripts/test-fast.mjs --list`
prints this table from that source, and a test walks this file and the rule set together so the two cannot
drift.

| rule | what it omits | why that is safe |
| --- | --- | --- |
| `deleted` | a path the change removes | there is no file left to run; a mapped target whose file is gone is skipped by `runTarget` (P2-3) |
| `docs` | `*.md`, `*.txt`, `LICENSE`, `NOTICE`, `AUTHORS` | prose has no executable behaviour |
| `media-and-markup` | `*.png`, `*.jpg`, `*.gif`, `*.svg`, `*.webp`, `*.mp4`, `*.webm`, `*.har`, `*.css`, `*.html`, `*.ico`, `*.woff2` | media and markup assets, not modules |
| `data-and-config` | `*.json`, `*.jsonl`, `*.yaml`, `*.yml`, `*.toml`, `*.conf`, `*.lock`, `*.keep`, `*.gitkeep`, `*.gitignore` | data and config files, not modules |
| `recorded-artefacts` | `evidence-out/**`, `.pi-subagents/**` | recorded outputs of an audit or agent run that no suite imports (the one executable-bearing exception, declared here) |
| `agent-and-ci-config` | `.beads/**`, `.github/**`, `.gemini/**`, `.claude-plugin/**`, `.mcp.json`, `opencode.json` | agent/CI tooling config: the workflow or agent that consumes it is the check |
| `fixture-and-demo-trees` | non-executable files under `tests/fixtures/**`, `playground/**`, `eval/**`, `examples/**` | fixture and demo data, no fast-tier suite of its own |

Executable files in the fixture/demo trees are **not** here: `playground/**/*.js` and
`eval/fixtures/**/*.js` are refused until a `SUBSYSTEMS` entry names their consumer (web-uplift-5r7z).

## When the fast gate refuses: the one next action

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
  reason it is skipped, so the next reader can see the policy rather than infer it.
- **cannot extend the map right now**: run the full union gate instead:
  `FLEET_CHECK_CONF=/home/exedev/.fleet/conf.d/web-uplift.conf fleet-check`.

Do not make a refusal pass by pointing it at the baseline: a baseline run is not evidence that the changed
module was tested.

## Measured cost of this policy (2026-10-13, web-uplift-5i9a)

- The policy changed no target for any mapped path: the dry-run plan for 8 representative paths
  (`evidence/cdp.mjs`, `runner/flow.mjs`, `package.json`, `fixer/fix.mjs`, `mcp/skills-server.mjs`,
  `tests/safe-fetch.mjs`, `runner/agents.mjs`, `tests/census-targets.mjs`) is identical before and after.
- The one cost is in the gate's own self-test target: `tests/test-fast.mjs` 5.3s -> 7.5s (+2.2s, four
  bounded `node` spawns). The 494-file tracked-path census inside it measures 0.15s.
- A refusal is cheaper than a run: it stops before dispatching any target.
- Fast records now carry coverage: the gate emits the fleet's `fast-gate: running|passed|failed: <suite>`
  markers, so a cached fast record reads `coverage: KNOWN` with the executed suite list instead of
  `UNKNOWN` (fleet docs/speed.md R15). The eleven web-uplift fast records before this change all read
  `UNKNOWN`, `coverage_verified: false`, `suites: 0`.
