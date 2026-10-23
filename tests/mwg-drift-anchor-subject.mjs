#!/usr/bin/env node
// Classify a drift-check report into the ANCHOR-BROKEN subject, so the workflow that files the
// issue names the condition that actually fired (web-uplift-6f8x).
//
// Why this is a script and not an inline bash branch: the acceptance for 6f8x is "test it with a
// fixture whose state is in-sync but whose anchor is broken, and the workflow must title it
// anchor-broken". Inline YAML cannot be driven by a fixture, so the classification lives here and
// the workflow calls it. The bash in .github/workflows/mwg-drift.yml still classifies the
// heartbeat/delta conditions from the guard's own wording (web-uplift-vc4h, dsl2, igdk); this
// reads the anchor condition's wording the same way.
//
// Anchored extraction, no bare substring grabs (the igdk rule): every value in the title is read
// end to end from a line the guard emits. If the guard printed an ANCHOR-BROKEN header but no
// violation line this script can parse, the title says what it knows (the upstream version) and
// does not invent a rule or a guide.
//
// Usage:
//   node tests/mwg-drift-anchor-subject.mjs [--output <file> | stdin] [--json]
//       [--github-output <file>] [--body-file <file>]
//
// Exit codes:
//   0: the input IS an anchor-broken report; the subject was produced
//   3: the input is NOT an anchor-broken report (no ANCHOR-BROKEN header). The caller must not
//      file an anchor issue on this, and must not treat the absence as success either - an exit
//      of 4 from the check without the guard's own wording is a bug worth seeing.

import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';

const USAGE = `Usage: node tests/mwg-drift-anchor-subject.mjs [--output <file>] [--json]
       [--github-output <file>] [--body-file <file>]`;

const args = process.argv.slice(2);
let outputFile = null;
let jsonMode = false;
let githubOutput = null;
let bodyFile = null;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--output') {
    i += 1;
    if (i >= args.length) {
      console.error(`FAIL: --output requires a file argument\n${USAGE}`);
      process.exit(64);
    }
    outputFile = args[i];
  } else if (arg === '--json') {
    jsonMode = true;
  } else if (arg === '--github-output') {
    i += 1;
    if (i >= args.length) {
      console.error(`FAIL: --github-output requires a file argument\n${USAGE}`);
      process.exit(64);
    }
    githubOutput = args[i];
  } else if (arg === '--body-file') {
    i += 1;
    if (i >= args.length) {
      console.error(`FAIL: --body-file requires a file argument\n${USAGE}`);
      process.exit(64);
    }
    bodyFile = args[i];
  } else if (arg === '--help' || arg === '-h') {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`FAIL: unrecognized argument: ${arg}\n${USAGE}`);
    process.exit(64);
  }
}

let text;
try {
  text = outputFile ? readFileSync(outputFile, 'utf8') : readFileSync(0, 'utf8');
} catch (err) {
  console.error(`FAIL: cannot read the drift-check output: ${err.message}`);
  process.exit(1);
}

// The guard's own headers, matched end to end. A bare `includes('ANCHOR-BROKEN')` would also match
// the phrase inside a quoted issue body, a step summary or a log line quoting a previous alert.
//
// There are TWO shapes, and both have to be recognised or the freshness job mislabels the condition
// it was handed (found while wiring this: the freshness pass prints the recorded condition, with no
// problem count, rather than re-listing the violations):
//   check mode:     ANCHOR-BROKEN: 2 rule-basis anchor problem(s) against upstream 0.0.194
//   freshness mode: ANCHOR-BROKEN: the last check recorded that the rule basis no longer verifies
//                   against upstream 0.0.194; the registry needs re-anchoring (...)
// The count is [1-9][0-9]* because the guard only prints this header when there IS a violation: a
// report of "0 problems" is not this condition, and treating it as one would invent an alert.
const HEADER = /^ANCHOR-BROKEN: ([1-9][0-9]*) rule-basis anchor problem\(s\) against upstream (\S+)$/m;
const HEADER_RECORDED = /^ANCHOR-BROKEN: the last check recorded that the rule basis no longer verifies against upstream (\S+?);/m;
// The two violation shapes the verifier emits, matched whole so a rule id or guide id cannot be
// half-read out of a longer message.
const NOT_FOUND = /^ {2}- Rule "([^"]+)" for guide "([^"]+)": anchor not found in guide text: (.*)$/gm;
const GUIDE_MISSING = /^ {2}- Rule "([^"]+)": registered guide "([^"]+)" does not exist in corpus$/gm;
// web-uplift-m4ae: a rule that declares no anchors verifies nothing, and an anchor that is not
// usable text matches any guide. The verifier emits both as violations, so both must be readable
// here or the alert would fire with a problem count and no rule to name - the same generic title a
// human cannot act on.
const NO_ANCHORS = /^ {2}- Rule "([^"]+)" for guide "([^"]+)": declares no anchors, so nothing could be verified and the rule would pass vacuously$/gm;
const UNUSABLE_ANCHOR = /^ {2}- Rule "([^"]+)" for guide "([^"]+)": anchor at index ([0-9]+) is not usable text \(empty or not a string\), so it would match any guide text$/gm;

const header = HEADER.exec(text);
const recorded = header === null ? HEADER_RECORDED.exec(text) : null;
if (header === null && recorded === null) {
  console.error('NOT-ANCHOR-BROKEN: the output carries no ANCHOR-BROKEN header the guard would have printed, so no anchor subject can be derived from it');
  process.exit(3);
}

// `null` when the freshness pass reported the RECORDED condition: it names no count, and the title
// must not invent one.
const problemCount = header === null ? null : Number(header[1]);
const upstreamVersion = header === null ? recorded[1] : header[2];
const violations = [];
for (const match of text.matchAll(NOT_FOUND)) {
  violations.push({ rule: match[1], guide: match[2], anchor: match[3], kind: 'anchor-not-found' });
}
for (const match of text.matchAll(GUIDE_MISSING)) {
  violations.push({ rule: match[1], guide: match[2], anchor: null, kind: 'guide-missing' });
}
for (const match of text.matchAll(NO_ANCHORS)) {
  violations.push({ rule: match[1], guide: match[2], anchor: null, kind: 'no-anchors' });
}
for (const match of text.matchAll(UNUSABLE_ANCHOR)) {
  violations.push({ rule: match[1], guide: match[2], anchor: null, anchorIndex: Number(match[3]), kind: 'unusable-anchor' });
}

// ONE stable tag for dedupe. The check job and the freshness job both use it, so the same
// condition cannot open two issues; and it is distinct from the heartbeat and delta tags, so an
// open anchor issue cannot swallow a delta alert or vice versa (the vc4h lesson, one condition on).
const TAG = 'MWG rule-basis anchor broken';
const CONDITION = 'anchor-broken';

let title;
if (violations.length === 1) {
  const [only] = violations;
  title = `${TAG}: ${only.rule} (guide ${only.guide})`;
} else if (violations.length > 1) {
  const rules = new Set(violations.map((v) => v.rule));
  title = `${TAG}: ${violations.length} problems across ${rules.size} rule(s), starting with ${violations[0].rule} (guide ${violations[0].guide})`;
} else {
  // The header fired but nothing parsed. Say only what the guard actually printed.
  title = `${TAG} against upstream ${upstreamVersion}`;
}

const describeViolation = (v) => {
  if (v.kind === 'guide-missing') return `rule \`${v.rule}\`, guide \`${v.guide}\` (guide missing from the corpus)`;
  if (v.kind === 'no-anchors') return `rule \`${v.rule}\`, guide \`${v.guide}\` (rule declares no anchors, so it verified nothing)`;
  if (v.kind === 'unusable-anchor') return `rule \`${v.rule}\`, guide \`${v.guide}\`, anchor #${v.anchorIndex} (empty or not a string)`;
  return `rule \`${v.rule}\`, guide \`${v.guide}\`, anchor ${v.anchor}`;
};

const body = [
  `This is an **${CONDITION}** alert. It is NOT a stale-heartbeat alert and NOT an unactioned-delta alert: the drift check ran, and what failed is the rule basis it verifies.`,
  '',
  `Upstream version: \`${upstreamVersion}\``,
  ...(problemCount === null
    ? ['This report comes from the freshness pass, which repeats the condition the last check recorded.', 'The check log holds the rule and anchor detail.']
    : [`Rule-basis anchor problem(s): ${problemCount}`]),
  '',
  'The registry quotes verbatim guide text as evidence for each rule, so an anchor that no longer',
  'resolves means the guide we depend on has moved (or vanished) and a human must re-anchor it.',
  'Refreshing the heartbeat cannot repair this, and neither can waiting for a version delta: the',
  'versions may already agree.',
  '',
  ...(violations.length > 0
    ? ['Violations:', '', ...violations.map((v) => `- ${describeViolation(v)}`), '']
    : []),
  'Drift-check output:',
  '```',
  text.trimEnd(),
  '```',
  '',
].join('\n');

if (bodyFile) {
  try {
    writeFileSync(bodyFile, body, 'utf8');
  } catch (err) {
    console.error(`FAIL: cannot write the issue body to ${bodyFile}: ${err.message}`);
    process.exit(1);
  }
}

if (githubOutput) {
  try {
    appendFileSync(githubOutput, `condition=${CONDITION}\ntag=${TAG}\ntitle=${title}\n`, 'utf8');
  } catch (err) {
    console.error(`FAIL: cannot write to ${githubOutput}: ${err.message}`);
    process.exit(1);
  }
}

if (jsonMode) {
  console.log(JSON.stringify({ condition: CONDITION, tag: TAG, title, upstreamVersion, problemCount, violations }, null, 2));
} else {
  console.log(`CONDITION=${CONDITION}`);
  console.log(`TAG=${TAG}`);
  console.log(`TITLE=${title}`);
}
process.exit(0);
