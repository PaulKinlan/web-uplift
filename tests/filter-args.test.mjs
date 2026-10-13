#!/usr/bin/env node
/**
 * tests/filter-args.test.mjs - direct tests for the suite flag parser (web-uplift-dipf).
 *
 * WHY THIS FILE EXISTS: parseFilterArgs used to live inside tests/test-helpers.mjs, which every suite entry
 * point names and which is FULL-GATE-ONLY by policy (web-uplift-5y2w). A one-line change to a flag guard
 * therefore refused the fast gate and demanded the full union gate - the slow path as a design smell, for
 * what is iteration-loop work. The parser now lives in tests/filter-args.mjs and this suite covers it
 * directly, so a parser change selects THIS suite.
 *
 * THE EXIT PATHS ARE SPAWNED, DELIBERATELY: parseFilterArgs calls process.exit for --help, for an unknown
 * flag and for a missing value. Testing those in-process would kill the suite mid-run, which would read as a
 * crashed gate rather than a passing assertion. The in-process cases below cover the pure forms, where the
 * function returns a value instead of ending the process.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFilterArgs } from './filter-args.mjs';
import { runSuite } from './test-helpers.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function runAggregator(args) {
  return spawnSync(process.execPath, ['tests/regression.mjs', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60000,
  });
}

function testNoFlagsMeansEveryCase() {
  console.log('Testing that no flags still means every case rather than a refusal...');
  assert.deepEqual(parseFilterArgs([]), { filters: [], list: false }, 'no flags must select every case');
  console.log('✔ no flags still selects every case');
}

function testLongAndShortAliasesCollectFilters() {
  console.log('Testing that --only/-o/--filter/-f/--grep/-g each collect their value...');
  const { filters, list } = parseFilterArgs(['--only', 'a', '-o', 'b', '--filter', 'c', '-f', 'd', '--grep', 'e', '-g', 'f']);
  assert.deepEqual(filters, ['a', 'b', 'c', 'd', 'e', 'f'], 'every long and short alias must collect its value in order');
  assert.equal(list, false, 'filtering must not imply --list');
  console.log('✔ all six aliases collect their value');
}

function testEqualsFormsCollectFilters() {
  console.log('Testing the --only=/--filter=/--grep= equals forms...');
  const { filters } = parseFilterArgs(['--only=x', '--filter=y', '--grep=z']);
  assert.deepEqual(filters, ['x', 'y', 'z'], 'the equals forms must collect their values');
  console.log('✔ the equals forms collect their values');
}

function testPositionalArgumentIsAFilter() {
  console.log('Testing that a bare positional argument is treated as a filter...');
  const { filters } = parseFilterArgs(['plainName']);
  assert.deepEqual(filters, ['plainName'], 'a positional argument is a filter, not an error');
  console.log('✔ a positional argument is a filter');
}

function testListFlagsAskForNamesWithoutFiltering() {
  console.log('Testing that --list/-l ask for case names and do not filter...');
  assert.deepEqual(parseFilterArgs(['--list']), { filters: [], list: true }, '--list must set list only');
  assert.deepEqual(parseFilterArgs(['-l']), { filters: [], list: true }, '-l must be the --list alias');
  console.log('✔ --list and -l ask for names without filtering');
}

function testBareDashIsIgnoredRatherThanRefused() {
  console.log('Testing that a bare "-" is ignored, as it was before the strict guard...');
  assert.deepEqual(parseFilterArgs(['-']), { filters: [], list: false }, 'a bare "-" is not a flag and must be ignored');
  console.log('✔ a bare "-" is ignored');
}

function testHelpExitsZeroAndPrintsUsage() {
  console.log('Testing that --help prints usage and exits 0...');
  const res = runAggregator(['--help']);
  assert.equal(res.status, 0, `--help must exit 0 (got ${res.status})`);
  assert(res.stdout.includes('usage: node <suite-file>.mjs'), '--help must print the usage line on stdout');
  console.log('✔ --help exits 0 with usage on stdout');
}

function testUnknownFlagExitsOneWithUsageOnStderr() {
  console.log('Testing that an unknown flag is REFUSED rather than ignored (web-uplift-rpc9)...');
  const res = runAggregator(['--definitely-not-a-flag']);
  assert.equal(res.status, 1, `an unknown flag must exit 1 (got ${res.status})`);
  assert(res.stderr.includes('unknown flag: --definitely-not-a-flag'), 'the unknown flag must be named on stderr');
  assert(res.stderr.includes('usage: node <suite-file>.mjs'), 'the refusal must show the usage');
  assert(!res.stdout.includes('tests OK'), 'an unknown flag must not run the suite to completion');
  console.log('✔ an unknown flag exits 1 and is named on stderr');
}

function testMissingFilterValueExitsOne() {
  console.log('Testing that a filter flag with no value exits 1...');
  const res = runAggregator(['--only']);
  assert.equal(res.status, 1, `a filter flag with no value must exit 1 (got ${res.status})`);
  assert(res.stderr.includes('missing argument for filter flag: --only'), 'the missing value must be named');
  console.log('✔ a filter flag with no value exits 1');
}

function testEmptyEqualsValueExitsOne() {
  console.log('Testing that an empty equals value (--only=) exits 1...');
  const res = runAggregator(['--only=']);
  assert.equal(res.status, 1, `an empty equals value must exit 1 (got ${res.status})`);
  assert(res.stderr.includes('missing value for --only='), 'the empty value must be named');
  console.log('✔ an empty equals value exits 1');
}

export const filterArgsTests = [
  testNoFlagsMeansEveryCase,
  testLongAndShortAliasesCollectFilters,
  testEqualsFormsCollectFilters,
  testPositionalArgumentIsAFilter,
  testListFlagsAskForNamesWithoutFiltering,
  testBareDashIsIgnoredRatherThanRefused,
  testHelpExitsZeroAndPrintsUsage,
  testUnknownFlagExitsOneWithUsageOnStderr,
  testMissingFilterValueExitsOne,
  testEmptyEqualsValueExitsOne,
];

export {
  testNoFlagsMeansEveryCase,
  testLongAndShortAliasesCollectFilters,
  testEqualsFormsCollectFilters,
  testPositionalArgumentIsAFilter,
  testListFlagsAskForNamesWithoutFiltering,
  testBareDashIsIgnoredRatherThanRefused,
  testHelpExitsZeroAndPrintsUsage,
  testUnknownFlagExitsOneWithUsageOnStderr,
  testMissingFilterValueExitsOne,
  testEmptyEqualsValueExitsOne,
};

await runSuite(filterArgsTests, import.meta.url, { timeoutMs: 60000, concurrency: 1 });
