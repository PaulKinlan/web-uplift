# web-uplift-7tj evidence: allowlist A/B on the real `claude` engine

Date: 2026-10-06. Worktree `~/worktrees/web-uplift-7tj`, branch `fleet/7tj`.

## Claim under test

The derived headless allowlist (commit 5a04a88: `SKILL_REQUIRED_COMMANDS` ->
`headlessBashRules()` in `runner/agents.mjs`) admits the six command forms the
OLD scoped allowlist (as of `5a04a88^`, introduced by e2138c9) denied, and the
old one denies them. Proven through the REAL `claude` CLI (v2.1.284), not by
simulating a matcher.

## Method (`ab-probe.mjs`)

Both arms spawn the real CLI with the production argv shape from
`runner/run-batch.mjs`: `AGENTS.claude.args(prompt, { maxTurns, root: <repo> })`
-> `claude -p <prompt> --output-format json --max-turns 30 --allowedTools
'Read,Write,Edit,Glob,Grep,<rules>'`, cwd = the repo root. The ONLY difference
between arms is the `--allowedTools` value:

- OLD arm: the literal list from `git show 5a04a88^:runner/agents.mjs`
  (evidence CLI repo-relative + vendored, pinned guidance, mkdir, ffmpeg).
- NEW arm: `headlessBashRules({ root: <repo> })` exactly as production derives
  it (six scripts x four spellings + guidance + mkdir + ffmpeg).

The prompt instructs the model to attempt each of the six commands with Bash
exactly once, in order, no retries, no other tools; a usage message or nonzero
exit counts as EXECUTED, only a permission/approval error counts as DENIED; then
report one `N: ALLOWED|DENIED` line per command. The six commands are the five
scripts the old list did not name plus the ABSOLUTE-path evidence-CLI spelling
the old prefix rules missed, each with harmless arguments (usage output only):

1. `node schema/validate-report.mjs knowledge/principles.json`
2. `node aggregate/compare.mjs example.invalid`
3. `node aggregate/scorecard.mjs example.invalid`
4. `node knowledge/baseline.mjs --json`
5. `node runner/flow.mjs --help`
6. `node /home/exedev/worktrees/web-uplift-7tj/evidence/cli.mjs --help`

Two independent verdict sources: the model's six-line report AND the
machine-recorded `permission_denials` array in the CLI's own result JSON.

## Result: PASS

| Arm | turns | secs | machine `permission_denials` | model verdicts |
|---|---|---|---|---|
| OLD (`5a04a88^`) | 7 | 20.2 | 6 entries, one per command above | 1-6: DENIED |
| NEW (`5a04a88`)  | 7 | 20.4 | `[]` (none) | 1-6: ALLOWED |

Raw outputs: `ab-old-allowlist.json`, `ab-new-allowlist.json` (full argv,
exit code, result text, permission_denials). Under the old allowlist every
attempt was refused by the permission system (the CLI itself recorded all six
tool_use ids); under the new one every attempt executed (usage output, exit
clean) and nothing was denied.

## Bounded real audit attempt (same day, follow-up)

A real headless audit was also attempted through the production runner
(`npm run batch -- https://paul.kinlan.me --agent claude --max-turns 80`, the
spawn line in `audit-run-stdout.txt` shows the full derived `--allowedTools`
list in production). Operator-bounded at 600s; the runner exited 124 at the
bound with the audit mid-flight. Before the cut the agent had produced 53
artifact files under the run's `evidence/` (40 JSON: axe, a11ytree, cookies,
discoverability, layout, screenshots, ...) over ~9.5 minutes, and the streamed
log contains ZERO permission denials (grep -ci 'permission|denied' -> 0).
What was NOT reached: `report.json` + schema validation (skill step 6), so
end-to-end audit COMPLETION remains unverified; only the permission mechanism
(the 7tj blocker) is proven fixed on the real engine. `runner/README.md` states
exactly this.

## Not exercised here

End-to-end audit completion (report.json + schema validation) was not reached
inside the 10-minute bound above; that remains the one unverified claim.
