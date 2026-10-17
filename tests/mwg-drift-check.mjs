#!/usr/bin/env node
// Recurring drift check for Modern Web Guidance (MWG).
// Reads the current upstream npm version of modern-web-guidance and compares it
// to the analysed version stored in knowledge/mwg-state.json (cross-checked
// against knowledge/mwg-catalog.json).
//
// Dependency-free: Node builtins only (node:fs, node:path, node:url), plus `tar` for the
// upstream package the anchor verification reads.
//
// Usage:
//   node tests/mwg-drift-check.mjs [--write] [--json]
//   node tests/mwg-drift-check.mjs --freshness-only [--max-age <duration>]
//
// Exit codes:
//   0: Upstream version equals the analysed version (in sync), or (in freshness
//      mode) the last check is fresh.
//   1: The check itself failed loudly: state file missing/unparseable/invalid,
//      state-vs-catalog version mismatch, upstream unreachable, or upstream
//      response unparseable/empty/missing valid version string.
//      This is the sabotage/absence signal: a blind check must never exit 0.
//   2: Version delta detected (upstream != analysedVersion). Output notes whether
//      upstream is newer or older. Triggers full reanalysis.
//   3: Freshness guard failed (freshness mode only), in three separate cases.
//      The heartbeat: lastCheckAt missing, null, unreadable, implausibly
//      future-dated, or older than --max-age. A never-run state has no heartbeat, so it
//      counts as stale.
//      A recorded delta: the recorded upstream version differs from analysedVersion,
//      or a delta is recorded with no usable upstream version at all, and analysedAt
//      is unreadable, implausibly future-dated, or older than --max-age. There the
//      age that matters is the analysis's, so a fresh heartbeat cannot rescue it;
//      inside the window it stays fresh and the FRESH line says a delta is carried.
//      A claim that cannot be substantiated: the state says in-sync while the two
//      versions cannot be shown to agree. That is REJECTED OUTRIGHT and never
//      age-gated, because a corrupt or hand-edited claim is not a recently detected
//      change and a fresh analysedAt must not buy it a grace window.
//  64: Usage error (unknown flags, invalid arguments).
//
// Exit 4 (anchor-broken) is deliberately NOT 1, 2 or 3: the check ran, the versions may even
// agree, and what failed is the basis those versions are supposed to carry. Folding it into the
// delta condition would hide a registry that needs re-anchoring behind an ordinary version bump,
// and folding it into the staleness condition would tell an operator to refresh a heartbeat that
// is already current (web-uplift-m9o3, and the three-way distinction vc4h established).
//
// Environment variable overrides (fixtures, tests, offline runs):
//   MWG_DRIFT_STATE: Path to state JSON (default: knowledge/mwg-state.json).
//   MWG_DRIFT_CATALOG: Path to catalog JSON (default: knowledge/mwg-catalog.json).
//   MWG_DRIFT_BASIS: Path to the rule basis JSON (default: knowledge/mwg-rule-basis.json).
//   MWG_DRIFT_UPSTREAM_FILE: Local JSON file used instead of network fetch.
//   MWG_DRIFT_UPSTREAM_CORPUS: Corpus JSON ({version, guides:{id:text}}) used as the upstream
//     guide text. Required with MWG_DRIFT_UPSTREAM_FILE (a version fixture carries no text, and
//     silently skipping the anchor verification there would be the opt-in hole of web-uplift-70im).
//     On the real path it is NOT needed: the check downloads the resolved version's tarball.
//   MWG_DRIFT_REGISTRY_URL: Override npm registry URL (default: https://registry.npmjs.org/modern-web-guidance/latest).
//   MWG_DRIFT_TIMEOUT_MS: Fetch timeout in milliseconds (default: 10000; the tarball gets 4x).
//
// The anchor verification (web-uplift-m9o3): comparing versions is not enough, because a release
// can rewrite guide bodies without changing any version we track. 0.0.194 rewrote 31 existing
// guides and one of them was a rule-basis anchor. So every run reads the rule basis, fetches the
// guide text for the SAME upstream version it resolved, and requires each anchor to still be
// verbatim in its guide. A violation is its own condition - result "anchor-broken", exit 4 - and
// is never reported as in-sync, stale heartbeat, or delta-unactioned, because the repairs differ.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basisAnchorViolations } from './mwg-basis.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Anchored: a version is the whole string, so a payload smuggling a newline or
// extra text cannot pass validation. Note JS `$` still matches before a final
// newline, so whitespace is rejected explicitly.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
function isValidVersion(v) {
  return typeof v === 'string' && VERSION_PATTERN.test(v) && !/\s/.test(v);
}

function parseDuration(val) {
  if (typeof val !== 'string' || val.trim().length === 0) return null;
  const trimmed = val.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(trimmed);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num < 0) return null;
  const unit = match[2];
  switch (unit) {
    case 'ms': return Math.round(num);
    case 's': return Math.round(num * 1000);
    case 'm': return Math.round(num * 60 * 1000);
    case 'h': return Math.round(num * 60 * 60 * 1000);
    case 'd': return Math.round(num * 24 * 60 * 60 * 1000);
    default: return null;
  }
}

function formatDuration(ms) {
  if (ms < 0) return '0s';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  const hours = ms / 3600000;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function compareVersions(a, b) {
  const [aMain, aPre] = a.split('-');
  const [bMain, bPre] = b.split('-');
  const aParts = aMain.split('.').map(Number);
  const bParts = bMain.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const ai = aParts[i] ?? 0;
    const bi = bParts[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  if (aPre === bPre) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  return aPre < bPre ? -1 : 1;
}

// Direction is informational only and MUST never decide equality: Number()
// collapses integers beyond 2^53 and returns NaN for build metadata, so a
// numeric compare can call two distinct version strings equal. Return null
// when the versions are not safely comparable.
function compareVersionsSafe(a, b) {
  const numOk = (v) => v.split('-')[0].split('.').every((p) => /^\d+$/.test(p) && Number(p) <= Number.MAX_SAFE_INTEGER);
  if (!numOk(a) || !numOk(b)) return null;
  return compareVersions(a, b);
}

// Parse command line arguments
const args = process.argv.slice(2);
let writeState = false;
let jsonMode = false;
let freshnessOnly = false;
let maxAgeArg = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--write') {
    writeState = true;
  } else if (arg === '--json') {
    jsonMode = true;
  } else if (arg === '--freshness-only') {
    freshnessOnly = true;
  } else if (arg === '--max-age') {
    i++;
    if (i >= args.length) {
      console.error('FAIL: --max-age requires a duration argument (e.g. 90s, 30m, 26h, 7d)');
      process.exit(64);
    }
    maxAgeArg = args[i];
  } else {
    console.error(`FAIL: unrecognized argument "${arg}"`);
    console.error(
      'Usage:\n' +
      '  node tests/mwg-drift-check.mjs [--write] [--json]\n' +
      '  node tests/mwg-drift-check.mjs --freshness-only [--max-age <duration>]'
    );
    process.exit(64);
  }
}

if (freshnessOnly) {
  if (writeState) {
    console.error('FAIL: --write is not supported with --freshness-only');
    process.exit(64);
  }
} else {
  if (maxAgeArg !== null) {
    console.error('FAIL: --max-age requires --freshness-only');
    process.exit(64);
  }
}

const statePath = process.env.MWG_DRIFT_STATE
  ? resolve(process.cwd(), process.env.MWG_DRIFT_STATE)
  : join(repoRoot, 'knowledge', 'mwg-state.json');

const catalogPath = process.env.MWG_DRIFT_CATALOG
  ? resolve(process.cwd(), process.env.MWG_DRIFT_CATALOG)
  : join(repoRoot, 'knowledge', 'mwg-catalog.json');

const basisPath = process.env.MWG_DRIFT_BASIS
  ? resolve(process.cwd(), process.env.MWG_DRIFT_BASIS)
  : join(repoRoot, 'knowledge', 'mwg-rule-basis.json');

// Upstream guide text, for the anchor verification. Fixture mode must supply it explicitly: a
// version fixture carries no text, and quietly skipping the verification when no corpus is given
// would recreate the opt-in hole that web-uplift-70im closed (a check that runs only when an
// optional input is present). The real path downloads the tarball of the version it resolved.
function readCorpusGuides(corpusPath) {
  let corpus;
  try {
    corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  } catch (err) {
    console.error(`FAIL: cannot read or parse the upstream corpus at ${corpusPath}: ${err.message}`);
    process.exit(1);
  }
  if (!corpus || typeof corpus !== 'object' || Array.isArray(corpus) || !corpus.guides || typeof corpus.guides !== 'object') {
    console.error(`FAIL: upstream corpus at ${corpusPath} has no guides map (expected {version, guides:{id:text}})`);
    process.exit(1);
  }
  return corpus.guides;
}

// Pull the guide markdown out of the same published tarball the version check resolved, so the
// text verified is the text that version actually ships. Only the guides subtree is extracted;
// the package's multi-megabyte model shards are never written to disk.
async function fetchUpstreamGuides(registryDoc, version, timeoutMs) {
  const tarballUrl = registryDoc?.dist?.tarball;
  if (typeof tarballUrl !== 'string' || tarballUrl === '') {
    console.error(`FAIL: the upstream document names no dist.tarball, so the guide text for ${version} cannot be read and the anchors cannot be verified`);
    process.exit(1);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs * 4);
  let buffer;
  try {
    const response = await fetch(tarballUrl, { signal: controller.signal });
    if (!response.ok) {
      console.error(`FAIL: fetching the upstream tarball returned HTTP ${response.status} ${response.statusText}`);
      process.exit(1);
    }
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    console.error(`FAIL: fetching the upstream tarball failed: ${err.message}`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
  const dir = mkdtempSync(join(tmpdir(), 'mwg-anchors-'));
  try {
    const tarball = join(dir, 'package.tgz');
    writeFileSync(tarball, buffer);
    const tar = spawnSync(
      'tar',
      ['-xzf', tarball, '-C', dir, 'package/skills/modern-web-guidance/guides'],
      { encoding: 'utf8', timeout: 120000 },
    );
    if (tar.error || tar.status !== 0) {
      console.error(`FAIL: cannot extract the published package (tar): ${tar.error?.message ?? tar.stderr ?? tar.status}`);
      process.exit(1);
    }
    const guidesRoot = join(dir, 'package', 'skills', 'modern-web-guidance', 'guides');
    const guides = {};
    const walk = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          guides[basename(entry.name, '.md')] = readFileSync(full, 'utf8');
        }
      }
    };
    walk(guidesRoot);
    if (Object.keys(guides).length === 0) {
      console.error('FAIL: the published package contains no guide markdown, so the anchors cannot be verified');
      process.exit(1);
    }
    return guides;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Freshness mode
if (freshnessOnly) {
  let maxAgeMs = 26 * 60 * 60 * 1000; // default 26h
  if (maxAgeArg !== null) {
    const parsed = parseDuration(maxAgeArg);
    if (parsed === null) {
      console.error(`FAIL: invalid --max-age duration "${maxAgeArg}" (expected e.g. 90s, 30m, 26h, 7d or ms integer)`);
      process.exit(64);
    }
    maxAgeMs = parsed;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (err) {
    console.error(`FAIL: cannot read or parse state file at ${statePath}: ${err.message}`);
    process.exit(1);
  }

  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    console.error(`FAIL: state file at ${statePath} is not a valid JSON object`);
    process.exit(1);
  }

  // A broken anchor is its OWN condition (web-uplift-m9o3), checked before any age logic and
  // reported with its own exit code: the check ran, the heartbeat may be perfectly fresh, and the
  // repair is re-anchoring the registry, not refreshing a timestamp or reanalysing a version. If
  // this were left to the staleness branch the operator would be told to refresh a heartbeat that
  // is already current, and if it were folded into delta-unactioned it would hide behind a version
  // bump that may not even have happened.
  if (state.lastCheckResult === 'anchor-broken') {
    console.error(
      `ANCHOR-BROKEN: the last check recorded that the rule basis no longer verifies against upstream ${JSON.stringify(state.lastCheckUpstreamVersion ?? null)}; the registry needs re-anchoring (the check log names the rule and the anchor). A fresh heartbeat cannot repair this and is not the condition being reported.`
    );
    process.exit(4);
  }

  // A detected-but-unactioned delta is NOT fresh, however recently the check ran. --write advances
  // lastCheckAt for the delta outcome as well as the in-sync one, so the heartbeat alone cannot see
  // it: the state file itself records that the last check found an upstream version the analysis never
  // caught up with. For that case the age that matters is the ANALYSIS's, not the heartbeat's
  // (web-uplift-yh6o). Without this, a sustained delta refreshes the heartbeat on every run and the
  // freshness job reports green indefinitely while the analysed catalog stays a version behind.
  //
  // The predicate is VERSION-based rather than flag-based (lastCheckResult === 'delta') so that it
  // clears itself as soon as the catalog is re-analysed, even if a stale result flag was left behind:
  // versions that agree mean the analysis agrees with what the last check saw.
  const checkedUpstream = state.lastCheckUpstreamVersion;
  const analysedVersion = state.analysedVersion;
  const hasUpstream = typeof checkedUpstream === 'string' && checkedUpstream.length > 0;
  const versionsAgree =
    hasUpstream && typeof analysedVersion === 'string' && checkedUpstream === analysedVersion;
  // Two distinct conditions, deliberately kept separate because they are different repairs:
  //   - the state CLAIMS in-sync while the two versions cannot be shown to agree. That is a corrupt
  //     or hand-edited claim, so it is REJECTED OUTRIGHT below, whatever analysedAt says.
  //   - the versions disagree, OR a delta is recorded with no usable upstream version at all. That is
  //     an unactioned upstream change, so it is AGED from analysedAt - except when the flag says
  //     in-sync, which is REJECTED by the branch below instead, because the rejection is checked
  //     first and an in-sync claim can satisfy both bullets at once. Inside the window a delta stays
  //     fresh with a note; past it the age rule reports it stale.
  const unsubstantiatedInSync = state.lastCheckResult === 'in-sync' && !versionsAgree;
  const analysisBehind = !versionsAgree && (hasUpstream || state.lastCheckResult === 'delta');
  const versionsDisagree = hasUpstream && !versionsAgree;
  const upstreamText = JSON.stringify(checkedUpstream ?? null);
  const analysedText = JSON.stringify(analysedVersion ?? null);
  const why = versionsDisagree
    ? `the last check found upstream version ${upstreamText} but the analysed version is ${analysedText}`
    : `the state records result ${JSON.stringify(state.lastCheckResult ?? null)} with upstream version ${upstreamText} against analysed version ${analysedText}, which cannot be shown to agree`;
  const trailing = versionsDisagree
    ? 'a detected delta has not been actioned'
    : 'the state cannot show the analysis matching what the last check recorded';
  // An in-sync claim that cannot be substantiated is REJECTED outright rather than aged: it
  // is a malformed or hand-edited state, not a recently-detected change, and a fresh analysedAt
  // must not buy it a grace window. --write always records a version for both sides, so no
  // legitimate state reaches here (review finding, web-uplift-yh6o).
  if (unsubstantiatedInSync) {
    console.error(
      `STALE: the state records result ${JSON.stringify(state.lastCheckResult)} but cannot show it (upstream version ${upstreamText} against analysed version ${analysedText}), so the analysis cannot be shown to match what the last check recorded; an unsubstantiated in-sync claim is rejected (threshold: ${formatDuration(maxAgeMs)})`
    );
    process.exit(3);
  }
  if (analysisBehind) {
    const analysedTime = typeof state.analysedAt === 'string' ? Date.parse(state.analysedAt) : NaN;
    if (Number.isNaN(analysedTime)) {
      // Fail closed. If the analysis time cannot be read we cannot say the delta is inside the
      // grace window, and answering FRESH here would be precisely the quiet failure this guard
      // exists to prevent, so an unreadable analysedAt is reported stale rather than assumed young.
      console.error(
        `STALE: ${why}, and analysedAt (${JSON.stringify(state.analysedAt ?? null)}) cannot be read as a timestamp, so the age of that analysis is unknown (threshold: ${formatDuration(maxAgeMs)}); ${trailing}`
      );
      process.exit(3);
    }
    const deltaAgeMs = Date.now() - analysedTime;
    // Same reasoning as the future-dated heartbeat guard below: a future-dated analysedAt must not
    // read as a young analysis and quietly buy the delta unlimited grace.
    if (deltaAgeMs < -5 * 60 * 1000) {
      console.error(
        `STALE: ${why}, and analysedAt is ${formatDuration(-deltaAgeMs)} in the FUTURE (hand-edit or clock skew); refusing to treat it as fresh; ${trailing}`
      );
      process.exit(3);
    }
    if (deltaAgeMs > maxAgeMs) {
      console.error(
        `STALE: ${why}, and that analysis is ${formatDuration(deltaAgeMs)} old, exceeding max-age threshold of ${formatDuration(maxAgeMs)}; ${trailing}`
      );
      process.exit(3);
    }
  }

  if (!state.lastCheckAt || typeof state.lastCheckAt !== 'string') {
    console.error(
      `STALE: state file has no recorded check timestamp (lastCheckAt is ${JSON.stringify(state.lastCheckAt ?? null)}) (threshold: ${formatDuration(maxAgeMs)})`
    );
    process.exit(3);
  }

  const lastCheckTime = Date.parse(state.lastCheckAt);
  if (Number.isNaN(lastCheckTime)) {
    console.error(
      `STALE: lastCheckAt in state file is not a valid timestamp: ${JSON.stringify(state.lastCheckAt)} (threshold: ${formatDuration(maxAgeMs)})`
    );
    process.exit(3);
  }

  const ageMs = Date.now() - lastCheckTime;
  // A future-dated lastCheckAt (hand-edit, skewed writer) must not read as
  // fresh indefinitely; allow only small clock skew.
  if (ageMs < -5 * 60 * 1000) {
    console.error(
      `STALE: lastCheckAt is ${formatDuration(-ageMs)} in the FUTURE (hand-edit or clock skew); refusing to treat it as fresh`
    );
    process.exit(3);
  }
  if (ageMs > maxAgeMs) {
    console.error(
      `STALE: last check was ${formatDuration(ageMs)} ago, exceeding max-age threshold of ${formatDuration(maxAgeMs)}`
    );
    process.exit(3);
  }

  console.log(
    `FRESH: last check was ${formatDuration(ageMs)} ago (within max-age threshold of ${formatDuration(maxAgeMs)})` +
    (analysisBehind
      ? ` [NOTE: ${why}; it is inside the grace period, which is measured from analysedAt (${state.analysedAt}), not from this heartbeat]`
      : '')
  );
  process.exit(0);
}

// Normal mode
let state;
try {
  state = JSON.parse(readFileSync(statePath, 'utf8'));
} catch (err) {
  console.error(`FAIL: cannot read or parse state file at ${statePath}: ${err.message}`);
  process.exit(1);
}

if (!state || typeof state !== 'object' || Array.isArray(state)) {
  console.error(`FAIL: state file at ${statePath} is not a valid JSON object`);
  process.exit(1);
}

if (!isValidVersion(state.analysedVersion)) {
  console.error(`FAIL: state file at ${statePath} has no valid analysedVersion (got ${JSON.stringify(state.analysedVersion)})`);
  process.exit(1);
}

// Cross-check against catalog version
let catalog;
try {
  catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
} catch (err) {
  console.error(`FAIL: cannot read or parse catalog at ${catalogPath}: ${err.message}`);
  process.exit(1);
}

if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || typeof catalog.version !== 'string') {
  console.error(`FAIL: catalog at ${catalogPath} has no valid version string`);
  process.exit(1);
}

if (state.analysedVersion !== catalog.version) {
  console.error(
    `FAIL: state-vs-catalog version mismatch: state.analysedVersion (${state.analysedVersion}) !== catalog.version (${catalog.version})`
  );
  process.exit(1);
}

// Obtain upstream version
let upstreamVersion;
let source;
// The resolved registry document, kept for the anchor verification: it names the dist.tarball of
// the version this run is about. Null in fixture mode, where the corpus is supplied explicitly.
let upstreamDoc = null;

if (process.env.MWG_DRIFT_UPSTREAM_FILE) {
  const upstreamPath = resolve(process.cwd(), process.env.MWG_DRIFT_UPSTREAM_FILE);
  source = upstreamPath;
  let raw;
  try {
    raw = readFileSync(upstreamPath, 'utf8');
  } catch (err) {
    console.error(`FAIL: cannot read upstream fixture file at ${upstreamPath}: ${err.message}`);
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`FAIL: upstream fixture file at ${upstreamPath} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !isValidVersion(data.version)) {
    console.error(`FAIL: upstream fixture file at ${upstreamPath} has no valid version string (got ${JSON.stringify(data?.version)})`);
    process.exit(1);
  }
  upstreamVersion = data.version;
} else {
  const registryUrl = process.env.MWG_DRIFT_REGISTRY_URL || 'https://registry.npmjs.org/modern-web-guidance/latest';
  const timeoutMs = Number(process.env.MWG_DRIFT_TIMEOUT_MS) || 10000;
  source = registryUrl;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let data;
  try {
    const response = await fetch(registryUrl, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`FAIL: upstream registry returned HTTP ${response.status} ${response.statusText}`);
      process.exit(1);
    }
    data = await response.json();
  } catch (err) {
    console.error(`FAIL: upstream registry request failed: ${err.message}`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data) || !isValidVersion(data.version)) {
    console.error(`FAIL: upstream response contains no valid version string (got ${JSON.stringify(data?.version)})`);
    process.exit(1);
  }
  upstreamVersion = data.version;
  upstreamDoc = data;
}

const analysedVersion = state.analysedVersion;
const checkedAt = new Date().toISOString();
// Equality is EXACT-STRING only; the numeric compare is used solely to
// describe the direction of an already-established delta.
const cmp = compareVersionsSafe(upstreamVersion, analysedVersion);

let result;
let exitCode;
let message;

// The anchor verification (web-uplift-m9o3). Versions agreeing says nothing about whether the
// guide text they name still contains the excerpts our registry depends on: 0.0.194 rewrote 31
// existing guide bodies and one of them was an anchor. So the basis is checked against the text of
// the version this run resolved, every run, and a violation is its own result.
let basis;
try {
  basis = JSON.parse(readFileSync(basisPath, 'utf8'));
} catch (err) {
  console.error(`FAIL: cannot read or parse the rule basis at ${basisPath}: ${err.message}`);
  process.exit(1);
}
if (!basis || typeof basis !== 'object' || !Array.isArray(basis.rules) || basis.rules.length === 0) {
  console.error(`FAIL: the rule basis at ${basisPath} declares no rules, so the anchor verification would be vacuous and in-sync would mean less than it says`);
  process.exit(1);
}
let upstreamGuides;
let anchorTextSource;
if (process.env.MWG_DRIFT_UPSTREAM_CORPUS) {
  const corpusPath = resolve(process.cwd(), process.env.MWG_DRIFT_UPSTREAM_CORPUS);
  upstreamGuides = readCorpusGuides(corpusPath);
  anchorTextSource = corpusPath;
} else if (upstreamDoc === null) {
  // Fixture mode carries a version and nothing else. Failing here rather than skipping is the whole
  // lesson of web-uplift-70im: a verification that quietly does not run is worse than one that says
  // it cannot run.
  console.error('FAIL: fixture mode (MWG_DRIFT_UPSTREAM_FILE) supplies no guide text, so the rule-basis anchors cannot be verified; set MWG_DRIFT_UPSTREAM_CORPUS to a corpus JSON rather than letting the check pass without checking');
  process.exit(1);
} else {
  upstreamGuides = await fetchUpstreamGuides(upstreamDoc, upstreamVersion, Number(process.env.MWG_DRIFT_TIMEOUT_MS) || 10000);
  anchorTextSource = String(upstreamDoc.dist?.tarball ?? 'upstream tarball');
}
const anchorViolations = basisAnchorViolations(basis, upstreamGuides);
const anchorCount = basis.rules.reduce((n, rule) => n + (Array.isArray(rule.anchors) ? rule.anchors.length : 0), 0);
const anchorResult = anchorViolations.length === 0 ? 'ok' : 'anchor-broken';

if (anchorViolations.length > 0) {
  result = 'anchor-broken';
  exitCode = 4;
  message = `ANCHOR-BROKEN: ${anchorViolations.length} rule-basis anchor problem(s) against upstream ${upstreamVersion}`;
  // The header goes to stderr with its violations so a log reader and the workflow's subject both
  // see the condition next to the evidence, not detached from it on stdout.
  console.error(message);
  for (const violation of anchorViolations) {
    console.error(`  - ${violation}`);
  }
} else if (upstreamVersion === analysedVersion) {
  result = 'in-sync';
  exitCode = 0;
  message = `IN-SYNC: upstream version ${upstreamVersion} matches analysed version ${analysedVersion}, and all ${anchorCount} rule-basis anchor(s) across ${basis.rules.length} rule(s) are still verbatim in that release`;
} else {
  result = 'delta';
  exitCode = 2;
  const direction = cmp === null ? 'different from' : cmp > 0 ? 'newer than' : cmp < 0 ? 'older than' : 'distinct but numerically equal to';
  message = `DELTA: upstream version ${upstreamVersion} is ${direction} analysed version ${analysedVersion}, and all ${anchorCount} rule-basis anchor(s) across ${basis.rules.length} rule(s) still resolve in it`;
}

if (writeState) {
  state.lastCheckAt = checkedAt;
  state.lastCheckUpstreamVersion = upstreamVersion;
  state.lastCheckSource = source;
  state.lastCheckResult = result;
  state.lastAnchorCheck = {
    upstreamVersion,
    result: anchorResult,
    rules: basis.rules.length,
    anchors: anchorCount,
    checkedAt,
    source: anchorTextSource,
  };
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error(`FAIL: cannot write updated state to ${statePath}: ${err.message}`);
    process.exit(1);
  }
}

console.log(message);
if (jsonMode) {
  console.log(JSON.stringify({
    result,
    analysedVersion,
    upstreamVersion,
    checkedAt,
    source,
    anchorCheck: {
      result: anchorResult,
      rules: basis.rules.length,
      anchors: anchorCount,
      violations: anchorViolations,
      source: anchorTextSource,
    },
  }));
}

process.exit(exitCode);
