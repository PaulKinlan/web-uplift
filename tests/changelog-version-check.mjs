#!/usr/bin/env node
// Release-hygiene guard: every version this package declares must have an entry
// in CHANGELOG.md. A `chore: release` commit neither wrote nor required one, so
// the file silently rotted at 0.2.3 while the package reached 0.4.1 (see the
// reconstructed entries at the top of CHANGELOG.md). This check makes that
// failure loud instead.
//
// Dependency-free on purpose: it must run before `npm ci`, on a bare checkout,
// and in a workflow that installs nothing.
//
//   node tests/changelog-version-check.mjs            # checks package.json's version
//   node tests/changelog-version-check.mjs 0.4.1      # checks an explicit version
//
// Exit 0 when the entry is present, 1 when it is missing, 2 on a usage error.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CHANGELOG_PATH = join(repoRoot, 'CHANGELOG.md');
const PACKAGE_PATH = join(repoRoot, 'package.json');

// Matches the file's heading format, `## [0.4.1] - 2026-09-25`, and tolerates a
// bare `## 0.4.1`, a `v` prefix, and a space-separated date
// (`## [0.4.1] 2026-09-25`), so the check does not break on formatting drift.
// The dashless form still requires a real date, so `## [0.4.1] trailing prose`
// stays unrecognised exactly as it was before.
const ENTRY =
  /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?\s*(?:-\s*(.*)|\s+(\d{4}-\d{2}-\d{2}))?$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Drop fenced code blocks before scanning. A version heading quoted inside a
// ``` / ~~~ fence is documentation (an example, a pasted transcript), not a
// release entry, and used to satisfy the check and hide a missing entry.
function stripFencedCode(text) {
  const opener = /^\s{0,3}(`{3,}|~{3,})/;
  const closer = /^\s{0,3}(`{3,}|~{3,})\s*$/;
  const kept = [];
  let fence = null;
  for (const line of text.split('\n')) {
    if (fence === null) {
      const open = opener.exec(line);
      if (open) fence = open[1];
      else kept.push(line);
    } else {
      const close = closer.exec(line);
      // Only a fence of the same character, at least as long, closes it.
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = null;
      }
    }
  }
  return kept.join('\n');
}

// Read the version to check: the explicit argument wins, else package.json.
const explicit = process.argv[2];
if (explicit !== undefined && !VERSION.test(explicit)) {
  console.error(
    `usage: node tests/changelog-version-check.mjs [<version>]\n` +
      `  <version> must be a bare semver string like 0.4.1, got ${JSON.stringify(explicit)}`,
  );
  process.exit(2);
}

let version = explicit;
let versionSource = 'the command line argument';
if (version === undefined) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
  } catch (err) {
    fail(`FAIL: cannot read the version to check from package.json: ${err.message}`);
  }
  version = pkg?.version;
  versionSource = 'package.json';
  if (typeof version !== 'string' || !VERSION.test(version)) {
    fail(`FAIL: package.json has no usable "version" field (got ${JSON.stringify(version)}).`);
  }
}

let changelog;
try {
  changelog = readFileSync(CHANGELOG_PATH, 'utf8');
} catch (err) {
  fail(`FAIL: cannot read CHANGELOG.md: ${err.message}`);
}

// Collect every release heading in the file, ignoring anything fenced.
const entries = [];
for (const line of stripFencedCode(changelog).split('\n')) {
  const match = ENTRY.exec(line);
  if (match) entries.push({ version: match[1], date: (match[2] ?? match[3] ?? '').trim() });
}

if (entries.length === 0) {
  fail(
    `FAIL: CHANGELOG.md has no release entries at all.\n` +
      `  Expected at least one \`## [x.y.z] - YYYY-MM-DD\` heading, including one for ${version}.`,
  );
}

const found = entries.find((entry) => entry.version === version);
if (found) {
  console.log(
    `OK: CHANGELOG.md has an entry for ${version}${found.date ? ` (${found.date})` : ''}, ` +
      `matching ${versionSource}. ${entries.length} release entries total.`,
  );
  process.exit(0);
}

// Name the newest entry too, so the message says what the file does have and not
// only what it lacks. The file is reverse-chronological, so "newest" is the
// highest semver rather than whichever heading happens to come first.
const newest = entries.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a));
fail(
  `FAIL: CHANGELOG.md has no entry for ${version} (${versionSource}).\n` +
    `  CHANGELOG.md's newest entry is ${newest.version}${newest.date ? ` (${newest.date})` : ''}.\n` +
    `  Add a \`## [${version}] - YYYY-MM-DD\` entry above the ${newest.version} block before the\n` +
    `  release commit lands. The CHANGELOG entry is mandatory: see RELEASING.md, and the\n` +
    `  reconstructed 0.3.0-0.4.1 entries at the top of CHANGELOG.md for what skipping costs.`,
);

// Numeric compare on major.minor.patch; a prerelease sorts below its release.
function compareVersions(a, b) {
  const [aMain, aPre] = a.split('-');
  const [bMain, bPre] = b.split('-');
  const aParts = aMain.split('.').map(Number);
  const bParts = bMain.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
  }
  if (aPre === bPre) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  return aPre < bPre ? -1 : 1;
}
