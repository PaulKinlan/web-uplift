# Model-led floor run: provenance record (web-uplift-cpa)

This run exists because the hub ruled (F1 = option a): the floor must come from
ONE GENUINE MODEL-LED RUN using the repo's OWN runner, not from any deterministic
harness. **The score numbers below are NOT reproducible by design** (a model-led
audit is non-deterministic); what this record makes reproducible is the
PROVENANCE of the run.

**Attestation levels.** The model, per-run turns/cost/denials, coverage, and
terminal status are independently recoverable from the committed run dirs
(`<target>/run.json`, `<target>/report.json`). The CLI version and binary path,
the exact invocation, and the prompt/runner/corpus commit refs are
OPERATOR-ATTESTED: they are not independently recoverable from the committed
artifacts, so the attesting outputs are committed alongside this file in
`OPERATOR-ATTESTED.txt` (captured `claude --version`, `which claude`, the exact
invocation, the `git log` output for the corpus ref, and the repo commit the
runner ran at).

## Instrument (web-uplift's own, unmodified)

- **Runner:** `runner/run-batch.mjs` (the repo's batch orchestrator; it contains
  no checks). No CHECK-DECIDING script was written for this run; nothing in it
  decides check outcomes except the model applying the skill. (The
  `<target>/scratch/` files committed here - `manifest.mjs`, `flow-probe.js` and
  similar - were authored BY THE AGENT during its own run as evidence-gathering
  and coverage-manifest probes, which the skill explicitly instructs it to keep
  in the run's scratch dir; they gather and organise evidence, they do not
  judge checks.)
- **Repo commit:** `8ada339` (`origin/master` at run time; branch
  `fleet/mwg-drift-cpa` carries only this evidence-out/ directory).
  (Operator-attested; see `OPERATOR-ATTESTED.txt`.)
- **Prompt source:** the `/web-audit` slash command, i.e.
  `.claude/skills/web-audit/SKILL.md` @ `8ada339`, with the skill-contract
  scoped Bash allowlist (7tj) enforced by the claude CLI
  (`--allowedTools Read,Write,Edit,Glob,Grep,Bash(node evidence/cli.mjs:*)...`).
- **Exact command:**
  ```sh
  python3 -m http.server 8765 --directory /tmp/mwg-train/docs/eval/targets &
  node runner/run-batch.mjs --agent claude --concurrency 1 \
    --urls /tmp/cpa-urls.txt --out reports-cpa --max-turns 80 \
    --isolation host-permission-model
  ```
  run gated + bounded (`fleet-gate cpa-batch -t 5400`); gate exit 0 after 3427s,
  `Done. 0 failure(s)`; every run `terminal_reason: completed`, 58/58 checks
  judged per target (`coverage.complete: true`).
- **Isolation assertion:** `operator-supplied:host-permission-model`, recorded
  in `run-security.json` with its own `unverified: true` qualifier (the tool
  records, it does not verify). Naming note: the scoped CLI allowlist is NOT an
  execution sandbox - `runner/agents.mjs` says so verbatim ("This list narrows
  which commands are reachable; it is NOT an execution sandbox, and container/VM
  isolation stays the enforcement boundary for untrusted sites"). The assertion
  names the permission model because that is the mechanism that actually
  constrains the agent on this run; it is not a claim of confinement.
  Judgement recorded on web-uplift-cpa: a `vm` assertion would not protect the
  agent-writable `latest` pointer (same filesystem), and the fixtures are
  trusted static content served from localhost.

## Agent and MODEL (captured, not guessed)

- **Agent CLI:** `claude` (Claude Code) **v2.1.284**, `/usr/local/bin/claude`,
  headless `-p` mode, `--output-format json`. (Operator-attested; captured
  outputs in `OPERATOR-ATTESTED.txt`.)
- **Model:** **`claude-opus-5-5`** (`canonicalModel`, provider `firstParty`,
  costBasis `list`), read from each run's `run.json` `modelUsage` - identical
  in all 5 runs.
- **Per-run usage** (from `<target>/run.json`):

  | target | turns | cost USD | permission denials |
  |---|---|---|---|
  | booking | 91 | 3.95 | 17 |
  | account-recovery | 83 | 3.94 | 11 |
  | catalogue | 76 | 4.42 | 5 |
  | contact-lead | 108 | 4.91 | 9 |
  | event-registration | 98 | 4.98 | 8 |

  Permission denials are the scoped allowlist working as designed: the agent
  probed non-contract forms (`curl`, `node -e`, compound shell), was refused,
  and completed using only the skill-declared primitives. No denial blocked
  evidence gathering (58/58 coverage in every run).

## Corpus (mwg-train's, unchanged)

- **Ref:** `mwg-train @ 44424fb37feabeb44ab2cae91a8b5a7031b99893`
  (`Merge fleet/6ek`), clone at `/tmp/mwg-train` (ref verified before serving;
  verification output in `OPERATOR-ATTESTED.txt`).
- **Targets:** the 5 held-out eval targets in `docs/eval/targets/`
  (booking, account-recovery, catalogue, contact-lead, event-registration) -
  the sealed measurement set per mwg-train's own docs ("The sealed eval set is
  never trained on - it exists only to measure"). Served read-only by
  `python3 -m http.server 8765`; server lifetime scoped inside the gate.
- **Ruleset:** `modern-web-guidance@0.0.193` (17 principles, 58 checks,
  catalog sha256 `5cb6b09a...82b7` as recorded in each report's coverage).

## Timestamps

- Run window: 2026-10-09T00:06:22Z to 2026-10-09T01:03Z (gate log
  `/tmp/mwg-drift-cpa-batch.log`).
- Run dirs: `<target>/` here = `reports-cpa/127_0_0_1_8765/<runId>/` copied
  verbatim (report.json, report.md, run.json, write-scope.json, launches.jsonl,
  evidence/, scratch/).

## Floor (per-target scorecards regenerated with the repo's own
`aggregate/scorecard.mjs`, one run per host-root)

| target | overall | speed | memory | usability | inclusive | discoverable | trust | findings (c/h/m/l) |
|---|---|---|---|---|---|---|---|---|
| booking | 86 | 95 | 100 | 79 | 83 | 85 | 76 | 14 (0/2/6/6) |
| account-recovery | 85 | 95 | 100 | 73 | 83 | 85 | 75 | 15 (1/2/7/5) |
| catalogue | 86 | 95 | 100 | 72 | 83 | 85 | 78 | 20 (1/1/7/11) |
| contact-lead | 86 | 93 | 100 | 66 | 95 | 85 | 76 | 18 (1/1/8/8) |
| event-registration | 79 | 93 | 100 | 68 | 77 | 65 | 71 | 20 (1/2/9/8) |
| **mean** | **84.4** | 94.2 | 100 | 71.6 | 84.2 | 81.0 | 75.2 | 87 total |

No previously computed delta is carried forward.

**Not directly comparable.** The model-led floor above (84.4/100) and the
rejected proxy harness's number (94.4/100) come from DIFFERENT INSTRUMENTS with
different judgement rules, so the two numbers are not directly comparable and
no measured delta between them is claimed here. Separately, as a matter of
record, this run SUPERSEDES the proxy run as the floor of record: the proxy
path was rejected by the hub ruling, whatever its number was. Any analysis of
WHY the instruments diverge (for example the proxy's contextual free passes on
native-only validation, 404 submit flows, and bare-host headers) is a matter
for the review and the hub, not a measurement asserted by this record.
