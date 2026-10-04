#!/usr/bin/env node
// Isolated regression guard for the Chrome bootstrap flake that killed the
// suite: a bare CDP({ port }) relied on a pre-existing default page target,
// which Chrome for Testing 154 sometimes does not provide ("No inspectable
// targets"). This loop exercises launchChrome + newSession N times in a fresh
// process so a regression cannot silently return. Run it directly:
//
//   node tests/launch-loop.mjs 15
//
// The regression suite runs a cheap 3-iteration version so the guard stays in
// the fast path without paying for 15 browser starts.

import { launchChrome, newSession } from '../evidence/cdp.mjs';

const iterations = Number(process.argv[2]) || 15;
if (!Number.isInteger(iterations) || iterations < 1) {
  console.error(`usage: node tests/launch-loop.mjs <iterations>=15`);
  process.exit(2);
}

let ok = 0;
for (let i = 1; i <= iterations; i++) {
  const chrome = await launchChrome({ log: () => {} });
  try {
    const session = await newSession(chrome.port, { log: () => {} });
    try {
      // Prove the target is actually attached and usable, not just created.
      const value = await session.client.Runtime.evaluate({
        expression: '40 + 2',
        returnByValue: true,
      });
      if (value.result?.value !== 42) {
        throw new Error(`unexpected evaluate result: ${JSON.stringify(value)}`);
      }
      ok++;
      console.log(`launch-session-loop ${i}/${iterations} ok`);
    } finally {
      await session.close();
    }
  } finally {
    await chrome.close();
  }
}

console.log(`launch-session-loop OK: ${ok}/${iterations}`);
process.exit(ok === iterations ? 0 : 1);
