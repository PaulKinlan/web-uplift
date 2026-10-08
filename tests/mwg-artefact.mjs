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
//   node tests/mwg-artefact.mjs compute    # print the full sha256 hex of the canonicalised catalog
//   node tests/mwg-artefact.mjs verify     # recompute and compare to catalogSha256 in the state file
//   node tests/mwg-artefact.mjs update     # recompute and write catalogSha256 into the state file (2-space pretty JSON + trailing newline, preserving other keys)
//
// Exit codes:
//    0: Success (exact match on verify, successful compute, successful update).
//    1: Failure (verify mismatch, unreadable/unparseable files, missing or invalid
//       catalogSha256 in state). Fail-closed: never exits 0 when it cannot verify.
//   64: Usage error (unknown command, invalid argument count).
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
  if (parsed === null || typeof parsed !== 'object') {
    console.error(`FAIL: catalog at ${path} is not a valid JSON object or array`);
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
    const hash = computeSha256(catalog);
    console.log(hash);
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

    const catalog = readCatalogFile(catalogPath);
    const computed = computeSha256(catalog);

    if (computed !== state.catalogSha256) {
      console.error(
        `FAIL: catalogSha256 mismatch (state: ${state.catalogSha256}, computed: ${computed})`
      );
      process.exit(1);
    }

    console.log(`OK: catalogSha256 matches (${computed})`);
    process.exit(0);
  }

  if (command === 'update') {
    const catalog = readCatalogFile(catalogPath);
    const state = readStateFile(statePath);
    const computed = computeSha256(catalog);

    state.catalogSha256 = computed;

    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.error(`FAIL: cannot write state file at ${statePath}: ${err.message}`);
      process.exit(1);
    }

    console.log(`OK: updated catalogSha256 in ${statePath} (${computed})`);
    process.exit(0);
  }
}
