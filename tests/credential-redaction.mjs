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
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const REDACTED = /%5Bredacted%5D|\[redacted\]/;
function assertThrows(fn, message) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(message);
}


// ---------------------------------------------------------------------------------------------
// A structural scan for a second, locally spelled authority detector (web-uplift-wxax).
//
// The check below used to be `!source.includes('[^/?#]')`, which has both faults any literal
// character-class match has: it saw only the exact spelling the deleted line used, and it could not tell
// code from prose. The first version of this scan fixed the spelling blindness in the wrong layer. It read
// the class LEXICALLY, so /[^\x2f\x3f\x23]/ (the same detector in hex) contributed the literal 'x', '2' and
// 'f' and was invisible (web-uplift-og7y). It also kept string literals in the code view, so a string that
// merely named the import and the call satisfied both (web-uplift-85gs).
//
// Two rules follow, and they are why this is a token walk rather than a regex over the text:
//
//   1. ESCAPES ARE DECODED before a class decides what it contains, in both layers: the regex layer
//      (\xNN, \uNNNN, \u{...}, \cX, and ranges) and, for a pattern written as a string, the JavaScript
//      string layer beneath it (\\, \', \n, and that string's own hex and unicode escapes). A construct
//      that cannot be enumerated confidently FAILS LOUDLY instead of being guessed at, because silently
//      wrong members are what produced this round.
//   2. ONLY A STRING USED AS A RegExp ARGUMENT CONTRIBUTES A PATTERN, and no string reaches the code view.
//      The code view holds identifiers, keywords and punctuation only: every literal, whether string,
//      template or regex, is blanked to a space. That is what keeps a quoted mention from standing in for
//      the import and the call.
//
// The property it looks for is "this class stops at the authority terminators", which is what the removed
// detector did. Two spellings count, and the failure names whichever it saw:
//   - a NEGATED class excluding all of '/', '?' and '#' (any order, with or without extra members), which
//     is the shape the deleted line used;
//   - a POSITIVE class listing all three, that is, splitting the value at the first terminator.
// A class excluding only '/' is a path-segment class rather than an authority one and stays quiet.
//
// WHAT THIS SCAN IS NOT, so a reader meets its limits here rather than discovering them in review: it is a
// best-effort belt, NOT the authority for this guard, and it is NOT complete. It re-implements part of the
// JavaScript lexer, and every evasion found in review was one more lexing rule it had not implemented
// (escape decoding, then value versus code, then backslash parity inside a template). Unmodelled, and not
// fixable by adding cases: a pattern assembled by concatenation, by a variable, by a helper, or by
// RegExp.escape; String.raw, where escapes stay literal; flags that change what an escape means; the v
// flag's class set notation ([a-z&&[^aeiou]], [[a-z]--[aeiou]]); a class assembled by interpolating a
// template, which now refuses loudly rather than being parsed as text; and any re-derivation that writes no
// character class at all, such as splitting a value on a literal '#'. The list is open because it is "all of
// JavaScript". The runtime delegation check further down is the authority; this scan stays because it is
// cheap and it catches the literal spellings a person would actually write.
const CLASS_SHORTHANDS = new Set(['d', 'D', 's', 'S', 'w', 'W']);
const CLASS_CONTROL_CHARS = new Map([['n', '\n'], ['r', '\r'], ['t', '\t'], ['f', '\f'], ['v', '\v'], ['b', '\b']]);
const REGEX_ALLOWED_AFTER = new Set([
  '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '~', '^', '<', '>',
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'case', 'throw',
]);

function undecodable(reason) {
  throw new Error(
    `the authority scan cannot decode a construct and will not guess at it (web-uplift-og7y): ${reason}. `
    + 'Fix the scan or rewrite the pattern; do not loosen the check.');
}

const isHex = (str) => /^[0-9a-fA-F]+$/.test(str);

function codePointFrom(digits, raw, where) {
  const point = parseInt(digits, 16);
  if (!Number.isInteger(point) || point > 0x10ffff) undecodable(`the code point ${raw} in ${where}`);
  return String.fromCodePoint(point);
}

// One escape sequence inside a REGEX, starting at its backslash. Returns { ch } for a single character or
// { set: true } for a shorthand, plus how many characters the sequence occupies.
function decodeRegexEscape(pattern, i, where) {
  const next = pattern[i + 1];
  if (next === undefined) undecodable(`a trailing backslash in ${where}`);
  if (next === 'x') {
    const digits = pattern.slice(i + 2, i + 4);
    if (digits.length !== 2 || !isHex(digits)) undecodable(`\\x${digits} in ${where}`);
    return { ch: codePointFrom(digits, `\\x${digits}`, where), length: 4 };
  }
  if (next === 'u') {
    if (pattern[i + 2] === '{') {
      const close = pattern.indexOf('}', i + 3);
      if (close === -1) undecodable(`an unclosed \\u{ in ${where}`);
      const digits = pattern.slice(i + 3, close);
      if (digits.length < 1 || digits.length > 6 || !isHex(digits)) undecodable(`\\u{${digits}} in ${where}`);
      return { ch: codePointFrom(digits, `\\u{${digits}}`, where), length: close - i + 1 };
    }
    const digits = pattern.slice(i + 2, i + 6);
    if (digits.length !== 4 || !isHex(digits)) undecodable(`\\u${digits} in ${where}`);
    return { ch: codePointFrom(digits, `\\u${digits}`, where), length: 6 };
  }
  if (next === 'c') {
    const letter = pattern[i + 2];
    if (!letter || !/[A-Za-z]/.test(letter)) undecodable(`\\c without a letter in ${where}`);
    return { ch: String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64), length: 3 };
  }
  if (CLASS_SHORTHANDS.has(next)) return { set: true, length: 2 };
  if (next === 'p' || next === 'P') {
    // A Unicode property names a set this scan cannot enumerate, and some properties DO contain '/', '?'
    // or '#'. Refusing is the honest answer; treating it as empty is the silent guess this round removed.
    undecodable(`the Unicode property escape \\${next}{...} in ${where}`);
  }
  if (CLASS_CONTROL_CHARS.has(next)) return { ch: CLASS_CONTROL_CHARS.get(next), length: 2 };
  if (next === '0') {
    if (/[0-9]/.test(pattern[i + 2] ?? '')) undecodable(`the legacy octal escape \\0${pattern[i + 2]} in ${where}`);
    return { ch: '\0', length: 2 };
  }
  if (/[1-9]/.test(next) || next === 'k') undecodable(`the reference escape \\${next} inside a class in ${where}`);
  if (/[A-Za-z]/.test(next)) {
    undecodable(`the unknown escape \\${next} in ${where}: a letter escape means something and this scan does not know what`);
  }
  return { ch: next, length: 2 }; // an escaped punctuation character is that character
}

// A '${' opens an interpolation unless its '$' is preceded by an ODD number of backslashes, because each
// PAIR of backslashes is one escaped backslash: \\${x} interpolates while \${x} does not. A lookbehind for
// a single backslash got this wrong (web-uplift-pud6), so an assembled detector was read as static text.
function hasTemplateInterpolation(body) {
  for (let i = 0; i + 1 < body.length; i += 1) {
    if (body[i] !== '$' || body[i + 1] !== '{') continue;
    let backslashes = 0;
    for (let k = i - 1; k >= 0 && body[k] === '\\'; k -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return true;
  }
  return false;
}

// The JavaScript string layer beneath a pattern written as a string: '\\x2f' is the regex source \x2f, and
// '\\\\' is one backslash. Returns the string's VALUE, which is the regex source to analyse next.
function decodeStringValue(raw, quote, where) {
  const body = raw.slice(1, -1);
  if (quote === '`' && hasTemplateInterpolation(body)) undecodable(`a template literal with an interpolation in ${where}`);
  let value = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c !== '\\') { value += c; continue; }
    const next = body[i + 1];
    if (next === undefined) undecodable(`a trailing backslash in ${where}`);
    if (next === 'x') {
      const digits = body.slice(i + 2, i + 4);
      if (digits.length !== 2 || !isHex(digits)) undecodable(`\\x${digits} in ${where}`);
      value += codePointFrom(digits, `\\x${digits}`, where);
      i += 3;
      continue;
    }
    if (next === 'u') {
      if (body[i + 2] === '{') {
        const close = body.indexOf('}', i + 3);
        if (close === -1) undecodable(`an unclosed \\u{ in ${where}`);
        const digits = body.slice(i + 3, close);
        if (digits.length < 1 || digits.length > 6 || !isHex(digits)) undecodable(`\\u{${digits}} in ${where}`);
        value += codePointFrom(digits, `\\u{${digits}}`, where);
        i = close;
        continue;
      }
      const digits = body.slice(i + 2, i + 6);
      if (digits.length !== 4 || !isHex(digits)) undecodable(`\\u${digits} in ${where}`);
      value += codePointFrom(digits, `\\u${digits}`, where);
      i += 5;
      continue;
    }
    if (next === '\n') { i += 1; continue; } // a line continuation contributes nothing
    if (next === '\r') { i += body[i + 2] === '\n' ? 2 : 1; continue; }
    if (next === '0' && !/[0-9]/.test(body[i + 2] ?? '')) { value += '\0'; i += 1; continue; }
    if (/[1-9]/.test(next)) undecodable(`the legacy octal escape \\${next} in ${where}`);
    if (CLASS_CONTROL_CHARS.has(next)) { value += CLASS_CONTROL_CHARS.get(next); i += 1; continue; }
    value += next; // \\, the escaped quote, and every identity escape
    i += 1;
  }
  return value;
}

// Every character class in a pattern, escapes decoded and ranges expanded, because deciding what a class
// contains is the whole job: /[^\x2f\x3f\x23]/ excludes what /[^/?#]/ excludes, and /[\x23-\x3f]/ names the
// same three characters as a range.
function characterClassesIn(pattern, where) {
  const classes = [];
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '\\') { i += decodeRegexEscape(pattern, i, where).length; continue; }
    if (pattern[i] !== '[') { i += 1; continue; }
    const negated = pattern[i + 1] === '^';
    let j = i + (negated ? 2 : 1);
    const atoms = [];
    if (pattern[j] === ']') {
      // A leading ']' is a literal member, except in the empty-class form /[^]/ which closes right here.
      if (j + 1 >= pattern.length) {
        classes.push({ negated, members: new Set(), raw: pattern.slice(i) });
        i = pattern.length;
        continue;
      }
      atoms.push({ ch: ']', escaped: false });
      j += 1;
    }
    let closed = false;
    while (j < pattern.length) {
      const c = pattern[j];
      if (c === '\\') {
        const decoded = decodeRegexEscape(pattern, j, where);
        atoms.push(decoded.ch === undefined ? { set: true, escaped: true } : { ch: decoded.ch, escaped: true });
        j += decoded.length;
        continue;
      }
      if (c === ']') { closed = true; break; }
      atoms.push({ ch: c, escaped: false });
      j += 1;
    }
    if (!closed) undecodable(`an unclosed character class in ${where}`);
    const members = new Set();
    for (let k = 0; k < atoms.length; k += 1) {
      const start = atoms[k];
      const dash = atoms[k + 1];
      const end = atoms[k + 2];
      // A range needs an unescaped '-' between two single characters; an escaped '-' is a literal hyphen.
      if (start.ch !== undefined && dash && dash.ch === '-' && dash.escaped === false && end && end.ch !== undefined) {
        const low = start.ch.codePointAt(0);
        const high = end.ch.codePointAt(0);
        if (low <= high) for (let point = low; point <= high; point += 1) members.add(String.fromCodePoint(point));
        k += 2;
        continue;
      }
      if (start.set) continue; // a shorthand names characters but none of them as a literal
      members.add(start.ch);
    }
    classes.push({ negated, members, raw: pattern.slice(i, j + 1) });
    i = j + 1;
  }
  return classes;
}

// One token walk. Comments become a space so prose can neither satisfy nor trip a check. Every literal is
// blanked out of the code view. A string handed to RegExp is decoded and collected as a pattern; a string
// that is an import specifier is recorded against that import; every other string contributes nothing.
function scanAgentSource(source) {
  const regexPatterns = [];
  const imports = [];
  let code = '';
  let i = 0;
  let prev = '';
  let pendingImport = null;
  let expectSpecifier = false;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      code += ' ';
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      code += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      i += 1;
      while (i < source.length && source[i] !== c) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      const raw = source.slice(start, i);
      const short = raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
      const where = `the string ${short}`;
      if (/(?:^|[^A-Za-z0-9_$.])RegExp\s*\(\s*$/.test(code)) {
        regexPatterns.push({ pattern: decodeStringValue(raw, c, where), where: `new RegExp(${short})` });
      } else if (expectSpecifier && pendingImport) {
        pendingImport.specifier = decodeStringValue(raw, c, where);
        imports.push(pendingImport);
        pendingImport = null;
        expectSpecifier = false;
      }
      code += ' ';
      prev = 'x'; // a literal is a value, so a following '/' divides
      continue;
    }
    if (c === '/' && REGEX_ALLOWED_AFTER.has(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const ch = source[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        else if (ch === '\n') break;
        j += 1;
      }
      if (source[j] === '/') {
        const pattern = source.slice(i + 1, j);
        j += 1;
        while (j < source.length && /[a-z]/i.test(source[j])) j += 1;
        regexPatterns.push({ pattern, where: `the regex literal /${pattern}/` });
        code += ' '; // a regex literal is a value as well, not code
        i = j;
        prev = 'x';
        continue;
      }
    }
    if (/\s/.test(c)) { code += c; i += 1; continue; }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      if (word === 'import') { pendingImport = { names: [], specifier: null }; expectSpecifier = false; }
      else if (pendingImport && word === 'from') expectSpecifier = true;
      else if (pendingImport) pendingImport.names.push(word);
      prev = word;
      code += word;
      i = j;
      continue;
    }
    if (c === ';') { pendingImport = null; expectSpecifier = false; }
    prev = c;
    code += c;
    i += 1;
  }
  return { code, regexPatterns, imports };
}

// The findings as text, so a failure names what it saw rather than only failing.
function authorityBoundRegexesIn(source) {
  const findings = [];
  for (const { pattern, where } of scanAgentSource(source).regexPatterns) {
    for (const { negated, members, raw } of characterClassesIn(pattern, where)) {
      const named = ['/', '?', '#'].filter((t) => members.has(t));
      if (named.length !== 3) continue;
      findings.push(`${where} ${negated ? 'excludes' : 'lists'} ${named.join('')} in ${raw}`);
    }
  }
  return findings;
}

// Both requirements read the TOKEN WALK, not the text: the import has to be a real import statement and the
// call has to be real code, and no literal survives in the code view to stand in for either.
const importsSharedRule = (scan) => scan.imports.some((entry) => entry.names.includes('carriesAuthorityUserinfo')
  && /(^|\/)credential-terms\.mjs$/.test(entry.specifier || ''));
const callsSharedRule = (scan) => /\bcarriesAuthorityUserinfo\s*\(/.test(scan.code);

// ---------------------------------------------------------------------------------------------
// THE RUNTIME DELEGATION CHECK. This is the AUTHORITY for this guard (web-uplift-pud6 and the shape
// question it raised); the source scan above is the belt.
//
// The property this guard exists for is a RUNTIME property: that the proxy sanitiser ASKS the shared rule
// instead of answering the question itself. Reading source can only ever approximate that, and three rounds
// of review proved the approximation leaky. So this observes it instead. The shared module is loaded behind
// a counting wrapper, the runner's real sanitiser is driven over shapes where the shared rule and a locally
// re-derived narrower detector DISAGREE, and two things are asserted: that the shared predicate was
// INVOKED, and that its answer, not a re-derivation, decided the OUTCOME. Spelling cannot evade this,
// because it watches behaviour rather than syntax, and neither can a re-implementation, because a runner
// that answers locally does not call the shared rule at all.
//
// HOW. A module load hook serves a wrapper in place of evidence/credential-terms.mjs. The wrapper
// re-exports everything from the real file (an explicit export takes precedence over the star export) and
// wraps carriesAuthorityUserinfo so each call is recorded. That runs in a child process, because a hook has
// to be in place before the first load of the shared module and this suite shares a process with others.
const DELEGATION_SHAPES = [
  ['a proxy with no credential', 'http://proxy.invalid:8080'],
  ['parsed userinfo', 'http://user:pw@proxy.invalid:8080'],
  ['userinfo truncated by #', 'http://user:pw#x@proxy.invalid:8080'],
  ['userinfo truncated by ?', 'http://user:pw?x@proxy.invalid:8080'],
  ['a protocol-relative reference', '//user:pw@proxy.invalid:8080'],
  ['an @ in the PATH of a parseable URL', 'https://x.test:8080/a/b@2x.png'],
  // The class ck2s named: the first terminator comes BEFORE the '@', and the redactor leaves the value
  // alone, so a narrow detector's error survives to the output instead of being repaired downstream.
  ['an @ in the path of an UNPARSEABLE proxy', 'proxy.invalid:8080/a/b@2x.png'],
  ['an @ after a slash, another host and port', 'cache.invalid:3128/p@th'],
  // Measured NOT to discriminate, kept so nobody re-adds it believing it does (I did, and the precondition
  // assertion below caught me): this value has no terminator at all, so a narrow detector takes the WHOLE
  // value as the authority, finds the '@', and gets this shape right.
  ['a malformed proxy the narrow rule also gets right', 'proxy.invalid:8080@attacker.invalid'],
  // The shape web-uplift-i5f4 fixed, kept in the delegation table because it is the branch that CHANGED: an
  // empty userinfo on a value the parser rejects now passes through, and the general loop below asserts that
  // this is the SHARED rule's answer (the probe records the call) rather than a local one.
  ['an unparseable proxy with an EMPTY userinfo', 'https://@host:99999'],
];

function runDelegationProbe() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sharedUrl = pathToFileURL(resolve(root, 'evidence/credential-terms.mjs')).href;
  const runnerUrl = pathToFileURL(resolve(root, 'runner/agents.mjs')).href;
  const dir = mkdtempSync(join(tmpdir(), 'web-uplift-delegation-'));
  try {
    writeFileSync(join(dir, 'wrapper.mjs'), [
      `export * from ${JSON.stringify(`${sharedUrl}?probe=1`)};`,
      `import { carriesAuthorityUserinfo as real } from ${JSON.stringify(`${sharedUrl}?probe=1`)};`,
      'export const __sharedCalls = [];',
      'export function carriesAuthorityUserinfo(input) { __sharedCalls.push(input); return real(input); }',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'bootstrap.mjs'), [
      "import { registerHooks } from 'node:module';",
      "import { readFileSync } from 'node:fs';",
      `const REAL = ${JSON.stringify(sharedUrl)};`,
      `const WRAPPER = readFileSync(${JSON.stringify(join(dir, 'wrapper.mjs'))}, 'utf8');`,
      'registerHooks({',
      '  load(url, context, nextLoad) {',
      '    if (url === REAL) return { format: \'module\', source: WRAPPER, shortCircuit: true };',
      '    return nextLoad(url, context);',
      '  },',
      '});',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'driver.mjs'), [
      `const shared = await import(${JSON.stringify(sharedUrl)});`,
      // The real answers come from an UNINSTRUMENTED instance, or the probe's own questions would fill the
      // call log and make the delegation assertion vacuous (it did, until this line existed).
      `const expected = await import(${JSON.stringify(`${sharedUrl}?uninstrumented=1`)});`,
      `const runner = await import(${JSON.stringify(runnerUrl)});`,
      `const shapes = ${JSON.stringify(DELEGATION_SHAPES)};`,
      'const outcomes = {};',
      'shared.__sharedCalls.length = 0;',
      'for (const [name, value] of shapes) {',
      "  const built = runner.buildAgentEnv({ env: { HOME: '/tmp/home', HTTPS_PROXY: value }, warn: () => {} });",
      '  outcomes[name] = { sharedSays: expected.carriesAuthorityUserinfo(value), '
      + 'passed: built.HTTPS_PROXY ?? null, redactorLeavesIt: expected.redactUrlCredentialValues(value) === value };',
      '}',
      'process.stdout.write(JSON.stringify({ calls: shared.__sharedCalls, outcomes }));',
      '',
    ].join('\n'));
    const run = spawnSync(process.execPath,
      ['--import', pathToFileURL(join(dir, 'bootstrap.mjs')).href, join(dir, 'driver.mjs')],
      { encoding: 'utf8', timeout: 60000 });
    if (run.status !== 0) {
      throw new Error(
        `the runtime delegation probe did not run (status ${run.status}, ${run.error ? run.error.code : 'no error'}). `
        + `This IS the guard, so it fails loudly rather than passing silently. stderr: ${(run.stderr || '').slice(0, 500)}`);
    }
    return JSON.parse(run.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function testCredentialRedactorsAgree() {
  const cli = await import('../evidence/cli.mjs');
  const flow = await import('../runner/flow-record.mjs');
  const terms = await import('../evidence/credential-terms.mjs');

  // 11. The shared rule OWNS the question "does this value carry userinfo", and the proxy env sanitiser must
  // ask it rather than keeping a second, narrower detector (web-uplift-2rw1). The defect stayed invisible
  // because both notions agreed on the values anyone looked at: the sanitiser ended the authority at the
  // first '/?#', so userinfo truncated by '#' or '?' was invisible to it, and it withheld such a value only
  // because this module had already rewritten the value first. The guard has two halves - this table pins
  // what the shared answer IS, and the source check pins that the sanitiser still asks for it.
  const P = 'p' + 'w';
  assert(terms.carriesAuthorityUserinfo(`http://user:${P}@proxy.invalid:8080`) === true,
    'parsed userinfo is userinfo');
  assert(terms.carriesAuthorityUserinfo('http://user@proxy.invalid:8080') === true,
    'a username with no password is still userinfo');
  assert(terms.carriesAuthorityUserinfo('http://proxy.invalid:8080/?next=a@b') === false,
    'an @ in the QUERY of a parseable URL is not userinfo - the shape a wider text rule would wrongly withhold');
  assert(terms.carriesAuthorityUserinfo(`http://user:${P}#x@proxy.invalid:8080`) === true,
    'userinfo truncated by # is still userinfo, which is exactly what the private narrower detector could not see');
  assert(terms.carriesAuthorityUserinfo(`http://user:${P}?x@proxy.invalid:8080`) === true,
    'and so is userinfo truncated by ?');
  assert(terms.carriesAuthorityUserinfo('http://@proxy.invalid:8080') === false,
    'an EMPTY userinfo is not a credential; the sweep makes the same distinction, so the sanitiser must not report one removed');
  assert(terms.carriesAuthorityUserinfo(`//user:${P}@proxy.invalid:8080`) === true,
    'a protocol-relative reference is judged through the same base this module redacts through');
  assert(terms.carriesAuthorityUserinfo('https://x.test:99999/a/b@2x.png') === true,
    'an unparseable value whose run contains @ reads as userinfo to the sweep, and this must agree with it');
  assert(terms.carriesAuthorityUserinfo('https://x.test:8080/a/b@2x.png') === false,
    'but a PATH @ on a value the parser ACCEPTS is not userinfo');
  // The EMPTY-userinfo family on the route the parser REJECTS (web-uplift-i5f4). This route counted the text
  // before the '@' by LENGTH, so the scheme itself ('https://') read as a username and every value below came
  // back true - while the parsed route, pinned two assertions above, already called the same shape
  // credential-free, and the sweep effectively does too (it replaces each empty half with nothing, leaving
  // these values BYTE-IDENTICAL). Each row asserts the answer AND that the two halves of the module now
  // agree, because the DISAGREEMENT, not the direction of the answer, is what was filed.
  for (const [value, why] of [
    ['https://@host:99999', 'the scheme before the @ is not a username'],
    ['http://@host:99999', 'and the same for http'],
    ['https://@[bad', 'a value that is not even an authority'],
    ['https://@host:99999/', 'with a path'],
    ['https://:@host:99999', 'an all-empty userinfo written with its colon'],
    ['//:@host:99999', 'and the protocol-relative spelling'],
  ]) {
    assert(terms.carriesAuthorityUserinfo(value) === false,
      `an EMPTY userinfo is not a credential on the unparseable route either (${why}): ${value}`);
    assert(terms.redactUrlCredentialValues(value) === value,
      `and the redactor must have nothing to do to it, or the predicate is contradicting the sweep: ${value}`);
  }
  // THE PRODUCT, which is what two consecutive rounds on the caller's sibling change each missed by testing one
  // axis at a time: scheme x userinfo x host, the answer decided by the userinfo cell, asserted on BOTH routes
  // (a parseable host answers through the parsed authority, a rejected port through the run rule). The
  // invariant is asserted in BOTH directions - credential-bearing IF AND ONLY IF the redactor changes the
  // value - so a route that drifts either way fails here rather than in a caller.
  for (const [userinfoName, userinfo, carries] of [
    ['an empty userinfo', '', false],
    ['an all-empty userinfo with a colon', ':', false],
    ['a username only', 'user', true],
    ['a username and password', 'user:pw', true],
    ['a password with no username', ':pw', true],
  ]) {
    for (const scheme of ['http://', 'https://']) {
      for (const host of ['host:8080', 'host:99999', '[bad']) {
        const value = `${scheme}${userinfo}@${host}`;
        assert(terms.carriesAuthorityUserinfo(value) === carries,
          `${userinfoName} at ${host} must read as ${carries ? 'a credential' : 'NO credential'}: ${value}`);
        assert((terms.redactUrlCredentialValues(value) !== value) === carries,
          `the two routes must agree about ${userinfoName} at ${host}, and the redactor's own verdict is the second half: ${value}`);
      }
    }
  }
  const agentsSource = readFileSync(new URL('../runner/agents.mjs', import.meta.url), 'utf8');
  const agentsScan = scanAgentSource(agentsSource);
  assert(importsSharedRule(agentsScan),
    'the proxy sanitiser must IMPORT the userinfo question from the shared rule, not answer it locally');
  assert(callsSharedRule(agentsScan),
    'and it must actually CALL that rule: importing it and then deciding locally is still a second detector');
  // POSITIVE control: a detector spelled differently must fail however it is written, INCLUDING when its
  // class is written with escapes, which is exactly how the first version of this scan was evaded.
  for (const spelling of [
    'const re = /[^/?#]/;',
    'const re = /[^?#/]/;',
    'const re = /[^\\s/?#]+/;',
    "const re = new RegExp('[^/?#]');",
    'const re = /[/?#]/;',
    'const re = /[^\\x2f\\x3f\\x23]/;', // web-uplift-og7y: the same exclusion in hex
    'const re = /[^\\u002f\\u003f\\u0023]/;', // and in unicode escapes
    'const re = /[^\\u{2f}\\u{3f}\\u{23}]/;', // and in the code-point form
    'const re = /[\\x23-\\x3f]/;', // and as a range spanning the terminators
    "const re = new RegExp('[^\\\\x2f\\\\x3f\\\\x23]');", // and double-escaped through a string
  ]) {
    assert(authorityBoundRegexesIn(spelling).length === 1,
      `the scan must catch a second authority detector whatever its spelling: ${spelling}`);
  }
  // NEGATIVE control: classes that are not authority shaped, so the scan stays precise rather than loud.
  for (const innocent of [
    'const re = /[^/]/;', // a path segment, not an authority
    'const re = /[?#]/;', // two terminators, not the boundary shape
    'const re = /^https?:\\/\\//;',
    'const re = /foo\\/bar/;',
    'const re = /[\\x00-\\x1f]/;', // a range that does not reach any terminator
    'const re = /[^\\d\\s]/;', // shorthands name no literal character
  ]) {
    assert(authorityBoundRegexesIn(innocent).length === 0,
      `a class that is not authority shaped must stay quiet: ${innocent}`);
  }
  // NEGATIVE control: prose that mentions the class must not trip it, which is the fault this fixes.
  for (const prose of [
    '// the deleted detector ended the authority at [^/?#], do not bring it back',
    '/* [^/?#] was removed in web-uplift-2rw1 */',
    'const note = "[^/?#]";',
  ]) {
    assert(authorityBoundRegexesIn(prose).length === 0,
      `prose that merely mentions the class must not trip the guard: ${prose}`);
  }
  // NEGATIVE control for web-uplift-85gs: a string that NAMES the import and the call must satisfy neither,
  // because a quoted mention is not code. These are the two predicates the guard above uses.
  const fakeMentions = [
    'const note = "import { carriesAuthorityUserinfo } from \'../evidence/credential-terms.mjs\'";',
    'const also = "carriesAuthorityUserinfo(value)";',
  ].join('\n');
  const fakeScan = scanAgentSource(fakeMentions);
  assert(!importsSharedRule(fakeScan),
    'a string that merely NAMES the import must not satisfy the import requirement (web-uplift-85gs)');
  assert(!callsSharedRule(fakeScan),
    'and a string that merely NAMES the call must not satisfy the call requirement either');
  // and the same predicates are not merely always false: a real import and a real call satisfy both.
  const realShaped = 'import { carriesAuthorityUserinfo } from "../evidence/credential-terms.mjs";\n'
    + 'const value = carriesAuthorityUserinfo(input);\n';
  const realShapedScan = scanAgentSource(realShaped);
  assert(importsSharedRule(realShapedScan) && callsSharedRule(realShapedScan),
    'a real import and a real call must satisfy both requirements, or the guard passes for the wrong reason');
  // A construct that cannot be enumerated fails LOUDLY rather than being counted as empty, which is the
  // behaviour that lets an authority class through invisibly (web-uplift-og7y).
  assertThrows(() => authorityBoundRegexesIn('const re = /[^\\p{ASCII}]/;'),
    'a Unicode property escape names a set the scan cannot enumerate, so it must fail loudly rather than guess');
  assertThrows(() => authorityBoundRegexesIn('const re = /[^\\x2g]/;'),
    'a malformed hex escape must fail loudly rather than contribute the wrong members');
  // The prose control compares AGAINST the real source's own result, so it isolates the thing it is testing:
  // prose must not ADD findings. Asserting zero here instead would have turned every real detector into a
  // failure reported under the prose message, which is how it first behaved.
  const realFindings = authorityBoundRegexesIn(agentsSource);
  assert(authorityBoundRegexesIn(`${agentsSource}\n// the removed detector used [^/?#], recorded here\n`).length === realFindings.length,
    'prose that merely mentions the class must not add findings when it sits in the real source');
  // The guard itself: no authority-shaped class, in any spelling, in the file as it stands.
  assert(realFindings.length === 0,
    `the sanitiser must not keep its own /?#-bounded authority detector, in any spelling: ${realFindings.join('; ')}`);

  // THE RUNTIME DELEGATION CHECK, the authority for this guard. It observes behaviour, so no spelling can
  // evade it, and a runner that answers the question locally is caught because it never asks.
  const probe = runDelegationProbe();
  const probeBlob = JSON.stringify(probe);
  for (const [name, value] of DELEGATION_SHAPES) {
    const outcome = probe.outcomes[name];
    assert(outcome, `the probe must report an outcome for ${name}: ${probeBlob}`);
    assert(probe.calls.includes(value),
      `the runner must ASK the shared rule about ${name}, and the probe recorded no call with that value: ${probeBlob}`);
    if (outcome.sharedSays) {
      assert(outcome.passed === null || !outcome.passed.includes('@'),
        `${name} carries userinfo per the shared rule, so it must not reach the child intact: ${probeBlob}`);
    } else {
      assert(outcome.passed === value,
        `${name} is not userinfo per the shared rule, so it must pass through byte-identical: ${probeBlob}`);
    }
  }
  // The two shapes a locally re-derived narrower detector (the 2rw1 defect) got WRONG, asserted by name so
  // the failure says which regression came back rather than only that something did.
  for (const name of ['userinfo truncated by #', 'userinfo truncated by ?']) {
    const outcome = probe.outcomes[name];
    assert(outcome.sharedSays === true,
      `${name} must read as userinfo to the shared rule, or this guard is testing the wrong shapes: ${probeBlob}`);
    assert(outcome.passed === null,
      `${name} is userinfo the parser cannot strip, so it must be WITHHELD; the 2rw1 detector ended the authority `
      + `at the first /?#, read it as credential-free, and would have passed the value through: ${probeBlob}`);
  }

  // THE CLASS ASSERTION (web-uplift-ck2s). An outcome assertion only discriminates where a wrong
  // implementation's error SURVIVES to the observed output, so the shapes that matter are the ones where the
  // first terminator comes BEFORE the '@' AND the redactor leaves the value byte-identical: nothing
  // downstream repairs the narrow answer, so the shared rule withholds while a detector that ended the
  // authority at the first /?# reads no userinfo and lets the value through intact. The preconditions are
  // asserted with the outcome, so if a future change makes the redactor touch these values, this fails
  // saying the class no longer tests anything rather than quietly passing.
  for (const name of ['an @ in the path of an UNPARSEABLE proxy', 'an @ after a slash, another host and port']) {
    const value = DELEGATION_SHAPES.find(([n]) => n === name)[1];
    const outcome = probe.outcomes[name];
    const terminator = Math.min(...['/', '?', '#'].map((ch) => {
      const at = value.indexOf(ch);
      return at === -1 ? value.length : at;
    }));
    assert(terminator < value.indexOf('@'),
      `${name} must keep its @ AFTER the first /?#, or it has left the class this assertion exists for: ${probeBlob}`);
    assert(outcome.redactorLeavesIt === true,
      `${name} must stay byte-identical through redactUrlCredentialValues; if the redactor now repairs it, a narrow `
      + `detector is hidden again by the follow-up check and this shape stops discriminating (ck2s): ${probeBlob}`);
    assert(outcome.sharedSays === true,
      `${name} must read as userinfo to the shared rule, through its run rule for an unparseable value: ${probeBlob}`);
    assert(outcome.passed === null,
      `${name} must be WITHHELD. A detector that ended the authority at the first /?# (web-uplift-2rw1) reads the `
      + `authority, finds no @, and lets the value reach the child intact, and THAT difference, not any other, is `
      + `what makes this a check rather than a decoration: ${probeBlob}`);
  }

  // CONTROL for the scanner's own pitfall (web-uplift-pud6): a template whose interpolation supplies the
  // terminators is a RUNTIME pattern, so it must refuse loudly rather than be parsed as static text.
  assertThrows(() => authorityBoundRegexesIn('const c = "\\x2f\\x3f\\x23"; const re = new RegExp(`[^\\\\${c}]`);'),
    'an interpolated template pattern must fail loudly, even when the interpolation is preceded by an escaped backslash');
  assertThrows(() => authorityBoundRegexesIn('const re = new RegExp(`[^${din}]`);'),
    'an interpolated template pattern must fail loudly');

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
    // The anti-regression for the quadratic defect. It used to assert that four times the input must
    // not cost more than eight times the work, using a ratio for machine-independence. That ratio is
    // gone, and both attempts at this fixture are worth recording so nobody rebuilds either one:
    //   - An absolute bound was tried first and was a placebo, because a shape-identical quadratic
    //     still passed it: V8 vectorises the character search, and 8e8 byte-scans fit inside a second.
    //     That was a failure of WHERE the bound sat, not of absolute bounds in general: 8e8 byte-scans
    //     is what a quadratic costs at 40 kB, which is the size that fits inside a one second bound.
    //   - The ratio that replaced it could not be made to mean anything either, measured both ways:
    //     with Date.now() the small sample read 0 ms and the floor turned the ratio into about 0.5 so
    //     it could not fail; with process.cpuUsage(), which does resolve these durations (a 20 us busy
    //     loop reports 0.023 ms), the ratio ranged from 1.42 to 8.01 over ten runs of this test and
    //     tripped the threshold once. The spread is warm-up: the first redactor measured is still being
    //     optimised while the second settles at 4.1 to 4.7. A ratio whose noise spans its own threshold
    //     is not a guard, and one that fails a run in ten is worse than one that never failed.
    // What is left is the assertion that can be trusted, at a size where the regression cannot hide. This
    // fixture costs 1.1 to 6 ms linear, and a genuinely quadratic scan of the same shape measured at
    // about 92 s at this size (fitted from 1.4 s at 20 kB and 5.8 s at 40 kB), so the bound below sits
    // about 800x above the real cost and 18x below the regression. Cost, stated rather than hidden: a
    // MILD superlinearity is not detected here. It never was.
    const measure = (length) => {
      const input = `https://x.test:99999${'/'.repeat(length)}`;
      const started = Date.now();
      redactor(input);
      return Date.now() - started;
    };
    const large = measure(160000);
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
    // An ABSOLUTE budget at BOTH sizes, not a wall-clock ratio between them (web-uplift-tb6p).
    //
    // The ratio this replaces compared 160 kB against 640 kB and asserted that 4x the input costs
    // under 8x the time. Measured on this VM, that ratio cannot separate the regression it was
    // written for from a busy machine. A linear sweep sits at about 4.0 on a quiet box (40 samples,
    // p50 3.86, max 4.83), but under the parallel load the gate itself now creates, the SAME code
    // produces ratios of 8.9, 10.0 and 11.4 at concurrency 3 and up to 16 under 6-way CPU load.
    // The reason is that the 640 kB measurement is memory-bound while the 160 kB one stays in cache,
    // so contention inflates the large one about 4x; that is bandwidth, not scheduling, because the
    // CPU time inflates the same way (27 ms becomes 97 ms). A quadratic lands near 16. Noise that
    // reaches 16 against a signal of 16 is not a guard, at any threshold: raising the 8 to clear the
    // noise would pass the defect, and leaving it at 8 fails a quiet-intent assertion on a busy box.
    //
    // What the ratio protected is real, and it is catastrophic rather than marginal, so the budget
    // below still catches it. Rather than assume that, I measured a genuinely quadratic scan of this
    // fixture shape: 1.4 s at 20 kB and 5.8 s at 40 kB (x4.1 per doubling), which fits to about 92 s
    // at 160 kB and 1,480 s at 640 kB, against 1 ms and 4 ms for the linear sweep. A 5 s budget
    // therefore sits roughly 300x below the regression at 640 kB and more than 10x above the worst
    // load inflation measured, so the assertion still catches the defect it exists for and no longer
    // asserts how quiet this VM is. It is also why the small-size bound above already caught the
    // documented four-spelling version on its own: that one took tens of seconds at 160 kB.
    //
    // The cost, stated plainly: a MILD superlinearity, say 8x, is no longer detected. In practice it
    // never was, because that is the same band the load noise occupies.
    assert(manyLarge < 5000,
      `the sweep must stay linear with MANY authority starts: 640 kB took ${manyLarge}ms, past the budget`);
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
    // (f) Why the run is NOT narrowed to "extend past '?'/'#' only when no '/' precedes the delimiter",
    // which is the obvious next refinement and was raised in review as an over-redaction P2. A password
    // containing BOTH a '/' and a '?' HAS a slash before the delimiter, so that refinement declines to
    // extend the run and the credential survives - measured on a mutant that implements it, not reasoned.
    // The over-redaction in (e) is the price of not leaking this shape, and the bias toward redacting is
    // the one this file already states for the '/' case above.
    const bothDelims = `https://user:p/x${'?'}y@x.test`;
    assert(!redactor(bothDelims).includes('p/x?y'),
      `a password containing both / and ? must not survive, which is why the run is not narrowed: ${redactor(bothDelims)}`);
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
