#!/usr/bin/env node
// Console-evidence credential redaction (web-uplift-lsn3).
//
// The console block is attached to the result of EVERY primitive and written into every artifact
// (reports/, evidence-out/), and its `url` is whatever the page asked for: a failed <script src>
// carrying a credential in its query is the ordinary case, and a page that logs location.href puts
// one in an entry's TEXT as well. evidence/cdp.mjs used to copy both verbatim while the
// externalScriptFailures list for the very same request was redacted (web-uplift-6fe), so the same
// credential was cleaned from one field of the artifact and left in another.
//
// This drives the collector through a CDP client stand-in rather than a browser: the redaction
// decision is what is under test here, and it is deterministic. The real-browser end to end
// (gather('secrets') against a page whose script 404s with a credential in its query) is measured
// on the bead, because it needs Chrome.
//
// The in-text redactor is a SCANNER over URL starts rather than one regex over the whole string:
// four review rounds found four adjacency shapes a single "match the URL, redact it" regex got
// wrong (a second URL after a comma, after a semicolon, after a comma when the second URL was a
// rooted path, and after a comma when its scheme was uppercase), each time because the outer match
// swallowed both URLs so the first URL's parameters were the only ones examined. The scanner finds
// every URL start at a boundary (start of text, whitespace, or a separator), takes each span to the
// next start or a natural stop, and redacts it, so adjacency stops being a special case.
//
// Boundary stated rather than implied: it rewrites absolute URLs, protocol-relative URLs, and
// ROOTED relative paths ('/api/send?access_token=...', an ordinary console message and a real leak
// until the review found it). What it still does not rewrite: a relative path with no leading slash
// ('api/send?access_token=...'), and a credential that appears with no URL around it at all (that is
// the secrets scanner's job, not this one's). A URL it rewrites is re-emitted by URL.toString(), so
// an uppercase scheme or host is lowercased as part of the redaction - shape only, and only when a
// credential was actually removed.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { attachConsoleCollector, attachConsoleEvidence } from '../evidence/cdp.mjs';
import { redactUrlCredentialValues, redactUrlsInText } from '../evidence/credential-terms.mjs';

const SECRET = 'NOTAREALKEY_FIXTURE_CONSOLE1234567890ABCDEF';
const REDACTED = '%5Bredacted%5D'; // '[redacted]' after URL encoding

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// A CDP client stand-in: the collector registers three event handlers and enables two domains.
function stubClient() {
  const handlers = {};
  return {
    handlers,
    Runtime: {
      consoleAPICalled: (cb) => { handlers.console = cb; },
      exceptionThrown: (cb) => { handlers.exception = cb; },
      enable: async () => {},
    },
    Log: {
      entryAdded: (cb) => { handlers.log = cb; },
      enable: async () => {},
    },
  };
}

export async function testConsoleEvidenceRedaction() {
  // 1. The shared redactor itself: the parameter NAME and every other parameter survive.
  assert(
    redactUrlCredentialValues(`https://x.test/a.js?api_key=${SECRET}&page=2`) === `https://x.test/a.js?api_key=${REDACTED}&page=2`,
    'a credential parameter must be redacted by value, keeping its name and the other parameters',
  );
  assert(
    redactUrlCredentialValues('https://x.test/a.js?page=2') === 'https://x.test/a.js?page=2',
    'a URL with no credential parameter must be untouched',
  );
  assert(
    redactUrlCredentialValues(`/relative?token=${SECRET}`) === `/relative?token=${REDACTED}`,
    'a relative URL must also be redacted, because a console text can hold one',
  );
  assert(redactUrlCredentialValues('') === '' && redactUrlCredentialValues(null) === null, 'a non-string passes through');
  assert(redactUrlsInText('nothing to see') === 'nothing to see', 'text without a URL is untouched');
  assert(
    redactUrlsInText(`see https://x.test/a?token=${SECRET}, then stop.`) === `see https://x.test/a?token=${REDACTED}, then stop.`,
    'a URL inside prose is redacted while the surrounding punctuation is preserved',
  );
  // A protocol-relative URL is matched (that is what matters here: the credential goes), but the
  // shared redactor re-emits it as a path because new URL() cannot parse a host without a scheme -
  // a pre-existing shape quirk of the moved function, filed separately, not introduced here. The
  // assertion is on the credential, which is the property this file is about.
  const protocolRelative = redactUrlsInText(`//x.test/a?token=${SECRET}`);
  assert(!protocolRelative.includes(SECRET) && protocolRelative.includes(REDACTED),
    `a protocol-relative URL must have its credential removed: ${protocolRelative}`);

  // Adjacent URLs: the review's P1. Everything after the comma used to be swallowed into the first
  // URL's last parameter value, so the first URL had no credential parameter and the SECOND URL's
  // credential came back untouched.
  assert(
    redactUrlsInText(`https://one.test/?page=1,https://two.test/?token=${SECRET}`) === `https://one.test/?page=1,https://two.test/?token=${REDACTED}`,
    'a credential in a second URL after a comma must be redacted',
  );
  // Review pass 3: the split was case-sensitive while the outer matcher was not, so an uppercase
  // scheme on the second URL was not a split point at all. The scanner matches case-insensitively,
  // and the assertion is on the credential (URL.toString() lowercases the scheme as part of the
  // redaction, which is shape only).
  const uppercaseSecond = redactUrlsInText(`https://one.test/?page=1,HTTPS://two.test/?token=${SECRET}`);
  assert(
    uppercaseSecond === `https://one.test/?page=1,https://two.test/?token=${REDACTED}`,
    `an uppercase scheme must not hide the second URL's credential: ${uppercaseSecond}`,
  );
  // A "//" INSIDE a path is not a second URL: treating it as one made the relative branch re-emit
  // the path as a protocol-relative URL and lose a segment. This case was found by writing the
  // scanner, not by a review, and it is why a URL start has to sit at a boundary.
  assert(
    redactUrlsInText(`https://x.test/a//b?token=${SECRET}`) === `https://x.test/a//b?token=${REDACTED}`,
    'a double slash inside a path must not split the URL',
  );
  // A URL glued to prose by punctuation is still a URL start.
  assert(
    redactUrlsInText(`fetch failed:https://x.test/a?token=${SECRET}`) === `fetch failed:https://x.test/a?token=${REDACTED}`,
    'a URL after a colon must be redacted',
  );
  // ...and two innocent URLs glued the same way are left exactly as they were.
  assert(
    redactUrlsInText('https://a.test/x?p=1 and https://b.test/y?q=2') === 'https://a.test/x?p=1 and https://b.test/y?q=2',
    'adjacent URLs with no credential parameter must be untouched',
  );

  // ...and a ROOTED PATH as the second URL, which is the shape the first fix still missed
  // (review pass 2, P1): with only absolute/protocol-relative split points the whole string parsed
  // as the first URL's last parameter and the second URL's credential came back.
  assert(
    redactUrlsInText(`https://one.test/?page=1,/api/send?token=${SECRET}`) === `https://one.test/?page=1,/api/send?token=${REDACTED}`,
    'a credential in a ROOTED PATH after a comma must be redacted',
  );
  // ...and when BOTH URLs carry a credential the separator must survive: putting it at the end of
  // the first piece let the redaction of that piece's own value consume the comma and concatenate
  // the two URLs (review pass 2, P2).
  const bothRedacted = redactUrlsInText(`https://one.test/?token=${SECRET},https://two.test/?token=${SECRET}`);
  assert(
    bothRedacted === `https://one.test/?token=${REDACTED},https://two.test/?token=${REDACTED}`,
    `two adjacent credential URLs must both be redacted with their separator intact: ${bothRedacted}`,
  );
  const semicolonSeparated = redactUrlsInText(`see https://one.test/?page=1; //two.test/?token=${SECRET} now`);
  assert(semicolonSeparated.includes(REDACTED) && !semicolonSeparated.includes(SECRET),
    `a semicolon-separated second URL must be redacted too: ${semicolonSeparated}`);

  // A ROOTED relative path with a credential query is a realistic console message, not a
  // theoretical boundary; the matcher covers it now.
  assert(
    redactUrlsInText(`failed to send to /api/send?access_token=${SECRET}`) === `failed to send to /api/send?access_token=${REDACTED}`,
    'a rooted relative path with a credential query must be redacted',
  );
  assert(
    redactUrlsInText('see /docs?page=2 first') === 'see /docs?page=2 first',
    'a rooted relative path with no credential parameter must be untouched',
  );

  // 2. Through the collector: every entry path, and the innocents that must survive.
  const client = stubClient();
  await attachConsoleCollector(client, { log: () => {} });
  assert(
    typeof client.handlers.log === 'function' &&
      typeof client.handlers.console === 'function' &&
      typeof client.handlers.exception === 'function',
    'the collector must register all three entry paths',
  );

  const failedResource = {
    level: 'error',
    source: 'network',
    text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
    url: `http://127.0.0.1:9/missing.js?api_key=${SECRET}`,
  };
  client.handlers.log({ entry: failedResource });
  client.handlers.log({ entry: failedResource }); // a retry loop: same entry, same identity
  client.handlers.exception({
    exceptionDetails: {
      text: 'Uncaught TypeError',
      url: `http://127.0.0.1:9/app.js?session_key=${SECRET}`,
      lineNumber: 2,
      stackTrace: {
        callFrames: [{ functionName: 'boom', url: `http://127.0.0.1:9/app.js?access_token=${SECRET}`, lineNumber: 2, columnNumber: 3 }],
      },
    },
  });
  // A computed method name can BE a URL, and it reaches the artifact inside stack[]: redacting
  // only the frame's url field left that open (review P1).
  client.handlers.exception({
    exceptionDetails: {
      text: 'Uncaught',
      url: 'http://127.0.0.1:9/plain.js',
      lineNumber: 1,
      stackTrace: {
        callFrames: [{ functionName: `https://evil.test/?token=${SECRET}`, url: 'http://127.0.0.1:9/plain.js', lineNumber: 1, columnNumber: 1 }],
      },
    },
  });
  // A page logging its own location: the credential is inside the TEXT, not in any field.
  client.handlers.console({
    type: 'error',
    args: [{ value: `failed to send to http://127.0.0.1:9/api/send?access_token=${SECRET} and /api/other?session_key=${SECRET}` }],
    stackTrace: { callFrames: [] },
  });
  // Innocents: a non-credential query parameter, and a URL with no query at all.
  client.handlers.log({
    entry: { level: 'warning', source: 'deprecation', text: 'see https://example.test/docs?page=2 for details', url: 'https://example.test/docs?page=2' },
  });

  const result = {};
  const block = attachConsoleEvidence(client, result);
  const json = JSON.stringify(result);

  assert(!json.includes(SECRET), `NO console entry may carry a credential value: ${json}`);
  assert(
    json.includes(`api_key=${REDACTED}`) && json.includes(`session_key=${REDACTED}`) && json.includes(`access_token=${REDACTED}`),
    `every credential parameter must survive by name with a redacted value: ${json}`,
  );
  assert(json.includes('https://example.test/docs?page=2'), 'a non-credential URL must be unchanged');
  assert(
    json.includes('Failed to load resource') && json.includes('boom') && json.includes('failed to send to'),
    `the diagnostic text must survive redaction: ${json}`,
  );
  assert(
    block.entries.filter((e) => e.kind === 'exception').length === 2,
    `both exceptions must be recorded: ${JSON.stringify(block.entries)}`,
  );
  assert(
    block.entries.some((e) => e.kind === 'exception' && e.stack.some((f) => f.includes('evil.test') && f.includes(REDACTED) && !f.includes(SECRET))),
    `a stack frame whose FUNCTION NAME is a URL must be redacted: ${JSON.stringify(block.entries)}`,
  );
  assert(block.entries.length === 5, `an unchanged entry must not be split by redaction: ${JSON.stringify(block.entries)}`);
  assert(block.entries[0].repeat === 2, `a retried entry must still collapse into one with a repeat count: ${JSON.stringify(block.entries[0])}`);
  assert(result.console === block && block.hasErrors === true, 'the block is attached to the result');
  assert(
    block.entries.find((e) => e.kind === 'exception').stack[0].includes('boom (http://127.0.0.1:9/app.js?access_token=' + REDACTED + ':3:4)'),
    `a stack frame must keep its line and column while its url is redacted: ${JSON.stringify(block.entries.find((e) => e.kind === 'exception'))}`,
  );
  assert(JSON.stringify(block) === JSON.stringify(JSON.parse(json).console), 'the attached block is what gets serialised');

  // 3. Idempotence: redacting an already-redacted artifact changes nothing (a second pass over a
  //    re-read artifact is a real thing: primitives, run-batch and the fixer all read these files).
  assert(
    JSON.stringify(JSON.parse(json)) === JSON.stringify({ ...result, console: JSON.parse(JSON.stringify(block)) }),
    'the serialised result round-trips',
  );
  const roundTripped = JSON.parse(json).console;
  const urlBearing = roundTripped.entries.find((e) => typeof e.text === 'string' && e.text.includes(REDACTED));
  assert(urlBearing, `an entry whose text carried a URL must exist: ${JSON.stringify(roundTripped.entries)}`);
  assert(redactUrlsInText(urlBearing.text) === urlBearing.text,
    'redacting already-redacted text is a no-op, on an entry that actually carried a URL');
  assert(roundTripped.entries.every((e) => !JSON.stringify(e).includes(SECRET)),
    're-reading the serialised artifact finds no credential in any entry');

  // 4. A collector never sees another session's entries: the block is per client, not global.
  const other = stubClient();
  await attachConsoleCollector(other, { log: () => {} });
  other.handlers.log({ entry: { level: 'error', source: 'network', text: '404', url: `http://127.0.0.1:9/x.js?token=${SECRET}` } });
  const otherResult = {};
  const otherBlock = attachConsoleEvidence(other, otherResult);
  assert(otherBlock.entries.length === 1 && !JSON.stringify(otherResult).includes(SECRET), 'a second session starts clean and is redacted too');

  // 5. attachConsoleEvidence's existing contract is untouched by the redaction.
  assert(attachConsoleEvidence(client, result) === block, 'an existing block is returned rather than rebuilt');
  assert(attachConsoleEvidence(stubClient(), {}) === null, 'a client with no collector yields no block');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  testConsoleEvidenceRedaction()
    .then(() => console.log('tests/console-evidence-redaction.mjs: tests OK'))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
