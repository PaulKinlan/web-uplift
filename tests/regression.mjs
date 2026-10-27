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
import { parseFilterArgs, runSuite } from './test-helpers.mjs';

const suiteDir = dirname(fileURLToPath(import.meta.url));

// Discovery, not a hand-maintained list: every tests/*.test.mjs is a suite, and its ONE exported array is
// the list of cases it runs. A suite that exports no list (or more than one) fails loudly here rather than
// being silently absent from the registry.
const suiteFiles = readdirSync(suiteDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

// --exclude-suite <name> (repeatable) leaves a suite file OUT of THIS run (web-uplift-91lr). The fast gate
// uses it when the same suite is already scheduled as a whole-suite target: the direct target runs every case,
// so a filter that re-runs some of them is duplicate work, not extra coverage. Accepts 'tests/x.test.mjs',
// 'x.test.mjs' or 'x', because the caller should not have to know which spelling this file uses.
const excludeSuites = new Set();
for (let i = process.argv.length - 1; i >= 0; i -= 1) {
  if (process.argv[i] === '--exclude-suite' && process.argv[i + 1]) {
    const raw = process.argv[i + 1].trim().replace(/^tests\//, '').replace(/\.test\.mjs$/, '');
    excludeSuites.add(raw);
    // Splice the pair OUT: runSuite parses the same argv with parseFilterArgs, which refuses unknown flags, and
    // it has no business knowing about a gate-level exclusion.
    process.argv.splice(i, 2);
  }
}
const isExcluded = (file) => excludeSuites.has(file.replace(/\.test\.mjs$/, ''));

const ALL_TESTS = [];
const RUN_TESTS = [];
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
  if (!isExcluded(file)) RUN_TESTS.push(...cases);
}

export { ALL_TESTS };

// Say it on stderr: --list output is machine-read by the coverage check, and an informational line in the
// middle of a case-name list would be read as a case name.
if (excludeSuites.size > 0 && !process.argv.includes('--list')) {
  console.error(`[regression] ${excludeSuites.size} suite(s) left out of this run because a whole-suite target already runs them: ${[...excludeSuites].join(', ')}`);
}

// An empty selection after an EXCLUSION is not a failure: the cases exist and the suite's own direct target
// runs them, so this filter has nothing left to do. It is only reachable when a suite was deliberately left
// out, and an empty selection WITHOUT one still fails as it always did (runSuite does that, below) - a typo'd
// filter must never certify a target that never ran. The match rule is parseFilterArgs's rule, read back the
// same way runSuite reads it, and the gate's self-test cross-checks this against a real filtered run rather
// than trusting the duplicate.
// The filter is validated against the PRE-DEDUPE population, before any exclusion can hide it (web-uplift-4k7l).
// The first cut of this checked only what was left after the exclusions, so `--only NonExistentTest
// --exclude-suite tests/redaction.test.mjs` matched nothing at all and still exited 0: a typo'd filter, or a
// filter naming a renamed case, would have run nothing and reported success. That is the fail-open this whole
// fortnight has been about, and it is the difference between the two empty cases below:
//
//   matched nothing BEFORE the exclusions  -> exit 1. The filter itself is wrong; the gate must not certify it.
//   matched something before, nothing after -> exit 0, naming the suites that took the cases. The cases exist
//                                             and the whole-suite targets run them; this filter is simply done.
if (excludeSuites.size > 0) {
  const { filters } = parseFilterArgs(process.argv.slice(2));
  const matches = (pool) => pool.filter((fn) => filters.some((f) => fn.name.toLowerCase().includes(f.toLowerCase())));
  if (filters.length > 0) {
    if (matches(ALL_TESTS).length === 0) {
      console.error(
        `no tests matched filter: ${filters.join(', ')} - not before and not after leaving out ` +
          `${[...excludeSuites].join(', ')}, so this filter names no case that exists`,
      );
      process.exitCode = 1;
      process.exit(1);
    }
    if (matches(RUN_TESTS).length === 0) {
      console.log(`no tests left for filter [${filters.join(', ')}] after leaving out ${[...excludeSuites].join(', ')}: the whole-suite target runs them`);
      process.exitCode = 0;
      process.exit(0);
    }
  }
}

await runSuite(RUN_TESTS, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
