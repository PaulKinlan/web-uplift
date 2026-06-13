// Score an audit's findings against playground/expected-findings.json.
//
// The stable join key is the scenario id (e.g. "no-dark-mode"), which both the
// detectors and the ground truth carry. (The ground-truth file predates the
// final principle ids and still uses the older adapt-to-the-* names, so we map
// those to the current principle ids for an informational principle-alignment
// check, but the pass/fail join is on scenario id.)

const PRINCIPLE_ALIASES = new Map([
  ['adapt-to-the-device', 'adapt-to-the-form-factor'],
  ['adapt-to-the-user', 'respect-user-preferences'],
]);

function canonicalPrinciple(id) {
  return PRINCIPLE_ALIASES.get(id) || id;
}

// mode: 'issues' (expect to find every scenario) or 'fixed' (expect none).
export function scoreAgainstExpected(findings, expected, mode) {
  const expectedScenarios = new Set(expected.scenarios.map((s) => s.id));
  const foundScenarios = new Set(
    findings.map((f) => f.scenario).filter(Boolean),
  );

  if (mode === 'fixed') {
    // Any finding at all is a false positive.
    const falsePositives = [...foundScenarios];
    return {
      mode,
      expectedCount: 0,
      foundCount: foundScenarios.size,
      truePositives: 0,
      falsePositives: falsePositives.length,
      falseNegatives: 0,
      precision: foundScenarios.size === 0 ? 1 : 0,
      recall: 1,
      matched: [],
      missed: [],
      spurious: falsePositives,
      principleAlignment: [],
    };
  }

  const matched = [];
  const missed = [];
  const spurious = [];
  const principleAlignment = [];

  for (const exp of expected.scenarios) {
    if (foundScenarios.has(exp.id)) {
      matched.push(exp.id);
      const f = findings.find((x) => x.scenario === exp.id);
      principleAlignment.push({
        scenario: exp.id,
        expectedPrinciple: canonicalPrinciple(exp.principleId),
        foundPrinciple: f.principleId,
        aligned: canonicalPrinciple(exp.principleId) === f.principleId,
        checkAligned: exp.principleCheckId === f.principleCheckId,
      });
    } else {
      missed.push(exp.id);
    }
  }
  for (const s of foundScenarios) {
    if (!expectedScenarios.has(s)) spurious.push(s);
  }

  const tp = matched.length;
  const fp = spurious.length;
  const fn = missed.length;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);

  return {
    mode,
    expectedCount: expected.scenarios.length,
    foundCount: foundScenarios.size,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision,
    recall,
    matched,
    missed,
    spurious,
    principleAlignment,
  };
}
