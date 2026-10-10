#!/usr/bin/env node
// The tracked passive export .beads/issues.jsonl must not contain provider-secret-shaped tokens
// (web-uplift-ffum).
//
// Why this is a guard and not a one-time cleanup: the export is REGENERATED from the Dolt database by
// bd export, so a correction applied to the file alone is undone by the next regeneration. The
// redaction lives at generation (scripts/beads-export.mjs, which uses the rule below), and this test
// is what makes that true over time rather than on the day someone remembered.
//
// The rule itself is imported, never re-stated here. A guard with its own copy of the pattern can
// agree with itself while disagreeing with the redactor - the "one implementation of the redaction
// rule" lesson from web-uplift-lsn3.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTokenShapesInText, redactTokenShapesInText, looksLikeToken } from '../evidence/credential-terms.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = join(repoRoot, '.beads', 'issues.jsonl');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export async function testTrackedBeadsExportHasNoSecretShapes() {
  assert(existsSync(EXPORT),
    `the tracked passive export is missing at .beads/issues.jsonl. It is committed, so a checkout without it is anomalous rather than a reason to skip: regenerate it with node scripts/beads-export.mjs`);

  const text = readFileSync(EXPORT, 'utf8');
  const hits = findTokenShapesInText(text);

  // Never print a value, only how many and where. This message can end up in a log or a bead.
  assert(hits.length === 0,
    `the tracked beads export contains ${hits.length} provider-secret-shaped token(s). Shapes, not values: ${hits.map((h) => `${h.slice(0, 6)}...(${h.length} chars)`).join(', ')}. Regenerate with node scripts/beads-export.mjs, and consider editing the offending bead so the shape does not exist in the database either - an exemption list is not what protects this file.`);
}

// THE POSITIVE CONTROL, and it is the reason this file is worth having. A guard whose matcher can
// never fire passes every run while checking nothing - the "clean vs blind" defect this project has
// hit five times today. So the matcher is proven able to fire on a value built to be found, and the
// redactor is proven to remove it. A fixture is used rather than a real credential, and the value is
// assembled at runtime so that no token-shaped literal is committed to this repository.
export async function testBeadsExportRedactionRuleCanFire() {
  const shape = ['sk', '-', 'live-', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('');
  assert(looksLikeToken(shape), 'the rule must recognise a provider-prefixed token, or this guard can never fire');

  const prose = `a change whose textContent is ${shape} produces a step`;
  const found = findTokenShapesInText(prose);
  assert(found.length === 1, `the matcher must find exactly one shape in a fixture that contains one, found ${found.length}`);

  const redacted = redactTokenShapesInText(prose);
  assert(!redacted.includes(shape), 'the redactor must remove the shape it found');
  assert(redacted.includes('[redacted]'), 'the redactor must leave a visible marker rather than deleting the text');

  // The separator class, which is the finding this bead came from: the value that blocked a push was
  // written with an underscore and the values in the export were the hyphen form, so a rule keyed on
  // one spelling is blind to the other.
  const underscored = ['sk', '_', 'live_', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('');
  assert(findTokenShapesInText(underscored).length === 1, 'the hyphen spelling must not be the only one recognised');

  // And the other direction, so a matcher that fires on everything is caught too: the false positive
  // that shipped first in this change was the word "skill", because a two-letter prefix with an
  // optional separator matched skill-write-contract.mjs as sk + ill-write-contract.mjs.
  for (const plain of ['skill-write-contract.mjs', 'skill-copy.mjs', 'task-success', 'disk-pointer', 'bundle.min.js']) {
    assert(findTokenShapesInText(plain).length === 0, `${plain} is not a credential and must not be rewritten`);
  }
}
