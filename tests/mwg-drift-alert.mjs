// Behavioural regression for the MWG drift ALERT, not for the workflow's text (web-uplift-igdk note: 'YAML only
// maps to general regression rather than classifier behaviour'). The alert classifier lives in a workflow
// `run:` block, so this extracts that block from the YAML and executes it with a stubbed `gh`, feeding it the
// GUARD'S OWN message texts. What is asserted is the subject line that would be filed.
//
// The case that matters most is the invalid lastCheckAt whose stored value itself reads like a measurement: the
// guard declares it unusable, so the subject must not report an age at all. That was the igdk finding - an
// unanchored regex read '35.5h' out of the quoted value and published a measurement that was never made.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** The alert step's `run:` block, dedented, taken from the workflow by step name (no YAML dependency). */
function alertRunBlock() {
  const lines = readFileSync(join(repoRoot, '.github', 'workflows', 'mwg-drift.yml'), 'utf8').split('\n');
  const stepAt = lines.findIndex((line) => line.includes('- name: Classify the freshness'));
  assert(stepAt >= 0, 'the workflow must still have the freshness alert step');
  const runAt = lines.findIndex((line, i) => i > stepAt && /^\s+run: \|/.test(line));
  assert(runAt > stepAt, 'the alert step must still have a run block');
  const indent = lines[runAt].match(/^\s*/)[0].length + 2;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== '' && line.match(/^\s*/)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

/** Run the classifier over one guard output and return the subject it would file. */
function subjectFor(output, binDir) {
  const script = join(binDir, 'alert.sh');
  writeFileSync(script, alertRunBlock());
  const out = execFileSync('sh', [script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FRESHNESS_OUTPUT: output, GITHUB_STEP_SUMMARY: '/dev/null' },
  });
  const filed = out.match(/^FILED: (.*)$/m);
  assert(filed, `the classifier filed no issue for output ${JSON.stringify(output)}`);
  return filed[1];
}

export function testMwgDriftAlertNamesTheConditionItReports() {
  console.log('Testing that the drift alert names the condition it reports, including invalid timestamps...');
  const binDir = mkdtempSync(join(tmpdir(), 'mwg-drift-alert-'));
  // gh stub: issue list reports no open issue, issue create echoes the title it was given.
  writeFileSync(join(binDir, 'gh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *"--json title --jq length"*) echo 0 ;;',
    '  *"issue create"*) prev=""; for a in "$@"; do [ "$prev" = "--title" ] && echo "FILED: $a"; prev="$a"; done ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(binDir, 'gh'), 0o755);

  // THE FINDING: the stored value is invalid AND contains duration-shaped prose. No age may be reported.
  const invalid = subjectFor('STALE: lastCheckAt in state file is not a valid timestamp: "last check was 35.5h ago" (threshold: 30.0h)', binDir);
  assert(!/\d/.test(invalid.replace(/30\.0|0\.0\.19\d/g, '')), `an invalid lastCheckAt must not yield a measured age in the subject, got: ${invalid}`);
  assert(/invalid/i.test(invalid) && /timestamp/i.test(invalid), `the subject must say the timestamp is invalid, got: ${invalid}`);
  assert(!/last check 35\.5h ago/.test(invalid), 'the subject must not echo the invalid value as a measurement');

  // The guard's measured shapes still produce their ages, fractional ones included (web-uplift-dsl2).
  assert(/analysis 5\.2d old/.test(subjectFor('STALE: x, and that analysis is 5.2d old, exceeding max-age threshold of 30.0h', binDir)), 'a fractional analysis age must be named');
  assert(/last check 35\.5h ago/.test(subjectFor('STALE: last check was 35.5h ago, exceeding max-age threshold of 30.0h', binDir)), 'a fractional heartbeat age must be named');
  assert(/last check 500ms ago/.test(subjectFor('STALE: last check was 500ms ago, exceeding max-age threshold of 30.0h', binDir)), 'a millisecond heartbeat age must be named, not read as minutes');

  // Every other shape keeps its own vocabulary and never borrows the heartbeat title.
  assert(/in-sync claim cannot be substantiated/.test(subjectFor('STALE: the state records result "in-sync" but cannot show it; an unsubstantiated in-sync claim is rejected (threshold: 30.0h)', binDir)));
  assert(/no usable last-check timestamp/.test(subjectFor('STALE: state file has no recorded check timestamp (lastCheckAt is null) (threshold: 30.0h)', binDir)));
  const crashed = subjectFor('FAIL: upstream unreachable', binDir);
  assert(!/heartbeat stale/i.test(crashed), `a guard crash must not be reported as a stale heartbeat, got: ${crashed}`);

  console.log('\u2714 the alert names the condition it reports, and an invalid timestamp yields no measured age');
}
