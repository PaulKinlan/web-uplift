#!/usr/bin/env node
// SUITE CONVENTION, learned the expensive way (web-uplift-17o): a test that needs a local
// server must drive the CLI IN-PROCESS via gather() - NOT by running the CLI as a child with
// an in-process server. spawnSync blocks the parent's event loop, so the in-process server
// never answers the child's browser (observed directly: zero server hits and a 30s timeout
// on a HEALTHY page, for trace and dom alike). Worse, that failure mode MIMICS a starvation
// defect: a healthy page simply times out, indistinguishable from the behaviour under test,
// so a harness built that way cannot observe the behaviour it exists to check. The --out
// argument-validation tests are the exception: they exit before any browser launches, so a
// child run with an in-process server is safe there.
//
// THE REGISTRY AGGREGATES, IT DOES NOT NAME CASES (web-uplift-jyyq). Each suite file owns its cases: it
// exports the list it runs (the same list `npm test` executes), and this file DISCOVERS the suite files and
// collects those lists. Adding a case therefore edits its owning suite and nothing else, and a new suite
// file is picked up without touching this one. Until this change the registry duplicated every name as an
// import plus an ALL_TESTS entry: 166 of 331 first-parent commits in 30 days touched this central file,
// making it the largest git-collision surface in the repository for no coverage benefit, because `npm test`
// runs the suite files directly and only `--only`/`--list` come through here.
//
// ORDER is deterministic: suite files sorted by name, each suite's own order. The old registry interleaved
// some suites in more than one block, which whole-suite aggregation cannot reproduce; that is benign for a
// manual `--only`/`--list` escape hatch whose cases are independent (npm test's order is per-file anyway).
// testSuiteListsMatchRegressionRegistry holds the invariant: the union of the suite lists is exactly what
// this file lists, every case appears once, no suite is empty, and no suite file hides a case its own list
// does not run.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runSuite } from './test-helpers.mjs';

const suiteDir = dirname(fileURLToPath(import.meta.url));

// Discovery, not a hand-maintained list: every tests/*.test.mjs is a suite, and its ONE exported array is
// the list of cases it runs. A suite that exports no list (or more than one) fails loudly here rather than
// being silently absent from the registry.
const suiteFiles = readdirSync(suiteDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

const ALL_TESTS = [];
for (const file of suiteFiles) {
  const mod = await import(`./${file}`);
  const lists = Object.entries(mod).filter(([, value]) => Array.isArray(value));
  if (lists.length !== 1) {
    throw new Error(
      `tests/${file} must export exactly one array of its cases (found ${lists.length}: ${lists.map(([k]) => k).join(', ') || 'none'}). ` +
        'The registry aggregates that array, so a suite with two arrays or none cannot be aggregated unambiguously.',
    );
  }
  const [, cases] = lists[0];
  for (const fn of cases) {
    if (typeof fn !== 'function' || !/^test[A-Za-z0-9_]+$/.test(fn.name)) {
      throw new Error(`tests/${file} lists an entry that is not a test function: ${String(fn)}`);
    }
  }
  ALL_TESTS.push(...cases);
}

export { ALL_TESTS };

await runSuite(ALL_TESTS, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
