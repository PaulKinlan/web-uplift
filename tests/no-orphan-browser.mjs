#!/usr/bin/env node
// Deterministic-teardown guard (web-uplift-knz): launch and close N browsers,
// then assert that NOTHING from this run survives: no process of any spawned
// browser tree (browser, zygote, renderer, gpu, crashpad) and no
// /tmp/web-uplift-cdp-* profile dir created by this run. The old close() sent a
// single SIGTERM to the main pid and rmSync'd the profile before Chrome had
// exited, which leaked a wedged browser group and one profile husk per boot.
//
// Run it directly:
//
//   node tests/no-orphan-browser.mjs [browsers=3]
//
// The assertions are scoped to THIS run (the exact pids, process-group ids and
// userDataDirs it created) because other lanes on a shared VM may legally have
// their own live Chrome trees and older husks: a leftover from another run is
// not a regression of this one. Membership in a spawned tree is decided by
// process-group id (Chrome is spawned detached, so its pid IS its pgid and
// every tree member inherits it), which also catches crashpad, whose command
// line does not mention the profile dir.

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, newSession } from '../evidence/cdp.mjs';

const rawBrowsers = process.argv[2];
const browsers = rawBrowsers === undefined ? 3 : Number(rawBrowsers);
if (!Number.isInteger(browsers) || browsers < 1) {
  console.error('usage: node tests/no-orphan-browser.mjs <browsers>=3');
  process.exit(2);
}

const launched = []; // { pid, pgid, userDataDir } for every launch this run

for (let i = 1; i <= browsers; i++) {
  const chrome = await launchChrome({ log: () => {} });
  launched.push({ pid: chrome.proc.pid, pgid: chrome.proc.pid, userDataDir: chrome.userDataDir });
  try {
    // The group scan below is only exact because the launcher spawns Chrome as
    // a process-group leader (pid === pgid). If that contract regresses, say so
    // loudly instead of scanning a group id that matches nothing.
    const pgrp = readPgrp(chrome.proc.pid);
    if (pgrp !== chrome.proc.pid) {
      throw new Error(
        `browser pid ${chrome.proc.pid} is not a process-group leader (pgid ${pgrp}); ` +
          'teardown cannot kill its tree by group, see launchChrome()',
      );
    }
    const session = await newSession(chrome.port, { log: () => {} });
    try {
      // Prove the browser is really up and attached, not just spawned.
      const value = await session.client.Runtime.evaluate({
        expression: '40 + 2',
        returnByValue: true,
      });
      if (value.result?.value !== 42) {
        throw new Error(`unexpected evaluate result: ${JSON.stringify(value)}`);
      }
      console.log(`no-orphan-browser ${i}/${browsers} ok`);
    } finally {
      await session.close();
    }
  } finally {
    await chrome.close();
  }
}

// close() already waits for the tree to die; this poll only absorbs scheduling
// noise on a loaded VM so a passing run does not flake.
const failures = await pollUntilClean(5000);
if (failures) {
  process.exitCode = 1;
} else {
  console.log(`no-orphan-browser OK: 0 processes and 0 dirs from ${browsers} closed browser(s)`);
}

async function pollUntilClean(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const procFailures = scanGroupSurvivors();
    const dirFailures = launched.filter((b) => existsSync(b.userDataDir));
    if (procFailures.length === 0 && dirFailures.length === 0) return false;
    if (Date.now() >= deadline) {
      for (const { pid, pgid, name } of procFailures) {
        console.error(`FAIL: no-orphan-browser: browser-tree process survived close(): pid ${pid} (pgid ${pgid}) ${name}`);
      }
      for (const { userDataDir } of dirFailures) {
        console.error(`FAIL: no-orphan-browser: profile dir survived close(): ${userDataDir}`);
      }
      // Record the failure, then reap exactly what this run leaked (our own
      // pgids and dirs, never another lane's tree) so a failing regression run
      // cannot leave the orphan it just detected.
      for (const b of launched) {
        try { process.kill(-b.pgid, 'SIGKILL'); } catch { /* already gone */ }
      }
      for (const { userDataDir } of dirFailures) {
        try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Any process whose process-group id belongs to one of this run's browsers.
function scanGroupSurvivors() {
  const pgids = new Set(launched.map((b) => b.pgid));
  const survivors = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let fields;
    try {
      const stat = readFileSync(join('/proc', entry, 'stat'), 'utf8');
      // comm can contain spaces; everything after the closing paren is fixed-width fields.
      fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    } catch {
      continue; // the process went away while we scanned
    }
    if (pgids.has(Number(fields[2]))) {
      survivors.push({ pid: entry, pgid: Number(fields[2]), name: procName(entry) });
    }
  }
  return survivors;
}

function procName(pid) {
  try {
    const stat = readFileSync(join('/proc', pid, 'stat'), 'utf8');
    return `(${stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))})`;
  } catch {
    return '(gone)';
  }
}

function readPgrp(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  } catch {
    return null;
  }
}
