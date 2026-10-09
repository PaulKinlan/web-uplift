# Model-led floor run: provenance record (web-uplift-cpa)

This run exists because the hub ruled (F1 = option a): the floor must come from
ONE GENUINE MODEL-LED RUN using the repo's OWN runner, not from any deterministic
harness. **The score numbers below are NOT reproducible by design** (a model-led
audit is non-deterministic); what this record makes reproducible is the
PROVENANCE of the run.

## Instrument (web-uplift's own, unmodified)

- **Runner:** `runner/run-batch.mjs` (the repo's batch orchestrator; it contains
  no checks). No scripts were written for this run; nothing in this run decides
  check outcomes except the model applying the skill.
- **Repo commit:** `8ada339` (`origin/master` at run time; branch
  `fleet/mwg-drift-cpa` carries only this evidence-out/ directory).
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
  in `run-security.json` (the claude CLI's scoped permission model is the
  boundary; the tool records, it does not verify). Judgement recorded on
  web-uplift-cpa: a `vm` assertion would not protect the agent-writable
  `latest` pointer (same filesystem); the scoped allowlist is the mechanism
  that actually constrains the agent, and the fixtures are trusted static
  content served from localhost.

## Agent and MODEL (captured, not guessed)

- **Agent CLI:** `claude` (Claude Code) **v2.1.284**, `/usr/local/bin/claude`,
  headless `-p` mode, `--output-format json`.
- **Model:** **`claude-opus-5-5`** (`canonicalModel`, provider `firstParty`,
  costBasis `list`), read from each run's `run.json` `modelUsage` — identical
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
  (`Merge fleet/6ek`), clone at `/tmp/mwg-train` (ref verified before serving).
- **Targets:** the 5 held-out eval targets in `docs/eval/targets/`
  (booking, account-recovery, catalogue, contact-lead, event-registration) —
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

No previously computed delta is carried forward. This run supersedes the
proxy-harness numbers (94.4/100, 22 findings) produced by the rejected
deterministic path; the comparison and the reasons the model-led floor is
harsher are for the review and the hub, not for this record.
