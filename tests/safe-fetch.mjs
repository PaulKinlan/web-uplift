#!/usr/bin/env node
// Focused, browser-free tests for page-derived fetches. Run directly or from regression.mjs.
import http from 'node:http';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { safeFetch } from '../evidence/cli.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function testSafeFetchDnsRebindingGuard() {
  const hostname = 'rebind.test.local';
  let validationLookups = 0;
  let connectLookups = 0;
  let privateHits = 0;
  const originalValidationLookup = dnsPromises.lookup;
  const originalConnectLookup = dns.lookup;
  const server = http.createServer((_req, res) => {
    privateHits++;
    res.end('private body');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    // syncBuiltinESMExports refreshes the named `lookup` binding already imported
    // by cli.mjs, unlike patching dns.promises.lookup on its own.
    dnsPromises.lookup = async (host, options) => {
      if (host !== hostname) return originalValidationLookup(host, options);
      validationLookups++;
      return [{ address: '8.8.8.8', family: 4 }];
    };
    syncBuiltinESMExports();
    dns.lookup = (host, options, callback) => {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      if (host !== hostname) return originalConnectLookup(host, options, callback);
      connectLookups++;
      if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    };
    let response = null;
    let error = null;
    try {
      response = await safeFetch(`http://${hostname}:${server.address().port}/`, {
        targetOrigin: 'http://127.0.0.1:8080', deadlineMs: 500,
      });
      await response.text();
    } catch (e) {
      error = e;
    }
    assert(validationLookups === 1, `the validation binding was not mocked: ${validationLookups}`);
    assert(privateHits === 0, `rebinding fetched the private server ${privateHits} time(s)`);
    assert(connectLookups === 0, `connection re-resolved the hostname ${connectLookups} time(s)`);
    assert(error, 'a public IP at an unused random port must not return a response');
  } finally {
    dns.lookup = originalConnectLookup;
    dnsPromises.lookup = originalValidationLookup;
    syncBuiltinESMExports();
    await new Promise((done) => server.close(done));
  }
}

export async function testSafeFetchContentDecoding() {
  const payload = '{"ok":true}';
  const server = http.createServer((req, res) => {
    const encoding = req.url.slice(1);
    assert((req.headers['accept-encoding'] || '').includes('gzip'), 'request must advertise gzip');
    if (encoding !== 'identity') res.setHeader('Content-Encoding', encoding);
    res.end(encoding === 'gzip' ? gzipSync(payload)
      : encoding === 'deflate' ? deflateSync(payload)
      : encoding === 'br' ? brotliCompressSync(payload) : payload);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const encoding of ['gzip', 'deflate', 'br', 'identity']) {
      const response = await safeFetch(`${origin}/${encoding}`, { targetOrigin: origin });
      assert(JSON.parse(await response.text()).ok === true, `${encoding} body not decoded correctly`);
    }
    let error = null;
    try {
      await safeFetch(`${origin}/unsupported`, { targetOrigin: origin });
    } catch (e) {
      error = e;
    }
    assert(/unsupported response Content-Encoding: unsupported/.test(error?.message), 'unsupported encoding must fail clearly');
  } finally {
    await new Promise((done) => server.close(done));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await testSafeFetchDnsRebindingGuard();
  await testSafeFetchContentDecoding();
  console.log('safe-fetch: DNS rebinding guard and content decoding passed');
}
