// ONE vocabulary for "a NAME that carries a credential, a payment identifier, or
// sensitive identity data" (web-uplift-glar, web-uplift-lw6, web-uplift-so2).
//
// WHY THIS MODULE EXISTS
// evidence/cli.mjs (the HAR "dsj" redaction) and runner/flow-record.mjs (the flow
// recorder/replayer) each grew their own word list for the same concept. Two
// tables for one concept drift by construction: by 2026-10-09, cli.mjs persisted
// ?csrf=, ?pin=, ?cvv= and ?passcode= unredacted while flow persisted ?code= and
// ?key= unredacted, each leaking exactly what the other redacted. The words, the
// tokenisation and the plural rule live here now; both callers use them, so the
// two redactors cannot disagree again.
//
// WHY TWO STRENGTHS INSTEAD OF ONE FLAT LIST
// `code` and `key` are credential-shaped as the WHOLE name (?code=AUTH_CODE_123,
// ?key=AIza...), but ordinary words inside a longer name: postalCode,
// countryCode and sortKey must keep their values or replay breaks. They are
// therefore WEAK words, matched ONLY when the entire name is that word (or its
// joined form, e.g. authcode/api_key through the compound rules below).
// Everything else is STRONG and matches as ANY word of a camelCase, snake_case,
// kebab-case or spaced name (apiKey, auth_token, userSession, accessKey).
//
// WHY PII IS A SEPARATE SET
// The HAR path is a credential redactor: it rewrites the VALUES of
// credential-named fields and deliberately leaves everything else intact so the
// artifact stays diagnostic. The flow recorder has a wider job - a recorded
// journey must not carry personal data either - so its field and navigation
// classifier also refuses emails, phone numbers, names, addresses and identity
// numbers. Both use the ONE credential vocabulary here; the flow side adds the
// PII set on top. That is a documented difference in strictness, not a second
// table for the same concept.
//
// Both halves are data, so the page-side copy the flow recorder injects into the
// browser is generated from these sets (makeCaptureJs) instead of being a third
// hand-maintained list.

// Credential-shaped words. Matched as any word of a name, joined with a
// neighbour, or joined whole; plural-tolerant in all three positions.
export const CREDENTIAL_WORDS = new Set([
  'passwd', 'password', 'pwd', 'secret', 'token', 'apikey', 'auth', 'authorization',
  'session', 'sessionid', 'sig', 'signature', 'credential', 'credentials', 'bearer',
  'jwt', 'otp', 'otc', 'mfa', 'onetimecode', 'onetimenumber', 'accesstoken', 'refreshtoken',
  'clientsecret', 'privatekey', 'accesskey', 'secretkey', 'idtoken', 'passcode', 'pin',
  'csrf', 'xsrf', 'security', 'securitycode', 'verificationcode',
  // payment & financial identifiers
  'cvv', 'cvc', 'csc', 'cardnumber', 'creditcard', 'cardholder', 'routing', 'iban', 'swift',
]);

// Credential-shaped only when the ENTIRE name is the word. See the header: a
// substring match here would take postalCode, countryCode and sortKey with it.
export const WEAK_CREDENTIAL_WORDS = new Set(['code', 'key']);

// Qualifiers that turn a weak word into a credential compound: auth+code,
// verify+code, api+key, otp+code are credentials, while sort+key, postal+code,
// country+code and redirect+uri+code are ordinary names that must keep their
// values. A qualifier on its own is not a credential (the strong set carries the
// spellings that are, e.g. 'otp', 'auth', 'token').
export const WEAK_QUALIFIER_WORDS = new Set([
  'auth', 'api', 'otp', 'mfa', 'totp', 'verify', 'verification', 'confirm', 'confirmation',
  'activate', 'activation', 'reset', 'recover', 'recovery', 'invite', 'unlock',
  'sms', 'email', 'device', 'backup', 'security', 'secret', 'private', 'access',
]);

// Sensitive PII / identity numbers. Used by the flow recorder's field and
// navigation classifier (never by the HAR credential redactor).
export const SENSITIVE_PII_WORDS = new Set([
  'ssn', 'socialsecurity', 'taxid', 'dob', 'birthdate',
  'email', 'phone', 'telephone', 'mobile', 'cellphone',
  'fullname', 'firstname', 'lastname', 'surname', 'username',
  'address', 'street',
]);

// The union, for callers that want one flat "is this word sensitive at all"
// membership test (the flow recorder's autocomplete token test does).
export const SENSITIVE_WORDS = new Set([...CREDENTIAL_WORDS, ...SENSITIVE_PII_WORDS]);

// Short PII words that are too ambiguous to live in a word set and are matched
// exactly instead (a bare `name` field is a person's name; `filename` is not).
const SHORT_PII_WORDS = new Set(['name', 'email', 'phone', 'tel']);

// Singular-but-a-plural-was-written: a word also matches when stripping ONE
// trailing 's' lands in the set ('secrets', 'apiKeys' via 'apikeys'). The strip
// is conditional on the RESULT being in the set, so innocent plurals ('boxes',
// 'regions', 'fonts') never stem into a match.
const member = (set, w) => set.has(w) || (w.endsWith('s') && set.has(w.slice(0, -1)));

export const isCredentialWord = (w) => member(CREDENTIAL_WORDS, w);
export const isWeakCredentialWord = (w) => member(WEAK_CREDENTIAL_WORDS, w);
export const isPiiWord = (w) => member(SENSITIVE_PII_WORDS, w) || SHORT_PII_WORDS.has(w);
export const isSensitiveWord = (w) => isCredentialWord(w) || isPiiWord(w);

// Split a name on separators AND camelCase/PascalCase boundaries, the way a
// credential actually gets spelled: accessToken, access_token, access-token.
export function splitName(str) {
  if (!str || typeof str !== 'string') return [];
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Credential-shaped NAME (no PII): the whole name, any one word of it, or two
// adjacent words joined (apiKey -> 'apikey', authToken -> 'auth'+'token'). Weak
// words match only as the whole name (or its joined compound, e.g. auth_code).
export function isCredentialName(name) {
  const words = splitName(name);
  if (!words.length) return false;
  const joined = words.join('');
  if (isCredentialWord(joined) || isWeakCredentialWord(joined)) return true;
  if (words.some(isCredentialWord)) return true;
  // A weak word qualified by a credential context: verifyCode, auth_code, api_key.
  if (words.some(isWeakCredentialWord) && words.some((w) => WEAK_QUALIFIER_WORDS.has(w))) return true;
  for (let i = 0; i < words.length - 1; i++) {
    if (isCredentialWord(words[i] + words[i + 1])) return true;
  }
  return false;
}

// WHY WEAK WORDS ARE NOT PART OF THE FIELD TEST
// isCredentialName (URL parameters, HAR fields, redirect Locations) treats a bare
// `code`/`key` as a credential, because ?code=AUTH_CODE_123 (an OAuth callback)
// and ?key=AIza... (an API call) are credentials. A FORM field named `code` is
// just as often a promo or product code, and redacting its value breaks replay of
// the journey the recorder exists to capture, so the field test here (and the
// page-side classifier generated from it) deliberately stays on STRONG words plus
// PII. Compound spellings (oneTimeCode, otpCode, verificationCode, passcode) are
// in the strong set and cover the OTP fields.

// Credential OR PII shaped name, the flow recorder's FIELD test.
export function isSensitiveName(name) {
  const words = splitName(name);
  if (!words.length) return false;
  if (words.some((w) => isPiiWord(w) || isCredentialWord(w))) return true;
  const joined = words.join('');
  if (isSensitiveWord(joined)) return true;
  for (let i = 0; i < words.length - 1; i++) {
    if (isSensitiveWord(words[i] + words[i + 1])) return true;
  }
  return false;
}

// A PATH segment or FRAGMENT that is itself the credential, with no name to
// classify: /reset-password/a8f9c0e2d4b6, ?returnTo=..., #ya29.a0AfH6SMB...
// Deliberately conservative, because redacting an innocent route segment breaks
// replay: a word-shaped segment (about-us, my-first-post) never matches, and the
// alphanumeric rule refuses a run that contains a natural-language word (four or
// more consecutive lowercase letters), so OrderConfirmation123,
// UserProfileStep2Page and SummerSalePromo2024 are routes while AbCdEf1234567890
// is an opaque id. Also refused on purpose: multi-dot filenames (bundle.min.js,
// archive.tar.gz), version strings (release-1.0.0, en-US.messages.json) and plain
// UUIDs. A UUID is a resource identifier far more often than it is a credential
// (/orders/<uuid> must keep replaying), and it carries no token shape, so neither
// this rule nor the route-marker rule below rewrites it.
// Shapes covered: a hex id with at least one letter, a JWT (its segments are
// base64url of JSON, so the header and payload start 'eyJ'), a short
// digits-dot-opaque token (Google's ya29.* access tokens), and a long
// separator-free-or-base64url opaque string with no word in it.
export function looksLikeToken(value) {
  if (!value || typeof value !== 'string') return false;
  if (value.length < 10) return false;
  if (/^[0-9a-f]{10,}$/i.test(value) && /\d/.test(value) && /[a-f]/i.test(value)) return true;
  // A JWT, in 2- or 3-part form. 'eyJ' is the base64url of '{"': requiring it is
  // what keeps bundle.min.js and en-US.messages.json out of this rule.
  if (/^eyJ[A-Za-z0-9_-]{4,}(\.[A-Za-z0-9_-]{4,}){1,2}$/.test(value)) return true;
  if (/^[0-9]{2,}\.[A-Za-z0-9_-]{12,}$/.test(value)) return true;
  if (/^[A-Za-z]{2}[0-9]{2,}\.[A-Za-z0-9_-]{12,}$/.test(value)) return true;
  if (value.length >= 16 && /^[A-Za-z0-9_-]+$/.test(value) && /\d/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && !/[a-z]{4,}/.test(value)) return true;
  return false;
}

// The literal JSON the page-side capture script is built from, so the injected
// classifier and the Node-side classifier can never hold different words.
// The literal written into a credential-named query parameter or header. One constant, so the URL
// redactor here and the HAR header redactor in evidence/cli.mjs cannot drift apart.
export const REDACTED_VALUE = '[redacted]';

// Redact the VALUES of credential-named query parameters in a URL; keep the names and
// every other parameter exactly as they were.
//
// This lives in the SHARED module rather than in evidence/cli.mjs because the console-evidence
// collector in evidence/cdp.mjs needs the same rule, and cdp.mjs is imported BY cli.mjs - the
// alternative was a second copy of the rule, which is how a credential ends up in an artifact that
// one caller redacts and another does not (web-uplift-lsn3).
export function redactUrlCredentialValues(raw) {
  if (typeof raw !== 'string' || !raw) return raw;
  const apply = (u) => {
    let hit = false;
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (v && isCredentialName(k)) {
        u.searchParams.set(k, REDACTED_VALUE);
        hit = true;
      }
    }
    return hit;
  };
  try {
    const u = new URL(raw);
    return apply(u) ? u.toString() : raw;
  } catch {
    /* not absolute: a redirect Location is very often a relative path */
  }
  try {
    // Parse against a throwaway base and re-emit relative, so a relative redirect target
    // ('/final?session=...') is redacted too - it used to pass through untouched because
    // new URL() rejects a relative string. The path is normalised (a bare '?a=b' gains a
    // leading '/'), which is the only shape change and is noted rather than silent.
    const u = new URL(raw, 'http://relative.invalid');
    if (!apply(u)) return raw;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return raw; // genuinely unparseable: leave it alone rather than guess
  }
}

// A URL that appears INSIDE a string of prose, redacted. This is a SCANNER, not one regex over the
// whole string, and that is deliberate.
//
// Three rounds of review found four shapes a single "match the URL, then redact it" regex got wrong
// (web-uplift-lsn3): a credential in a second URL after a comma, after a semicolon, after a comma
// when the second URL was a rooted path, and after a comma when its scheme was uppercase - because
// the outer match swallowed both URLs and the first URL's parameters were the only ones examined,
// and because every patch added another enumeration case rather than removing the enumeration.
//
// So: find every place a URL can START (one case-insensitive pattern), take each start's span up to
// the next start or a natural boundary, and redact that span. Adjacency stops being a special case:
// any separator, any scheme casing, any order.
// A URL start must sit at a real boundary - the beginning of the text, whitespace, or a separator -
// or a "//" inside a path ('https://x.test/a//b?token=..') would be treated as a second URL and the
// path segment before it would be re-emitted as a protocol-relative URL by the relative branch,
// which drops the host and mangles the path (found by the test below, not by a review).
// NOTE there is deliberately no "does this path have a query?" lookahead here. Every candidate
// start is bounded by the lookbehind, but an unbounded lookahead for a '?' made the SCAN quadratic:
// ",/".repeat(50000) has a boundary slash every two characters, and each one scanned the rest of a
// page-controlled string looking for a '?' that never comes (20k chars 438ms, 40k 1708ms, 80k
// 8610ms - web-uplift-lsn3 review pass 4). Whether a span carries a query is decided AFTER the span
// is bounded, where the check is proportional to that span.
const URL_START = /(?<=^|[\s,;:([{|"'<=>])(?:https?:)?\/\/?/gi;
// Where a URL span cannot continue: whitespace, or a delimiter that ends a token in prose.
const URL_SPAN_STOP = /[\s"'`<>()\[\]{}|]/;

export function redactUrlsInText(text) {
  if (typeof text !== 'string' || !text) return text;
  const starts = [];
  URL_START.lastIndex = 0;
  let found;
  while ((found = URL_START.exec(text)) !== null) {
    if (found[0] === '') {
      URL_START.lastIndex += 1; // no zero-length progress, ever
      continue;
    }
    if (starts[starts.length - 1] !== found.index) starts.push(found.index);
  }
  if (starts.length === 0) return text;

  let out = '';
  let cursor = 0;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const limit = i + 1 < starts.length ? starts[i + 1] : text.length;
    const stop = URL_SPAN_STOP.exec(text.slice(start, limit));
    const end = stop ? start + stop.index : limit;
    const raw = text.slice(start, end);
    // Prose puts punctuation straight after a URL ("see https://x/a?token=SECRET, then"), and the
    // separator that let the NEXT url start ("...?token=SECRET=https://b/x?token=..") is not part
    // of this URL either. Letting either into the parse means the redacted value swallows it and
    // the two URLs fuse, which also breaks idempotence: redacting the fused string again finds a
    // different shape. So hold trailing punctuation AND boundary separators back, and put them
    // back untouched. A URL whose span legitimately ends in '=' (base64 padding, say) is
    // unaffected in the common case, because the held-back character is re-appended verbatim.
    const trailing = /[.,;:!?=|"'<([{+]+$/.exec(raw);
    const body = trailing ? raw.slice(0, -trailing[0].length) : raw;
    out += text.slice(cursor, start);
    // Only a span that carries a query can hold a credential parameter, and checking here keeps the
    // work proportional to the text: the no-query case (the quadratic stress input above) never
    // reaches the URL parser at all.
    out += body && body.includes('?') ? redactUrlCredentialValues(body) : body;
    out += trailing ? trailing[0] : '';
    cursor = end;
  }
  return out + text.slice(cursor);
}

export const NAME_WORD_DATA = {
  credential: [...CREDENTIAL_WORDS],
  weak: [...WEAK_CREDENTIAL_WORDS],
  pii: [...SENSITIVE_PII_WORDS],
  shortPii: [...SHORT_PII_WORDS],
  weakQualifier: [...WEAK_QUALIFIER_WORDS],
};
