#!/usr/bin/env node
// Modern Web Guidance catalog generator: builds knowledge/mwg-catalog.json from an
// unpacked modern-web-guidance package directory.
//
// This exists because the "How to Regenerate" recipe in knowledge/mwg-catalog.md used to
// unpack the published package and EVALUATE its USE_CASES array in the operator's own Node
// process (the table was handed straight to eval), so anything the package shipped inside that
// array ran with the operator's privileges. That is the same mistake b0227d0 removed from
// the drift classifier, and docs/mwg-drift-check.md sends the reanalysis lane down this
// documented path (web-uplift-w0y).
//
// The table is DATA. It is read here by a strict, data-only parser that accepts string,
// number, boolean, null, array and object literals (with comments and trailing commas
// tolerated, because those cannot execute) and REFUSES anything else - a call, an
// operator, a bare identifier, a template literal. There is no eval, no Function and no
// a module evaluator in this file, and the test suite asserts that; a malformed or hostile
// table fails the run instead of running.
//
// Usage:
//   node tests/mwg-catalog.mjs --package-dir <unpacked-package-dir> --version <x.y.z>
//                              [-o <catalog.json>] [--existing <catalog.json>]
//
// --existing is the catalog to preserve `retrievedAt` from when its version already
// matches, so regenerating an unchanged upstream version is byte-for-byte reproducible
// (default: knowledge/mwg-catalog.json).
//
// Exit codes:
//    0: Success (catalog written).
//    1: Failure: unreadable package, no USE_CASES table, or a table that is not pure data
//       (fail-closed: this tool never executes package code to make progress).
//   64: Usage error.
//
// Nothing here is vendored into .web-uplift/: this is a maintainer tool for regenerating a
// knowledge artefact, not something an audited project runs (tests/cdp-copy-sync.mjs holds
// the vendored list).

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_EXISTING = join(repoRoot, 'knowledge', 'mwg-catalog.json');

// The guidance package's table entry point, relative to the unpacked package root.
const ENTRY_RELATIVE = join('skills', 'modern-web-guidance', 'modern-web.mjs');
const GUIDES_RELATIVE = join('skills', 'modern-web-guidance', 'guides');

export class CatalogRefusal extends Error {}

// --- the data-only reader -------------------------------------------------------------
//
// A literal reader, not a general JS parser and deliberately not an evaluator. It walks the
// array text once, tracking string state so a brace inside a string cannot confuse it, and
// throws CatalogRefusal the moment it meets something that is not a literal value.
function readLiteralAt(text, start) {
  let i = start;
  const here = () => `${JSON.stringify(text.slice(Math.max(0, i - 24), i + 24))} at offset ${i}`;
  const fail = (why) => {
    throw new CatalogRefusal(
      `the USE_CASES table is not pure data: ${why} (${here()}). ` +
        'This tool parses literals only, by design: evaluating the package would run downloaded code',
    );
  };
  const skipTrivia = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end === -1) fail('an unterminated block comment');
        i = end + 2;
        continue;
      }
      return;
    }
  };
  const readString = () => {
    const quote = text[i];
    const isTemplate = quote === '`';
    i++;
    let out = '';
    while (i < text.length) {
      const c = text[i];
      // A template literal is data as long as it does not interpolate: `${...}` is an
      // expression, which is code, so it is refused. (The published 0.0.193 table uses
      // backticks for some descriptions, with no interpolation anywhere in it.)
      if (isTemplate && c === '$' && text[i + 1] === '{') {
        fail('an interpolation in a template literal');
      }
      if (c === '\\') {
        const next = text[i + 1];
        if (next === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('a malformed \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
        out += Object.hasOwn(simple, next) ? simple[next] : next;
        i += 2;
        continue;
      }
      if (c === quote) {
        i++;
        return out;
      }
      // A template literal may span lines; a quoted one may not.
      if (c === '\n' && !isTemplate) fail('an unterminated string literal');
      out += c;
      i++;
    }
    fail('an unterminated string literal');
  };
  const readNumber = () => {
    const rest = text.slice(i);
    // Every pure-data numeric literal a package might legitimately contain: sign, decimal
    // with optional fraction and exponent, hex/octal/binary, and `_` separators. A number
    // cannot execute, so being liberal here costs nothing and a needless refusal would stop
    // a lane regenerating the catalog at all.
    const m = rest.match(/^[+-]?(?:0[xX][0-9a-fA-F][0-9a-fA-F_]*|0[oO][0-7][0-7_]*|0[bB][01][01_]*|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/);
    if (!m) fail('a malformed number');
    i += m[0].length;
    const value = Number(m[0].replace(/_/g, ''));
    if (!Number.isFinite(value)) fail(`a number that is not finite (${m[0]})`);
    return value;
  };
  const readValue = () => {
    skipTrivia();
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') return readString();
    if (c === '[') return readArray();
    if (c === '{') return readObject();
    const digitNext = /[0-9]/.test(text[i + 1] ?? '');
    if (c === '-' || (c >= '0' && c <= '9') || (c === '.' && digitNext) || (c === '+' && (digitNext || text[i + 1] === '.'))) {
      return readNumber();
    }
    for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i) && !/[A-Za-z0-9_$]/.test(table[i + word.length] ?? '')) {
        i += word.length;
        return value;
      }
    }
    return fail(`expected a literal, found ${JSON.stringify(c ?? '<end of table>')}`);
  };
  const readArray = () => {
    i++; // '['
    const out = [];
    skipTrivia();
    if (text[i] === ']') {
      i++;
      return out;
    }
    for (;;) {
      out.push(readValue());
      skipTrivia();
      if (text[i] === ',') {
        i++;
        skipTrivia();
        if (text[i] === ']') {
          i++; // trailing comma
          return out;
        }
        continue;
      }
      if (text[i] === ']') {
        i++;
        return out;
      }
      return fail(`expected ',' or ']' in an array, found ${JSON.stringify(text[i] ?? '<end>')}`);
    }
  };
  const readObject = () => {
    i++; // '{'
    const out = {};
    skipTrivia();
    if (text[i] === '}') {
      i++;
      return out;
    }
    for (;;) {
      skipTrivia();
      const key = text[i] === '"' || text[i] === "'" || text[i] === '`'
        ? readString()
        : fail(`expected a quoted key, found ${JSON.stringify(text[i] ?? '<end>')}`);
      // A key that would land on Object.prototype is refused rather than assigned: the
      // value comes from a downloaded package, and `__proto__` is not a guide field.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        fail(`a key named ${JSON.stringify(key)}`);
      }
      skipTrivia();
      if (text[i] !== ':') fail(`expected ':' after the key ${JSON.stringify(key)}`);
      i++;
      out[key] = readValue();
      skipTrivia();
      if (text[i] === ',') {
        i++;
        skipTrivia();
        if (text[i] === '}') {
          i++; // trailing comma
          return out;
        }
        continue;
      }
      if (text[i] === '}') {
        i++;
        return out;
      }
      return fail(`expected ',' or '}' in an object, found ${JSON.stringify(text[i] ?? '<end>')}`);
    }
  };

  const value = readValue();
  skipTrivia(); // trailing whitespace and comments are not content
  return { value, end: i };
}

// Parse a table text that must be exactly one literal, nothing after it but whitespace and
// comments. Returns the parsed array.
export function parseUseCasesTable(table) {
  const { value, end } = readLiteralAt(table, 0);
  if (table.slice(end) !== '') {
    throw new CatalogRefusal('the USE_CASES table has trailing content after the literal');
  }
  if (!Array.isArray(value)) throw new CatalogRefusal('the USE_CASES table is not an array');
  return value;
}

// The table, located by OFFSET after `var USE_CASES =` and read as data. The old recipe
// matched a regex ending in a newline plus `];`, which finds only a table whose closing
// bracket sits on its own line; a minified or differently formatted upstream release would
// have failed there, and this reader does not care about the formatting at all.
export function readUseCases(source) {
  const decl = /var\s+USE_CASES\s*=\s*/.exec(source);
  if (!decl) {
    throw new CatalogRefusal('the package entry point does not declare a `var USE_CASES = [...]` table');
  }
  const { value, end } = readLiteralAt(source, decl.index + decl[0].length);
  if (!Array.isArray(value)) throw new CatalogRefusal('the USE_CASES table is not an array');
  return { value, text: source.slice(decl.index + decl[0].length, end) };
}

// The slug test for a guide id or category used as a PATH segment. Anything else - notably
// `..` - is refused, because the id selects a guide file under the package.
const SLUG = /^[a-z0-9][a-z0-9-]*$/i;

export const REGENERATE =
  'Regenerate with the committed generator: `node tests/mwg-catalog.mjs --package-dir <unpacked modern-web-guidance package> --version <x.y.z> --out knowledge/mwg-catalog.json` (see "How to Regenerate" in knowledge/mwg-catalog.md). It unions the USE_CASES table from the package\'s skills/modern-web-guidance/modern-web.mjs with the package guides/*/*.md file enumeration to ensure guides omitted from USE_CASES like prompt-api are included; the CLI `list` command does not emit featuresUsed/tokenCount.';

// Build the catalog object from an unpacked package directory. Pure with respect to the
// filesystem apart from reading the package and, optionally, the previous catalog
// (for `retrievedAt` preservation).
export function buildCatalog({ packageDir, version, existing = null, now = () => new Date().toISOString() }) {
  const root = resolve(packageDir);
  const entryPath = join(root, ENTRY_RELATIVE);
  if (!existsSync(entryPath)) {
    throw new CatalogRefusal(`no package entry point at ${entryPath} (is --package-dir an unpacked modern-web-guidance tarball?)`);
  }
  const useCases = readUseCases(readFileSync(entryPath, 'utf8')).value;

  const guidesDir = join(root, GUIDES_RELATIVE);
  if (!existsSync(guidesDir)) throw new CatalogRefusal(`no guides directory at ${guidesDir}`);

  const byId = new Map();
  for (const entry of useCases) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CatalogRefusal('the USE_CASES table contains an entry that is not an object');
    }
    if (typeof entry.id !== 'string' || !entry.id) throw new CatalogRefusal('a USE_CASES entry has no string id');
    if (!SLUG.test(entry.id)) throw new CatalogRefusal(`a USE_CASES entry has a non-slug id ${JSON.stringify(entry.id)}`);
    if (typeof entry.category !== 'string' || !SLUG.test(entry.category)) {
      throw new CatalogRefusal(`USE_CASES entry ${entry.id} has a non-slug category ${JSON.stringify(entry.category)}`);
    }
    if (byId.has(entry.id)) throw new CatalogRefusal(`USE_CASES lists ${entry.id} twice`);
    byId.set(entry.id, {
      id: entry.id,
      category: entry.category,
      description: typeof entry.description === 'string' ? entry.description : '',
      featuresUsed: Array.isArray(entry.featuresUsed) ? entry.featuresUsed.filter((f) => typeof f === 'string') : [],
      tokenCount: typeof entry.tokenCount === 'number' ? entry.tokenCount : 0,
    });
  }

  const categories = readdirSync(guidesDir).filter((c) => statSync(join(guidesDir, c)).isDirectory()).sort();
  const fileOnly = [];
  for (const cat of categories) {
    const catDir = join(guidesDir, cat);
    for (const file of readdirSync(catDir).filter((f) => f.endsWith('.md')).sort()) {
      const id = file.replace(/\.md$/, '');
      if (byId.has(id)) continue;
      if (!SLUG.test(id)) continue; // never let a filename become a path or an id
      const content = readFileSync(join(catDir, file), 'utf8');
      // A guide file with no USE_CASES entry is inserted adjacent to an identical twin in
      // the same category (e.g. prompt-api after language-model), so the canonical upstream
      // order is preserved and the unlisted guide is not appended to the end.
      let twin = null;
      for (const other of byId.values()) {
        if (other.category !== cat) continue;
        const otherPath = join(catDir, `${other.id}.md`);
        if (existsSync(otherPath) && readFileSync(otherPath, 'utf8') === content) {
          twin = other;
          break;
        }
      }
      fileOnly.push({
        id,
        category: cat,
        twinId: twin ? twin.id : null,
        description: twin ? twin.description : '',
        featuresUsed: twin ? twin.featuresUsed : [],
        tokenCount: twin ? twin.tokenCount : Math.round(content.length / 3.8),
      });
    }
  }

  const guides = [];
  for (const uc of byId.values()) {
    guides.push({ ...uc });
    for (const fo of fileOnly) {
      if (fo.twinId === uc.id) {
        guides.push({ id: fo.id, category: fo.category, description: fo.description, featuresUsed: fo.featuresUsed, tokenCount: fo.tokenCount });
      }
    }
  }
  for (const fo of fileOnly) {
    if (!guides.some((g) => g.id === fo.id)) {
      guides.push({ id: fo.id, category: fo.category, description: fo.description, featuresUsed: fo.featuresUsed, tokenCount: fo.tokenCount });
    }
  }

  const guideIds = guides.map((g) => g.id).sort();
  const guideIdsSha256 = createHash('sha256').update(guideIds.join('\n')).digest('hex');
  const retrievedAt =
    existing && existing.version === version && typeof existing.retrievedAt === 'string' ? existing.retrievedAt : now();

  return {
    source: 'modern-web-guidance',
    version,
    retrievedAt,
    regenerate: REGENERATE,
    guideCount: guides.length,
    guideIds,
    guideIdsSha256,
    comment:
      `Catalog extracted from modern-web-guidance@${version}. The package CLI list command outputs id, category, and description; ` +
      'the package USE_CASES table and guides file enumeration additionally provide featuresUsed, tokenCount, and unlisted guides ' +
      '(such as prompt-api).',
    guides: guides.map((g) => ({ id: g.id, category: g.category, description: g.description, featuresUsed: g.featuresUsed, tokenCount: g.tokenCount })),
  };
}

function usage(message) {
  if (message) console.error(`FAIL: ${message}`);
  console.error('usage: node tests/mwg-catalog.mjs --package-dir <dir> --version <x.y.z> [-o <out>] [--existing <catalog.json>]');
  process.exit(64);
}

function main(argv) {
  let packageDir = null;
  let version = null;
  let out = join(repoRoot, 'knowledge', 'mwg-catalog.json');
  let existingPath = DEFAULT_EXISTING;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--package-dir') packageDir = argv[++i];
    else if (arg === '--version') version = argv[++i];
    else if (arg === '-o' || arg === '--out') out = argv[++i];
    else if (arg === '--existing') existingPath = argv[++i];
    else return usage(`unknown argument ${arg}`);
  }
  if (!packageDir) return usage('--package-dir is required');
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return usage('--version must be an x.y.z version');

  let existing = null;
  try {
    if (existsSync(existingPath)) existing = JSON.parse(readFileSync(existingPath, 'utf8'));
  } catch {
    existing = null;
  }

  let catalog;
  try {
    catalog = buildCatalog({ packageDir, version, existing });
  } catch (err) {
    if (err instanceof CatalogRefusal) {
      console.error(`FAIL: refused to build the catalog: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  writeFileSync(out, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`Wrote ${catalog.guideCount} guides for modern-web-guidance@${version} to ${out}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
