# ADR 0002: Test-file concurrency is a measured setting, superseding the 2-vCPU sequential mandate

- **Status**: Accepted. **Decision 1 is superseded by [ADR 0004](adr-0004-full-sweep-concurrency-2.md)
  (2026-10-28)**: the sweep runs at concurrency 2 and is no longer a per-landing gate. The rule this ADR
  establishes, that concurrency is a measured setting recorded with its measurement rather than a fixed
  mandate, stands and is exactly what ADR 0004 applies.
- **Date**: 2026-10-13
- **Supersedes**: the concurrency clause of [ADR 0001](adr-0001-test-and-evidence-decomposition.md)
  decision 3 ("Native Test Runner Adoption") and the premise of its decision 4
  alternatives-rejected #4. ADR 0001 is NOT withdrawn: its decomposition decisions (evidence
  modularisation, the fast gate, vendored-surface lifecycle, modular suite partitioning) stand.
- **Related Beads**: `web-uplift-f5mb` (the suite split, the measurement and the change),
  `web-uplift-jgkj` (the alphabetical-order scheduling tail, not fixed here), `web-uplift-wo80`
  (the case that fails at concurrency 8), `web-uplift-o4ec`, `web-uplift-bop3`, `web-uplift-tb6p`
- **Deciders**: `web-uplift-coord` (ruling 2026-10-13, on its own hardware check), `web-uplift-split-suite`

---

## Context

ADR 0001 decision 3 wired `--test-concurrency=1` into the gate "to ensure test files execute sequentially
on 2-vCPU VMs, preventing port collisions and RAM starvation", and its alternatives-rejected #4 reasoned
the same way: "Running browser tests concurrently across multiple child processes causes port exhaustion
and CPU starvation on 2-vCPU VMs, resulting in flaky timeout failures. Enforcing sequential execution for
browser workloads while parallelizing unit tests struck the necessary balance."

Two things have changed since, and both are matters of fact rather than preference.

**The host is not a 2-vCPU host.** This project's VM is 8 vCPU / 16 GiB. `web-uplift-coord` verified it
directly on 2026-10-13 rather than taking a document's word: `nproc` = 8, `/proc/cpuinfo` = 8,
MemTotal 15985 MB. The fleet's architect-owned standard (`~/fleet/docs/speed.md`, section 1) says the same
of every project VM: "**Hardware is not a lever.** Every project VM is 8 vCPU / 16 GiB and that is
adequate. A gate that is slow is slow because the suite is serialised, untiered, monolithic, or
rebuilding the world, never because the box is small." A sequential mandate justified by a 2-vCPU shape
does not survive on a host that is not that shape.

**The runner had already moved off 1, on measurement.** `web-uplift-tb6p` (2026-10-12) set the gate to
concurrency 3 from paired runs in one window: mean 134.8s at 2 against 98.3s at 3, about 1.4x. Decision
3's `--test-concurrency=1` was therefore already superseded in practice, by evidence, before this ADR.

**What the concurrency limit actually is.** Before keeping the number low, the suites were audited rather
than assumed (`web-uplift-f5mb`): every test HTTP/net server binds an ephemeral port
(`server.listen(0, ...)`), Chrome is launched with `--remote-debugging-port=0`, and each suite file
process gets its own `mkdtempSync` root, so two files cannot collide on a port, a profile directory or a
temp path. The two literal debug ports in `tests/chrome-cdp.test.mjs` (9222, 9223) are strings written by
a FAKE `CHROME_BIN` script that binds nothing. Port exhaustion is not the binding constraint; RAM is
(the reaper kills a job tree over 3 GB), and RAM is measurable.

## Decision

**The gate's file concurrency is a measured setting recorded with its measurement, not a fixed mandate.**

1. `npm test` runs `node --test --test-concurrency=6 tests/*.test.mjs`. **[SUPERSEDED 2026-10-28: the setting
   is now 2 and the sweep is no longer a per-landing gate; see ADR 0004. The measurement below is kept because
   it is what chose 6 for the sweep as it was then defined, and it is why 8 is rejected.]** The setting was
   chosen from paired runs in one window, 3 samples per arm, load recorded beside every run, in the tree that
   would ship it (`docs/speed.md`, "What the gate's wall time is made of"):

   | arm | median | runs | failed | peak job-tree RSS |
   | --- | --- | --- | --- | --- |
   | 10 files, concurrency 3 (before the split) | 99.1s | 105.1, 99.1, 96.4 | 0/3 | 490-530 MB |
   | 14 files, concurrency 3 | 82.6s | 82.6, 96.0, 80.6 | 0/3 | 497-708 MB |
   | 14 files, concurrency 6 | **66.2s** | 67.9, 60.8, 66.2 | 0/3 | 863-914 MB |
   | 14 files, concurrency 8 | 74.3s | 74.3, 56.5, 80.8 | 2/3 | 961-1033 MB |

   Concurrency 8 is rejected on both speed and safety: it is slower than 6 and 2 of its 3 runs failed on
   `testOversizedBodyDoesNotEarnACleanVerdict` (`web-uplift-wo80`), a case that asserts on the reader's
   scheduling. Peak job-tree RSS at the chosen setting is 863-914 MB against the reaper's 3 GB.
2. **ADR 0001 decision 3's sequential clause is superseded** for this repository. `npm run test:node`
   (`--test-concurrency=1`) is retained as the serial escape hatch for a genuinely small host; it is a
   tool, not the default.
3. **The fast gate is not part of this decision and did not move.** `npm run test:fast` does not read
   `npm test`'s concurrency, its `runTarget` loop is serial, and its `evidence` targets are `--only`
   regression filters rather than suite files, so the split and the concurrency change leave its target
   set and order alone. If any change to the full gate moves the fast gate, the fast gate wins.
4. **A higher number is not itself a goal, and the model is not the authority.** A list-schedule fitted to
   per-file wall times predicted 3 -> 76s, 6 -> 45s, 8 -> 37s; the measurements were 82.6s, 66.2s, 74.3s,
   because per-file times do not survive N-way contention on browser-and-parser-bound suites. The paired
   runs decided, and they decided against the highest number.

## Consequences

**Positive.** The gate uses the host it actually has; the setting is a measurement again rather than an
assumption about a machine this project does not run on; and the RAM ceiling is recorded as a number
(863-914 MB against a 3 GB limit) instead of being discovered when a lane loses a run to the reaper.

**Negative and neutral.** A higher number multiplies the ways a machine-speed assertion can fail under
load, which is exactly what happened at 8 and is the P3 pathology in `~/fleet/docs/speed.md` section 3.
The number is also now a thing that can go stale, so it is recorded beside its measurement rather than in
prose alone, and `AGENTS.md` carries the same table.

**Not fixed here.** `node --test` sorts test files alphabetically and ignores the order the paths are
given in, which leaves roughly 12s of tail at concurrency 3 (75.6s measured against the 63.9s floor). That
is `web-uplift-jgkj`, a sharded launcher; this ADR does not claim it. Nor does it fix
`web-uplift-wo80`, the case that fails at concurrency 8.

## What was wrong with it, found on 2026-10-28

The arms above measured wall time, failed runs and RSS, and they were paired and honest. What they did not
measure is the axis that broke: six suite processes can mean six Chrome instances launching at once, and the
launch is the expensive thing here (3.3-4.7s to a CDP reply plus 5.0s for the first session, measured with the
repo's own launcher). Under that oversubscription browser-bound cases cascade past their own 30s budgets: 48
harness-bound expiries in one run, ~1,900s of dead wall time, and a 48s gate returning as 2,449s. A setting can
win every number in a table and still lose the property the table was standing in for. See ADR 0004.
