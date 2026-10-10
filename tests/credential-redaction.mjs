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
    // web-uplift-73y3 changed what the re-emitted userinfo CONTAINS: the username is still there
    // (53o1's point - the branch must not silently delete part of the URL), and the password is now
    // the marker instead of the value that was passed in.
    assert(redactor(`//user:pass@x.test/a?token=${SECRET_53O1}`) === `//user:${'%5Bredacted%5D'}@x.test/a?token=${'%5Bredacted%5D'}`, 'userinfo is re-emitted with its password redacted');
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
    assert(plain === `https://user:${'%5Bredacted%5D'}@x.test/plain`,
      `a userinfo password must be redacted even with no credential parameter: ${plain}`);
    assert(!plain.includes(USERINFO_PASS), `the password must be gone from the value: ${plain}`);
    // Both halves at once, and the same through the protocol-relative branch.
    assert(redactor(`https://user:${USERINFO_PASS}@x.test/a?token=${SECRET_USERINFO}`) === `https://user:${'%5Bredacted%5D'}@x.test/a?token=${'%5Bredacted%5D'}`,
      'userinfo and query credentials are redacted together');
    assert(redactor(`//user:${USERINFO_PASS}@x.test/plain`) === `//user:${'%5Bredacted%5D'}@x.test/plain`,
      'the protocol-relative branch redacts a userinfo password too');
    // A username is an identifier the artifact needs, and is kept unless it is credential-shaped.
    assert(redactor(`https://paul@x.test/a?token=${SECRET_USERINFO}`) === `https://paul@x.test/a?token=${'%5Bredacted%5D'}`,
      'a plain username is kept');
    assert(redactor(`https://token:${USERINFO_PASS}@x.test/plain`) === `https://${'%5Bredacted%5D'}:${'%5Bredacted%5D'}@x.test/plain`,
      'a credential-NAMED username goes with the password: the whole userinfo');
    assert(redactor(`https://9f8b1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f607182:${USERINFO_PASS}@x.test/plain`) === `https://${'%5Bredacted%5D'}:${'%5Bredacted%5D'}@x.test/plain`,
      'a token-SHAPED username goes too');
    // Controls: no userinfo keeps the old behaviour, and an unrelated parameter survives.
    assert(redactor(`https://x.test/a?token=${SECRET_USERINFO}`) === `https://x.test/a?token=${'%5Bredacted%5D'}`, 'control: no userinfo, unchanged');
    assert(redactor(`https://user:${USERINFO_PASS}@x.test/plain?page=2`) === `https://user:${'%5Bredacted%5D'}@x.test/plain?page=2`,
      'an unrelated query parameter is preserved');
  }
  // The prose path reaches the same redactor through a scanner that skips spans with nothing to
  // redact, so a userinfo-only URL in console text (web-uplift-lsn3's path) must trigger it too.
  const prose = `see https://user:${USERINFO_PASS}@x.test/plain then move on`;
  const redactedProse = terms.redactUrlsInText(prose);
  assert(!redactedProse.includes(USERINFO_PASS), `a userinfo password in prose must be redacted: ${redactedProse}`);
  assert(redactedProse.includes(`https://user:${'%5Bredacted%5D'}@x.test/plain`), `the rest of the URL must survive: ${redactedProse}`);
  // The call site that makes this a P2 rather than a nit: the redirect Location header, driven
  // through the artifact helper itself and not only through the unit.
  const headered = cli.redactHeaderList([{ name: 'location', value: `https://user:${USERINFO_PASS}@x.test/next?token=${SECRET_USERINFO}` }]);
  assert(!JSON.stringify(headered).includes(USERINFO_PASS),
    `a redirect Location must not carry the userinfo password into the artifact: ${JSON.stringify(headered)}`);
}

// Run directly (node tests/credential-redaction.mjs), not when imported by the
// regression suite, which calls the exported function itself.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await testCredentialRedactorsAgree();
  console.log('tests OK');
}
