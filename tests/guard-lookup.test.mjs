#!/usr/bin/env node
// web-uplift-j48l + web-uplift-jpzr: the audited-page network guard's DNS adapter.
//
// The guard resolves every hostname the audited page asks for and hands the answer to the shared
// page-derived fetch policy (evidence/fetch.mjs). Two properties of that adapter are security
// properties, not implementation details, and both are decided here without a browser because both
// are about the adapter's own contract:
//
//   j48l - the cache must not be able to REFUSE. It used to be one module-scope Map that, once 256
//          distinct hostnames had been seen in the process, answered every new host with
//          'guard lookup cache full' for the rest of the process: a batch audit of a few real sites
//          silently stopped loading assets part-way through. Bound it by EVICTION (a re-resolve,
//          which can never allow anything) and give each session its own, so one session's host set
//          cannot spend another's budget.
//   jpzr - the answer is only valid for the TTL, because what the policy checks is the address this
//          process resolved, not the address the browser connects to. Re-resolution cannot close
//          that (Fetch.continueRequest cannot pin an address), so the honest claim is the narrower
//          one pinned here: every request is decided on an answer no older than the TTL, and a name
//          that switches from a public to a private address is caught on the next request instead of
//          for the life of the cache.

import { assert, runSuite } from './test-helpers.mjs';
import { createGuardLookup } from '../evidence/cdp.mjs';
import { assertPageDerivedFetchAllowed } from '../evidence/fetch.mjs';

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const PRIVATE = [{ address: '127.0.0.1', family: 4 }];

// A resolver whose answer can be changed between calls, recording what it was asked.
function fakeResolver(answers) {
  const calls = [];
  const resolve = async (host, opts) => {
    calls.push({ host, opts });
    const answer = answers[host];
    if (typeof answer === 'function') return answer();
    if (answer) return answer;
    throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  };
  return { resolve, calls };
}

export async function testAdapterHandsThePolicyNodeArrayShape() {
  const { resolve } = fakeResolver({ 'cdn.test': PUBLIC });
  const guardLookup = createGuardLookup({ resolve });
  const addresses = await guardLookup('cdn.test');
  assert.ok(Array.isArray(addresses), `an injected lookup must resolve to an ARRAY, got ${typeof addresses}`);
  assert.deepEqual(addresses, PUBLIC);
  // And the shared policy is what consumes it: an array is allowed, an envelope threw (web-uplift-a32k).
  const allowed = await assertPageDerivedFetchAllowed('https://cdn.test/asset.js', { lookup: guardLookup });
  assert.equal(allowed.pinnedAddress, '93.184.216.34');
}

export async function testAdapterAsksTheResolverWithNodeOptions() {
  const { resolve, calls } = fakeResolver({ 'cdn.test': PUBLIC });
  const guardLookup = createGuardLookup({ resolve });
  await guardLookup('cdn.test');
  assert.deepEqual(calls[0], { host: 'cdn.test', opts: { all: true, verbatim: true } });
}

export async function testPastTheCapTheCacheEvictsItNeverRefuses() {
  const answers = {};
  for (let i = 0; i < 300; i += 1) answers[`host-${i}.test`] = PUBLIC;
  const { resolve, calls } = fakeResolver(answers);
  // The production cap, so this is the shipped number and not a convenient one.
  const guardLookup = createGuardLookup({ resolve });

  for (let i = 0; i < 300; i += 1) {
    const addresses = await guardLookup(`host-${i}.test`);
    assert.equal(addresses.length, 1, `host ${i} must resolve, not be refused by a full cache`);
  }
  assert.ok(guardLookup.cacheSize <= 256, `the cache must stay bounded, size was ${guardLookup.cacheSize}`);
  // Eviction costs a re-resolve and nothing else: the oldest host resolves again, still allowed.
  const before = calls.length;
  await guardLookup('host-0.test');
  assert.equal(calls.length, before + 1, 'an evicted host must be re-resolved, not remembered as refused');
}

export async function testEachSessionGetsItsOwnCache() {
  const { resolve } = fakeResolver({ 'a.test': PUBLIC, 'b.test': PUBLIC });
  const first = createGuardLookup({ resolve });
  const second = createGuardLookup({ resolve });
  await first('a.test');
  assert.equal(first.cacheSize, 1);
  assert.equal(second.cacheSize, 0, 'a fresh session must start with an empty cache');
}

export async function testTheCacheEvictsTheLeastRecentlyUsedEntry() {
  const { resolve, calls } = fakeResolver({ 'hot.test': PUBLIC, 'cold.test': PUBLIC, 'new.test': PUBLIC });
  const guardLookup = createGuardLookup({ resolve, maxEntries: 2 });
  await guardLookup('hot.test');
  await guardLookup('cold.test');
  await guardLookup('hot.test'); // still cached: no new resolve
  assert.equal(calls.length, 2, 'a cached host must not be resolved again');
  await guardLookup('new.test'); // evicts cold, the least recently used
  assert.equal(guardLookup.cacheSize, 2);
  const before = calls.length;
  await guardLookup('hot.test');
  await guardLookup('new.test');
  assert.equal(calls.length, before, 'the recently used entries must still be cached');
}

export async function testAFailedResolveIsNotCachedAndIsRetried() {
  let attempt = 0;
  const guardLookup = createGuardLookup({
    resolve: async () => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' });
      return PUBLIC;
    },
  });
  await assert.rejects(() => guardLookup('flaky.test'), /EAI_AGAIN/);
  assert.equal(guardLookup.cacheSize, 0, 'a failed answer must not be stored');
  assert.deepEqual(await guardLookup('flaky.test'), PUBLIC, 'the next request must resolve again');
}

export async function testAnAnswerOlderThanTheTtlIsDecidedAgain() {
  let current = PUBLIC;
  let clock = 1_000;
  const guardLookup = createGuardLookup({ resolve: async () => current, ttlMs: 30_000, now: () => clock });

  const first = await assertPageDerivedFetchAllowed('https://rebind.test/x', { lookup: guardLookup });
  assert.equal(first.pinnedAddress, PUBLIC[0].address, 'a name resolving public must be allowed');

  // The name now answers with a loopback address. Inside the TTL the guard still sees the cached
  // public answer - this is the residual jpzr states - and after it, the guard refuses.
  current = PRIVATE;
  const insideWindow = await assertPageDerivedFetchAllowed('https://rebind.test/x', { lookup: guardLookup });
  assert.equal(insideWindow.pinnedAddress, PUBLIC[0].address, 'inside the TTL the cached answer is reused');

  clock += 30_000;
  await assert.rejects(
    () => assertPageDerivedFetchAllowed('https://rebind.test/x', { lookup: guardLookup }),
    /refused: rebind\.test resolves to 127\.0\.0\.1/,
    'past the TTL the flipped answer must be decided on, not the cached one',
  );
}

export async function testTheAdapterNeverReturnsItsCachedArray() {
  const guardLookup = createGuardLookup({ resolve: async () => PUBLIC, ttlMs: 30_000 });
  const first = await guardLookup('cdn.test');
  first.push({ address: '10.0.0.1', family: 4 });
  const second = await guardLookup('cdn.test');
  assert.equal(second.length, 1, 'a caller mutating its copy must not poison the cache');
}

export const guardLookupTests = [
  testAdapterHandsThePolicyNodeArrayShape,
  testAdapterAsksTheResolverWithNodeOptions,
  testPastTheCapTheCacheEvictsItNeverRefuses,
  testEachSessionGetsItsOwnCache,
  testTheCacheEvictsTheLeastRecentlyUsedEntry,
  testAFailedResolveIsNotCachedAndIsRetried,
  testAnAnswerOlderThanTheTtlIsDecidedAgain,
  testTheAdapterNeverReturnsItsCachedArray,
];

await runSuite(guardLookupTests, import.meta.url, { timeoutMs: 60000, concurrency: 1 });
