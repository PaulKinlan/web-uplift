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
  const WRAPPERS = /shownUrl\(|shownAuditUrl\(|shownCommand\(|shownText\(/;
  // The identifier boundary matters: `${urls.length}` and `${urlsFile}` are not a target
  // URL, and the first version of this rule flagged both (the census caught its own
  // over-reach, which is why the boundary is asserted rather than assumed).
  const INTERPOLATES_URL = /\$\{(?:f\.url|url|auditUrl)(?![a-zA-Z0-9_$])/;
  const CONSOLE_CALL = /\bconsole\.(?:log|error|warn|info)\(/;
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
      const interpolates = INTERPOLATES_URL.test(ln);
      // `${` (or String()) must be present too: `console.log('Per-iteration command the model is\n  // driven with:')` mentions "command" in a LITERAL string and is not a command echo (the
  // first version of this rule flagged it).
  const printsCommandOrMessage = CONSOLE_CALL.test(ln) && /\$\{|String\(/.test(ln) && (COMMAND_ISH.test(ln) || MESSAGE_ISH.test(ln));
      if (!interpolates && !printsCommandOrMessage) return;
      // shownText/shownCommand cover a message or a command; shownUrl/shownAuditUrl cover an
      // interpolation the line names.
      if (WRAPPERS.test(ln) && (!interpolates || /shown(Text|Command)\(/.test(ln))) return;
      const text = ln.trim();
      const exempt = EXEMPT.find((e) => e.file === file && text.includes(e.match));
      if (exempt) { used.add(file + '|' + exempt.match); return; }
      findings.push(`${file}:${i + 1}: ${text.slice(0, 120)}`);
    });
  }
  for (const e of EXEMPT) {
    if (!used.has(e.file + '|' + e.match)) {
      findings.push(`census: the exemption for ${e.file} ("${e.match}") matched nothing - a stale exemption hides a real leak (${e.why})`);
    }
  }
  assert(findings.length === 0,
    `log-url census: ${findings.length} output line(s) interpolate a target URL without the redacting wrapper (web-uplift-b9p/s0x). Wrap it, or add an asserted exemption with the reason:\n  ${findings.join('\n  ')}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

if (process.argv[1] && join(process.argv[1]) === join(fileURLToPath(import.meta.url))) {
  await testLogUrlRedaction();
  console.log('tests OK');
}
