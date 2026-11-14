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
import { CANONICALISATION_RULE, computeSha256 } from './mwg-artefact.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
import { basisAnchorViolations, guidesFromTree } from './mwg-basis.mjs';
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
import { AGENTS } from '../runner/agents.mjs';
import { testMwgDriftExtractPipe } from './mwg-drift-extract-pipe.mjs';
import { testMwgDriftBasisFloor } from './mwg-drift-basis-floor.mjs';
import { testMwgDriftAlertNamesTheConditionItReports } from './mwg-drift-alert.mjs';
import { testRuleBasisAnchorsArePinnedPerAppliedVersion, testRulesRevisionRequiresProvableEvidenceOnly } from './mwg-rule-basis-anchors.mjs';
import { testMwgCatalogExtract } from './mwg-catalog-extract.mjs';

export function testGuidanceUsage() {
  const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));
  const findings = report.findings || [];
  assert(findings.length > 0, 'guidance: fixture should have issue-findings to check');
  const consulted = report.guidanceConsulted || [];
  assert(Array.isArray(consulted) && consulted.length > 0,
    'guidance: a report with issue-findings must populate guidanceConsulted (MWG was not called)');
  const consultedSet = new Set(consulted);
  for (const f of findings) {
    assert(typeof f.guidanceId === 'string' && f.guidanceId.length > 0,
      `guidance: finding ${f.id} is missing a guidanceId (its fix is not backed by Modern Web Guidance)`);
    assert(consultedSet.has(f.guidanceId),
      `guidance: finding ${f.id} cites guidanceId "${f.guidanceId}" that is not in guidanceConsulted`);
  }
  // All findings citing guidanceCategory must use a valid Modern Web Guidance category (0.0.193 taxonomy).
  const catalog = readJson('knowledge/mwg-catalog.json');
  const validCategories = new Set(catalog.guides.map((g) => g.category));
  for (const f of findings) {
    if (f.guidanceCategory) {
      assert(
        validCategories.has(f.guidanceCategory),
        `guidance: finding ${f.id} has invalid category "${f.guidanceCategory}" (must be in Modern Web Guidance catalog: ${[...validCategories].join(', ')})`,
      );
      assert(
        f.guidanceCategory !== 'user-experience',
        `guidance: finding ${f.id} uses removed category "user-experience"`,
      );
    }
  }
  // The clean/fixed report may have no findings, but if it lists guidance it must be an array.
  const fixed = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  assert(fixed.guidanceConsulted === undefined || Array.isArray(fixed.guidanceConsulted),
    'guidance: fixed report guidanceConsulted must be an array when present');
}


// The audit docs tell the model to run modern-web-guidance through npx. They must
// all name the version pinned as guidanceCatalogVersion in
// knowledge/principles.json: an unpinned @latest has no lockfile entry and no
// integrity check, so it makes audits irreproducible and lets a compromised
// publish execute on the audit host (factory-audit TM-006, web-uplift-2op). This
// check is what stops a version bump from leaving a stale literal or an @latest
// behind in any of the docs the model reads.
export function testGuidanceVersionPinnedInDocs() {
  const pinned = readJson('knowledge/principles.json').guidanceCatalogVersion;
  assert(
    /^modern-web-guidance@\d+\.\d+\.\d+$/.test(pinned),
    `guidanceCatalogVersion must pin a concrete version, got ${pinned}`,
  );
  const docs = [
    'knowledge/guidance.md',
    'runner/README.md',
    'AGENTS.md',
    '.github/copilot-instructions.md',
    'web-uplift.example.json',
    'schema/config.schema.json',
    // The audit skill exists twice: the source and its tracked vendored twin, which install-surface.mjs
    // regenerates during prepare. Both are surfaced to operators, so both must name the pin - the twin was
    // stale once (web-uplift-xkax) and nothing was watching it (web-uplift-yfbk).
    '.claude/skills/web-audit/SKILL.md',
    '.pi/skills/web-audit/SKILL.md',
    // PLAN.md is where an operator reads what is pinned and why (Open questions), so a bump that leaves it
    // pointing at the superseded catalog sends the reader to the wrong version. It drifted once
    // (web-uplift-l69l) and nothing was watching it, which is the same shape as the skill twin above.
    'PLAN.md',
  ];
  for (const rel of docs) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    const refs = [...text.matchAll(/modern-web-guidance@([^\s"'`]+)/g)].map((m) => m[1]);
    assert(refs.length > 0, `${rel} must name the pinned guidance version (${pinned})`);
    for (const raw of refs) {
      // A permission rule can follow the version directly, e.g.
      // `modern-web-guidance@0.0.193:*` in the headless allowlist docs, so strip
      // a trailing rule suffix before comparing. A genuinely different version
      // (or an @latest) still fails.
      const ref = raw.replace(/[:*)]+$/, '');
      assert(
        `modern-web-guidance@${ref}` === pinned,
        `${rel} names modern-web-guidance@${raw}, but guidanceCatalogVersion is ${pinned}`,
      );
    }
  }

  // The snapshot doc states the guide total as prose next to the JSON that is authoritative for it, and the
  // two drifted apart silently: knowledge/mwg-catalog.md said 178 while mwg-catalog.json declared 187, three
  // version bumps after the snapshot was written (web-uplift-8jzf). Naming the number here means a bump that
  // regenerates the JSON but forgets the prose fails the suite instead of waiting for a reviewer.
  const snapshot = readFileSync(join(repoRoot, 'knowledge/mwg-catalog.md'), 'utf8');
  const stated = /\*\*Total guides:\*\*\s*([0-9]+)/.exec(snapshot);
  assert(stated, 'knowledge/mwg-catalog.md must state its guide total so it can be cross-checked');
  const declared = readJson('knowledge/mwg-catalog.json').guideCount;
  assert(
    Number(stated[1]) === declared,
    `knowledge/mwg-catalog.md says ${stated[1]} guides but mwg-catalog.json declares ${declared}`,
  );
}


// Asserts that the extraction script inside knowledge/mwg-catalog.md and the
// 'regenerate' property in knowledge/mwg-catalog.json agree, preventing
// reintroduction of incorrect CLI flags (web-uplift-bxl).
//
// It used to compare the catalog against an extraction script embedded in
// knowledge/mwg-catalog.md, eval-ing the string out of the markdown to read it. That script
// is gone: it evaluated the USE_CASES table of a downloaded npm package (web-uplift-w0y),
// and the generator (tests/mwg-catalog.mjs) is now the single source of truth for both the
// extraction and this text.
export async function testMwgCatalogRegenerateAgreement() {
  const catalog = readJson('knowledge/mwg-catalog.json');
  assert(
    typeof catalog.regenerate === 'string' && catalog.regenerate.length > 0,
    'knowledge/mwg-catalog.json must declare a regenerate field',
  );
  const md = readFileSync(join(repoRoot, 'knowledge', 'mwg-catalog.md'), 'utf8');
  assert(
    !/regenerate:\s*['"`]/.test(md),
    'knowledge/mwg-catalog.md must not carry its own catalog extraction script: the generator is the single source of truth (web-uplift-w0y)',
  );
  const { REGENERATE } = await import('./mwg-catalog.mjs');
  assert(
    REGENERATE === catalog.regenerate,
    `tests/mwg-catalog.mjs writes '${REGENERATE}', but knowledge/mwg-catalog.json has '${catalog.regenerate}'`,
  );
}


// Validates that every guide in the current Modern Web Guidance catalog (0.0.197)
// is covered by principles.json, dead/renamed ids are rejected, and changed-guidance
// deltas (CSP object-src none, custom-button-actions, top-layer probe, etc.) are
// actively asserted so regressions would fail.
export function testPrinciplesMwgCatalogSyncAndChangedGuidance() {
  const catalog = readJson('knowledge/mwg-catalog.json');
  const principles = readJson('knowledge/principles.json');
  const catalogIds = new Set(catalog.guides.map((g) => g.id));

  // Assert catalog version and principles pinned version match
  assert(
    principles.guidanceCatalogVersion === `modern-web-guidance@${catalog.version}`,
    `principles.json guidanceCatalogVersion (${principles.guidanceCatalogVersion}) must match mwg-catalog.json version (modern-web-guidance@${catalog.version})`,
  );

  // Assert the canonical catalog has the full guide set (194 as of the 0.0.197 reanalysis),
  // includes prompt-api, and has a sorted guideIds list
  assert(
    catalog.guideCount === 194,
    `mwg-catalog.json guideCount must be 194, got ${catalog.guideCount}`,
  );
  assert(
    catalog.guides.length === 194,
    `mwg-catalog.json guides array must contain 194 entries, got ${catalog.guides.length}`,
  );
  assert(
    catalogIds.has('prompt-api'),
    'mwg-catalog.json must contain "prompt-api"',
  );
  const promptApi = catalog.guides.find((g) => g.id === 'prompt-api');
  assert(
    promptApi?.category === 'built-in-ai',
    `prompt-api category must be built-in-ai, got ${promptApi?.category}`,
  );
  assert(
    Array.isArray(catalog.guideIds) && catalog.guideIds.length === 194,
    'mwg-catalog.json must declare a sorted guideIds array of 194 items',
  );
  assert(
    catalog.guideIds.includes('prompt-api'),
    'mwg-catalog.json guideIds must include prompt-api',
  );
  const sortedIds = [...catalog.guideIds].sort();
  assert(
    JSON.stringify(catalog.guideIds) === JSON.stringify(sortedIds),
    'mwg-catalog.json guideIds must be sorted ascending',
  );
  // The identity fields are REQUIRED and cross-checked against each other (web-uplift-plp9). The previous form
  // was wrapped in 'if (catalog.guideIdsSha256)', so DELETING the field skipped the assertion and the case went
  // green while the value it claims to protect was gone - the js42 round-1 / nz0l shape, an assertion that
  // passes for the wrong reason. A missing identity field is now a failure, not an opt-out.
  assert(
    typeof catalog.guideIdsSha256 === 'string' && /^[0-9a-f]{64}$/.test(catalog.guideIdsSha256),
    `mwg-catalog.json must declare guideIdsSha256 as a sha256 hex digest, got ${JSON.stringify(catalog.guideIdsSha256)}. It is required: an optional identity field is one that can be dropped without any gate noticing (web-uplift-plp9).`,
  );
  const computedHash = createHash('sha256').update(catalog.guideIds.join('\n')).digest('hex');
  assert(
    catalog.guideIdsSha256 === computedHash,
    `mwg-catalog.json guideIdsSha256 must match sha256 of newline-joined guideIds (expected ${computedHash}, got ${catalog.guideIdsSha256})`,
  );

  // And guideIds must be the SAME SET as guides[].id, checked in BOTH directions. Length, sorted-ness and an
  // includes('prompt-api') test all pass for a guideIds array that is a DIFFERENT set of 187 ids, so none of
  // them tie the identity list to the guides it claims to identify (web-uplift-plp9).
  const guideIdsSet = new Set(catalog.guideIds);
  const guidesIdSet = new Set(catalog.guides.map((g) => g.id));
  const inGuidesButNotIds = [...guidesIdSet].filter((id) => !guideIdsSet.has(id));
  assert(
    inGuidesButNotIds.length === 0,
    `mwg-catalog.json guideIds is missing ${inGuidesButNotIds.length} guide(s) that guides[] declares: ${inGuidesButNotIds.slice(0, 5).join(', ')}. guideIds must be the same set as guides[].id (web-uplift-plp9).`,
  );
  const inIdsButNotGuides = [...guideIdsSet].filter((id) => !guidesIdSet.has(id));
  assert(
    inIdsButNotGuides.length === 0,
    `mwg-catalog.json guideIds declares ${inIdsButNotGuides.length} id(s) that no guides[] entry has: ${inIdsButNotGuides.slice(0, 5).join(', ')}. guideIds must be the same set as guides[].id (web-uplift-plp9).`,
  );

  // 1. Every catalog guide is covered by exact ID in principles.json, and no unknown guide IDs exist
  const coveredGuides = new Set();
  const deadIds = [
    'prevent-text-wrapping',
    'declarative-button-actions',
    'format-human-readable-durations',
    'manage-recurring-intervals',
    'model-partial-time-concepts',
    'resilient-context-menus-and-nested-dropdowns',
    'sequence-distributed-events',
    'stabilize-reactive-state',
  ];
  for (const p of principles.principles) {
    for (const c of p.checks) {
      for (const g of c.guides || []) {
        for (const dead of deadIds) {
          assert(g !== dead, `principles.json check ${p.id}/${c.id} must not reference dead/renamed guide "${dead}"`);
        }
        // If a guide pointer does not have spaces, it is a discrete guide ID and MUST exist in catalog
        if (!g.includes(' ')) {
          assert(
            catalogIds.has(g),
            `principles.json check ${p.id}/${c.id} references unknown or dead guide ID "${g}"`,
          );
        }
        if (catalogIds.has(g)) {
          coveredGuides.add(g);
        }
      }
    }
  }
  for (const id of catalogIds) {
    assert(coveredGuides.has(id), `principles.json must cover catalog guide "${id}"`);
  }

  // 2. Changed-guidance behavioral deltas are encoded in principles
  const secureHeaders = principles.principles
    .find((p) => p.id === 'be-private-and-secure')
    ?.checks.find((c) => c.id === 'secure-transport-and-headers');
  assert(
    secureHeaders?.summary.includes("object-src 'none'") &&
      secureHeaders?.summary.includes("frame-ancestors 'self'") &&
      secureHeaders?.summary.includes("require-trusted-types-for 'script'"),
    'secure-transport-and-headers summary must encode mandatory object-src none, frame-ancestors self, require-trusted-types-for script',
  );
  assert(
    !secureHeaders?.summary.includes('report-only violations near zero'),
    'secure-transport-and-headers must not encode superseded report-only gate',
  );

  const defPolicies = principles.principles
    .find((p) => p.id === 'be-private-and-secure')
    ?.checks.find((c) => c.id === 'defensive-browser-policies');
  assert(
    defPolicies?.guides.includes('trusted-types') &&
      defPolicies?.guides.includes('validate-origins') &&
      defPolicies?.guides.includes('local-network-access') &&
      defPolicies?.guides.includes('restrict-outbound-connections'),
    'defensive-browser-policies must include new defensive security guides',
  );

  const primaryFlow = principles.principles
    .find((p) => p.id === 'support-core-task-success')
    ?.checks.find((c) => c.id === 'primary-flow-completion');
  assert(
    primaryFlow?.guides.includes('custom-button-actions') &&
      !primaryFlow?.guides.includes('declarative-button-actions'),
    'primary-flow-completion must reference custom-button-actions rather than declarative-button-actions',
  );

  const physicalGestures = principles.principles
    .find((p) => p.id === 'implement-natural-interactions')
    ?.checks.find((c) => c.id === 'physical-gestures');
  assert(
    physicalGestures?.detectableVia.includes('runtime probe element'),
    'physical-gestures must note runtime probe element requirement for top-layer animation',
  );

  const agenticTools = principles.principles
    .find((p) => p.id === 'be-agent-ready')
    ?.checks.find((c) => c.id === 'structured-agent-capabilities');
  assert(
    agenticTools?.summary.includes('async (await registerTool)') &&
      agenticTools?.summary.includes('returns structured errors rather than throwing'),
    'structured-agent-capabilities must reflect async registerTool and structured error returns',
  );
}


export async function testBaselineOracle() {
  const { lookupBaseline, formatBaseline } = await import('../knowledge/baseline.mjs');

  // 1. Exact ID lookup
  const newly = lookupBaseline('light-dark');
  assert(newly.found === true, 'baseline: light-dark should be found');
  assert(newly.id === 'light-dark' && newly.status === 'newly', 'baseline: light-dark should be newly available');
  assert(newly.featureId === 'light-dark' && newly.featureName === 'light-dark()', 'baseline: schema aliases featureId/featureName must be present');
  assert(newly.fallbackMandatory === true, 'baseline: newly available should mandate a fallback');
  assert(newly.lowDate === '2024-05-13', `baseline: lowDate for light-dark should be 2024-05-13, got ${newly.lowDate}`);

  const widely = lookupBaseline('color-scheme');
  assert(widely.found === true, 'baseline: color-scheme should be found');
  assert(widely.status === 'widely' && widely.fallbackMandatory === false, 'baseline: color-scheme should be widely available');
  assert(widely.highDate === '2024-08-03', `baseline: highDate for color-scheme should be 2024-08-03, got ${widely.highDate}`);

  // 2. BCD compat key lookup & property suffix
  const anchor = lookupBaseline('position-anchor');
  assert(anchor.found === true && anchor.id === 'anchor-positioning', 'baseline: position-anchor should resolve to anchor-positioning');
  assert(anchor.status === 'limited' && anchor.fallbackMandatory === true, 'baseline: anchor-positioning should be limited');

  const fullBcd = lookupBaseline('css.properties.position-anchor');
  assert(fullBcd.found === true && fullBcd.id === 'anchor-positioning', 'baseline: full BCD key should resolve');

  // 3. Name lookup & parenthesis tolerance
  const byName = lookupBaseline('Anchor positioning');
  assert(byName.found === true && byName.id === 'anchor-positioning', 'baseline: lookup by name should resolve');
  const withParens = lookupBaseline('light-dark()');
  assert(withParens.found === true && withParens.id === 'light-dark', 'baseline: query with () should resolve');

  // 4. Symbol forms (@container, :has, :popover-open, ::part)
  const container = lookupBaseline('@container');
  assert(container.found === true && container.id === 'container-queries', 'baseline: @container should resolve to container-queries');
  assert(container.status === 'widely' && container.fallbackMandatory === false, 'baseline: container-queries should be widely available');

  const has = lookupBaseline(':has');
  assert(has.found === true && has.id === 'has', 'baseline: :has should resolve to has');
  assert(has.status === 'widely', 'baseline: :has should be widely available');

  const popover = lookupBaseline(':popover-open');
  assert(popover.found === true && popover.id === 'popover', 'baseline: :popover-open should resolve to popover');
  assert(popover.status === 'newly' && popover.fallbackMandatory === true, 'baseline: popover should be newly available with mandatory fallback');

  // 5. Ambiguous short keys resolve to CSS types first, not data-order collisions
  const min = lookupBaseline('min');
  assert(min.found === true && min.id === 'min-max-clamp', `baseline: min should resolve to min-max-clamp, got ${min.id}`);
  assert(min.status === 'widely', 'baseline: min-max-clamp should be widely available');

  const max = lookupBaseline('max');
  assert(max.found === true && max.id === 'min-max-clamp', `baseline: max should resolve to min-max-clamp, got ${max.id}`);

  // 6. Redirect resolution (single and plural targets)
  const redirect = lookupBaseline('masonry');
  assert(redirect.found === true && redirect.id === 'grid-lanes', 'baseline: masonry should resolve to grid-lanes');
  assert(redirect.redirectedFrom === 'masonry', 'baseline: redirectedFrom should record the alias');

  const pluralRedirect = lookupBaseline('text-wrap-style');
  assert(pluralRedirect.found === true && pluralRedirect.id === 'text-wrap-style', 'baseline: text-wrap-style should be found');
  assert(Array.isArray(pluralRedirect.targets) && pluralRedirect.targets.length === 3, 'baseline: text-wrap-style should have 3 targets');
  assert(pluralRedirect.status === 'limited' && pluralRedirect.fallbackMandatory === true, 'baseline: split feature with limited targets must be limited with mandatory fallback');
  const formattedPlural = formatBaseline(pluralRedirect);
  assert(formattedPlural.includes('text-wrap: pretty') && formattedPlural.includes('Limited availability'), 'baseline: format plural should show individual target statuses');

  // 7. Unknown query & suggestions
  const unknown = lookupBaseline('non-existent-xyz-feature');
  assert(unknown.found === false, 'baseline: unknown feature should return found=false');

  const formattedUnknown = formatBaseline(unknown);
  assert(formattedUnknown.includes('Unknown web platform feature "non-existent-xyz-feature"'), 'baseline: format unknown should name feature');

  // 8. CLI execution: bin/web-uplift.mjs baseline <query> [--json]
  const jsonRun = run(process.execPath, ['bin/web-uplift.mjs', 'baseline', 'light-dark', '--json']);
  assert(jsonRun.status === 0, `baseline CLI: json run failed:\n${jsonRun.stderr}`);
  const parsedJson = JSON.parse(jsonRun.stdout);
  assert(parsedJson.id === 'light-dark' && parsedJson.featureId === 'light-dark' && parsedJson.status === 'newly', 'baseline CLI: json output mismatch');

  const textRun = run(process.execPath, ['bin/web-uplift.mjs', 'baseline', 'color-scheme']);
  assert(textRun.status === 0, `baseline CLI: text run failed:\n${textRun.stderr}`);
  assert(textRun.stdout.includes('Baseline Widely available') && textRun.stdout.includes('Fallback: optional'),
    `baseline CLI: text output unexpected:\n${textRun.stdout}`);

  const symbolRun = run(process.execPath, ['bin/web-uplift.mjs', 'baseline', '@container']);
  assert(symbolRun.status === 0 && symbolRun.stdout.includes('container-queries'),
    `baseline CLI: @container run failed:\n${symbolRun.stdout}`);

  const badRun = run(process.execPath, ['bin/web-uplift.mjs', 'baseline', 'non-existent-xyz-feature']);
  assert(badRun.status === 1, `baseline CLI: bad query should exit 1, got ${badRun.status}`);
  assert(badRun.stderr.includes('Unknown web platform feature'), `baseline CLI: bad query should log error to stderr:\n${badRun.stderr}`);
}

export const mwgPrinciplesTests = [
  testMwgCanonicalisationPinsStringEscaping,
  testMwgArtefactAppliedRulesAxisFailsClosed,
  testMwgDriftExtractPipe,
  testMwgDriftBasisFloor,
  testMwgDriftAlertNamesTheConditionItReports,
  testRuleBasisAnchorsArePinnedPerAppliedVersion,
  testRulesRevisionRequiresProvableEvidenceOnly,
  testGuidanceUsage,
  testGuidanceVersionPinnedInDocs,
  testMwgCatalogRegenerateAgreement,
  testPrinciplesMwgCatalogSyncAndChangedGuidance,
  testMwgCatalogExtract,
  testBaselineOracle,
];

export {
  testMwgDriftExtractPipe,
  testMwgDriftBasisFloor,
  testMwgCatalogExtract,
};

await runSuite(mwgPrinciplesTests, import.meta.url, { timeoutMs: 60000, concurrency: 1 });

// web-uplift-s52q: the applied-rules axis is an instrument now, and instruments need a case that can fail.
// FIXTURES ONLY: this case writes temp copies of the state and of the two rule sources and points the tool at
// them through the same env overrides it already supports for its state and catalog. It never reads or writes
// the live knowledge/ files, so it cannot turn another lane's tree red (docs/speed.md).
function testMwgArtefactAppliedRulesAxisFailsClosed() {
  console.log('Testing that the mwg artefact fails closed on the applied-rules axis (web-uplift-s52q)...');
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), 's52q-axis-'));
  try {
    const base = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'mwg-state.json'), 'utf8'));
    const baseRules = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'mwg-rule-basis.json'), 'utf8'));
    const tmpState = (mutate) => {
      const s = structuredClone(base);
      mutate(s);
      const f = join(tmp, `state-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(f, JSON.stringify(s, null, 2));
      return f;
    };
    const run = (stateFile, { cmd = 'verify', rules } = {}) => spawnSync(
      process.execPath,
      ['tests/mwg-artefact.mjs', cmd],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          MWG_DRIFT_STATE: stateFile,
          ...(rules ? { MWG_RULE_BASIS: rules } : {}),
        },
      },
    );

    // POSITIVE FIRST: the state this repo commits must verify, or every refusal below proves nothing.
    const positive = run(tmpState(() => {}));
    assert(positive.status === 0, `the committed state must verify (got ${positive.status}: ${positive.stderr.trim()})`);

    const missing = run(tmpState((s) => { delete s.appliedRulesVersion; }));
    assert(missing.status === 1 && /appliedRulesVersion/.test(missing.stderr),
      `a missing appliedRulesVersion must fail closed and name the field (got ${missing.status}: ${missing.stderr.trim()})`);

    const bogus = run(tmpState((s) => { s.appliedRulesVersion = '9.9.999'; }));
    assert(bogus.status === 1 && /does not match the applied rules/.test(bogus.stderr),
      `a version that disagrees with the applied rules must fail closed (got ${bogus.status}: ${bogus.stderr.trim()})`);

    const unrecorded = run(tmpState((s) => { delete s.ruleBasisSha256; }));
    assert(unrecorded.status === 1 && /ruleBasisSha256/.test(unrecorded.stderr),
      `an unrecorded rules hash must fail closed (got ${unrecorded.status}: ${unrecorded.stderr.trim()})`);

    // THE RULES CHANGE ITSELF, with the version deliberately unchanged: the case the bead exists for.
    const editedRules = join(tmp, 'rule-basis-edited.json');
    writeFileSync(editedRules, JSON.stringify({ ...baseRules, _probe: 'an edit that nobody bumped for' }, null, 2));
    const drifted = run(tmpState(() => {}), { rules: editedRules });
    assert(drifted.status === 1 && /ruleBasisSha256 mismatch/.test(drifted.stderr),
      `a rules edit with no version bump must fail verify (got ${drifted.status}: ${drifted.stderr.trim()})`);
    const absorbed = run(tmpState(() => {}), { cmd: 'update', rules: editedRules });
    assert(absorbed.status === 1 && /bump the version deliberately/.test(absorbed.stderr),
      `update must refuse to absorb a rules change under an unchanged version (got ${absorbed.status}: ${absorbed.stderr.trim()})`);

    // THE ANALYSED-ONLY PATH MUST PASS (web-uplift-a1vf, correcting my own conflation). Per
    // docs/mwg-train-consumer-contract.md the ANALYSED catalogue axis may advance on its own - upstream guide
    // text moved, no applied-rule change - while appliedRulesVersion stays where it is. My first cut compared
    // principles.guidanceCatalogVersion (an analysed pin) against the rule basis and hashed it with the
    // applied rules, so a legitimate analysed-only update was rejected and forced a needless rule bump.
    const advancedCatalog = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'mwg-catalog.json'), 'utf8'));
    advancedCatalog.version = '9.9.194';                 // a version no rule basis claims
    const advancedCatalogPath = join(tmp, 'catalog-advanced.json');
    writeFileSync(advancedCatalogPath, JSON.stringify(advancedCatalog, null, 2));
    const advancedPrinciples = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'principles.json'), 'utf8'));
    advancedPrinciples.guidanceCatalogVersion = 'modern-web-guidance@9.9.194';
    const advancedPrinciplesPath = join(tmp, 'principles-advanced.json');
    writeFileSync(advancedPrinciplesPath, JSON.stringify(advancedPrinciples, null, 2));
    const advancedState = tmpState((s) => {
      s.analysedVersion = '9.9.194';
      s.catalogSha256 = JSON.parse(spawnSync(
        process.execPath,
        ['tests/mwg-artefact.mjs', 'compute'],
        { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, MWG_DRIFT_CATALOG: advancedCatalogPath } },
      ).stdout).catalogSha256;
    });
    const analysedRun = (cmd, stateFile) => spawnSync(
      process.execPath,
      ['tests/mwg-artefact.mjs', cmd],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          MWG_DRIFT_STATE: stateFile,
          MWG_DRIFT_CATALOG: advancedCatalogPath,
          MWG_PRINCIPLES: advancedPrinciplesPath,
        },
      },
    );
    const analysedOnly = analysedRun('verify', advancedState);
    assert(analysedOnly.status === 0,
      `an ANALYSED-only advance must verify: appliedRulesVersion was not supposed to move (got ${analysedOnly.status}: ${analysedOnly.stderr.trim()})`);

    // and update must accept it while KEEPING appliedRulesVersion where it was.
    const updateTarget = join(tmp, 'state-analysed-only.json');
    writeFileSync(updateTarget, readFileSync(advancedState));
    const updated = analysedRun('update', updateTarget);
    assert(updated.status === 0, `update must accept an analysed-only advance (got ${updated.status}: ${updated.stderr.trim()})`);
    const after = JSON.parse(readFileSync(updateTarget, 'utf8'));
    assert(after.analysedVersion === '9.9.194', `analysedVersion must advance (got ${after.analysedVersion})`);
    assert(after.appliedRulesVersion === base.appliedRulesVersion,
      `appliedRulesVersion must NOT move for an analysed-only advance (got ${after.appliedRulesVersion})`);

    console.log('✔ the applied-rules axis fails closed on a missing, bogus, unrecorded or unbumped value, and an analysed-only advance still passes');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// web-uplift-rxbh: the canonicalisation rule a consumer implements from must pin STRING ESCAPING. The committed
// catalog contains non-ASCII (U+2014), so a serialiser that escapes it computes a different digest for the same
// bytes - Python's json.dumps does that by default. This case implements the documented rule independently (it
// does not call the tool's helper) and checks both directions, with a guard so the experiment is not vacuous: if
// the catalog carried no non-ASCII, the escaped form would equal the literal one and prove nothing.
function testMwgCanonicalisationPinsStringEscaping() {
  console.log('Testing that the canonicalisation rule pins JSON string escaping (P3, web-uplift-rxbh)...');
  const catalog = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'mwg-catalog.json'), 'utf8'));
  const state = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'mwg-state.json'), 'utf8'));
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
    return v;
  };
  const sha = (str) => createHash('sha256').update(str, 'utf8').digest('hex');
  const literal = JSON.stringify(canon(catalog));
  const escaped = literal.replace(/[^\x00-\x7F]/g, (ch) => '\\u' + ch.codePointAt(0).toString(16).padStart(4, '0'));

  assert(/[^\x00-\x7F]/.test(literal), 'the catalog must actually contain non-ASCII, or the comparison below is vacuous');
  assert(sha(literal) === state.catalogSha256,
    `the documented rule, implemented independently with literal non-ASCII, must reproduce the pin (got ${sha(literal)})`);
  // And the NORMATIVE implementation must agree with that independent reading. Without this the case would
  // still pass if the tool's own serialiser started escaping non-ASCII - verified by mutating computeSha256 to
  // escape, which fails verify and now fails here too - so the rule and the implementation are tied together.
  assert(computeSha256(catalog) === state.catalogSha256,
    `the normative implementation must reproduce the pin under the rule it documents (got ${computeSha256(catalog)})`);
  assert(sha(escaped) !== state.catalogSha256,
    'an escaped serialisation must NOT reproduce the pin - that difference is exactly what the rule has to name');
  assert(CANONICALISATION_RULE.includes('literal UTF-8') && CANONICALISATION_RULE.includes('uXXXX'),
    'the normative rule string must state the escaping, not leave it to the consumer');
  console.log('✔ the canonicalisation rule pins JSON string escaping');
}
