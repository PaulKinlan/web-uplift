/**
 * The shared notion of REMAINING WORK in a report. Both the hill-climb
 * (fixer/fix.mjs, where it gates a PASS claim) and the run comparison
 * (aggregate/compare.mjs, where it is descriptive) must count the same thing:
 * findings still outstanding PLUS checks that never concluded. Two copies of
 * this logic drifted apart once already (web-uplift-cuv fixed one; the other
 * kept printing "0 outstanding" for runs with blocked checks) — there is one
 * implementation now, here.
 */

// The atomic coverage contract says a run carrying blocked or not-run checks is
// PARTIAL, never completed. Counting findings cannot see that: a report with
// zero findings and five checks that never concluded looks exactly like a clean
// audit, which is the absence-of-evidence failure the contract exists to stop.
//
// The checkOutcomes ROWS are the authority here, not `coverage.complete`. A
// report can declare complete: true while still carrying blocked rows, and that
// shape is precisely the one that must not be allowed to claim a pass. Where the
// rows and the declared accounting disagree we take the WORSE answer, so a
// wrong self-declaration can only ever cost a run its pass, never grant one.
export function completionState(report) {
  const rows = Array.isArray(report?.checkOutcomes) ? report.checkOutcomes : [];
  const coverage = report?.coverage ?? null;
  const count = (n) => Number(n ?? 0) || 0;

  const blocked = Math.max(rows.filter((r) => r.status === 'blocked').length, count(coverage?.blocked));
  const notRun = Math.max(rows.filter((r) => r.status === 'not-run').length, count(coverage?.notRun));
  const missing = count(coverage?.missing);
  const unknown = count(coverage?.unknown);
  const duplicates = count(coverage?.duplicates);

  const reasons = [];
  if (blocked) reasons.push(`${blocked} blocked`);
  if (notRun) reasons.push(`${notRun} not-run`);
  if (missing) reasons.push(`${missing} missing`);
  if (unknown) reasons.push(`${unknown} unknown`);
  if (duplicates) reasons.push(`${duplicates} duplicate`);
  // No coverage accounting at all (a pre-contract report) is unverifiable, not
  // clean. It cannot claim a completed run either.
  if (!coverage) reasons.push('no coverage accounting in the report');
  else if (coverage.complete !== true && !reasons.length) reasons.push('coverage.complete is not true');

  return { complete: reasons.length === 0, blocked, notRun, missing, unknown, duplicates, reasons };
}

// "Outstanding" = findings tied to a principle the report did NOT mark
// not-applicable or opted-out. A clean audit (only pass / n-a / opted-out)
// returns 0 even though contextual principles exist. We read principleOutcomes
// to know which principles are out of scope, then count findings that are not
// against those principles. This counts FINDINGS only; see completionState for
// the checks that never concluded.
export function countOutstanding(report) {
  const outcomes = report.principleOutcomes ?? [];
  const excused = new Set(
    outcomes
      .filter((o) => o.status === 'not-applicable' || o.status === 'opted-out')
      .map((o) => o.principleId)
  );
  const findings = report.findings ?? [];
  return findings.filter((f) => !excused.has(f.principleId)).length;
}

// The work left in a run: findings still to fix PLUS checks still to conclude.
// `total` is the hill-climb's progress metric, so concluding a blocked check
// registers as progress even when it resolves no finding.
export function remaining(report) {
  const outstanding = countOutstanding(report);
  const completion = completionState(report);
  return { outstanding, completion, total: outstanding + completion.blocked + completion.notRun };
}
