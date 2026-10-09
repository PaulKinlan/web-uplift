#!/usr/bin/env node
// Direct tests for the Modern Web Guidance catalog generator (tests/mwg-catalog.mjs), for
// web-uplift-w0y: the documented regeneration recipe used to eval the USE_CASES table it
// had just unpacked from a published npm package, on the path docs/mwg-drift-check.md sends
// the reanalysis lane down.
//
// The first assertion here is the one the old recipe fails: a table that contains an
// expression is refused AND that expression never runs (its marker file must not exist).
// The rest pin the generator's output, because a parser that is safe by dropping guides
// would be a different bug.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogRefusal, buildCatalog, parseUseCasesTable } from './mwg-catalog.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => join(repoRoot, 'tests', 'fixtures', 'mwg-catalog', name);
const generator = join(repoRoot, 'tests', 'mwg-catalog.mjs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function testMwgCatalogExtract() {
  // 1. A literal table parses as data, including single-quoted strings, comments and a
  // trailing comma. Nothing here is executable, so nothing here can be executed.
  const parsed = parseUseCasesTable(`[
    // a comment cannot execute
    { 'id': 'a', "category": 'x', "description": 'It\\'s data', "featuresUsed": ['<not-json>'], "tokenCount": 3 },
    { "id": "b", "category": "y", "featuresUsed": [], "tokenCount": 4, },
  ]`);
  assert(Array.isArray(parsed) && parsed.length === 2, `a literal table must parse: ${JSON.stringify(parsed)}`);
  assert(parsed[0].description === "It's data" && parsed[0].featuresUsed[0] === '<not-json>',
    `single-quoted strings are data: ${JSON.stringify(parsed[0])}`);

  // 1b. Template literals: the published 0.0.193 table uses backticks for some
  // descriptions, with no interpolation anywhere in it. A backtick string is data - it may
  // even span lines - but `${...}` inside one is an expression, so it is refused.
  const templated = parseUseCasesTable(
    '[\n  { "id": "a", "category": "x", "description": `line one\nline two ::before {}`, "tokenCount": 1 },\n]',
  );
  assert(templated[0].description === 'line one\nline two ::before {}' && templated[0].description.includes('\n'),
    `a template literal is data and may span lines: ${JSON.stringify(templated[0])}`);
  let interpolated = null;
  try {
    parseUseCasesTable('[ { "id": "a", "description": `x ${globalThis.process.exit(9)}` } ]');
  } catch (err) {
    interpolated = err;
  }
  assert(interpolated instanceof CatalogRefusal && /interpolation in a template literal/.test(interpolated.message),
    `an interpolation must be refused: ${interpolated && interpolated.message}`);

  // 1c. Numeric literals a real package can legitimately contain are all data: separators,
  // exponents, signs, hex/octal/binary. A refusal here would stop the lane regenerating.
  const numbers = parseUseCasesTable('[ { "a": 1_000, "b": 2e3, "c": -5, "d": .5, "e": 0x10, "f": 0o17, "g": 0b101, "h": 3.5e-2 } ]');
  assert(numbers[0].a === 1000 && numbers[0].b === 2000 && numbers[0].c === -5 && numbers[0].d === 0.5 &&
    numbers[0].e === 16 && numbers[0].f === 15 && numbers[0].g === 5 && numbers[0].h === 0.035,
    `numeric literals are data: ${JSON.stringify(numbers[0])}`);

  // 1d. true/false/null are literals. This is the class that a stray identifier reference in
  // the reader turned into a ReferenceError for any table containing one, which no fixture
  // covered until a review pointed at the line (the published table has none, so only a unit
  // case can catch it).
  const scalars = parseUseCasesTable('[ { "a": true, "b": false, "c": null } ]');
  assert(scalars[0].a === true && scalars[0].b === false && scalars[0].c === null,
    `true/false/null must parse as literals: ${JSON.stringify(scalars[0])}`);

  // 1e. Every escape JavaScript defines must decode to the value the language would produce,
  // because the alternative (flattening or dropping) silently changes the catalog text.
  const escapes = parseUseCasesTable('[ { "a": "\\x41", "b": "\\u0041", "c": "\\u{1F600}", "d": "line\\\n  continued", "e": "tab\\there", "f": "\\q" } ]');
  assert(escapes[0].a === 'A' && escapes[0].b === 'A', `hex and unicode escapes must decode: ${JSON.stringify(escapes[0])}`);
  assert(escapes[0].c === '\u{1F600}' && escapes[0].c.length === 2, `a code point escape must decode: ${JSON.stringify(escapes[0].c)}`);
  assert(escapes[0].d === 'line  continued', `a line continuation contributes nothing: ${JSON.stringify(escapes[0].d)}`);
  assert(escapes[0].e === 'tab\there', `a tab escape decodes: ${JSON.stringify(escapes[0].e)}`);
  assert(escapes[0].f === 'q', `an undefined escape drops the backslash, as JavaScript does: ${JSON.stringify(escapes[0].f)}`);
  // A malformed code point must be a NAMED refusal, not a RangeError out of
  // String.fromCodePoint (mutation-testing found the upper-bound check untested).
  for (const [table, why] of [
    ['[ "\\u{110000}" ]', 'a code point above the Unicode maximum'],
    ['[ "\\u{zz}" ]', 'a code point that is not hex'],
    ['[ "\\u{1234567}" ]', 'a code point escape with too many digits'],
    ['[ "\\x4" ]', 'a truncated hex escape'],
    ['[ "\\u12" ]', 'a truncated unicode escape'],
  ]) {
    let refused = null;
    try {
      parseUseCasesTable(table);
    } catch (err) {
      refused = err;
    }
    assert(refused instanceof CatalogRefusal && /escape/.test(refused.message),
      `the reader must refuse ${why} by name: ${refused && refused.message}`);
  }
  // The literal/identifier boundary is defence in depth rather than load-bearing: without it
  // the parser still refuses `trueish`, just with a different message (it reads `true` and
  // then fails to find a separator). Recorded here so nobody reads a passing mutation as a
  // hole - the assertion is about the refusal, which both versions produce.
  let identifier = null;
  try {
    parseUseCasesTable('[ trueish ]');
  } catch (err) {
    identifier = err;
  }
  assert(identifier instanceof CatalogRefusal, `a bare identifier must be refused: ${identifier && identifier.message}`);

  // 2. Anything that is not a literal is REFUSED, and the refusal names the reason.
  for (const [table, why] of [
    ['[ { "id": "a" }, (function () { throw new Error("boom"); })() ]', 'an expression element'],
    ['[ { "id": person } ]', 'a bare identifier'],
    ['[ { "id": "a" + "b" } ]', 'a concatenation'],
    ['[ { "id": `a${identifier}` } ]', 'an interpolating template literal'],
    ['[ { "id": "a", "__proto__": { "polluted": true } } ]', 'a prototype-polluting key'],
  ]) {
    let refused = null;
    try {
      parseUseCasesTable(table);
    } catch (err) {
      refused = err;
    }
    assert(refused instanceof CatalogRefusal, `the parser must refuse ${why}: ${table}`);
    assert(/not pure data/.test(refused.message), `the refusal must say why (${why}): ${refused.message}`);
  }

  // 2b. The reader's own structural guards, including one that only matters if the table
  // ends cleanly: mutation-testing found that disabling the trailing-content check changed
  // no test outcome, so it is asserted here.
  let trailing = null;
  try {
    parseUseCasesTable('[ { "id": "a" } ] and then some');
  } catch (err) {
    trailing = err;
  }
  assert(trailing instanceof CatalogRefusal && /trailing content/.test(trailing.message),
    `a table with content after the literal must be refused: ${trailing && trailing.message}`);
  assert(parseUseCasesTable('[ { "id": "a" } ] /* a trailing comment is not content */').length === 1,
    'a trailing comment is not trailing content');
  // The READER accepts an empty array (an empty table is well-formed data); it is the
  // catalog builder that refuses to write a catalog with no guides. The first version of this
  // block asserted a refusal it had thrown itself, so it would have passed either way
  // (web-uplift-w0y review).
  assert(JSON.stringify(parseUseCasesTable('[]')) === '[]', 'the reader accepts an empty array as data');
  let notAnArray = null;
  try {
    parseUseCasesTable('{ "id": "a" }');
  } catch (err) {
    notAnArray = err;
  }
  assert(notAnArray instanceof CatalogRefusal && /not an array/.test(notAnArray.message),
    `an object instead of an array must be refused: ${notAnArray && notAnArray.message}`);

  // 2c. buildCatalog's per-entry guards. Each of these was reachable before as a silent
  // path or an unhelpful crash; a mutation run found the category check untested.
  const guardTmp = mkdtempSync(join(tmpdir(), 'mwg-catalog-guards-'));
  const pkgWith = (name, table, guides = {}) => {
    const dir = join(guardTmp, name, 'package');
    mkdirSync(join(dir, 'skills', 'modern-web-guidance', 'guides'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'modern-web-guidance', 'modern-web.mjs'), `var USE_CASES = ${table};\n`);
    for (const [cat, files] of Object.entries(guides)) {
      mkdirSync(join(dir, 'skills', 'modern-web-guidance', 'guides', cat), { recursive: true });
      for (const [file, content] of Object.entries(files)) {
        writeFileSync(join(dir, 'skills', 'modern-web-guidance', 'guides', cat, file), content);
      }
    }
    return dir;
  };
  const fields = '"description": "d", "featuresUsed": [], "tokenCount": 1';
  const guardCases = [
    ['non-slug-category', `[ { "id": "a", "category": "../outside", ${fields} } ]`, /non-slug category/],
    ['non-slug-id', `[ { "id": "../a", "category": "x", ${fields} } ]`, /non-slug id/],
    ['duplicate-id', `[ { "id": "a", "category": "x", ${fields} }, { "id": "a", "category": "x", ${fields} } ]`, /lists a twice/],
    ['no-id', `[ { "category": "x", ${fields} } ]`, /no string id/],
    ['not-an-object', '[ 42 ]', /not an object/],
    // A changed upstream field shape must refuse rather than substitute or filter: a silent
    // default would read as a guide that lost its description, features or token count.
    ['description-missing', '[ { "id": "a", "category": "x", "featuresUsed": [], "tokenCount": 1 } ]', /no string description/],
    ['description-not-a-string', '[ { "id": "a", "category": "x", "description": 7, "featuresUsed": [], "tokenCount": 1 } ]', /no string description/],
    ['features-not-an-array', '[ { "id": "a", "category": "x", "description": "d", "featuresUsed": "nope", "tokenCount": 1 } ]', /featuresUsed that is not an array/],
    ['features-non-string-member', `[ { "id": "a", "category": "x", "description": "d", "featuresUsed": ["a", null], "tokenCount": 1 } ]`, /non-string featuresUsed member/],
    ['tokenCount-missing', '[ { "id": "a", "category": "x", "description": "d", "featuresUsed": [] } ]', /not a finite number/],
    ['tokenCount-not-a-number', '[ { "id": "a", "category": "x", "description": "d", "featuresUsed": [], "tokenCount": "9" } ]', /not a finite number/],
  ];
  // A package whose entry point has no table at all is its own case, because the helper
  // above always writes the declaration.
  const noTableDir = join(guardTmp, 'no-table', 'package');
  try {
    mkdirSync(join(noTableDir, 'skills', 'modern-web-guidance'), { recursive: true });
    writeFileSync(join(noTableDir, 'skills', 'modern-web-guidance', 'modern-web.mjs'), 'const OTHER = 1;\n');
    let refused = null;
    try {
      buildCatalog({ packageDir: noTableDir, version: '9.9.9' });
    } catch (err) {
      refused = err;
    }
    assert(refused instanceof CatalogRefusal && /does not declare/.test(refused.message),
      `a package with no USE_CASES table must be refused by name: ${refused && refused.message}`);
    // ...and a package that yields NO guides at all is refused too, rather than written as a
    // catalog whose 0-guide set would read to consumers as a total removal.
    const emptyDir = pkgWith('empty', '[]');
    let emptyRefused = null;
    try {
      buildCatalog({ packageDir: emptyDir, version: '9.9.9' });
    } catch (err) {
      emptyRefused = err;
    }
    assert(emptyRefused instanceof CatalogRefusal && /no guides at all/.test(emptyRefused.message),
      `an empty catalog must be refused: ${emptyRefused && emptyRefused.message}`);
  } catch (err) {
    if (err instanceof CatalogRefusal) throw err;
    throw err;
  }
  try {
    for (const [name, table, expected] of guardCases) {
      const dir = pkgWith(name, table, { x: { 'a.md': '# A\n' } });
      let refused = null;
      try {
        buildCatalog({ packageDir: dir, version: '9.9.9' });
      } catch (err) {
        refused = err;
      }
      assert(refused instanceof CatalogRefusal, `buildCatalog must refuse ${name}`);
      assert(expected.test(refused.message), `the refusal for ${name} must say why: ${refused.message}`);
    }
  } finally {
    rmSync(guardTmp, { recursive: true, force: true });
  }

  // 3. End to end on a real unpacked package shape: the union, the canonical ordering (a
  // file-only guide is inserted after its identical twin), the token estimate for a guide
  // with no table entry, and the sorted guideIds with their sha.
  const built = buildCatalog({ packageDir: fixture('ok'), version: '9.9.9', now: () => '2000-01-01T00:00:00.000Z' });
  assert(built.version === '9.9.9' && built.source === 'modern-web-guidance', 'the catalog carries source and version');
  assert(built.guideCount === 5, `five guides expected, got ${built.guideCount}: ${JSON.stringify(built.guideIds)}`);
  // prompt-api has no USE_CASES entry and its twin is language-model, so it must land
  // BETWEEN language-model and the entry that follows it in the table; stray-guide has no
  // twin and is appended. A mutation run showed the fixture could not tell "inserted next to
  // the twin" from "appended at the end" until omega-guide existed.
  assert(JSON.stringify(built.guides.map((g) => g.id)) === JSON.stringify(['alpha-guide', 'language-model', 'prompt-api', 'omega-guide', 'stray-guide']),
    `the twin must be inserted directly after its twin and the stray guide appended: ${JSON.stringify(built.guides.map((g) => g.id))}`);
  const twin = built.guides.find((g) => g.id === 'prompt-api');
  assert(twin.tokenCount === 20 && twin.description === 'Twin guide.' && twin.category === 'built-in-ai',
    `a twin guide inherits its twin's metadata: ${JSON.stringify(twin)}`);
  const stray = built.guides.find((g) => g.id === 'stray-guide');
  assert(stray.tokenCount === Math.round('# Stray\n'.length / 3.8) && stray.description === '',
    `a guide with no twin gets the character estimate and an empty description: ${JSON.stringify(stray)}`);
  assert(JSON.stringify(built.guideIds) === JSON.stringify(['alpha-guide', 'language-model', 'omega-guide', 'prompt-api', 'stray-guide']),
    `guideIds must be sorted: ${JSON.stringify(built.guideIds)}`);
  assert(built.guideIdsSha256 === createHash('sha256').update(built.guideIds.join('\n')).digest('hex'),
    'guideIdsSha256 must be the sha256 of the sorted ids joined by single newlines');
  assert(built.retrievedAt === '2000-01-01T00:00:00.000Z', 'a first run takes its own timestamp');
  assert(/tests\/mwg-catalog\.mjs/.test(built.regenerate), `the regenerate field must name the generator: ${built.regenerate}`);

  const tmp = mkdtempSync(join(tmpdir(), 'mwg-catalog-test-'));
  try {
    const out = join(tmp, 'catalog.json');
    const run = (args, env = {}) => spawnSync(process.execPath, [generator, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

    const first = run(['--package-dir', fixture('ok'), '--version', '9.9.9', '-o', out, '--existing', join(tmp, 'none.json')]);
    assert(first.status === 0, `the generator must succeed on a data table: ${first.status} ${first.stderr}`);
    const firstBytes = readFileSync(out, 'utf8');
    assert(JSON.parse(firstBytes).guideCount === 5, 'the written catalog must match the built one');

    // Regenerating the same version repeatedly is byte-for-byte reproducible: the timestamp
    // is preserved from the existing catalog rather than refreshed (that is what makes a
    // no-op regeneration reviewable).
    const second = run(['--package-dir', fixture('ok'), '--version', '9.9.9', '-o', out, '--existing', out]);
    assert(second.status === 0 && readFileSync(out, 'utf8') === firstBytes,
      `regenerating an unchanged version must be byte-identical: ${second.status} ${second.stderr}`);
    const bumped = run(['--package-dir', fixture('ok'), '--version', '9.9.10', '-o', out, '--existing', out]);
    assert(bumped.status === 0 && JSON.parse(readFileSync(out, 'utf8')).retrievedAt !== JSON.parse(firstBytes).retrievedAt,
      'a NEW version must take a new timestamp');

    // 4. THE ASSERTION THE OLD RECIPE FAILS. The table contains an element that writes a
    // marker file when it runs. The generator must refuse the run (exit 1, a reason on
    // stderr) and the marker must NOT exist, because no line of the table was executed.
    const marker = join(tmp, 'tripwire-marker.txt');
    const evil = run(['--package-dir', fixture('evil'), '--version', '9.9.9', '-o', join(tmp, 'evil.json')], { MWG_CATALOG_TRIPWIRE: marker });
    assert(evil.status === 1, `a table containing an expression must be refused, got exit ${evil.status}: ${evil.stdout}`);
    assert(/refused to build the catalog/.test(evil.stderr) && /not pure data/.test(evil.stderr),
      `the refusal must explain itself: ${evil.stderr}`);
    assert(!existsSync(marker), 'the eval-era failure mode: the table was EXECUTED and wrote its marker');
    assert(!existsSync(join(tmp, 'evil.json')), 'a refused run must not write a catalog');

    // 5. A hostile id must be refused rather than turned into a path.
    const traversal = run(['--package-dir', fixture('traversal'), '--version', '9.9.9', '-o', join(tmp, 'trav.json')]);
    assert(traversal.status === 1 && /non-slug id/.test(traversal.stderr),
      `a traversal id must be refused: ${traversal.status} ${traversal.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // 6. The documented path itself: the reanalysis instructions must not hand a lane an
  // eval, and every pointer (catalog doc, catalog JSON, drift runbook) must name the
  // generator, so the old recipe cannot quietly come back.
  const doc = readFileSync(join(repoRoot, 'knowledge', 'mwg-catalog.md'), 'utf8');
  const howto = doc.slice(doc.indexOf('## How to Regenerate'));
  assert(howto.length > 0, 'knowledge/mwg-catalog.md must keep a "How to Regenerate" section');
  for (const forbidden of ['eval(', 'new Function', 'node:vm', 'vm.runIn', 'runInNewContext']) {
    assert(!howto.includes(forbidden), `the regeneration recipe must not contain ${forbidden}`);
  }
  assert(howto.includes('tests/mwg-catalog.mjs'), 'the recipe must point at the committed generator');
  const catalog = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'mwg-catalog.json'), 'utf8'));
  assert(/tests\/mwg-catalog\.mjs/.test(catalog.regenerate),
    `knowledge/mwg-catalog.json regenerate must name the generator: ${catalog.regenerate}`);
  const runbook = readFileSync(join(repoRoot, 'docs', 'mwg-drift-check.md'), 'utf8');
  assert(runbook.includes('tests/mwg-catalog.mjs'),
    'docs/mwg-drift-check.md must send the reanalysis lane to the generator, not to a recipe containing an eval');
  // The catalog this repo actually ships must still be self-consistent after any edit to it.
  const guides = Array.isArray(catalog.guides) ? catalog.guides : [];
  assert(guides.length === catalog.guideCount, `catalog guideCount must match its guides array (${guides.length} vs ${catalog.guideCount})`);
  assert(JSON.stringify([...catalog.guideIds].sort()) === JSON.stringify(catalog.guideIds), 'catalog guideIds must be sorted');
  assert(createHash('sha256').update(catalog.guideIds.join('\n')).digest('hex') === catalog.guideIdsSha256,
    'catalog guideIdsSha256 must match its guideIds');
  assert(guides.every((g) => !('imageData' in g)), 'the generator must never pick up a field it was not asked for');
  // A guard on the generator itself: it must not gain an evaluator in a later edit.
  const source = readFileSync(generator, 'utf8');
  for (const forbidden of ['eval(', 'new Function', 'node:vm']) {
    assert(!source.includes(forbidden), `tests/mwg-catalog.mjs must not contain ${forbidden}`);
  }
  // And a write helper the fixture needs, so a silent no-op cannot pass the tripwire check.
  writeFileSync(join(tmpdir(), 'mwg-catalog-test-ran.marker'), 'ok');
  rmSync(join(tmpdir(), 'mwg-catalog-test-ran.marker'), { force: true });

  console.log('tests/mwg-catalog-extract.mjs: tests OK');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await testMwgCatalogExtract();
}
