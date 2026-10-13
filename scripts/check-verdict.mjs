#!/usr/bin/env node
/**
 * scripts/check-verdict.mjs - refuse a cached fleet-check verdict this project did not produce.
 *
 * WHY THIS EXISTS (web-uplift-ebvj). `fleet-check` sources ~/.fleet/check.conf for ANY repository on this
 * VM, and that file is machine-global: right now it holds ANOTHER project's commands, and its own header
 * says so ("fleet-check reads this file for any repo invoked on this host"). So a verdict can be produced
 * by a command this project never chose, and the cache file cannot show it: it is named <tree>.json and
 * names no config file.
 *
 * WHAT IT CAN POLICE, MEASURED RATHER THAN ASSUMED over the 328 records in ~/.fleet/checks:
 *   cmd   328/328 records (100%, every tier)  -> REQUIRED. This is the provenance we act on.
 *   repo  143/328 records (about 47%; only 52/132 full records) -> used when present, never required.
 *   produced_in  0/328 -> does not exist; the string appears in no cached file, so nothing depends on it.
 * Because the record names no config FILE, the refusal says "produced by cmd X" and never claims to know
 * which config was sourced. The project check uses git's COMMON dir, so another WORKTREE of this project
 * is accepted: this VM has six worktrees of this repository and keying on the path would refuse the
 * merger's legitimate verdicts.
 *
 * Usage:
 *   node scripts/check-verdict.mjs [--tree <sha>] [--dir <cache>] [--json]
 * Exit 0 = accepted, 1 = refused (with one next action), 2 = usage error.
 */
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** This project's own gate commands - the PROJECT half of the pin. Owner: this repository, not ~/.fleet. */
export const PROJECT_COMMANDS = ['npm run test:fast', 'npm test'];

/** The git COMMON dir, i.e. project identity. Two worktrees of one repository share it. */
export function gitCommonDir(path) {
  try {
    return realpathSync(execFileSync('git', ['-C', path, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^\.git$/, path));
  } catch {
    return null;
  }
}

/** Decide one record. Returns { ok, why, recorded: { cmd, repo, kind } }. */
export function judgeVerdict(record, { repo = repoRoot, thisCommonDir = gitCommonDir(repoRoot) } = {}) {
  const cmd = typeof record?.cmd === 'string' ? record.cmd : '';
  const recordedRepo = typeof record?.repo === 'string' && record.repo ? record.repo : null;
  const recorded = { cmd: cmd || '(none recorded)', repo: recordedRepo, kind: record?.kind ?? '(none)' };
  if (!cmd) {
    return { ok: false, why: 'the record names no command, so nothing identifies what produced it', recorded };
  }
  if (!PROJECT_COMMANDS.includes(cmd)) {
    return {
      ok: false,
      why: `produced by cmd '${cmd}', which is not a command this project chose (${PROJECT_COMMANDS.join(' or ')})`,
      recorded,
    };
  }
  if (recordedRepo) {
    const otherCommon = gitCommonDir(recordedRepo);
    if (otherCommon && thisCommonDir && otherCommon !== thisCommonDir) {
      return { ok: false, why: `produced by cmd '${cmd}' in a different project (${recordedRepo})`, recorded };
    }
  }
  const caveat = recordedRepo
    ? ''
    : ' (the record carries no repo, so the project was not checked - only the command was)';
  return { ok: true, why: `produced by cmd '${cmd}'${recordedRepo ? ` in ${recordedRepo}` : ''}${caveat}`, recorded };
}

/** Newest record, or the one for a tree. */
export function findRecord(dir, tree) {
  if (tree) return join(dir, `${tree}.json`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
  if (files.length === 0) return null;
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function main(argv) {
  const arg = (name, dflt = null) => {
    const i = argv.indexOf(name);
    return i === -1 ? dflt : argv[i + 1];
  };
  const asJson = argv.includes('--json');
  const tree = arg('--tree');
  const dir = arg('--dir', join(process.env.HOME ?? '', '.fleet', 'checks'));
  const file = findRecord(dir, tree);
  if (!file) {
    console.error(`fast-verdict: REFUSED - no cached verdict found in ${dir}${tree ? ` for tree ${tree}` : ''}.`);
    console.error('[verdict] NEXT ACTION: run this project\'s gate with its own config, then read it again:');
    console.error('  FLEET_CHECK_CONF=/home/exedev/.fleet/conf.d/web-uplift.conf fleet-check --fast');
    process.exit(1);
  }
  let record;
  try {
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`fast-verdict: REFUSED - ${file} is not readable JSON (${err.message}).`);
    process.exit(1);
  }
  const verdict = judgeVerdict(record);
  if (asJson) {
    console.log(JSON.stringify({ file, accepted: verdict.ok, why: verdict.why, recorded: verdict.recorded }, null, 2));
  } else if (verdict.ok) {
    console.log(`fast-verdict: ACCEPTED - ${verdict.why}`);
    console.log(`  record: ${file}  state: ${record.state ?? '(none)'}  kind: ${verdict.recorded.kind}`);
  } else {
    console.error(`fast-verdict: REFUSED - ${verdict.why}`);
    console.error(`  record: ${file}  state: ${record.state ?? '(none)'}  kind: ${verdict.recorded.kind}`);
    console.error('[verdict] NEXT ACTION: re-run this project\'s gate with its own config, so the verdict you quote');
    console.error('  was produced by this project: FLEET_CHECK_CONF=/home/exedev/.fleet/conf.d/web-uplift.conf fleet-check --fast');
  }
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main(process.argv.slice(2));
