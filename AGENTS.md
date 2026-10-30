# AGENTS.md - web-uplift

Guidance for any coding agent that reads `AGENTS.md` (Codex, opencode, and
others). This repo is a fully agentic modern-web quality auditor: the model
(you) is the auditor. There is no deterministic check runner and no fast path.

## The one canonical skill

When asked to web-audit, UX-audit, uplift, modernise, or quality-audit a site,
read [`.claude/skills/web-audit/SKILL.md`](.claude/skills/web-audit/SKILL.md) and
follow it exactly. That single file is the source of truth for every agent
(Claude Code, Codex, Gemini CLI, Antigravity, GitHub Copilot, opencode, ...).
Do not reimplement the methodology; every per-agent entry point just points
here so it cannot drift.

Run as the slash command where available (`/web-audit <url>`), or use the raw
prompt in any agent:

> Read the file .claude/skills/web-audit/SKILL.md and follow its instructions
> exactly, with these arguments: <url>

**Two ways to run, default first.** The DEFAULT for an individual is to run the
skill INSIDE this session (it uses your subscription): `/web-audit <url>` to
audit, `/web-audit <url> --source <dir> --fix` for the model-driven fix
hill-climb. The HEADLESS / CI path (`npm run audit`, `npm run fix`,
`web-uplift audit|fix`) spawns an agent CLI in `-p`/`exec` mode and bills API
tokens; it is for automation, not the individual default. Both follow this same
SKILL.md. Fix mode is a MODEL-DRIVEN hill-climb: you write every guidance-backed
edit and re-audit until no outstanding `issues` remain (there are no canned
transforms).

## How you see the page (no MCP required)

Evidence is gathered with a plain Node CLI over raw Chrome DevTools Protocol
(chrome-remote-interface), no browser-automation MCP server, no Playwright, no
Puppeteer:

```sh
node evidence/cli.mjs <screenshot|video|heap|layout|dom|evaluate> <url> [options]
```

You choose the conditions and tools at inspection time: `--emulate-media k=v,..`,
`--viewport WxH`, `--selector`, `--interact`, `--expr`, `--source`, `--out`,
`--bodies`, `--cdp-deadline <ms>`, `--fetch-deadline <ms>`. You
may also run `npx -y lighthouse ...`, inject axe-core via the `evaluate`
primitive, or write your own probes. Query Modern Web Guidance with
`npx -y --ignore-scripts modern-web-guidance@0.0.194 search "<query>"` /
`retrieve "<id>"` (the pinned version is `guidanceCatalogVersion` in
[`knowledge/principles.json`](knowledge/principles.json); tests/regression.mjs
fails if any doc names a different one or `@latest`).

The only host requirements: Node, `google-chrome-stable` (override `CHROME_BIN`),
`ffmpeg` (for the video primitive), and network access for `npx`.

## Knowledge layers

- Principles (spec, as outcomes): [`knowledge/principles.json`](knowledge/principles.json)
- Guidance (the how): the `modern-web-guidance` feed; [`knowledge/guidance.md`](knowledge/guidance.md)
- Findings schema: [`schema/findings.schema.json`](schema/findings.schema.json)
- Eval ground truth: [`eval/README.md`](eval/README.md)

## House rules

- Raw CDP only; never add Playwright or Puppeteer.
- ESM only; no Node `Buffer` (use `TextEncoder`/`Uint8Array`/`atob`/`btoa`).
- No em dashes in prose.
- Write `report.json` (valid against the schema) and `report.md`, recording the
  `evidenceUsed`.
- Canonical and vendored trees must remain 100% byte-identical. Changes to
  `evidence/`, `aggregate/`, `runner/`, `schema/`, or `knowledge/` are
  mirrored into `.web-uplift/` automatically via `npm run prepare` (or
  `node install-surface.mjs`), while `.web-uplift/` is gitignored to prevent
  duplicate merge conflicts (web-uplift-diaq). Run `npm run sync:vendored` (or
  `node tests/cdp-copy-sync.mjs --sync`) to resync copies. The test gate
  (`npm test`) enforces byte identity via `testCdpCopySyncGuard`.
- Bead comments are APPEND-ONLY, so never paste a live-looking secret into one
  (web-uplift-246z). Verified on bd 1.3.1: `bd comments` offers `add` and the list
  form only, with no edit and no delete; `bd update` rewrites the description
  alone; and `bd dolt` has no `sql` verb, so there is no supported command that
  can correct a comment. It also leaves this machine: the Dolt database that
  carries the comment is published to `origin` as `refs/dolt/data` by
  `bd dolt push`, so a token-shaped comment is public rather than local.
  `scripts/beads-export.mjs` and `tests/beads-export-redaction.mjs` protect the
  tracked export FILE only, never the database.
- Check any body before you post it, with the rule the redactor itself uses (an
  empty array is clean):
  `node -e "import('./evidence/credential-terms.mjs').then((m) => console.log(m.findTokenShapesInText(process.argv[1])))" '<text>'`
  If a shape is already written, rotate the credential: no edit can recall bytes
  that the published ref history keeps.

## Codex specifics

`.codex/config.toml` registers only the optional `web-uplift` skills server
(SKILL.md distribution; not a browser). `.codex/skills/web-audit` symlinks the
canonical skill so `/web-audit` works. The `workspace-write` sandbox keeps file
edits inside the repo.

## opencode specifics

`.opencode/command/web-audit.md` is the `/web-audit` command (it points here and
at the skill). opencode also reads this `AGENTS.md` for project context.

## Testing & fast gates (fleet-check --fast)

The full test suite is `npm test`, which runs `npm run sync:vendored` and then
`node --test --test-concurrency=2 tests/*.test.mjs`: the 14 modular suites
(`tests/*.test.mjs`) each run in their own `node:test` process.

**It is NOT a per-landing gate** (hub ruling, 2026-10-28). A landing needs a verified
fast gate plus an independent cross-family review; the full sweep is deferred to the
nightly factory audit, which is where its wall time is recorded. Do not run it to
verify a change, and do not wait for it before handing off. `docs/speed.md` section
"The full sweep runs two suites at a time, and it is not a per-landing gate" holds
the ruling, the measurement behind the concurrency, and what is still outstanding
about it; `docs/adr-0004-full-sweep-concurrency-2.md` is the decision record.

**Why concurrency 6 was chosen, and why the sweep now runs at 2** (the table below was
measured 2026-10-13, web-uplift-f5mb, when the sweep was still the per-landing gate;
replacing these numbers with adjectives is how this becomes a guess again). Paired run by
run in ONE window with the load beside every run, 3 samples per arm, each arm in its own
tree:

| arm | median | runs (s) | failed runs | peak job-tree RSS |
| --- | --- | --- | --- | --- |
| 10 suite files, concurrency 3 (before the split) | 99.1s | 105.1, 99.1, 96.4 | 0/3 | 490-530 MB |
| 14 suite files, concurrency 3 | 82.6s | 82.6, 96.0, 80.6 | 0/3 | 497-708 MB |
| 14 suite files, concurrency 6 | **66.2s** | 67.9, 60.8, 66.2 | 0/3 | 863-914 MB |
| 14 suite files, concurrency 8 | 74.3s | 74.3, 56.5, 80.8 | **2/3** | 961-1033 MB |

- **8 is rejected on both counts, and that is the useful part of this table.** It is SLOWER than 6
  (74.3s against 66.2s) and 2 of its 3 runs FAILED, both on
  `testOversizedBodyDoesNotEarnACleanVerdict` (web-uplift-wo80: the case relies on two socket writes
  not coalescing, so it asserts on the reader's scheduling). The extra slots buy nothing here and
  cost a flake; do not raise this to 8 on the strength of a single fast run.
- **Memory is not the binding constraint, and that is measured, not assumed.** The number the reaper
  acts on is the JOB TREE's RSS (it kills over 3 GB): 863-914 MB at concurrency 6, 3.4x of headroom,
  with MemAvailable never below 12.6 GB. (An earlier note in this file cited "~2.2GB in use with 3-4
  concurrent browser suites"; that is a machine-wide figure, not the job tree.)
- **The gain is real but smaller than a model predicts.** A list-schedule fitted to per-file wall times
  predicted 3 -> 76s, 6 -> 45s, 8 -> 37s. Measured: 82.6s, 66.2s, 74.3s. Per-file times do NOT survive
  N-way contention on browser-and-parser-bound suites, so the model is a hypothesis and the paired runs
  are the authority.
- **Compare concurrency settings with PAIRED runs, never against a single run from earlier in the day.**
  The load here moved between 7.7 and 21.0 across the window, and an unpaired concurrency 3 run through
  `npm test` once took 226s at load 3-6 in a 2026-10-12 window. What makes this table usable is that
  every arm was sampled in the same window and the concurrency 6 arm held 67.9/60.8/66.2s across loads
  8.7 to 19.8.
- The earlier concurrency-2-vs-3 measurement (web-uplift-tb6p, 2026-10-12: mean 134.8s against 98.3s)
  is what took this off 1. Its prohibition on going above 3 rested on a 2-vCPU premise that is not this
  host (8 vCPU / 16 GiB), and on one unpaired concurrency 4 run at 94.2s. Superseded: see
  `docs/adr-0002-test-concurrency-measured-setting.md`.
- Raising concurrency was BLOCKED until web-uplift-tb6p: `testCredentialRedactorsAgree`
  asserted a wall-clock ratio between a cache-resident 160 kB measurement and a non-resident
  640 kB one, so it failed at concurrency 3 and 4 on both the split and the unsplit layouts.
  If a gate run ever fails there again, that is a machine-speed assertion, not the sweep.
- **The 6 setting was beaten by the browser launches it stacked, and that is what set 2.** Six suite
  processes can mean six Chrome instances launching at once; measured with the repo's own launcher on an
  idle VM, a launch is 3.3-4.7s to a CDP reply plus 5.0s more for the first session, so sessions queue
  and browser-bound cases cascade past their own 30s budgets (48 harness-bound expiries in one run, about
  1,900s of dead wall time, a 48s gate returning as 2,449s). The sweep now runs at **2** and is no longer
  per-landing. This table still holds: it is the measurement that chose 6 for the sweep as it was then
  defined, and it is why 8 was rejected.
- `npm run test:node` (`node --test --test-concurrency=1 tests/*.test.mjs`) pins concurrency to
  1 and is the serial escape hatch for a host too small for concurrent browser suites.

For iteration and implementer fast gates, several selective mechanisms are provided:

1. **Native node:test runner:** All 14 suites use native `node:test` and `node:assert/strict`.
   Run `node --test tests/evidence-conditions.test.mjs` or filter natively by pattern via
   `node --test --test-name-pattern="<regex>" tests/evidence-conditions.test.mjs`. Multi-suite
   execution is bounded by `--test-concurrency`: `npm test` runs the 14 files at concurrency 2,
   while `npm run test:node` (`node --test --test-concurrency=1 tests/*.test.mjs`) pins it to 1
   as the serial escape hatch for a host too small for concurrent browser suites.
2. **Direct suite execution:** Each `tests/*.test.mjs` suite can be run directly
   (e.g. `node tests/evidence-conditions.test.mjs`, `node tests/redaction.test.mjs`), with
   support for `--only <filter>`, `--filter`, `--grep`, and `--list`.
3. **Filterable regression tests:** `node tests/regression.mjs --only <filter>`
   runs only tests matching the given substring across all suites (e.g. `--only Flow`,
   `--only SafeFetch`, `--only Symlink`), `--list` enumerates all available tests,
   and multiple `--only` flags can be combined.
4. **Automated fast test gate:** `npm run test:fast` (or `node scripts/test-fast.mjs`)
   maps changed files (via `git diff $(git merge-base HEAD origin/master)` against the working tree,
   plus untracked files, or via explicit file paths) to
   their corresponding standalone and regression test targets. The run names the comparison BASE sha and
   how far the branch is ahead/behind the ref, and names every selected path that is not in HEAD as
   `[uncommitted: modified|untracked]` with one line saying the result describes the working tree and not
   HEAD alone: `fleet-check` caches a verdict under the committed tree it ran on, so a selection that
   contains uncommitted paths produces a green that sha does not describe (web-uplift-5e9s).

### Affected-only routing fails closed (web-uplift-5i9a)

The fast gate is affected-only, so a changed file that no suite maps is a **failure**, not a silent
baseline pass: a green gate that never ran the suite for a changed module is a false green. Concretely,
`node scripts/test-fast.mjs`:

- **REFUSES, before running anything** (exit 1), any changed path with an executable extension
  (`CODE_EXTENSIONS`, identical to the fleet's own `code_exts`: `.mjs`, `.js`, `.cjs`, `.ts`, `.tsx`,
  `.jsx`, `.py`, `.sh`, `.rs`, `.go`, `.c`, `.cpp`) that no `SUBSYSTEMS` entry maps. It prints one
  `fast-gate: unmapped: <path>` per path, then `fast-gate: FAIL - N changed file(s) map to no suite:` and a
  `NEXT ACTION` block on stderr, and exits 1 before dispatching any target - in `--dry-run` too, so a
  preview cannot look greener than the run. A mixed diff fails: the mapped half never buys a green verdict
  for the unmapped half. One narrow widening (web-uplift-tp77): an unmapped executable named by a
  **changed runnable test suite in the same diff** (quoted import/path/subprocess argument) selects that
  suite. Every such auto-map prints `auto-mapped <path> -> <suite>` even on success; unchanged suites are
  never searched. A name alone does not prove the suite exercises the module: review the printed pair
  against the suite behavior. Unmapped executable files in fixture/demo trees are NOT exceptions:
  `playground/**/*.js` and `eval/fixtures/seeded-issues/site/**/*.js` select
  `tests/fixture-sites.test.mjs`, which checks syntax, local imports and scenario metadata.
  This is structural coverage, not browser-behaviour coverage; `.github/workflows/audit-playground.yml`
  serves and probes both sites in CI. Other unmapped executable fixture/demo files remain refused.
- **NAMES THE ESCAPE in the same block.** A lane that cannot see the way forward adds its file to an
  omission rule to make the gate green, which is the silent narrowing this bead exists to stop, so the
  refusal says what to do: extend the map (`SUBSYSTEMS` for the covering suite, `KNOWN_STANDALONE_TESTS`
  for a suite that runs with no arguments), or declare the path in `OMITTED_RULES` with a reason. If the map
  cannot be extended now, the full gate is **not evidence on its own** for a refused path its tests do not
  exercise. `npm test` runs `tests/*.test.mjs`; the guarded standalone suites here are covered **only if**
  those files invoke their tests (directly or transitively). Import alone does not run these guarded tests;
  a module registering `node:test` cases at import time can instead run them on import. An unimported suite
  is likewise not covered. Check what actually executes, then run a suite covering a path not exercised by
  those files explicitly (for a
  refused `tests/*.mjs`, `node <path>`), then
  `FLEET_CHECK_CONF=/home/exedev/.fleet/conf.d/web-uplift.conf fleet-check`, and name the evidence command
  in the hand-off. Only a path with genuinely no suite belongs in an omission rule.
- **OMITS, by a named rule whose reason is printed**, a NON-EXECUTABLE changed path that no suite maps. The
  rules are `deleted`, `docs`, `media-and-markup`, `data-and-config`, `recorded-artefacts`,
  `agent-and-ci-config` and `fixture-and-demo-trees`. `node scripts/test-fast.mjs --list` prints each one
  with its reason, and that reason lives in `OMITTED_RULES` in `scripts/test-fast.mjs`. A rule only sees an
  executable path when it sets `mayOmitExecutable`, and exactly two do (`deleted`, `recorded-artefacts`:
  outputs of a run that no suite imports), so a tree, doc or data rule can never be the reason a changed
  module went untested. A diff whose changed paths are all omitted by a rule (documentation-only, or a
  deleted path that no subsystem maps) still runs the baseline four; a deleted file that a subsystem DOES
  map selects that subsystem's targets, and `runTarget` skips the missing file (P2-3).
- **PUBLISHES what ran** with the fleet's anchored markers: `fast-gate: running: <suite>`, then
  `fast-gate: passed: <suite>` or `fast-gate: failed: <suite>`. The suite is named by file, because that is
  what `fleet remote/check-coverage.py` matches against the diff; the record for a fast run can then state
  its coverage instead of `UNKNOWN` (fleet docs/speed.md R15).

The budget is a median under 60s (the fleet's `docs/speed.md` R2) for the fast gate, which is the
per-landing verification; the full sweep is not run per landing (see the testing section above).
`docs/speed.md` in this repo is the readable record: the routing policy, the omission
rules with their reasons, the escape, and the measurements with their provenance. It is not a fourth place
to drift - `tests/test-fast.mjs` parses its rule table and compares every reason cell to `OMITTED_RULES`,
specifically so a wrong-but-plausible reason with a right rule id fails.

`tests/test-fast.mjs` pins each of these, including that NO AUTHORED executable tracked path is omitted by
a rule while every non-executable tracked path is mapped or omitted, that the refusal names the escape, and
that AGENTS.md and `docs/speed.md` both state the rule ids. The full sweep (`npm test`) is not a
per-landing gate and has not been since 2026-10-28; it runs in the nightly factory audit.

### Fleet configuration (~/.fleet/check.conf)

To enable `fleet-check --fast` for this project across fleet lanes, configure
`~/.fleet/check.conf` with:

```bash
CHECK_CMD="npm test"
CHECK_TIMEOUT=2400
CHECK_FAST_CMD="npm run test:fast"
CHECK_FAST_TIMEOUT=300
```

`fleet-check --fast` then runs the affected subsystem tests in seconds and
records the cached verdict in `~/.fleet/checks/<tree>.fast.json`.

`~/.fleet/check.conf` is MACHINE-GLOBAL: on a shared VM an installer from another checkout can overwrite it
(web-uplift-ebvj, 2026-10-13), and a bare `fleet-check` would then run another project's command. Point the
wrapper at a config this project owns instead:

```bash
FLEET_CHECK_CONF=/home/exedev/.fleet/conf.d/web-uplift.conf fleet-check --fast
```

`docs/speed.md` is this project's speed record: gate budgets, the affected-only routing policy, the named
omission rules with the reason each path is skipped, the escape when the fast gate refuses a change, and the
measurements with their provenance. The policy is also executable - `node scripts/test-fast.mjs --list`
prints each rule and its reason from `OMITTED_RULES` - and the test suite walks both against that data.

## Releases & versioning

The single source of truth for the version is `package.json` (`version` field).
`bin/web-uplift.mjs` reads it via `pkg.version` and stamps it into the install
manifest at install/update time, so bumping `package.json` is the only manual
edit. The manifest also records `vendoredDependencies`: the name and version of
every package the install copies into `.web-uplift/node_modules`, which are in no
consumer lockfile and would otherwise be unrecorded. `.web-uplift/manifest.json` is
generated on install/prepare under `.web-uplift/` (which is gitignored).

**Where the version literal must agree** (grep `0.1.x` before tagging):

- `package.json` (canonical)
- `.web-uplift/manifest.json` (generated by prepare / install)

**Skill files are version-coupled.** `.claude/skills/web-audit/SKILL.md` is the
canonical skill; every per-agent entry point (`.codex`, `.opencode`, `.github`,
`.agents`, `.pi`, the vendored `.web-uplift/skill/SKILL.md`) is a copy produced by
`web-uplift install`. If you change the skill, bump the version and republish so
`npx web-uplift install` ships the fix.

**SKILL.md frontmatter must be valid YAML.** The `description:` value is a long
single-line scalar that frequently contains `word: word` (colon + space). An
unquoted plain scalar with `: ` inside is parsed as a nested mapping and throws
`Nested mappings are not allowed in compact mappings`, which makes agent skill
loaders (pi, Claude Code, Codex) silently reject the skill. Therefore:

- Keep `description` wrapped in double quotes: `description: "..."`.
- Before tagging, sanity-check with the agent's own parser, e.g.
  `node -e 'import("yaml").then(y=>y.parse(require("fs").readFileSync(".claude/skills/web-audit/SKILL.md","utf8").split("---")[1]))'`
  must not throw.
- Avoid em dashes in the description and body (house rule).

**Bump procedure** (use semver: patch for fixes, minor for new features, major
for breaking skill/schema changes):

1. Edit `package.json` to the new version (`npm run prepare` regenerates `.web-uplift/manifest.json`).
2. Regenerate installed skill copies so the repo is self-consistent:
   `node bin/web-uplift.mjs install --agent all`.
3. `npm test` (the 9 suites) and spot-check the frontmatter parser above.
4. `git commit -m "chore: release v<VERSION>"`.
5. `npm publish` (publishes `bin/`, `evidence/`, `runner/`, `fixer/`,
   `aggregate/`, `index.mjs`, `mcp/`, `knowledge/`, `schema/`, `tests/`, and the
   `.claude/skills/web-audit/SKILL.md`, and the root `install-surface.mjs` the
   installer imports, per the `files` allowlist).
6. `git tag v<VERSION> && git push && git push --tags`.

### Current release: v0.5.0

Minor over v0.4.2, cut on 2026-10-06 from the same audit line. Three defects fixed,
one record added, and the skill change that makes a release necessary at all:

- **Fix mode requires an operator-supplied isolation assertion** and scopes every
  agent run; a refused run publishes nothing. The tool still does not sandbox the
  agent, and README.md ("Running it safely") states what the boundary must
  guarantee; the CHANGELOG entry is the precise version of what changed.
- **The axe primitive audits the page under the page's own policy.** The policy used
  to be lifted before navigation, so the page's own blocked scripts ran during the
  audit and the result never said so. It is now lifted only for the injection of
  the vendored engine, and `cspBypassedForInjection`/`cspBypassNote` record that it
  happened, so a reader can tell such a run from one with no bypass.
- **The headers primitive matches header names case-insensitively and reports three
  states per header** - absent, present with a value, present but empty. A
  capitalised response previously reported every security header as absent, and an
  empty value now reads as neither missing nor satisfied. `present` for
  `x-content-type-options` means "the response sent the header"; `issues` carries
  the value judgement.
- **The install manifest records the vendored dependency tree**
  (`vendoredDependencies`), which no consumer lockfile covers.
- **`conditions` records the emulation profile a run was measured under** -
  `profile` (`mobile` or `desktop`), `deviceScaleFactor` and `mobile`, alongside the
  dimensions - so an artifact can be read without having watched stderr. A run with
  no device-metrics override still records no profile rather than an invented one.
- The skill's frontmatter `description` is wrapped over several lines, with the
  parsed value unchanged. That is the change that made this release necessary:
  installs only pick up a skill fix when the version the installer sees moves.

### Current release: v0.4.2

Patch over v0.4.1. Fixes the intermittent `npm test` failure in the evidence
harness and adds a regression guard. Chrome for Testing 154 sometimes boots with
an empty `/json/list` because the default New Tab fails to load (`incorrect
profile type`); `newSession()` read that list through a bare `CDP({ port })` and
assumed a default page target existed, so roughly 1 in 3 browser boots threw
`No inspectable targets` and the suite could not be used as a merge gate.
`newSession()` now creates its own target through the `/json/new` HTTP endpoint
and attaches to the returned WebSocket URL directly, with a bounded retry only
for the start-up race, so it no longer depends on a default page existing. The
public API is unchanged (`newSession(port) -> { client, targetId, close }`).
`tests/launch-loop.mjs` is a new guard that runs the launch plus session loop and
fails on any miss.

The same tree also carries `docs/aoo-first-increment.md` and
`evidence-out/aoo-increment/`: the first increment proposal for the two high
findings (F-001 no dark mode, F-005 1.19MB fonts) on paul.kinlan.me, with the
live re-verification artifacts. Documentation and evidence only, no runtime
behaviour. v0.4.1, the previous release, added `a11ytree --max-nodes/--max-stops`.

v0.4.0, the previous release, introduced the six evidence primitives built since
v0.3.0 (`axe`, `console`, `targets`, `features`, `resilience`, `a11ytree`), the
evidence-honesty work (every cap reported, report-shape validation, the
`censusComplete` and truncation signals) and the skill rule that a miss in a
truncated sample is not absence.

<!-- web-uplift:install -->
## web-uplift (modern-web audit + fix)

When asked to web-audit, UX-audit, uplift, modernise, or quality-audit a site, read `.web-uplift/skill/SKILL.md` and follow it exactly. Gather evidence with `node .web-uplift/evidence/cli.mjs <primitive> <url> [options]` (raw CDP). `--fix --source <dir>` runs the model-driven hill-climb.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
