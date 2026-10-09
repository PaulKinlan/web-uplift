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
//    FRAGMENT (which may be query-like: #email=...&tab=2). Long digit sequences are
//    only treated as payment cards with real payment context (a payment-named
//    parameter or a Luhn-valid value), so innocent numeric ids survive replay.

// Words that mark a field as credential-shaped, payment-bearing, or sensitive PII.
// Note: Bare "code" and "key" are intentionally omitted to avoid over-broad matching
// on innocent form fields like postalCode, countryCode, sortKey. Explicit compound
// terms (passcode, one-time-code, securitycode, apiKey, etc.) are matched instead.
export const SENSITIVE_WORDS = new Set([
  // credentials (the dsj pipeline: evidence/cli.mjs CREDENTIAL_WORDS refined)
  'passwd', 'password', 'pwd', 'secret', 'token', 'apikey', 'auth', 'authorization',
  'session', 'sessionid', 'sig', 'signature', 'credential', 'credentials', 'bearer',
  'jwt', 'otp', 'mfa', 'onetimecode', 'accesstoken', 'refreshtoken', 'clientsecret', 'privatekey',
  'accesskey', 'secretkey', 'idtoken', 'passcode', 'pin', 'csrf', 'xsrf',
  'security', 'securitycode',
  // payment & financial
  'cvv', 'cvc', 'csc', 'cardnumber', 'creditcard', 'cardholder', 'routing', 'iban', 'swift',
  // sensitive PII & identity numbers
  'ssn', 'socialsecurity', 'taxid', 'dob', 'birthdate',
  // PII - email & phone
  'email', 'phone', 'telephone', 'mobile', 'cellphone',
  // PII - name
  'fullname', 'firstname', 'lastname', 'surname', 'username',
  // PII - address
  'address', 'street'
]);

export const isSensitiveWord = (w) =>
  SENSITIVE_WORDS.has(w) || (w.endsWith('s') && SENSITIVE_WORDS.has(w.slice(0, -1)));

export function hasSensitiveWord(str) {
  if (!str || typeof str !== 'string') return false;
  const words = str
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase / PascalCase boundary
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!words.length) return false;
  if (words.some((w) => w === 'name' || w === 'email' || w === 'phone' || w === 'tel' || isSensitiveWord(w))) return true;
  if (isSensitiveWord(words.join(''))) return true;
  for (let i = 0; i < words.length - 1; i++) {
    if (isSensitiveWord(words[i] + words[i + 1])) return true;
  }
  return false;
}

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
  // Phone numbers require phone formatting (separators, parentheses, or a +) so a
  // bare 10-13 digit id is not mistaken for a phone number.
  if (/[-.\s()+]/.test(v) && /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(v)) return true;
  return false;
}

export function sanitizeNavUrl(raw) {
  if (!raw || typeof raw !== 'string' || raw.startsWith('about:')) return raw;
  try {
    const u = new URL(raw);
    let modified = false;
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (!v) continue;
      if (hasSensitiveWord(k) || isSensitiveNavValue(v, k)) {
        u.searchParams.set(k, '[redacted]');
        modified = true;
      }
    }
    // Path segments carry values too: /user/alice@example.com/orders persists the
    // email unless the segment is redacted. Value-shape only (no key heuristics) so
    // routes like /settings/security are left alone.
    if (u.pathname && u.pathname !== '/') {
      let pathModified = false;
      const segs = u.pathname.split('/').map((seg) => {
        if (!seg) return seg;
        let decoded = seg;
        try { decoded = decodeURIComponent(seg); } catch { /* keep raw */ }
        if (isSensitiveNavValue(decoded)) { pathModified = true; return '[redacted]'; }
        return seg;
      });
      if (pathModified) {
        u.pathname = segs.join('/');
        modified = true;
      }
    }
    // Fragments can be query-like (#email=...&tab=2) or a bare PII value.
    if (u.hash && u.hash.length > 1) {
      const frag = u.hash.slice(1);
      let decoded = frag;
      try { decoded = decodeURIComponent(frag); } catch { /* keep raw */ }
      if (decoded.includes('=')) {
        const params = new URLSearchParams(decoded);
        let fragModified = false;
        for (const [k, v] of [...params.entries()]) {
          if (!v) continue;
          if (hasSensitiveWord(k) || isSensitiveNavValue(v, k)) {
            params.set(k, '[redacted]');
            fragModified = true;
          }
        }
        if (fragModified) {
          u.hash = params.toString();
          modified = true;
        }
      } else if (isSensitiveNavValue(decoded)) {
        u.hash = '[redacted]';
        modified = true;
      }
    }
    return modified ? u.toString() : raw;
  } catch {
    return raw;
  }
}

// The page-side capture script. Kept as a string template so it can be injected via
// Page.addScriptToEvaluateOnNewDocument (runs before page scripts, every load).
export function makeCaptureJs({ captureHidden = false, captureSensitive = false } = {}) {
  return `
(() => {
  if (window.__wuRec) return;
  window.__wuRec = true;
  const CAPTURE_HIDDEN = ${captureHidden ? 'true' : 'false'};
  const CAPTURE_SENSITIVE = ${captureSensitive ? 'true' : 'false'};
  const send = (step) => { try { window.__wuRecordStep(JSON.stringify(step)); } catch (e) {} };

  const SENSITIVE_WORDS = new Set([
    'passwd', 'password', 'pwd', 'secret', 'token', 'apikey', 'auth', 'authorization',
    'session', 'sessionid', 'sig', 'signature', 'credential', 'credentials', 'bearer',
    'jwt', 'otp', 'mfa', 'onetimecode', 'accesstoken', 'refreshtoken', 'clientsecret', 'privatekey',
    'accesskey', 'secretkey', 'idtoken', 'passcode', 'pin', 'csrf', 'xsrf',
    'security', 'securitycode',
    'cvv', 'cvc', 'csc', 'cardnumber', 'creditcard', 'cardholder', 'routing', 'iban', 'swift',
    'ssn', 'socialsecurity', 'taxid', 'dob', 'birthdate',
    'email', 'phone', 'telephone', 'mobile', 'cellphone',
    'fullname', 'firstname', 'lastname', 'surname', 'username',
    'address', 'street'
  ]);

  const isSensitiveWord = (w) => SENSITIVE_WORDS.has(w) || (w.endsWith('s') && SENSITIVE_WORDS.has(w.slice(0, -1)));
  const hasSensitiveWord = (str) => {
    if (!str || typeof str !== 'string') return false;
    const words = str
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (!words.length) return false;
    if (words.some((w) => w === 'name' || w === 'email' || w === 'phone' || w === 'tel' || isSensitiveWord(w))) return true;
    if (isSensitiveWord(words.join(''))) return true;
    for (let i = 0; i < words.length - 1; i++) {
      if (isSensitiveWord(words[i] + words[i + 1])) return true;
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
      return isSensitiveWord(s.replace(/[^a-z0-9]+/g, ''));
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
    if (hasSensitiveWord(el.name) ||
        hasSensitiveWord(el.id) ||
        hasSensitiveWord(aria) ||
        hasSensitiveWord(placeholder) ||
        hasSensitiveWord(labelText)) {
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

  document.addEventListener('click', (e) => {
    const el = e.target.closest('a,button,[role=button],input[type=submit],input[type=button],summary,[onclick]') || e.target;
    if (el && el.id === '__wu_done') return; // the Done control itself
    send({ type: 'click', selectors: selectorsFor(el), target: 'main' });
  }, true);

  document.addEventListener('change', (e) => {
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
      send({ type: '__done' });
    }, true);
  };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
`;
}

export async function recordFlow(client, url, { log = () => {}, captureHidden = false, captureSensitive = false } = {}) {
  const steps = [{ type: 'setViewport', width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false }];
  if (captureSensitive) {
    log('[flow-record] WARNING: --capture-sensitive persists form values AND navigation URLs verbatim (needed for replay fidelity); treat the resulting flow.json as a secret and never commit or share it.');
  }
  let lastNav = null;
  let done;
  const finished = new Promise((r) => { done = r; });

  // Receive steps from the page over the CDP binding.
  await client.Runtime.addBinding({ name: '__wuRecordStep' });
  client.Runtime.bindingCalled(({ name, payload }) => {
    if (name !== '__wuRecordStep') return;
    let step;
    try { step = JSON.parse(payload); } catch { return; }
    if (step.type === '__done') { done(); return; }
    if (step.type === 'change' && step.redacted) {
      step.value = '';
    }
    steps.push(step);
    log(`[flow-record] captured ${step.type}${step.value != null ? ' = ' + JSON.stringify(step.value) : ''}`);
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

  await client.Page.addScriptToEvaluateOnNewDocument({ source: makeCaptureJs({ captureHidden, captureSensitive }) });
  await client.Page.navigate({ url });
  log('[flow-record] recording... interact with the page, then click Done.');

  await finished;
  return { title: `Recorded flow (${new URL(url).host})`, steps };
}
