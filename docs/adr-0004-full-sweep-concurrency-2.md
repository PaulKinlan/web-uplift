# ADR 0004: The full sweep runs two suites at a time and is not a per-landing gate

- **Status**: Accepted
- **Date**: 2026-10-28
- **Supersedes**: [ADR 0002](adr-0002-test-concurrency-measured-setting.md) decision 1 (the concurrency
  value) and, as a consequence, the "full regression suite runs once per landing" clause of
  [ADR 0001](adr-0001-test-and-evidence-decomposition.md) decision 2. Neither ADR is withdrawn: ADR 0002's
  rule that concurrency is a measured setting rather than a fixed mandate is what this decision applies, and
  ADR 0001's decomposition decisions stand.
- **Related Beads**: `web-uplift-91lr` (the launch-cost measurement and the 6-way failure),
  `web-uplift-7l6y` (the documents this supersession corrects), `web-uplift-gpbd` (fast gate target costs)
- **Deciders**: hub ruling, 2026-10-28, relayed to this project's lanes

---

## Context

ADR 0002 chose `--test-concurrency=6` from paired runs and was right about what it measured: at 6 the 14
suites finished in 66.2s median, faster than 3 (82.6s) and than 8 (74.3s, which also flaked). The arms
recorded wall time, failed runs and peak job-tree RSS.

What they did not record is Chrome launches. Six suite processes can mean six browsers starting at once, and
a launch is the expensive operation in this repo: measured with its own launcher on an otherwise idle VM,
3.3-4.7s to a CDP reply and 5.0s more for the first session (`web-uplift-91lr`). Under six of those
simultaneously, sessions queue behind each other, and browser-bound cases cascade past the 30s budgets they
carry: **48 harness-bound expiries in one run, about 1,900s of dead wall time, and a 48s gate returning as
2,449s.** The setting was not too slow; it was oversubscribed.

At the same time the fleet settled what the sweep is for. The fast gate selects targets from mapped changed
paths and publishes coverage for them, so it can verify a change; the full sweep's job is to catch what a
change-scoped selection cannot see, which is a periodic job rather than a per-landing one.

## Decision

1. **`npm test` runs `node --test --test-concurrency=2 tests/*.test.mjs`.**
2. **The full sweep is not a per-landing gate.** A landing requires a verified fast gate (with mapped change
   coverage, its budget recorded in `docs/speed.md`) plus an independent cross-family review. The full
   multi-browser sweep is deferred to the **nightly factory audit**.
3. **This is the smaller change, deliberately.** It removes the oversubscription rather than giving the
   per-case timeouts more room, and it does not weaken an assertion.

## Consequences

**Positive.** The browser launches stop queueing against each other, which is where the 2,449s went; a lane
no longer spends a full sweep on a lockfile change; and the sweep's remaining job, catching what a
change-scoped selection misses, is scheduled where it belongs.

**Negative and neutral, stated plainly.**

- **The number 2 does not yet carry the paired measurement ADR 0002 requires.** What is measured is the
  failure at 6 and the launch cost that explains it. What is not yet measured is wall time, failed runs and
  peak job-tree RSS at 2, in one window with the load recorded beside every run. The first nightly sweep's
  wall time is where that comes from; until it exists, 2 is a reasoned setting with a measured failure behind
  it. `docs/speed.md` says the same in the "full sweep" section, and the measurement belongs there when
  someone takes it, not in a bead comment.
- **The 2026-10-13 tables in `docs/speed.md` and `AGENTS.md` are historical.** They are kept, because they
  are the evidence that chose 6 for the sweep as it was then defined and that rejects 8. They no longer
  describe the current setting, and both files now say so beside the table rather than only here.
- **No per-landing full-gate pass is recorded anywhere any more.** That is the point of decision 2, but it
  means a regression visible only to the whole sweep is caught up to a day later. The nightly audit's
  result is the record that closes that gap, so a nightly failure is a landing-blocking bug, not a note.

## What this ADR does not decide

`web-uplift-jgkj` (a sharded launcher that would remove the alphabetical scheduling tail) and
`web-uplift-wo80` (`testOversizedBodyDoesNotEarnACleanVerdict`, the case that fails at concurrency 8) are
untouched. `web-uplift-gpbd` and `web-uplift-3jzf` cover the fast gate's own target costs, which is where
per-landing time is now actually spent.
