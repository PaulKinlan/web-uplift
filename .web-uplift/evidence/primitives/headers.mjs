import { navigate } from '../cdp.mjs';
import { resolve } from 'node:path';
import { applyConditions, emit, headerMap, headerArray } from '../common.mjs';

function headerReport(value, valueIssues = [], missingIssue = 'missing') {
  const present = value !== null;
  const empty = present && String(value).trim() === '';
  return {
    present,
    empty,
    value,
    issues: !present ? [missingIssue] : empty ? ['present but empty'] : valueIssues,
  };
}

// --- headers primitive: security response headers -------------------------
export async function headers(client, url, opts, log) {
  log('[headers] inspecting ' + url);
  const respHeaders = {};
  const docPromise = new Promise((resolve) => {
    client.Network.responseReceived(({response}) => {
      try { if (response.mimeType && response.mimeType.includes('html')) { resolve(response); } } catch {}
    });
    setTimeout(() => resolve(null), (opts.wait || 5000) + 3000);
  });
  await navigate(client, url, { settleMs: opts.wait || 3000, log });
  const resp = await docPromise;
  // Header names are case-insensitive (RFC 9110), and Chrome hands them over as the
  // server sent them: capitalised on an HTTP/1.1 response, lowercased on HTTP/2. The
  // lookups below used to be lowercase-only, so a capitalised response reported
  // every security header as missing. Normalise through headerMap/headerArray - the
  // same lower-casing the HAR path uses - and look up by lower-cased name, so no
  // wire shape can be missed (web-uplift-0w6).
  if (resp && resp.headers) Object.assign(respHeaders, headerMap(headerArray(resp.headers)));
  const get = (name) => respHeaders[name.toLowerCase()] ?? null;
  const csp = get('content-security-policy');
  const hsts = get('strict-transport-security');
  const xcto = get('x-content-type-options');
  const xfo = get('x-frame-options');
  const rp = get('referrer-policy');
  const pp = get('permissions-policy');
  const summary = {
    primitive: 'headers', url,
    scannedAt: new Date().toISOString(),
    securityHeaders: {
      'content-security-policy': headerReport(csp, csp && (csp.includes('unsafe-inline') || csp.includes('unsafe-eval')) ? ['unsafe-inline/unsafe-eval'] : []),
      'strict-transport-security': headerReport(hsts),
      'x-content-type-options': headerReport(xcto, xcto && xcto.toLowerCase() === 'nosniff' ? [] : ['not nosniff'], 'missing or not nosniff'),
      'x-frame-options': headerReport(xfo, [], 'missing (check CSP frame-ancestors)'),
      'referrer-policy': headerReport(rp),
      'permissions-policy': headerReport(pp),
    },
    https: url.startsWith('https://'),
    note: 'Descriptive signal. Judge against be-private-and-secure. A missing CSP/HSTS/X-Content-Type-Options is a security gap, and a header that is present but EMPTY is not a pass either: `present` says whether the response carried the header at all, `empty` says it carried no value, and `issues` names what is wrong with it. unsafe-inline/unsafe-eval weakens XSS protection.',
  };
  return emit(opts, summary, client);
}

// --- cookies primitive: cookie security audit -----------------------------
