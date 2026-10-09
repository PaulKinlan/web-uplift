import { join } from 'node:path';
import { announceCap, emit, byteLength } from '../common.mjs';
import { redactUrlCredentialValues } from '../redaction.mjs';
import { FETCH_MAX_BYTES, fetchDeadlineMsDefault } from '../fetch.mjs';
import { navigate, evaluate } from '../cdp.mjs';

const SECRET_PATTERNS = [
  { id: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g, severity: 'critical', desc: 'AWS Access Key ID' },
  { id: 'aws-secret', re: /aws_secret_access_key["\s:=]+([A-Za-z0-9/+=]{40})/g, severity: 'critical', desc: 'AWS Secret Access Key' },
  { id: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g, severity: 'high', desc: 'Google API Key' },
  { id: 'stripe-secret', re: /sk_live_[0-9a-zA-Z]{24,}/g, severity: 'critical', desc: 'Stripe Secret Key' },
  { id: 'stripe-publishable', re: /pk_live_[0-9a-zA-Z]{24,}/g, severity: 'medium', desc: 'Stripe Publishable Key (live)' },
  { id: 'github-token', re: /gh[pousr]_[0-9a-zA-Z]{36,}/g, severity: 'critical', desc: 'GitHub Token' },
  { id: 'slack-token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/g, severity: 'critical', desc: 'Slack Token' },
  { id: 'jwt', re: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, severity: 'high', desc: 'JWT Token' },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, severity: 'critical', desc: 'Private Key' },
  { id: 'connection-string', re: /(?:mongodb|postgres|postgresql|mysql|redis):\/\/[^"]+:[^"]+@[^"]+/g, severity: 'critical', desc: 'Database Connection String with credentials' },
  { id: 'generic-api-key', re: /(?:api[_-]?key|apikey|api[_-]?secret)["\s:=]+['"]([A-Za-z0-9_-]{32,})['"]/gi, severity: 'high', desc: 'Generic API Key/Secret (32+ chars)' },
  { id: 'bearer-token', re: /(?:bearer|authorization)["\s:=]+([A-Za-z0-9_-]{20,})/gi, severity: 'high', desc: 'Bearer/Authorization token' },
];

// `seen` deduplicates across the sources one scan walks (page HTML, inline
// scripts, external JS, meta tags). It keys on the RAW match, which is never put
// on a finding: findings carry a fixed placeholder and the match length only, so
// an artifact can never republish credential material (web-uplift-u5n).
export function scanTextForSecrets(text, source, seen = new Set()) {
  const findings = [];
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    let m, count = 0;
    while ((m = p.re.exec(text)) !== null) {
      count++;
      if (count <= 3) {
        const matched = m[0];
        const key = `${p.id}:${matched}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          pattern: p.id,
          severity: p.severity,
          description: p.desc,
          source,
          match: '[redacted]',
          matchLength: matched.length,
        });
      }
    }
    if (count > 3) {
      const key = `${p.id}:`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({ pattern: p.id, severity: p.severity, description: p.desc, source, note: `+${count - 3} more matches` });
      }
    }
  }
  return findings;
}

// The in-page script fetch can fail in ways the Node side must not confuse with a
// clean read (web-uplift-6fe review). This decision table is exported and SERIALIZED
// into the page with .toString() - the same idiom runner/flow.mjs uses for its
// resolver - so the browser test drives the exact function the page runs instead of
// a re-implementation.
//
// It fails closed on every ambiguity. A non-2xx body is not the script. A classic
// script cannot be served as text/html (the browser refuses to execute it, so the
// body is an error page, and a redirect to one must not read as coverage). A body
// with no readable stream cannot be bounded in-page, so it is REFUSED rather than
// read with only its DECLARED length as the bound: a declared length is not a
// guarantee about the bytes delivered, and an absent header used to arrive as
// Number(null) === 0 and let an unbounded read through.
export function classifyScriptFetch({ httpOk, status, contentType, hasStream, declaredLength }) {
  if (!httpOk) return { ok: false, error: 'HTTP ' + status };
  const type = String(contentType || '').toLowerCase();
  if (type.startsWith('text/html')) {
    return { ok: false, error: 'HTML response (content-type ' + type + '), not JavaScript' };
  }
  if (!hasStream) {
    const declared = declaredLength === null || declaredLength === undefined || declaredLength === ''
      ? 'no content-length'
      : 'declared content-length ' + declaredLength;
    return { ok: false, error: 'no readable stream: the body size cannot be bounded in-page (' + declared + ')' };
  }
  return { ok: true };
}

// One shape for "this script was not read", used by BOTH failure paths - the
// in-page verdict and a failed evaluate - so the credential redaction cannot be
// forgotten on one of them (6fe review). A page-selected script URL can carry a
// credential in its query, and both land in the artifact.
export function scriptFetchFailure(rawUrl, reason, rawFinalUrl) {
  const failure = { url: redactUrlCredentialValues(rawUrl), reason };
  if (rawFinalUrl && rawFinalUrl !== rawUrl) failure.finalUrl = redactUrlCredentialValues(rawFinalUrl);
  return failure;
}

export async function secrets(client, url, opts, log) {
  log('[secrets] scanning ' + url);
  await navigate(client, url, { settleMs: opts.wait || 3000, log });
  const findings = [];
  const seen = new Set();
  // 1. Page HTML
  const html = await evaluate(client, 'document.documentElement.outerHTML');
  findings.push(...scanTextForSecrets(html || '', 'page HTML', seen));
  // 2. Inline scripts
  const inline = await evaluate(client, "[...document.querySelectorAll('script:not([src])')].map(s=>s.textContent).join('\\n')");
  findings.push(...scanTextForSecrets(inline || '', 'inline scripts', seen));
  // 3. External JS (sample first 20). The in-page fetch reads page-selected URLs
  // from the page's own context (same-origin/CORS reach), so it cannot go
  // through the Node-side safeFetch - but it gets the SAME containment values
  // (web-uplift-61i): the FETCH_MAX_BYTES body cap and the configured fetch
  // deadline, enforced in-page via a streamed read and an AbortController.
  const scripts = await evaluate(client, "(() => { const all = [...document.querySelectorAll('script[src]')].map(s => s.src); return { urls: all.slice(0, 20), total: all.length }; })()");
  const scriptUrls = scripts?.urls || [];
  const scriptFailures = [];
  let scriptsScanned = 0;
  let scriptsCapped = 0;
  for (const su of scriptUrls) {
    // The label reaches the artifact (`source`) and the log, and a page-selected URL
    // can carry a credential in its query, so both go through the same redactor the
    // rest of the artifact uses (6fe review: this path used to persist ?api_key=...).
    const scriptLabel = redactUrlCredentialValues(su).split('/').pop();
    try {
      const got = await evaluate(client, `(async () => {
        const classifyScriptFetch = ${classifyScriptFetch.toString()};
        try {
          const MAX = ${FETCH_MAX_BYTES};
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ${fetchDeadlineMsDefault});
          try {
            const res = await fetch(${JSON.stringify(su)}, { signal: controller.signal });
            const verdict = classifyScriptFetch({
              httpOk: res.ok,
              status: res.status,
              contentType: res.headers.get('content-type'),
              hasStream: !!(res.body && res.body.getReader),
              declaredLength: res.headers.get('content-length'),
            });
            if (!verdict.ok) {
              return {
                text: '',
                truncated: !!verdict.truncated,
                ok: false,
                error: verdict.error,
                finalUrl: typeof res.url === 'string' ? res.url : null,
              };
            }
            const reader = res.body.getReader();
            const chunks = [];
            let total = 0;
            let hitCap = false;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              total += value.byteLength;
              if (total >= MAX) { hitCap = true; try { await reader.cancel(); } catch {} break; }
            }
            const buf = new Uint8Array(Math.min(total, MAX));
            let off = 0;
            for (const c of chunks) {
              const n = Math.min(c.byteLength, buf.byteLength - off);
              if (n <= 0) break;
              buf.set(c.subarray(0, n), off);
              off += n;
            }
            return { text: new TextDecoder().decode(buf), truncated: hitCap, ok: true };
          } finally { clearTimeout(timer); }
        } catch (e) {
          // A rejection or an aborted (deadline) fetch is a script that was NOT
          // read. It must say so instead of coming back as an empty success.
          const reason = e && e.name === 'AbortError' ? 'fetch deadline exceeded' : ((e && e.message) || String(e));
          return { text: '', truncated: false, ok: false, error: reason };
        }
      })()`, { awaitPromise: true });
      if (!got || got.ok !== true) {
        const reason = (got && got.error) || 'the in-page fetch returned no result';
        scriptFailures.push(scriptFetchFailure(su, reason, got && got.finalUrl));
        log(`[secrets] external JS NOT scanned (${reason}): ${scriptLabel}`);
        continue;
      }
      const js = typeof got.text === 'string' ? got.text : '';
      scriptsScanned++;
      if (got.truncated) {
        scriptsCapped++;
        log(`[secrets] external JS body capped at ${FETCH_MAX_BYTES} bytes: ${scriptLabel}`);
      }
      if (js) findings.push(...scanTextForSecrets(js, 'external JS: ' + scriptLabel, seen));
    } catch (e) {
      // The evaluate itself failing (a page that navigated away, a CDP error) is
      // also an unread script, not a silent skip - and it goes through the SAME
      // redacting record builder as the in-page verdict (6fe review).
      const reason = 'in-page fetch could not be evaluated: ' + ((e && e.message) || String(e));
      scriptFailures.push(scriptFetchFailure(su, reason));
      log(`[secrets] external JS NOT scanned (${reason}): ${scriptLabel}`);
    }
  }
  // 4. Meta tags
  const meta = await evaluate(client, "[...document.querySelectorAll('meta')].map(m=>m.content||'').join(' ')");
  findings.push(...scanTextForSecrets(meta || '', 'meta tags', seen));
  announceCap('secrets.findings', 30, findings.length, log);
  announceCap('secrets.externalScriptsSampled', scriptUrls.length, scripts?.total ?? scriptUrls.length, log);
  if (scriptFailures.length) {
    log(
      `[evidence] WARNING: ${scriptFailures.length} of ${scriptUrls.length} external script URL(s) could NOT be read and were NOT scanned: ` +
        scriptFailures.map((f) => `${f.url.split('/').pop()} (${f.reason})`).join(', ') +
        '. A miss in this sample is not evidence of absence.',
    );
  }
  const summary = {
    primitive: 'secrets',
    url,
    scannedAt: new Date().toISOString(),
    totalFindings: findings.length,
    findings: findings.slice(0, 30),
    findingsTruncated: findings.length > 30,
    externalScriptsAttempted: scriptUrls.length,
    externalScriptsScanned: scriptsScanned,
    externalScriptsCapped: scriptsCapped,
    externalScriptsFailed: scriptFailures.length,
    externalScriptFailures: scriptFailures,
    externalScriptsTotal: scripts?.total ?? scriptUrls.length,
    externalScriptsTruncated: (scripts?.total ?? scriptUrls.length) > scriptUrls.length,
    note: 'Descriptive signal, not a verdict. externalScriptsScanned counts only the scripts that were actually READ; a script counted there may be only PARTIALLY read when externalScriptsCapped > 0 (the body was cut at the byte cap), so treat the tail of a capped script as unscanned. An entry in externalScriptFailures (HTTP error, HTML response, fetch deadline, bounded-read refusal) was NOT scanned, so a miss there is not evidence of absence. The MODEL must REASON about each finding: legitimate public API keys (e.g. Google Maps keys, Stripe publishable keys) are EXPECTED to be client-side and are NOT security issues. Actual sensitive secrets (AWS keys, Stripe SECRET keys, JWTs, private keys, DB connection strings, GitHub/Slack tokens) exposed client-side ARE critical be-private-and-secure failures. Judge each finding accordingly.',
  };
  return emit(opts, summary, client);
}

// A response header is one of three things, and the artifact has to show which:
// absent (null), present with a value, or present but EMPTY. An empty security
// header protects nothing, so it is not a pass, and it must not read as absent
// either - the first would be false assurance and the second is the false negative
// this primitive was just fixed for. `present` is therefore a null check rather
// than a truthiness test, `empty` records the third state, and `issues` says what
// is wrong with whichever state it is (web-uplift-0w6).
