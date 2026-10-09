import { isCredentialName, redactUrlCredentialValues, REDACTED_VALUE } from './credential-terms.mjs';

const REDACTED_HEADER_NAMES = new Set([
  'set-cookie',
  'cookie',
  'authorization',
  'proxy-authorization',
  'x-auth-token',
  'x-api-key',
  'x-amz-security-token',
]);
// One literal for every redaction in the tool (web-uplift-lsn3): shared with the URL redactor.
const REDACTED_HEADER_VALUE = REDACTED_VALUE;

// Replace the value of every credential header in a HAR header list, keeping the
// name and any other fields. Non-credential headers pass through untouched, so
// the redaction stays diagnostic rather than wholesale.
// The same names-based test the header redaction uses, applied to the OTHER places a
// credential can land in a network artifact: the request URL and its query string,
// the request body and its size, the redirect target, and response body text when
// bodies are recorded. Named-based is the honest choice - the tool cannot know which
// value in an arbitrary URL or body is a secret, so it redacts the VALUES of fields
// whose NAME says credential and leaves everything else untouched (a redaction that
// blanked whole fields would destroy the evidence the artifact exists to carry).
// Words that mark a value as credential-shaped. Matched as WHOLE WORDS after splitting
// the name on separators AND camelCase boundaries, because a regex anchored on separators
// missed the common spellings `accessToken`, `refreshToken`, `apiKey` and `clientSecret`
// entirely - a hole the review found by asking what a plausible credential parameter
// actually looks like, rather than by testing the spellings we happened to think of.
//
// web-uplift-glar/lw6: the words, the tokenisation and the plural rule now live in ONE
// shared module, evidence/credential-terms.mjs, used by this HAR redactor AND by the
// flow recorder. Two lists for one concept drifted: this file persisted ?csrf=, ?pin=,
// ?cvv= and ?passcode= that the flow recorder redacted, while the flow recorder
// persisted ?code= and ?key= that this file redacted. One module, one answer.
//
// Deliberately fail-closed on ambiguity: `code` and `key` can be innocent (`countryCode`,
// `sortKey`), and redacting an innocent value costs evidence, but leaving a credential
// costs a disclosure. They are therefore matched as the WHOLE name only, which is what
// keeps postalCode/countryCode/sortKey inside the artifact with their values intact.
// The artifact note says the test is names-based and can over-redact.
//
// The module also keeps the flow recorder's PII words (email, phone, names, address)
// SEPARATE from this credential vocabulary: this artifact is a credential redactor, so
// it does not start rewriting fields the review never asked it to touch.
export { isCredentialName, redactUrlCredentialValues };

export function redactQueryList(list) {
  if (!Array.isArray(list)) return list;
  return list.map((p) =>
    p && typeof p === 'object' && p.value && isCredentialName(p.name)
      ? { ...p, value: REDACTED_HEADER_VALUE }
      : p,
  );
}

// Redact credential-named fields inside body text (form-encoded or JSON-ish). The
// name and every other field survive; only the value becomes [redacted].
// STRUCTURED redaction: PARSE TO LOCATE, SPLICE TO REDACT, NEVER RE-SERIALIZE.
//
// An earlier version parsed the body and re-stringified a fresh object. That corrupts evidence:
// a `__proto__` key was assigned through the ordinary object's prototype setter and VANISHED
// from the output, and integers beyond JavaScript's safe range were silently rounded. Both are
// the same defect - the recorded body no longer matched the bytes received.
//
// So the parse is used ONLY to decide whether the text is valid JSON; the redaction itself walks
// the ORIGINAL text, finds each credential-named key's value span, and replaces just that span.
// Every other byte is copied through untouched: no prototype setter, no numeric rounding, no
// formatting drift, no field that can disappear.

// End offset of the JSON value starting at `i` (string, container, or bare primitive).
function jsonValueEnd(text, i) {
  const c = text[i];
  if (c === '"') {
    let k = i + 1;
    while (k < text.length) {
      if (text[k] === '\\') { k += 2; continue; }
      if (text[k] === '"') return k + 1;
      k += 1;
    }
    return text.length;
  }
  if (c === '{' || c === '[') {
    let depth = 0;
    let k = i;
    while (k < text.length) {
      const ch = text[k];
      if (ch === '"') {
        k += 1;
        while (k < text.length) {
          if (text[k] === '\\') { k += 2; continue; }
          if (text[k] === '"') { k += 1; break; }
          k += 1;
        }
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return k + 1;
      }
      k += 1;
    }
    return text.length;
  }
  let k = i;
  while (k < text.length && !/[,\]}\s]/.test(text[k])) k += 1;
  return k;
}

// [start, end) spans of the VALUES belonging to credential-named keys. A string token is a key
// when the next non-space character is ':'; the key token is decoded with JSON.parse so a
// unicode-escaped name is compared as its real name.
function credentialValueSpans(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') { i += 1; continue; }
    const keyStart = i;
    i += 1;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '"') { i += 1; break; }
      i += 1;
    }
    const keyToken = text.slice(keyStart, i);
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    if (text[j] !== ':') continue;
    let v = j + 1;
    while (v < text.length && /\s/.test(text[v])) v += 1;
    const vEnd = jsonValueEnd(text, v);
    let name = null;
    try {
      name = JSON.parse(keyToken);
    } catch {
      name = null;
    }
    if (typeof name === 'string' && isCredentialName(name)) {
      spans.push([v, vEnd]);
      i = vEnd; // the whole value is being replaced, so nothing inside it needs examining
    } else {
      // DESCEND into container values for a NON-credential key. The walker used to jump to the
      // end of the value unconditionally, which skipped every nested object and array, so a
      // credential one level down was never examined (and the valid-JSON path returned its
      // result, so the heuristic scanner never got a second chance at that body). A scalar
      // contains no keys, so only containers descend.
      const vc = text[v];
      i = vc === '{' || vc === '[' ? v + 1 : vEnd;
    }
  }
  return spans;
}

// Returns the redacted text, or null when the input is not valid JSON (the caller then falls
// back to the heuristic text scanner).
function redactJsonText(text) {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    JSON.parse(text); // validity only: the redaction below never re-serialises
  } catch {
    return null;
  }
  const spans = credentialValueSpans(text);
  if (!spans.length) return text;
  let out = '';
  let last = 0;
  for (const [s0, e0] of spans) {
    out += text.slice(last, s0) + `"${REDACTED_HEADER_VALUE}"`;
    last = e0;
  }
  return out + text.slice(last);
}

// ANNOTATION vs COMPARISON vs DESTRUCTURING (web-uplift-xwr, review round 2). Three
// colon shapes share the `name: something ... = something` silhouette and must not be
// confused, because each binds a different span to the secret:
//   const apiKey: TYPE = VALUE   declaration — VALUE after a SINGLE '=' is the secret;
//                                TYPE is evidence and must survive byte-identical.
//   { password: mySecret === x } comparison — the token after ':' is the secret.
//   let { password: n } = y      destructuring rename — the token after ':' is the
//                                secret-bearing name; the '=' belongs to the binding.
// The discriminators, each pinned by a fixture: the declaration's '=' is SINGLE
// (never '==' / '===' / '=>'), its TYPE cannot contain ':', '}', ';' or a newline (so
// comparisons and destructuring never parse as declarations), and the colon pass skips
// a value only when a single '=' follows in the SAME type-like segment (no ':', '}',
// ';' or newline between) — that is annotation residue whose value the declaration
// rule already redacted. The equals pass never skips: a following comparison must not
// abort a form/query redaction. A value consisting only of operator characters is
// never redacted (it is an operator, not a secret). RESIDUALS, stated: an annotation
// whose type spans a newline, contains ';' or '}', or is a function/mapped type
// (`(x) => string`, `{ [K in T]: X }`) matches no rule here — the colon pass may
// redact its first token but the post-'=' value can survive. Names-based redaction
// is a tripwire, not a parser.
//
// BUILT ONCE (web-uplift-eqo): these patterns are constants, so they are compiled here
// at module scope instead of on every redactBodyText call. Reusing a global RegExp
// across calls is safe: String.prototype.replace resets lastIndex to 0 before and after
// its walk.
const ANNOTATION_SKIP = '(?![^=;\\r\\n}:]*=[^=])';
const isOperatorValue = (val) => !/^["']/.test(val) && /^[=!<>|&]+$/.test(val);
const QUOTED_VALUE = `"(?:[^"\\\\]|\\\\[\\s\\S])*"|'(?:[^'\\\\]|\\\\[\\s\\S])*'`;
const TOKEN_VALUE = `[^&;,\\s}]+`;
// TypeScript-style annotated declaration, matched WHOLE and first: quoted or bare name,
// optional '?', lazy type up to a SINGLE '=' (not '==', not '=>'), then the value. Keeps
// `name?: TYPE =` byte-identical and redacts only the value.
const BODY_ANNOTATED_DECLARATION_RE = new RegExp(`("[A-Za-z0-9_.\\-]+"|[A-Za-z0-9_.\\-]+)(\\??\\s*:\\s*[^=;\\r\\n}:]+?\\s*=(?![=>])\\s*)(${QUOTED_VALUE}|${TOKEN_VALUE})`, 'g');
// Quoted keys, with ESCAPES handled: a naive `"[^"]*"` ends at the first quote even when
// it is backslash-escaped, so a value containing \" was replaced only up to the backslash
// and the credential after it stayed in the recorded body. The alternative below consumes
// escaped characters properly, so the WHOLE string value is replaced.
const BODY_QUOTED_KEY_RE = new RegExp(`(["'])([A-Za-z0-9_.\\-]+)\\1(\\s*[:=]\\s*)(${QUOTED_VALUE}|${TOKEN_VALUE})${ANNOTATION_SKIP}`, 'g');
// Unquoted keys, COLON form (JS/JSON-ish object literals in a recorded document body -
// `{ password: 'SECRET' }`). Skips annotation residue per ANNOTATION_SKIP.
const BODY_COLON_KEY_RE = new RegExp(`(^|[?&;,\\s{([])([A-Za-z0-9_.\\-]+)(\\s*:\\s*)(${QUOTED_VALUE}|${TOKEN_VALUE})${ANNOTATION_SKIP}`, 'g');
// Unquoted keys, EQUALS form (form-encoded bodies, query strings). NO skip and no
// annotation logic: a credential value here must be redacted even when a comparison or
// second assignment follows (`password=secret === true`), which a shared lookahead used
// to abort — a disclosure regression the review caught.
const BODY_EQUALS_KEY_RE = new RegExp(`(^|[?&;,\\s{([])([A-Za-z0-9_.\\-]+)(\\s*=\\s*)(${QUOTED_VALUE}|${TOKEN_VALUE})`, 'g');

export function redactBodyText(text) {
  if (typeof text !== 'string' || !text) return text;
  // Structured first, by construction; the scanner below is the heuristic fallback for text
  // that has no parseable structure (an inline script, an HTML body, a partial fragment).
  const structured = redactJsonText(text);
  if (structured !== null) return structured;
  // The heuristics are the four module-scope patterns built above; the comment there
  // records why each rule exists and what the annotation rule deliberately does not cover.
  return text
    .replace(BODY_ANNOTATED_DECLARATION_RE, (match, name, mid, val) => {
      if (!isCredentialName(name.replace(/^"|"$/g, ''))) return match;
      if (isOperatorValue(val)) return match;
      return `${name}${mid}"${REDACTED_HEADER_VALUE}"`;
    })
    .replace(BODY_QUOTED_KEY_RE, (match, q, name, sep, val) => {
      if (!isCredentialName(name)) return match;
      if (isOperatorValue(val)) return match;
      return `${q}${name}${q}${sep}"${REDACTED_HEADER_VALUE}"`;
    })
    .replace(BODY_COLON_KEY_RE, (match, pre, name, sep, val) => {
      if (!isCredentialName(name)) return match;
      if (isOperatorValue(val)) return match;
      return `${pre}${name}${sep}"${REDACTED_HEADER_VALUE}"`;
    })
    .replace(BODY_EQUALS_KEY_RE, (match, pre, name, sep, val) => {
      if (!isCredentialName(name)) return match;
      if (isOperatorValue(val)) return match;
      return `${pre}${name}${sep}"${REDACTED_HEADER_VALUE}"`;
    });
}

export function redactHeaderList(headers) {
  if (!Array.isArray(headers)) return headers;
  return headers.map((header) => {
    if (REDACTED_HEADER_NAMES.has(String(header?.name || '').toLowerCase())) {
      return { ...header, value: REDACTED_HEADER_VALUE };
    }
    // URL-VALUED headers carry the audited page URL verbatim - Referer above all - so a
    // credential in its query string would survive the name-based pass entirely. This is
    // the same root cause one call site further out; found by the integration test, not
    // by inspection. No name list is needed here: redactUrlCredentialValues only rewrites
    // a value that actually carries a credential-named parameter, so every other value
    // (content types, sizes, plain words) passes through unchanged. Since web-uplift-73y3 it also
    // rewrites a userinfo password, so a Location carrying basic-auth credentials is covered here
    // too - which matters because this is the redirect path the artifact records.
    const value = typeof header?.value === 'string' ? redactUrlCredentialValues(header.value) : header?.value;
    return value === header?.value ? header : { ...header, value };
  });
}
