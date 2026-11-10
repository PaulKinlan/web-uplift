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

export const gitEnvIsolationCases = [
  testASpreadEnvCannotRestoreGitDir,
  testEveryGitSpawnInTestsGoesThroughTheScrub,
  testScrubDistinguishesCodeFromStringData,
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
// whose CALLABLE NAME is code is a spawn. A spawn hidden inside a string literal is inert data - it cannot
// execute - so skipping it cannot hide a real spawn; template interpolation stays CODE, so a spawn there is
// still required to scrub. The classification is tested both ways by testScrubDistinguishesCodeFromStringData.
//
// KNOWN LIMITS, stated: (1) regex literals are delimited with the standard division-vs-regex heuristic (a /
// opens a regex after an operator, open bracket, comma, or keyword; after an identifier or closer it is division).
// A heuristic can misclassify a pathological line locally, but (2) bounds the damage: a raw NEWLINE inside a
// ' or " frame is illegal JavaScript, so the frame pops there and the scan resynchronises at the next line
// instead of poisoning the rest of the file. Template literals legitimately span lines and persist.
function maskNonExecutableContent(text) {
  // 1 = the character is content of a string literal, template text, or comment; 0 = executable code.
  const mask = new Uint8Array(text.length);
  // Frames: sq | dq | tpl (template TEXT) | interp (template ${} - executable) | line | block (comments).
  const stack = [];
  let interpBraceDepth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      if (c === '/' && text[i + 1] === '/') { stack.push('line'); mask[i] = 1; mask[i + 1] = 1; i += 2; continue; }
      if (c === '/' && text[i + 1] === '*') { stack.push('block'); mask[i] = 1; mask[i + 1] = 1; i += 2; continue; }
      if (c === '/') {
        // Division vs regex: a slash OPENS a regex when the previous significant character puts the parser in
        // expression position; after an identifier or a closer it is division. Misclassifying a pathological
        // line shifts flagging only locally, and the newline resync below bounds any damage to that line.
        let p = i - 1;
        while (p >= 0 && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n')) p -= 1;
        const prev = p >= 0 ? text[p] : '';
        const before = text.slice(0, p + 1);
        const opensRegex = prev === '' || '([{},;:=!&|?+%*-<>~^'.includes(prev) ||
          /(?:return|typeof|case|in|of|new|delete|void|do|else|yield|await)$/.test(before);
        if (opensRegex) {
          // Consume the regex body: no escapes-to-EOL semantics, just find the closing unescaped slash.
          mask[i] = 1;
          i += 1;
          while (i < text.length && text[i] !== '/') {
            if (text[i] === '\\') { mask[i] = 1; if (i + 1 < text.length) mask[i + 1] = 1; i += 2; continue; }
            if (text[i] === '\n') break; // a regex cannot span lines either; resync
            mask[i] = 1;
            i += 1;
          }
          if (text[i] === '/') { mask[i] = 1; i += 1; }
          continue;
        }
        i += 1; continue;
      }
      if (c === "'") { stack.push('sq'); mask[i] = 1; i += 1; continue; }
      if (c === '"') { stack.push('dq'); mask[i] = 1; i += 1; continue; }
      if (c === '`') { stack.push('tpl'); mask[i] = 1; i += 1; continue; }
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
  const spawnPattern = /(?:execFileSync|execFile|execSync|spawnSync|spawn|exec)\(\s*['"]git['"]/g;
  const mask = maskNonExecutableContent(text);
  const sites = [];
  let skippedNonExecutable = 0;
  for (const match of text.matchAll(spawnPattern)) {
    // The CALLABLE NAME must be code. In a real call the name is code and only the 'git' argument is a string;
    // in a negative control the whole shape - name included - is literal content, which is inert and cannot
    // spawn, so skipping it cannot hide a real spawn.
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
