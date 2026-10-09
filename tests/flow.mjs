#!/usr/bin/env node
// Focused guard for the flow record/replay privacy + safety gates
// (web-uplift-r5t, web-uplift-bwh).
//
// r5t: the recorder must not persist PII/tokens. Values are redacted at capture
// (VM-driven injected handler) and navigation URLs are sanitized across query,
// PATH SEGMENTS, and FRAGMENTS. Long digit sequences are only cards with real
// payment context (payment-named key or Luhn-valid), so an innocent
// ?orderId=1234567890123 survives for replay.
//
// bwh: replay must not mutate live targets without --allow-mutations. The
// mutating-control predicate and the selector resolver are exported from
// runner/flow.mjs AND serialized into the page expressions, so this suite drives
// the exact code the page runs - a DOM stub in a vm context, not a mock that
// agrees with itself (the previous mock returned mutationBlocked for ANY
// expression containing "findMutatingControl", which was vacuous).
//
// This file is the fast, browser-free foreground check. Run it directly:
//   node tests/flow.mjs
// It is also imported by tests/regression.mjs so the full gate covers it.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function testFlowNormalize() {
  const { normalizeFlow } = await import('../runner/flow.mjs');

  // A Chrome DevTools Recorder export normalises cleanly (same shape we use).
  const recorderJson = {
    title: 'Search',
    steps: [
      { type: 'setViewport', width: 1200, height: 800 },
      { type: 'navigate', url: 'https://example.com/' },
      { type: 'click', selectors: [['aria/Search'], ['#go']], target: 'main' },
      null, // stray/empty entries are dropped
    ],
  };
  const flow = normalizeFlow(recorderJson);
  assert(flow.title === 'Search', 'flow: title should carry through');
  assert(flow.steps.length === 3, `flow: empty steps should be dropped, got ${flow.steps.length}`);
  assert(flow.steps[2].selectors[0][0] === 'aria/Search', 'flow: selectors preserved');

  // Not-a-flow inputs throw.
  let threw = false;
  try { normalizeFlow({ nope: true }); } catch { threw = true; }
  assert(threw, 'flow: an object without steps[] must throw');

  // A JSON string is accepted (the original loadFlow contract: raw file contents
  // hand straight to normalizeFlow), so hand-authored callers can pass either
  // shape. A non-JSON string fails with the same named shape error.
  const fromString = normalizeFlow(JSON.stringify(recorderJson));
  assert(fromString.title === 'Search' && fromString.steps.length === 3,
    'flow: a JSON string must normalise identically to the parsed object');
  let threwOnBadString = false;
  try { normalizeFlow('{not json'); } catch (e) { threwOnBadString = /Invalid flow\.json/.test(e.message); }
  assert(threwOnBadString, 'flow: a non-JSON string must throw the named shape error');
}

export async function testFlowRecordSensitiveRedaction() {
  const { runInNewContext } = await import('node:vm');
  const { isSensitiveField, makeCaptureJs, sanitizeNavUrl } = await import('../runner/flow-record.mjs');

  // 1. Password inputs are always sensitive.
  assert(isSensitiveField({ type: 'password', name: 'pwd' }), 'password field must be sensitive');
  assert(isSensitiveField({ type: 'password' }), 'unnamed password field must be sensitive');

  // 2. Hidden inputs: sensitive by default (captureHidden=false), not sensitive when captureHidden=true.
  assert(isSensitiveField({ type: 'hidden', name: 'csrf_token' }, { captureHidden: false }), 'hidden input must be sensitive by default');
  assert(!isSensitiveField({ type: 'hidden', name: 'returnUrl' }, { captureHidden: true }), 'innocent hidden input must be allowed when captureHidden=true');

  // 3. PII by type: email and tel are sensitive.
  assert(isSensitiveField({ type: 'email', name: 'email' }), 'email type must be sensitive');
  assert(isSensitiveField({ type: 'tel', name: 'phone' }), 'tel type must be sensitive');

  // 4. Autocomplete sensitive tokens (payment, auth, PII, address, including multi-token strings).
  assert(isSensitiveField({ type: 'text', name: 'card', autocomplete: 'cc-number' }), 'cc-number autocomplete must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'code', autocomplete: 'one-time-code' }), 'one-time-code autocomplete must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'pw', autocomplete: 'current-password' }), 'current-password autocomplete must be sensitive');
  assert(isSensitiveField({ type: 'text', autocomplete: 'email' }), 'email autocomplete must be sensitive');
  assert(isSensitiveField({ type: 'text', autocomplete: 'tel' }), 'tel autocomplete must be sensitive');
  assert(isSensitiveField({ type: 'text', autocomplete: 'street-address' }), 'street-address autocomplete must be sensitive');
  assert(isSensitiveField({ type: 'text', autocomplete: 'name' }), 'name autocomplete must be sensitive');
  assert(isSensitiveField({ type: 'text', autocomplete: 'shipping street-address' }), 'multi-token shipping street-address must be sensitive');
  assert(isSensitiveField({ type: 'text', autocomplete: 'section-user email' }), 'multi-token section-user email must be sensitive');
  assert(isSensitiveField({ type: 'text', autocomplete: 'billing name' }), 'multi-token billing name must be sensitive');

  // 5. Credential-shaped names, IDs, labels, placeholders.
  assert(isSensitiveField({ type: 'text', name: 'apiKey' }), 'apiKey name must be sensitive');
  assert(isSensitiveField({ type: 'text', id: 'user_session' }), 'user_session ID must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'authToken' }), 'authToken name must be sensitive');
  assert(isSensitiveField({ type: 'text', ariaLabel: 'Account Secret' }), 'secret aria-label must be sensitive');
  assert(isSensitiveField({ type: 'text', placeholder: 'Enter JWT bearer token' }), 'jwt placeholder must be sensitive');
  assert(isSensitiveField({ type: 'text', label: 'Client Secret Key' }), 'secret label must be sensitive');

  // 5b. One-time-code fields in every spelling a form uses: camelCase, hyphenated,
  // otp/mfa compounds. The classifier tokenises camelCase, so "oneTimeCode" must
  // land on the same rule as autocomplete="one-time-code" - WITHOUT a bare "code"
  // substring match, which would take postalCode down with it (below).
  assert(isSensitiveField({ type: 'text', name: 'oneTimeCode' }), 'camelCase oneTimeCode must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'one-time-code' }), 'hyphenated one-time-code name must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'mfaCode' }), 'mfaCode must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'otpCode' }), 'otpCode must be sensitive');

  // 6. Payment, sensitive PII, contact, and delimited names (billingName, contactEmail, etc.).
  assert(isSensitiveField({ type: 'text', name: 'cardCvc' }), 'cvc must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'creditCard' }), 'creditCard must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'ssn' }), 'ssn must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'socialSecurityNumber' }), 'socialSecurityNumber must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'taxId' }), 'taxId must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'emailAddress' }), 'emailAddress must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'phoneNumber' }), 'phoneNumber must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'fullName' }), 'fullName must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'billingName' }), 'billingName must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'shippingAddress' }), 'shippingAddress must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'contactEmail' }), 'contactEmail must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'userPhone' }), 'userPhone must be sensitive');

  // 7. Innocent fields must not be sensitive (bare code/key omitted to protect postalCode/sortKey).
  assert(!isSensitiveField({ type: 'text', name: 'search' }), 'search must not be sensitive');
  assert(!isSensitiveField({ type: 'text', name: 'city' }), 'city must not be sensitive');
  assert(!isSensitiveField({ type: 'number', name: 'quantity' }), 'quantity must not be sensitive');
  assert(!isSensitiveField({ type: 'text', name: 'comment' }), 'comment must not be sensitive');
  assert(!isSensitiveField({ type: 'text', name: 'postalCode' }), 'postalCode must not match bare code keyword');
  assert(!isSensitiveField({ type: 'text', name: 'countryCode' }), 'countryCode must not match bare code keyword');
  assert(!isSensitiveField({ type: 'text', name: 'sortKey' }), 'sortKey must not match bare key keyword');

  // 8. Opt-in captureSensitive overrides redaction.
  assert(!isSensitiveField({ type: 'email', name: 'email' }, { captureSensitive: true }), 'captureSensitive must allow email');
  assert(!isSensitiveField({ type: 'password', name: 'pwd' }, { captureSensitive: true }), 'captureSensitive must allow password');

  // 9. Injected capture handler persistence test in VM sandbox.
  function mockEl(props) {
    return {
      getAttribute: (k) => props[k] ?? null,
      tagName: 'INPUT',
      nodeType: 1,
      ...props
    };
  }
  function testCaptureSession({ captureHidden = false, captureSensitive = false } = {}) {
    const steps = [];
    const listeners = {};
    const mockElem = { setAttribute: () => {}, addEventListener: () => {} };
    const mockDoc = {
      addEventListener: (evt, fn) => { listeners[evt] = fn; },
      createElement: () => mockElem,
      body: {},
      documentElement: { appendChild: () => {} },
      getElementById: (id) => (id === '__wu_bar' ? null : mockElem),
    };
    const mockWin = {
      __wuRecordStep: (str) => { steps.push(JSON.parse(str)); },
    };
    runInNewContext(makeCaptureJs({ captureHidden, captureSensitive }), {
      window: mockWin,
      document: mockDoc,
      CSS: { escape: (s) => s },
    });
    return {
      triggerChange: (props) => listeners['change']({ target: mockEl(props) }),
      steps
    };
  }

  // A. Default session: verify sensitive and hidden fields are redacted/omitted,
  // on BOTH the returned steps and their JSON serialisation (what flow.json
  // actually persists - a redacted step that still serialises the secret is a leak).
  const def = testCaptureSession({ captureHidden: false, captureSensitive: false });
  def.triggerChange({ type: 'password', name: 'pwd', value: 'secret123', id: 'p1' });
  assert(def.steps.length === 1 && def.steps[0].value === '', 'password value must be blanked');

  def.triggerChange({ type: 'hidden', name: 'csrf_token', value: 'tok456', id: 'h1' });
  assert(def.steps.length === 1, 'hidden input must be omitted by default');

  def.triggerChange({ type: 'email', name: 'user_email', value: 'alice@example.com', id: 'e1' });
  assert(def.steps.length === 2 && def.steps[1].value === '' && def.steps[1].redacted === true, 'email must be redacted');

  def.triggerChange({ type: 'tel', name: 'phone_num', value: '+1-555-0199', id: 't1' });
  assert(def.steps.length === 3 && def.steps[2].value === '' && def.steps[2].redacted === true, 'phone must be redacted');

  def.triggerChange({ type: 'text', name: 'search', value: 'blue sneakers', id: 's1' });
  assert(def.steps.length === 4 && def.steps[3].value === 'blue sneakers' && !def.steps[3].redacted, 'search query must be persisted verbatim');

  def.triggerChange({ type: 'text', name: 'postalCode', value: '90210', id: 'pc1' });
  assert(def.steps.length === 5 && def.steps[4].value === '90210' && !def.steps[4].redacted, 'postalCode must be persisted verbatim');

  def.triggerChange({ type: 'text', name: 'oneTimeCode', value: '483920', id: 'o1' });
  assert(def.steps.length === 6 && def.steps[5].value === '' && def.steps[5].redacted === true,
    'the injected handler must redact a camelCase oneTimeCode field');

  const defSerialized = JSON.stringify(def.steps);
  assert(!defSerialized.includes('secret123') && !defSerialized.includes('tok456') &&
    !defSerialized.includes('alice@example.com') && !defSerialized.includes('+1-555-0199') &&
    !defSerialized.includes('483920'),
    `default session serialisation must not contain any sensitive value: ${defSerialized}`);
  assert(defSerialized.includes('blue sneakers') && defSerialized.includes('90210'),
    'default session serialisation must keep innocent values');

  // B. Opt-in session (captureSensitive:true): values are captured verbatim, on
  // the returned steps AND in their serialisation - the opt-in is only meaningful
  // if both carry the value through for replay.
  const opt = testCaptureSession({ captureHidden: true, captureSensitive: true });
  opt.triggerChange({ type: 'hidden', name: 'csrf_token', value: 'tok456', id: 'h2' });
  assert(opt.steps.length === 1 && opt.steps[0].value === 'tok456', 'hidden token preserved when captureHidden=true');

  opt.triggerChange({ type: 'email', name: 'user_email', value: 'alice@example.com', id: 'e2' });
  assert(opt.steps.length === 2 && opt.steps[1].value === 'alice@example.com', 'email preserved when captureSensitive=true');

  opt.triggerChange({ type: 'text', name: 'oneTimeCode', value: '483920', id: 'o2' });
  assert(opt.steps.length === 3 && opt.steps[2].value === '483920', 'oneTimeCode preserved when captureSensitive=true');

  const optSerialized = JSON.stringify(opt.steps);
  assert(optSerialized.includes('tok456') && optSerialized.includes('alice@example.com') && optSerialized.includes('483920'),
    `opt-in session serialisation must carry the values verbatim: ${optSerialized}`);

  // C. Opt-in on sensitive only: captureSensitive alone must NOT open the hidden
  // gate - CSRF tokens in hidden inputs stay omitted unless captureHidden is
  // also passed.
  const optSensitiveOnly = testCaptureSession({ captureHidden: false, captureSensitive: true });
  optSensitiveOnly.triggerChange({ type: 'hidden', name: 'csrf_token', value: 'tok789', id: 'h3' });
  assert(optSensitiveOnly.steps.length === 0, 'hidden inputs stay omitted when only captureSensitive is set');
  optSensitiveOnly.triggerChange({ type: 'email', name: 'user_email', value: 'bob@example.com', id: 'e3' });
  assert(optSensitiveOnly.steps.length === 1 && optSensitiveOnly.steps[0].value === 'bob@example.com',
    'captureSensitive alone still preserves sensitive non-hidden values');
  assert(!JSON.stringify(optSensitiveOnly.steps).includes('tok789'),
    'captureSensitive-only serialisation must not leak the hidden token');

  // 10. Navigation URL query sanitization (keys and values, preserving innocent params).
  const safeNav = sanitizeNavUrl('https://example.com/checkout?step=2&session_token=xyz&email=alice%40test.com&q=alice@example.com&postalCode=90210&search=boots');
  assert(safeNav.includes('session_token=%5Bredacted%5D'), 'nav URL session_token must be redacted');
  assert(safeNav.includes('email=%5Bredacted%5D'), 'nav URL email key must be redacted');
  assert(safeNav.includes('q=%5Bredacted%5D'), 'nav URL q with email value must be redacted');
  assert(safeNav.includes('postalCode=90210'), 'nav URL postalCode must be preserved (not matching bare code)');
  assert(safeNav.includes('search=boots'), 'nav URL innocent search param must be preserved');

  // 10b. PATH SEGMENTS carry values too: /user/alice@example.com persisted the
  // email verbatim before the fix. Redact PII-shaped segments; leave route names
  // (and routes containing sensitive WORDS, like /settings/security) alone.
  const pathNav = sanitizeNavUrl('https://example.com/user/alice@example.com/orders?step=2');
  assert(pathNav === 'https://example.com/user/[redacted]/orders?step=2',
    `nav URL email path segment must be redacted: ${pathNav}`);
  const innocentPath = sanitizeNavUrl('https://example.com/settings/security/order/1234567890123');
  assert(innocentPath === 'https://example.com/settings/security/order/1234567890123',
    `innocent path segments (and a bare numeric id) must be preserved: ${innocentPath}`);

  // 10c. FRAGMENTS may be query-like (#email=...&tab=2) or a bare PII value.
  const fragNav = sanitizeNavUrl('https://example.com/app#email=alice@example.com&tab=2');
  assert(fragNav === 'https://example.com/app#email=%5Bredacted%5D&tab=2',
    `query-like fragment must be sanitised per-key: ${fragNav}`);
  const bareFrag = sanitizeNavUrl('https://example.com/app#alice@example.com');
  assert(bareFrag === 'https://example.com/app#[redacted]', `bare PII fragment must be redacted: ${bareFrag}`);
  const anchorFrag = sanitizeNavUrl('https://example.com/app#/dashboard');
  assert(anchorFrag === 'https://example.com/app#/dashboard', `innocent fragment must be preserved: ${anchorFrag}`);

  // 10e. SPA ROUTER FRAGMENTS may contain PII in the route segments or queries.
  // Both bare values and path segments after markers must be redacted.
  const fragKeyNav = sanitizeNavUrl('https://example.com/app#/user/alice@example.com?tab=2');
  assert(fragKeyNav === 'https://example.com/app#/user/[redacted]?tab=2' && !fragKeyNav.includes('alice@example.com'),
    `a PII-bearing fragment route must be redacted: ${fragKeyNav}`);
  const markerPath = sanitizeNavUrl('https://example.com/token/abc123');
  assert(markerPath === 'https://example.com/token/[redacted]',
    `a path segment after a sensitive marker must be redacted: ${markerPath}`);

  // 10d. Long digit sequences are cards ONLY with payment context: a
  // payment-named key or a Luhn-valid value. A bare 13-19 digit identifier
  // (?orderId=...) is innocent and must survive for replay; a bare digit string
  // is not a phone number either.
  assert(sanitizeNavUrl('https://example.com/o?orderId=1234567890123').includes('orderId=1234567890123'),
    'innocent 13-digit order id must be preserved');
  assert(sanitizeNavUrl('https://example.com/o?orderId=15550190199').includes('orderId=15550190199'),
    'a bare 11-digit id must not be read as a phone number');
  assert(sanitizeNavUrl('https://example.com/o?ref=4111111111111111').includes('ref=%5Bredacted%5D'),
    'a Luhn-valid card number must be redacted regardless of key name');
  assert(sanitizeNavUrl('https://example.com/o?cc=1234567890123').includes('cc=%5Bredacted%5D'),
    'a payment-named key must redact a card-length digit value');
  assert(sanitizeNavUrl('https://example.com/o?n=%2B1-555-019-0199').includes('n=%5Bredacted%5D'),
    'a formatted phone number value must be redacted');

  // 11. End-to-end recordFlow execution and serialized output assertion.
  const { recordFlow } = await import('../runner/flow-record.mjs');
  const bindingListeners = [];
  const frameNavListeners = [];
  const mockCdp = {
    Runtime: {
      addBinding: async () => {},
      bindingCalled: (fn) => bindingListeners.push(fn),
    },
    Page: {
      frameNavigated: (fn) => frameNavListeners.push(fn),
      addScriptToEvaluateOnNewDocument: async () => {},
      navigate: async () => {},
    },
  };
  const flowPromise = recordFlow(mockCdp, 'https://example.com/checkout', { captureHidden: false });
  await new Promise((r) => setTimeout(r, 10));

  for (const fn of frameNavListeners) {
    fn({ frame: { parentId: null, url: 'https://example.com/checkout?step=2&token=sec123&postalCode=90210&user_email=alice@test.com' } });
    fn({ frame: { parentId: null, url: 'https://example.com/app#/user/alice@example.com?tab=2' } });
    fn({ frame: { parentId: null, url: 'https://example.com/app#/token/abc123' } });
    fn({ frame: { parentId: null, url: 'https://example.com/app#/token/xyz890?tab=2' } });
  }
  for (const fn of bindingListeners) {
    fn({ name: '__wuRecordStep', payload: JSON.stringify({ type: 'change', selectors: [['#email']], value: '', redacted: true }) });
    fn({ name: '__wuRecordStep', payload: JSON.stringify({ type: 'change', selectors: [['#search']], value: 'winter boots' }) });
    fn({ name: '__wuRecordStep', payload: JSON.stringify({ type: '__done' }) });
  }
  const flow = await flowPromise;
  assert(flow.title === 'Recorded flow (example.com)', 'flow title matches host');
  assert(flow.steps.length === 7, 'flow contains 7 steps (viewport, 4 navs, 2 changes)');
  assert(flow.steps[1].type === 'navigate' && flow.steps[1].url.includes('token=%5Bredacted%5D'), 'flow nav step redacts token');
  assert(flow.steps[1].url.includes('postalCode=90210'), 'flow nav step preserves postalCode');
  assert(flow.steps[2].type === 'navigate' && flow.steps[2].url === 'https://example.com/app#/user/[redacted]?tab=2',
    `flow nav step redacts the PII-bearing fragment route: ${flow.steps[2].url}`);
  assert(flow.steps[3].type === 'navigate' && flow.steps[3].url === 'https://example.com/app#/token/[redacted]',
    `flow nav step redacts the token fragment route: ${flow.steps[3].url}`);
  assert(flow.steps[4].type === 'navigate' && flow.steps[4].url === 'https://example.com/app#/token/[redacted]?tab=2',
    `flow nav step redacts the token fragment route with query: ${flow.steps[4].url}`);
  assert(flow.steps[5].redacted === true && flow.steps[5].value === '', 'flow email step is redacted');
  assert(flow.steps[6].value === 'winter boots', 'flow search step preserves value');

  const serialized = JSON.stringify(flow);
  assert(!serialized.includes('sec123'), 'serialized flow must not leak token');
  assert(!serialized.includes('alice@test.com'), 'serialized flow must not leak email');
  assert(!serialized.includes('alice@example.com'), 'serialized flow must not leak the fragment-key email');
  assert(!serialized.includes('abc123'), 'serialized flow must not leak the token fragment value');
  assert(!serialized.includes('xyz890'), 'serialized flow must not leak the token fragment query value');

  // 12. End-to-end recordFlow execution with opt-in flags (captureHidden, captureSensitive).
  const bindingListenersOpt = [];
  const frameNavListenersOpt = [];
  const optLogs = [];
  const mockCdpOpt = {
    Runtime: {
      addBinding: async () => {},
      bindingCalled: (fn) => bindingListenersOpt.push(fn),
    },
    Page: {
      frameNavigated: (fn) => frameNavListenersOpt.push(fn),
      addScriptToEvaluateOnNewDocument: async () => {},
      navigate: async () => {},
    },
  };
  const flowOptPromise = recordFlow(mockCdpOpt, 'https://example.com/checkout', { captureHidden: true, captureSensitive: true, log: (m) => optLogs.push(m) });
  await new Promise((r) => setTimeout(r, 10));

  for (const fn of frameNavListenersOpt) {
    fn({ frame: { parentId: null, url: 'https://example.com/checkout?step=2&token=sec123&user_email=alice@test.com' } });
  }
  for (const fn of bindingListenersOpt) {
    fn({ name: '__wuRecordStep', payload: JSON.stringify({ type: 'change', selectors: [['#hiddenToken']], value: 'csrf_secret_123' }) });
    fn({ name: '__wuRecordStep', payload: JSON.stringify({ type: 'change', selectors: [['#email']], value: 'alice@test.com' }) });
    fn({ name: '__wuRecordStep', payload: JSON.stringify({ type: '__done' }) });
  }
  const flowOpt = await flowOptPromise;
  assert(flowOpt.steps[1].url.includes('token=sec123'), 'opt-in flow preserves URL parameters verbatim');
  assert(flowOpt.steps[2].value === 'csrf_secret_123', 'opt-in flow preserves hidden inputs');
  assert(flowOpt.steps[3].value === 'alice@test.com', 'opt-in flow preserves email value');

  const serializedOpt = JSON.stringify(flowOpt);
  assert(serializedOpt.includes('csrf_secret_123'), 'serialized opt-in flow retains token');
  assert(serializedOpt.includes('alice@test.com'), 'serialized opt-in flow retains email');
  assert(optLogs.some((m) => /WARNING.*--capture-sensitive/.test(m) && /replay fidelity/.test(m)),
    `opt-in recording must warn that values are persisted verbatim: ${JSON.stringify(optLogs)}`);
}

export async function testFlowReplayMutationGate() {
  const { runInNewContext } = await import('node:vm');
  const { findMutatingControl, isSubmitControl, parseFlowArgs, replayFlow, resolveSelectorCandidate } = await import('../runner/flow.mjs');

  // 1. Argument parsing flag order independence (boolean flags do not consume positionals).
  const p1 = parseFlowArgs(['replay', '--allow-mutations', 'checkout.json']);
  assert(p1.positional[0] === 'checkout.json', 'flow path preserved when flag comes first');
  assert(p1.flags.has('--allow-mutations'), 'allow-mutations flag captured');

  const p2 = parseFlowArgs(['record', '--capture-hidden', '--capture-sensitive', 'https://example.com', '--out', 'f.json']);
  assert(p2.positional[0] === 'https://example.com', 'url preserved with leading boolean flags');
  assert(p2.options.out === 'f.json', 'out option captured');
  assert(p2.flags.has('--capture-hidden') && p2.flags.has('--capture-sensitive'), 'boolean flags captured');

  // 2. The real mutating-control predicate against DOM stubs (this is the exact
  // function serialized into the page expression, not a copy).
  const form = { tagName: 'FORM', nodeType: 1 };
  const submitBtn = { tagName: 'BUTTON', type: 'submit', nodeType: 1, form, closest: (s) => (s.includes('form') ? form : null) };
  const spanChild = { tagName: 'SPAN', nodeType: 1, textContent: 'Submit Order', closest: (s) => (s.includes('button') ? submitBtn : null) };
  const innocentLink = { tagName: 'A', nodeType: 1, textContent: 'About Us', closest: () => null, getAttribute: () => null };
  const onclickDeleteAnchor = {
    tagName: 'A', nodeType: 1, textContent: 'Delete',
    closest: () => null,
    getAttribute: (k) => (k === 'onclick' ? 'deleteItem()' : null),
  };
  const onclickMoreAnchor = {
    tagName: 'A', nodeType: 1, textContent: 'More',
    closest: () => null,
    getAttribute: (k) => (k === 'onclick' ? 'deleteItem()' : null),
  };

  assert(isSubmitControl(submitBtn), 'button type=submit must be submit control');
  assert(isSubmitControl(spanChild), 'span inside submit button must be submit control');
  assert(isSubmitControl({ tagName: 'BUTTON', form }), 'button in form without type must be submit control');
  assert(isSubmitControl({ tagName: 'INPUT', type: 'submit' }), 'input type=submit must be submit control');
  assert(isSubmitControl({ tagName: 'INPUT', type: 'image', form }), 'input type=image must be submit control');
  assert(!isSubmitControl(innocentLink), 'innocent link must not be submit control');

  // The a[onclick] arm used to be dead: an anchor failed the BUTTON-only type
  // check, so <a onclick="...">Delete</a> ran its handler against the live
  // target in dry-run. The mutating-terms check now covers anchors.
  assert(findMutatingControl(onclickDeleteAnchor) === onclickDeleteAnchor,
    '<a onclick>Delete</a> must be recognised as a mutating control');
  // An inline onclick handler is mutating by nature: the label ("More") says
  // nothing about what the handler runs, so a[onclick] is gated REGARDLESS of
  // its display text.
  assert(findMutatingControl(onclickMoreAnchor) === onclickMoreAnchor,
    '<a onclick="deleteItem()">More</a> must be gated despite its innocuous label');
  assert(findMutatingControl(innocentLink) === null, 'innocent anchor must stay clickable in dry-run');

  // 2b. Selector resolution: text/ and pierce/ (Chrome DevTools Recorder emits
  // them) are restored, aria/ matching is exact-attribute (a double-quote in the
  // name cannot break it), and a stale CSS/xpath candidate falls through.
  const aboutLink = { tagName: 'A', nodeType: 1, childElementCount: 0, textContent: 'About Us', getAttribute: () => null, closest: () => null };
  const quotedLabelBtn = { tagName: 'BUTTON', nodeType: 1, childElementCount: 0, textContent: '', getAttribute: (k) => (k === 'aria-label' ? 'Say "Hi"' : null), closest: () => null };
  const resolveDoc = {
    querySelector: (sel) => (sel === '#about' ? aboutLink : null),
    querySelectorAll: (sel) => {
      if (sel === '*') return [quotedLabelBtn, aboutLink];
      if (sel === '[aria-label]') return [quotedLabelBtn];
      if (sel === 'button, a, input, [role=button]') return [quotedLabelBtn, aboutLink];
      return [];
    },
    evaluate: () => { throw new Error('xpath unsupported in stub'); },
  };
  assert(resolveSelectorCandidate('text/About Us', resolveDoc) === aboutLink, 'text/ selector must resolve by exact leaf text');
  assert(resolveSelectorCandidate('pierce/#about', resolveDoc) === aboutLink, 'pierce/ selector must resolve through querySelector');
  // pierce/ crosses OPEN shadow roots (Recorder semantics): the target lives in
  // a host's shadowRoot, invisible to a document-level querySelector. A
  // light-DOM match still wins before the shadow walk.
  const shadowTarget = { tagName: 'BUTTON', nodeType: 1, textContent: 'Shadow' };
  const nestedTarget = { tagName: 'BUTTON', nodeType: 1, textContent: 'Nested' };
  const nestedRootStub = {
    querySelector: (sel) => (sel === '#nestedBtn' ? nestedTarget : null),
    querySelectorAll: () => [],
  };
  const nestedHost = { tagName: 'DIV', nodeType: 1, shadowRoot: nestedRootStub };
  const shadowRootStub = {
    querySelector: (sel) => (sel === '#shadowBtn' ? shadowTarget : null),
    querySelectorAll: (sel) => (sel === '*' ? [nestedHost] : []),
  };
  const shadowHost = { tagName: 'DIV', nodeType: 1, shadowRoot: shadowRootStub };
  const shadowDoc = {
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '*' ? [shadowHost] : []),
  };
  assert(resolveSelectorCandidate('pierce/#shadowBtn', shadowDoc) === shadowTarget,
    'pierce/ must resolve a target inside an open shadow root');
  assert(resolveSelectorCandidate('pierce/#nestedBtn', shadowDoc) === nestedTarget,
    'pierce/ must resolve a target inside a NESTED open shadow root');
  const lightFirstDoc = {
    querySelector: (sel) => (sel === '#shadowBtn' ? aboutLink : null),
    querySelectorAll: (sel) => (sel === '*' ? [shadowHost] : []),
  };
  assert(resolveSelectorCandidate('pierce/#shadowBtn', lightFirstDoc) === aboutLink,
    'pierce/ must prefer a light-DOM match before walking shadow roots');
  assert(resolveSelectorCandidate('aria/Say "Hi"', resolveDoc) === quotedLabelBtn,
    'aria/ selector with a double-quote in the name must resolve (no CSS.escape in a quoted attribute selector)');
  assert(resolveSelectorCandidate('.stale-css', resolveDoc) === null, 'a stale CSS selector must resolve to null so the next alternative is tried');
  assert(resolveSelectorCandidate('xpath//button[1]', resolveDoc) === null, 'an unresolvable xpath must resolve to null, not throw');

  // 3. Replay execution suppression test. The mock CDP client EVALUATES the real
  // generated expression in a vm sandbox against a DOM stub - the previous mock
  // returned mutationBlocked for ANY expression containing "findMutatingControl",
  // which passed even if the gating branch was deleted.
  function stubEl(props) {
    return {
      nodeType: 1,
      childElementCount: 0,
      textContent: '',
      tagName: 'DIV',
      getAttribute: () => null,
      closest: () => null,
      scrollIntoView: () => {},
      click: () => {},
      ...props,
    };
  }

  function makeVmReplayClient({ activeElement } = {}) {
    const clicks = [];
    const submits = [];
    const formStub = { tagName: 'FORM', nodeType: 1, requestSubmit: () => submits.push('form') };
    // The Enter step acts on document.activeElement; default to a form field.
    const active = activeElement ?? stubEl({ tagName: 'INPUT', form: formStub });
    const submitBtnEl = stubEl({
      tagName: 'BUTTON', type: 'submit', textContent: 'Submit Order', form: formStub,
      closest(sel) { return sel.includes('form') ? formStub : null; },
      click() { clicks.push('submitBtn'); },
    });
    const spanChildEl = stubEl({
      tagName: 'SPAN', textContent: 'Submit Order',
      closest(sel) { return sel.includes('button') ? submitBtnEl : null; },
      click() { clicks.push('spanChild'); },
    });
    const aboutLinkEl = stubEl({ tagName: 'A', textContent: 'About Us', click() { clicks.push('aboutLink'); } });
    const deleteAnchorEl = stubEl({
      tagName: 'A', textContent: 'Delete',
      getAttribute: (k) => (k === 'onclick' ? 'deleteItem()' : null),
      click() { clicks.push('deleteAnchor'); },
    });
    const moreAnchorEl = stubEl({
      tagName: 'A', textContent: 'More',
      getAttribute: (k) => (k === 'onclick' ? 'loadMore()' : null),
      click() { clicks.push('moreAnchor'); },
    });
    const byId = { '#childSpan': spanChildEl, '#about': aboutLinkEl, '#deleteLink': deleteAnchorEl, '#moreLink': moreAnchorEl };
    const documentStub = {
      activeElement: active,
      querySelector: (sel) => byId[sel] ?? null,
      querySelectorAll: (sel) => {
        if (sel === '*') return [deleteAnchorEl, aboutLinkEl, spanChildEl, moreAnchorEl];
        if (sel === '[aria-label]') return [];
        return [submitBtnEl, aboutLinkEl, deleteAnchorEl, moreAnchorEl];
      },
      evaluate: () => { throw new Error('xpath unsupported in stub'); },
    };
    const sandbox = {
      document: documentStub,
      location: { href: 'https://example.test/current' },
      KeyboardEvent: class KeyboardEvent { constructor(type, init) { this.type = type; this.key = init?.key; } },
      Event: class Event { constructor(type, init) { this.type = type; this.bubbles = !!init?.bubbles; } },
    };
    const client = {
      clicks,
      submits,
      Emulation: { setDeviceMetricsOverride: async () => {} },
      Page: { captureScreenshot: async () => ({ data: 'AAAA' }) },
      Runtime: {
        evaluate: async ({ expression }) => {
          try {
            const value = runInNewContext(expression, sandbox);
            return { result: { value } };
          } catch (e) {
            return { result: {}, exceptionDetails: { text: e.message } };
          }
        },
      },
    };
    return client;
  }

  const flow = {
    title: 'Test flow',
    steps: [
      { type: 'change', selectors: [['#pwd']], value: '', redacted: true },
      { type: 'click', selectors: [['#childSpan']], target: 'main' },
      { type: 'click', selectors: [['#deleteLink']], target: 'main' },
      { type: 'click', selectors: [['#moreLink']], target: 'main' },
      { type: 'click', selectors: [['#about']], target: 'main' },
      { type: 'click', selectors: [['.stale-css'], ['text/About Us']], target: 'main' },
      { type: 'keyDown', key: 'Enter', target: 'main' },
    ],
  };

  // Dry-run: the real predicate blocks the submit-button child AND the
  // <a onclick>Delete</a> anchor; the innocent link clicks; the stale-CSS
  // candidate falls back to text/; Enter on a form field is blocked.
  const dryClient = makeVmReplayClient();
  const resDefault = await replayFlow(dryClient, flow, { allowMutations: false, settleMs: 1 });
  assert(resDefault.steps[0].skipped === true, 'redacted change step skipped when value is empty');
  assert(resDefault.steps[1].mutationBlocked === true, 'click on child of mutating control blocked in dry-run');
  assert(resDefault.steps[1].detail.includes('dry-run'), `blocked click explains itself: ${resDefault.steps[1].detail}`);
  assert(resDefault.steps[2].mutationBlocked === true, 'click on <a onclick>Delete</a> blocked in dry-run');
  assert(resDefault.steps[3].mutationBlocked === true, 'click on innocuously labelled <a onclick>More</a> blocked in dry-run');
  assert(!dryClient.clicks.includes('moreAnchor'), '<a onclick>More</a> handler NOT called in dry-run');
  assert(resDefault.steps[4].ok === true && !resDefault.steps[4].mutationBlocked, 'innocent link click allowed in dry-run');
  assert(resDefault.steps[4].detail.includes('A About Us'), `innocent click ran against the anchor: ${resDefault.steps[4].detail}`);
  assert(resDefault.steps[5].ok === true && !resDefault.steps[5].mutationBlocked,
    'stale CSS candidate must fall back to text/ and resolve: ' + resDefault.steps[5].detail);
  assert(resDefault.steps[6].mutationBlocked === true, 'Enter submission blocked in dry-run');
  assert(dryClient.clicks.length === 2 && dryClient.clicks.every((c) => c === 'aboutLink'),
    `dry-run must click ONLY the innocent links, got: ${JSON.stringify(dryClient.clicks)}`);
  assert(dryClient.submits.length === 0, 'dry-run must never submit a form');

  // Enter on a contenteditable element: contenteditable="" makes getAttribute
  // return "" (falsy) while the element IS editable - isContentEditable is the
  // correct probe, and dry-run must still suppress the keydown.
  const editable = stubEl({ tagName: 'DIV', isContentEditable: true, getAttribute: () => '' });
  const editableClient = makeVmReplayClient({ activeElement: editable });
  const resEditable = await replayFlow(editableClient, { title: 't', steps: [{ type: 'keyDown', key: 'Enter' }] }, { allowMutations: false, settleMs: 1 });
  assert(resEditable.steps[0].mutationBlocked === true,
    `Enter on contenteditable="" must be blocked in dry-run: ${resEditable.steps[0].detail}`);

  // Opt-in: --allow-mutations executes the same steps for real.
  const allowClient = makeVmReplayClient();
  const resAllow = await replayFlow(allowClient, flow, { allowMutations: true, settleMs: 1 });
  assert(resAllow.steps[1].ok === true && !resAllow.steps[1].mutationBlocked, 'allowed click on submit child executes');
  assert(resAllow.steps[2].ok === true && !resAllow.steps[2].mutationBlocked, 'allowed click on delete anchor executes');
  assert(resAllow.steps[3].ok === true && !resAllow.steps[3].mutationBlocked, 'allowed click on more anchor executes');
  assert(resAllow.steps[6].ok === true && resAllow.steps[6].detail.includes('submitted form'),
    `allowed Enter submits the form: ${resAllow.steps[6].detail}`);
  assert(allowClient.clicks.includes('spanChild') && allowClient.clicks.includes('deleteAnchor') && allowClient.clicks.includes('moreAnchor'),
    `allowed run clicks every control: ${JSON.stringify(allowClient.clicks)}`);
  assert(allowClient.submits.length === 1, 'allowed run submits the form exactly once');
}

// Run directly (node tests/flow.mjs), not when imported by the regression
// suite, which calls the exported functions itself.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await testFlowNormalize();
  await testFlowRecordSensitiveRedaction();
  await testFlowReplayMutationGate();
  console.log('tests OK');
}
