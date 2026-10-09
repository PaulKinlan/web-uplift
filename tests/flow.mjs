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
  const { isSensitiveField, makeCaptureJs, sanitizeNavUrl, RECORDER_WORLD } = await import('../runner/flow-record.mjs');

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
  // so2: 'otc' is the abbreviation that was missing while 'otp' matched, and
  // 'otcCode' reaches it through the camelCase join. The page-side classifier is
  // generated from the SAME table, so both stay in step (asserted in section A2).
  assert(isSensitiveField({ type: 'text', name: 'otc' }), 'otc must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'otcCode' }), 'camelCase otcCode must be sensitive');
  assert(isSensitiveField({ type: 'text', name: 'oneTimeNumber' }), 'oneTimeNumber must be sensitive');

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
  function testCaptureSession({ captureHidden = false, captureSensitive = false, token = 'tok-test-1234' } = {}) {
    const steps = [];
    const tokens = [];
    const rawPayloads = [];
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
      // The emitted payload is an envelope: { __wu: token, step } (web-uplift-sg5). The
      // harness unwraps it AND keeps the token so a test can assert the page script does
      // authenticate; the recorder refuses a payload without it.
      __wuRecordStep: (str) => { const msg = JSON.parse(str); steps.push(msg.step); tokens.push(msg.__wu); rawPayloads.push(str); },
    };
    runInNewContext(makeCaptureJs({ captureHidden, captureSensitive, token }), {
      window: mockWin,
      document: mockDoc,
      CSS: { escape: (s) => s },
    });
    return {
      // isTrusted: an event the user agent produced. Without it the listener refuses to
      // record at all (web-uplift-sg5 review), which is asserted below.
      triggerChange: (props, trusted = true) => listeners['change']({ isTrusted: trusted, target: mockEl(props) }),
      triggerClick: (props, trusted = true) => listeners['click']({ isTrusted: trusted, target: { closest: () => mockEl(props) } }),
      steps,
      tokens,
      rawPayloads,
      token,
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

  // web-uplift-sg5: every step the page script emits carries the recording token, which is
  // what the recorder checks before it persists anything.
  assert(def.tokens.length === def.steps.length && def.tokens.every((t) => t === def.token),
    `every emitted payload must carry the recording token, got ${JSON.stringify(def.tokens)}`);
  // A4. Synthetic events are refused (web-uplift-sg5 review). A page can dispatch a click
  // or change on any element it likes; without the isTrusted check the recorder signs that
  // step with its own token, and the operator replays something they never did. This is
  // asserted on the emitter, BEFORE any token is involved - the browser repro showed the
  // attack landing on the pre-fix tree with the token layer already in place.
  const synthetic = testCaptureSession({ captureHidden: false, captureSensitive: false });
  synthetic.triggerClick({ id: 'evil', tagName: 'BUTTON', textContent: 'Delete my account' }, false);
  synthetic.triggerChange({ type: 'text', name: 'q', value: 'attacker-typed', id: 'evil' }, false);
  assert(synthetic.steps.length === 0 && synthetic.tokens.length === 0,
    `a synthetic click or change must not be recorded at all: ${JSON.stringify(synthetic.steps)}`);
  // ...and the trusted event on the same session still is, so the check cannot pass by
  // breaking recording outright.
  synthetic.triggerClick({ id: 'real', tagName: 'BUTTON', textContent: 'Go' }, true);
  assert(synthetic.steps.length === 1 && synthetic.steps[0].type === 'click',
    'a trusted click on the same session must still be recorded');

  const defSerialized = JSON.stringify(def.steps);
  assert(!defSerialized.includes('secret123') && !defSerialized.includes('tok456') &&
    !defSerialized.includes('alice@example.com') && !defSerialized.includes('+1-555-0199') &&
    !defSerialized.includes('483920'),
    `default session serialisation must not contain any sensitive value: ${defSerialized}`);
  assert(defSerialized.includes('blue sneakers') && defSerialized.includes('90210'),
    'default session serialisation must keep innocent values');
  def.triggerChange({ type: 'text', name: 'otcCode', value: '483921', id: 'otc1' });
  assert(def.steps.length === 7 && def.steps[6].value === '' && def.steps[6].redacted === true,
    'the injected handler must redact an otcCode field (web-uplift-so2)');
  assert(!JSON.stringify(def.steps).includes('483921'),
    'so2: the serialised capture must not carry the one-time-code value');


  // A click goes through the same authenticated path, and it is the step a page could most
  // usefully forge - so the positive case matters as much as the refusals below.
  const clickSession = testCaptureSession({ captureHidden: false, captureSensitive: false });
  clickSession.triggerClick({ id: 'go', tagName: 'BUTTON', textContent: 'Go' });
  assert(clickSession.steps.length === 1 && clickSession.steps[0].type === 'click' && clickSession.steps[0].selectors.length >= 1,
    `a legitimate click must still be recorded: ${JSON.stringify(clickSession.steps)}`);
  assert(clickSession.tokens[0] === clickSession.token, 'the click payload must be authenticated too');

  // A3. validateRecordedStep driven directly: the e2e above proves the live path, this
  // pins the shapes and the BOUNDS - including the shapes that must still be accepted, so
  // the allowlist cannot be tightened into a recorder that silently drops real steps.
  const { validateRecordedStep } = await import('../runner/flow-record.mjs');
  const okClick = validateRecordedStep({ type: 'click', selectors: [['#go']], target: 'main' });
  assert(okClick.ok && okClick.step.type === 'click' && !('value' in okClick.step),
    'a well-formed click validates, and carries no value field');
  const okRedacted = validateRecordedStep({ type: 'change', selectors: [['#pwd']], value: 'secret', redacted: true });
  assert(okRedacted.ok && okRedacted.step.value === '' && okRedacted.step.redacted === true,
    'a redacted change validates WITH an empty value (the redaction is enforced here, not in the page)');
  const refused = [
    [null, 'not a step object'],
    ['click', 'not a step object'],
    [{ type: 'navigate', url: 'https://evil.test/' }, 'a type the recorder never emits'],
    [{ type: 'click', selectors: [['#go']], target: 'main', onclick: 'x()' }, 'an extra field'],
    [{ type: 'click', selectors: [], target: 'main' }, 'no selectors'],
    [{ type: 'click', selectors: [[]], target: 'main' }, 'an empty selector group'],
    [{ type: 'click', selectors: [['#go', '']], target: 'main' }, 'an empty selector'],
    [{ type: 'click', selectors: [['x'.repeat(600)]], target: 'main' }, 'an over-long selector'],
    [{ type: 'change', selectors: [['#x']], value: 42 }, 'a non-string value'],
    [{ type: 'change', selectors: [['#x']], value: 'v'.repeat(11000) }, 'an over-long value'],
    [{ type: 'click', selectors: [['#go']], target: 't'.repeat(70) }, 'an over-long target'],
  ];
  for (const [input, why] of refused) {
    const verdict = validateRecordedStep(input);
    assert(!verdict.ok, `validateRecordedStep must refuse ${why}: ${String(JSON.stringify(input)).slice(0, 80)}`);
    assert(typeof verdict.reason === 'string' && verdict.reason.length > 0, `a refusal must carry a reason (${why})`);
  }
  // A refusal must be a refusal, not a throw: the allowlist is keyed by a PAGE-supplied
  // string, and RECORDED_STEP_FIELDS inherits from Object.prototype, so "__proto__" and
  // "constructor" used to resolve to a non-array and throw out of the handler
  // (web-uplift-sg5 review).
  for (const type of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const verdict = validateRecordedStep({ type, selectors: [['#x']], target: 'main' });
    assert(verdict.ok === false && typeof verdict.reason === 'string',
      `type "${type}" must be refused with a reason, not thrown: ${JSON.stringify(verdict)}`);
  }
  assert(validateRecordedStep({ type: 'click', selectors: Array.from({ length: 32 }, (_, i) => [`#s${i}`]), target: 'main' }).ok,
    '32 selector groups are within the bound');
  assert(validateRecordedStep({ type: 'click', selectors: [Array.from({ length: 8 }, (_, i) => `text/x${i}`)], target: 'main' }).ok,
    '8 alternatives inside a selector group are within the bound');

  // A2. The injected page-side classifier and the Node-side one must agree. The
  // page script's word DATA is generated from evidence/credential-terms.mjs, but
  // its matching logic is a template copy, so this drives BOTH over one case list
  // (the page script in a vm context, the module in Node): a divergence in either
  // direction fails here. Bare code/key are deliberately NOT field-sensitive - a
  // promo/product code is not a credential - while being credential-shaped as URL
  // parameters (asserted in 10f).
  const { isSensitiveName, isCredentialName } = await import('../evidence/credential-terms.mjs');
  const agree = testCaptureSession({ captureHidden: false, captureSensitive: false });
  const fieldCases = ['otc', 'otcCode', 'oneTimeNumber', 'otpCode', 'authCode', 'apiKey', 'csrfToken',
    'code', 'key', 'postalCode', 'countryCode', 'sortKey', 'businessKey', 'search', 'quantity', 'email'];
  let agreeIndex = 0;
  for (const name of fieldCases) {
    agree.triggerChange({ type: 'text', name, value: 'v1', id: 'agree-' + agreeIndex });
    const step = agree.steps[agreeIndex];
    agreeIndex++;
    assert((step.redacted === true) === isSensitiveName(name),
      `page-side and Node-side classifiers must agree on field "${name}": page=${step.redacted === true} node=${isSensitiveName(name)}`);
  }

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

  // 10f. web-uplift-lw6: a query parameter named code/key IS a credential (an
  // OAuth callback code, an API key), while postalCode/countryCode/sortKey are
  // ordinary parameters that must keep their values for replay. Weak words match
  // the WHOLE parameter name only, which is how both stay true at once.
  assert(sanitizeNavUrl('https://example.com/oauth/callback?code=AUTH_SECRET_CODE_12345').includes('code=%5Bredacted%5D'),
    'lw6: an OAuth ?code= parameter must be redacted');
  const apiKeyNav = sanitizeNavUrl('https://api.example.com/x?key=AIzaSySECRET123&q=1');
  assert(apiKeyNav.includes('key=%5Bredacted%5D') && apiKeyNav.includes('q=1'),
    `lw6: ?key= must be redacted and its sibling preserved: ${apiKeyNav}`);
  assert(sanitizeNavUrl('https://example.com/x?postalCode=90210').includes('postalCode=90210'), 'lw6: postalCode must be preserved');
  assert(sanitizeNavUrl('https://example.com/x?countryCode=GB').includes('countryCode=GB'), 'lw6: countryCode must be preserved');
  assert(sanitizeNavUrl('https://example.com/x?sortKey=name').includes('sortKey=name'), 'lw6: sortKey must be preserved');
  assert(sanitizeNavUrl('https://example.com/x?businessKey=1').includes('businessKey=1'), 'lw6: businessKey must be preserved');
  assert(isCredentialName('code') && isCredentialName('key'), 'lw6: the shared credential test must cover code/key');
  assert(!isCredentialName('postalCode') && !isCredentialName('sortKey'), 'lw6: weak words must not match a longer name');

  // 10g. web-uplift-hi3: values with no name to classify. A token-shaped segment,
  // a bare opaque fragment and URL userinfo are the credential itself, while a
  // route word after a markered ROUTE (/auth/callback, /settings/password/change)
  // and a word-shaped slug stay intact so replay still works.
  assert(sanitizeNavUrl('https://example.com/reset-password/a8f9c0e2d4b6') === 'https://example.com/reset-password/[redacted]',
    'hi3: a token after the reset-password marker must be redacted');
  assert(sanitizeNavUrl('https://example.com/verify/483920') === 'https://example.com/verify/[redacted]',
    'hi3: a code after the verify marker must be redacted');
  assert(sanitizeNavUrl('https://example.com/auth/callback') === 'https://example.com/auth/callback',
    'hi3: /auth/callback is a route, not a secret, and must survive');
  assert(sanitizeNavUrl('https://example.com/settings/password/change') === 'https://example.com/settings/password/change',
    'hi3: /settings/password/change must survive');
  assert(sanitizeNavUrl('https://example.com/#ya29.a0AfH6SMBxxxxxxxx') === 'https://example.com/#[redacted]',
    'hi3: a bare opaque fragment token must be redacted');
  assert(sanitizeNavUrl('https://example.com/app#tab2') === 'https://example.com/app#tab2',
    'hi3: an innocent anchor fragment must survive');
  assert(sanitizeNavUrl('https://example.com/files/AbCdEf1234567890') === 'https://example.com/files/[redacted]',
    'hi3: a token-shaped path segment must be redacted');
  assert(sanitizeNavUrl('https://example.com/files/sK_9-dF0_xZ2aB123456') === 'https://example.com/files/[redacted]',
    'hi3 review: a base64url token must be redacted');
  assert(sanitizeNavUrl('https://example.com/v2-Release-Notes-2024') === 'https://example.com/v2-Release-Notes-2024',
    'hi3: a word-shaped path segment must survive');
  assert(sanitizeNavUrl('https://example.com/my-first-post-2024') === 'https://example.com/my-first-post-2024',
    'hi3: a slug path segment must survive');
  // hi3 REVIEW FPs: the JWT rule must not eat multi-dot filenames or versions, and
  // the route-marker rule must not redact a route word that merely contains a digit.
  for (const [url, why] of [
    ['https://example.com/static/bundle.min.js', 'a multi-dot filename'],
    ['https://example.com/files/archive.tar.gz', 'a multi-extension archive'],
    ['https://example.com/docs/release-1.0.0', 'a version string'],
    ['https://example.com/locales/en-US.messages.json', 'a locale bundle'],
    ['https://example.com/auth/v1', 'a versioned route after auth'],
    ['https://example.com/auth/oauth2', 'a route after auth'],
    ['https://example.com/auth/2fa', 'a route after auth'],
    ['https://example.com/auth/step1', 'a step route after auth'],
    ['https://example.com/settings/password/step2', 'a step route after password'],
    ['https://example.com/OrderConfirmation123', 'a long camelCase route'],
    ['https://example.com/UserProfileStep2Page', 'a long camelCase route'],
    ['https://example.com/orders/550e8400-e29b-41d4-a716-446655440000', 'a resource UUID (identifier, not a credential)'],
  ]) {
    assert(sanitizeNavUrl(url) === url, `hi3 review: ${why} must survive: ${sanitizeNavUrl(url)}`);
  }
  // hi3 REVIEW FNs: a code after a marker is a credential whatever its alphabet,
  // and a marker still redacts a value-shaped next segment.
  assert(sanitizeNavUrl('https://example.com/verify/ABCDEF') === 'https://example.com/verify/[redacted]',
    'hi3 review: an all-letter OTP after a marker must be redacted');
  assert(sanitizeNavUrl('https://example.com/verify/A1B2C3') === 'https://example.com/verify/[redacted]',
    'hi3 review: an alphanumeric OTP after a marker must be redacted');
  assert(sanitizeNavUrl('https://user:pass@example.com/x') === 'https://%5Bredacted%5D:%5Bredacted%5D@example.com/x',
    'hi3: URL userinfo carrying a password must be scrubbed');
  assert(sanitizeNavUrl('https://example.com/x') === 'https://example.com/x', 'hi3: an innocent URL must pass through unchanged');

  // 11. End-to-end recordFlow execution and serialized output assertion.
  const { recordFlow } = await import('../runner/flow-record.mjs');
  const bindingListeners = [];
  const frameNavListeners = [];
  const logs11 = [];
  const injected = [];
  const bindingParams = [];
  const scriptParams = [];
  const mockCdp = {
    Runtime: {
      addBinding: async (params) => { bindingParams.push(params); },
      bindingCalled: (fn) => bindingListeners.push(fn),
    },
    Page: {
      frameNavigated: (fn) => frameNavListeners.push(fn),
      // Capture the injected source: the test reads the recording token OUT of the script
      // the page received, which is a capability a page script does NOT have (the token
      // lives in the injected closure, and that script is not in the DOM).
      addScriptToEvaluateOnNewDocument: async (params) => { injected.push(params.source); scriptParams.push(params); },
      navigate: async () => {},
    },
  };
  const flowPromise = recordFlow(mockCdp, 'https://example.com/checkout', { captureHidden: false, log: (m) => logs11.push(m) });
  await new Promise((r) => setTimeout(r, 10));
  const token = /const TOKEN = "([^"]+)"/.exec(injected.join('\n'))?.[1];
  assert(typeof token === 'string' && token.length >= 16,
    `the injected capture script must carry a per-recording token: ${injected.join('').slice(0, 200)}`);
  const emit = (step) => JSON.stringify({ __wu: token, step });

  // The isolated world (web-uplift-sg5 review P1). Both halves of the wiring are asserted
  // because isolation is what makes the binding UNREACHABLE for a page rather than merely
  // guarded by a secret, and a refactor that drops either parameter silently returns to a
  // page-callable binding. The browser repro is what proves the page really cannot see it;
  // this pins the wiring so the proof cannot be lost to a later edit.
  assert(bindingParams.length === 1 && bindingParams[0].executionContextName === RECORDER_WORLD,
    `the binding must be bound to the recorder's own world: ${JSON.stringify(bindingParams)}`);
  assert(scriptParams.length >= 1 && scriptParams.every((p) => p.worldName === RECORDER_WORLD),
    `the capture script must be injected into that world: ${JSON.stringify(scriptParams.map((p) => p.worldName))}`);

  for (const fn of frameNavListeners) {
    fn({ frame: { parentId: null, url: 'https://example.com/checkout?step=2&token=sec123&postalCode=90210&user_email=alice@test.com' } });
    fn({ frame: { parentId: null, url: 'https://example.com/settings/security' } });
    fn({ frame: { parentId: null, url: 'https://example.com/app#/user/alice@example.com?tab=2' } });
    fn({ frame: { parentId: null, url: 'https://example.com/app#/token/abc123' } });
    fn({ frame: { parentId: null, url: 'https://example.com/app#/token/abc123?tab=2' } });
  }
  for (const fn of bindingListeners) {
    // web-uplift-sg5: the binding is a function on the PAGE global, so any page script can
    // call it. Every one of these is a page trying to write steps the operator never took.
    fn({ name: '__wuRecordStep', payload: JSON.stringify({ type: 'navigate', url: 'https://evil.example/collect?api_key=ATTACKER_KEY_123' }) });
    fn({ name: '__wuRecordStep', payload: JSON.stringify({ type: 'change', selectors: [['#pwd']], value: 'attacker-typed', target: 'main' }) });
    fn({ name: '__wuRecordStep', payload: JSON.stringify({ type: '__done' }) });
    fn({ name: '__wuRecordStep', payload: JSON.stringify({ __wu: 'not-the-token', step: { type: 'change', selectors: [['#pwd']], value: 'wrong-token' } }) });
    // Authenticated but malformed. A field nobody validated is exactly how a page would
    // smuggle something into a flow.json that gets replayed.
    fn({ name: '__wuRecordStep', payload: emit({ type: 'click', selectors: [['#evil']], target: 'main', onclick: 'fetch("https://evil.example")' }) });
    fn({ name: '__wuRecordStep', payload: emit({ type: 'navigate', url: 'https://evil.example/' }) });
    fn({ name: '__wuRecordStep', payload: emit({ type: 'change', selectors: [['#pwd']], value: 'x'.repeat(20000) }) });
    fn({ name: '__wuRecordStep', payload: emit({ type: 'change', selectors: [], value: 'no-selector' }) });
    // The real steps, authenticated and well formed. The FIRST of these is the payload the
    // page-side emitter actually produced in the VM harness above, re-wrapped with this
    // session's token: what crosses the boundary is the emitter's own output rather than a
    // hand-written object, so an emitter/validator integration regression cannot pass
    // (web-uplift-sg5 review, test gap).
    const emittedClick = JSON.parse(synthetic.rawPayloads[0]).step;
    assert(emittedClick.type === 'click' && Array.isArray(emittedClick.selectors),
      `the emitter must have produced a real click payload: ${JSON.stringify(emittedClick)}`);
    fn({ name: '__wuRecordStep', payload: emit(emittedClick) });
    fn({ name: '__wuRecordStep', payload: emit({ type: 'change', selectors: [['#email']], value: '', redacted: true }) });
    fn({ name: '__wuRecordStep', payload: emit({ type: 'change', selectors: [['#search']], value: 'winter boots' }) });
    fn({ name: '__wuRecordStep', payload: emit({ type: '__done' }) });
  }
  const flow = await flowPromise;
  assert(flow.title === 'Recorded flow (example.com)', 'flow title matches host');
  assert(flow.steps.length === 9, 'flow contains 9 steps (viewport, 5 navs, 1 emitted click, 2 changes)');
  // The emitter's own click payload was accepted end-to-end (see the loop above): this is
  // the assertion that the emitter and the validator agree on a REAL click, which is what
  // the review asked for - a hand-written step in this test would not have proved it.
  assert(flow.steps[6].type === 'click' && Array.isArray(flow.steps[6].selectors),
    `the emitter's own click must be persisted: ${JSON.stringify(flow.steps[6])}`);
  assert(flow.steps[1].type === 'navigate' && flow.steps[1].url.includes('token=%5Bredacted%5D'), 'flow nav step redacts token');
  assert(flow.steps[1].url.includes('postalCode=90210'), 'flow nav step preserves postalCode');
  assert(flow.steps[2].type === 'navigate' && flow.steps[2].url === 'https://example.com/settings/security', 'flow nav step preserves exact /settings/security');
  assert(flow.steps[3].type === 'navigate' && flow.steps[3].url === 'https://example.com/app#/user/[redacted]?tab=2',
    `flow nav step redacts the PII-bearing fragment route: ${flow.steps[3].url}`);
  assert(flow.steps[4].type === 'navigate' && flow.steps[4].url === 'https://example.com/app#/token/[redacted]',
    `flow nav step redacts the token fragment route: ${flow.steps[4].url}`);
  assert(flow.steps[5].type === 'navigate' && flow.steps[5].url === 'https://example.com/app#/token/[redacted]?tab=2',
    `flow nav step redacts the token fragment route with query: ${flow.steps[5].url}`);
  assert(flow.steps[7].redacted === true && flow.steps[7].value === '', 'flow email step is redacted');
  assert(flow.steps[8].value === 'winter boots', 'flow search step preserves value');

  const serialized = JSON.stringify(flow);
  assert(serialized.includes('https://example.com/settings/security'), 'serialized flow must preserve exact /settings/security route');
  assert(!serialized.includes('sec123'), 'serialized flow must not leak token');
  assert(!serialized.includes('alice@test.com'), 'serialized flow must not leak email');
  assert(!serialized.includes('alice@example.com'), 'serialized flow must not leak the fragment-key email');
  assert(!serialized.includes('abc123'), 'serialized flow must not leak the token fragment value (bare or queried)');
  // sg5: nothing a page script sent reached the flow; a redacted step still cannot carry a
  // value; and the refusals are visible to the operator instead of silent.
  assert(!serialized.includes('evil.example') && !serialized.includes('ATTACKER_KEY_123'),
    `a page-supplied navigate step must never be persisted: ${serialized.slice(0, 200)}`);
  assert(!serialized.includes('attacker-typed') && !serialized.includes('wrong-token') && !serialized.includes('onclick'),
    'a page-supplied change/handler step must never be persisted');
  assert(!serialized.includes('x'.repeat(100)), 'an oversized value must never be persisted');
  assert(flow.steps[7].redacted === true && flow.steps[7].value === '',
    'a redacted change step still carries no value, whatever the emitter sends');
  const refusals = logs11.filter((m) => /refused a step the recorder did not emit/.test(m));
  assert(refusals.length >= 5, `every refused step must be reported to the operator, got ${JSON.stringify(logs11)}`);
  assert(!flow.tokens, 'the token must not leak into the flow record');

  // 12. End-to-end recordFlow execution with opt-in flags (captureHidden, captureSensitive).
  const bindingListenersOpt = [];
  const frameNavListenersOpt = [];
  const optLogs = [];
  const injectedOpt = [];
  const mockCdpOpt = {
    Runtime: {
      addBinding: async () => {},
      bindingCalled: (fn) => bindingListenersOpt.push(fn),
    },
    Page: {
      frameNavigated: (fn) => frameNavListenersOpt.push(fn),
      addScriptToEvaluateOnNewDocument: async ({ source }) => { injectedOpt.push(source); },
      navigate: async () => {},
    },
  };
  const flowOptPromise = recordFlow(mockCdpOpt, 'https://example.com/checkout', { captureHidden: true, captureSensitive: true, log: (m) => optLogs.push(m) });
  await new Promise((r) => setTimeout(r, 10));

  for (const fn of frameNavListenersOpt) {
    fn({ frame: { parentId: null, url: 'https://example.com/checkout?step=2&token=sec123&user_email=alice@test.com' } });
  }
  const tokenOpt = /const TOKEN = "([^"]+)"/.exec(injectedOpt.join('\n'))?.[1];
  assert(typeof tokenOpt === 'string' && tokenOpt.length >= 16, 'the opt-in session must carry its own token');
  const emitOpt = (step) => JSON.stringify({ __wu: tokenOpt, step });
  for (const fn of bindingListenersOpt) {
    fn({ name: '__wuRecordStep', payload: emitOpt({ type: 'change', selectors: [['#hiddenToken']], value: 'csrf_secret_123' }) });
    fn({ name: '__wuRecordStep', payload: emitOpt({ type: 'change', selectors: [['#email']], value: 'alice@test.com' }) });
    fn({ name: '__wuRecordStep', payload: emitOpt({ type: '__done' }) });
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
  const { classifyClickControl, findMutatingControl, isSubmitControl, isWriteUrl, parseFlowArgs, replayFlow, resolveSelectorCandidate } = await import('../runner/flow.mjs');

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

  // 2c. web-uplift-d31: a dry run is DEFAULT-DENY for interactive controls, not a
  // keyword check. The old predicate returned null for a plain
  // <button>Update Profile</button> outside a form, so a click on it fell through
  // to el.click() against the live target.
  const mk = (props) => ({ nodeType: 1, getAttribute: () => null, closest: () => null, ...props });
  const reasonFor = (el) => classifyClickControl(el).reason;
  const outsideFormButton = mk({ tagName: 'BUTTON', textContent: 'Update Profile' });
  assert(classifyClickControl(outsideFormButton).gated, 'a button outside a form is gated by default');
  assert(reasonFor(outsideFormButton).includes('Update Profile'), `the refusal names the control: ${reasonFor(outsideFormButton)}`);
  for (const label of ['Post', 'Apply', 'Continue', 'Proceed', 'Publish', 'Archive', 'Rename']) {
    assert(classifyClickControl(mk({ tagName: 'BUTTON', textContent: label })).gated,
      `a button labelled "${label}" must be gated in dry-run`);
  }
  const menuItem = mk({
    tagName: 'DIV', role: 'menuitem', textContent: 'Rename',
    getAttribute: (k) => (k === 'onclick' ? 'renameItem()' : k === 'role' ? 'menuitem' : null),
  });
  assert(classifyClickControl(menuItem).gated,
    'a <div role=menuitem onclick> is gated (it was invisible to the old form/BUTTON check)');
  // The allowlist is read-only navigation and client-side disclosure, not labels.
  assert(!classifyClickControl(mk({ tagName: 'A', textContent: 'About Us', getAttribute: (k) => (k === 'href' ? '/about' : null) })).gated,
    'a plain link is read-only navigation');
  assert(!classifyClickControl(mk({ tagName: 'SUMMARY', textContent: 'Details' })).gated, 'a summary disclosure toggle does not write');
  assert(!classifyClickControl(mk({ tagName: 'DIV', role: 'tab', textContent: 'Tab 1' })).gated, 'a tab switch is client-side');
  assert(!classifyClickControl(mk({ tagName: 'INPUT', type: 'text' })).gated, 'clicking a text field only focuses it');
  assert(classifyClickControl(mk({ tagName: 'INPUT', type: 'checkbox' })).gated, 'a checkbox click fires a change handler');
  assert(classifyClickControl(mk({ tagName: 'SELECT' })).gated, 'a select sets a value');
  assert(classifyClickControl(mk({ tagName: 'A', textContent: 'Delete account', getAttribute: (k) => (k === 'href' ? '/account/delete' : null) })).gated,
    'a link whose label or URL names a write is gated (a GET that deletes is a delete)');
  assert(classifyClickControl(mk({ tagName: 'A', textContent: 'More', getAttribute: (k) => (k === 'href' ? 'javascript:void(0)' : null) })).gated,
    'a javascript: link is code, not navigation');
  assert(classifyClickControl(mk({ tagName: 'BUTTON', textContent: 'Continue', getAttribute: (k) => (k === 'form' ? 'checkout' : null) })).gated,
    'a control owned by a form is gated');
  assert(findMutatingControl(menuItem) === menuItem && findMutatingControl(outsideFormButton) === outsideFormButton,
    'findMutatingControl still answers which element would be triggered');
  assert(findMutatingControl(mk({ tagName: 'A', getAttribute: (k) => (k === 'href' ? '/about' : null) })) === null,
    'findMutatingControl returns null for read-only navigation');

  // 2d. web-uplift-d31: a NAVIGATION whose URL names a write is gated, while the
  // journey's ordinary pages are the reason dry-run exists.
  assert(isWriteUrl('https://example.test/delete?id=1'), '/delete is a write');
  assert(isWriteUrl('https://example.test/account/delete'), 'a trailing /delete segment is a write');
  assert(isWriteUrl('https://example.test/account/logout'), '/logout is a write');
  assert(isWriteUrl('https://example.test/x?action=delete'), 'action=delete is a write');
  assert(!isWriteUrl('https://example.test/reset-password/abc123'), '/reset-password is a read (its segment is reset-password)');
  assert(!isWriteUrl('https://example.test/checkout'), 'loading the checkout page is a read');
  assert(!isWriteUrl('https://example.test/deleted-items'), 'a segment that merely starts with delete is not a write');
  assert(!isWriteUrl(''), 'no URL is not a write');

  // 2e. The review's follow-ups (findings 1-4 on this delta).
  // Finding 1: a click resolved to a LEAF node inside the control that acts. The
  // Recorder matches whatever it found, so <span>Delete</span> inside an <a> must be
  // lifted to the anchor - with `a` missing from the closest() selector it fell through
  // to "not an interactive control" and el.click() bubbled into a real navigation.
  const deleteAnchor = mk({ tagName: 'A', textContent: 'Delete Account', getAttribute: (k) => (k === 'href' ? '/account/delete' : null) });
  // Token-accurate: `sel.includes('a')` would be true for 'textarea' and make this test
  // pass without the fix (it did, until the mutation check caught it).
  const lifts = (sel, tag) => sel.split(',').map((x) => x.trim()).includes(tag);
  const spanInDeleteAnchor = mk({ tagName: 'SPAN', textContent: 'Delete Account', closest: (sel) => (lifts(sel, 'a') ? deleteAnchor : null) });
  assert(classifyClickControl(spanInDeleteAnchor).gated,
    'click on a span INSIDE <a href=/account/delete> must be lifted to the anchor and gated');
  assert(/names a write/.test(reasonFor(spanInDeleteAnchor)), `and the refusal names the link: ${reasonFor(spanInDeleteAnchor)}`);
  const logoutAnchor = mk({ tagName: 'A', textContent: '', getAttribute: (k) => (k === 'href' ? '/logout' : null) });
  const iconInLogoutAnchor = mk({ tagName: 'IMG', closest: (sel) => (lifts(sel, 'a') ? logoutAnchor : null) });
  assert(classifyClickControl(iconInLogoutAnchor).gated, 'an icon inside <a href=/logout> is lifted to the anchor and gated');
  const checkboxLabel = mk({ tagName: 'LABEL', textContent: 'Autosave' });
  const spanInLabel = mk({ tagName: 'SPAN', textContent: 'Autosave', closest: (sel) => (lifts(sel, 'label') ? checkboxLabel : null) });
  assert(classifyClickControl(spanInLabel).gated, 'a span inside a <label> forwards the click to its control and is gated');
  // ...and the container-role trap my first version had: closest('[role]') would lift
  // <main role="main"> from any span inside it and refuse an ordinary click.
  const mainRegion = mk({ tagName: 'MAIN', getAttribute: (k) => (k === 'role' ? 'main' : null) });
  const spanInMain = mk({ tagName: 'SPAN', textContent: 'Read more', closest: (sel) => (sel.includes('role="main"') ? null : mainRegion) });
  assert(!classifyClickControl(spanInMain).gated, 'a container role (role=main) must not gate a click inside it');

  // Finding 2: substring matching on the label refused ordinary navigation links.
  for (const [href, text] of [
    ['/credits', 'Site Credits'], ['/contact', 'Our Address'], ['/careers/ladder', 'Engineering Ladder'],
    ['/blog/1', 'Read Post'], ['/news', 'Product Updates'], ['/orders', 'Order History'],
    ['/article', 'Continue Reading'], ['/apply', 'How to Apply'], ['/about', 'About Us'],
  ]) {
    const link = mk({ tagName: 'A', textContent: text, getAttribute: (k) => (k === 'href' ? href : null) });
    assert(!classifyClickControl(link).gated, `a read-only link must not be gated: "${text}" (${href}) -> ${reasonFor(link)}`);
  }
  // ...while a destructive verb in the link's own text still refuses it.
  assert(classifyClickControl(mk({ tagName: 'A', textContent: 'Delete' })).gated, 'a bare <a>Delete</a> is still refused');
  // Finding 3: the link-URL check missed a query verb, a bare relative target and an extension.
  for (const href of ['/items?action=delete', 'delete', './delete', '/delete.php', '/account/logout.php', '/x?op=remove']) {
    const link = mk({ tagName: 'A', textContent: 'go', getAttribute: (k) => (k === 'href' ? href : null) });
    assert(classifyClickControl(link).gated, `a link to a URL that names a write must be gated: ${href}`);
  }
  // A link to /news/archive IS gated: archiving is a mutation and the URL alone cannot
  // tell a listing from "archive this item", so a CLICK takes the safe direction. The
  // NAVIGATION to the same URL is allowed (isWriteUrl), because a dry run must be able
  // to follow the journey - that asymmetry is the point of the two different sets.
  assert(classifyClickControl(mk({ tagName: 'A', textContent: 'go', getAttribute: (k) => (k === 'href' ? '/news/archive' : null) })).gated,
    'a click on a link to /news/archive is gated (safe direction) even though navigating there is not');
  assert(!isWriteUrl('https://example.test/news/archive'), 'navigating to /news/archive is allowed');
  assert(!classifyClickControl(mk({ tagName: 'A', textContent: 'go', getAttribute: (k) => (k === 'href' ? '/reset-password/abc' : null) })).gated,
    'a link to /reset-password/<token> is a read');
  // A role=link that carries its target in data-href is read the same way.
  assert(classifyClickControl(mk({ tagName: 'DIV', role: 'link', textContent: 'Delete account', getAttribute: (k) => (k === 'data-href' ? '/account/delete' : null) })).gated,
    'a role=link with data-href that names a write is gated');
  // Finding 4: SPA hash routes name writes too, and /delete.php is a write while
  // /news/archive and a payment-return /checkout/cancel are not.
  assert(isWriteUrl('https://app.test/#/account/delete'), 'a hash route that names a write is a write');
  assert(isWriteUrl('https://app.test/#/settings/logout'), 'a hash route /logout is a write');
  assert(isWriteUrl('https://example.test/account/delete.php'), 'a write with a .php extension is a write');
  assert(!isWriteUrl('https://example.test/news/archive'), '/news/archive is a listing');
  assert(!isWriteUrl('https://store.example/checkout/cancel'), 'a payment-return landing page named cancel is not a write');
  assert(!isWriteUrl('https://example.test/#/archive/2024'), 'an archive listing in a hash route is not a write');

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
  class MiniElement {
    constructor(tagName, id = null, textContent = '') {
      this.tagName = tagName;
      this.id = id;
      this.textContent = textContent;
      this.nodeType = 1;
      this.children = [];
      this.shadowRoot = null;
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    attachShadow(init) {
      this.shadowRoot = new MiniDocumentFragment();
      this.shadowRoot.mode = init.mode;
      return this.shadowRoot;
    }
    querySelector(sel) {
      if (sel.startsWith('#') && this.id === sel.slice(1)) return this;
      for (const child of this.children) {
        const match = child.querySelector(sel);
        if (match) return match;
      }
      return null;
    }
    querySelectorAll(sel) {
      const res = [];
      if (sel === '*') {
        res.push(this);
        for (const child of this.children) {
          res.push(...child.querySelectorAll(sel));
        }
      }
      return res;
    }
    get childElementCount() { return this.children.length; }
    getAttribute() { return null; }
    closest() { return null; }
  }

  class MiniDocumentFragment {
    constructor() {
      this.children = [];
      this.mode = 'open';
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    querySelector(sel) {
      for (const child of this.children) {
        const match = child.querySelector(sel);
        if (match) return match;
      }
      return null;
    }
    querySelectorAll(sel) {
      const res = [];
      for (const child of this.children) {
        res.push(...child.querySelectorAll(sel));
      }
      return res;
    }
  }

  const shadowTarget = new MiniElement('BUTTON', 'shadowBtn', 'Shadow');
  const nestedTarget = new MiniElement('BUTTON', 'nestedBtn', 'Nested');
  
  const shadowHost = new MiniElement('DIV');
  const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
  shadowRoot.appendChild(shadowTarget);
  
  const nestedHost = new MiniElement('DIV');
  const nestedRoot = nestedHost.attachShadow({ mode: 'open' });
  nestedRoot.appendChild(nestedTarget);
  shadowRoot.appendChild(nestedHost);

  const shadowDoc = new MiniDocumentFragment();
  shadowDoc.appendChild(shadowHost);

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
      focus: () => {},
      ...props,
    };
  }

  function makeVmReplayClient({ activeElement } = {}) {
    const clicks = [];
    const submits = [];
    const typed = [];
    const navigations = [];
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
    // web-uplift-d31 / e4z fixtures: an SPA button outside a form, a
    // role=menuitem with an inline handler, an autosave text field and a
    // password field whose flow carries a real value and no `redacted` flag.
    const updateBtnEl = stubEl({ tagName: 'BUTTON', textContent: 'Update Profile', click() { clicks.push('updateBtn'); } });
    const menuItemEl = stubEl({
      tagName: 'DIV', textContent: 'Rename', role: 'menuitem',
      getAttribute: (k) => (k === 'onclick' ? 'renameItem()' : k === 'role' ? 'menuitem' : null),
      click() { clicks.push('menuItem'); },
    });
    const emailInputEl = stubEl({ tagName: 'INPUT', type: 'email', value: '', id: 'email', dispatchEvent: (e) => { typed.push(`${e.type}:${emailInputEl.value}`); } });
    const pwdInputEl = stubEl({ tagName: 'INPUT', type: 'password', value: '', id: 'pwd', dispatchEvent: (e) => { typed.push(`${e.type}:${pwdInputEl.value}`); } });
    Object.assign(byId, { '#update': updateBtnEl, '#menu': menuItemEl, '#email': emailInputEl, '#pwd': pwdInputEl });
    // Review findings 1 and 2, in the replay path itself: a click resolved to a span
    // INSIDE <a href="/account/delete"> (must be gated) and an ordinary link whose text
    // merely contains "edit" ("Site Credits", must NOT be gated).
    const deleteAccountAnchor = stubEl({ tagName: 'A', textContent: 'Delete Account', getAttribute: (k) => (k === 'href' ? '/account/delete' : null), click() { clicks.push('deleteAccountAnchor'); } });
    const spanInDeleteAnchorEl = stubEl({
      tagName: 'SPAN', textContent: 'Delete Account',
      closest: (sel) => (sel.split(',').map((x) => x.trim()).includes('a') ? deleteAccountAnchor : null),
      click() { clicks.push('spanInDeleteAnchor'); },
    });
    const creditsLink = stubEl({ tagName: 'A', textContent: 'Site Credits', getAttribute: (k) => (k === 'href' ? '/credits' : null), click() { clicks.push('creditsLink'); } });
    Object.assign(byId, { '#deleteSpan': spanInDeleteAnchorEl, '#credits': creditsLink });
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
      typed,
      navigations,
      Page: {
        captureScreenshot: async () => ({ data: 'AAAA' }),
        navigate: async ({ url }) => { navigations.push(url); },
        loadEventFired: () => Promise.resolve(),
      },
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
      // 7-12: web-uplift-d31 (default-deny clicks, change steps, write URLs) and
      // e4z (an imported flow's password step carries a value and no redacted flag).
      { type: 'click', selectors: [['#update']], target: 'main' },
      { type: 'click', selectors: [['#menu']], target: 'main' },
      { type: 'change', selectors: [['#email']], value: 'alice@example.com' },
      { type: 'navigate', url: 'https://example.test/delete?id=1' },
      { type: 'navigate', url: 'https://example.test/about' },
      { type: 'change', selectors: [['#pwd']], value: 'secret123' },
      { type: 'click', selectors: [['#deleteSpan']], target: 'main' },
      { type: 'click', selectors: [['#credits']], target: 'main' },
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
  assert(dryClient.clicks.length === 3 && dryClient.clicks.every((c) => c === 'aboutLink' || c === 'creditsLink'),
    `dry-run must click ONLY the innocent links, got: ${JSON.stringify(dryClient.clicks)}`);
  assert(dryClient.submits.length === 0, 'dry-run must never submit a form');

  // 7. A button outside a form, whatever its label, is gated (d31).
  assert(resDefault.steps[7].mutationBlocked === true, 'click on a plain <button>Update Profile</button> blocked in dry-run');
  assert(resDefault.steps[7].detail.includes('Update Profile'), `the refusal names the control: ${resDefault.steps[7].detail}`);
  assert(resDefault.steps[7].detail.includes('--allow-mutations'), 'the refusal says how to proceed');
  // 8. A role=menuitem with an inline handler is gated even though it is a DIV.
  assert(resDefault.steps[8].mutationBlocked === true, 'click on <div role=menuitem onclick> blocked in dry-run');
  assert(!dryClient.clicks.includes('updateBtn') && !dryClient.clicks.includes('menuItem'),
    `dry-run must not click an ungated SPA control, got: ${JSON.stringify(dryClient.clicks)}`);
  // 9. A change step is not dispatched: autosave/inline-AJAX listens on input/change.
  assert(resDefault.steps[9].mutationBlocked === true, 'dry-run must not dispatch a change step');
  assert(/autosave/.test(resDefault.steps[9].detail), `the refusal explains the autosave risk: ${resDefault.steps[9].detail}`);
  assert(dryClient.typed.length === 0, `dry-run must type nothing, got: ${JSON.stringify(dryClient.typed)}`);
  // 10-11. A navigation that names a write is gated; an ordinary page is not.
  assert(resDefault.steps[10].mutationBlocked === true, 'dry-run must not navigate to a URL that names a write');
  assert(!dryClient.navigations.includes('https://example.test/delete?id=1'),
    `the write URL must never be requested, got: ${JSON.stringify(dryClient.navigations)}`);
  assert(resDefault.steps[11].ok === true && !resDefault.steps[11].mutationBlocked, 'ordinary navigation still runs in dry-run');
  assert(dryClient.navigations.includes('https://example.test/about'), 'the journey page is still loaded');
  // 12. e4z: a password field is never filled in dry-run, even though this flow
  // step carries a value and no `redacted` flag (an imported Recorder export).
  assert(resDefault.steps[12].mutationBlocked === true, 'dry-run must not fill a password field from an imported flow');
  assert(/password/.test(resDefault.steps[12].detail), `the refusal names the password field: ${resDefault.steps[12].detail}`);
  // 13. Iterating the fix: a span inside <a href="/account/delete"> must be lifted to
  // the anchor. With `a` missing from closest(), el.click() bubbled to a real delete.
  assert(resDefault.steps[13].mutationBlocked === true, 'click on a span inside <a href=/account/delete> blocked in dry-run');
  assert(!dryClient.clicks.includes('spanInDeleteAnchor') && !dryClient.clicks.includes('deleteAccountAnchor'),
    `the delete link must not be clicked, got: ${JSON.stringify(dryClient.clicks)}`);
  // 14. ...and a link that merely CONTAINS "edit" ("Site Credits") is not a write.
  assert(resDefault.steps[14].ok === true && !resDefault.steps[14].mutationBlocked,
    `an ordinary link labelled "Site Credits" must be clickable in dry-run: ${resDefault.steps[14].detail}`);
  assert(dryClient.clicks.includes('creditsLink'), `it is clicked, got: ${JSON.stringify(dryClient.clicks)}`);
  assert(dryClient.clicks.length === 3, `dry-run clicks the three innocent links only, got: ${JSON.stringify(dryClient.clicks)}`);

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
  // --allow-mutations is the documented way to perform the gated steps, and it
  // performs every one of them (the gate is a gate, not a removal).
  assert(resAllow.steps[7].ok === true && !resAllow.steps[7].mutationBlocked && allowClient.clicks.includes('updateBtn'),
    'allowed run clicks the SPA button');
  assert(resAllow.steps[8].ok === true && !resAllow.steps[8].mutationBlocked && allowClient.clicks.includes('menuItem'),
    'allowed run clicks the role=menuitem');
  assert(resAllow.steps[9].ok === true && !resAllow.steps[9].mutationBlocked, 'allowed run dispatches the change step');
  assert(allowClient.typed.includes('change:alice@example.com'),
    `allowed change step dispatches input+change, got: ${JSON.stringify(allowClient.typed)}`);
  assert(resAllow.steps[10].ok === true && !resAllow.steps[10].mutationBlocked && allowClient.navigations.includes('https://example.test/delete?id=1'),
    'allowed run performs the write URL navigation');
  assert(resAllow.steps[12].ok === true && !resAllow.steps[12].mutationBlocked,
    'allowed run fills the password field (explicit --allow-mutations)');
  assert(allowClient.typed.includes('change:secret123'),
    `allowed password step types the value, got: ${JSON.stringify(allowClient.typed)}`);
  assert(resAllow.steps[13].ok === true && !resAllow.steps[13].mutationBlocked && allowClient.clicks.includes('spanInDeleteAnchor'),
    'allowed run clicks through to the delete link when explicitly authorized');
}

// Run directly (node tests/flow.mjs), not when imported by the regression
// suite, which calls the exported functions itself.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await testFlowNormalize();
  await testFlowRecordSensitiveRedaction();
  await testFlowReplayMutationGate();
  console.log('tests OK');
}
