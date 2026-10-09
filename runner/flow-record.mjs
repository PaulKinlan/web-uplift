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
// Main-frame navigations are captured from Page.frameNavigated.
//
// Security & Privacy (web-uplift-r5t):
// Form values are sanitized by default before being written to flow.json:
// 1. Password fields (type="password") are never recorded (empty string).
// 2. Hidden inputs (type="hidden") are omitted by default to prevent leaking CSRF
//    tokens, session identifiers, or internal state into durable flow files.
//    Capturing hidden input values requires explicit opt-in (--capture-hidden).
// 3. Credential-shaped and PII-bearing fields (autocomplete=cc-*/one-time-code, or
//    names/IDs/labels matching credential, payment, and sensitive PII patterns)
//    have their values redacted (value: "", redacted: true) using the names-based
//    dsj pipeline.

// Words that mark a field as credential-shaped, payment-bearing, or sensitive PII.
export const SENSITIVE_WORDS = new Set([
  // credentials (the dsj pipeline: evidence/cli.mjs CREDENTIAL_WORDS)
  'passwd', 'password', 'pwd', 'secret', 'token', 'apikey', 'auth', 'authorization',
  'session', 'sessionid', 'sig', 'signature', 'credential', 'credentials', 'bearer',
  'jwt', 'otp', 'key', 'accesstoken', 'refreshtoken', 'clientsecret', 'privatekey',
  'accesskey', 'secretkey', 'idtoken', 'code', 'passcode', 'pin', 'csrf', 'xsrf',
  'security',
  // payment & financial
  'cvv', 'cvc', 'csc', 'cardnumber', 'creditcard', 'cardholder', 'routing', 'iban', 'swift',
  // sensitive PII & identity numbers
  'ssn', 'socialsecurity', 'taxid'
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
  if (isSensitiveWord(words.join(''))) return true;
  if (words.some(isSensitiveWord)) return true;
  for (let i = 0; i < words.length - 1; i++) {
    if (isSensitiveWord(words[i] + words[i + 1])) return true;
  }
  return false;
}

export function isSensitiveField(desc, { captureHidden = false } = {}) {
  if (!desc) return false;
  const type = (desc.type || '').toLowerCase();
  if (type === 'password') return true;
  if (type === 'hidden') return !captureHidden;

  const ac = (desc.autocomplete || (typeof desc.getAttribute === 'function' ? desc.getAttribute('autocomplete') : '') || '').toLowerCase().trim();
  if (ac.startsWith('cc-') || ac === 'one-time-code' || ac === 'current-password' || ac === 'new-password' || ac.includes('password')) {
    return true;
  }

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

// The page-side capture script. Kept as a string template so it can be injected via
// Page.addScriptToEvaluateOnNewDocument (runs before page scripts, every load).
export function makeCaptureJs({ captureHidden = false } = {}) {
  return `
(() => {
  if (window.__wuRec) return;
  window.__wuRec = true;
  const CAPTURE_HIDDEN = ${captureHidden ? 'true' : 'false'};
  const send = (step) => { try { window.__wuRecordStep(JSON.stringify(step)); } catch (e) {} };

  const SENSITIVE_WORDS = new Set([
    'passwd', 'password', 'pwd', 'secret', 'token', 'apikey', 'auth', 'authorization',
    'session', 'sessionid', 'sig', 'signature', 'credential', 'credentials', 'bearer',
    'jwt', 'otp', 'key', 'accesstoken', 'refreshtoken', 'clientsecret', 'privatekey',
    'accesskey', 'secretkey', 'idtoken', 'code', 'passcode', 'pin', 'csrf', 'xsrf',
    'security',
    'cvv', 'cvc', 'csc', 'cardnumber', 'creditcard', 'cardholder', 'routing', 'iban', 'swift',
    'ssn', 'socialsecurity', 'taxid'
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
    if (isSensitiveWord(words.join(''))) return true;
    if (words.some(isSensitiveWord)) return true;
    for (let i = 0; i < words.length - 1; i++) {
      if (isSensitiveWord(words[i] + words[i + 1])) return true;
    }
    return false;
  };

  const isSensitiveField = (el) => {
    if (!el) return false;
    const type = (el.type || '').toLowerCase();
    if (type === 'password') return true;
    if (type === 'hidden') return !CAPTURE_HIDDEN;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase().trim();
    if (ac.startsWith('cc-') || ac === 'one-time-code' || ac === 'current-password' || ac === 'new-password' || ac.includes('password')) {
      return true;
    }
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
    if (sensitive && type !== 'password') {
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

export async function recordFlow(client, url, { log = () => {}, captureHidden = false } = {}) {
  const steps = [{ type: 'setViewport', width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false }];
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
      lastNav = frame.url;
      steps.push({ type: 'navigate', url: frame.url });
      log(`[flow-record] navigate ${frame.url}`);
    }
  });

  await client.Page.addScriptToEvaluateOnNewDocument({ source: makeCaptureJs({ captureHidden }) });
  await client.Page.navigate({ url });
  log('[flow-record] recording... interact with the page, then click Done.');

  await finished;
  return { title: `Recorded flow (${new URL(url).host})`, steps };
}
