#!/usr/bin/env node
// Versioned-artefact hash contract CLI for Modern Web Guidance (MWG).
// Computes, verifies, and updates the canonical sha256 hash of the catalog
// recorded in knowledge/mwg-state.json.
//
// Dependency-free: Node builtins only (node:fs, node:crypto, node:path, node:url).
//
// Canonicalisation rule:
//   "json: recursive lexicographic key sort; array order preserved; compact (no insignificant whitespace); UTF-8; sha256 hex"
//
// Usage:
//   node tests/mwg-artefact.mjs compute    # print a JSON object {catalogSha256, guideIdsSha256, guideCount}
//   node tests/mwg-artefact.mjs verify     # recompute all three and compare to the state file
//   node tests/mwg-artefact.mjs update     # recompute and write all three into the state file (2-space pretty JSON + trailing newline, preserving other keys)
//
// Exit codes:
//    0: Success (exact match on verify, successful compute, successful update).
//    1: Failure (verify mismatch, unreadable/unparseable files, missing or invalid
//       catalogSha256/guideIdsSha256/guideCount in state). Fail-closed: never
//       exits 0 when it cannot verify.
//   64: Usage error (unknown command, invalid argument count).
//
// Set identity: alongside catalogSha256 the artefact carries guideIdsSha256 (the
// sha256 of the canonicalised JSON array of guide ids sorted lexicographically)
// and guideCount, because a count is not an identity: consumers compare SETS.
//
// Environment variable overrides:
//   MWG_DRIFT_STATE: Path to state JSON (default: knowledge/mwg-state.json).
//   MWG_DRIFT_CATALOG: Path to catalog JSON (default: knowledge/mwg-catalog.json).

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const CANONICALISATION_RULE =
  'json: recursive lexicographic key sort; array order preserved; compact (no insignificant whitespace); UTF-8; sha256 hex';

export function canonicalise(val) {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalise);
  }
  const sorted = {};
  for (const key of Object.keys(val).sort()) {
    sorted[key] = canonicalise(val[key]);
  }
  return sorted;
}

export function computeSha256(data) {
  const canon = canonicalise(data);
  const compact = JSON.stringify(canon);
  const encoded = new TextEncoder().encode(compact);
  return createHash('sha256').update(encoded).digest('hex');
}

// Set identity, not just a count: the sha256 of the canonicalised JSON array of
// the catalog's guide ids sorted lexicographically. A count alone cannot tell
// "same set" from "same size" (the 177-vs-178 prompt-api divergence, web-uplift-968).
export function computeGuideIds(catalog) {
  const ids = catalog.guides.map((g) => g.id).sort();
  return { guideIdsSha256: computeSha256(ids), guideCount: ids.length };
}

function readCatalogFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`FAIL: cannot read catalog at ${path}: ${err.message}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`FAIL: cannot parse catalog at ${path}: ${err.message}`);
    process.exit(1);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`FAIL: catalog at ${path} is not a valid JSON object`);
    process.exit(1);
  }
  if (!Array.isArray(parsed.guides) || parsed.guides.some((g) => !g || typeof g.id !== 'string')) {
    console.error(`FAIL: catalog at ${path} has no valid guides array (every entry needs a string id)`);
    process.exit(1);
  }
  return parsed;
}

function readStateFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`FAIL: cannot read state file at ${path}: ${err.message}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`FAIL: cannot parse state file at ${path}: ${err.message}`);
    process.exit(1);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`FAIL: state file at ${path} is not a valid JSON object`);
    process.exit(1);
  }
  return parsed;
}

// Only execute CLI runner when invoked directly
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error(`FAIL: expected exactly one command (compute|verify|update), got ${args.length} arguments`);
    console.error(
      'Usage:\n' +
      '  node tests/mwg-artefact.mjs compute\n' +
      '  node tests/mwg-artefact.mjs verify\n' +
      '  node tests/mwg-artefact.mjs update'
    );
    process.exit(64);
  }

  const command = args[0];
  if (command !== 'compute' && command !== 'verify' && command !== 'update') {
    console.error(`FAIL: unrecognized command "${command}"`);
    console.error(
      'Usage:\n' +
      '  node tests/mwg-artefact.mjs compute\n' +
      '  node tests/mwg-artefact.mjs verify\n' +
      '  node tests/mwg-artefact.mjs update'
    );
    process.exit(64);
  }

  const statePath = process.env.MWG_DRIFT_STATE
    ? resolve(process.cwd(), process.env.MWG_DRIFT_STATE)
    : join(repoRoot, 'knowledge', 'mwg-state.json');

  const catalogPath = process.env.MWG_DRIFT_CATALOG
    ? resolve(process.cwd(), process.env.MWG_DRIFT_CATALOG)
    : join(repoRoot, 'knowledge', 'mwg-catalog.json');

  if (command === 'compute') {
    const catalog = readCatalogFile(catalogPath);
    console.log(JSON.stringify({ catalogSha256: computeSha256(catalog), ...computeGuideIds(catalog) }));
    process.exit(0);
  }

  if (command === 'verify') {
    const state = readStateFile(statePath);
    if (typeof state.catalogSha256 !== 'string' || !SHA256_PATTERN.test(state.catalogSha256)) {
      console.error(
        `FAIL: state file at ${statePath} has missing or invalid catalogSha256 (expected 64-char hex, got ${JSON.stringify(state.catalogSha256 ?? null)})`
      );
      process.exit(1);
    }
    if (typeof state.guideIdsSha256 !== 'string' || !SHA256_PATTERN.test(state.guideIdsSha256)) {
      console.error(
        `FAIL: state file at ${statePath} has missing or invalid guideIdsSha256 (expected 64-char hex, got ${JSON.stringify(state.guideIdsSha256 ?? null)})`
      );
      process.exit(1);
    }
    if (!Number.isInteger(state.guideCount) || state.guideCount < 0) {
      console.error(
        `FAIL: state file at ${statePath} has missing or invalid guideCount (got ${JSON.stringify(state.guideCount ?? null)})`
      );
      process.exit(1);
    }

    const catalog = readCatalogFile(catalogPath);
    const computed = computeSha256(catalog);
    const ids = computeGuideIds(catalog);

    const mismatches = [];
    if (computed !== state.catalogSha256) {
      mismatches.push(`catalogSha256 mismatch (state: ${state.catalogSha256}, computed: ${computed})`);
    }
    if (ids.guideIdsSha256 !== state.guideIdsSha256) {
      mismatches.push(`guideIdsSha256 mismatch (state: ${state.guideIdsSha256}, computed: ${ids.guideIdsSha256})`);
    }
    if (ids.guideCount !== state.guideCount) {
      mismatches.push(`guideCount mismatch (state: ${state.guideCount}, computed: ${ids.guideCount})`);
    }
    if (mismatches.length > 0) {
      for (const m of mismatches) console.error(`FAIL: ${m}`);
      process.exit(1);
    }

    console.log(`OK: catalogSha256, guideIdsSha256 and guideCount match (${computed}, ${ids.guideCount} guides)`);
    process.exit(0);
  }

  if (command === 'update') {
    const catalog = readCatalogFile(catalogPath);
    const state = readStateFile(statePath);
    const computed = computeSha256(catalog);
    const ids = computeGuideIds(catalog);

    state.catalogSha256 = computed;
    state.guideIdsSha256 = ids.guideIdsSha256;
    state.guideCount = ids.guideCount;

    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.error(`FAIL: cannot write state file at ${statePath}: ${err.message}`);
      process.exit(1);
    }

    console.log(`OK: updated catalogSha256, guideIdsSha256 and guideCount in ${statePath} (${computed}, ${ids.guideCount} guides)`);
    process.exit(0);
  }
}
