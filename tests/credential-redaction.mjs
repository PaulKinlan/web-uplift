#!/usr/bin/env node
// ONE credential vocabulary, TWO redactors (web-uplift-glar, web-uplift-lw6).
//
// WHY THIS FILE EXISTS: the HAR credential redactor (evidence/cli.mjs) and the
// flow recorder's navigation sanitiser (runner/flow-record.mjs) each grew their
// own word list for the same concept. By 2026-10-09 they disagreed in both
// directions - cli.mjs persisted ?csrf=, ?pin=, ?cvv= and ?passcode= that flow
// redacted, while flow persisted ?code= and ?key= that cli.mjs redacted - so each
// leaked exactly what the other protected. They now read ONE table
// (evidence/credential-terms.mjs). This suite drives BOTH redactors over one case
// list, so an edit that re-splits the tables fails here rather than in production.
//
// It also pins the two deliberate boundaries: weak words (bare code/key) are
// credentials in a URL but NOT in a form field (a promo/product code is not a
// credential), and PII (email, phone, names) is refused by the flow field
// classifier without widening the credential-scoped HAR redactor.
//
// This file is the fast, browser-free foreground check. Run it directly:
//   node tests/credential-redaction.mjs
// It is also imported by tests/regression.mjs so the full gate covers it.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const REDACTED = /%5Bredacted%5D|\[redacted\]/;

export async function testCredentialRedactorsAgree() {
  const cli = await import('../evidence/cli.mjs');
  const flow = await import('../runner/flow-record.mjs');
  const terms = await import('../evidence/credential-terms.mjs');

  // 1. Every credential-shaped parameter the two review findings named must be
  // redacted by BOTH redactors, and neither may leave the value behind.
  const credentialParams = [
    'csrf=CSRF_SECRET_123', // glar: cli.mjs leaked this
    'pin=1234', // glar
    'cvv=999', // glar
    'passcode=abcd', // glar
    'code=AUTH_CODE_12345', // lw6: flow leaked this
    'key=AIzaSySECRET123', // lw6
    'api_key=AIzaSySECRET123',
    'secret_key=whsec_123',
    'auth_token=tok12345',
    'access_token=tok12345',
    'session=abc123',
    'otp=483920',
    'password=hunter2',
    'jwt=eyJhbGciOiJIUzI1NiJ9',
  ];
  for (const param of credentialParams) {
    const url = `https://example.com/x?${param}`;
    const [key, value] = [param.split('=')[0], param.slice(param.indexOf('=') + 1)];
    const cliOut = cli.redactUrlCredentialValues(url);
    const flowOut = flow.sanitizeNavUrl(url);
    assert(REDACTED.test(cliOut), `cli must redact ?${key}= (got ${cliOut})`);
    assert(REDACTED.test(flowOut), `flow must redact ?${key}= (got ${flowOut})`);
    assert(!cliOut.includes(value), `cli must not leave the value of ?${key}= (got ${cliOut})`);
    assert(!flowOut.includes(value), `flow must not leave the value of ?${key}= (got ${flowOut})`);
    assert(cli.isCredentialName(key) === terms.isCredentialName(key),
      `cli and the shared table must agree on the credential name "${key}"`);
  }

  // 2. Innocent parameters both redactors must PRESERVE byte-for-byte: the whole
  // reason bare code/key are a separate weak class.
  const innocentParams = [
    'postalCode=90210', 'countryCode=GB', 'sortKey=name', 'businessKey=1',
    'q=boots', 'page=2', 'filename=report.csv', 'orderId=1234567890123',
  ];
  for (const param of innocentParams) {
    const url = `https://example.com/x?${param}`;
    assert(cli.redactUrlCredentialValues(url) === url, `cli must preserve ?${param} (not a credential)`);
    assert(flow.sanitizeNavUrl(url) === url, `flow must preserve ?${param} (not a credential)`);
  }

  // 3. The table itself: credential membership, the weak class, and the compound
  // and plural rules the previous two tables had each implemented differently.
  for (const name of ['csrf', 'pin', 'cvv', 'passcode', 'code', 'key', 'apiKey', 'accessToken', 'clientSecret', 'secrets',
    'auth_code', 'verifyCode', 'otpCode', 'deviceCode', 'smsCode']) {
    assert(terms.isCredentialName(name), `"${name}" must be a credential name`);
  }
  for (const name of ['postalCode', 'countryCode', 'sortKey', 'sortKeyName', 'businessKey', 'primaryKey',
    'redirectUriCode', 'promoCode', 'search', 'quantity', 'comment']) {
    assert(!terms.isCredentialName(name), `"${name}" must NOT be a credential name`);
  }
  assert(terms.isCredentialName('code') && !terms.isCredentialName('postalCode'),
    'weak words must match the whole name only');
  assert(terms.isCredentialName('api_key') && terms.isCredentialName('apiKeys'),
    'the compound and plural rules must both hold');
  assert(terms.isCredentialName('verifyCode') && !terms.isCredentialName('promoCode'),
    'a weak word is a credential only with a credential qualifier beside it');

  // 4. The two documented boundaries between the strictnesses.
  assert(!terms.isCredentialName('email') && terms.isSensitiveName('email'),
    'email is PII for the flow classifier, not a credential for the HAR redactor');
  assert(!terms.isSensitiveName('code') && terms.isCredentialName('code'),
    'code is a URL credential but not a field-sensitive name (a promo code is not a credential)');
  for (const name of ['otc', 'otcCode', 'oneTimeNumber', 'otpCode', 'verificationCode', 'mfa']) {
    assert(terms.isSensitiveName(name), `so2: "${name}" must be a field-sensitive one-time-code name`);
  }

  // 5. looksLikeToken is the one place the path/fragment shapes are decided, so its
  // answer is pinned here (flow's own path tests drive it end to end). Both
  // directions matter: a false positive rewrites a real route and breaks replay, a
  // false negative leaves a token in flow.json (web-uplift-hi3 review).
  for (const token of [
    'a8f9c0e2d4b6',
    'ya29.a0AfH6SMBxxxxxxxx',
    'AbCdEf1234567890',
    'sK_9-dF0_xZ2aB123456',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturePart',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0',
  ]) {
    assert(terms.looksLikeToken(token), `"${token}" must be recognised as a token shape`);
  }
  for (const word of [
    'about-us', 'my-first-post', 'settings', 'v2-Release-Notes-2024', 'dashboard', 'abc123', 'tab2', '4f3a9b2c.js',
    // The review's false positives: multi-dot filenames, version strings and long
    // camelCase route words are not tokens.
    'bundle.min.js', 'styles.min.css', 'archive.tar.gz', 'release-1.0.0', 'v1.2.3456789', 'en-US.messages.json',
    'OrderConfirmation123', 'UserProfileStep2Page', 'SummerSalePromo2024',
    // A resource UUID is an identifier, not a credential: redacting it breaks replay.
    '550e8400-e29b-41d4-a716-446655440000',
  ]) {
    assert(!terms.looksLikeToken(word), `"${word}" is a route/filename, not a token, and must not be redacted`);
  }

  // 6. Protocol-relative URLs keep their host (web-uplift-53o1). new URL() cannot parse a
  // protocol-relative string without a base, so this path was reached through the relative-path
  // fallback, which re-emitted only pathname+search+hash: the host silently vanished from the
  // artifact or HAR entry, inventing a URL that was never requested. The credential was redacted
  // either way, which is why it hid for so long - the output looked plausible.
  const SECRET_53O1 = 'NOTAREALKEY_FIXTURE_53O1';
  for (const redactor of [terms.redactUrlCredentialValues, cli.redactUrlCredentialValues]) {
    assert(
      redactor(`//x.test/a?token=${SECRET_53O1}`) === `//x.test/a?token=${'%5Bredacted%5D'}`,
      'a protocol-relative URL must keep its host AND redact its credential parameter',
    );
    assert(
      redactor(`//x.test:8443/a?token=${SECRET_53O1}`) === `//x.test:8443/a?token=${'%5Bredacted%5D'}`,
      'a protocol-relative URL with a port must keep host:port',
    );
    assert(redactor('//x.test/a?page=2') === '//x.test/a?page=2', 'a protocol-relative URL with no credential parameter is untouched');
    assert(redactor(`/a?token=${SECRET_53O1}`) === `/a?token=${'%5Bredacted%5D'}`, 'a rooted relative path is unchanged by this fix');
    assert(redactor('not a url at all ?') === 'not a url at all ?', 'an unparseable string is left alone');
    // Edge cases from a sweep after the first fix (each one measured, not assumed): the parser
    // strips leading whitespace and an HTTP field value may carry it, so the authority test has to
    // allow it; bracketed IPv6 and a fragment must survive; userinfo must be re-emitted in the
    // protocol-relative form as it already is in the absolute form.
    assert(redactor(` //x.test/a?token=${SECRET_53O1}`) === ` //x.test/a?token=${'%5Bredacted%5D'}`, 'leading whitespace must not hide the host');
    assert(redactor(`//[::1]:8443/a?token=${SECRET_53O1}`) === `//[::1]:8443/a?token=${'%5Bredacted%5D'}`, 'a bracketed IPv6 host must survive');
    assert(redactor(`//x.test/a?token=${SECRET_53O1}#frag`) === `//x.test/a?token=${'%5Bredacted%5D'}#frag`, 'a fragment must survive');
    // 53o1's point is that the branch must re-emit the userinfo rather than silently delete part of
    // the URL. It still does: the shape 'userinfo@host' is rebuilt. What CHANGE went into it is the
    // marker for both halves now (web-uplift-73y3 and its review), rather than the credentials.
    assert(redactor(`//user:pass@x.test/a?token=${SECRET_53O1}`) === `//${'%5Bredacted%5D'}:${'%5Bredacted%5D'}@x.test/a?token=${'%5Bredacted%5D'}`, 'userinfo is re-emitted, redacted');
  }

  // 7. A password in URL USERINFO is a credential on a surface this redactor already covers
  // (web-uplift-73y3). The artifacts are the secret-bearing output: evidence/cli.mjs applies this
  // function to redirect Location headers and to HAR entry URLs, so 'https://user:pass@host/' wrote
  // the password into reports/, evidence-out/ and the run log while the query-parameter pass looked
  // clean - the same class the tool already redacts as the Authorization header.
  const SECRET_USERINFO = 'NOTAREALKEY_FIXTURE_73Y3';
  const USERINFO_PASS = 's3cr3t-73y3';
  for (const redactor of [terms.redactUrlCredentialValues, cli.redactUrlCredentialValues]) {
    // The case that must not be missed: NO credential parameter anywhere. A redactor that only
    // rewrites when a query parameter matched would take the "nothing to do" path and leak here.
    const plain = redactor(`https://user:${USERINFO_PASS}@x.test/plain`);
    assert(plain === `https://${'%5Bredacted%5D'}:${'%5Bredacted%5D'}@x.test/plain`,
      `a userinfo password must be redacted even with no credential parameter: ${plain}`);
    assert(!plain.includes(USERINFO_PASS), `the password must be gone from the value: ${plain}`);
    // Both halves at once, and the same through the protocol-relative branch.
    assert(redactor(`https://user:${USERINFO_PASS}@x.test/a?token=${SECRET_USERINFO}`) === `https://${'%5Bredacted%5D'}:${'%5Bredacted%5D'}@x.test/a?token=${'%5Bredacted%5D'}`,
      'userinfo and query credentials are redacted together');
    assert(redactor(`//user:${USERINFO_PASS}@x.test/plain`) === `//${'%5Bredacted%5D'}:${'%5Bredacted%5D'}@x.test/plain`,
      'the protocol-relative branch redacts a userinfo password too');
    // The WHOLE userinfo goes, username included. An earlier version of this fix kept the username
    // unless it looked credential-shaped, and review showed that heuristic leaking real credentials:
    // a token used AS the username is a standard shape ('https://ghp_<PAT>@github.com/'), and the
    // shape tests answer false for every real prefix (below). A heuristic that needs extending per
    // token vendor is a leak per vendor, so the artifact redacts what it cannot vouch for - which is
    // also exactly what the flow recorder's sanitizeNavUrl already did.
    assert(redactor(`https://paul@x.test/a?token=${SECRET_USERINFO}`) === `https://${'%5Bredacted%5D'}@x.test/a?token=${'%5Bredacted%5D'}`,
      'even a plain-looking username is redacted: the artifact cannot vouch for it');
    assert(redactor(`https://token:${USERINFO_PASS}@x.test/plain`) === `https://${'%5Bredacted%5D'}:${'%5Bredacted%5D'}@x.test/plain`,
      'a credential-NAMED username goes with the password: the whole userinfo');
    assert(redactor(`https://9f8b1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f607182:${USERINFO_PASS}@x.test/plain`) === `https://${'%5Bredacted%5D'}:${'%5Bredacted%5D'}@x.test/plain`,
      'a token-SHAPED username goes too');
    // Real token shapes, as the username AND as a username-only userinfo. These are the assertions
    // whose absence let the heuristic ship: the 40-hex case above is a string looksLikeToken was
    // built to accept, so it proved the heuristic worked on itself and nothing else.
    // Vendor prefixes are here to keep the point concrete, NOT to embed live-shaped fixtures: a
    // fabricated 'sk_live_' string made GitHub push protection reject the push for a secret that does
    // not exist, and the fix for that is to use the vendor's TEST-mode prefix rather than to allowlist
    // a fake. Stripe test keys are not secrets; the live-mode prefix is deliberately absent.
    for (const token of [
      'ghp_NOTAREALKEY',  // GitHub PAT shape
      'sk_test_NOTAREALKEY',    // Stripe TEST key shape (never sk_live_ in a fixture)
      'AKIAIOSFODNN7EXAMPLE',                    // AWS's own documented example key id
      'glpat-xxxxxxxxxxxxxxxxxxxx',              // GitLab PAT shape
    ]) {
      assert(!redactor(`https://${token}@x.test/plain`).includes(token),
        `a token used as the username must not reach the artifact: ${redactor(`https://${token}@x.test/plain`)}`);
      assert(!redactor(`https://${token}:x-oauth-basic@x.test/plain`).includes(token),
        `a token used as the username with a password must not reach the artifact: ${redactor(`https://${token}:x-oauth-basic@x.test/plain`)}`);
    }
    // Controls: no userinfo keeps the old behaviour, and an unrelated parameter survives.
    assert(redactor(`https://x.test/a?token=${SECRET_USERINFO}`) === `https://x.test/a?token=${'%5Bredacted%5D'}`, 'control: no userinfo, unchanged');
    assert(redactor(`https://user:${USERINFO_PASS}@x.test/plain?page=2`) === `https://${'%5Bredacted%5D'}:${'%5Bredacted%5D'}@x.test/plain?page=2`,
      'an unrelated query parameter is preserved');
  }
  // The prose path reaches the same redactor through a scanner that skips spans with nothing to
  // redact, so a userinfo-only URL in console text (web-uplift-lsn3's path) must trigger it too.
  const prose = `see https://user:${USERINFO_PASS}@x.test/plain then move on`;
  const redactedProse = terms.redactUrlsInText(prose);
  assert(!redactedProse.includes(USERINFO_PASS), `a userinfo password in prose must be redacted: ${redactedProse}`);
  assert(redactedProse.includes(`https://${'%5Bredacted%5D'}:${'%5Bredacted%5D'}@x.test/plain`), `the rest of the URL must survive: ${redactedProse}`);
  // A URL that the parser REJECTS must not come back verbatim either. Chrome and Node reject
  // 'file://user:pass@/path' outright, and an authority whose ':' is read as an invalid port throws,
  // so both used to return the whole string with the credential intact - the same leak through the
  // other door (web-uplift-73y3 review, P1). Only the userinfo is rewritten, so the rest of the
  // string and the documented leave-an-unparseable-string-alone boundary both survive.
  for (const redactor of [terms.redactUrlCredentialValues, cli.redactUrlCredentialValues]) {
    assert(!redactor(`file://user:${USERINFO_PASS}@/path`).includes(USERINFO_PASS),
      `file: userinfo must not survive an unparseable string: ${redactor(`file://user:${USERINFO_PASS}@/path`)}`);
    assert(!redactor(`https://AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7@x.test/`).includes('AKIA'),
      'an authority the parser reads as an invalid port must not leak its credential');
    assert(redactor('not a url at all ?') === 'not a url at all ?',
      'an unparseable string with no userinfo is still left exactly alone');
    assert(redactor('see //cdn.test/lib.js and email a@b.test') === 'see //cdn.test/lib.js and email a@b.test',
      'prose that merely contains // and @ is not rewritten');
  }
  // The call site that makes this a P2 rather than a nit: the redirect Location header, driven
  // through the artifact helper itself and not only through the unit.
  const headered = cli.redactHeaderList([{ name: 'location', value: `https://user:${USERINFO_PASS}@x.test/next?token=${SECRET_USERINFO}` }]);
  assert(!JSON.stringify(headered).includes(USERINFO_PASS),
    `a redirect Location must not carry the userinfo password into the artifact: ${JSON.stringify(headered)}`);

  // 8. A protocol-relative URL with a PASSWORD and no username keeps its '@' (web-uplift-5m9f). The
  // relative branch re-emitted '@' only when there was a username, so '//:s3cr3t@x.test/plain' came
  // back as '//:%5Bredacted%5Dx.test/plain' - the redacted userinfo ran into the host and the
  // authority was mangled. Found while fixing 73y3; the absolute branch never had it, because
  // URL.toString() serialises userinfo itself.
  for (const redactor of [terms.redactUrlCredentialValues, cli.redactUrlCredentialValues]) {
    assert(redactor(`//:${USERINFO_PASS}@x.test/plain`) === `//:${'%5Bredacted%5D'}@x.test/plain`,
      'a password-only userinfo must keep its @ and its host');
    assert(redactor(`//:${USERINFO_PASS}@x.test/a?token=${SECRET_USERINFO}`) === `//:${'%5Bredacted%5D'}@x.test/a?token=${'%5Bredacted%5D'}`,
      'password-only userinfo with a query credential keeps both');
    assert(redactor(`https://:${USERINFO_PASS}@x.test/plain`) === `https://:${'%5Bredacted%5D'}@x.test/plain`,
      'the absolute branch agrees, as it always did');
    assert(redactor('//x.test/plain') === '//x.test/plain', 'control: no userinfo is unchanged');
  }

  // 9. The last-resort sweep, for a string the URL parser REFUSED (web-uplift-73y3 review). Three
  // separate defects lived in the single line it replaced, and each one gets its own assertion
  // because each was invisible to the others:
  //   - the regex restarted its forward scan at every '//', so it was QUADRATIC in a run of
  //     characters with no '@' (213 ms at 10 kB, 2.8 s at 40 kB). The input is the audited site's
  //     and the path is every response header value and every console line, so that was a hang a
  //     page could aim at the tool;
  //   - it stopped at the FIRST '@', but a URL parser ends the userinfo at the LAST one, so
  //     'file://user:p@ss@/path' kept 'ss' of the password in the artifact;
  //   - it rebuilt the userinfo as a single marker, so an EMPTY username gained a fabricated one,
  //     against the shape rule 5m9f established for the parseable path.
  for (const redactor of [terms.redactUrlCredentialValues, cli.redactUrlCredentialValues]) {
    assert(redactor(`file://user:${USERINFO_PASS}@/path`) === 'file://[redacted]:[redacted]@/path',
      `an unparseable URL redacts both halves in place: ${redactor(`file://user:${USERINFO_PASS}@/path`)}`);
    assert(redactor(`file://user:p@${USERINFO_PASS}@/path`) === 'file://[redacted]:[redacted]@/path',
      `a raw @ inside the password must not leave its tail: ${redactor(`file://user:p@${USERINFO_PASS}@/path`)}`);
    assert(!redactor(`file://user:p@${USERINFO_PASS}@/path`).includes(USERINFO_PASS),
      'no part of that password survives');
    assert(redactor(`file://:${USERINFO_PASS}@/p`) === 'file://:[redacted]@/p',
      `an empty username must not gain a fabricated marker: ${redactor(`file://:${USERINFO_PASS}@/p`)}`);
    assert(redactor('file://@/p') === 'file://@/p', 'control: an empty userinfo has nothing to redact');
    assert(!redactor('https://AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7@x.test/').includes('wJalrXUtnFEMI'),
      'the invalid-port shape must lose the secret itself, not only the key id');
    assert(redactor('\\\\user:pw@x.test/a').includes('x.test'),
      'a backslash authority keeps its host instead of being reduced to a path');
    // An UNPARSEABLE backslash authority, which the assertion above did not cover because that string
    // parses and never reaches the sweep. Which assertion catches what, stated honestly: THIS one
    // passes even with the defective single-backslash search, because the match then lands at index 0
    // and the run still starts at the username. The one-backslash assertion below is the one that pins
    // that defect (it produced 'https:\a[redacted]@...'), and this one pins the two-character
    // delimiter itself. Four backslashes in the source, i.e. two in the string, is what is correct.
    const TWO_BACKSLASHES = '\\\\';
    assert(
      redactor(`${TWO_BACKSLASHES}user:${USERINFO_PASS}@x.test:99999/a`) ===
        `${TWO_BACKSLASHES}[redacted]:[redacted]@x.test:99999/a`,
      `an unparseable backslash authority must redact both halves without eating the first character: ${redactor(`${TWO_BACKSLASHES}user:${USERINFO_PASS}@x.test:99999/a`)}`,
    );
    // Special-scheme anchor forms resolved in web-uplift-k99c: zero or one slash-or-backslash
    // after the scheme colon ('https:', 'https:/', 'https:\') are recognised as authority starts for
    // the special schemes (https?, ftp, wss?), while a lone backslash in ordinary prose or an
    // opaque-path non-special scheme (mailto:) is left untouched. file: requires two slashes (file://).
    assert(
      redactor('https:\\admin@x.test:99999/p') === 'https:\\[redacted]@x.test:99999/p',
      `one backslash in a special scheme must redact: ${redactor('https:\\admin@x.test:99999/p')}`,
    );
    assert(
      redactor(`https:user:${USERINFO_PASS}@x.test:99999/a`) === `https:[redacted]:[redacted]@x.test:99999/a`,
      `zero slashes in a special scheme must redact: ${redactor(`https:user:${USERINFO_PASS}@x.test:99999/a`)}`,
    );
    assert(
      redactor(`https:/user:${USERINFO_PASS}@x.test:99999/a`) === `https:/[redacted]:[redacted]@x.test:99999/a`,
      `one slash in a special scheme must redact: ${redactor(`https:/user:${USERINFO_PASS}@x.test:99999/a`)}`,
    );
    assert(
      redactor(`https:\\user:${USERINFO_PASS}@x.test:99999/a`) === `https:\\[redacted]:[redacted]@x.test:99999/a`,
      `one backslash with password in a special scheme must redact: ${redactor(`https:\\user:${USERINFO_PASS}@x.test:99999/a`)}`,
    );
    assert(
      redactor(`http:user:${USERINFO_PASS}@x.test:99999/a`) === `http:[redacted]:[redacted]@x.test:99999/a`,
      `http with zero slashes must redact: ${redactor(`http:user:${USERINFO_PASS}@x.test:99999/a`)}`,
    );
    assert(
      redactor(`ftp:user:${USERINFO_PASS}@x.test:99999/a`) === `ftp:[redacted]:[redacted]@x.test:99999/a`,
      `ftp with zero slashes must redact: ${redactor(`ftp:user:${USERINFO_PASS}@x.test:99999/a`)}`,
    );
    assert(
      redactor(`ws:user:${USERINFO_PASS}@x.test:99999/a`) === `ws:[redacted]:[redacted]@x.test:99999/a`,
      `ws with zero slashes must redact: ${redactor(`ws:user:${USERINFO_PASS}@x.test:99999/a`)}`,
    );
    assert(
      redactor(`wss:user:${USERINFO_PASS}@x.test:99999/a`) === `wss:[redacted]:[redacted]@x.test:99999/a`,
      `wss with zero slashes must redact: ${redactor(`wss:user:${USERINFO_PASS}@x.test:99999/a`)}`,
    );
    // Unparseable URLs with credential query parameters must also redact query values without leaking secrets:
    assert(
      !redactor(`http:/x.test:99999/a?token=${USERINFO_PASS}`).includes(USERINFO_PASS),
      `unparseable http: URL must redact query parameter token: ${redactor(`http:/x.test:99999/a?token=${USERINFO_PASS}`)}`,
    );
    assert(
      !redactor(`https:/x.test:99999/a?token=${USERINFO_PASS}`).includes(USERINFO_PASS),
      `unparseable https: URL must redact query parameter token: ${redactor(`https:/x.test:99999/a?token=${USERINFO_PASS}`)}`,
    );
    assert(
      !redactor(`https://x.test:99999/a?token=${USERINFO_PASS}`).includes(USERINFO_PASS),
      `unparseable https:// URL must redact query parameter token: ${redactor(`https://x.test:99999/a?token=${USERINFO_PASS}`)}`,
    );
    assert(
      redactor(`http:user:${USERINFO_PASS}@x.test:99999/a?token=${USERINFO_PASS}`) ===
        `http:[redacted]:[redacted]@x.test:99999/a?token=%5Bredacted%5D`,
      `both userinfo and query parameters must be redacted in unparseable URLs: ${redactor(`http:user:${USERINFO_PASS}@x.test:99999/a?token=${USERINFO_PASS}`)}`,
    );
    // Negative controls: non-special schemes and ordinary prose with lone backslashes stay untouched.
    assert(
      redactor(`mailto:user:${USERINFO_PASS}@x.test`) === `mailto:user:${USERINFO_PASS}@x.test`,
      'mailto is not a special scheme and must stay untouched',
    );
    assert(
      redactor('a path with a \\ in it') === 'a path with a \\ in it',
      'ordinary prose with a lone backslash must stay untouched',
    );
    assert(
      redactor('https:x.test:99999/path') === 'https:x.test:99999/path',
      'special scheme with zero slashes but no userinfo must stay untouched',
    );
    // Tab, LF and CR are NOT run breaks. The URL parser strips them anywhere in the input, so an
    // authority continues across them; treating them as breaks left the tail of the credential in the
    // output, which review measured as reachable through redactHeaderList because an internal tab is
    // legal in an HTTP field value. Over-redacting across one is the safe side of that trade.
    assert(!redactor(`https://us\ter:${USERINFO_PASS}@x.test:99999/a`).includes(USERINFO_PASS),
      `a tab inside the userinfo must not split the run: ${redactor(`https://us\ter:${USERINFO_PASS}@x.test:99999/a`)}`);
    assert(!redactor(`https://user:\t${USERINFO_PASS}@x.test:99999/a`).includes(USERINFO_PASS),
      `a tab before the password must not split the run: ${redactor(`https://user:\t${USERINFO_PASS}@x.test:99999/a`)}`);
    assert(!redactor(`https://user:${USERINFO_PASS}@x.test:99999/a\nmore`).includes(USERINFO_PASS),
      `a newline after the URL must not leave the credential behind: ${redactor(`https://user:${USERINFO_PASS}@x.test:99999/a\nmore`)}`);
    assert(redactor('see https://x.test:99999/a\tb') === 'see https://x.test:99999/a\tb',
      'control: a tab in an unparseable string with no credential changes nothing');
    // MIXED SPELLINGS, the regression a later review found in this fix. A URL parser for the special
    // schemes reads ANY pair from the slash-or-backslash class as the start of an authority, so these
    // are authorities, they fail on the port, and they reach this sweep. An intermediate version
    // searched for '//' and for two backslashes SEPARATELY, so the mixed pairs matched neither and came
    // back VERBATIM with the password - worse than the version before it, which redacted them by
    // accident. One search over the whole class closed it, and these assertions hold it closed.
    assert(
      redactor(`https:\\/user:${USERINFO_PASS}@x.test:99999/a`) === `https:\\/[redacted]:[redacted]@x.test:99999/a`,
      `a backslash-then-slash authority must redact, not leak: ${redactor(`https:\\/user:${USERINFO_PASS}@x.test:99999/a`)}`,
    );
    assert(
      redactor(`https:/\\user:${USERINFO_PASS}@x.test:99999/a`) === `https:/\\[redacted]:[redacted]@x.test:99999/a`,
      `a slash-then-backslash authority must redact, not leak: ${redactor(`https:/\\user:${USERINFO_PASS}@x.test:99999/a`)}`,
    );
    assert(
      redactor(`\\/user:${USERINFO_PASS}@x.test:99999/a`) === `\\/[redacted]:[redacted]@x.test:99999/a`,
      `the protocol-relative mixed pair redacts too: ${redactor(`\\/user:${USERINFO_PASS}@x.test:99999/a`)}`,
    );
    // The anti-regression for the quadratic defect, and it measures SCALING rather than a wall
    // clock. An absolute bound was tried first and was a placebo: a shape-identical quadratic still
    // passed it, because V8 vectorises the character search and 8e8 byte-scans finish inside a
    // second. Four times the input must not cost more than eight times the work - linear lands near
    // 4, a quadratic near 16 and up - and a ratio needs no knowledge of how loaded this VM is,
    // which an absolute millisecond bound did.
    // The MINIMUM of three runs, not one: a single short run lands in the timer's resolution and
    // its noise is what made this assertion flake, and the minimum is the statistic that a busy VM
    // disturbs least.
    const measure = (length) => {
      const input = `https://x.test:99999${'/'.repeat(length)}`;
      let best = Infinity;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = Date.now();
        redactor(input);
        const elapsed = Date.now() - started;
        best = Math.min(best, elapsed);
        // Stop repeating once ONE pass is already far past any linear expectation. The repeats exist to
        // defeat timer noise on a fast run, not to spend three times the cost of a hang - without this a
        // quadratic regression delays its own failure by a factor of three before the backstop fires.
        if (elapsed > 5000) break;
      }
      return best;
    };
    const small = measure(40000);
    const large = measure(160000);
    const ratio = large / Math.max(small, 2);
    assert(ratio < 8,
      `the sweep must scale linearly: 4x the input took ${ratio.toFixed(1)}x the time (40 kB ${small}ms, 160 kB ${large}ms)`);
    // A backstop against a hang, set far above the measured 12 ms so it cannot flake.
    assert(large < 5000, `the sweep must not hang: 160 kB took ${large}ms`);
    // The fixture above is a single run with ONE authority start, so the loop executes once and it
    // cannot see a quadratic that comes from re-searching for the spelling that does NOT occur. This
    // fixture repeats the start instead, and what it catches is a PER-SPELLING search that re-runs each
    // pass while its spelling is absent: this fixture never contains a mixed pair, so a four-spelling
    // version scans to the end twice per pass and took about 36 s at the small size alone.
    //
    // It does NOT catch the original two-spelling defect, and review measured that plainly: with both
    // spellings alternating close together, re-searching either one stays cheap (2.3x, which passes).
    // That defect is pinned by the mixed-spelling CORRECTNESS assertions above instead, because a search
    // for two fixed spellings structurally cannot redact a mixed pair. Both fixtures are kept because
    // each is blind to the other's failure.
    const measureStarts = (length) => {
      // BOTH spellings alternating, which is the shape whose re-searching a multi-spelling version
      // cannot keep cheap. The repeat unit is 6 characters, so the divisor must be 6: with 5 the sizes
      // silently became 192 kB and 768 kB instead of the 160 kB and 640 kB named in the messages.
      const input = '// \\\\ '.repeat(Math.floor(length / 6));
      let best = Infinity;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = Date.now();
        redactor(input);
        const elapsed = Date.now() - started;
        best = Math.min(best, elapsed);
        if (elapsed > 5000) break;
      }
      return best;
    };
    const manySmall = measureStarts(160000);
    // Stop BEFORE the large measurement when the small one already shows a hang. A truly quadratic
    // version costs tens of seconds here, and without this the fixed 4x run would then cost minutes;
    // the bound sits far above the measured tens of milliseconds, so it cannot flake.
    assert(manySmall < 5000,
      `the sweep must not hang with many authority starts: 160 kB took ${manySmall}ms`);
    const manyLarge = measureStarts(640000);
    const manyRatio = manyLarge / Math.max(manySmall, 2);
    assert(manyRatio < 8,
      `the sweep must stay linear with MANY authority starts, not just one: 4x the input took ${manyRatio.toFixed(1)}x (160 kB ${manySmall}ms, 640 kB ${manyLarge}ms)`);
  }
  // 10. Two blind spots in the VALUE-level rule, both of which the proxy env sanitiser inherits
  // rather than re-implements (web-uplift-nxsy). Measured on the committed tree before the fix: each
  // value came back VERBATIM, so the sanitiser handed the child the operator's secret text and the
  // artifact redactor left the same text in reports and logs.
  for (const redactor of [terms.redactUrlCredentialValues, cli.redactUrlCredentialValues]) {
    // (a) A userinfo password containing a raw '#' or '?'. The sweep's run used to END at those
    // characters, so with the '@' on the far side the run held no '@' at all and nothing was
    // classified. The URL parser refuses both values, so the sweep is the only thing that can clean
    // them - there is no parseable form to fall back on.
    for (const delim of ['#', '?']) {
      const v = `https://user:${USERINFO_PASS}${delim}x@x.test:99999/p`;
      assert(!redactor(v).includes(USERINFO_PASS),
        `a userinfo password truncated by ${delim} must not survive: ${redactor(v)}`);
    }
    // (b) A credential-named parameter in the FRAGMENT. Only searchParams was examined, so
    // '?token=..' was redacted while '#token=..' was passed through.
    const frag = redactor(`https://x.test/p#token=${SECRET_USERINFO}`);
    assert(!frag.includes(SECRET_USERINFO), `a credential-named FRAGMENT parameter must be redacted: ${frag}`);
    assert(frag.includes('token='), `and the parameter NAME must survive: ${frag}`);
    // The SAME shape on the UNPARSEABLE path, which has its own splice rather than the parse path: an
    // out-of-range port makes the parser refuse the value, so this exercises the fallback, and the
    // fallback used to put the fragment tail back untouched even when the query splice had run.
    const fragUnparseable = redactor(`https://x.test:99999/p#token=${SECRET_USERINFO}`);
    assert(!fragUnparseable.includes(SECRET_USERINFO),
      `a fragment credential must be redacted on the UNPARSEABLE path too: ${fragUnparseable}`);
    // (c) The boundary that makes (b) safe: a fragment is not always a parameter string.
    assert(redactor('https://x.test/p#section-2') === 'https://x.test/p#section-2',
      'an ordinary fragment anchor must survive untouched, or every deep link in an artifact is rewritten');
    assert(redactor('https://x.test/p#a=b&c=d') === 'https://x.test/p#a=b&c=d',
      'fragment parameters with no credential name must survive byte-for-byte');
    // (d) 'pass' as a WEAK word: the filed spelling is caught, and the words it would otherwise drag
    // in are pinned as ordinary so the boundary cannot drift by accident.
    assert(!redactor(`https://x.test/p?pass=${SECRET_USERINFO}`).includes(SECRET_USERINFO), '?pass= is a credential name');
    assert(!redactor(`https://x.test/p#pass=${SECRET_USERINFO}`).includes(SECRET_USERINFO), 'so is a FRAGMENT #pass=');
    for (const ordinary of ['passenger=1', 'bypass=1', 'compass=1', 'passphrase=1', 'passkey=1', 'pass_count=2']) {
      assert(redactor(`https://x.test/p?${ordinary}`) === `https://x.test/p?${ordinary}`,
        `?${ordinary} is an ordinary name and must keep its value`);
    }
  }
  // (e) The ACCEPTED COST of removing '?' and '#' from the sweep's run breaks, pinned so it stays a
  // decision rather than becoming an accident later: on a value the parser REJECTS, an '@' inside the
  // query is now read as userinfo and the authority is redacted. The alternative - leaving such a run
  // unclassified - is exactly the leak shape in (a). This is the same over-redaction this file already
  // accepts for a path on an unparseable value, and it only ever applies to a string no client can use.
  const unparseableQueryAt = 'https://x.test:99999/?email=me@example.com';
  assert(terms.redactUrlCredentialValues(unparseableQueryAt) !== unparseableQueryAt,
    'the declared cost of the wider run must be visible: an @ in the query of an UNPARSEABLE value is read as userinfo');
  assert(!terms.redactUrlCredentialValues(unparseableQueryAt).includes('me@example.com'),
    'and the over-redaction must actually remove the text, not merely rewrite around it');
}

// Run directly (node tests/credential-redaction.mjs), not when imported by the
// regression suite, which calls the exported function itself.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await testCredentialRedactorsAgree();
  console.log('tests OK');
}
