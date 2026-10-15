#!/usr/bin/env node
// web-uplift-b9p (runner/run-batch.mjs) and web-uplift-s0x (fixer/fix.mjs) log the
// target URL. A batch/fix log lands in CI artifacts and gets pasted into issues, and a
// target URL can carry a credential in its query (?api_key=, ?token=), so every printed
// URL goes through the HAR redactor (redactUrlCredentialValues) instead of the raw value.
//
// The word set is not this file's business: evidence/credential-terms.mjs is the one
// table (web-uplift-glar), and the HAR redactor imported here reads it, so the log
// redaction follows exactly the same words as the HAR artifact and the flow recorder.
//
// Two halves, because the two failure modes are different:
//   1. behaviour - the redactor keeps the URL useful while removing the credential VALUE
//      (the parameter name still reads, and non-credential query values are untouched);
//   2. a CENSUS over the two files - every line that interpolates a URL for OUTPUT is
//      wrapped, so a new status line cannot silently reintroduce a raw URL. This is the
//      same technique as testAwaitCensus: the invariant is enforced by a source scan with
//      an explicit, asserted exemption list, not by reading.
//
// Why a census and not just driving the lines: a status line only prints on a path that
// needs a real agent or a real audit (integrity abort, confinement failure, completion
// publish failure, the baseline-audit line). The two that CAN be driven without spawning
// anything are exercised for real by the repro recorded on the beads; the rest are
// covered here by the invariant, stated as such rather than implied.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export async function testLogUrlRedaction() {
  const { redactUrlCredentialValues } = await import('../evidence/cli.mjs');

  // 1. The redactor, on the shapes a log line actually carries.
  const redacted = (u) => redactUrlCredentialValues(u);
  // [url, credential parameter, the credential VALUE (asserted absent verbatim), a
  // non-credential parameter whose value must survive]
  const cases = [
    ['https://t.example/search?api_key=LIVEKEY1234567890&q=shoes', 'api_key', 'LIVEKEY1234567890', 'q'],
    ['https://t.example/a?token=abcdef123456&page=3', 'token', 'abcdef123456', 'page'],
    ['https://t.example/a?access_token=xyz123&utm_source=news', 'access_token', 'xyz123', 'utm_source'],
    ['https://t.example/a?password=hunter2', 'password', 'hunter2', null],
    ['https://t.example/a?session=SESS123', 'session', 'SESS123', null],
    ['https://t.example/a?apikey=KEY987', 'apikey', 'KEY987', null],
    // The values a batch/fix log is most likely to carry from a real target, and the
    // ones master's table did not cover before web-uplift-glar landed.
    ['https://t.example/a?csrf=CSRF123&lang=en', 'csrf', 'CSRF123', 'lang'],
    ['https://t.example/a?pin=1234', 'pin', '1234', null],
    ['https://t.example/a?cvv=999', 'cvv', '999', null],
    ['https://t.example/a?passcode=abcd', 'passcode', 'abcd', null],
  ];
  for (const [url, secretKey, secretValue, keepKey] of cases) {
    const out = redacted(url);
    assert(out !== url, `a credential-bearing URL must change: ${url}`);
    // The VALUE comes from the case itself: a hand-written alternation of the values that
    // happen to be in the list is how pin/cvv/passcode went unasserted (review finding 3).
    assert(!out.includes(secretValue),
      `the credential VALUE "${secretValue}" must not survive: ${out}`);
    assert(out.includes(`${secretKey}=`), `the parameter name stays readable: ${out}`);
    if (keepKey) assert(out.includes(`${keepKey}=`), `${keepKey} is not a credential and must keep its parameter: ${out}`);
  }
  assert(!/CSRF123/.test(redacted('https://t.example/a?csrf=CSRF123')), 'the csrf VALUE must not survive a log line');
  // The other direction, and the reason the shared table has two strengths: a name that
  // merely CONTAINS a weak word is not a credential, so an ordinary target URL keeps
  // its parameters legible in the log instead of being redacted into uselessness.
  for (const url of ['https://t.example/a?postalCode=90210&sortKey=name', 'https://t.example/a?countryCode=GB&page=3']) {
    assert(redacted(url) === url, `a non-credential parameter must stay legible in a log: ${url}`);
  }
  // A URL with nothing credential-shaped is returned untouched, so a log line is not
  // spoiled for no reason, and a non-URL is passed through (never "redacted" to nothing).
  assert(redacted('https://t.example/search?q=shoes&page=3') === 'https://t.example/search?q=shoes&page=3',
    'a URL with no credential-shaped parameter is unchanged');
  assert(redacted('/relative/path?api_key=KEY1') === '/relative/path?api_key=%5Bredacted%5D',
    'a relative URL (a redirect target) is redacted too');
  assert(redacted('<audit-url>') === '<audit-url>' && redacted('') === '' && redacted(undefined) === undefined,
    'a non-URL placeholder passes through unchanged');

  // 1b. The warning for a URL the parser REJECTS (web-uplift-9lhy, web-uplift-mafp). The redactor's
  // job is hardest here, because the parser it normally relies on is the thing that rejected the
  // input, which is why this one path had grown a regex of its own: it scrubbed '[?&]name=value' only,
  // so 'https://user:secret@invalid-host:port/path' was printed with the password intact. The runner
  // is driven for REAL (--dry-run spawns no agent), because a re-statement of the fix in the test is
  // not the fix.
  //
  // The class of each row is decided by the value's SHAPE: 'withheld' when the shared rule recognises
  // a credential in the value as written OR in its whitespace-free form, 'printed' only when it
  // recognises none in either. The COMPOSITION rows are the ones two rounds of review found missing:
  // a whitespace-hidden credential AND a credential the shared rule can see, in the SAME value, in
  // both orders, with the visible one buried among benign parameters and with it in the fragment.
  // Round 2's guard returned as soon as the visible question was true, so exactly those rows printed
  // the redacted query credential alongside the whitespace-hidden password (web-uplift-mafp round 3).
  const REJECTED = [
    // [class, value, credential values that must NOT survive, the line the log must carry]
    ['withheld', 'https://user:secret@invalid-host:port/path', ['secret'], 'skipping invalid URL: [withheld:'],
    ['withheld', 'http://user:password@[invalid-ipv6]', ['password'], 'skipping invalid URL: [withheld:'],
    ['withheld', 'https://x.test:99999/?api_key=LIVEKEY123&page=2', ['LIVEKEY123'], 'skipping invalid URL: [withheld:'],
    ['withheld', 'https://us er:SECRET@invalid-host:port/path', ['SECRET'], 'skipping invalid URL: [withheld:'],
    ['withheld', 'https://user:se cret@host:99999/', ['se cret'], 'skipping invalid URL: [withheld:'],
    // A tab inside the userinfo is NOT hidden (the parser strips tabs, so the shared rule reaches it),
    // but the value still carries a credential and is withheld all the same: the decision is the shape
    // of the value, not which mechanism found it.
    ['withheld', 'https://user:secret@fail.test:99999/\tand\tmore', ['secret'], 'skipping invalid URL: [withheld:'],
    // COMPOSITION: the hidden credential first, then a visible query credential - the exact row round
    // 2 disclosed.
    ['withheld', 'https://us er:SECRET@invalid-host:port/path?api_key=OTHER', ['SECRET', 'OTHER'], 'skipping invalid URL: [withheld:'],
    // COMPOSITION: the other order, visible credential first and the hidden one in a second URL.
    ['withheld', 'https://x.test:99999/a?api_key=OTHER&next=https://us er:SECRET@h.test:99999/', ['SECRET', 'OTHER'], 'skipping invalid URL: [withheld:'],
    // COMPOSITION: the visible credential behind other parameters, so an early exit on it is reached
    // only after the value has been partly rendered.
    ['withheld', 'https://us er:SECRET@invalid-host:port/path?page=2&api_key=OTHER&lang=en', ['SECRET', 'OTHER'], 'skipping invalid URL: [withheld:'],
    // COMPOSITION: the visible credential in the FRAGMENT rather than the query.
    ['withheld', 'https://us er:SECRET@invalid-host:port/path#access_token=OTHER', ['SECRET', 'OTHER'], 'skipping invalid URL: [withheld:'],
    // Nothing credential-shaped in either form: the diagnostic is kept in full, whitespace included,
    // which is what stops the withhold rule from becoming "refuse every unparseable URL".
    ['printed', 'https://ok.test:99999/ page', [], 'skipping invalid URL: https://ok.test:99999/ page'],
    ['printed', 'https://ok.test:99999/', [], 'skipping invalid URL: https://ok.test:99999/'],
    ['printed', 'not a url at all', [], 'skipping invalid URL: not a url at all'],
    // Whitespace where the joined-up name is a WEAK word that is not a credential (sort key, postal
    // code): the over-redaction this must NOT do, asserted rather than assumed.
    ['printed', 'https://ok.test:99999/page?sort key=1', [], 'skipping invalid URL: https://ok.test:99999/page?sort key=1'],
    ['printed', 'https://ok.test:99999/page?postal code=90210', [], 'skipping invalid URL: https://ok.test:99999/page?postal code=90210'],
  ];
  const batch = spawnSync(process.execPath,
    [join(repoRoot, 'runner', 'run-batch.mjs'), '--dry-run', ...REJECTED.map(([, u]) => u), 'https://ok.test/'],
    { encoding: 'utf8', timeout: 60000 });
  assert(batch.status === 0, `a batch with invalid URLs must still run: ${batch.stderr}`);
  const printed = `${batch.stdout}\n${batch.stderr}`;
  for (const [kind, badUrl, secrets, expectedLine] of REJECTED) {
    for (const secret of secrets) {
      assert(!printed.includes(secret), `a rejected URL's credential must not reach the log ("${secret}" from ${badUrl} survived):\n${printed}`);
    }
    assert(printed.includes(expectedLine), `the log must carry "${expectedLine}" for ${badUrl}:\n${printed}`);
    // A withheld value is withheld WHOLE: not the raw form and not a partly rendered one.
    if (kind === 'withheld') {
      assert(!printed.includes(badUrl), `the withheld value must not appear at all: ${badUrl}\n${printed}`);
    }
  }
  // Exactly the withheld-class values are withheld, DERIVED from the table rather than fixed at a
  // number so that adding a legitimate case cannot be accommodated by tuning this line. It still
  // fails both failure modes: "withhold nothing" leaves credentials in the log, and "withhold
  // everything" fails the printed rows, which can only appear in full if their values are printed.
  const withheldCount = printed.split('[withheld:').length - 1;
  const expectedWithheld = REJECTED.filter(([kind]) => kind === 'withheld').length;
  assert(withheldCount === expectedWithheld,
    `exactly the ${expectedWithheld} credential-bearing values must be withheld, got ${withheldCount}:\n${printed}`);
  assert(expectedWithheld > 0 && REJECTED.some(([kind]) => kind === 'printed'),
    'the table must exercise both classes, or one of the assertions above is vacuous');

  // 2. The census. Every output line that can print a target URL must wrap it, either
  // through the URL interpolations or, when the URL rides inside a message/command, through
  // shownText/shownCommand.
  //
  // ATTACKED BY A REVIEW, and this is the shape it survived in: the first version only saw
  // a bare `${url}`, so `console.log(`[${slug}] $ ${cliArgs.join(' ')}`)` leaked the URL
  // inside the agent PROMPT without ever naming `url` - and the exemption's reason claimed
  // the echo was wrapped, which was false for that line. A console line mentioning a
  // command/prompt or a message is therefore checked too.
  //
  // STILL NOT COVERED, stated instead of implied: an alias (`const u = url`), `'x' + url`
  // concatenation, a `console.log(url)` with no interpolation, `${` split across lines, and
  // a URL carried inside an arbitrary object (`console.log(step)`). Those are human review
  // and the leak's blast radius (a CI log, not an artifact), not this scan's.
  const WRAPPERS = /shownUrl\(|shownAuditUrl\(|shownCommand\(|shownText\(|shownRefusedUrl\(/;
  // The identifier boundary matters: `${urls.length}` and `${urlsFile}` are not a target
  // URL, and the first version of this rule flagged both (the census caught its own
  // over-reach, which is why the boundary is asserted rather than assumed).
  //
  // `candidate` is on the list because web-uplift-9lhy landed ON a bare-looking warning line this
  // scan could not see: collectUrls() prints the URL it rejected by interpolating `candidate`, not
  // `url`, so the line was invisible while it printed a password in the authority. Adding the name
  // is what makes that class censused instead of reviewed by memory.
  const URL_VAR = '(?:f\\.url|url|auditUrl|candidate)';
  const INTERPOLATES_URL = new RegExp(`\\$\\{${URL_VAR}(?![a-zA-Z0-9_$])`);
  // The fix shape for the same interpolation, which the bare test above cannot see because
  // '${shownUrl(candidate)}' starts with an 's' and not with the variable name. It is stated as the
  // redacting call AROUND the variable, so wrapping the line reads as wrapped rather than as a leak.
  const WRAPPED_URL = new RegExp(`\\$\\{shown(?:Url|AuditUrl)\\(\\s*${URL_VAR}\\s*\\)\\}`);
  const CONSOLE_CALL = /\bconsole\.(?:log|error|warn|info)\(/;
  // The span rule below asks the question the bare test above cannot: is a target URL interpolated
  // into a PRINTED line through a call the redactor list does not know? '${fallbackScrub(candidate)}'
  // is the exact shape web-uplift-9lhy landed on, and the bare test saw neither the wrapper nor the
  // variable, so the line was invisible while it printed a password. Stated as
  // "url-ish identifier inside the span" plus "the span is a redacting call", so a renamed or
  // re-implemented wrapper is reported rather than whitelisted by memory.
  const URLISH_IN_SPAN = new RegExp(`(?<![a-zA-Z0-9_$.])${URL_VAR}(?![a-zA-Z0-9_$])`);
  const REDACTING_CALL = /^\s*(?:shownUrl|shownAuditUrl|shownText|shownCommand|shownRefusedUrl)\s*\(/;
  const COMMAND_ISH = /(?<![a-zA-Z0-9_$.])(?:cliArgs|agentArgs|command|cmd|prompt)(?![a-zA-Z0-9_$])/;
  const MESSAGE_ISH = /err\.message|agentError|iterationError|validation\.detail|String\(err\)/;
  // The exemption list is asserted, not implied: each entry names the file, the text,
  // and the reason it is not an output line.
  const EXEMPT = [
    {
      file: 'fixer/fix.mjs',
      match: 'then re-audit ${auditUrl} and write report.json',
      why: 'prompt STRING CONSTRUCTION (the model input itself), not a print: every site that ECHOES this prompt is wrapped, which the verbose command echo at the bottom of the file did not used to be - exactly what the review caught',
    },
    {
      file: 'runner/run-batch.mjs',
      match: 'Could not read --urls file',
      why: 'a filesystem read error for --urls: no target URL is in scope here, so the message cannot carry one (and wrapping it would have nothing to substitute)',
    },
  ];
  // The tracked sources only. The vendored .web-uplift/ tree is GENERATED (gitignored since web-uplift-diaq),
  // so it is absent on a clean checkout or in any archive, and reading it here made the census fail on a
  // tree that was perfectly correct (web-uplift-v062). Its byte-identity with these sources is owned by
  // tests/cdp-copy-sync.mjs, which fails on any byte difference or one-sided file and backs
  // npm run sync:vendored - so scanning the copy here added no coverage, and scanning it when PRESENT
  // added a worse failure: a stale copy (one predating a change to the source) reports output lines that
  // do not exist in the source at all. The coverage is therefore MOVED to cdp-copy-sync, not lost.
  const targets = ['runner/run-batch.mjs', 'fixer/fix.mjs'];
  const findings = [];
  const used = new Set();
  for (const file of targets) {
    const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
    lines.forEach((ln, i) => {
      if (ln.trim().startsWith('//') || ln.trim().startsWith('*')) return;
      // The span rule runs only on a console line, so a URL used to build a directory name
      // (`reports/fix-${slugify(auditUrl)}`) is not mistaken for a printed URL, and it is kept for
      // the assertion at the end of this scan.
      const spanLeaks = [];
      if (CONSOLE_CALL.test(ln)) {
        for (const span of ln.matchAll(/\$\{([^{}]*)\}/g)) {
          if (!URLISH_IN_SPAN.test(span[1]) || REDACTING_CALL.test(span[1])) continue;
          spanLeaks.push(span[0]);
        }
      }
      const interpolates = INTERPOLATES_URL.test(ln);
      // `${` (or String()) must be present too: `console.log('Per-iteration command the model is\n  // driven with:')` mentions "command" in a LITERAL string and is not a command echo (the
  // first version of this rule flagged it).
  const printsCommandOrMessage = CONSOLE_CALL.test(ln) && /\$\{|String\(/.test(ln) && (COMMAND_ISH.test(ln) || MESSAGE_ISH.test(ln));
      // A line is output-relevant if it interpolates the URL, echoes a command/message, or leaks a
      // URL through a wrapper this scan does not know. The last half is what makes the span rule
      // below reachable: control-tested with `${fallbackScrub(candidate)}`, the shape web-uplift-9lhy
      // landed on, which neither of the first two tests sees (the census was silent on it until this
      // term existed).
      if (!interpolates && !printsCommandOrMessage && spanLeaks.length === 0) return;
      // A bare interpolation, or a command/message echo, is satisfied by a known wrapper: the
      // redacting call around the variable covers the bare shape (WRAPPED_URL); shownText and
      // shownCommand cover a message or a command; shownUrl and shownAuditUrl cover an
      // interpolation the line names.
      const wrapped = WRAPPED_URL.test(ln)
        || (WRAPPERS.test(ln) && (!interpolates || /shown(Text|Command)\(/.test(ln)));
      const text = ln.trim();
      const exempt = EXEMPT.find((e) => e.file === file && text.includes(e.match));
      if (exempt) { used.add(file + '|' + exempt.match); return; }
      if (!wrapped && (interpolates || printsCommandOrMessage)) {
        findings.push(`${file}:${i + 1}: ${text.slice(0, 120)}`);
      }
      for (const span of spanLeaks) {
        findings.push(`${file}:${i + 1}: ${text.slice(0, 120)} [${span}]`);
      }
    });
  }
  for (const e of EXEMPT) {
    if (!used.has(e.file + '|' + e.match)) {
      findings.push(`census: the exemption for ${e.file} ("${e.match}") matched nothing - a stale exemption hides a real leak (${e.why})`);
    }
  }

  // The census's own control pair, because a scan that reports nothing and a scan that cannot
  // report look identical from the outside: the wrapper this fix introduced is accepted, and the
  // local regex it replaced is reported (web-uplift-9lhy).
  assert(URLISH_IN_SPAN.test('candidate') && REDACTING_CALL.test('shownRefusedUrl(candidate)'),
    'the census must accept the redacting call around a URL-carrying variable, including the one that withholds');
  assert(URLISH_IN_SPAN.test('fallbackScrub(candidate)') && !REDACTING_CALL.test('fallbackScrub(candidate)'),
    'and it must report the un-whitelisted wrapper that leaked the credential');
  assert(!URLISH_IN_SPAN.test('candidates.length') && !URLISH_IN_SPAN.test('urlsFile'),
    'the identifier boundary still holds: a plural or a longer name is not a target URL');
  assert(findings.length === 0,
    `log-url census: ${findings.length} output line(s) interpolate a target URL without the redacting wrapper (web-uplift-b9p/s0x). Wrap it, or add an asserted exemption with the reason:\n  ${findings.join('\n  ')}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const CASES = [
  testLogUrlRedaction,
];

// --list names this suite's cases for DECLARED_SUITE_CASES (web-uplift-yfbk), from the same array the
// runner drives, so the list cannot drift from what runs. process.exitCode, not process.exit: exit()
// does not flush asynchronous stdout on a pipe (web-uplift-ecif).
if (process.argv[1] && join(process.argv[1]) === join(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--list')) {
    for (const fn of CASES) console.log(fn.name);
    process.exitCode = 0;
  } else {
  for (const fn of CASES) await fn();
  console.log('tests OK');
  }
}
