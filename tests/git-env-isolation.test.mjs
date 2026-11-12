// A gate's children inherit the surrounding shell's environment, and GIT_DIR OVERRIDES cwd: an inherited GIT_*
// can point a git call at a DIFFERENT repository while every path in the call looks correct, so a census or a
// tracked-file check can answer about someone else's tree and still look authoritative (web-uplift-tax6).
//
// Measured on this VM, the gate's children really do inherit GIT_EDITOR/GIT_PAGER/GIT_SEQUENCE_EDITOR/
// GIT_MERGE_AUTOEDIT/GIT_TERMINAL_PROMPT from the shell that started the lane, so inherited GIT_* is the normal
// case here rather than a hypothetical. For that reason tests/test-helpers.mjs passes env: gitEnv() - the
// process environment with every GIT_* removed - to each spawn it makes, and the direct call sites in this
// directory do the same.
//
// These cases hold both halves of that claim, because either half alone is worthless: that the leak is real and
// would otherwise misdirect a lookup, and that a spawn through the harness is immune to it. The second case is
// the one that fails if the scrub is reverted, which is how the fix was proven rather than asserted.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitEnv, repoRoot, run, runSuite } from './test-helpers.mjs';

function makeRepo(fileName) {
  const dir = mkdtempSync(join(tmpdir(), 'tax6-git-env-'));
  const git = (args, env, opts) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv(env ?? {}, opts) });
  const init = git(['init', '-q']);
  if (init.status !== 0) throw new Error(`git init failed in ${dir}: ${init.stderr}`);
  writeFileSync(join(dir, fileName), `${fileName}\n`);
  const add = git(['add', '--', fileName]);
  if (add.status !== 0) throw new Error(`git add failed in ${dir}: ${add.stderr}`);
  return dir;
}

function listFiles(dir, env, opts) {
  const res = spawnSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8', env: gitEnv(env ?? {}, opts) });
  if (res.status !== 0) throw new Error(`git ls-files failed in ${dir}: ${res.stderr}`);
  return res.stdout.split('\n').filter(Boolean);
}

function testGitDirOverridesCwdSoTheLeakIsReal() {
  const a = makeRepo('in-a.txt');
  const b = makeRepo('in-b.txt');
  try {
    // Sanity: each repo answers about itself when nothing leaks.
    for (const [dir, expected] of [[a, 'in-a.txt'], [b, 'in-b.txt']]) {
      const own = listFiles(dir);
      if (own.length !== 1 || own[0] !== expected) {
        throw new Error(`expected ${dir} to list only ${expected} but it listed ${JSON.stringify(own)}`);
      }
    }
    // The leak: cwd points at a, the environment points at b, and git answers about b. This is why removing the
    // variable matters and why passing an explicit cwd is not enough on its own. Carrying a GIT_* is asked for
    // EXPLICITLY here (allowGitDir), because a deliberate override must be visible rather than inferred from a
    // spread - the same reasoning that made the scrub sanitise the final environment.
    const leaked = listFiles(a, { GIT_DIR: join(b, '.git') }, { allowGitDir: true });
    if (leaked.length !== 1 || leaked[0] !== 'in-b.txt') {
      throw new Error(
        `GIT_DIR must override cwd or this control proves nothing: asked about a while the environment pointed at b, ` +
          `and got ${JSON.stringify(leaked)}`,
      );
    }
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}

function testInheritedGitDirIsStrippedByTheHarness() {
  const a = makeRepo('in-a.txt');
  const b = makeRepo('in-b.txt');
  const saved = process.env.GIT_DIR;
  const savedTrace = process.env.GIT_TRACE2_EVENT;
  try {
    // Exactly the shape that breaks a gate: the surrounding environment carries a GIT_* that points elsewhere.
    // A spawn through the harness must not be able to see it.
    process.env.GIT_DIR = join(b, '.git');
    process.env.GIT_TRACE2_EVENT = '1';
    if (Object.keys(gitEnv()).some((k) => k.startsWith('GIT_'))) {
      throw new Error('gitEnv() must contain no GIT_* keys at all, or the leak can still reach a child');
    }
    const viaHarness = run('git', ['ls-files'], { cwd: a });
    if (viaHarness.status !== 0) throw new Error(`harness spawn failed: ${viaHarness.stderr}`);
    const answered = viaHarness.stdout.split('\n').filter(Boolean);
    if (answered.length !== 1 || answered[0] !== 'in-a.txt') {
      throw new Error(
        `an inherited GIT_DIR must NOT redirect a harness spawn: asked about a and got ${JSON.stringify(answered)}`,
      );
    }
    // A caller that genuinely needs a variable must ASK for it. A bare argument is not enough any more, and
    // that is deliberate: the scrub is applied to the merged result, so intent cannot be inferred from an object
    // that may simply be a spread of process.env - which is how the scrub was defeated in the first place.
    if (gitEnv({ GIT_DIR: join(b, '.git') }).GIT_DIR !== undefined) {
      throw new Error('a bare GIT_* argument must NOT survive: a spread of process.env must not be able to restore it');
    }
    if (gitEnv({ GIT_DIR: join(b, '.git') }, { allowGitDir: true }).GIT_DIR !== join(b, '.git')) {
      throw new Error('an explicitly requested GIT_* must survive, or the helper cannot express a deliberate choice');
    }
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    if (savedTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = savedTrace;
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}

// web-uplift-j176: the resync must hold for the EXACT desync shape the soundness note used to claim was
// impossible - a residual misread ('o.of /' reading 'of') on a line that also opens a multi-line template
// swallowes the template's opening backtick; the old scanner left no frame open at the newline, so the
// template's closing backtick on a later line opened a tpl frame and MASKED a real spawn two lines below.
// The resync consumes that orphan closer as content, so the spawn stays flagged. RED pre-fix (0 sites).
function testScrubResyncsATemplateSwallowedByAFakeRegex() {
  const text = [
    "const q = o.of / 2; const t = `text",
    "more text`;",
    "spawnSync('git', ['status']);",
    "const u = `tail`;",
  ].join('\n');
  const sites = findGitSpawnSites('p.mjs', text).sites;
  assert(
    sites.length === 1,
    `a spawn two lines below a misread that swallowed a template opener must still be flagged (web-uplift-j176): got ${sites.length} site(s)`,
  );
  // Control: the same shape WITHOUT the keyword-misread misread ('o.a /' is a plain property division,
  // never opened as a regex) keeps the template intact and the spawn flagged - the swallow is what the
  // resync neutralises, not the template itself.
  const control = [
    "const q = o.a / 2; const t = `text",
    "more text`;",
    "spawnSync('git', ['status']);",
    "const u = `tail`;",
  ].join('\n');
  assert(
    findGitSpawnSites('p.mjs', control).sites.length === 1,
    'the control shape (no misread) must stay flagged - the resync must not change honest classifications',
  );
  console.log('\u2714 a template opener swallowed by a misread regex body resyncs; the spawn below stays flagged');
}

export const gitEnvIsolationCases = [
  testASpreadEnvCannotRestoreGitDir,
  testEveryGitSpawnInTestsGoesThroughTheScrub,
  testScrubDistinguishesCodeFromStringData,
  testScrubResyncsATemplateSwallowedByAFakeRegex,
  testGitDirOverridesCwdSoTheLeakIsReal,
  testInheritedGitDirIsStrippedByTheHarness,
];

// Same shape as every suite here: the harness returns immediately unless this file IS argv[1], so being imported
// by the registry does not re-run these cases, and running this file directly does.
await runSuite(gitEnvIsolationCases, import.meta.url, { timeoutMs: 60000, concurrency: 1 });

// The reviewer's measurement, as a test: the scrub used to be defeated by the CALLER. gitEnv deleted GIT_* from
// process.env and then spread the caller's env over the result, so a caller passing { ...process.env } - the real
// pattern at tests/test-fast.mjs and tests/runner-agents.test.mjs - restored the inherited GIT_DIR and pointed
// the spawn at another repository again. Sanitising the FINAL merged environment is what stops that, and this
// case is the proof: it deliberately spreads process.env into the call.
function testASpreadEnvCannotRestoreGitDir() {
  const a = makeRepo('in-a.txt');
  const b = makeRepo('in-b.txt');
  const saved = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = join(b, '.git');
    const viaRun = run('git', ['ls-files'], { cwd: a, env: { ...process.env } });
    if (viaRun.status !== 0) throw new Error(`harness spawn failed: ${viaRun.stderr}`);
    const answered = viaRun.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (answered.length !== 1 || answered[0] !== 'in-a.txt') {
      throw new Error(
        `a caller spreading process.env must NOT be able to restore a GIT_DIR: asked about a and got ${JSON.stringify(answered)}`,
      );
    }
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}

// An ENUMERATION rather than a count, because a count is what let a missed site through: the first pass fixed 13
// spawns and the reviewer found more (web-uplift-rmhf measured the fixture helper in tests/test-fast.mjs). This
// walks every module under tests/ that spawns git, extracts the WHOLE call for each one by balancing parentheses,
// and requires the scrub in that call. It fails by naming the file and line, and it asserts a floor on the number
// of sites so it cannot pass by finding none at all.
//
// CODE vs STRING-LITERAL DATA (web-uplift-grde): the pattern matches TEXT, and a detector's own negative controls
// are TEXT too - chrome-cdp.test.mjs carries `spawnSites("spawnSync('git', ['status']);")`, whose literal is
// exactly the shape this scan flags, so the raw scan flagged master's own guard and went red on a clean tree.
// The fix is NOT an exemption (a broad exemption is a bypass): the scan now classifies each character as
// executable code or as non-executable content (string literals, template text, comments), and only a match
// whose CALLABLE NAME is code is a spawn. String/template/comment content cannot execute, so skipping it is
// inert - WITHIN the limits of the classifier, which are stated precisely in the soundness note above
// (web-uplift-cly2): the two known misread forms are excluded by construction, and the rest is pinned by
// testScrubDistinguishesCodeFromStringData. Template interpolation stays CODE, so a spawn there is still
// required to scrub. The classification is tested both ways by that case.
//
// THE SOUNDNESS PROPERTY, stated precisely (web-uplift-cly2): the skip decision is only as sound as the
// classifier. Its two KNOWN misread forms - a division after an identifier whose name ends in a keyword
// ('min / total' reading 'in'), and a division after postfix ++/-- - are excluded by construction (whole-
// identifier keyword test; +/- absent from the operator set) and pinned by that test, so they cannot mask a
// live spawn. A residual unknown misread is bounded by the frame resyncs: the regex-body scan stops at a
// newline and 'sq'/'dq' frames pop there, and - web-uplift-j176 - a fake regex body that swallowed an ODD
// number of backticks sets a one-shot resync so the orphaned template CLOSER out in the code is consumed
// as content instead of opening a tpl frame. Without that, a misread line could mask a real spawn up to
// the NEXT backtick - across lines (a real regex literal cannot contain a raw newline, so a newline-terminated
// body scan is always a misread, and odd backticks in it always mean a swallowed opener). The committed
// pin for the known shapes is the synthetic case testScrubDistinguishesCodeFromStringData - there is no
// standing planted-red drill; that phrase described a one-off instrument from the original fix, not code.
const SCRUB_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await',
]);
function maskNonExecutableContent(text) {
  // 1 = the character is content of a string literal, template text, or comment; 0 = executable code.
  const mask = new Uint8Array(text.length);
  // Frames: sq | dq | tpl (template TEXT) | interp (template ${} - executable) | line | block (comments).
  const stack = [];
  let interpBraceDepth = 0;
  // web-uplift-j176: one-shot resync - the next code-level backtick closes a template whose opener a
  // misread regex body swallowed, so it must not open a frame.
  let skipNextTplOpen = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      if (c === '/' && text[i + 1] === '/') { stack.push('line'); mask[i] = 1; mask[i + 1] = 1; i += 2; continue; }
      if (c === '/' && text[i + 1] === '*') { stack.push('block'); mask[i] = 1; mask[i + 1] = 1; i += 2; continue; }
      if (c === '/') {
        // Division vs regex: a slash OPENS a regex when the previous significant token puts the parser in
        // expression position. The keyword test is a WHOLE-IDENTIFIER test (a suffix match would read the
        // 'in' in 'min / total' as a keyword and misopen a regex - web-uplift-cly2), and '+' and '-' are
        // deliberately ABSENT from the operator set: 'i++ / 2' is postfix division, and where plus-slash is
        // genuinely ambiguous the guard must prefer the LOUD misread (scanning a rare regex as code can only
        // over-flag) over the SILENT one (masking a live spawn as regex body - web-uplift-cly2's defect).
        let p = i - 1;
        while (p >= 0 && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n')) p -= 1;
        const prev = p >= 0 ? text[p] : '';
        const before = text.slice(0, p + 1);
        const ident = before.match(/([A-Za-z0-9_$]+)$/);
        const opensRegex = prev === '' || '([{},;:=!&|?*<>~^'.includes(prev) ||
          (ident !== null && SCRUB_KEYWORDS.has(ident[1]));
        if (opensRegex) {
          // Consume the regex body: no escapes-to-EOL semantics, just find the closing unescaped slash.
          mask[i] = 1;
          i += 1;
          let swallowedBackticks = 0;
          while (i < text.length && text[i] !== '/') {
            if (text[i] === '\\') { mask[i] = 1; if (i + 1 < text.length) mask[i + 1] = 1; i += 2; continue; }
            if (text[i] === '\n') break; // a regex cannot span lines either; resync
            if (text[i] === '`') swallowedBackticks += 1; // web-uplift-j176: masked content, not a frame
            mask[i] = 1;
            i += 1;
          }
          if (text[i] === '/') { mask[i] = 1; i += 1; }
          // web-uplift-j176: a newline-terminated body scan is always a MISREAD (real regex literals
          // cannot span lines). An odd swallowed-backtick count means the fake body consumed a template
          // OPENING backtick whose closer is still out in the code - consume that closer as content
          // (one-shot) instead of letting it open a tpl frame that masks a real spawn across lines.
          if (text[i] === '\n' && swallowedBackticks % 2 === 1) skipNextTplOpen = true;
          continue;
        }
        i += 1; continue;
      }
      if (c === "'") { stack.push('sq'); mask[i] = 1; i += 1; continue; }
      if (c === '"') { stack.push('dq'); mask[i] = 1; i += 1; continue; }
      if (c === '`') {
        if (skipNextTplOpen) {
          // The closer of a template whose opener a misread regex body swallowed (web-uplift-j176):
          // consume it as content instead of opening a frame.
          skipNextTplOpen = false;
          mask[i] = 1;
          i += 1;
          continue;
        }
        stack.push('tpl'); mask[i] = 1; i += 1; continue;
      }
      i += 1; continue;
    }
    if (frame === 'line') {
      if (c === '\n') stack.pop(); else mask[i] = 1;
      i += 1; continue;
    }
    if (frame === 'block') {
      mask[i] = 1;
      if (c === '*' && text[i + 1] === '/') { mask[i + 1] = 1; stack.pop(); i += 2; continue; }
      i += 1; continue;
    }
    if (frame === 'sq' || frame === 'dq') {
      if (c === '\n') {
        // A raw newline inside a ' or " literal is illegal JavaScript: reaching one means the frame is a
        // scanner desync, not a real string. Pop and treat the newline as code so the damage ends at this
        // line instead of poisoning everything after it.
        stack.pop();
        i += 1; continue;
      }
      mask[i] = 1;
      if (c === '\\') { if (i + 1 < text.length) mask[i + 1] = 1; i += 2; continue; }
      if ((frame === 'sq' && c === "'") || (frame === 'dq' && c === '"')) stack.pop();
      i += 1; continue;
    }
    if (frame === 'tpl') {
      mask[i] = 1;
      if (c === '\\') { if (i + 1 < text.length) mask[i + 1] = 1; i += 2; continue; }
      if (c === '`') { stack.pop(); i += 1; continue; }
      if (c === '$' && text[i + 1] === '{') { stack.push('interp'); interpBraceDepth = 0; i += 2; continue; }
      i += 1; continue;
    }
    if (frame === 'interp') {
      // Interpolation is CODE: executable, mask stays 0. Braces, strings and nested templates inside it
      // recurse through the same stack, so a `}` inside a nested string cannot close the interpolation.
      if (c === '{') { interpBraceDepth += 1; i += 1; continue; }
      if (c === '}') {
        if (interpBraceDepth === 0) { stack.pop(); mask[i] = 1; i += 1; continue; } // the closing delimiter
        interpBraceDepth -= 1; i += 1; continue;
      }
      if (c === "'") { stack.push('sq'); mask[i] = 1; i += 1; continue; }
      if (c === '"') { stack.push('dq'); mask[i] = 1; i += 1; continue; }
      if (c === '`') { stack.push('tpl'); mask[i] = 1; i += 1; continue; }
      i += 1; continue;
    }
    i += 1;
  }
  return mask;
}

function findGitSpawnSites(file, text) {
  // Backtick is included (web-uplift-yrfb): spawn(`git`, ...) is a real spawn shape and was invisible to the
  // census when only quotes were accepted - the old gap predates the classifier but is fixed here because the
  // classifier already exists to tell executable from inert text.
  const spawnPattern = /(?:execFileSync|execFile|execSync|spawnSync|spawn|exec)\(\s*['"`]git['"`]/g;
  const mask = maskNonExecutableContent(text);
  const sites = [];
  let skippedNonExecutable = 0;
  for (const match of text.matchAll(spawnPattern)) {
    // The CALLABLE NAME must be code. In a real call the name is code and only the 'git' argument is a string;
    // in a negative control the whole shape - name included - is literal content. The classifier's known
    // misread forms are excluded by construction (see the soundness note on maskNonExecutableContent,
    // web-uplift-cly2), so a skip here means inert text; the cly2 repros in the distinguishing case pin it.
    const nameLen = match[0].indexOf('(');
    let nameIsContent = false;
    for (let k = match.index; k < match.index + nameLen; k += 1) {
      if (mask[k]) { nameIsContent = true; break; }
    }
    if (nameIsContent) { skippedNonExecutable += 1; continue; }
    // Balance parentheses from the opening call to its close, so the statement checked is this call's.
    let depth = 0;
    let index = match.index + match[0].length - 1;
    let end = index;
    for (; index < text.length; index += 1) {
      if (text[index] === '(') depth += 1;
      else if (text[index] === ')') {
        depth -= 1;
        if (depth === 0) { end = index; break; }
      }
    }
    const call = text.slice(match.index, end + 1);
    const line = text.slice(0, match.index).split('\n').length;
    sites.push({ file, line, scrubbed: call.includes('gitEnv(') });
  }
  return { sites, skippedNonExecutable };
}

function testEveryGitSpawnInTestsGoesThroughTheScrub() {
  const dir = join(repoRoot, 'tests');
  const files = readdirSync(dir).filter((name) => name.endsWith('.mjs'));
  const sites = [];
  let skipped = 0;
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const found = findGitSpawnSites(file, text);
    sites.push(...found.sites);
    skipped += found.skippedNonExecutable;
  }
  const unscrubbed = sites.filter((site) => !site.scrubbed);
  assert(
    unscrubbed.length === 0,
    `every git spawn under tests/ must pass env: gitEnv(...), and these do not: ${unscrubbed.map((s) => `${s.file}:${s.line}`).join(', ')}`,
  );
  assert(
    sites.length >= 10,
    `this control must actually find the git spawns it is guarding: it found ${sites.length}, which is too few to be the real set`,
  );
  console.log(`\u2714 all ${sites.length} git spawn(s) under tests/ scrub GIT_* through gitEnv() (${skipped} non-executable literal/comment match(es) skipped as data)`);
}

// The mechanism itself, both ways, on synthetic text (web-uplift-grde): a REAL spawn is flagged wherever it
// sits in code; the same shape inside string/template/comment content is skipped because it is inert data;
// a spawn inside template interpolation is CODE again and is flagged. The last assertions are the guardrail
// against the skip becoming a bypass: interpolation and escaped-quote forms stay in the flagged set, so
// wrapping a live spawn in string-shaped text cannot smuggle it past the scrub.
function testScrubDistinguishesCodeFromStringData() {
  const realSpawn = "const runArchive = spawnSync('git', ['archive', 'HEAD'], { cwd: repoRoot });";
  const flagged = (text) => findGitSpawnSites('synthetic.mjs', text).sites.length;

  // Flagged: code is code, whichever quoting the first argument uses.
  assert(flagged(realSpawn) === 1, 'a real unscrubbed spawnSync must be flagged');
  assert(flagged("execFileSync(\"git\", ['ls-files'], { env: cwdOnly });") === 1, 'a double-quoted real spawn must be flagged');
  assert(flagged('const run = spawnSync(`git`, [\'archive\', \'HEAD\'], { cwd: repoRoot });') === 1, 'a template-literal git argument must be flagged (web-uplift-yrfb)');

  // web-uplift-cly2 repros: a DIVISION that a sloppy heuristic would misread as a regex must NOT mask a real
  // spawn later on the same line. All three were silent false negatives before the whole-identifier keyword
  // test and the removal of +/- from the operator set.
  assert(flagged("const pct = min / total; spawnSync('git', ['status']);") === 1, 'division after an identifier ending in \'in\' must not open a regex');
  assert(flagged("const q = i++ / 2; spawnSync('git', ['status']);") === 1, 'division after postfix ++ must not open a regex');
  assert(flagged("const p = begin / n, s = spawnSync('git', ['status']);") === 1, 'division after an identifier ending in \'in\' (begin) must not open a regex');

  // Skipped: the same shapes as DATA - string literals and comments cannot spawn.
  assert(flagged("const control = \"spawnSync('git', ['status']);\";") === 0, 'a spawn shape inside a double-quoted string must be skipped');
  assert(flagged("const control = 'spawnSync(\\'git\\', [\\'status\\']);';") === 0, 'a spawn shape inside a single-quoted string must be skipped');
  assert(flagged('const control = `spawnSync(\'git\', [\'status\']);`;') === 0, 'a spawn shape inside a template literal must be skipped');
  assert(flagged('// spawnSync(\'git\', [\'status\']);') === 0, 'a spawn shape inside a line comment must be skipped');
  assert(flagged('/* spawnSync(\'git\', [\'status\']); */') === 0, 'a spawn shape inside a block comment must be skipped');
  // The REAL negative control that took master red (chrome-cdp.test.mjs:1168), verbatim shape.
  assert(
    flagged('  assert(spawnSites("spawnSync(\'git\', [\'status\']);").length === 0, \'a non-agent spawn must be accepted\');') === 0,
    'the chrome-cdp negative control must be skipped as data, not flagged',
  );
  // An escaped quote must not end the string early and un-hide the rest.
  assert(flagged("const s = 'it\\'s not spawnSync(\\'git\\');';") === 0, 'an escaped quote must not terminate a string mid-shape');

  // Still flagged: template interpolation is executable code, so the skip cannot be used as a bypass there.
  assert(flagged('const t = `${ spawnSync(\'git\', [\'status\']) }`;') === 1, 'a spawn inside template interpolation is code and must be flagged');
  assert(flagged('const t = `${ list.includes("git") ? spawnSync("git", args) : null }`;') === 1, 'a spawn inside interpolation with nested strings must be flagged');
}
