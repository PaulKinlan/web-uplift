#!/usr/bin/env node
// Recurring drift check for Modern Web Guidance (MWG).
// Reads the current upstream npm version of modern-web-guidance and compares it
// to the analysed version stored in knowledge/mwg-state.json (cross-checked
// against knowledge/mwg-catalog.json).
//
// Dependency-free: Node builtins only (node:fs, node:path, node:url).
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
// Environment variable overrides (fixtures, tests, offline runs):
//   MWG_DRIFT_STATE: Path to state JSON (default: knowledge/mwg-state.json).
//   MWG_DRIFT_CATALOG: Path to catalog JSON (default: knowledge/mwg-catalog.json).
//   MWG_DRIFT_UPSTREAM_FILE: Local JSON file used instead of network fetch.
//   MWG_DRIFT_REGISTRY_URL: Override npm registry URL (default: https://registry.npmjs.org/modern-web-guidance/latest).
//   MWG_DRIFT_TIMEOUT_MS: Fetch timeout in milliseconds (default: 10000).

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  //   - the versions disagree, OR a delta is recorded with no usable upstream version at all. That
  //     is an unactioned upstream change, so it is AGED from analysedAt - inside the window it stays
  //     fresh with a note, and past it the age rule above reports it stale.
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
}

const analysedVersion = state.analysedVersion;
const checkedAt = new Date().toISOString();
// Equality is EXACT-STRING only; the numeric compare is used solely to
// describe the direction of an already-established delta.
const cmp = compareVersionsSafe(upstreamVersion, analysedVersion);

let result;
let exitCode;
let message;

if (upstreamVersion === analysedVersion) {
  result = 'in-sync';
  exitCode = 0;
  message = `IN-SYNC: upstream version ${upstreamVersion} matches analysed version ${analysedVersion}`;
} else {
  result = 'delta';
  exitCode = 2;
  const direction = cmp === null ? 'different from' : cmp > 0 ? 'newer than' : cmp < 0 ? 'older than' : 'distinct but numerically equal to';
  message = `DELTA: upstream version ${upstreamVersion} is ${direction} analysed version ${analysedVersion}`;
}

if (writeState) {
  state.lastCheckAt = checkedAt;
  state.lastCheckUpstreamVersion = upstreamVersion;
  state.lastCheckSource = source;
  state.lastCheckResult = result;
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
  }));
}

process.exit(exitCode);
