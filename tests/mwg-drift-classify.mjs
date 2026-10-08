#!/usr/bin/env node
// Deterministic delta classifier for Modern Web Guidance (MWG).
// Categorizes differences between two MWG corpus snapshots into three classes:
//   REVERSED: An implemented rule's textual basis moved or was eliminated upstream.
//             Reported first and loudest; never mixed into generic updates.
//   CHANGED:  Guide text moved but implemented rules still retain their anchor basis,
//             or an unregistered guide was changed or withdrawn.
//   NEW:      Guide introduced upstream that was not present in the baseline.
//
// Dependency-free: Node builtins only (node:fs, node:path, node:url).
// The USE_CASES table is parsed declaratively with regexes; package code is
// NEVER evaluated (an eval here once ran downloaded code in-process).
//
// Corpus format:
//   { "version": "x.y.z", "guides": { "<id>": "<full guide text>" },
//     "provenance": { "<id>": "use_cases" | "scan" } }
// (provenance is present on extracted corpora; older corpora without it are
// still valid).
//
// Usage:
//   node tests/mwg-drift-classify.mjs --old-corpus <file> --new-corpus <file> [--basis <file>] [--json]
//   node tests/mwg-drift-classify.mjs --extract <package-dir> --version <x.y.z> [-o <file>]
//   node tests/mwg-drift-classify.mjs --verify-basis <corpus-file> [--basis <file>] [--catalog <file>]
//
// Exit codes:
//    0: No delta between old and new corpora, or successful extraction/verification.
//    1: Classifier is blind or inputs are invalid: missing or unparseable files,
//       invalid corpus schema, invalid semver version string, empty new corpus
//       when old is non-empty, zero guides extracted, or basis verification failure.
//    2: Delta classified (one or more REVERSED, CHANGED, or NEW guides).
//   64: Usage error (unknown flags, missing arguments, mode conflict).
//
// Environment variable overrides:
//   MWG_DRIFT_BASIS: Path to rule basis JSON (default: knowledge/mwg-rule-basis.json).

import { readFileSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Anchored: a version is the whole string, so a payload smuggling a newline or
// extra text cannot pass validation.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
function isValidVersion(v) {
  // JS `$` still matches before a final newline, so reject whitespace explicitly.
  return typeof v === 'string' && VERSION_PATTERN.test(v) && !/\s/.test(v);
}

function printUsageAndExit(code = 64) {
  const msg = `Usage:
  node tests/mwg-drift-classify.mjs --old-corpus <file> --new-corpus <file> [--basis <file>] [--json]
  node tests/mwg-drift-classify.mjs --extract <package-dir> --version <x.y.z> [-o <file>]
  node tests/mwg-drift-classify.mjs --verify-basis <corpus-file> [--basis <file>] [--catalog <file>]

Options:
  --old-corpus <file>      Path to baseline corpus JSON
  --new-corpus <file>      Path to target corpus JSON to compare against
  --basis <file>           Path to rule basis registry JSON (default: knowledge/mwg-rule-basis.json)
  --json                   Emit single JSON summary line in addition to human report
  --extract <package-dir>  Extract corpus from unpacked modern-web-guidance package dir
  --version <x.y.z>        Version tag to record in extracted corpus
  -o, --out <file>         Destination file for extracted corpus (default: stdout)
  --verify-basis <file>    Verify all basis registry anchors against given corpus JSON
  --catalog <file>         With --verify-basis: also validate that every registered
                           guide id exists in the catalog's guide set and that the
                           registry catalogueVersion matches the catalog version
`;
  if (code === 0) {
    console.log(msg);
  } else {
    console.error(msg);
  }
  process.exit(code);
}

function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`FAIL: cannot read ${label} at ${filePath}: ${err.message}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`FAIL: cannot parse ${label} at ${filePath}: ${err.message}`);
    process.exit(1);
  }
  return parsed;
}

function validateCorpus(corpus, label) {
  if (!corpus || typeof corpus !== 'object' || Array.isArray(corpus)) {
    console.error(`FAIL: ${label} is not a valid JSON object`);
    process.exit(1);
  }
  if (!isValidVersion(corpus.version)) {
    console.error(`FAIL: ${label} has invalid or missing version string: ${JSON.stringify(corpus.version)}`);
    process.exit(1);
  }
  if (!corpus.guides || typeof corpus.guides !== 'object' || Array.isArray(corpus.guides)) {
    console.error(`FAIL: ${label} has invalid or missing guides mapping`);
    process.exit(1);
  }
  for (const [id, text] of Object.entries(corpus.guides)) {
    if (typeof text !== 'string') {
      console.error(`FAIL: ${label} guide "${id}" content is not a string`);
      process.exit(1);
    }
  }
  return corpus;
}

function validateBasis(basis, label) {
  if (!basis || typeof basis !== 'object' || Array.isArray(basis)) {
    console.error(`FAIL: ${label} is not a valid JSON object`);
    process.exit(1);
  }
  if (!Array.isArray(basis.rules)) {
    console.error(`FAIL: ${label} rules field must be an array`);
    process.exit(1);
  }
  for (let i = 0; i < basis.rules.length; i++) {
    const r = basis.rules[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      console.error(`FAIL: ${label} rule at index ${i} is not an object`);
      process.exit(1);
    }
    if (typeof r.id !== 'string' || r.id.length === 0) {
      console.error(`FAIL: ${label} rule at index ${i} has invalid or missing id`);
      process.exit(1);
    }
    if (typeof r.guide !== 'string' || r.guide.length === 0) {
      console.error(`FAIL: ${label} rule "${r.id}" has invalid or missing guide id`);
      process.exit(1);
    }
    if (!Array.isArray(r.anchors) || r.anchors.length === 0) {
      console.error(`FAIL: ${label} rule "${r.id}" anchors must be a non-empty array`);
      process.exit(1);
    }
    for (const a of r.anchors) {
      if (typeof a !== 'string' || a.length === 0) {
        console.error(`FAIL: ${label} rule "${r.id}" has invalid anchor string`);
        process.exit(1);
      }
    }
  }
  // The registry is version-bound; a missing or malformed catalogueVersion
  // must fail validation, not silently disable the binding checks.
  if (!isValidVersion(basis.catalogueVersion)) {
    console.error(`FAIL: ${label} has missing or invalid catalogueVersion (got ${JSON.stringify(basis.catalogueVersion ?? null)})`);
    process.exit(1);
  }
  return basis;
}

function extractFromPackage(packageDir, versionStr) {
  if (!existsSync(packageDir)) {
    console.error(`FAIL: package directory does not exist: ${packageDir}`);
    process.exit(1);
  }

  const guides = {};
  // Per-guide provenance: "use_cases" when the guide was located through the
  // package's USE_CASES table, "scan" when only the disk scan found it (the
  // table has no entry for it, the prompt-api defect class of web-uplift-968).
  const provenance = {};
  const modernWebCandidates = [
    join(packageDir, 'skills', 'modern-web-guidance', 'modern-web.mjs'),
    join(packageDir, 'modern-web.mjs'),
  ];
  const modernWebPath = modernWebCandidates.find((p) => existsSync(p));

  if (modernWebPath) {
    let src;
    try {
      src = readFileSync(modernWebPath, 'utf8');
    } catch (err) {
      console.error(`FAIL: cannot read ${modernWebPath}: ${err.message}`);
      process.exit(1);
    }
    const match = src.match(/var USE_CASES\s*=\s*(\[[\s\S]*?\n\];)/);
    if (match) {
      // Parse, never eval: the table is not pure JSON (single-quoted literals),
      // so pull each entry's id and category declaratively. A hostile or
      // malformed package must never get code execution in this lane tool.
      const table = match[1];
      const idMatches = [...table.matchAll(/"id"\s*:\s*"([^"\n]+)"/g)];
      // Guide ids and categories are slugs; anything else (notably `..`) is a
      // hostile or corrupt table entry and must never become a path segment.
      const SLUG = /^[a-z0-9][a-z0-9-]*$/i;
      const packageRoot = resolve(packageDir);
      for (let k = 0; k < idMatches.length; k++) {
        const id = idMatches[k][1];
        const windowEnd = k + 1 < idMatches.length ? idMatches[k + 1].index : table.length;
        const windowText = table.slice(idMatches[k].index, windowEnd);
        const catMatch = windowText.match(/"category"\s*:\s*"([^"\n]+)"/);
        const category = catMatch ? catMatch[1] : '';
        if (!SLUG.test(id) || (category !== '' && !SLUG.test(category))) {
          continue;
        }
        const fileCandidates = [
          join(packageDir, 'skills', 'modern-web-guidance', 'guides', category, `${id}.md`),
          join(packageDir, 'guides', category, `${id}.md`),
          join(packageDir, 'skills', 'modern-web-guidance', 'guides', `${id}.md`),
          join(packageDir, `${id}.md`),
        ];
        // Belt and braces: even with slug validation, never read outside the
        // unpacked package directory, and never through a symlink (resolve()
        // checks the spelling; realpathSync() checks the truth).
        const foundPath = fileCandidates.find((p) => {
          const spelled = resolve(p);
          if (!(spelled === packageRoot || spelled.startsWith(packageRoot + '/')) || !existsSync(spelled)) {
            return false;
          }
          let real;
          try {
            real = realpathSync(spelled);
          } catch {
            return false;
          }
          return real === packageRoot || real.startsWith(packageRoot + '/');
        });
        if (foundPath) {
          guides[id] = readFileSync(foundPath, 'utf8');
          provenance[id] = 'use_cases';
        }
      }
    }
  }

  // Supplement, not just fallback: a guide file can exist without a USE_CASES
  // entry (prompt-api in 0.0.193, the 177-vs-178 defect of web-uplift-968), so
  // scanning only when the table yielded nothing would silently drop unlisted
  // guides. Always scan the dedicated guides directories and add anything the
  // table missed. The package root is scanned ONLY as a last resort, when no
  // guides directory exists at all.
  const guidesDirCandidates = [
    join(packageDir, 'skills', 'modern-web-guidance', 'guides'),
    join(packageDir, 'guides'),
  ];
  const scanRoots = guidesDirCandidates.filter((d) => existsSync(d));
  if (scanRoots.length === 0 && existsSync(packageDir)) {
    scanRoots.push(packageDir);
  }
  function scanDir(dir) {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        scanDir(full);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        const name = ent.name.slice(0, -3);
        const upper = name.toUpperCase();
        if (!['README', 'CONTRIBUTING', 'SKILL', 'THIRD_PARTY_NOTICES', 'LICENSE'].includes(upper)) {
          // Own-property check, not truthiness: a table-located guide whose
          // file is EMPTY must keep its use_cases provenance.
          if (!Object.prototype.hasOwnProperty.call(guides, name)) {
            guides[name] = readFileSync(full, 'utf8');
            provenance[name] = 'scan';
          }
        }
      }
    }
  }
  for (const root of scanRoots) {
    scanDir(root);
  }

  const guideIds = Object.keys(guides).sort();
  if (guideIds.length === 0) {
    console.error(`FAIL: no guide text found in package directory: ${packageDir}`);
    process.exit(1);
  }

  const sortedGuides = {};
  const sortedProvenance = {};
  for (const id of guideIds) {
    sortedGuides[id] = guides[id];
    sortedProvenance[id] = provenance[id];
  }

  const useCasesCount = Object.values(provenance).filter((p) => p === 'use_cases').length;
  const scanCount = Object.values(provenance).filter((p) => p === 'scan').length;
  console.error(`extracted ${guideIds.length} guides (${useCasesCount} via USE_CASES, ${scanCount} via scan only)`);

  return {
    version: versionStr,
    guides: sortedGuides,
    provenance: sortedProvenance,
  };
}

// The registry is written against ONE catalog version; a registry carried
// across a version boundary without re-verification silently disables reversal
// detection for guides that moved. Returns an error string or null.
function basisVersionBindingError(basis, version, what) {
  if (basis.catalogueVersion !== version) {
    return `basis registry catalogueVersion (${basis.catalogueVersion}) does not match ${what} (${version}); re-verify the registry against this catalog version`;
  }
  return null;
}

// A registered guide id absent from the catalog's guide set means the registry
// and catalog have drifted apart; fail loud rather than silently skipping
// reversal detection for that rule. Returns violation strings.
function basisCatalogViolations(basis, catalog) {
  const violations = [];
  if (!isValidVersion(catalog.version)) {
    violations.push(`catalog has missing or invalid version (got ${JSON.stringify(catalog.version ?? null)})`);
  } else if (basis.catalogueVersion !== catalog.version) {
    violations.push(`basis registry catalogueVersion (${basis.catalogueVersion}) does not match catalog version (${catalog.version})`);
  }
  const declaredIds = Array.isArray(catalog.guideIds) ? catalog.guideIds : null;
  const derivedIds = Array.isArray(catalog.guides) ? catalog.guides.map((g) => g && g.id) : null;
  // When the catalog carries both representations they must agree; trusting
  // one over the other would let a stale declaration mask registry drift.
  let ids;
  if (declaredIds && derivedIds) {
    const sortedDeclared = [...declaredIds].sort();
    const sortedDerived = [...derivedIds].sort();
    if (sortedDeclared.length !== sortedDerived.length || sortedDeclared.some((v, i) => v !== sortedDerived[i])) {
      violations.push('catalog guideIds declaration does not match the ids of its guides array');
    }
    ids = declaredIds;
  } else {
    ids = declaredIds || derivedIds || [];
  }
  if (ids.length === 0) {
    violations.push('catalog has no guide ids to validate against');
    return violations;
  }
  const set = new Set(ids);
  for (const rule of basis.rules) {
    if (!set.has(rule.guide)) {
      violations.push(`Rule "${rule.id}": registered guide "${rule.guide}" is absent from the catalog guide set`);
    }
  }
  return violations;
}

function verifyBasisAgainstCorpus(corpusPath, basisPath, catalogPath) {
  const corpusRaw = readJsonFile(corpusPath, 'corpus file');
  const corpus = validateCorpus(corpusRaw, 'corpus file');
  const basisRaw = readJsonFile(basisPath, 'basis registry file');
  const basis = validateBasis(basisRaw, 'basis registry file');

  const bindErr = basisVersionBindingError(basis, corpus.version, 'the corpus version');
  if (bindErr) {
    console.error(`FAIL: ${bindErr}`);
    process.exit(1);
  }

  if (catalogPath) {
    const catalog = readJsonFile(catalogPath, 'catalog file');
    const catViolations = basisCatalogViolations(basis, catalog);
    if (catViolations.length > 0) {
      console.error(`FAIL: ${catViolations.length} basis-vs-catalog violation(s):`);
      for (const v of catViolations) {
        console.error(`  - ${v}`);
      }
      process.exit(1);
    }
  }

  const violations = [];
  for (const rule of basis.rules) {
    if (!Object.prototype.hasOwnProperty.call(corpus.guides, rule.guide)) {
      violations.push(`Rule "${rule.id}": registered guide "${rule.guide}" does not exist in corpus`);
      continue;
    }
    const guideText = corpus.guides[rule.guide];
    for (const anchor of rule.anchors) {
      if (!guideText.includes(anchor)) {
        violations.push(`Rule "${rule.id}" for guide "${rule.guide}": anchor not found in guide text: ${JSON.stringify(anchor)}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error(`FAIL: ${violations.length} basis verification violation(s):`);
    for (const v of violations) {
      console.error(`  - ${v}`);
    }
    process.exit(1);
  }

  console.log(`OK: basis verified successfully against corpus (${basis.rules.length} rule(s) verified, all anchors intact)`);
  process.exit(0);
}

function classifyDelta(oldCorpusPath, newCorpusPath, basisPath, jsonMode) {
  const oldRaw = readJsonFile(oldCorpusPath, 'old corpus');
  const oldCorpus = validateCorpus(oldRaw, 'old corpus');
  const newRaw = readJsonFile(newCorpusPath, 'new corpus');
  const newCorpus = validateCorpus(newRaw, 'new corpus');
  const basisRaw = readJsonFile(basisPath, 'basis registry');
  const basis = validateBasis(basisRaw, 'basis registry');

  const bindErr = basisVersionBindingError(basis, oldCorpus.version, 'the baseline corpus version');
  if (bindErr) {
    console.error(`FAIL: ${bindErr}`);
    process.exit(1);
  }

  const oldKeys = Object.keys(oldCorpus.guides);
  const newKeys = Object.keys(newCorpus.guides);

  // A blind check refusing rule: an empty baseline is not a valid baseline
  // (there is nothing to classify against), and an empty target against a
  // non-empty baseline means the extractor saw nothing; diffing against
  // nothing is never "all guides withdrawn". Refuse both, loud.
  if (oldKeys.length === 0) {
    console.error('FAIL: baseline corpus has no guides; refusing to classify without a baseline');
    process.exit(1);
  }
  if (newKeys.length === 0) {
    console.error('FAIL: new corpus has empty guides while old corpus is non-empty; refusing to classify against empty corpus');
    process.exit(1);
  }

  const reversed = [];
  const changed = [];
  const newGuides = [];

  const allGuideIds = Array.from(new Set([...oldKeys, ...newKeys])).sort();

  for (const id of allGuideIds) {
    const inOld = Object.prototype.hasOwnProperty.call(oldCorpus.guides, id);
    const inNew = Object.prototype.hasOwnProperty.call(newCorpus.guides, id);
    const rulesForGuide = basis.rules.filter((r) => r.guide === id);

    if (!inOld && inNew) {
      newGuides.push({ guide: id });
    } else if (inOld && !inNew) {
      if (rulesForGuide.length > 0) {
        reversed.push({
          guide: id,
          rules: rulesForGuide.map((r) => r.id),
          missingAnchors: [],
          reason: 'guide withdrawn upstream while referenced by implemented rules',
        });
      } else {
        changed.push({
          guide: id,
          reason: 'guide withdrawn upstream (no implemented rules)',
        });
      }
    } else if (inOld && inNew) {
      const oldText = oldCorpus.guides[id];
      const newText = newCorpus.guides[id];

      if (oldText === newText) {
        // Identical text: not reported
        continue;
      }

      if (rulesForGuide.length > 0) {
        const missingAnchors = [];
        const affectedRules = [];

        for (const rule of rulesForGuide) {
          let ruleAffected = false;
          for (const anchor of rule.anchors || []) {
            if (!newText.includes(anchor)) {
              if (!missingAnchors.includes(anchor)) {
                missingAnchors.push(anchor);
              }
              ruleAffected = true;
            }
          }
          if (ruleAffected) {
            affectedRules.push(rule.id);
          }
        }

        if (missingAnchors.length > 0) {
          reversed.push({
            guide: id,
            rules: affectedRules,
            missingAnchors,
            reason: 'implemented rule anchor missing upstream',
          });
        } else {
          changed.push({
            guide: id,
            reason: 'guide text modified upstream (implemented rule anchors intact)',
          });
        }
      } else {
        changed.push({
          guide: id,
          reason: 'guide text modified upstream (no implemented rules)',
        });
      }
    }
  }

  const hasDelta = reversed.length > 0 || changed.length > 0 || newGuides.length > 0;

  // Format human report: REVERSED section FIRST and LOUDEST
  let report = '';
  report += `======================================================================\n`;
  report += `MWG DRIFT CLASSIFICATION: ${oldCorpus.version} -> ${newCorpus.version}\n`;
  report += `======================================================================\n`;
  report += `Total guides: baseline=${oldKeys.length}, upstream=${newKeys.length}\n`;
  report += `Delta summary: ${reversed.length} reversed, ${changed.length} changed, ${newGuides.length} new\n\n`;

  // SECTION 1: REVERSED (FIRST and LOUDEST)
  report += `!!! REVERSED (${reversed.length}): implemented rules whose upstream basis moved\n`;
  if (reversed.length === 0) {
    report += `  (none)\n`;
  } else {
    for (const item of reversed) {
      report += `  - guide: ${item.guide}\n`;
      report += `    reason: ${item.reason}\n`;
      report += `    rules: ${item.rules.join(', ')}\n`;
      if (item.missingAnchors.length > 0) {
        report += `    missing anchors:\n`;
        for (const a of item.missingAnchors) {
          report += `      * ${JSON.stringify(a)}\n`;
        }
      }
    }
  }
  report += `\n`;

  // SECTION 2: CHANGED
  report += `=== CHANGED (${changed.length}): guides modified upstream with intact basis ===\n`;
  if (changed.length === 0) {
    report += `  (none)\n`;
  } else {
    for (const item of changed) {
      report += `  - guide: ${item.guide} (${item.reason})\n`;
    }
  }
  report += `\n`;

  // SECTION 3: NEW
  report += `=== NEW (${newGuides.length}): new guides added upstream ===\n`;
  if (newGuides.length === 0) {
    report += `  (none)\n`;
  } else {
    for (const item of newGuides) {
      report += `  - guide: ${item.guide}\n`;
    }
  }

  console.log(report);

  if (jsonMode) {
    console.log(JSON.stringify({
      reversed,
      changed,
      new: newGuides,
      oldVersion: oldCorpus.version,
      newVersion: newCorpus.version,
    }));
  }

  if (hasDelta) {
    process.exit(2);
  } else {
    process.exit(0);
  }
}

// Main CLI parsing
const defaultBasisPath = process.env.MWG_DRIFT_BASIS || join(repoRoot, 'knowledge', 'mwg-rule-basis.json');

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
  printUsageAndExit(rawArgs.length === 0 ? 64 : 0);
}

let mode = null;
let oldCorpusArg = null;
let newCorpusArg = null;
let basisArg = defaultBasisPath;
let catalogArg = null;
let jsonArg = false;
let extractDirArg = null;
let versionArg = null;
let outArg = null;
let verifyCorpusArg = null;

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];

  if (arg === '--extract') {
    if (mode && mode !== 'extract') {
      console.error('FAIL: cannot mix --extract with other modes');
      process.exit(64);
    }
    mode = 'extract';
    i++;
    if (i >= rawArgs.length) {
      console.error('FAIL: --extract requires <package-dir> argument');
      process.exit(64);
    }
    extractDirArg = rawArgs[i];
  } else if (arg === '--version') {
    i++;
    if (i >= rawArgs.length) {
      console.error('FAIL: --version requires a version string');
      process.exit(64);
    }
    versionArg = rawArgs[i];
  } else if (arg === '-o' || arg === '--out') {
    i++;
    if (i >= rawArgs.length) {
      console.error(`FAIL: ${arg} requires a destination file argument`);
      process.exit(64);
    }
    outArg = rawArgs[i];
  } else if (arg === '--verify-basis') {
    if (mode && mode !== 'verify_basis') {
      console.error('FAIL: cannot mix --verify-basis with other modes');
      process.exit(64);
    }
    mode = 'verify_basis';
    i++;
    if (i >= rawArgs.length) {
      console.error('FAIL: --verify-basis requires <corpus-file> argument');
      process.exit(64);
    }
    verifyCorpusArg = rawArgs[i];
  } else if (arg === '--old-corpus') {
    if (mode && mode !== 'classify') {
      console.error('FAIL: cannot mix --old-corpus with other modes');
      process.exit(64);
    }
    mode = 'classify';
    i++;
    if (i >= rawArgs.length) {
      console.error('FAIL: --old-corpus requires <file> argument');
      process.exit(64);
    }
    oldCorpusArg = rawArgs[i];
  } else if (arg === '--new-corpus') {
    if (mode && mode !== 'classify') {
      console.error('FAIL: cannot mix --new-corpus with other modes');
      process.exit(64);
    }
    mode = 'classify';
    i++;
    if (i >= rawArgs.length) {
      console.error('FAIL: --new-corpus requires <file> argument');
      process.exit(64);
    }
    newCorpusArg = rawArgs[i];
  } else if (arg === '--basis') {
    i++;
    if (i >= rawArgs.length) {
      console.error('FAIL: --basis requires <file> argument');
      process.exit(64);
    }
    basisArg = rawArgs[i];
  } else if (arg === '--catalog') {
    i++;
    if (i >= rawArgs.length) {
      console.error('FAIL: --catalog requires <file> argument');
      process.exit(64);
    }
    catalogArg = rawArgs[i];
    if (catalogArg.length === 0) {
      console.error('FAIL: --catalog requires a non-empty path');
      process.exit(64);
    }
  } else if (arg === '--json') {
    jsonArg = true;
  } else {
    console.error(`FAIL: unrecognized argument: ${arg}`);
    process.exit(64);
  }
}

if (mode === 'extract') {
  if (catalogArg !== null) {
    console.error('FAIL: --catalog is only valid with --verify-basis');
    process.exit(64);
  }
  if (!versionArg) {
    console.error('FAIL: --extract requires --version <x.y.z>');
    process.exit(64);
  }
  if (!isValidVersion(versionArg)) {
    console.error(`FAIL: invalid version string: ${JSON.stringify(versionArg)}`);
    process.exit(1);
  }
  const corpus = extractFromPackage(extractDirArg, versionArg);
  const formatted = JSON.stringify(corpus, null, 2) + '\n';
  if (outArg) {
    try {
      writeFileSync(outArg, formatted, 'utf8');
    } catch (err) {
      console.error(`FAIL: cannot write extracted corpus to ${outArg}: ${err.message}`);
      process.exit(1);
    }
  } else {
    process.stdout.write(formatted);
  }
  process.exit(0);
} else if (mode === 'verify_basis') {
  verifyBasisAgainstCorpus(verifyCorpusArg, basisArg, catalogArg);
} else if (mode === 'classify') {
  if (catalogArg !== null) {
    console.error('FAIL: --catalog is only valid with --verify-basis');
    process.exit(64);
  }
  if (!oldCorpusArg || !newCorpusArg) {
    console.error('FAIL: classification mode requires both --old-corpus and --new-corpus');
    process.exit(64);
  }
  classifyDelta(oldCorpusArg, newCorpusArg, basisArg, jsonArg);
} else {
  console.error('FAIL: no valid mode specified (--old-corpus/--new-corpus, --extract, or --verify-basis)');
  process.exit(64);
}
