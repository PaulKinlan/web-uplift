// The zero-knowledge flow recorder. `web-uplift flow record <url>` opens a headed
// browser and WE inject a tiny recorder + an on-page overlay, so the user just
// clicks through their journey and presses Done - they never need to know Chrome
// DevTools' Recorder panel exists. Output is Chrome-Recorder-compatible flow.json,
// so it replays through the same runner/flow.mjs replayer.
//
// Mechanics (raw CDP, no Playwright): a capture script is injected on every new
// document (so it survives MPA navigations and SPA route changes); it records
// clicks and input changes with resilient selectors (data-testid / aria / role+
// text before a CSS path) and reports each step to Node through a CDP binding.
// Main-frame navigations are captured from Page.frameNavigated and sanitized.
//
// Security & Privacy (web-uplift-r5t):
// Form values are sanitized by default before being written to flow.json:
// 1. Password fields (type="password") are never recorded by default (empty string, redacted: true).
// 2. Hidden inputs (type="hidden") are omitted by default to prevent leaking CSRF
//    tokens, session identifiers, or internal state into durable flow files.
//    Capturing hidden input values requires explicit opt-in (--capture-hidden).
// 3. Credential-shaped and PII-bearing fields (email, phone, name, address, payment,
//    tokens, and sensitive identity numbers, by type, tokenized autocomplete, or name
//    heuristics) have their values redacted (value: "", redacted: true). Capturing
//    unredacted sensitive values for local test replay requires explicit opt-in
//    (--capture-sensitive).
// 4. Navigation URLs: Query parameter keys matching sensitive field tokens and query
//    values matching PII formats (emails, phone numbers, auth tokens) are redacted in
//    captured navigation steps, while innocent search queries and postal codes
//    remain preserved. The same rules are applied to PATH segments (a user profile
//    URL like /user/alice@example.com must not persist the email) and to the
//    FRAGMENT (which may be query-like: #email=...&tab=2, or an SPA route that
//    hides the value in a parameter KEY: #/user/alice@example.com?tab=2). Path
//    segments right after a sensitive marker (/token/abc123, /reset-password/<tok>,
//    /verify/<code>) are values too, as is a segment or bare fragment that is
//    itself token-shaped (an opaque id, a JWT, a ya29.* token), and URL userinfo
//    is scrubbed. Long digit sequences are only treated as payment cards with real
//    payment context (a payment-named parameter or a Luhn-valid value), so innocent
//    numeric ids survive replay.
// 5. The word list itself lives in ONE place - evidence/credential-terms.mjs, shared
//    with the HAR credential redactor (web-uplift-glar/lw6) - and the page-side copy
//    the capture script injects is GENERATED from it, so the browser cannot hold a
//    third, drifted table (web-uplift-so2).
// 6. The recording binding is ISOLATED, AUTHENTICATED and every step is validated before
//    it is persisted (web-uplift-sg5). `__wuRecordStep` is a CDP binding, and a binding
//    added the plain way is a function on the PAGE global: any page script (or a
//    third-party script the page loads) can call it, and the step it sends used to go
//    straight into flow.json - so a hostile page could add a navigate step to its own URL,
//    or a change step (password field, value) the operator never typed, and the operator
//    would replay it. Four layers now, because they fail differently:
//    - ISOLATION: the emitter runs in its own execution world
//      (Page.addScriptToEvaluateOnNewDocument worldName, and Runtime.addBinding bound to
//      that world). The page cannot SEE or CALL the binding at all, so the attack is not
//      "forge a payload", it is unreachable. Note that a review caught the earlier,
//      page-world version: a token that is merely closed over is still reachable, because
//      the emitter had to call the page-global JSON.stringify to send it.
//    - TRUST: a listener only records an event the user agent itself produced (isTrusted).
//      Without it a page could dispatch a synthetic click or change on any element and the
//      recorder would sign it with its own token; the Done control is the same, so a page
//      cannot end a recording either.
//    - AUTHENTICITY: each recording also carries a token generated in Node and closed over
//      inside the injected script (and the injection keeps its own reference to the native
//      JSON.stringify), so a payload is only accepted from our emitter.
//    - SHAPE: the payload's step is rebuilt from an allowlist of types and fields with
//      bounds. A refused payload is counted, reported, and NEVER persisted.

// The credential/PII word list, its tokenisation and its two strengths
// (strong = any word of a name, weak = only the whole name) live in ONE shared
// module used by this recorder AND by the HAR credential redactor, because two
// tables for one concept drifted and each leaked what the other redacted
// (web-uplift-glar, web-uplift-lw6). `SENSITIVE_WORDS` is re-exported here for
// callers that only need the flat membership test.
import {
  SENSITIVE_WORDS,
  isCredentialName,
  isSensitiveName,
  isSensitiveWord,
  looksLikeToken,
  NAME_WORD_DATA,
} from '../evidence/credential-terms.mjs';
import { randomUUID } from 'node:crypto';

// What the recorder may persist, and how large each part may be (web-uplift-sg5). The
// page-side emitter can only produce clicks and changes; the replayer's other step types
// (navigate, keyDown, setViewport, ...) are produced by the RECORDER itself, not by the
// page, so a page-supplied step of one of those types is refused and reported.
const RECORDED_STEP_FIELDS = {
  click: ['selectors', 'target'],
  change: ['selectors', 'value', 'target', 'redacted'],
};
const MAX_STEP_SELECTOR_GROUPS = 32;
const MAX_STEP_SELECTORS_PER_GROUP = 8;
const MAX_SELECTOR_LENGTH = 500;
const MAX_STEP_VALUE_LENGTH = 10000;
const MAX_RECORDED_STEPS = 2000;
// How many refusals to print before going quiet (a hostile page can spam the binding,
// and a log flooded with identical warnings is a log the operator stops reading).
const MAX_REPORTED_REFUSALS = 5;

// Rebuild a page-supplied step from the allowlist rather than passing the object through:
// a field nobody validated is exactly what a page would use to smuggle something into a
// flow.json that gets replayed. Returns {ok, step} or {ok:false, reason}.
export function validateRecordedStep(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not a step object' };
  const type = typeof raw.type === 'string' ? raw.type : typeof raw.type;
  // Object.hasOwn, not a bare lookup: `raw.type` comes from a page, and RECORDED_STEP_FIELDS
  // inherits from Object.prototype, so type "__proto__" or "constructor" resolved to a
  // non-array and threw instead of refusing (web-uplift-sg5 review).
  const fields = typeof raw.type === 'string' && Object.hasOwn(RECORDED_STEP_FIELDS, raw.type) ? RECORDED_STEP_FIELDS[raw.type] : null;
  if (!fields) return { ok: false, reason: `type ${JSON.stringify(type)} is not a type the recorder emits` };
  // `type` selects the allowlist, so it is not an "extra" field: the first version of
  // this check refused the recorder's OWN click step ("unexpected field(s) type"), which
  // the browser repro caught by showing a legitimate click missing from the flow.
  const extra = Object.keys(raw).filter((key) => key !== 'type' && !fields.includes(key));
  if (extra.length) return { ok: false, reason: `unexpected field(s) ${extra.join(', ')}` };
  const groups = raw.selectors;
  if (!Array.isArray(groups) || groups.length === 0 || groups.length > MAX_STEP_SELECTOR_GROUPS) {
    return { ok: false, reason: `selectors must be 1-${MAX_STEP_SELECTOR_GROUPS} groups` };
  }
  const selectors = [];
  for (const group of groups) {
    if (!Array.isArray(group) || group.length === 0 || group.length > MAX_STEP_SELECTORS_PER_GROUP) {
      return { ok: false, reason: `each selector group must hold 1-${MAX_STEP_SELECTORS_PER_GROUP} selectors` };
    }
    const clean = [];
    for (const selector of group) {
      if (typeof selector !== 'string' || !selector || selector.length > MAX_SELECTOR_LENGTH) {
        return { ok: false, reason: `a selector must be a non-empty string of at most ${MAX_SELECTOR_LENGTH} characters` };
      }
      clean.push(selector);
    }
    selectors.push(clean);
  }
  const step = { type: raw.type, selectors };
  if (raw.type === 'change') {
    if (typeof raw.value !== 'string') return { ok: false, reason: 'a change value must be a string' };
    if (raw.value.length > MAX_STEP_VALUE_LENGTH) return { ok: false, reason: `a change value must be at most ${MAX_STEP_VALUE_LENGTH} characters` };
    // The redaction guarantee stays here, not in the page: a step flagged redacted can
    // never carry a value, whatever the emitter sends.
    if (raw.redacted) { step.redacted = true; step.value = ''; } else { step.value = raw.value; }
  }
  if (raw.target !== undefined) {
    if (typeof raw.target !== 'string' || raw.target.length > 64) return { ok: false, reason: 'target must be a string of at most 64 characters' };
    step.target = raw.target;
  }
  return { ok: true, step };
}

export { SENSITIVE_WORDS, isSensitiveWord };

export const hasSensitiveWord = (str) => isSensitiveName(str);
export function isSensitiveAutocomplete(ac) {
  if (!ac || typeof ac !== 'string') return false;
  const tokens = ac.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.some((s) => {
    if (s.startsWith('cc-')) return true;
    if (s.startsWith('tel')) return true;
    if (s === 'email') return true;
    if (s === 'one-time-code' || s === 'current-password' || s === 'new-password' || s.includes('password')) return true;
    if (s === 'name' || s === 'given-name' || s === 'family-name' || s === 'additional-name' || s === 'nickname' || s === 'username') return true;
    if (s.startsWith('address-') || s === 'street-address' || s === 'country' || s === 'country-name') return true;
    if (s.startsWith('bday') || s === 'sex') return true;
    if (s.startsWith('transaction-')) return true;
    return isSensitiveWord(s.replace(/[^a-z0-9]+/g, ''));
  });
}

export function isSensitiveField(desc, { captureHidden = false, captureSensitive = false } = {}) {
  if (!desc) return false;
  if (captureSensitive) return false;
  const type = (desc.type || '').toLowerCase();
  if (type === 'password') return true;
  if (type === 'hidden') return !captureHidden;
  if (type === 'email' || type === 'tel') return true;

  const ac = (desc.autocomplete || (typeof desc.getAttribute === 'function' ? desc.getAttribute('autocomplete') : '') || '').toLowerCase().trim();
  if (isSensitiveAutocomplete(ac)) return true;

  const aria = desc.ariaLabel || (typeof desc.getAttribute === 'function' ? desc.getAttribute('aria-label') : '') || '';
  const placeholder = desc.placeholder || (typeof desc.getAttribute === 'function' ? desc.getAttribute('placeholder') : '') || '';
  const labelText = desc.label || (desc.labels && desc.labels.length ? Array.from(desc.labels).map((l) => l.textContent || '').join(' ') : '') || '';
  const name = desc.name || '';
  const id = desc.id || '';

  if (hasSensitiveWord(name) ||
      hasSensitiveWord(id) ||
      hasSensitiveWord(aria) ||
      hasSensitiveWord(placeholder) ||
      hasSensitiveWord(labelText)) {
    return true;
  }

  return false;
}

// Payment-context tokens: a long digit sequence is only treated as a card number
// when the surrounding parameter/field name points at payment (or the value itself
// is Luhn-valid). Without this, /(?:\d[ -]*?){13,19}\b/ redacts ANY 13-19 digit
// value - an innocent ?orderId=1234567890123 is corrupted, breaking replay.
const PAYMENT_KEY_WORDS = new Set(['cc', 'pan', 'cvv', 'cvc', 'csc']);

// Path segments that mark the FOLLOWING segment as a value (/token/abc123,
// /session/<id>). Deliberately narrower than SENSITIVE_WORDS: a route word like
// "security" in /settings/security must not turn the next route segment into a
// redaction. Bare "key" is safe here - a path segment, unlike a form-field
// name, is never sortKey/postalCode.
const PATH_VALUE_MARKERS = new Set(['token', 'secret', 'key', 'session']);

// Markers that are ALSO ordinary route words (web-uplift-hi3): /auth/callback and
// /settings/password/change are routes, /verify/abc123 and /reset-password/<tok>
// are credentials. These only redact the next segment when that segment itself
// carries a value shape - a token, PII, or a short OTP-style code - so a real
// route word is never thrown away. That last test is anchored (/^[A-Z0-9]{4,10}$/)
// rather than a bare /\d/, which used to redact /auth/v1, /auth/oauth2, /auth/2fa,
// /auth/step1 and /settings/password/step2.
const ROUTE_VALUE_MARKERS = new Set([
  'auth', 'authorize', 'authorization', 'verify', 'verification', 'validate',
  'confirm', 'confirmation', 'activate', 'activation', 'reset', 'password',
  'code', 'otp', 'totp', 'invite', 'unlock', 'recover', 'recovery',
]);

// A short uppercase code after a route marker: 483920, ABCDEF, A1B2C3. An
// all-letter OTP is as much a credential as a numeric one (web-uplift-hi3 review).
const ROUTE_CODE_SHAPE = /^[A-Z0-9]{4,10}$/;

// The words of one path segment, so a hyphenated marker (/reset-password) is
// recognised by its parts.
const segmentWords = (seg) => seg.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export function hasPaymentWord(str) {
  if (!str || typeof str !== 'string') return false;
  const words = str
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!words.length) return false;
  if (words.some((w) => PAYMENT_KEY_WORDS.has(w))) return true;
  const joined = words.join('');
  return joined.includes('card') || joined.includes('credit') || joined.includes('payment');
}

// Luhn checksum: a 13-19 digit value that passes is almost certainly a real card
// number regardless of the parameter name it arrived under.
export function luhnValid(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

export function isSensitiveNavValue(v, key = '') {
  if (!v || typeof v !== 'string') return false;
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(v)) return true;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(v)) return true;
  // Payment cards: only with real payment context (payment-named key or a
  // Luhn-valid value) - never a bare numeric identifier like an order id.
  if (/^[\d -]+$/.test(v)) {
    const digits = v.replace(/[^\d]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && (luhnValid(digits) || hasPaymentWord(key))) return true;
  }
  // Phone numbers require phone FORMATTING: a separator between each group, which
  // also requires the whole value to be a number and nothing else. A bare 10-13
  // digit id is not a phone number, and neither is a UUID or a date that merely
  // contains a 3-3-4 digit run - the separators are what make this a phone
  // (review of web-uplift-hi3 found /orders/<uuid> being rewritten as a phone).
  if (v.trim() === v && /^\+?(?:\d{1,3}[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}$/.test(v)) return true;
  return false;
}

export function sanitizeNavUrl(raw) {
  if (!raw || typeof raw !== 'string' || raw.startsWith('about:')) return raw;
  try {
    const u = new URL(raw);
    let modified = false;
    // Userinfo is a credential when a password is present, and an opaque
    // userinfo is a token (https://<token>@host/): scrub it. A plain username
    // with no password is left alone, so a user page keeps its evidence.
    if (u.password || looksLikeToken(u.username) || isSensitiveNavValue(u.username)) {
      u.username = '[redacted]';
      if (u.password) u.password = '[redacted]';
      modified = true;
    }
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (!v) continue;
      // The weak words (bare code/key) ARE credentials in a URL: ?code= is an
      // OAuth callback code and ?key= an API key (web-uplift-lw6).
      if (isCredentialName(k) || isSensitiveName(k) || isSensitiveNavValue(v, k)) {
        u.searchParams.set(k, '[redacted]');
        modified = true;
      }
    }
    const sanitizePath = (pathname) => {
      if (!pathname || pathname === '/') return { modified: false, pathname };
      let pathModified = false;
      const rawSegs = pathname.split('/');
      const segs = rawSegs.map((seg, i) => {
        if (!seg) return seg;
        let decoded = seg;
        try { decoded = decodeURIComponent(seg); } catch { /* keep raw */ }
        if (isSensitiveNavValue(decoded)) { pathModified = true; return '[redacted]'; }
        // A segment that IS the credential, with no name to classify:
        // /reset-password/a8f9c0e2d4b6, /files/AbCdEf1234567890, a bare fragment
        // that is a ya29.* token. Word-shaped segments never match (see
        // looksLikeToken), so /about-us and /my-first-post survive.
        if (looksLikeToken(decoded)) { pathModified = true; return '[redacted]'; }
        if (i > 0) {
          let prev = rawSegs[i - 1];
          try { prev = decodeURIComponent(prev); } catch { /* keep raw */ }
          const prevWords = segmentWords(prev);
          if (prevWords.some((w) => PATH_VALUE_MARKERS.has(w))) { pathModified = true; return '[redacted]'; }
          if (prevWords.some((w) => ROUTE_VALUE_MARKERS.has(w)) &&
              (looksLikeToken(decoded) || isSensitiveNavValue(decoded) || ROUTE_CODE_SHAPE.test(decoded))) {
            pathModified = true;
            return '[redacted]';
          }
        }
        return seg;
      });
      return { modified: pathModified, pathname: segs.join('/') };
    };

    if (u.pathname && u.pathname !== '/') {
      const pathRes = sanitizePath(u.pathname);
      if (pathRes.modified) {
        u.pathname = pathRes.pathname;
        modified = true;
      }
    }
    // Fragments can be query-like (#email=...&tab=2), route-like (#/token/abc123?tab=2), or a bare PII value.
    if (u.hash && u.hash.length > 1) {
      const frag = u.hash.slice(1);
      let fragPath = frag;
      let fragSearch = '';
      const qIdx = frag.indexOf('?');
      if (qIdx !== -1) {
        fragPath = frag.slice(0, qIdx);
        fragSearch = frag.slice(qIdx);
      } else if (frag.includes('=') && !frag.startsWith('/')) {
        fragSearch = '?' + frag;
        fragPath = '';
      }

      let fragModified = false;
      if (fragPath) {
        const res = sanitizePath(fragPath);
        if (res.modified) { fragPath = res.pathname; fragModified = true; }
      }
      
      if (fragSearch) {
        const params = new URLSearchParams(fragSearch.slice(1));
        let searchModified = false;
        for (const [k, v] of [...params.entries()]) {
          // SPA router fragments hide the value in the parameter KEY:
          // #/user/alice@example.com?tab=2 parses as key
          // "/user/alice@example.com?tab". A key carrying a sensitive
          // value-shape cannot be value-redacted, so the parameter is omitted.
          if (isSensitiveNavValue(k)) {
            params.delete(k);
            searchModified = true;
            continue;
          }
          if (!v) continue;
          if (isCredentialName(k) || isSensitiveName(k) || isSensitiveNavValue(v, k)) {
            params.set(k, '[redacted]');
            searchModified = true;
          }
        }
        if (searchModified) {
          const newSearch = params.toString();
          fragSearch = newSearch ? '?' + newSearch : '';
          fragModified = true;
        }
      }
      
      if (fragModified) {
        let newHash = fragPath;
        if (!fragPath && qIdx === -1 && fragSearch.startsWith('?')) {
          newHash = fragSearch.slice(1);
        } else {
          newHash = fragPath + fragSearch;
        }
        u.hash = newHash;
        modified = true;
      }
    }
    return modified ? u.toString() : raw;
  } catch {
    return raw;
  }
}

// The execution world the capture script and its binding live in (web-uplift-sg5). The
// page's own scripts run in the main world and cannot see into this one, which is what
// makes the binding unreachable for a hostile page rather than merely guarded.
export const RECORDER_WORLD = '__wuRecorderWorld';

// The page-side capture script. Kept as a string template so it can be injected via
// Page.addScriptToEvaluateOnNewDocument (runs before page scripts, every load).
export function makeCaptureJs({ captureHidden = false, captureSensitive = false, token = '' } = {}) {
  return `
(() => {
  if (window.__wuRec) return;
  window.__wuRec = true;
  const CAPTURE_HIDDEN = ${captureHidden ? 'true' : 'false'};
  const CAPTURE_SENSITIVE = ${captureSensitive ? 'true' : 'false'};
  // Layer 2 (the page cannot reach this world at all - see RECORDER_WORLD): a token that
  // exists only inside this closure, plus our OWN reference to the native JSON.stringify
  // (web-uplift-sg5). A review showed why the second half matters: a token that is closed
  // over is not secret if the emitter has to call a PAGE-GLOBAL function to send it - a
  // page that replaces JSON.stringify reads the token off the next legitimate send and
  // then forges payloads. Both references are taken here, before any page script runs.
  const TOKEN = ${JSON.stringify(token)};
  const wuSend = window.__wuRecordStep;
  const wuStringify = JSON.stringify;
  const send = (step) => { try { wuSend(wuStringify({ __wu: TOKEN, step })); } catch (e) {} };

  // The word data is injected from evidence/credential-terms.mjs (the ONE table,
  // shared with the HAR redactor): a third hand-maintained list here is exactly
  // how web-uplift-so2 happened. The matching logic below mirrors the module's
  // isSensitiveName; the flow test suite drives both on the same case list.
  const CREDENTIAL_WORDS = new Set(${JSON.stringify(NAME_WORD_DATA.credential)});
  const PII_WORDS = new Set(${JSON.stringify(NAME_WORD_DATA.pii)});
  const SHORT_PII_WORDS = new Set(${JSON.stringify(NAME_WORD_DATA.shortPii)});
  const member = (set, w) => set.has(w) || (w.endsWith('s') && set.has(w.slice(0, -1)));
  const credentialWord = (w) => member(CREDENTIAL_WORDS, w);
  const piiWord = (w) => member(PII_WORDS, w) || SHORT_PII_WORDS.has(w);
  const sensitiveWord = (w) => credentialWord(w) || piiWord(w);

  const splitName = (str) => {
    if (!str || typeof str !== 'string') return [];
    return str
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  };

  const isSensitiveName = (str) => {
    const words = splitName(str);
    if (!words.length) return false;
    if (words.some((w) => piiWord(w) || credentialWord(w))) return true;
    const joined = words.join('');
    if (sensitiveWord(joined)) return true;
    for (let i = 0; i < words.length - 1; i++) {
      if (sensitiveWord(words[i] + words[i + 1])) return true;
    }
    return false;
  };

  const isSensitiveAutocomplete = (ac) => {
    if (!ac || typeof ac !== 'string') return false;
    const tokens = ac.toLowerCase().split(/\\s+/).filter(Boolean);
    if (!tokens.length) return false;
    return tokens.some((s) => {
      if (s.startsWith('cc-')) return true;
      if (s.startsWith('tel')) return true;
      if (s === 'email') return true;
      if (s === 'one-time-code' || s === 'current-password' || s === 'new-password' || s.includes('password')) return true;
      if (s === 'name' || s === 'given-name' || s === 'family-name' || s === 'additional-name' || s === 'nickname' || s === 'username') return true;
      if (s.startsWith('address-') || s === 'street-address' || s === 'country' || s === 'country-name') return true;
      if (s.startsWith('bday') || s === 'sex') return true;
      if (s.startsWith('transaction-')) return true;
      return sensitiveWord(s.replace(/[^a-z0-9]+/g, ''));
    });
  };

  const isSensitiveField = (el) => {
    if (!el) return false;
    if (CAPTURE_SENSITIVE) return false;
    const type = (el.type || '').toLowerCase();
    if (type === 'password') return true;
    if (type === 'hidden') return !CAPTURE_HIDDEN;
    if (type === 'email' || type === 'tel') return true;

    const ac = (el.getAttribute('autocomplete') || '').toLowerCase().trim();
    if (isSensitiveAutocomplete(ac)) return true;

    const labelText = el.labels && el.labels.length ? Array.from(el.labels).map((l) => l.textContent || '').join(' ') : '';
    const aria = el.getAttribute('aria-label') || '';
    const placeholder = el.placeholder || '';
    if (isSensitiveName(el.name) ||
        isSensitiveName(el.id) ||
        isSensitiveName(aria) ||
        isSensitiveName(placeholder) ||
        isSensitiveName(labelText)) {
      return true;
    }
    return false;
  };

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let sel = node.tagName.toLowerCase();
      const p = node.parentElement;
      if (p) {
        const sibs = [...p.children].filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      if (node.id) { parts[0] = '#' + CSS.escape(node.id); break; }
      node = p;
    }
    return parts.join(' > ');
  };

  const selectorsFor = (el) => {
    const alts = [];
    if (el.id) alts.push(['#' + CSS.escape(el.id)]);
    const tid = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (tid) alts.push(['[data-testid="' + tid + '"]']);
    const aria = el.getAttribute('aria-label');
    if (aria) alts.push(['aria/' + aria]);
    const txt = (el.textContent || '').trim();
    if (txt && txt.length <= 40 && ['A', 'BUTTON', 'SUMMARY', 'LABEL'].includes(el.tagName)) alts.push(['aria/' + txt]);
    alts.push([cssPath(el)]);
    return alts;
  };

  // Layer 3: only an event the user agent produced is recordable. A page can dispatch a
  // synthetic click or change on any element, and without this check the recorder would
  // sign it with its own token and the operator would replay a step they never took
  // (web-uplift-sg5 review). Refused silently, on purpose: a page can dispatch events in a
  // loop, and a page-triggered log line is a log flood.
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const el = e.target.closest('a,button,[role=button],input[type=submit],input[type=button],summary,[onclick]') || e.target;
    if (el && el.id === '__wu_done') return; // the Done control itself
    send({ type: 'click', selectors: selectorsFor(el), target: 'main' });
  }, true);

  document.addEventListener('change', (e) => {
    if (!e.isTrusted) return;
    const el = e.target;
    if (!el || !('value' in el)) return;
    const type = (el.type || '').toLowerCase();
    if (type === 'hidden' && !CAPTURE_HIDDEN) {
      // Do not persist hidden-input values by default.
      return;
    }
    const sensitive = isSensitiveField(el);
    const val = sensitive ? '' : el.value;
    const step = { type: 'change', selectors: selectorsFor(el), value: val, target: 'main' };
    if (sensitive) {
      step.redacted = true;
    }
    send(step);
  }, true);

  // Overlay: a small always-on-top banner with a Done button.
  const mount = () => {
    if (document.getElementById('__wu_bar')) return;
    const bar = document.createElement('div');
    bar.id = '__wu_bar';
    bar.setAttribute('style', 'position:fixed;z-index:2147483647;top:12px;right:12px;background:#171b21;color:#e6e9ee;font:14px system-ui;border:1px solid #5b8def;border-radius:10px;padding:10px 12px;box-shadow:0 6px 20px rgba(0,0,0,.4);display:flex;gap:10px;align-items:center');
    bar.innerHTML = '<span style="color:#f04438">\\u25CF</span> Recording your journey' +
      '<button id="__wu_done" style="background:#5b8def;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit">Done</button>';
    document.documentElement.appendChild(bar);
    document.getElementById('__wu_done').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      // The Done control is OUR control, but a page can click it programmatically: a real
      // user gesture is the only thing that ends a recording.
      if (!e.isTrusted) return;
      send({ type: '__done' });
    }, true);

    // Overlay-removal detection (web-uplift-q7s6): if page scripts remove the overlay
    // or its Done control, the operator can never click Done. Notify Node so the
    // recording terminates instead of hanging indefinitely.
    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(() => {
        if (!bar.isConnected || !document.getElementById('__wu_done')) {
          observer.disconnect();
          send({ type: '__overlay_removed' });
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
`;
}

export async function recordFlow(client, url, { log = () => {}, captureHidden = false, captureSensitive = false, timeoutMs = 0 } = {}) {
  const steps = [{ type: 'setViewport', width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false }];
  if (captureSensitive) {
    log('[flow-record] WARNING: --capture-sensitive persists form values AND navigation URLs verbatim (needed for replay fidelity); treat the resulting flow.json as a secret and never commit or share it.');
  }
  let lastNav = null;
  let done;
  const finished = new Promise((r) => { done = r; });

  let timer = null;
  const finish = (reason) => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (reason === 'overlay_removed') {
      log('[flow-record] WARNING: recorder overlay was removed from the page; terminating recording');
    } else if (reason === 'timeout') {
      log(`[flow-record] WARNING: recording timed out after ${timeoutMs}ms; terminating recording`);
    }
    done();
  };

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      finish('timeout');
    }, timeoutMs);
  }

  // One token per recording, held only by the injected script's closure (see makeCaptureJs).
  const token = randomUUID();
  let refusedSteps = 0;
  const refuse = (why) => {
    refusedSteps += 1;
    if (refusedSteps <= MAX_REPORTED_REFUSALS) {
      log(`[flow-record] WARNING: refused a step the recorder did not emit (#${refusedSteps}: ${why}) - it was NOT recorded`);
    } else if (refusedSteps % 100 === 0) {
      log(`[flow-record] WARNING: ${refusedSteps} steps refused so far (last: ${why}) - none were recorded`);
    }
  };

  // Receive steps from the page over the CDP binding, bound to the ISOLATED world the
  // emitter runs in: the page's own scripts cannot see or call it (web-uplift-sg5).
  await client.Runtime.addBinding({ name: '__wuRecordStep', executionContextName: RECORDER_WORLD });
  client.Runtime.bindingCalled(({ name, payload }) => {
    if (name !== '__wuRecordStep') return;
    let msg;
    try { msg = JSON.parse(payload); } catch { return; }
    // The binding is page-callable, so an unauthenticated payload is a page trying to
    // write steps the operator never took (web-uplift-sg5). Never persisted.
    if (!msg || typeof msg !== 'object' || msg.__wu !== token) {
      refuse('it did not carry this recording\'s token');
      return;
    }
    if (msg.step && msg.step.type === '__done') { finish('done'); return; }
    if (msg.step && msg.step.type === '__overlay_removed') { finish('overlay_removed'); return; }
    if (steps.length >= MAX_RECORDED_STEPS) {
      refuse(`the recording already holds the maximum of ${MAX_RECORDED_STEPS} steps`);
      return;
    }
    const verdict = validateRecordedStep(msg.step);
    if (!verdict.ok) { refuse(verdict.reason); return; }
    steps.push(verdict.step);
    log(`[flow-record] captured ${verdict.step.type}${verdict.step.value != null ? ' = ' + JSON.stringify(verdict.step.value) : ''}`);
  });

  // Capture main-frame navigations (dedupe consecutive identical urls).
  client.Page.frameNavigated(({ frame }) => {
    if (frame.parentId) return; // main frame only
    if (frame.url && frame.url !== lastNav && !frame.url.startsWith('about:')) {
      const sanitizedUrl = captureSensitive ? frame.url : sanitizeNavUrl(frame.url);
      lastNav = frame.url;
      steps.push({ type: 'navigate', url: sanitizedUrl });
      log(`[flow-record] navigate ${sanitizedUrl}`);
    }
  });

  await client.Page.addScriptToEvaluateOnNewDocument({
    source: makeCaptureJs({ captureHidden, captureSensitive, token }),
    worldName: RECORDER_WORLD,
  });
  await client.Page.navigate({ url });
  log('[flow-record] recording... interact with the page, then click Done.');

  await finished;
  return { title: `Recorded flow (${new URL(url).host})`, steps };
}
