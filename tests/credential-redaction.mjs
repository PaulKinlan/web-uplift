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
  // answer is pinned here (flow's own path tests drive it end to end).
  for (const token of ['a8f9c0e2d4b6', 'ya29.a0AfH6SMBxxxxxxxx', 'AbCdEf1234567890', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturePart']) {
    assert(terms.looksLikeToken(token), `"${token}" must be recognised as a token shape`);
  }
  for (const word of ['about-us', 'my-first-post', 'settings', 'v2-Release-Notes-2024', 'dashboard', 'abc123', 'tab2', '4f3a9b2c.js']) {
    assert(!terms.looksLikeToken(word), `"${word}" is a route/filename, not a token, and must not be redacted`);
  }
}

// Run directly (node tests/credential-redaction.mjs), not when imported by the
// regression suite, which calls the exported function itself.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await testCredentialRedactorsAgree();
  console.log('tests OK');
}
