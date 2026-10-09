import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { withDeadline } from './cdp.mjs';

export const CRAWLER_UA =
  'Mozilla/5.0 (compatible; web-uplift-discoverability/1.0; +https://github.com/PaulKinlan/web-uplift)';

// --- page-derived fetch guard (SSRF) ---------------------------------------
//
// A page controls the manifest href (read straight from the live DOM) and the
// redirects the discoverability fetch follows, and both are fetched by this
// PRIVILEGED Node process with the body persisted into the report. Unguarded, a
// malicious audited page could make the auditor read cloud metadata, loopback or
// private-range services (threat model I2 / F-003, web-uplift-2kh). Every
// Node-side fetch of a page-derived URL goes through safeFetch below.
//
// The audited target's own ORIGIN is exempt from the private-address rule:
// auditing 127.0.0.1 on purpose (which this repo's whole test suite does) is the
// operator's explicit choice, not something the page controls, and the page cannot
// widen that exemption to another origin (host, port or scheme). Everything else
// is validated per hop, fails closed, and reads a bounded body.
export const FETCH_SCHEMES = new Set(['http:', 'https:']);
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_MAX_REDIRECTS = 5;

const BLOCKED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the 169.254.169.254 metadata service
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
]) BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]) BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv6');
// No ::ffff:0:0/96 rule on purpose: net.BlockList already matches an
// IPv4-mapped address against the IPv4 subnets, so adding the mapped range would
// block EVERY IPv4 address, public ones included (measured, not assumed).

// The WHATWG URL parser already normalises every IPv4 literal encoding
// (2130706433, 0x7f.0.0.1, 0177.0.0.1 and 127.1 all become 127.0.0.1), so the
// hostname can be classified directly; IPv6 hosts keep their brackets, which
// net.isIP() does not accept.
export function normalizedHost(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

// The audited target's ORIGIN (scheme + host + port, with URL#origin's default-port
// normalisation) is the operator's explicit choice and is exempt from the
// private-address rule. Exempting the whole HOSTNAME would let a page on
// 127.0.0.1:8080 point its manifest at 127.0.0.1:2375, a different local service,
// and have that service's body persisted (adversarial review P1a, web-uplift-2kh).
export function targetOriginOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function isBlockedAddress(address) {
  const host = normalizedHost(address);
  const version = isIP(host);
  if (version === 0) return false;
  return BLOCKED_ADDRESSES.check(host, version === 4 ? 'ipv4' : 'ipv6');
}

// Resolve a page-derived URL to one this process may fetch, or throw a reason.
// `targetOrigin` is the audited target's origin (see the note above).
export async function assertPageDerivedFetchAllowed(rawUrl, { base, targetOrigin } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl, base);
  } catch {
    throw new Error(`refused: not a valid URL (${String(rawUrl).slice(0, 120)})`);
  }
  if (!FETCH_SCHEMES.has(parsed.protocol)) {
    throw new Error(`refused: scheme "${parsed.protocol}" is not http(s)`);
  }
  const host = normalizedHost(parsed.hostname);
  // Only the operator-selected ORIGIN is exempt: the same host on a different
  // port (another local service) is a different origin and must not inherit it.
  // The exemption ONLY applies to explicitly provided IP addresses, not names
  // that resolve to private addresses.
  if (targetOrigin && parsed.origin === targetOrigin && isIP(host)) {
    parsed.pinnedAddress = host;
    return parsed;
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new Error(`refused: ${parsed.hostname} is a loopback, link-local or private address`);
    }
    parsed.pinnedAddress = host;
    return parsed;
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch (e) {
    // Fail closed: a name this process cannot resolve is not fetched at all.
    throw new Error(`refused: ${host} did not resolve (${e?.code || e?.message || 'lookup failed'})`);
  }
  if (addresses.length === 0) throw new Error(`refused: ${host} resolved to no address`);
  const blocked = addresses.find((a) => isBlockedAddress(a.address));
  if (blocked) {
    throw new Error(`refused: ${host} resolves to ${blocked.address}, a loopback, link-local or private address`);
  }
  parsed.pinnedAddress = addresses[0].address;
  return parsed;
}

function pinnedFetch(urlObj, { headers, signal }) {
  return new Promise((resolve, reject) => {
    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;
    const requestHeaders = { ...headers };
    if (!Object.keys(requestHeaders).some((name) => name.toLowerCase() === 'accept-encoding')) {
      requestHeaders['Accept-Encoding'] = 'gzip, deflate, br';
    }
    const reqOpts = {
      method: 'GET',
      headers: requestHeaders,
      signal,
      lookup: urlObj.pinnedAddress ? (hostname, opts, cb) => {
        if (typeof opts === 'function') {
          cb = opts;
          opts = {};
        }
        const family = urlObj.pinnedAddress.includes(':') ? 6 : 4;
        if (opts.all) {
          cb(null, [{ address: urlObj.pinnedAddress, family }]);
        } else {
          cb(null, urlObj.pinnedAddress, family);
        }
      } : undefined
    };
    
    const req = lib.request(urlObj, reqOpts, (res) => {
      let bodyStream = res;
      const encodings = String(res.headers['content-encoding'] || 'identity').split(',').map((value) => value.trim().toLowerCase());
      for (const encoding of encodings.reverse()) {
        if (encoding === 'identity') continue;
        const decoder = encoding === 'gzip' ? createGunzip()
          : encoding === 'deflate' ? createInflate()
          : encoding === 'br' ? createBrotliDecompress() : null;
        if (!decoder) {
          res.destroy();
          reject(new Error(`unsupported response Content-Encoding: ${encoding}`));
          return;
        }
        bodyStream = bodyStream.pipe(decoder);
      }
      const response = {
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: {
          get: (name) => {
            const val = res.headers[name.toLowerCase()];
            return Array.isArray(val) ? val.join(', ') : (val || null);
          }
        },
        body: {
          cancel: async () => { req.destroy(); },
          getReader: () => {
            const webStream = Readable.toWeb(bodyStream);
            return webStream.getReader();
          }
        }
      };
      resolve(response);
    });
    
    req.on('error', reject);
    req.end();
  });
}

function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// The exchange is time-bounded, because a starved host can stall a fetch or a body read
// indefinitely - and the discoverability primitive fetches BEFORE its first navigation, so
// an unbounded stall here would hang the CLI before any page is reached.
export const SAFEFETCH_DEADLINE_MS = 30000;
// The fetch exchange budget is CONFIGURABLE (--fetch-deadline / WEB_UPLIFT_FETCH_DEADLINE_MS),
// because a fixed bound turns a slow-but-successful response into a recorded error - and
// downstream of that error, evidence that was never gathered gets read as evidence about the
// page. Operators on slow networks raise it; tests override it per call.
export let fetchDeadlineMsDefault = SAFEFETCH_DEADLINE_MS;
export function configureFetchDeadline(ms) {
  if (Number.isFinite(ms) && ms > 0) fetchDeadlineMsDefault = ms;
}

export async function readBodyCapped(res, maxBytes, deadlineMs = fetchDeadlineMsDefault) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  for (;;) {
    let read;
    try {
      read = await withDeadline(reader.read(), deadlineMs, 'the response body to arrive');
    } catch (e) {
      // Best-effort and DETACHED, not awaited: a stalled cancellation must not delay the
      // timeout this catch exists to deliver (cleanup-after-deadline, the class from rev2).
      reader.cancel().catch(() => {});
      throw new Error(
        `web-uplift: a response body read did not complete within ${deadlineMs}ms (the host may be starved)`,
        { cause: e },
      );
    }
    const { done, value } = read;
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {}); // detached best-effort, as above
      throw new Error(`refused: response body exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concatChunks(chunks, total));
}

// Follow redirects by hand. Node's fetch follows them internally, so validating
// only the first URL is exactly the naive fix that a redirect defeats: here every
// hop is validated before it is requested, the hop count is bounded, and the body
// is capped. The validated address is pinned during connect to prevent DNS rebinding.
export async function safeFetch(rawUrl, { base, targetOrigin, headers, maxBytes = FETCH_MAX_BYTES, deadlineMs = fetchDeadlineMsDefault } = {}) {
  let current = await assertPageDerivedFetchAllowed(rawUrl, { base, targetOrigin });
  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
    const res = await pinnedFetch(current, { headers, signal: AbortSignal.timeout(deadlineMs) });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (location === null) {
      return { res, url: current.href, text: () => readBodyCapped(res, maxBytes, deadlineMs) };
    }
    // Drain and drop a redirect body: it is not evidence, and an uncancelled
    // stream can pin a socket. Detached, not awaited: a stalled cancellation must
    // not hang the hop loop.
    res.body?.cancel().catch(() => {});
    if (hop === FETCH_MAX_REDIRECTS) throw new Error(`refused: more than ${FETCH_MAX_REDIRECTS} redirects`);
    current = await assertPageDerivedFetchAllowed(location, { base: current.href, targetOrigin });
  }
  throw new Error('refused: redirect loop');
}
