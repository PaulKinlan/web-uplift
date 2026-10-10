#!/usr/bin/env node
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assert,
  run,
  runAsync,
  repoRoot,
  tmp,
  runSuite,
  readJson,
  validateJson,
  listFiles,
  assertProbeFileInert,
  assertUnknownRawSurface,
  cleanStaleNpxRegressionTrees,
  packTarball,
  noUpdateEnv,
  SKIP_DIRS,
} from './test-helpers.mjs';
import {
  gather,
  redactHeaderList,
  scanTextForSecrets,
  readSourceTree,
} from '../evidence/cli.mjs';
import { testLogUrlRedaction } from './log-redaction.mjs';
import { testCredentialRedactorsAgree } from './credential-redaction.mjs';
import { testSecretsCoverageClassification } from './secrets-coverage.mjs';

export function testRedactHeaderList() {
  const list = [
    { name: 'Set-Cookie', value: 'a=1' },
    { name: 'cookie', value: 'b=2' },
    { name: 'Authorization', value: 'Bearer x' },
    { name: 'proxy-authorization', value: 'Basic y' },
    { name: 'X-Auth-Token', value: 't' },
    { name: 'x-api-key', value: 'k' },
    { name: 'X-Amz-Security-Token', value: 's' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'ETag', value: 'W/"abc"' },
  ];
  const redacted = redactHeaderList(list);
  assert(redacted.length === list.length, 'the redaction must not drop headers');
  for (let i = 0; i < 7; i++) {
    assert(redacted[i].value === '[redacted]', `${list[i].name} must be redacted by value: ${JSON.stringify(redacted[i])}`);
    assert(redacted[i].name === list[i].name, `the header name must be preserved: ${JSON.stringify(redacted[i])}`);
  }
  assert(
    redacted[7].value === 'application/json' && redacted[8].value === 'W/"abc"',
    `non-secret headers must be untouched: ${JSON.stringify(redacted.slice(7))}`,
  );
}


// web-uplift-dsj: the credential redaction landed for HEADER VALUES only, and the rest of
// the artifact was still verbatim. These are the per-vector tests: for each vector, the
// credential value must be ABSENT and a non-credential value in the SAME field must
// SURVIVE, so the redaction cannot pass by being over-broad.
export async function testCredentialRedactionHelpers() {
  const { redactUrlCredentialValues, redactQueryList, redactBodyText, isCredentialName, redactHeaderList } =
    await import('../evidence/cli.mjs');
  const SECRET = 'SECRET-CANARY-123';

  // 1. The request URL and its query string: credential-named parameters are redacted,
  //    the names and every other parameter are untouched.
  const url = redactUrlCredentialValues(`https://x.test/page?token=${SECRET}&page=2`);
  assert(!url.includes(SECRET), `redaction: the token value must be gone from the URL (${url})`);
  assert(url.includes('token=') && url.includes('page=2'), `redaction: the parameter NAME and a non-credential parameter must survive (${url})`);

  // 2. The HAR entry's parsed queryString list.
  const qs = redactQueryList([{ name: 'api_key', value: SECRET }, { name: 'page', value: '2' }]);
  assert(qs[0].value === '[redacted]' && qs[0].name === 'api_key', `redaction: query list credential value (${JSON.stringify(qs[0])})`);
  assert(qs[1].value === '2', `redaction: query list non-credential value must survive (${JSON.stringify(qs[1])})`);

  // 6. CAMEL-CASE AND OTHER PLAUSIBLE SPELLINGS. A separator-anchored matcher missed these
  //    entirely, which the review found by asking what a credential parameter plausibly
  //    looks like rather than by testing only the spellings we had thought of.
  for (const name of ['accessToken', 'refreshToken', 'apiKey', 'clientSecret', 'userIdToken', 'x-api-key']) {
    assert(isCredentialName(name), `redaction: '${name}' must be recognised as credential-shaped`);
    const u2 = redactUrlCredentialValues(`https://x.test/cb?${name}=${SECRET}&page=2`);
    assert(!u2.includes(SECRET) && u2.includes('page=2'), `redaction: camel/separator spelling in a URL (${name}: ${u2})`);
  }
  for (const name of ['country', 'page', 'monkey']) {
    assert(!isCredentialName(name), `redaction: '${name}' must NOT be treated as a credential (over-redaction costs evidence)`);
  }
  // WEAK WORDS (web-uplift-glar/lw6): a bare code/key IS a credential, while a name
  // that merely CONTAINS the word is not. An earlier revision over-redacted every
  // name with 'key' in it, which is exactly what breaks postalCode/sortKey in a
  // recorded journey, so the narrow rule is asserted in BOTH directions: a
  // qualifier compound (auth_code, api_key, verifyCode, otpCode) stays a
  // credential, and sortKeyName/redirectUriCode/primaryKey keep their values.
  // tests/credential-redaction.mjs pins the same boundary for the flow redactor.
  for (const credential of ['code', 'key', 'auth_code', 'api_key', 'verifyCode', 'otpCode']) {
    assert(isCredentialName(credential), `redaction: '${credential}' must be credential-shaped`);
  }
  for (const innocent of ['sortKeyName', 'redirectUriCode', 'primaryKey', 'postalCode', 'countryCode', 'sortKey']) {
    assert(
      !isCredentialName(innocent),
      `redaction: '${innocent}' must NOT be redacted (a weak word matches the whole name or a qualifier compound only)`,
    );
  }

  // 3. Request bodies, form-encoded and JSON.
  const form = redactBodyText(`user=bob&password=${SECRET}&remember=1`);
  assert(!form.includes(SECRET) && form.includes('user=bob') && form.includes('remember=1'), `redaction: form body (${form})`);
  const json = redactBodyText(`{"api_key":"${SECRET}","page":2}`);
  assert(!json.includes(SECRET) && json.includes('"page":2'), `redaction: json body (${json})`);
  // An ESCAPED QUOTE inside the value used to end the match at the backslash, leaving the
  // rest of the credential in the recorded body. The whole string value must be replaced.
  const escaped = redactBodyText(`{"password":"head\\"${SECRET}tail","page":2}`);
  assert(!escaped.includes(SECRET), `redaction: a value containing an escaped quote must be redacted WHOLE (${escaped})`);
  assert(escaped.includes('"page":2'), `redaction: the field after an escaped-quote value must survive (${escaped})`);

  // 4. The redirect target: a Location can carry a credential in its query string.
  const loc = redactUrlCredentialValues(`/final?session=${SECRET}&ref=home`);
  assert(!loc.includes(SECRET) && loc.includes('ref=home'), `redaction: redirect target, RELATIVE form (${loc})`);
  const locAbs = redactUrlCredentialValues(`https://x.test/final?session=${SECRET}&ref=home`);
  assert(!locAbs.includes(SECRET) && locAbs.includes('ref=home'), `redaction: redirect target, ABSOLUTE form (${locAbs})`);

  // 5. Response body text when bodies are recorded.
  const resp = redactBodyText(`{"refresh_token":"${SECRET}","ok":true}`);
  assert(!resp.includes(SECRET) && resp.includes('"ok":true'), `redaction: response body text (${resp})`);

  // The header redaction is NOT regressed by any of this.
  const header = redactHeaderList([{ name: 'Set-Cookie', value: SECRET }, { name: 'Content-Type', value: 'text/html' }]);
  assert(header[0].value === '[redacted]' && header[1].value === 'text/html', `redaction: headers must still behave (${JSON.stringify(header)})`);

  // STRUCTURED JSON IS REDACTED BY DECODED KEY, BY CONSTRUCTION. Each of these leaked on the
  // previous revision: an ARRAY value (the scanner stopped at the bracket), a UNICODE-ESCAPED
  // key (the pattern could not see the decoded name), and a JS LINE CONTINUATION inside a
  // quoted value (the escape class did not consume a backslash-newline).
  const arr = redactBodyText(`{"token":["${SECRET}","other"]}`);
  assert(!arr.includes(SECRET), `redaction: a credential field holding an ARRAY must be redacted whole (${arr})`);
  assert(!arr.includes('other'), `redaction: the whole array goes with the field, so no element survives (${arr})`);
  const uni = redactBodyText(`{"tok\\u0065n":"${SECRET}","page":2}`);
  assert(!uni.includes(SECRET), `redaction: a UNICODE-ESCAPED credential key must be decoded and matched (${uni})`);
  assert(uni.includes('"page":2'), `redaction: a non-credential field beside it must survive (${uni})`);
  const cont = redactBodyText("var x = { password: 'head\\\n" + SECRET + "tail', page: 2 };");
  assert(!cont.includes(SECRET), `redaction: a JS LINE CONTINUATION inside the value must not end the match (${cont})`);

  // 7. TYPESCRIPT TYPE ANNOTATIONS (web-uplift-xwr). In `const apiKey: string = "secret"`
  //    the ':' after the key binds to the TYPE, not the value. The generic colon rule
  //    redacted the type token and left the secret in the artifact:
  //    'const apiKey: "[redacted]" = "secret123"'. .ts/.tsx trees are exactly what
  //    `dom --source` walks, so this was a live bypass, not a curiosity.
  const tsDecl = redactBodyText(`const apiKey: string = "${SECRET}";\nconst region: string = 'eu-west-1';`);
  assert(!tsDecl.includes(SECRET), `redaction: a TS annotation must not swallow the redaction - the value AFTER '=' is the secret (${tsDecl})`);
  assert(tsDecl.includes('string'), `redaction: the TYPE name is not a credential value and must survive (${tsDecl})`);
  assert(tsDecl.includes('eu-west-1'), `redaction: a non-credential annotated declaration must survive (${tsDecl})`);
  const tsNoSpace = redactBodyText(`let token:string='${SECRET}';`);
  assert(!tsNoSpace.includes(SECRET), `redaction: an annotation without spaces (${tsNoSpace})`);
  const tsUnion = redactBodyText(`const clientSecret: string | null = "${SECRET}";`);
  assert(!tsUnion.includes(SECRET), `redaction: a union-typed annotation (${tsUnion})`);
  assert(tsUnion.includes('string | null'), `redaction: a union type must survive byte-identical (${tsUnion})`);
  // The review's probes, pinned: container generics, nested spaced unions, the optional
  // marker, and a QUOTED key with an annotation. Each of these survived the first
  // revision of the fix (type token redacted, secret left) — they are fixtures now.
  const tsContainer = redactBodyText(`const apiKey: Record<string, string> = "${SECRET}";`);
  assert(!tsContainer.includes(SECRET), `redaction: a container-generic annotation must not leak the value (${tsContainer})`);
  assert(tsContainer.includes('Record<string, string>'), `redaction: the container type must survive byte-identical (${tsContainer})`);
  const tsNestedUnion = redactBodyText(`const apiKey: Map<string, string | null> = "${SECRET}";`);
  assert(!tsNestedUnion.includes(SECRET) && tsNestedUnion.includes('Map<string, string | null>'),
    `redaction: a spaced union inside a container type (${tsNestedUnion})`);
  const tsOptional = redactBodyText(`const apiKey?: string = "${SECRET}";`);
  assert(!tsOptional.includes(SECRET), `redaction: an optional-marker annotation (${tsOptional})`);
  const tsQuotedKey = redactBodyText(`"apiKey": string = "${SECRET}"`);
  assert(!tsQuotedKey.includes(SECRET), `redaction: a quoted key with an annotation (${tsQuotedKey})`);
  assert(tsQuotedKey.includes('string'), `redaction: the quoted-key annotation's type must survive (${tsQuotedKey})`);

  // 9. COMPARISON SHAPES MUST NOT ABORT THE EQUALS FORM (review P0). The first revision
  //    guarded the generic rule with (?!\s*=), which skipped redaction whenever ANY '='
  //    followed — so `password=secret === true` disclosed the secret. The equals form
  //    never skips; only the colon form skips annotation residue.
  const cmp1 = redactBodyText(`password=${SECRET} === true`);
  assert(!cmp1.includes(SECRET), `redaction: a comparison after the value must not abort redaction (${cmp1})`);
  assert(cmp1.includes('=== true'), `redaction: the comparison itself must survive (${cmp1})`);
  const cmp2 = redactBodyText(`password=${SECRET} = 2`);
  assert(!cmp2.includes(SECRET), `redaction: a second assignment after the value must not abort redaction (${cmp2})`);

  // 10. ROUND-2 REVIEW PROBES, PINNED. The annotation rule must not steal colon shapes
  //     that are NOT declarations: a comparison inside an object literal and a
  //     destructuring rename both bind the token AFTER ':' — and a quoted-literal union
  //     type IS a declaration and must keep its type. Each of these leaked (or destroyed
  //     an operator) on the blocked revision 2861e7f.
  const cmpObj = redactBodyText(`let obj = { password: mySecret === input }`);
  assert(!cmpObj.includes('mySecret'), `redaction: a colon-comparison in an object literal must not be read as an annotation (${cmpObj})`);
  assert(cmpObj.includes('=== input'), `redaction: the comparison must survive (${cmpObj})`);
  const destr = redactBodyText(`let { password: mySecret } = y;`);
  assert(!destr.includes('mySecret'), `redaction: a destructuring rename must not be read as an annotation (${destr})`);
  assert(destr.includes('= y'), `redaction: the destructuring binding source must survive (${destr})`);
  const tsLiteralUnion = redactBodyText(`const apiKey: 'sandbox' | 'live' = "${SECRET}";`);
  assert(!tsLiteralUnion.includes(SECRET), `redaction: a quoted-literal union type must not leak the value (${tsLiteralUnion})`);
  assert(tsLiteralUnion.includes(`'sandbox' | 'live'`), `redaction: the literal union type must survive (${tsLiteralUnion})`);
  const opPreserved = redactBodyText(`const x = "secret" == true`);
  assert(opPreserved.includes('== true'), `redaction: a comparison operator must not be redacted as a value (${opPreserved})`);

  // 8. PLURALIZED CREDENTIAL NAMES (web-uplift-xwr). CREDENTIAL_WORDS carries singulars,
  //    so isCredentialName('secrets'|'tokens'|'apiKeys') was false and {"secrets":{...}}
  //    walked through BOTH the structured and the heuristic pass untouched.
  for (const name of ['apiKeys', 'secrets', 'tokens', 'passwords', 'clientSecrets', 'accessTokens']) {
    assert(isCredentialName(name), `redaction: pluralized credential name '${name}' must be recognised`);
  }
  const pluralJson = redactBodyText(`{"secrets":{"db":"${SECRET}"},"tokens":["${SECRET}"],"page":2}`);
  assert(!pluralJson.includes(SECRET), `redaction: plural-named containers must be redacted whole (${pluralJson})`);
  assert(pluralJson.includes('"page":2'), `redaction: a non-credential field beside them must survive (${pluralJson})`);
  const pluralApiKeys = redactBodyText(`{"apiKeys":["${SECRET}"]}`);
  assert(!pluralApiKeys.includes(SECRET), `redaction: an apiKeys array (${pluralApiKeys})`);
  const pluralForm = redactBodyText(`user=bob&tokens=${SECRET}&remember=1`);
  assert(!pluralForm.includes(SECRET) && pluralForm.includes('user=bob'), `redaction: a plural name in a form body (${pluralForm})`);
  // DIRECTION CHECK: stemming must not turn innocent plurals into credentials.
  for (const name of ['colors', 'fonts', 'boxes', 'regions']) {
    assert(!isCredentialName(name), `redaction: innocent plural '${name}' must NOT be treated as a credential (over-redaction costs evidence)`);
  }

  // FIDELITY: the assertion that catches BOTH classes of corruption. The redacted body must be
  // byte-identical to the input EXCEPT at the redacted spans - so a body that still round-trips
  // with a credential in it fails, and so does a body that lost a field or changed a number.
  // Re-serialising used to drop a __proto__ field through the prototype setter and round a large
  // integer; the splice path must not.
  const proto = `{"__proto__":{"x":1},"token":"${SECRET}","big":9007199254740993,"page":2}`;
  const protoOut = redactBodyText(proto);
  assert(
    protoOut === `{"__proto__":{"x":1},"token":"[redacted]","big":9007199254740993,"page":2}`,
    `redaction: the body must differ from the input ONLY at the redacted span\n  in : ${proto}\n  out: ${protoOut}`,
  );
  assert(protoOut.includes('__proto__'), 'redaction: a __proto__ field must survive (re-serialising dropped it through the prototype setter)');
  assert(protoOut.includes('9007199254740993'), 'redaction: an integer beyond the safe range must survive unchanged (re-serialising rounded it)');
  const cleanBody = '{"page":2,"big":9007199254740993}';
  assert(redactBodyText(cleanBody) === cleanBody, 'redaction: a body with no credential-named field must be recorded byte-identical');
  const arrIn = `{"token":["${SECRET}","other"],"page":2}`;
  assert(
    redactBodyText(arrIn) === '{"token":"[redacted]","page":2}',
    `redaction: an array value is replaced at its own span and nothing else moves (${redactBodyText(arrIn)})`,
  );

  // NESTING IS COVERED BY CONSTRUCTION - and this is the exact-string assertion that proves it.
  // The walker used to jump to the end of a NON-credential key's value unconditionally, which
  // skipped an entire container instead of descending into it, so a nested credential survived
  // unchanged (and the valid-JSON path returned it, so the heuristic never saw it). Each of
  // these compares the WHOLE string, so a missed redaction and a corrupted body both fail.
  const nestedObj = `{"outer":{"token":"${SECRET}","keep":1},"page":2}`;
  assert(
    redactBodyText(nestedObj) === '{"outer":{"token":"[redacted]","keep":1},"page":2}',
    `redaction: a credential NESTED in an object must be redacted with every other byte preserved (${redactBodyText(nestedObj)})`,
  );
  const nestedArr = `{"list":[{"apiKey":"${SECRET}","n":1},{"n":2}],"page":2}`;
  assert(
    redactBodyText(nestedArr) === '{"list":[{"apiKey":"[redacted]","n":1},{"n":2}],"page":2}',
    `redaction: a credential NESTED in an array of objects must be redacted with every other byte preserved (${redactBodyText(nestedArr)})`,
  );
  const multi = `{"token":"${SECRET}","outer":{"password":"${SECRET}"},"page":2}`;
  assert(
    redactBodyText(multi) === '{"token":"[redacted]","outer":{"password":"[redacted]"},"page":2}',
    `redaction: MULTIPLE credential keys, at least one nested, must all be redacted (${redactBodyText(multi)})`,
  );

  // THE DOCUMENTED GAPS, asserted so they cannot be mistaken for coverage later:
  // a base64-encoded body is not text-searchable, and a credential whose name does not
  // look like one is not detected. Both are stated in the artifact's own note.
  const b64 = Buffer.from(`password=${SECRET}`).toString('base64');
  assert(redactBodyText(b64) === b64, 'redaction: a base64-encoded body is left untouched - a KNOWN GAP, since base64 is not text-searchable');
  assert(
    Buffer.from(redactBodyText(b64), 'base64').toString('utf8').includes(SECRET),
    'redaction: and the credential is still RECOVERABLE from that body by decoding it - asserted so the artifact note states the gap instead of claiming coverage',
  );
  assert(redactBodyText('page=2&q=hello') === 'page=2&q=hello', 'redaction: text with no credential-named field must be untouched');
  assert(isCredentialName('api_key') && isCredentialName('Set-Cookie') === false && isCredentialName('page') === false, 'redaction: the names-based test itself');
}


// The integration half: a REAL har run over a local page, so the wiring is exercised and
// not just the helpers. One browser launch covers every vector in the artifact.
export async function testHarCredentialRedaction() {
  const SECRET = 'SECRET-CANARY-456';
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/redir') {
      res.writeHead(302, { Location: `/final?session=${SECRET}` });
      res.end('redirecting');
      return;
    }
    if (path === '/api') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(`{"refresh_token":"${SECRET}","ok":true}`);
      return;
    }
    if (path === '/final') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(`{"refresh_token":"${SECRET}","ok":true}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>t</title><link rel="icon" href="data:,">
      <script>
        fetch('/api?api_key=${SECRET}', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: '${SECRET}', page: 2 }) });
        fetch('/redir');
      </script>ok`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const base = join(tmp, `dsj-har-${Math.random().toString(36).slice(2)}`);
    mkdirSync(base, { recursive: true });
    const out = join(base, 'network.har');
    await gather('har', `http://127.0.0.1:${port}/?token=${SECRET}&page=2`, { quiet: true, wait: 2500, bodies: true, out });

    const raw = readFileSync(out, 'utf8');
    assert(!raw.includes(SECRET), 'dsj har: the credential must not appear anywhere in the raw HAR');

    const entries = JSON.parse(raw).log.entries;
    const withToken = entries.find((e) => (e.request.url || '').includes('token='));
    assert(withToken, 'dsj har: the entry carrying the token parameter must be present');
    assert(withToken.request.url.includes('token=%5Bredacted%5D') || withToken.request.url.includes('token=[redacted]'), `dsj har: the request URL parameter must be redacted (${withToken.request.url})`);
    assert(withToken.request.url.includes('page=2'), `dsj har: a non-credential parameter in the same URL must survive (${withToken.request.url})`);
    const qs = (withToken.request.queryString || []).map((q) => `${q.name}=${q.value}`);
    assert(qs.includes('token=[redacted]') && qs.includes('page=2'), `dsj har: the parsed queryString must redact one and keep the other (${JSON.stringify(qs)})`);

    const postEntry = entries.find((e) => e.request.postData && e.request.postData.text);
    assert(postEntry, 'dsj har: the POST entry must be present (the body vector)');
    assert(!postEntry.request.postData.text.includes(SECRET), `dsj har: the request body must be redacted (${postEntry.request.postData.text})`);
    assert(postEntry.request.postData.text.includes('"page":2'), `dsj har: a non-credential body field must survive (${postEntry.request.postData.text})`);
    assert(postEntry.request.bodySize === Buffer.byteLength(postEntry.request.postData.text), 'dsj har: bodySize must describe the REDACTED text, not the original secret length');
    // and the wire lengths are NOT adjusted - the note says so, so assert the gap is real
    assert(typeof postEntry.response?.bodySize === 'number', 'dsj har: response wire sizes remain measurements (a stated gap, not a hidden one)');

    const redirectEntry = entries.find((e) => (e.response?.status === 302));
    assert(redirectEntry, 'dsj har: the redirect entry must be present');
    assert(!String(redirectEntry.response.redirectURL).includes(SECRET), `dsj har: the redirect target must be redacted (${redirectEntry.response.redirectURL})`);

    const bodyEntry = entries.find((e) => (e.response?.content?.text || '').includes('[redacted]'));
    assert(bodyEntry, 'dsj har: a recorded response body carrying a credential-named field must be redacted (--bodies path)');
    assert(!entries.some((e) => (e.response?.content?.text || '').includes(SECRET)), 'dsj har: no recorded response body may still carry the credential');
    // The note claims the WIRE sizes still measure the ORIGINAL bytes, so assert exactly that:
    // had either been recomputed from the redacted text it would be SHORTER, and this fails.
    // Compare WITHIN the same entry: bodySize is the wire measurement of the ORIGINAL body,
    // the recorded text is the redacted one, and for an uncompressed response the former is
    // longer. An implementation that recomputed bodySize from the redacted text fails here.
    const redactedLen = Buffer.byteLength(postEntry.response?.content?.text || '');
    assert(
      typeof postEntry.response?.bodySize === 'number' && postEntry.response.bodySize > redactedLen,
      `dsj har: response bodySize must remain the ORIGINAL wire measurement, not a recomputed one (wire ${postEntry.response?.bodySize}, redacted ${redactedLen})`,
    );
    assert(
      typeof postEntry.response?._transferSize === 'number' && postEntry.response._transferSize > redactedLen,
      `dsj har: _transferSize must remain the ORIGINAL wire measurement too (transfer ${postEntry.response?._transferSize}, redacted ${redactedLen})`,
    );

    // THE TWO VECTORS THIS TEST FOUND ITSELF, one call site further out than the bead's
    // list: URL-valued headers (Referer carries the audited page URL verbatim) and the
    // initiator fields (the inserting document and the JS call-frame URL, which is the page
    // URL when a script started the request).
    const refererEntry = entries.find((e) =>
      (e.request.headers || []).some((h) => String(h.name).toLowerCase() === 'referer' && String(h.value).includes('token=')));
    assert(refererEntry, 'dsj har: an entry whose Referer carries the token URL must be present (otherwise this vector is untested)');
    assert(
      !JSON.stringify(refererEntry.request.headers).includes(SECRET),
      'dsj har: the Referer header must not carry the credential',
    );
    // POSITIVE FIRST, or the absence assertion cannot show an initiator-specific failure:
    // the fixture must demonstrably have carried the parameter in an initiator URL, and the
    // redaction must have replaced its VALUE while keeping the name.
    // URL.toString() percent-encodes the brackets, so accept both renderings.
    const carried = (v) => /token=(\[redacted\]|%5Bredacted%5D)/i.test(String(v || ''));
    const initiatorCarried = entries.some((e) => carried(e._initiator?.url) || carried(e._initiator?.callFrame?.url));
    assert(initiatorCarried, 'dsj har: an initiator URL must have carried the token parameter and been cleaned (otherwise this vector is untested)');
    assert(
      !entries.some((e) => String(e._initiator?.url || '').includes(SECRET) || String(e._initiator?.callFrame?.url || '').includes(SECRET)),
      'dsj har: neither initiator field may carry the credential',
    );

    const summary = JSON.parse(readFileSync(join(base, 'network-summary.json'), 'utf8'));
    const summaryRaw = JSON.stringify(summary);
    assert(!summaryRaw.includes(SECRET), 'dsj har: the model-readable summary must not re-leak what the HAR redacted');
    const redir = (summary.hygiene?.redirects || []).find((r) => r.status === 302);
    assert(redir && !String(redir.location).includes(SECRET), `dsj har: the summary redirect target must be redacted (${JSON.stringify(redir)})`);
  } finally {
    server.close();
  }
}


// A HAR carries every recorded request's and response's headers, and this repo
// commits evidence-out artifacts to a public remote, so a page-supplied bearer
// token or API key would be published irreversibly. Credential header VALUES are
// redacted by default (names, counts, status and URL metadata stay);
// --no-redact-headers is the explicit opt-out (web-uplift-dxk).
//
// Scope note, measured rather than assumed: Chrome keeps Set-Cookie and Cookie out
// of the Network.requestWillBeSent / responseReceived events this harness consumes
// (they live in the *ExtraInfo events it does not listen to), so the headers that
// actually reach a HAR today are page-supplied request headers such as
// Authorization and X-Api-Key. The full name list is still applied defensively,
// and testRedactHeaderList covers all of it without a browser.
export async function testHarRedactsCredentialHeaders() {
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/api') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>creds</title><link rel="icon" href="data:,">' +
        '<script>fetch("/api",{headers:{Authorization:"Bearer super-secret-token","X-Api-Key":"super-secret-api-key"}})</script>',
    );
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    const token = 'super-secret-token';
    const apiKey = 'super-secret-api-key';

    const out = join(tmp, 'redacted-network.har');
    const result = await gather('har', url, { quiet: true, wait: 600, out });
    const harText = readFileSync(out, 'utf8');
    const summaryText = readFileSync(result.summaryArtifact, 'utf8');
    const har = JSON.parse(harText);

    for (const [label, text] of [['the HAR', harText], ['the network summary', summaryText]]) {
      assert(!text.includes(token), `${label} must not carry the raw Authorization value`);
      assert(!text.includes(apiKey), `${label} must not carry the raw API-key value`);
    }

    const api = har.log.entries.find((e) => e.request.url.endsWith('/api'));
    assert(api, `the fixture request must be recorded: ${har.log.entries.map((e) => e.request.url).join(', ')}`);
    const auth = (api.request.headers || []).find((h) => h.name.toLowerCase() === 'authorization');
    assert(
      auth && auth.value === '[redacted]',
      `a request Authorization must be redacted by value: ${JSON.stringify(api.request.headers)}`,
    );
    const apiKeyHeader = (api.request.headers || []).find((h) => h.name.toLowerCase() === 'x-api-key');
    assert(
      apiKeyHeader && apiKeyHeader.value === '[redacted]',
      `a request X-Api-Key must be redacted by value: ${JSON.stringify(api.request.headers)}`,
    );
    const contentType = (api.response.headers || []).find((h) => h.name.toLowerCase() === 'content-type');
    assert(
      contentType && contentType.value.includes('json'),
      `a non-secret header must be untouched: ${JSON.stringify(api.response.headers)}`,
    );

    const rawOut = join(tmp, 'raw-network.har');
    await gather('har', url, { quiet: true, wait: 600, out: rawOut, redactHeaders: false });
    const rawText = readFileSync(rawOut, 'utf8');
    assert(
      rawText.includes(token) && rawText.includes(apiKey),
      '--no-redact-headers must keep the raw credential values for an operator who accepts the risk',
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// A page-derived script URL is attacker-controlled text, and it used to be
// interpolated into the evaluated fetch() expression UNQUOTED (web-uplift-991),
// unlike every other interpolation in the file. Empirically (this fixture was
// built to find out): the DOM URL-serializes apostrophes in http(s) script URLs
// to %27, so THAT spelling is not reachable - but a data: URL's opaque path is
// NOT normalized, so a raw quote in it reaches the interpolation verbatim. With
// the unquoted form the expression is a syntax error the try/catch swallows and
// the external script is silently NEVER scanned. The fixture keeps the planted
// key percent-encoded so the page HTML itself contains no key: a finding can
// only come from the fetched external script.
export async function testSecretsScanHandlesQuotedScriptUrl() {
  const encKey = Array.from('AKIAIOSFODNN7EXAMPLE')
    .map((c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .join('');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      `<!doctype html><title>quoted</title><link rel="icon" href="data:,">` +
        `<script src="data:text/plain,x='${encKey}"></script><body>page</body>`,
    );
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const result = await gather('secrets', `http://127.0.0.1:${port}/`, { quiet: true, wait: 300 });
    const ext = result.findings.filter((f) => typeof f.source === 'string' && f.source.startsWith('external JS'));
    assert(
      ext.length >= 1 && ext[0].pattern === 'aws-access-key',
      `the quoted data: script URL must still be fetched and scanned (a syntax-erroring fetch is a silent skip): ${JSON.stringify(result.findings)}`,
    );
    assert(
      !result.findings.some((f) => f.source === 'page HTML'),
      `the key is percent-encoded in the HTML, so a page-HTML finding would mean the fixture is wrong: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}



// web-uplift-61i: the secrets primitive's in-page fetch of page-selected script
// URLs must carry the same containment as the Node-side path (FETCH_MAX_BYTES
// cap + the configured fetch deadline), or a hostile page can return an
// unbounded body or hang the audit. Proven with three fixtures: a key BEFORE
// the 2 MiB boundary is found, a key AFTER it is not (the body was capped),
// and a never-answering script cannot hang the run past the deadline.
export async function testSecretsExternalScriptFetchIsCappedAndDeadlined() {
  const { configureFetchDeadline } = await import('../evidence/cli.mjs');
  const earlyKey = 'NOTAREALKEY_FIXTURE_EARLY1234567890ABCDEFGH';
  const lateKey = 'NOTAREALKEY_FIXTURE_LATE1234567890ABCDEFGHIJ';
  const missingKey = 'NOTAREALKEY_FIXTURE_URLQUERY1234567890';
  let slowRequests = 0;
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/early.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(`const api_key="${earlyKey}";`);
      return;
    }
    if (path === '/big.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end('/*' + 'a'.repeat(2 * 1024 * 1024 + 4096) + '*/' + `const api_key="${lateKey}";`);
      return;
    }
    if (path === '/missing.js') {
      // A script URL the page references but the server cannot serve. A 404 body is
      // not the script, so counting it as scanned over-claims coverage (6fe). The
      // credential in its query string must NOT reach the artifact's failure list.
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    if (path === '/notjs.js') {
      // A real redirect: the browser follows it to an HTML error page, so res.ok is
      // true while the body is not JavaScript and res.url differs from the request
      // (6fe review: the previous fixture served HTML directly and so never
      // exercised the redirect/finalUrl path).
      res.writeHead(302, { Location: '/error.html' });
      res.end();
      return;
    }
    if (path === '/error.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>error</title><p>not a script</p>');
      return;
    }
    if (path === '/slow.js') {
      slowRequests++;
      // Never answer: the socket stays open. The in-page deadline must cut it.
      req.on('close', () => res.destroy());
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>capped</title><link rel="icon" href="data:,">' +
        `<script src="/early.js"></script><script src="/big.js"></script><script src="/missing.js?api_key=${missingKey}"></script><script src="/notjs.js"></script><script>window.addEventListener("load",()=>{const s=document.createElement("script");s.src="/slow.js";document.body.appendChild(s);})</script><body>page</body>`,
    );
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const started = Date.now();
  try {
    const { port } = server.address();
    configureFetchDeadline(800);
    const result = await gather('secrets', `http://127.0.0.1:${port}/`, { quiet: true, wait: 300 });
    const elapsedMs = Date.now() - started;
    const sources = result.findings.map((f) => `${f.pattern}@${f.source}`);
    assert(
      result.findings.some((f) => f.source === 'external JS: early.js'),
      `the key before the cap boundary must be found: ${JSON.stringify(sources)}`
    );
    assert(
      !result.findings.some((f) => f.source === 'external JS: big.js'),
      `the key AFTER the 2 MiB boundary must NOT be found (body must be capped): ${JSON.stringify(sources)}`
    );
    assert(slowRequests >= 1, 'the fixture must actually have been asked for the hanging script');
    assert(
      elapsedMs < 20000,
      `a never-answering script URL must not hang the audit (took ${elapsedMs}ms with an 800ms deadline)`
    );

    // web-uplift-6fe: a script that could not be READ must say so and must not be
    // counted as covered. Of the five sampled URLs, early.js alone is a clean read
    // (big.js is capped, missing.js is a 404, notjs.js is served as HTML, slow.js
    // hits the deadline).
    assert(
      result.externalScriptsAttempted === 5,
      `all five script URLs must be accounted for: ${JSON.stringify({ attempted: result.externalScriptsAttempted })}`
    );
    assert(
      result.externalScriptsScanned === 2,
      `only the two readable scripts may be counted as scanned (early.js, big.js): ${JSON.stringify({ scanned: result.externalScriptsScanned, failed: result.externalScriptFailures })}`
    );
    assert(result.externalScriptsCapped === 1, `the capped body must be reported as capped: ${result.externalScriptsCapped}`);
    assert(
      result.externalScriptsFailed === 3,
      `the 404, the HTML body and the deadline must all be reported as failed: ${JSON.stringify(result.externalScriptFailures)}`
    );
    const reasons = (result.externalScriptFailures || []).map((f) => f.reason).sort();
    assert(
      reasons.some((r) => r === 'HTTP 404') && reasons.some((r) => /HTML/.test(r)) && reasons.some((r) => /deadline/.test(r)),
      `each failure must name its cause: ${JSON.stringify(reasons)}`
    );
    assert(
      (result.externalScriptFailures || []).every((f) => typeof f.url === 'string' && (f.url.includes('.js') || f.url.includes('error.html'))),
      `each failure must name the URL it could not read: ${JSON.stringify(result.externalScriptFailures)}`
    );
    // The redirecting script must report where it actually ended up, redacted like
    // every other artifact URL - and the HTML body must be the reason, not the 200.
    const redirected = (result.externalScriptFailures || []).find((f) => f.url.includes('/notjs.js'));
    assert(redirected && /HTML/.test(redirected.reason),
      `a redirected script must be reported as HTML, not counted as read: ${JSON.stringify(redirected)}`);
    assert(redirected.finalUrl && redirected.finalUrl.includes('/error.html'),
      `the final (redirected) URL must be recorded: ${JSON.stringify(redirected)}`);
    assert(
      result.note.includes('NOT scanned'),
      'the artifact note must warn that an unread script is not coverage'
    );
    // The failure list is a surface this change owns, so a credential in a
    // page-selected URL must be redacted there like everywhere else (6fe review).
    // NOTE: the artifact's `console` block still carries the same URL verbatim from
    // the CDP Log entry - that is a pre-existing, wider surface (every primitive
    // emits it) and is filed separately rather than widened into this change.
    assert(
      !JSON.stringify(result.externalScriptFailures).includes(missingKey),
      'a credential in a failed script URL must not reach the failure list'
    );
    assert(
      (result.externalScriptFailures || []).some((f) => /api_key=%5Bredacted%5D/.test(f.url)),
      `the failed URL must keep its shape with the value redacted: ${JSON.stringify(result.externalScriptFailures)}`
    );
  } finally {
    configureFetchDeadline(30000); // restore the production default for the rest of the suite
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// The secrets scan reports what it matched without republishing it: a finding
// carries the pattern, severity, source and the match length, never a character
// of the credential. The old shape kept the first six and last four characters
// (and the whole value for a match of twelve characters or fewer), and those
// findings are written into run artifacts that can be published (web-uplift-u5n).
export async function testSecretsArtifactDoesNotPersistMatches() {
  const secret = 'NOTAREALKEY_FIXTURE_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/clean') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>clean</title><body>nothing secret here</body>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>secrets</title><link rel="icon" href="data:,">' +
        `<script>const api_key="${secret}";</script>`,
    );
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'secrets.json');
    const result = await gather('secrets', `http://127.0.0.1:${port}/`, { quiet: true, wait: 300, out });
    assert(result.totalFindings >= 1, `the fixture secret must still be reported: ${JSON.stringify(result.findings)}`);
    const finding = result.findings.find((f) => f.match !== undefined);
    assert(finding && finding.match === '[redacted]', `a finding must not carry the matched value: ${JSON.stringify(finding)}`);
    assert(
      typeof finding.matchLength === 'number' && finding.matchLength > 0,
      `a finding should report the match length instead of the value: ${JSON.stringify(finding)}`,
    );
    const artifact = readFileSync(out, 'utf8');
    for (const [label, text] of [['the artifact', artifact], ['stdout', JSON.stringify(result)]]) {
      assert(!text.includes(secret), `${label} must not carry the matched value`);
    }
    const clean = await gather('secrets', `http://127.0.0.1:${port}/clean`, { quiet: true, wait: 300 });
    assert(clean.totalFindings === 0, `a page with no secret must report none: ${JSON.stringify(clean.findings)}`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// The persisted shape itself, without a browser. The fixture value is built at
// runtime so this file contains no provider-shaped key literal, and the scan is
// asked directly: what a finding may carry is the pattern, severity, source and
// the match LENGTH, never a character of the matched value. This is the precise
// check for the old behaviour, which kept the first six and last four characters
// of the match (web-uplift-u5n).
export function testSecretsScanDoesNotPersistMatchCharacters() {
  const value = 'sk_' + 'live_' + 'A'.repeat(30);
  const findings = scanTextForSecrets(`const api_key="${value}"`, 'unit fixture');
  assert(findings.length > 0, `the fixture value must be reported: ${JSON.stringify(findings)}`);
  for (const finding of findings) {
    if (finding.match === undefined) continue; // the "more matches" note carries no value
    assert(finding.match === '[redacted]', `a finding must not carry the matched value: ${JSON.stringify(finding)}`);
    assert(
      typeof finding.matchLength === 'number' && finding.matchLength > 0,
      `a finding should report the match length instead of the value: ${JSON.stringify(finding)}`,
    );
  }
  const serialised = JSON.stringify(findings);
  assert(!serialised.includes(value.slice(0, 6)), 'no part of the matched value may be persisted (head)');
  assert(!serialised.includes(value.slice(-4)), 'no part of the matched value may be persisted (tail)');
  assert(!serialised.includes(value), 'the whole matched value must never be persisted');
}


// The source read without a browser. `dom --source <dir>` inlines the local tree
// into an artifact that is committed and republished, so a credential in the tree
// must not survive the read (web-uplift-obl). Read THROUGH the existing
// names-based redaction rather than a second implementation, and do not read at
// all a file whose NAME says credential. The fixture secret is built at runtime so
// this file carries no provider-shaped key literal.
export function testSourceTreeRedactsBeforeInlining() {
  const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const root = join(tmp, 'source-tree');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'config.json'), JSON.stringify({ api_key: secret, region: 'eu-west-1' }, null, 2));
  writeFileSync(join(root, 'src', 'app.js'), `const apiKey = "${secret}";\nconst region = 'eu-west-1';\n`);
  writeFileSync(join(root, 'src', 'page.html'), `<p data-region="eu-west-1">ok</p>\n`);
  writeFileSync(join(root, '.env'), `AWS_ACCESS_KEY_ID=${secret}\n`);
  writeFileSync(join(root, 'service-credentials.json'), JSON.stringify({ serviceAccountToken: secret }));
  writeFileSync(join(root, 'signing.pem'), `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----\n`);
  writeFileSync(join(root, 'firebase.json'), JSON.stringify({ api_key: secret }));
  writeFileSync(join(root, 'wrangler.toml'), `api_token = "${secret}"\n`);
  // web-uplift-xwr: a DIRECTORY whose name says credential is skipped wholesale -
  // the documented fail-closed decision. Descending would rely on the in-text pass
  // catching every file inside; one miss is a disclosure, so the whole tree is
  // dropped as RECORDED evidence loss instead.
  mkdirSync(join(root, 'secret-utils'), { recursive: true });
  writeFileSync(join(root, 'secret-utils', 'sign.js'), `export const s = "${secret}";\n`);

  const tree = readSourceTree(root);
  const serialised = JSON.stringify(tree);
  assert(!serialised.includes(secret), `no source read may carry a credential value: ${serialised}`);
  assert(!serialised.includes(secret.slice(0, 4)), 'not even the head of the value may survive the read');

  const config = tree.files.find((f) => f.path === 'src/config.json');
  assert(config, `the JSON config must still be read: ${JSON.stringify(tree.files.map((f) => f.path))}`);
  assert(config.content.includes('"api_key": "[redacted]"'), `the credential value must be replaced in place: ${config.content}`);
  assert(config.content.includes('"region": "eu-west-1"'), `the rest of the file must survive byte-for-byte: ${config.content}`);
  assert(config.redacted === true, `a file that had a value replaced must say so: ${JSON.stringify(config)}`);

  const app = tree.files.find((f) => f.path === 'src/app.js');
  assert(app && app.content.includes('[redacted]'), `a credential-named const in JS must be redacted: ${JSON.stringify(app)}`);
  assert(app.content.includes("'eu-west-1'"), `a non-credential value in JS must survive: ${app.content}`);

  const page = tree.files.find((f) => f.path === 'src/page.html');
  assert(page && page.redacted === false, `a clean file must be recorded as unredacted: ${JSON.stringify(page)}`);

  const skipped = tree.skippedFiles.map((s) => s.path).sort();
  for (const name of ['.env', 'service-credentials.json', 'signing.pem', 'firebase.json', 'wrangler.toml']) {
    assert(skipped.includes(name), `a credential-named file must be skipped and recorded, not read: ${name} (${JSON.stringify(skipped)})`);
  }
  assert(skipped.includes('secret-utils'), `a credential-named DIRECTORY must be skipped wholesale and recorded: ${JSON.stringify(skipped)}`);
  assert(!tree.files.some((f) => f.path.startsWith('secret-utils')), `nothing inside a skipped directory may be read: ${JSON.stringify(tree.files.map((f) => f.path))}`);
  for (const entry of tree.skippedFiles) {
    assert(entry.reason === 'high-risk-name', `a skip must state its reason: ${JSON.stringify(entry)}`);
  }
  assert(tree.redactedFiles === 2, `exactly the two credential-bearing files should count as redacted: ${tree.redactedFiles}`);

  // The artifact must say a redaction happened AND what it cannot cover, so a
  // reader never treats a redacted read as either raw or complete.
  assert(tree.redaction && tree.redaction.applied === true, `the artifact must record that redaction was applied: ${JSON.stringify(tree.redaction)}`);
  assert(
    typeof tree.redaction.residual === 'string' && /still reach|not carried|opaque/.test(tree.redaction.residual),
    `the residual must be documented, not implied: ${JSON.stringify(tree.redaction)}`,
  );
}


// The same guarantee end to end: what `dom --source` actually writes to disk. The
// artifact is the thing that gets published, so the check is on the artifact text,
// not on the in-memory return (web-uplift-obl).
export async function testDomSourceArtifactIsRedacted() {
  const secret = 'AKIA' + 'QRSTUVWXYZ012345';
  const root = join(tmp, 'dom-source-tree');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ apiKey: secret, siteName: 'fixture' }, null, 2));
  writeFileSync(join(root, '.env'), `API_KEY=${secret}\n`);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>source redaction fixture</title></head><body><p>ok</p></body></html>');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const out = join(tmp, 'dom-source.json');
    const result = await gather('dom', `http://127.0.0.1:${port}/`, { quiet: true, wait: 300, source: root, out });
    assert(result.source, `dom --source must return a source block: ${Object.keys(result)}`);
    assert(result.source.redactedFiles >= 1, `the fixture credential must be redacted: ${JSON.stringify(result.source.redactedFiles)}`);
    assert(
      result.source.skippedFiles.some((s) => s.path === '.env'),
      `the credential-named file must be skipped and recorded: ${JSON.stringify(result.source.skippedFiles)}`,
    );
    const config = result.source.files.find((f) => f.path === 'config.json');
    assert(config && config.content.includes('[redacted]'), `the config value must be replaced: ${JSON.stringify(config)}`);
    for (const [label, text] of [['the artifact', readFileSync(out, 'utf8')], ['stdout', JSON.stringify(result)]]) {
      assert(!text.includes(secret), `${label} must not carry the source credential value`);
    }
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


export const redactionTests = [
  testRedactHeaderList,
  testCredentialRedactionHelpers,
  testHarCredentialRedaction,
  testHarRedactsCredentialHeaders,
  testSecretsScanHandlesQuotedScriptUrl,
  testSecretsExternalScriptFetchIsCappedAndDeadlined,
  testSecretsArtifactDoesNotPersistMatches,
  testSecretsScanDoesNotPersistMatchCharacters,
  testSecretsCoverageClassification,
  testSourceTreeRedactsBeforeInlining,
  testDomSourceArtifactIsRedacted,
  testLogUrlRedaction,
  testCredentialRedactorsAgree,
];

export {
  testSecretsCoverageClassification,
  testLogUrlRedaction,
  testCredentialRedactorsAgree,
};

await runSuite(redactionTests, import.meta.url);
