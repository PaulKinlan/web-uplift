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


// Validates that every guide in the current Modern Web Guidance catalog (0.0.194)
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

  // Assert the canonical catalog has the full guide set (187 as of the 0.0.194 reanalysis, web-uplift-lcth),
  // includes prompt-api, and has a sorted guideIds list
  assert(
    catalog.guideCount === 187,
    `mwg-catalog.json guideCount must be 187, got ${catalog.guideCount}`,
  );
  assert(
    catalog.guides.length === 187,
    `mwg-catalog.json guides array must contain 187 entries, got ${catalog.guides.length}`,
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
    Array.isArray(catalog.guideIds) && catalog.guideIds.length === 187,
    'mwg-catalog.json must declare a sorted guideIds array of 187 items',
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
  const deadIds = ['prevent-text-wrapping', 'declarative-button-actions'];
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


export function testMwgDriftCheckGuard() {
  const script = join(repoRoot, 'tests', 'mwg-drift-check.mjs');
  const fixDir = join(repoRoot, 'tests', 'fixtures', 'mwg-drift');
  const catalogFixture = join(fixDir, 'catalog-0.0.193.json');
  const stateFixture = join(fixDir, 'state-in-sync.json');

  // web-uplift-m9o3: the check now verifies the rule-basis anchors against the upstream guide
  // text, so every fixture-mode run needs a basis and a corpus. Defaults here rather than repeated
  // at nine call sites; a caller that wants a broken (or absent) corpus overrides them explicitly.
  //
  // web-uplift-kapa: the corpus carries its OWN release label and the check now requires it to be the
  // release under test, so a case has to pair its corpus with its upstream fixture instead of relying
  // on one unlabelled default. corpusFor(version) writes the shared guide text labelled with that
  // version; the default is 0.0.193, the version of upstream-same.json.
  const corpusFor = (version) => {
    const source = JSON.parse(readFileSync(join(fixDir, 'corpus-old.json'), 'utf8'));
    const path = join(tmp, `mwg-drift-corpus-${version.replace(/[^\w.-]/g, '_')}.json`);
    writeFileSync(path, JSON.stringify({ ...source, version }, null, 2));
    return path;
  };
  const runCheck = (args, envOverrides) => {
    return spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MWG_DRIFT_BASIS: join(fixDir, 'basis-fixture.json'),
        MWG_DRIFT_UPSTREAM_CORPUS: corpusFor('0.0.193'),
        ...envOverrides,
      },
    });
  };

  // 1. in-sync fixture + upstream-same -> exit 0.
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
    });
    assert(res.status === 0, `mwg-drift: case 1 (in-sync) failed:\n${res.stderr || res.stdout}`);
  }

  // 1b. web-uplift-m9o3: an in-sync VERSION with a broken ANCHOR must not report in-sync. The
  // state and upstream agree (upstream-same.json), exactly as they did for three days while
  // 0.0.194 had rewritten the text our registry quotes; before this bead the check answered
  // IN-SYNC and exited 0. The anchor condition must also be its OWN result - not delta, not stale.
  {
    const brokenBasis = join(tmp, 'basis-broken-anchor.json');
    const basis = JSON.parse(readFileSync(join(fixDir, 'basis-fixture.json'), 'utf8'));
    basis.rules[0].anchors = ['An anchor sentence that appears in no guide at all'];
    writeFileSync(brokenBasis, JSON.stringify(basis, null, 2));
    const stateCopy = join(tmp, 'state-anchor-broken.json');
    writeFileSync(stateCopy, JSON.stringify(JSON.parse(readFileSync(stateFixture, 'utf8')), null, 2));
    const res = runCheck(['--write'], {
      MWG_DRIFT_STATE: stateCopy,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
      MWG_DRIFT_BASIS: brokenBasis,
    });
    assert(res.status === 4, `mwg-drift: case 1b (in-sync version, broken anchor) must exit 4, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(/ANCHOR-BROKEN/.test(res.stderr), `mwg-drift: case 1b must name the anchor condition: ${res.stderr}`);
    assert(/anchor not found in guide text/.test(res.stderr), `mwg-drift: case 1b must name the anchor that broke: ${res.stderr}`);
    assert(!/IN-SYNC/.test(res.stdout), `mwg-drift: case 1b must not report in-sync with a broken anchor: ${res.stdout}`);
    const written = JSON.parse(readFileSync(stateCopy, 'utf8'));
    assert(written.lastCheckResult === 'anchor-broken', `mwg-drift: case 1b must record its own result, got ${JSON.stringify(written.lastCheckResult)}`);
    assert(written.lastAnchorCheck && written.lastAnchorCheck.result === 'anchor-broken', `mwg-drift: case 1b must record the anchor check, got ${JSON.stringify(written.lastAnchorCheck)}`);
    // The freshness path reports the same condition as itself, NOT as a stale heartbeat: the
    // heartbeat was just refreshed by the --write above, so telling an operator to refresh it
    // would be the folding-together this bead exists to prevent.
    const fresh = runCheck(['--freshness-only', '--max-age', '30h'], { MWG_DRIFT_STATE: stateCopy });
    assert(fresh.status === 4, `mwg-drift: case 1b freshness must exit 4 (anchor-broken), got ${fresh.status}: ${fresh.stderr}`);
    assert(/ANCHOR-BROKEN/.test(fresh.stderr), `mwg-drift: case 1b freshness must name the anchor condition: ${fresh.stderr}`);
    assert(!/STALE/.test(fresh.stderr), `mwg-drift: case 1b freshness must not call a broken anchor stale: ${fresh.stderr}`);
  }

  // 1c. control: the same state and upstream version with an INTACT basis reports in-sync and says
  // the anchors were checked, so 1b is measuring the anchor and not the fixture.
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
    });
    assert(res.status === 0, `mwg-drift: case 1c control must exit 0: ${res.stderr || res.stdout}`);
    assert(/IN-SYNC/.test(res.stdout) && /anchor/.test(res.stdout), `mwg-drift: case 1c must report that the anchors were verified: ${res.stdout}`);
  }

  // 1d. Fixture mode with no guide text must FAIL, not skip the verification: a check that runs
  // only when an optional input is present is the hole web-uplift-70im closed.
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
      MWG_DRIFT_UPSTREAM_CORPUS: '',
    });
    assert(res.status === 1, `mwg-drift: case 1d (no guide text in fixture mode) must fail closed, got ${res.status}: ${res.stdout}`);
    assert(/MWG_DRIFT_UPSTREAM_CORPUS/.test(res.stderr), `mwg-drift: case 1d must name the missing input: ${res.stderr}`);
  }

  // 1e. web-uplift-m9o3 review: guide ids are BASENAMES, so two guide files with the same name in
  // different categories would silently overwrite each other and an anchor could be verified
  // against the wrong guide's text. guidesFromTree() refuses the collision, and this case is what
  // keeps that refusal from being deletable: the fixture corpora bypass the tarball reader, so
  // without a direct test of the reader nothing exercises it (the first attempt at this commit
  // shipped the import and no case, which is exactly the hole the reviewer caught).
  {
    const tree = join(tmp, 'dup-guides');
    mkdirSync(join(tree, 'forms'), { recursive: true });
    mkdirSync(join(tree, 'ui-components'), { recursive: true });
    writeFileSync(join(tree, 'forms', 'duplicate.md'), '# one');
    writeFileSync(join(tree, 'ui-components', 'duplicate.md'), '# two');
    let refused = null;
    try {
      guidesFromTree(tree);
    } catch (err) {
      refused = err.message;
    }
    assert(refused !== null, 'mwg-drift: case 1e a duplicate guide id must be refused, not silently overwritten');
    assert(
      /share the id "duplicate"/.test(refused) && /forms/.test(refused) && /ui-components/.test(refused),
      `mwg-drift: case 1e the refusal must name the id and both files: ${refused}`,
    );
    // A unique tree still reads, so the guard is not simply refusing everything.
    const okTree = join(tmp, 'ok-guides');
    mkdirSync(join(okTree, 'forms'), { recursive: true });
    writeFileSync(join(okTree, 'forms', 'unique.md'), '# only');
    const ok = guidesFromTree(okTree);
    assert(Object.keys(ok).length === 1 && ok.unique === '# only', `mwg-drift: case 1e must still read a unique tree: ${JSON.stringify(ok)}`);
    // And an empty tree is a BLIND check (exit 1 territory), not an anchor break: distinct repairs.
    let emptyRefused = null;
    mkdirSync(join(tmp, 'empty-guides'), { recursive: true });
    try {
      guidesFromTree(join(tmp, 'empty-guides'));
    } catch (err) {
      emptyRefused = err.message;
    }
    assert(emptyRefused !== null && /no guide markdown/.test(emptyRefused), `mwg-drift: case 1e an empty guide tree must be refused: ${emptyRefused}`);
  }

  // 1f. web-uplift-6f8x: the check now emits its own anchor-broken condition, but the WORKFLOW that
  // consumes it has to tell that story. This drives the workflow's own classification block - not a
  // paraphrase of it - with a fixture whose state is IN-SYNC and whose anchor is broken, which is the
  // exact shape that hid for three days of green "in-sync".
  {
    const brokenBasis = join(tmp, 'basis-broken-for-subject.json');
    const basis = JSON.parse(readFileSync(join(fixDir, 'basis-fixture.json'), 'utf8'));
    basis.rules[0].anchors = ['An anchor sentence that appears in no guide at all'];
    writeFileSync(brokenBasis, JSON.stringify(basis, null, 2));
    const stateCopy = join(tmp, 'state-subject.json');
    writeFileSync(stateCopy, JSON.stringify(JSON.parse(readFileSync(stateFixture, 'utf8')), null, 2));
    // --write, because the freshness pass repeats the RECORDED condition: without it the state has
    // no timestamp and freshness would report a missing heartbeat instead (case 1b does the same).
    const checkRun = runCheck(['--write'], {
      MWG_DRIFT_STATE: stateCopy,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
      MWG_DRIFT_BASIS: brokenBasis,
    });
    assert(checkRun.status === 4, `mwg-drift: case 1f fixture must exit 4, got ${checkRun.status}: ${checkRun.stderr}`);
    const guardOutput = `${checkRun.stderr}${checkRun.stdout}`;
    const ruleId = basis.rules[0].id;

    // (i) The subject script, which both workflow jobs call.
    const subject = spawnSync(process.execPath, [join(repoRoot, 'tests', 'mwg-drift-anchor-subject.mjs'), '--json'], {
      input: guardOutput,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert(subject.status === 0, `mwg-drift: case 1f the subject script must recognise the guard's own header, got ${subject.status}: ${subject.stderr}`);
    const parsed = JSON.parse(subject.stdout);
    assert(parsed.condition === 'anchor-broken', `mwg-drift: case 1f condition must be anchor-broken, got ${parsed.condition}`);
    assert(parsed.tag === 'MWG rule-basis anchor broken', `mwg-drift: case 1f tag must be the anchor tag, got ${parsed.tag}`);
    assert(new RegExp(ruleId).test(parsed.title) && /guide [a-z0-9-]+/i.test(parsed.title),
      `mwg-drift: case 1f the title must name the broken rule and its guide: ${parsed.title}`);
    // The whole point of the bead: never the heartbeat or delta story.
    assert(!/heartbeat|stale|unactioned delta|reanalysis needed/i.test(parsed.title), `mwg-drift: case 1f the anchor title must not borrow another condition: ${parsed.title}`);
    // A second, non-anchor report must be refused by the script rather than mislabelled.
    const subjectOf = (text) => spawnSync(process.execPath, [join(repoRoot, 'tests', 'mwg-drift-anchor-subject.mjs'), '--json'], {
      input: text,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const notAnchor = subjectOf('IN-SYNC: upstream version 0.0.193 matches analysed version 0.0.193\n');
    assert(notAnchor.status === 3, `mwg-drift: case 1f an in-sync report must not be classified as anchor-broken, got ${notAnchor.status}`);
    // ANCHORED, not a bare substring grab (the igdk rule). A mention of the phrase inside a line the
    // guard did not emit is not the condition: neither a quoted previous alert nor a "0 problems"
    // report may be turned into one.
    const proseMention = subjectOf('NOTE: an earlier alert said "ANCHOR-BROKEN: 1 rule-basis anchor problem(s) against upstream 0.0.193" but it was repaired.\n');
    assert(proseMention.status === 3, `mwg-drift: case 1f a mid-line mention must not be classified as anchor-broken, got ${proseMention.status}: ${proseMention.stdout}`);
    const zeroProblems = subjectOf('ANCHOR-BROKEN: 0 rule-basis anchor problem(s) against upstream 0.0.193\n');
    assert(zeroProblems.status === 3, `mwg-drift: case 1f "0 problems" is not this condition, got ${zeroProblems.status}: ${zeroProblems.stdout}`);

    // The freshness pass emits a DIFFERENT ANCHOR-BROKEN shape (the recorded condition, no count).
    // Driving the real freshness run here is what caught the first version of the wiring, which only
    // matched the check-pass shape and would have filed "could not complete" for a real anchor break.
    const freshRun = runCheck(['--freshness-only', '--max-age', '30h'], { MWG_DRIFT_STATE: stateCopy });
    assert(freshRun.status === 4, `mwg-drift: case 1f freshness fixture must exit 4, got ${freshRun.status}: ${freshRun.stderr}`);
    const freshSubject = subjectOf(`${freshRun.stderr}${freshRun.stdout}`);
    assert(freshSubject.status === 0, `mwg-drift: case 1f the subject script must recognise the freshness shape, got ${freshSubject.status}: ${freshSubject.stderr}`);
    const freshParsed = JSON.parse(freshSubject.stdout);
    assert(freshParsed.condition === 'anchor-broken' && freshParsed.problemCount === null,
      `mwg-drift: case 1f the freshness shape must classify without inventing a count: ${freshSubject.stdout}`);
    assert(new RegExp(freshParsed.upstreamVersion.replace(/\./g, '\\.')).test(freshParsed.title),
      `mwg-drift: case 1f the recorded-condition title must name the upstream version: ${freshParsed.title}`);

    // (ii) The workflow's freshness classifier, executed as bash with a stub gh. Extracted from the
    // YAML rather than copied, so the test follows the workflow instead of drifting from it.
    const workflowText = readFileSync(join(repoRoot, '.github', 'workflows', 'mwg-drift.yml'), 'utf8');
    const stepMarker = '      - name: Classify the freshness failure and file one issue';
    const start = workflowText.indexOf(stepMarker);
    assert(start !== -1, 'mwg-drift: case 1f cannot find the freshness classification step in .github/workflows/mwg-drift.yml');
    const afterStep = workflowText.indexOf('\n        run: |\n', start);
    assert(afterStep !== -1, 'mwg-drift: case 1f cannot find the run block of the freshness classification step');
    const bodyStart = afterStep + '\n        run: |\n'.length;
    const nextStep = workflowText.indexOf('\n      - name:', bodyStart);
    assert(nextStep !== -1, 'mwg-drift: case 1f cannot find the end of the freshness classification run block');
    const classifyBlock = workflowText.slice(bodyStart, nextStep).split('\n').map((line) => (line.startsWith('          ') ? line.slice(10) : line)).join('\n');

    const binDir = join(tmp, 'gh-bin');
    mkdirSync(binDir, { recursive: true });
    const titleLog = join(tmp, 'gh-created-titles.txt');
    writeFileSync(join(binDir, 'gh'), [
      '#!/bin/sh',
      'if [ "$1 $2" = "issue list" ]; then echo 0; exit 0; fi',
      'if [ "$1 $2" = "issue create" ]; then printf "%s\\n" "$@" >> "' + titleLog + '"; exit 0; fi',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    const classify = (output) => {
      rmSync(titleLog, { force: true });
      const summary = join(tmp, `step-summary-${Math.random().toString(36).slice(2)}.txt`);
      writeFileSync(summary, '');
      const env = {
        PATH: `${binDir}:${process.env.PATH}`,
        GH_TOKEN: 'stub',
        GITHUB_STEP_SUMMARY: summary,
        FRESHNESS_OUTPUT: output,
        HOME: process.env.HOME,
        // The block pipes the guard text into the subject script, which lives in the repo.
        PWD: repoRoot,
      };
      const res = spawnSync('bash', ['-e', '-c', classifyBlock], { cwd: repoRoot, encoding: 'utf8', env, timeout: 30_000 });
      return {
        status: res.status,
        title: existsSync(titleLog) ? readFileSync(titleLog, 'utf8') : '',
        summary: readFileSync(summary, 'utf8'),
        stderr: res.stderr,
      };
    };

    const anchorClassified = classify(guardOutput);
    assert(anchorClassified.status === 0, `mwg-drift: case 1f the freshness classifier must succeed, got ${anchorClassified.status}: ${anchorClassified.stderr}`);
    assert(/--title\nMWG rule-basis anchor broken: /.test(anchorClassified.title),
      `mwg-drift: case 1f the workflow must title an anchor-broken run as anchor-broken, filed: ${JSON.stringify(anchorClassified.title)}`);
    assert(new RegExp(ruleId).test(anchorClassified.title), `mwg-drift: case 1f the workflow title must name the broken rule: ${anchorClassified.title}`);
    assert(/condition=anchor-broken/.test(anchorClassified.summary), `mwg-drift: case 1f the step summary must say anchor-broken: ${anchorClassified.summary}`);
    assert(!/heartbeat|unactioned/i.test(anchorClassified.title), `mwg-drift: case 1f the workflow must not fold the anchor into the heartbeat: ${anchorClassified.title}`);

    // The freshness shape must also classify through the WORKFLOW block, not just through the script.
    const anchorFreshnessClassified = classify(`${freshRun.stderr}${freshRun.stdout}`);
    assert(anchorFreshnessClassified.status === 0, `mwg-drift: case 1f the freshness classifier must succeed on the recorded shape, got ${anchorFreshnessClassified.status}: ${anchorFreshnessClassified.stderr}`);
    assert(/--title\nMWG rule-basis anchor broken against upstream /.test(anchorFreshnessClassified.title),
      `mwg-drift: case 1f the workflow must not call a recorded anchor break "could not complete", filed: ${JSON.stringify(anchorFreshnessClassified.title)}`);

    // Negative control: an ordinary stale heartbeat still gets the heartbeat title, so "anchor first"
    // did not become "everything is an anchor problem".
    const stale = classify('STALE: last check was 35.5h ago, exceeding max-age threshold of 30h\n');
    assert(/MWG drift check heartbeat stale/.test(stale.title) && !/anchor/i.test(stale.title),
      `mwg-drift: case 1f a stale heartbeat must keep its own title, filed: ${JSON.stringify(stale.title)}`);

    // And the check job's wiring: persist on 4, pass the job on 4, and file the anchor issue before
    // Run status decides the outcome.
    const persist = /name: Persist check state[\s\S]*?if: ([^\n]+)\n/.exec(workflowText);
    assert(persist !== null && /'4'/.test(persist[1]), `mwg-drift: case 1f the workflow must persist state on exit 4, found: ${persist && persist[1]}`);
    const status = /name: Run status[\s\S]*?run: \|\n([\s\S]*?)\n\n/.exec(workflowText);
    assert(status !== null && /"4"/.test(status[1]), 'mwg-drift: case 1f Run status must treat exit 4 as work to do, not a job failure');
    assert(workflowText.indexOf('name: File anchor-broken issue') !== -1, 'mwg-drift: case 1f the workflow must file an anchor-broken issue');
    const anchorStep = /name: File anchor-broken issue[\s\S]*?(?=\n      - name:)/.exec(workflowText);
    assert(anchorStep !== null && /mwg-drift-anchor-subject\.mjs/.test(anchorStep[0]),
      'mwg-drift: case 1f the anchor issue step must derive its subject from the testable classifier, not a hand-rolled title');
    assert(anchorStep !== null && /--body-file/.test(anchorStep[0]),
      'mwg-drift: case 1f the anchor issue step must file the body the classifier wrote');
  }

  // 1g. web-uplift-m4ae: a rule that declares NO anchors must not report in-sync. The version
  // comparison never looked at the anchor list's LENGTH, so `anchors: []` ran the loop zero times
  // and the check printed "IN-SYNC ... all 0 rule-basis anchor(s) across 1 rule(s)" and exited 0 -
  // the same false green as an empty registry (case 5 of the basis floor), one level down. A rule
  // that cannot fail is not a rule, and the scheduled workflow persists whatever this says.
  {
    const noAnchorsBasis = join(tmp, 'basis-no-anchors.json');
    const basis = JSON.parse(readFileSync(join(fixDir, 'basis-fixture.json'), 'utf8'));
    basis.rules[0].anchors = [];
    writeFileSync(noAnchorsBasis, JSON.stringify(basis, null, 2));
    const stateCopy = join(tmp, 'state-no-anchors.json');
    writeFileSync(stateCopy, JSON.stringify(JSON.parse(readFileSync(stateFixture, 'utf8')), null, 2));
    const res = runCheck(['--write'], {
      MWG_DRIFT_STATE: stateCopy,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
      MWG_DRIFT_BASIS: noAnchorsBasis,
    });
    assert(res.status === 4, `mwg-drift: case 1g (rule with no anchors) must exit 4, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(/ANCHOR-BROKEN/.test(res.stderr), `mwg-drift: case 1g must name the anchor condition: ${res.stderr}`);
    assert(/declares no anchors/.test(res.stderr) && new RegExp(basis.rules[0].id).test(res.stderr),
      `mwg-drift: case 1g must name the rule and what is wrong with it: ${res.stderr}`);
    assert(!/IN-SYNC/.test(res.stdout) && !/all 0 rule-basis anchor/.test(res.stdout),
      `mwg-drift: case 1g must never report in-sync over zero anchors: ${res.stdout}`);
    const written = JSON.parse(readFileSync(stateCopy, 'utf8'));
    assert(written.lastCheckResult === 'anchor-broken' && written.lastAnchorCheck.result === 'anchor-broken',
      `mwg-drift: case 1g must record the condition it reported, got ${JSON.stringify(written.lastCheckResult)}/${JSON.stringify(written.lastAnchorCheck)}`);
    // The alert subject has to name the rule, or the issue is unactionable. This is the third
    // violation shape and it is read end to end, like the other two.
    const subject = spawnSync(process.execPath, [join(repoRoot, 'tests', 'mwg-drift-anchor-subject.mjs'), '--json'], {
      input: `${res.stderr}${res.stdout}`,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert(subject.status === 0, `mwg-drift: case 1g the subject script must recognise the no-anchors violation, got ${subject.status}: ${subject.stderr}`);
    const parsed = JSON.parse(subject.stdout);
    assert(new RegExp(basis.rules[0].id).test(parsed.title) && parsed.violations[0].kind === 'no-anchors',
      `mwg-drift: case 1g the alert must name the rule that declares no anchors: ${subject.stdout}`);
    // The shared verifier's own invariant, called directly. Both current callers validate the basis
    // structurally at some level (the classifier in validateBasis), so this is the defence in depth
    // that stops a FUTURE caller from inheriting the vacuous pass - which is the reason the anchor
    // question lives in one shared module at all.
    const direct = basisAnchorViolations(
      { rules: [{ id: 'r-direct', guide: 'implemented-rule-guide', anchors: [] }] },
      { 'implemented-rule-guide': 'the guide text' },
    );
    assert(direct.some((v) => /declares no anchors/.test(v) && /r-direct/.test(v)),
      `mwg-drift: case 1g basisAnchorViolations must treat zero anchors as a violation, got ${JSON.stringify(direct)}`);
    const directBlank = basisAnchorViolations(
      { rules: [{ id: 'r-blank', guide: 'implemented-rule-guide', anchors: ['   '] }] },
      { 'implemented-rule-guide': 'the guide text' },
    );
    assert(directBlank.some((v) => /not usable text/.test(v) && /r-blank/.test(v)),
      `mwg-drift: case 1g basisAnchorViolations must reject a blank anchor, got ${JSON.stringify(directBlank)}`);
  }

  // 1h. The likelier regression is the anchors KEY going missing entirely (the bead's repro only
  // empties the list). Pre-fix that did not report somehow-wrong: it threw `rule.anchors is not
  // iterable` out of the shared verifier, so the failure mode was an uncaught TypeError from a
  // module, not the named condition an operator can act on. Same requirement: exit 4, ANCHOR-BROKEN,
  // no in-sync, and the state records it.
  {
    const missingAnchorsBasis = join(tmp, 'basis-missing-anchors.json');
    const basis = JSON.parse(readFileSync(join(fixDir, 'basis-fixture.json'), 'utf8'));
    delete basis.rules[0].anchors;
    writeFileSync(missingAnchorsBasis, JSON.stringify(basis, null, 2));
    const stateCopy = join(tmp, 'state-missing-anchors.json');
    writeFileSync(stateCopy, JSON.stringify(JSON.parse(readFileSync(stateFixture, 'utf8')), null, 2));
    const res = runCheck(['--write'], {
      MWG_DRIFT_STATE: stateCopy,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
      MWG_DRIFT_BASIS: missingAnchorsBasis,
    });
    assert(res.status === 4, `mwg-drift: case 1h (rule with no anchors key) must exit 4, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(/ANCHOR-BROKEN/.test(res.stderr) && /declares no anchors/.test(res.stderr),
      `mwg-drift: case 1h must report the condition, not crash on the iteration: ${res.stderr}`);
    assert(!/TypeError/.test(res.stderr), `mwg-drift: case 1h must not surface an internal TypeError: ${res.stderr}`);
    assert(!/IN-SYNC/.test(res.stdout), `mwg-drift: case 1h must not report in-sync: ${res.stdout}`);
    const written = JSON.parse(readFileSync(stateCopy, 'utf8'));
    assert(written.lastCheckResult === 'anchor-broken', `mwg-drift: case 1h must record anchor-broken, got ${JSON.stringify(written.lastCheckResult)}`);
  }

  // 1i. An anchor that is present but UNUSABLE is the same hole wearing a hat: `includes('')` is
  // true against every guide, so `anchors: ['']` claims to verify something and verifies nothing.
  // The fix must not be satisfiable by a list that merely has a length.
  {
    const emptyAnchorBasis = join(tmp, 'basis-empty-anchor.json');
    const basis = JSON.parse(readFileSync(join(fixDir, 'basis-fixture.json'), 'utf8'));
    basis.rules[0].anchors = [''];
    writeFileSync(emptyAnchorBasis, JSON.stringify(basis, null, 2));
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
      MWG_DRIFT_BASIS: emptyAnchorBasis,
    });
    assert(res.status === 4, `mwg-drift: case 1i (empty-string anchor) must exit 4, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(/not usable text/.test(res.stderr) && /anchor at index 0/.test(res.stderr),
      `mwg-drift: case 1i must name the unusable anchor by index: ${res.stderr}`);
    assert(!/IN-SYNC/.test(res.stdout), `mwg-drift: case 1i must not report in-sync: ${res.stdout}`);
  }

  // 1j. web-uplift-kapa, the bead's own repro: a corpus from the WRONG release. A corpus labelled
  // 0.0.192 paired with an upstream 0.0.193 used to report IN-SYNC with every anchor "verified"
  // against text from a release nobody asked about - the same shape as m4ae (no inputs read as no
  // problems), one level up. The corpus label must be bound to the version under test, and the
  // mismatch must be its OWN failure: never IN-SYNC, and not anchor-broken either, because
  // "re-anchor the registry" is the wrong repair for evidence from the wrong release.
  {
    const stateCopy = join(tmp, 'mwg-drift-state-corpus-mismatch.json');
    writeFileSync(stateCopy, readFileSync(stateFixture, 'utf8'), 'utf8');
    const before = JSON.parse(readFileSync(stateCopy, 'utf8'));
    const res = runCheck(['--write'], {
      MWG_DRIFT_STATE: stateCopy,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
      MWG_DRIFT_UPSTREAM_CORPUS: corpusFor('0.0.192'),
    });
    assert(res.status === 1, `mwg-drift: case 1j (corpus from the wrong release) must fail closed with exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(/corpus-version-mismatch/.test(res.stderr), `mwg-drift: case 1j must name the condition: ${res.stderr}`);
    assert(res.stderr.includes('0.0.192') && res.stderr.includes('0.0.193'),
      `mwg-drift: case 1j must name BOTH versions, the corpus's and the resolved one: ${res.stderr}`);
    assert(!/IN-SYNC/.test(res.stdout) && !/IN-SYNC/.test(res.stderr), `mwg-drift: case 1j must never report in-sync: ${res.stdout}${res.stderr}`);
    assert(!/ANCHOR-BROKEN/.test(res.stdout) && !/ANCHOR-BROKEN/.test(res.stderr), `mwg-drift: case 1j must not be folded into anchor-broken: ${res.stdout}${res.stderr}`);
    // A check that could not bind its evidence must not look like a completed check: no state write.
    const after = JSON.parse(readFileSync(stateCopy, 'utf8'));
    assert(after.lastCheckResult === before.lastCheckResult && after.lastCheckAt === before.lastCheckAt,
      `mwg-drift: case 1j must not persist a result for a run whose evidence belonged to another release, got ${JSON.stringify({ result: after.lastCheckResult, at: after.lastCheckAt })}`);
  }

  // 1k. The same binding catches the fixture pairing that shipped: corpus-old.json says 1.0.0 while
  // upstream-same.json says 0.0.193, and every drift case passed on that pair before this bead. It is
  // the shipped-corpus version, not a hand-crafted mutant, so a fix that only rejects a suspicious
  // 0.0.19x value fails here.
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
      MWG_DRIFT_UPSTREAM_CORPUS: join(fixDir, 'corpus-old.json'),
    });
    assert(res.status === 1, `mwg-drift: case 1k (shipped 1.0.0 corpus against upstream 0.0.193) must fail closed, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(/corpus-version-mismatch/.test(res.stderr), `mwg-drift: case 1k must name the condition: ${res.stderr}`);
    assert(!/IN-SYNC/.test(res.stdout), `mwg-drift: case 1k must not report in-sync: ${res.stdout}`);
  }

  // 1l. A corpus with NO version identity fails closed. The tempting behaviour is to assume the
  // version we resolved, which is the same silence as not checking; an unlabelled corpus cannot be
  // shown to be the release under test.
  {
    const noVersion = join(tmp, 'mwg-drift-corpus-no-version.json');
    const corpus = JSON.parse(readFileSync(join(fixDir, 'corpus-old.json'), 'utf8'));
    delete corpus.version;
    writeFileSync(noVersion, JSON.stringify(corpus, null, 2));
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
      MWG_DRIFT_UPSTREAM_CORPUS: noVersion,
    });
    assert(res.status === 1, `mwg-drift: case 1l (corpus with no version) must fail closed, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(/corpus-version-mismatch/.test(res.stderr) && /no usable version/.test(res.stderr),
      `mwg-drift: case 1l must name the missing identity: ${res.stderr}`);
    assert(!/IN-SYNC/.test(res.stdout), `mwg-drift: case 1l must not report in-sync: ${res.stdout}`);
  }

  // 1m. The real path has the same hole one level down: the registry document names a version and a
  // dist.tarball, and nothing reconciled the two, so a tarball from another release would be read as
  // evidence for the version the DOCUMENT named. Driven end to end with data: URLs (no server, so
  // spawnSync cannot deadlock on a blocked event loop) and a tarball built here; the packaged
  // manifest's version must match the document's before its guide text is used.
  {
    const pkgRoot = join(tmp, 'mwg-drift-tarball');
    const guidesDir = join(pkgRoot, 'package', 'skills', 'modern-web-guidance', 'guides');
    mkdirSync(guidesDir, { recursive: true });
    const corpus = JSON.parse(readFileSync(join(fixDir, 'corpus-old.json'), 'utf8'));
    // The basis quotes one anchor from implemented-rule-guide, so that guide's text is what the
    // control run verifies.
    writeFileSync(join(guidesDir, 'implemented-rule-guide.md'), corpus.guides['implemented-rule-guide']);
    const registryWith = (packageVersion) => {
      writeFileSync(join(pkgRoot, 'package', 'package.json'), JSON.stringify({ name: 'modern-web-guidance', version: packageVersion }));
      const tarballPath = join(tmp, `mwg-drift-pkg-${packageVersion.replace(/[^\w.-]/g, '_')}.tgz`);
      const tar = spawnSync('tar', ['-czf', tarballPath, '-C', pkgRoot, 'package'], { encoding: 'utf8' });
      assert(tar.status === 0, `mwg-drift: case 1m could not build its tarball fixture: ${tar.stderr}`);
      const tarballUrl = `data:application/gzip;base64,${readFileSync(tarballPath).toString('base64')}`;
      const doc = { version: '0.0.193', dist: { tarball: tarballUrl } };
      return `data:application/json,${encodeURIComponent(JSON.stringify(doc))}`;
    };
    const viaRegistry = (packageVersion) => runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_REGISTRY_URL: registryWith(packageVersion),
      MWG_DRIFT_UPSTREAM_FILE: '',
      MWG_DRIFT_UPSTREAM_CORPUS: '',
    });
    const mismatched = viaRegistry('0.0.199');
    assert(mismatched.status === 1, `mwg-drift: case 1m (tarball from another release) must fail closed, got ${mismatched.status}:\n${mismatched.stderr || mismatched.stdout}`);
    assert(/corpus-version-mismatch/.test(mismatched.stderr), `mwg-drift: case 1m must name the condition: ${mismatched.stderr}`);
    assert(mismatched.stderr.includes('0.0.193') && mismatched.stderr.includes('0.0.199'),
      `mwg-drift: case 1m must name the document's version and the tarball's: ${mismatched.stderr}`);
    assert(!/IN-SYNC/.test(mismatched.stdout), `mwg-drift: case 1m must not report in-sync: ${mismatched.stdout}`);
    // Control: the same path with a tarball that DOES name the resolved version still verifies and
    // reports IN-SYNC, so 1m is measuring the binding and not the fixture harness.
    const matched = viaRegistry('0.0.193');
    assert(matched.status === 0, `mwg-drift: case 1m control (matching tarball) must exit 0, got ${matched.status}:\n${matched.stderr || matched.stdout}`);
    assert(/IN-SYNC/.test(matched.stdout) && /anchor/.test(matched.stdout), `mwg-drift: case 1m control must report the anchors were verified: ${matched.stdout}`);
  }

  // 2. upstream-newer -> exit 2, stdout mentions the delta and "0.0.200".
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-newer.json'),
      MWG_DRIFT_UPSTREAM_CORPUS: corpusFor('0.0.200'),
    });
    assert(res.status === 2, `mwg-drift: case 2 (upstream-newer) must exit 2, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(res.stdout.includes('delta') || res.stdout.includes('DELTA'), `mwg-drift: case 2 stdout must mention delta:\n${res.stdout}`);
    assert(res.stdout.includes('0.0.200'), `mwg-drift: case 2 stdout must mention "0.0.200":\n${res.stdout}`);
  }

  // 3. upstream-older -> exit 2.
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-older.json'),
      MWG_DRIFT_UPSTREAM_CORPUS: corpusFor('0.0.150'),
    });
    assert(res.status === 2, `mwg-drift: case 3 (upstream-older) must exit 2, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 4. upstream-unparseable -> exit 1 (never 0).
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-unparseable.txt'),
    });
    assert(res.status === 1, `mwg-drift: case 4 (upstream-unparseable) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 5. upstream-empty -> exit 1.
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-empty.json'),
    });
    assert(res.status === 1, `mwg-drift: case 5 (upstream-empty) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 6. upstream-no-version -> exit 1.
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-no-version.json'),
    });
    assert(res.status === 1, `mwg-drift: case 6 (upstream-no-version) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 7. MWG_DRIFT_UPSTREAM_FILE pointing at a nonexistent path -> exit 1.
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'nonexistent-upstream.json'),
    });
    assert(res.status === 1, `mwg-drift: case 7 (nonexistent upstream) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 8. MWG_DRIFT_STATE pointing at a nonexistent path -> exit 1.
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: join(fixDir, 'nonexistent-state.json'),
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
    });
    assert(res.status === 1, `mwg-drift: case 8 (nonexistent state) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 9. state-in-sync + catalog-mismatch -> exit 1 (state/catalog drift is loud).
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: join(fixDir, 'catalog-mismatch.json'),
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
    });
    assert(res.status === 1, `mwg-drift: case 9 (catalog mismatch) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 10. --write on a COPY of state-in-sync written into the suite tmp dir: run with upstream-newer, assert exit 2 AND the written state has lastCheckResult "delta", lastCheckUpstreamVersion "0.0.200", a non-null lastCheckAt, and preserved analysedVersion "0.0.193".
  {
    const copyPath = join(tmp, 'mwg-drift-state-write-copy.json');
    writeFileSync(copyPath, readFileSync(stateFixture, 'utf8'), 'utf8');
    const res = runCheck(['--write', '--json'], {
      MWG_DRIFT_STATE: copyPath,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-newer.json'),
      MWG_DRIFT_UPSTREAM_CORPUS: corpusFor('0.0.200'),
    });
    assert(res.status === 2, `mwg-drift: case 10 (--write) must exit 2, got ${res.status}:\n${res.stderr || res.stdout}`);
    const written = JSON.parse(readFileSync(copyPath, 'utf8'));
    assert(written.lastCheckResult === 'delta', `mwg-drift: case 10 lastCheckResult must be "delta", got ${written.lastCheckResult}`);
    assert(written.lastCheckUpstreamVersion === '0.0.200', `mwg-drift: case 10 lastCheckUpstreamVersion must be "0.0.200", got ${written.lastCheckUpstreamVersion}`);
    assert(typeof written.lastCheckAt === 'string' && written.lastCheckAt.length > 0, `mwg-drift: case 10 lastCheckAt must be non-null string, got ${written.lastCheckAt}`);
    assert(written.analysedVersion === '0.0.193', `mwg-drift: case 10 analysedVersion must be preserved as "0.0.193", got ${written.analysedVersion}`);
  }

  // 11. freshness: write temp state with lastCheckAt = new Date().toISOString() -> --freshness-only exits 0; lastCheckAt = "2020-01-01T00:00:00.000Z" -> exits 3; the never-run fixture (lastCheckAt null) -> exits 3.
  {
    const freshPath = join(tmp, 'mwg-drift-state-freshness.json');
    const baseState = JSON.parse(readFileSync(stateFixture, 'utf8'));

    // Fresh
    baseState.lastCheckAt = new Date().toISOString();
    writeFileSync(freshPath, JSON.stringify(baseState), 'utf8');
    const freshRes = runCheck(['--freshness-only'], {
      MWG_DRIFT_STATE: freshPath,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
    });
    assert(freshRes.status === 0, `mwg-drift: case 11 (fresh) must exit 0, got ${freshRes.status}:\n${freshRes.stderr || freshRes.stdout}`);

    // Stale
    baseState.lastCheckAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(freshPath, JSON.stringify(baseState), 'utf8');
    const staleRes = runCheck(['--freshness-only'], {
      MWG_DRIFT_STATE: freshPath,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
    });
    assert(staleRes.status === 3, `mwg-drift: case 11 (stale) must exit 3, got ${staleRes.status}:\n${staleRes.stderr || staleRes.stdout}`);

    // Never-run fixture (lastCheckAt is null)
    const neverRunRes = runCheck(['--freshness-only'], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-same.json'),
    });
    assert(neverRunRes.status === 3, `mwg-drift: case 11 (never-run) must exit 3, got ${neverRunRes.status}:\n${neverRunRes.stderr || neverRunRes.stdout}`);
  }

  // 12. The committed knowledge/mwg-state.json validates: analysedVersion === readJson('knowledge/mwg-catalog.json').version, analysedAt === catalog.retrievedAt, and lastCheckResult is one of "never-run","in-sync","delta".
  {
    const catalog = readJson('knowledge/mwg-catalog.json');
    const committedState = readJson('knowledge/mwg-state.json');
    assert(
      committedState.analysedVersion === catalog.version,
      `mwg-drift: case 12 analysedVersion (${committedState.analysedVersion}) must match catalog.version (${catalog.version})`
    );
    assert(
      committedState.analysedAt === catalog.retrievedAt,
      `mwg-drift: case 12 analysedAt (${committedState.analysedAt}) must match catalog.retrievedAt (${catalog.retrievedAt})`
    );
    const validResults = new Set(['never-run', 'in-sync', 'delta', 'anchor-broken']);
    assert(
      validResults.has(committedState.lastCheckResult),
      `mwg-drift: case 12 lastCheckResult (${committedState.lastCheckResult}) must be one of never-run, in-sync, delta`
    );
    // web-uplift-b1p5: a version bump is not an analysis. The state must carry the recorded
    // delta analysis for the version it claims to have analysed, and that record must agree
    // with the catalog it describes - otherwise "analysedVersion 0.0.194 / in-sync" is a
    // heartbeat with nothing behind it. This is the invariant that was MISSING when 0.0.194
    // was recorded as analysed: 31 guide bodies had changed and one rule-basis anchor no
    // longer existed verbatim, and no assertion asked what the analysis had found.
    const analysis = committedState.lastAnalysis;
    assert(analysis && typeof analysis === 'object', 'mwg-drift: case 12 the state must record the delta analysis (lastAnalysis) for the analysed version - a heartbeat alone is not evidence of an analysed basis');
    assert(
      analysis.toVersion === committedState.analysedVersion,
      `mwg-drift: case 12 lastAnalysis.toVersion (${analysis.toVersion}) must be the analysed version (${committedState.analysedVersion}); an analysis of a different release does not describe this one`
    );
    assert(
      typeof analysis.fromVersion === 'string' && analysis.fromVersion !== analysis.toVersion,
      `mwg-drift: case 12 lastAnalysis.fromVersion must name the release the analysis came FROM, got ${JSON.stringify(analysis.fromVersion)}`
    );
    assert(
      typeof analysis.analysedAt === 'string' && !Number.isNaN(Date.parse(analysis.analysedAt)),
      `mwg-drift: case 12 lastAnalysis.analysedAt must be a parseable timestamp, got ${JSON.stringify(analysis.analysedAt)}`
    );
    assert(
      analysis.catalogDelta && analysis.catalogDelta.guideCount === catalog.guideCount,
      `mwg-drift: case 12 lastAnalysis.catalogDelta.guideCount (${analysis.catalogDelta?.guideCount}) must match the committed catalog (${catalog.guideCount})`
    );
    // The record must be internally consistent: its own guide arithmetic has to land on the
    // guide count the catalog actually has, so a half-recorded delta cannot pass as analysis.
    const added = analysis.catalogDelta.addedGuides;
    assert(
      Array.isArray(added) && typeof analysis.catalogDelta.fromGuideCount === 'number' && analysis.catalogDelta.fromGuideCount + added.length - analysis.catalogDelta.removedGuides === catalog.guideCount,
      `mwg-drift: case 12 lastAnalysis must add up: fromGuideCount + addedGuides - removedGuides must equal ${catalog.guideCount}, got ${analysis.catalogDelta.fromGuideCount} + ${Array.isArray(added) ? added.length : 'n/a'} - ${analysis.catalogDelta.removedGuides}`
    );
    // Every added guide must really be in the catalog: the record is a claim about the delta,
    // not a free-text note, and a guide it names that the catalog does not have is drift in
    // the record itself.
    const catalogIds = new Set(catalog.guideIds);
    const missingFromCatalog = added.filter((id) => !catalogIds.has(id));
    assert(
      missingFromCatalog.length === 0,
      `mwg-drift: case 12 lastAnalysis.catalogDelta.addedGuides names guide(s) the catalog does not contain: ${missingFromCatalog.join(', ')}`
    );
    // The verdict has to say something (the bead asked for an analysis, not a timestamp), and
    // the two pin sections are what a future version bump will need to revisit.
    for (const field of ['verdict']) {
      assert(typeof analysis[field] === 'string' && analysis[field].trim().length >= 20, `mwg-drift: case 12 lastAnalysis.${field} must state the finding, not just a version`);
    }
    for (const pin of ['ruleBasis', 'principles']) {
      assert(typeof analysis.pins?.[pin] === 'string' && analysis.pins[pin].trim().length >= 20, `mwg-drift: case 12 lastAnalysis.pins.${pin} must record what the analysis did to that pin`);
    }
  }

  // 13. upstream version with a trailing newline -> exit 1 (JS `$` matches
  // before a final newline; the validator must reject whitespace explicitly).
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-newline.json'),
    });
    assert(res.status === 1, `mwg-drift: case 13 (newline version) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 14. distinct versions must never compare equal: two integers straddling
  // 2^53 collapse under Number(), so equality is exact-string only.
  {
    const hugeState = join(tmp, 'mwg-drift-state-huge.json');
    const hugeCatalog = join(tmp, 'mwg-drift-catalog-huge.json');
    const hugeUpstream = join(tmp, 'mwg-drift-upstream-huge.json');
    const s = JSON.parse(readFileSync(stateFixture, 'utf8'));
    s.analysedVersion = '9007199254740992.0.0';
    writeFileSync(hugeState, JSON.stringify(s), 'utf8');
    writeFileSync(hugeCatalog, JSON.stringify({ source: 'modern-web-guidance', version: '9007199254740992.0.0', retrievedAt: '2026-10-08T00:00:00.000Z', guides: [] }), 'utf8');
    writeFileSync(hugeUpstream, JSON.stringify({ version: '9007199254740993.0.0' }), 'utf8');
    const res = runCheck([], {
      MWG_DRIFT_STATE: hugeState,
      MWG_DRIFT_CATALOG: hugeCatalog,
      MWG_DRIFT_UPSTREAM_FILE: hugeUpstream,
      MWG_DRIFT_UPSTREAM_CORPUS: corpusFor('9007199254740993.0.0'),
    });
    assert(res.status === 2, `mwg-drift: case 14 (distinct huge versions) must exit 2, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(
      res.stdout.includes('DELTA'),
      `mwg-drift: case 14 must report a delta, got:\n${res.stdout}`
    );
  }

  // 15. A DETECTED but unactioned delta must not read as fresh (web-uplift-yh6o). --write advances
  // lastCheckAt for the delta outcome too, so the heartbeat alone cannot see it; the state records that
  // upstream moved and the analysis did not, and the age that matters is the ANALYSIS's.
  {
    const deltaPath = join(tmp, 'mwg-drift-state-delta-age.json');
    const deltaState = JSON.parse(readFileSync(stateFixture, 'utf8'));
    deltaState.analysedVersion = '0.0.193';
    deltaState.lastCheckUpstreamVersion = '0.0.200'; // upstream moved...
    deltaState.lastCheckResult = 'delta';
    deltaState.lastCheckAt = new Date().toISOString(); // ...and the heartbeat is brand new

    // (a) GRACE: the analysis is recent, so the delta is inside the window and a fresh heartbeat stands.
    deltaState.analysedAt = new Date().toISOString();
    writeFileSync(deltaPath, JSON.stringify(deltaState), 'utf8');
    const grace = runCheck(['--freshness-only'], { MWG_DRIFT_STATE: deltaPath });
    assert(grace.status === 0, `mwg-drift: case 15 (delta inside grace) must exit 0, got ${grace.status}:\n${grace.stderr || grace.stdout}`);
    assert(
      grace.stdout.includes('0.0.200') && /NOTE/i.test(grace.stdout),
      `mwg-drift: case 15 (delta inside grace) must SAY the delta is inside the grace, so an operator is never told "fresh" with no qualification: ${grace.stdout}`
    );

    // (b) AGED: the analysis is older than the threshold -> stale, and the message names the delta.
    deltaState.analysedAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(deltaPath, JSON.stringify(deltaState), 'utf8');
    const aged = runCheck(['--freshness-only'], { MWG_DRIFT_STATE: deltaPath });
    assert(aged.status === 3, `mwg-drift: case 15 (aged delta) must exit 3, got ${aged.status}:\n${aged.stderr || aged.stdout}`);
    assert(
      (aged.stderr || '').includes('0.0.200') && (aged.stderr || '').includes('0.0.193'),
      `mwg-drift: case 15 (aged delta) must name the upstream version the check saw AND the analysed version: ${aged.stderr}`
    );

    // (c) FAIL CLOSED: no usable analysedAt means the delta cannot be aged -> stale, not fresh. This is
    // the load-bearing case: assuming "young" here is exactly the quiet failure this guard exists for.
    delete deltaState.analysedAt;
    writeFileSync(deltaPath, JSON.stringify(deltaState), 'utf8');
    const unageable = runCheck(['--freshness-only'], { MWG_DRIFT_STATE: deltaPath });
    assert(unageable.status === 3, `mwg-drift: case 15 (unageable delta) must exit 3, got ${unageable.status}:\n${unageable.stderr || unageable.stdout}`);

    // (f) A future-dated analysedAt must not read as a young analysis and buy the delta unlimited
    // grace - the same reasoning the heartbeat already applies to a future-dated lastCheckAt.
    deltaState.analysedAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    writeFileSync(deltaPath, JSON.stringify(deltaState), 'utf8');
    const future = runCheck(['--freshness-only'], { MWG_DRIFT_STATE: deltaPath });
    assert(future.status === 3, `mwg-drift: case 15 (future-dated analysedAt) must exit 3, got ${future.status}:\n${future.stderr || future.stdout}`);

    // (g) FAIL CLOSED: an upstream version with NO analysedVersion to compare against cannot be shown
        // to be in sync. The flag here deliberately says in-sync, so this exercises the VERSION route on
        // its own - and the first version of this check read exactly this state as FRESH (measured).
        deltaState.lastCheckUpstreamVersion = '0.0.200';
        deltaState.lastCheckResult = 'in-sync';
        delete deltaState.analysedVersion;
        deltaState.analysedAt = '2020-01-01T00:00:00.000Z';
        writeFileSync(deltaPath, JSON.stringify(deltaState), 'utf8');
        const noAnalysed = runCheck(['--freshness-only'], { MWG_DRIFT_STATE: deltaPath });
        assert(noAnalysed.status === 3, `mwg-drift: case 15 (upstream recorded, analysedVersion missing) must exit 3, got ${noAnalysed.status}:\n${noAnalysed.stderr || noAnalysed.stdout}`);

        // (h) FAIL CLOSED: the state SAYS delta but records no upstream version, so the delta can be named
        // by neither version - it must not read as fresh on a fresh heartbeat alone. Also measured as FRESH
        // before this was written, so the assertion is pinned to behaviour that really occurred.
        deltaState.analysedVersion = '0.0.193';
        deltaState.lastCheckUpstreamVersion = null;
        deltaState.lastCheckResult = 'delta';
        writeFileSync(deltaPath, JSON.stringify(deltaState), 'utf8');
        const unnamed = runCheck(['--freshness-only'], { MWG_DRIFT_STATE: deltaPath });
        assert(unnamed.status === 3, `mwg-drift: case 15 (delta flag with no recorded upstream version) must exit 3, got ${unnamed.status}:\n${unnamed.stderr || unnamed.stdout}`);

    // (i) REJECTED OUTRIGHT: the state claims in-sync but records no comparable upstream version, so
        // agreement cannot be shown. analysedAt is deliberately set to NOW, which proves this is a rejection
        // of an unsubstantiable claim rather than the age rule firing - and the first version of this check
        // read exactly this state as FRESH (measured, review finding).
        deltaState.lastCheckResult = 'in-sync';
        deltaState.lastCheckUpstreamVersion = null;
        deltaState.analysedVersion = '0.0.193';
        deltaState.analysedAt = new Date().toISOString();
        writeFileSync(deltaPath, JSON.stringify(deltaState), 'utf8');
        const unsubstantiated = runCheck(['--freshness-only'], { MWG_DRIFT_STATE: deltaPath });
        assert(unsubstantiated.status === 3, `mwg-drift: case 15 (in-sync with a null upstream version) must exit 3 even with a fresh analysedAt, got ${unsubstantiated.status}:\n${unsubstantiated.stderr || unsubstantiated.stdout}`);

        // (j) Same for a NON-STRING upstream version: it cannot be compared either, so the claim is equally
        // unsubstantiable.
        deltaState.lastCheckUpstreamVersion = { version: '0.0.200' };
        writeFileSync(deltaPath, JSON.stringify(deltaState), 'utf8');
        const nonString = runCheck(['--freshness-only'], { MWG_DRIFT_STATE: deltaPath });
        assert(nonString.status === 3, `mwg-drift: case 15 (in-sync with a non-string upstream version) must exit 3, got ${nonString.status}:\n${nonString.stderr || nonString.stdout}`);

        // (k) CONTROL: the VALID in-sync state must still pass, or this fix has broken the real workflow.
        // The committed knowledge/mwg-state.json records the same version on both sides.
        deltaState.lastCheckUpstreamVersion = deltaState.analysedVersion;
        deltaState.analysedAt = '2020-01-01T00:00:00.000Z';
        writeFileSync(deltaPath, JSON.stringify(deltaState), 'utf8');
        const validSync = runCheck(['--freshness-only'], { MWG_DRIFT_STATE: deltaPath });
        assert(validSync.status === 0, `mwg-drift: case 15 (valid in-sync control) must still exit 0, got ${validSync.status}:\n${validSync.stderr || validSync.stdout}`);

    // (l) A never-run (or unrecognised) flag does NOT escape the age rule when it carries a usable
        // upstream version that DISAGREES: the flag says no check ran, the versions say otherwise, and the
        // versions are what the age rule reads. An earlier version of the docs claimed such a state was
        // "judged on lastCheckAt alone whatever its versions say", which is false for exactly this shape
        // (review finding); this case pins the measured behaviour so the prose cannot drift from it again.
        deltaState.lastCheckResult = 'never-run';
        deltaState.lastCheckUpstreamVersion = '0.0.200';
        deltaState.analysedVersion = '0.0.193';
        deltaState.analysedAt = '2020-01-01T00:00:00.000Z';
        writeFileSync(deltaPath, JSON.stringify(deltaState), 'utf8');
        const neverRunDisagreeing = runCheck(['--freshness-only'], { MWG_DRIFT_STATE: deltaPath });
        assert(neverRunDisagreeing.status === 3, `mwg-drift: case 15 (never-run flag with a disagreeing upstream version) must be age-gated and exit 3, got ${neverRunDisagreeing.status}:\n${neverRunDisagreeing.stderr || neverRunDisagreeing.stdout}`);

        // and the shape that really IS heartbeat-only: the same flag with no usable upstream version, which
        // is the shape the existing freshness case uses.
        deltaState.lastCheckUpstreamVersion = null;
        writeFileSync(deltaPath, JSON.stringify(deltaState), 'utf8');
        const neverRunNoUpstream = runCheck(['--freshness-only'], { MWG_DRIFT_STATE: deltaPath });
        assert(neverRunNoUpstream.status === 0, `mwg-drift: case 15 (never-run with no usable upstream version) must be judged on the heartbeat and exit 0, got ${neverRunNoUpstream.status}:\n${neverRunNoUpstream.stderr || neverRunNoUpstream.stdout}`);

    // (d) CONTROL, the other direction: an in-sync state keeps the OLD heartbeat semantics even with an
    // ancient analysedAt, so this change cannot have quietly re-pointed the heartbeat at analysedAt.
    const syncState = JSON.parse(readFileSync(stateFixture, 'utf8'));
    syncState.lastCheckAt = new Date().toISOString();
    syncState.lastCheckUpstreamVersion = syncState.analysedVersion; // versions agree: no delta
    syncState.lastCheckResult = 'in-sync';
    writeFileSync(deltaPath, JSON.stringify(syncState), 'utf8');
    const inSync = runCheck(['--freshness-only'], { MWG_DRIFT_STATE: deltaPath });
    assert(inSync.status === 0, `mwg-drift: case 15 (in-sync control) must still exit 0 on a fresh heartbeat with an old analysis, got ${inSync.status}:\n${inSync.stderr || inSync.stdout}`);
    assert(!/NOTE/i.test(inSync.stdout), `mwg-drift: case 15 (in-sync control) must not carry the delta note: ${inSync.stdout}`);

    // (e) CONTROL against over-refusal: a stale result FLAG with agreeing versions is self-healed rather
    // than an unactioned delta, because the versions are what say whether the analysis matches what the
    // last check saw.
    syncState.lastCheckResult = 'delta'; // left behind; versions still agree
    writeFileSync(deltaPath, JSON.stringify(syncState), 'utf8');
    const healed = runCheck(['--freshness-only'], { MWG_DRIFT_STATE: deltaPath });
    assert(healed.status === 0, `mwg-drift: case 15 (stale flag, agreeing versions) must not be treated as an unactioned delta, got ${healed.status}:\n${healed.stderr || healed.stdout}`);
  }
}


export function testMwgArtefactGuard() {
  const script = join(repoRoot, 'tests', 'mwg-artefact.mjs');
  const fixDir = join(repoRoot, 'tests', 'fixtures', 'mwg-drift');
  const committedCatalog = join(repoRoot, 'knowledge', 'mwg-catalog.json');
  const committedState = join(repoRoot, 'knowledge', 'mwg-state.json');

  const runArtefact = (args, envOverrides) => {
    return spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...envOverrides,
      },
    });
  };

  // 1. verify against the committed state + catalog exits 0.
  {
    const res = runArtefact(['verify'], {
      MWG_DRIFT_STATE: committedState,
      MWG_DRIFT_CATALOG: committedCatalog,
    });
    assert(res.status === 0, `mwg-artefact: case 1 (verify committed) must exit 0, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 2. committed state shape: artifactId === "web-uplift/mwg-catalog", catalogSha256 matches /^[0-9a-f]{64}$/, canonicalisation is the exact rule string, appliedRulesVersion equal to the rule basis's version, and analysedVersion and appliedRulesVersion are both present as distinct fields.
  {
    const state = readJson('knowledge/mwg-state.json');
    assert(
      state.artifactId === 'web-uplift/mwg-catalog',
      `mwg-artefact: case 2 artifactId must be "web-uplift/mwg-catalog", got ${state.artifactId}`
    );
    assert(
      typeof state.catalogSha256 === 'string' && /^[0-9a-f]{64}$/.test(state.catalogSha256),
      `mwg-artefact: case 2 catalogSha256 must match /^[0-9a-f]{64}$/, got ${state.catalogSha256}`
    );
    const expectedCanon =
      'json: recursive lexicographic key sort; array order preserved; compact (no insignificant whitespace); UTF-8; sha256 hex; object keys are emitted in JS property-enumeration order (integer-like keys sort ascending numeric, not lexicographic); tests/mwg-artefact.mjs is the normative implementation; non-ASCII characters are emitted as literal UTF-8, never as \\uXXXX escapes (a serialiser that escapes them computes a different digest for the same catalog - the committed catalog contains U+2014; web-uplift-rxbh)';
    assert(
      state.canonicalisation === expectedCanon,
      `mwg-artefact: case 2 canonicalisation mismatch:\nexpected: ${expectedCanon}\ngot:      ${state.canonicalisation}`
    );
    assert(
      state.appliedRulesVersion === JSON.parse(readFileSync(new URL('../knowledge/mwg-rule-basis.json', import.meta.url), 'utf8')).catalogueVersion,
      `mwg-artefact: case 2 appliedRulesVersion must equal the applied rules' catalogueVersion (${JSON.parse(readFileSync(new URL('../knowledge/mwg-rule-basis.json', import.meta.url), 'utf8')).catalogueVersion}), got ${state.appliedRulesVersion}`
    );
    // Set identity fields: derived from the live catalog, never a hardcoded count
    // (the catalog set may gain prompt-api via web-uplift-968's fix bead).
    const liveCatalog = readJson('knowledge/mwg-catalog.json');
    assert(
      state.guideCount === liveCatalog.guides.length,
      `mwg-artefact: case 2 guideCount (${state.guideCount}) must equal the live catalog guide count (${liveCatalog.guides.length})`
    );
    assert(
      typeof state.guideIdsSha256 === 'string' && /^[0-9a-f]{64}$/.test(state.guideIdsSha256),
      `mwg-artefact: case 2 guideIdsSha256 must match /^[0-9a-f]{64}$/, got ${state.guideIdsSha256}`
    );
    // Pin the exact set-hash construction (sha256, UTF-8 hex, of the sorted
    // guide ids joined by single LF newlines with no trailing newline) so the
    // artefact and the catalog's own guideIdsSha256 declaration can never drift
    // into two constructions claiming to identify the same set.
    const expectedIdsHash = createHash('sha256')
      .update(new TextEncoder().encode(liveCatalog.guides.map((g) => g.id).sort().join('\n')))
      .digest('hex');
    assert(
      state.guideIdsSha256 === expectedIdsHash,
      `mwg-artefact: case 2 guideIdsSha256 (${state.guideIdsSha256}) must equal the newline-joined sorted-id construction (${expectedIdsHash})`
    );
    assert(
      Object.prototype.hasOwnProperty.call(state, 'analysedVersion') &&
      Object.prototype.hasOwnProperty.call(state, 'appliedRulesVersion') &&
      state.analysedVersion !== undefined &&
      state.appliedRulesVersion !== undefined,
      'mwg-artefact: case 2 analysedVersion and appliedRulesVersion must both be present as distinct fields'
    );
  }

  // 3. sabotage: copy the state into tmp, flip one hex char of catalogSha256, verify exits 1.
  {
    const copyPath = join(tmp, 'mwg-state-sabotage-flip.json');
    const state = JSON.parse(readFileSync(committedState, 'utf8'));
    const originalHash = state.catalogSha256;
    const flippedChar = originalHash[0] === 'a' ? 'b' : 'a';
    state.catalogSha256 = flippedChar + originalHash.slice(1);
    writeFileSync(copyPath, JSON.stringify(state, null, 2) + '\n', 'utf8');

    const res = runArtefact(['verify'], {
      MWG_DRIFT_STATE: copyPath,
      MWG_DRIFT_CATALOG: committedCatalog,
    });
    assert(res.status === 1, `mwg-artefact: case 3 (flipped hash) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 4. sabotage: state copy with catalogSha256 removed -> verify exits 1.
  {
    const copyPath = join(tmp, 'mwg-state-sabotage-missing-hash.json');
    const state = JSON.parse(readFileSync(committedState, 'utf8'));
    delete state.catalogSha256;
    writeFileSync(copyPath, JSON.stringify(state, null, 2) + '\n', 'utf8');

    const res = runArtefact(['verify'], {
      MWG_DRIFT_STATE: copyPath,
      MWG_DRIFT_CATALOG: committedCatalog,
    });
    assert(res.status === 1, `mwg-artefact: case 4 (missing hash) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 5. sabotage: catalog copy (in tmp) with one guide description string changed -> compute on it differs from the committed hash.
  {
    const copyPath = join(tmp, 'mwg-catalog-sabotage-desc.json');
    const catalog = JSON.parse(readFileSync(committedCatalog, 'utf8'));
    catalog.guides[0].description += ' modified for sabotage test';
    writeFileSync(copyPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

    const committedStateObj = readJson('knowledge/mwg-state.json');
    const res = runArtefact(['compute'], {
      MWG_DRIFT_STATE: committedState,
      MWG_DRIFT_CATALOG: copyPath,
    });
    assert(res.status === 0, `mwg-artefact: case 5 compute must exit 0, got ${res.status}:\n${res.stderr || res.stdout}`);
    const computedHash = JSON.parse(res.stdout.trim()).catalogSha256;
    assert(
      typeof computedHash === 'string' && /^[0-9a-f]{64}$/.test(computedHash),
      `mwg-artefact: case 5 compute must print a JSON object with a 64-char catalogSha256, got: ${res.stdout}`
    );
    assert(
      computedHash !== committedStateObj.catalogSha256,
      `mwg-artefact: case 5 modified catalog hash (${computedHash}) must differ from committed (${committedStateObj.catalogSha256})`
    );
  }

  // 6. canonicalisation determinism: compute on canon-a.json equals compute on canon-b.json; compute on canon-c.json differs from canon-a.json.
  {
    const canonA = join(fixDir, 'canon-a.json');
    const canonB = join(fixDir, 'canon-b.json');
    const canonC = join(fixDir, 'canon-c.json');

    const resA = runArtefact(['compute'], {
      MWG_DRIFT_STATE: committedState,
      MWG_DRIFT_CATALOG: canonA,
    });
    assert(resA.status === 0, `mwg-artefact: case 6 compute canon-a failed:\n${resA.stderr || resA.stdout}`);
    const hashA = resA.stdout.trim();

    const resB = runArtefact(['compute'], {
      MWG_DRIFT_STATE: committedState,
      MWG_DRIFT_CATALOG: canonB,
    });
    assert(resB.status === 0, `mwg-artefact: case 6 compute canon-b failed:\n${resB.stderr || resB.stdout}`);
    const hashB = resB.stdout.trim();

    const resC = runArtefact(['compute'], {
      MWG_DRIFT_STATE: committedState,
      MWG_DRIFT_CATALOG: canonC,
    });
    assert(resC.status === 0, `mwg-artefact: case 6 compute canon-c failed:\n${resC.stderr || resC.stdout}`);
    const hashC = resC.stdout.trim();

    assert(hashA === hashB, `mwg-artefact: case 6 canon-a hash (${hashA}) must equal canon-b hash (${hashB})`);
    assert(hashA !== hashC, `mwg-artefact: case 6 canon-c hash (${hashC}) must differ from canon-a hash (${hashA})`);
  }

  // 7. update on a tmp state copy writes the hash that compute prints (round trip), preserves unrelated keys, and ends the file with a trailing newline.
  {
    const copyPath = join(tmp, 'mwg-state-update-roundtrip.json');
    const originalContent = readFileSync(committedState, 'utf8');
    const state = JSON.parse(originalContent);
    state.catalogSha256 = '0000000000000000000000000000000000000000000000000000000000000000';
    state.unrelatedKey = 'preserved-value';
    writeFileSync(copyPath, JSON.stringify(state, null, 2) + '\n', 'utf8');

    const computeRes = runArtefact(['compute'], {
      MWG_DRIFT_STATE: copyPath,
      MWG_DRIFT_CATALOG: committedCatalog,
    });
    assert(computeRes.status === 0, `mwg-artefact: case 7 compute failed:\n${computeRes.stderr || computeRes.stdout}`);
    const expectedHash = JSON.parse(computeRes.stdout.trim()).catalogSha256;

    const updateRes = runArtefact(['update'], {
      MWG_DRIFT_STATE: copyPath,
      MWG_DRIFT_CATALOG: committedCatalog,
    });
    assert(updateRes.status === 0, `mwg-artefact: case 7 update failed:\n${updateRes.stderr || updateRes.stdout}`);

    const rawAfterUpdate = readFileSync(copyPath, 'utf8');
    assert(rawAfterUpdate.endsWith('\n'), 'mwg-artefact: case 7 updated state file must end with trailing newline');

    const updatedState = JSON.parse(rawAfterUpdate);
    assert(
      updatedState.catalogSha256 === expectedHash,
      `mwg-artefact: case 7 catalogSha256 must match computed hash (${expectedHash}), got ${updatedState.catalogSha256}`
    );
    assert(
      updatedState.unrelatedKey === 'preserved-value',
      `mwg-artefact: case 7 unrelatedKey must be preserved, got ${updatedState.unrelatedKey}`
    );
    assert(
      updatedState.artifactId === state.artifactId,
      `mwg-artefact: case 7 artifactId must be preserved, got ${updatedState.artifactId}`
    );
    assert(
      updatedState.analysedVersion === state.analysedVersion,
      `mwg-artefact: case 7 analysedVersion must be preserved, got ${updatedState.analysedVersion}`
    );
    assert(
      typeof updatedState.guideIdsSha256 === 'string' && /^[0-9a-f]{64}$/.test(updatedState.guideIdsSha256) &&
      updatedState.guideCount === readJson('knowledge/mwg-catalog.json').guides.length,
      'mwg-artefact: case 7 update must also write guideIdsSha256 and the live guideCount'
    );
  }

  // 8. sabotage: flip one hex char of guideIdsSha256 -> verify exits 1.
  {
    const copyPath = join(tmp, 'mwg-state-sabotage-flip-ids.json');
    const state = JSON.parse(readFileSync(committedState, 'utf8'));
    const original = state.guideIdsSha256;
    state.guideIdsSha256 = (original[0] === 'a' ? 'b' : 'a') + original.slice(1);
    writeFileSync(copyPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    const res = runArtefact(['verify'], {
      MWG_DRIFT_STATE: copyPath,
      MWG_DRIFT_CATALOG: committedCatalog,
    });
    assert(res.status === 1, `mwg-artefact: case 8 (flipped guideIdsSha256) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 9. sabotage: guideCount off by one -> verify exits 1 (a count is checked, but never alone).
  {
    const copyPath = join(tmp, 'mwg-state-sabotage-count.json');
    const state = JSON.parse(readFileSync(committedState, 'utf8'));
    state.guideCount = state.guideCount + 1;
    writeFileSync(copyPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    const res = runArtefact(['verify'], {
      MWG_DRIFT_STATE: copyPath,
      MWG_DRIFT_CATALOG: committedCatalog,
    });
    assert(res.status === 1, `mwg-artefact: case 9 (guideCount off by one) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 10. sabotage: the catalog's own declared set identity disagrees with its
  // guides array -> update REFUSES to write (never write a state verify would
  // reject) and verify exits 1 (extractor defects fail closed).
  {
    const catCopy = join(tmp, 'mwg-catalog-sabotage-declared-count.json');
    const catalog = JSON.parse(readFileSync(committedCatalog, 'utf8'));
    catalog.guideCount = catalog.guides.length + 1;
    writeFileSync(catCopy, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    const res = runArtefact(['verify'], {
      MWG_DRIFT_STATE: committedState,
      MWG_DRIFT_CATALOG: catCopy,
    });
    const stateCopy = join(tmp, 'mwg-state-for-declared-count.json');
    writeFileSync(stateCopy, readFileSync(committedState, 'utf8'), 'utf8');
    const upd = runArtefact(['update'], {
      MWG_DRIFT_STATE: stateCopy,
      MWG_DRIFT_CATALOG: catCopy,
    });
    assert(upd.status === 1, `mwg-artefact: case 10 update must REFUSE a catalog with inconsistent declarations, got ${upd.status}:\n${upd.stderr || upd.stdout}`);
    const untouched = JSON.parse(readFileSync(stateCopy, 'utf8'));
    assert(
      untouched.catalogSha256 === readJson('knowledge/mwg-state.json').catalogSha256,
      'mwg-artefact: case 10 refused update must leave the state file untouched'
    );
    assert(res.status === 1, `mwg-artefact: case 10 verify must exit 1, got ${res.status}`);
  }

  // 11. catalog declares a guideIdsSha256: wrong value -> exit 1; the correct
  // derived value -> exit 0. (The committed catalog may not declare one yet;
  // inject both forms into a tmp copy.)
  {
    const state = readJson('knowledge/mwg-state.json');
    const catalog = JSON.parse(readFileSync(committedCatalog, 'utf8'));
    catalog.guideIdsSha256 = state.guideIdsSha256;
    const catGood = join(tmp, 'mwg-catalog-declared-ids-good.json');
    writeFileSync(catGood, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    const stateCopy = join(tmp, 'mwg-state-for-declared-ids.json');
    writeFileSync(stateCopy, readFileSync(committedState, 'utf8'), 'utf8');
    const upd = runArtefact(['update'], {
      MWG_DRIFT_STATE: stateCopy,
      MWG_DRIFT_CATALOG: catGood,
    });
    assert(upd.status === 0, `mwg-artefact: case 11 update failed:\n${upd.stderr || upd.stdout}`);
    const good = runArtefact(['verify'], {
      MWG_DRIFT_STATE: stateCopy,
      MWG_DRIFT_CATALOG: catGood,
    });
    assert(good.status === 0, `mwg-artefact: case 11 (declared guideIdsSha256 matches derived) must exit 0, got ${good.status}:\n${good.stderr || good.stdout}`);
    catalog.guideIdsSha256 = (state.guideIdsSha256[0] === 'a' ? 'b' : 'a') + state.guideIdsSha256.slice(1);
    const catBad = join(tmp, 'mwg-catalog-declared-ids-bad.json');
    writeFileSync(catBad, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    // update refuses to write from a catalog whose declaration disagrees with
    // its guides array, and names the declared-vs-derived mismatch.
    const stateCopyBad = join(tmp, 'mwg-state-for-declared-ids-bad.json');
    writeFileSync(stateCopyBad, readFileSync(committedState, 'utf8'), 'utf8');
    const updBad = runArtefact(['update'], {
      MWG_DRIFT_STATE: stateCopyBad,
      MWG_DRIFT_CATALOG: catBad,
    });
    assert(updBad.status === 1, `mwg-artefact: case 11 update must refuse the bad declaration, got ${updBad.status}`);
    assert(
      (updBad.stderr + updBad.stdout).includes('guideIdsSha256 declaration'),
      `mwg-artefact: case 11 must name the declared-vs-derived mismatch:\n${updBad.stderr || updBad.stdout}`
    );
    const bad = runArtefact(['verify'], {
      MWG_DRIFT_STATE: stateCopyBad,
      MWG_DRIFT_CATALOG: catBad,
    });
    assert(bad.status === 1, `mwg-artefact: case 11 (declared guideIdsSha256 wrong) must exit 1, got ${bad.status}`);
  }

  // 12. web-uplift-nlem: a state recorded BEFORE the rules/evidence digest split must not verify green. It
  // carries the combined ruleBasisSha256 and NEITHER split digest, so before this bead verify exited 0 through
  // the old single-hash path and the split - the check introduced to make a same-version evidence-only
  // re-record assertable - simply did not run on it (p71b's escape hatch, one layer down). Exit 4 is its OWN
  // condition: not a pass, and not a mismatch, so a gate can tell "cannot be split-verified" from "verified"
  // and from "wrong".
  const legacyStatePath = (name) => {
    const path = join(tmp, name);
    const legacy = JSON.parse(readFileSync(committedState, 'utf8'));
    delete legacy.rulesSha256;
    delete legacy.basisSha256;
    writeFileSync(path, JSON.stringify(legacy, null, 2) + '\n', 'utf8');
    return path;
  };
  {
    const legacyState = legacyStatePath('mwg-artefact-legacy-state.json');
    const res = runArtefact(['verify'], { MWG_DRIFT_STATE: legacyState, MWG_DRIFT_CATALOG: committedCatalog });
    assert(res.status === 4, `mwg-artefact: case 12 (state with no split digests) must exit 4, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(/LEGACY-UNVERIFIED/.test(res.stderr), `mwg-artefact: case 12 must name the legacy condition: ${res.stderr}`);
    assert(
      res.stderr.includes('rulesSha256') && res.stderr.includes('basisSha256'),
      `mwg-artefact: case 12 must name both missing split digests: ${res.stderr}`
    );
    assert(/--accept-legacy-split/.test(res.stderr), `mwg-artefact: case 12 must name the migration command: ${res.stderr}`);
    assert(!/^OK:/m.test(res.stdout), `mwg-artefact: case 12 must not report OK for a state it could not split-verify: ${res.stdout}`);
  }

  // 13. update must not ESTABLISH the split digests as a side effect: that records a claim nobody verified,
  // which is exactly what p71b refused for the --accept-rules-revision flag. Without the migration flag it
  // refuses and writes nothing.
  {
    const path = legacyStatePath('mwg-artefact-legacy-update.json');
    const res = runArtefact(['update'], { MWG_DRIFT_STATE: path, MWG_DRIFT_CATALOG: committedCatalog });
    assert(res.status === 1, `mwg-artefact: case 13 (plain update on a legacy state) must refuse, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(/--accept-legacy-split/.test(res.stderr), `mwg-artefact: case 13 must name the migration flag: ${res.stderr}`);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert(
      after.rulesSha256 === undefined && after.basisSha256 === undefined,
      `mwg-artefact: case 13 must not write the split digests it refused to establish, got ${JSON.stringify({ rules: after.rulesSha256, basis: after.basisSha256 })}`
    );
  }

  // 14. the migration path, and the defined story for pre-split artefacts: the combined digest is unchanged, so
  // NEITHER axis moved since the artefact was recorded; with the reason recorded the state is migrated, the
  // acceptance and its reason are in the state file, and verify then passes on that same copy.
  {
    const path = legacyStatePath('mwg-artefact-legacy-migrate.json');
    const res = runArtefact(['update', '--accept-legacy-split', 'mwg-artefact case 14: the recorded rules are the ones this tree applies'], {
      MWG_DRIFT_STATE: path,
      MWG_DRIFT_CATALOG: committedCatalog,
    });
    assert(res.status === 0, `mwg-artefact: case 14 (migration with an unchanged combined digest) must succeed, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(/MIGRATED/.test(res.stdout), `mwg-artefact: case 14 must say it migrated: ${res.stdout}`);
    const migrated = JSON.parse(readFileSync(path, 'utf8'));
    const committed = JSON.parse(readFileSync(committedState, 'utf8'));
    assert(
      migrated.rulesSha256 === committed.rulesSha256 && migrated.basisSha256 === committed.basisSha256,
      'mwg-artefact: case 14 must establish the digests the tree computes, not an invented pair'
    );
    assert(
      migrated.lastLegacySplitAcceptance && migrated.lastLegacySplitAcceptance.reason.includes('case 14'),
      `mwg-artefact: case 14 must record the acceptance and its reason, got ${JSON.stringify(migrated.lastLegacySplitAcceptance)}`
    );
    const after = runArtefact(['verify'], { MWG_DRIFT_STATE: path, MWG_DRIFT_CATALOG: committedCatalog });
    assert(after.status === 0, `mwg-artefact: case 14 verify after migration must exit 0, got ${after.status}:\n${after.stderr || after.stdout}`);
  }

  // 15. the migration is only provable while the combined digest stands still. If it moved, the single hash
  // cannot say WHICH axis moved, so the reason string cannot make the artrefact safe and the artefact has to be
  // re-recorded through the reviewed path (a deliberate appliedRulesVersion bump).
  {
    const path = legacyStatePath('mwg-artefact-legacy-moved.json');
    const moved = JSON.parse(readFileSync(path, 'utf8'));
    moved.ruleBasisSha256 = 'f'.repeat(64);
    writeFileSync(path, JSON.stringify(moved, null, 2) + '\n', 'utf8');
    const res = runArtefact(['update', '--accept-legacy-split', 'mwg-artefact case 15: trust me'], {
      MWG_DRIFT_STATE: path,
      MWG_DRIFT_CATALOG: committedCatalog,
    });
    assert(res.status === 1, `mwg-artefact: case 15 (migration after the combined digest moved) must refuse, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(/refusing --accept-legacy-split/.test(res.stderr), `mwg-artefact: case 15 must name the refusal: ${res.stderr}`);
    assert(
      res.stderr.includes('ruleBasisSha256') && /appliedRulesVersion/.test(res.stderr),
      `mwg-artefact: case 15 must name the digest it compared and the reviewed path: ${res.stderr}`
    );
  }

  // 16. the split digests must be CHECKED, not merely written: flipping one alone exits 1 and names that axis.
  // Before this bead a flipped split digest was invisible whenever the combined digest still matched, which left
  // the split decorative in the one command whose job is verification.
  for (const [axis, field, otherField] of [
    ['RULES', 'rulesSha256', 'basisSha256'],
    ['EVIDENCE', 'basisSha256', 'rulesSha256'],
  ]) {
    const path = join(tmp, `mwg-artefact-split-flip-${field}.json`);
    const flipped = JSON.parse(readFileSync(committedState, 'utf8'));
    flipped[field] = (flipped[field][0] === 'a' ? 'b' : 'a') + flipped[field].slice(1);
    writeFileSync(path, JSON.stringify(flipped, null, 2) + '\n', 'utf8');
    const res = runArtefact(['verify'], { MWG_DRIFT_STATE: path, MWG_DRIFT_CATALOG: committedCatalog });
    assert(res.status === 1, `mwg-artefact: case 16 (${field} flipped) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
    assert(
      res.stderr.includes(`${field} mismatch`),
      `mwg-artefact: case 16 (${field} flipped) must report the ${field} mismatch: ${res.stderr}`
    );
    assert(
      res.stderr.includes(axis),
      `mwg-artefact: case 16 (${field} flipped) must name the ${axis} axis, so the repair is readable: ${res.stderr}`
    );
    assert(
      !res.stderr.includes(`${otherField} mismatch`),
      `mwg-artefact: case 16 (${field} flipped) must not blame ${otherField}: ${res.stderr}`
    );
  }
}


export function testMwgDriftClassifierGuard() {
  const script = join(repoRoot, 'tests', 'mwg-drift-classify.mjs');
  const fixDir = join(repoRoot, 'tests', 'fixtures', 'mwg-drift');
  const corpusOld = join(fixDir, 'corpus-old.json');
  const basisFixture = join(fixDir, 'basis-fixture.json');

  const runClassifier = (args) => {
    return spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
      },
    });
  };

  const parseJsonLine = (stdout) => {
    const lines = stdout.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{') && line.endsWith('}')) {
        return JSON.parse(line);
      }
    }
    throw new Error(`No JSON line found in stdout:\n${stdout}`);
  };

  // 1. old vs corpus-new-reversal -> exit 2; stdout has the REVERSED section and
  // it appears BEFORE any CHANGED or NEW section heading; the JSON line lists
  // implemented-rule-guide under reversed with the missing anchor.
  {
    const newCorpus = join(fixDir, 'corpus-new-reversal.json');
    const res = runClassifier([
      '--old-corpus', corpusOld,
      '--new-corpus', newCorpus,
      '--basis', basisFixture,
      '--json',
    ]);
    assert(res.status === 2, `mwg-drift-classify: case 1 must exit 2, got ${res.status}:\n${res.stderr || res.stdout}`);
    const revIdx = res.stdout.indexOf('REVERSED');
    const chgIdx = res.stdout.indexOf('CHANGED');
    const newIdx = res.stdout.indexOf('NEW');
    assert(revIdx !== -1, 'mwg-drift-classify: case 1 stdout must contain REVERSED section');
    if (chgIdx !== -1) {
      assert(revIdx < chgIdx, 'mwg-drift-classify: case 1 REVERSED section must precede CHANGED section');
    }
    if (newIdx !== -1) {
      assert(revIdx < newIdx, 'mwg-drift-classify: case 1 REVERSED section must precede NEW section');
    }
    const json = parseJsonLine(res.stdout);
    assert(json.reversed.length === 1, `mwg-drift-classify: case 1 expected 1 reversed guide, got ${json.reversed.length}`);
    assert(json.reversed[0].guide === 'implemented-rule-guide', 'mwg-drift-classify: case 1 expected implemented-rule-guide under reversed');
    assert(
      json.reversed[0].missingAnchors.includes("Always pin object-src to 'none' in the Content-Security-Policy header."),
      `mwg-drift-classify: case 1 missingAnchors must include object-src sentence, got: ${JSON.stringify(json.reversed[0].missingAnchors)}`
    );
  }

  // 2. old vs corpus-new-cosmetic -> exit 2; zero reversed; implemented-rule-guide under changed.
  {
    const newCorpus = join(fixDir, 'corpus-new-cosmetic.json');
    const res = runClassifier([
      '--old-corpus', corpusOld,
      '--new-corpus', newCorpus,
      '--basis', basisFixture,
      '--json',
    ]);
    assert(res.status === 2, `mwg-drift-classify: case 2 must exit 2, got ${res.status}:\n${res.stderr || res.stdout}`);
    const json = parseJsonLine(res.stdout);
    assert(json.reversed.length === 0, `mwg-drift-classify: case 2 expected 0 reversed guides, got ${json.reversed.length}`);
    assert(
      json.changed.some((c) => c.guide === 'implemented-rule-guide'),
      'mwg-drift-classify: case 2 expected implemented-rule-guide under changed'
    );
  }

  // 3. old vs corpus-new-mixed -> exit 2 (positive control): brand-new-guide under new,
  // implemented-rule-guide and withdrawn-guide under changed, zero reversed.
  {
    const newCorpus = join(fixDir, 'corpus-new-mixed.json');
    const res = runClassifier([
      '--old-corpus', corpusOld,
      '--new-corpus', newCorpus,
      '--basis', basisFixture,
      '--json',
    ]);
    assert(res.status === 2, `mwg-drift-classify: case 3 must exit 2, got ${res.status}:\n${res.stderr || res.stdout}`);
    const json = parseJsonLine(res.stdout);
    assert(json.reversed.length === 0, `mwg-drift-classify: case 3 expected 0 reversed guides, got ${json.reversed.length}`);
    assert(
      json.new.some((n) => n.guide === 'brand-new-guide'),
      'mwg-drift-classify: case 3 expected brand-new-guide under new'
    );
    assert(
      json.changed.some((c) => c.guide === 'implemented-rule-guide'),
      'mwg-drift-classify: case 3 expected implemented-rule-guide under changed'
    );
    assert(
      json.changed.some((c) => c.guide === 'withdrawn-guide'),
      'mwg-drift-classify: case 3 expected withdrawn-guide under changed'
    );
  }

  // 4. old vs corpus-new-withdrawn-implemented -> exit 2; implemented-rule-guide under reversed with a withdrawn reason.
  {
    const newCorpus = join(fixDir, 'corpus-new-withdrawn-implemented.json');
    const res = runClassifier([
      '--old-corpus', corpusOld,
      '--new-corpus', newCorpus,
      '--basis', basisFixture,
      '--json',
    ]);
    assert(res.status === 2, `mwg-drift-classify: case 4 must exit 2, got ${res.status}:\n${res.stderr || res.stdout}`);
    const json = parseJsonLine(res.stdout);
    assert(json.reversed.length === 1, `mwg-drift-classify: case 4 expected 1 reversed guide, got ${json.reversed.length}`);
    assert(json.reversed[0].guide === 'implemented-rule-guide', 'mwg-drift-classify: case 4 expected implemented-rule-guide under reversed');
    assert(
      typeof json.reversed[0].reason === 'string' && /withdrawn/i.test(json.reversed[0].reason),
      `mwg-drift-classify: case 4 reason must note withdrawal, got ${json.reversed[0].reason}`
    );
  }

  // 5. old vs corpus-new-empty -> exit 1.
  {
    const newCorpus = join(fixDir, 'corpus-new-empty.json');
    const res = runClassifier([
      '--old-corpus', corpusOld,
      '--new-corpus', newCorpus,
      '--basis', basisFixture,
    ]);
    assert(res.status === 1, `mwg-drift-classify: case 5 must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 6. old vs corpus-unparseable.txt -> exit 1.
  {
    const newCorpus = join(fixDir, 'corpus-unparseable.txt');
    const res = runClassifier([
      '--old-corpus', corpusOld,
      '--new-corpus', newCorpus,
      '--basis', basisFixture,
    ]);
    assert(res.status === 1, `mwg-drift-classify: case 6 must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 7. missing --new-corpus file -> exit 1.
  {
    const res = runClassifier([
      '--old-corpus', corpusOld,
      '--new-corpus', join(fixDir, 'does-not-exist.json'),
      '--basis', basisFixture,
    ]);
    assert(res.status === 1, `mwg-drift-classify: case 7 must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 8. old vs old (identical) -> exit 0.
  {
    const res = runClassifier([
      '--old-corpus', corpusOld,
      '--new-corpus', corpusOld,
      '--basis', basisFixture,
      '--json',
    ]);
    assert(res.status === 0, `mwg-drift-classify: case 8 must exit 0, got ${res.status}:\n${res.stderr || res.stdout}`);
    const json = parseJsonLine(res.stdout);
    assert(json.reversed.length === 0, 'mwg-drift-classify: case 8 expected 0 reversed');
    assert(json.changed.length === 0, 'mwg-drift-classify: case 8 expected 0 changed');
    assert(json.new.length === 0, 'mwg-drift-classify: case 8 expected 0 new');
  }

  // 9. sabotage the basis: tmp copy of basis-fixture.json with the anchor edited to a string absent from the corpus -> --verify-basis exits 1.
  {
    const copyPath = join(tmp, 'mwg-basis-sabotage.json');
    const basis = JSON.parse(readFileSync(basisFixture, 'utf8'));
    basis.rules[0].anchors = ['Sentence deliberately absent from baseline corpus for sabotage test'];
    writeFileSync(copyPath, JSON.stringify(basis, null, 2) + '\n', 'utf8');

    const res = runClassifier([
      '--verify-basis', corpusOld,
      '--basis', copyPath,
      '--catalog', join(fixDir, 'catalog-fixture-set.json'),
    ]);
    assert(res.status === 1, `mwg-drift-classify: case 9 (sabotaged anchor) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 10. --verify-basis with basis-fixture.json against corpus-old.json -> exit 0.
  {
    const res = runClassifier([
      '--verify-basis', corpusOld,
      '--basis', basisFixture,
      '--catalog', join(fixDir, 'catalog-fixture-set.json'),
    ]);
    assert(res.status === 0, `mwg-drift-classify: case 10 must exit 0, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 11. --extract on the fixture package: the USE_CASES table is parsed
  // declaratively (it is deliberately not pure JSON), both guides are found
  // through their category paths, and extraction exits 0.
  {
    const outPath = join(tmp, 'mwg-extract-fixture-corpus.json');
    const res = runClassifier([
      '--extract', join(fixDir, 'pkg-ok'),
      '--version', '1.0.0',
      '-o', outPath,
    ]);
    assert(res.status === 0, `mwg-drift-classify: case 11 extract must exit 0, got ${res.status}:\n${res.stderr || res.stdout}`);
    const corpus = JSON.parse(readFileSync(outPath, 'utf8'));
    assert(corpus.version === '1.0.0', `mwg-drift-classify: case 11 corpus version must be 1.0.0, got ${corpus.version}`);
    assert(
      typeof corpus.guides['alpha-guide'] === 'string' && corpus.guides['alpha-guide'].includes('Fixture text for alpha-guide'),
      'mwg-drift-classify: case 11 alpha-guide text must come from its category path'
    );
    assert(
      typeof corpus.guides['beta-guide'] === 'string' && corpus.guides['beta-guide'].includes('Fixture text for beta-guide'),
      'mwg-drift-classify: case 11 beta-guide text must come from its category path'
    );
    // The union scan must pick up a guide file that has NO USE_CASES entry
    // (the prompt-api defect class: present on disk, absent from the table).
    assert(
      typeof corpus.guides['gamma-guide'] === 'string' && corpus.guides['gamma-guide'].includes('NO USE_CASES entry'),
      'mwg-drift-classify: case 11 gamma-guide (unlisted in USE_CASES) must be extracted by the union scan'
    );
    assert(
      Object.keys(corpus.guides).length === 4,
      `mwg-drift-classify: case 11 must extract exactly 4 guides, got ${Object.keys(corpus.guides).length}`
    );
    // Extraction provenance: table-located guides are use_cases, the unlisted
    // gamma-guide is scan. The delta-guide file is intentionally EMPTY: it must
    // keep use_cases provenance (own-property presence, not truthiness).
    assert(
      corpus.provenance &&
      corpus.provenance['alpha-guide'] === 'use_cases' &&
      corpus.provenance['beta-guide'] === 'use_cases' &&
      corpus.provenance['delta-guide'] === 'use_cases' &&
      corpus.guides['delta-guide'] === '' &&
      corpus.provenance['gamma-guide'] === 'scan',
      `mwg-drift-classify: case 11 provenance must be use_cases x3 (incl. empty delta-guide) + scan, got ${JSON.stringify(corpus.provenance)}`
    );
  }

  // 12. --extract on an empty package dir must fail loud (exit 1), never emit
  // an empty corpus silently.
  {
    const res = runClassifier([
      '--extract', join(fixDir, 'pkg-empty'),
      '--version', '1.0.0',
    ]);
    assert(res.status === 1, `mwg-drift-classify: case 12 extract of an empty package must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 13. corpus version with a trailing newline -> exit 1 (JS `$` matches
  // before a final newline; validation must reject whitespace explicitly).
  {
    const nlCorpus = join(tmp, 'mwg-corpus-newline-version.json');
    const c = JSON.parse(readFileSync(corpusOld, 'utf8'));
    c.version = '1.0.0\n';
    writeFileSync(nlCorpus, JSON.stringify(c), 'utf8');
    const res = runClassifier([
      '--old-corpus', corpusOld,
      '--new-corpus', nlCorpus,
      '--basis', basisFixture,
    ]);
    assert(res.status === 1, `mwg-drift-classify: case 13 (newline version) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 14. an empty baseline corpus is not a baseline: exit 1 whether or not the
  // target is also empty (two empty corpora must never report success).
  {
    const emptyOld = join(fixDir, 'corpus-old-empty.json');
    const resA = runClassifier([
      '--old-corpus', emptyOld,
      '--new-corpus', join(fixDir, 'corpus-new-cosmetic.json'),
      '--basis', basisFixture,
    ]);
    assert(resA.status === 1, `mwg-drift-classify: case 14a (empty baseline) must exit 1, got ${resA.status}`);
    const resB = runClassifier([
      '--old-corpus', emptyOld,
      '--new-corpus', join(fixDir, 'corpus-new-empty.json'),
      '--basis', basisFixture,
    ]);
    assert(resB.status === 1, `mwg-drift-classify: case 14b (both corpora empty) must exit 1, got ${resB.status}`);
  }

  // 15. --extract on a package whose USE_CASES table carries a traversal id
  // and a slug-valid entry whose guide file is an escaping symlink: the escape
  // target exists on disk but must NOT be read; only the legitimate guide is
  // extracted.
  {
    const outPath = join(tmp, 'mwg-extract-evil-corpus.json');
    const res = runClassifier([
      '--extract', join(fixDir, 'pkg-evil'),
      '--version', '1.0.0',
      '-o', outPath,
    ]);
    assert(res.status === 0, `mwg-drift-classify: case 15 extract must exit 0, got ${res.status}:\n${res.stderr || res.stdout}`);
    const corpus = JSON.parse(readFileSync(outPath, 'utf8'));
    const ids = Object.keys(corpus.guides);
    assert(ids.length === 1 && ids[0] === 'legit-guide', `mwg-drift-classify: case 15 must extract only legit-guide, got ${JSON.stringify(ids)}`);
    assert(
      !Object.values(corpus.guides).some((t) => t.includes('ESCAPE-MARKER')),
      'mwg-drift-classify: case 15 traversal target must never be read'
    );
  }

  // 16. registry/catalogueVersion binding: a basis registry written against a
  // different catalog version than the baseline corpus fails loud (exit 1),
  // never silently classifies with a stale registry.
  {
    const staleBasis = join(tmp, 'mwg-basis-wrong-version.json');
    const b = JSON.parse(readFileSync(basisFixture, 'utf8'));
    b.catalogueVersion = '9.9.9';
    writeFileSync(staleBasis, JSON.stringify(b), 'utf8');
    const res = runClassifier([
      '--old-corpus', corpusOld,
      '--new-corpus', join(fixDir, 'corpus-new-cosmetic.json'),
      '--basis', staleBasis,
    ]);
    assert(res.status === 1, `mwg-drift-classify: case 16 (stale registry version) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
    const resV = runClassifier([
      '--verify-basis', corpusOld,
      '--basis', staleBasis,
      '--catalog', join(fixDir, 'catalog-fixture-set.json'),
    ]);
    assert(resV.status === 1, `mwg-drift-classify: case 16b (verify-basis, stale registry version) must exit 1, got ${resV.status}`);
  }

  // 17. --catalog validation: every registered guide id must exist in the
  // catalog's guide set and the registry catalogueVersion must match the
  // catalog version.
  {
    const catalogFixture = join(fixDir, 'catalog-fixture-set.json');
    const okRes = runClassifier([
      '--verify-basis', corpusOld,
      '--basis', basisFixture,
      '--catalog', catalogFixture,
    ]);
    assert(okRes.status === 0, `mwg-drift-classify: case 17a (catalog consistent) must exit 0, got ${okRes.status}:\n${okRes.stderr || okRes.stdout}`);

    const missingIdCatalog = join(tmp, 'mwg-catalog-missing-id.json');
    const c1 = JSON.parse(readFileSync(catalogFixture, 'utf8'));
    c1.guideIds = c1.guideIds.filter((x) => x !== 'implemented-rule-guide');
    c1.guides = c1.guides.filter((g) => g.id !== 'implemented-rule-guide');
    writeFileSync(missingIdCatalog, JSON.stringify(c1), 'utf8');
    const missRes = runClassifier([
      '--verify-basis', corpusOld,
      '--basis', basisFixture,
      '--catalog', missingIdCatalog,
    ]);
    assert(missRes.status === 1, `mwg-drift-classify: case 17b (registry guide absent from catalog) must exit 1, got ${missRes.status}`);

    const wrongVerCatalog = join(tmp, 'mwg-catalog-wrong-version.json');
    const c2 = JSON.parse(readFileSync(catalogFixture, 'utf8'));
    c2.version = '9.9.9';
    writeFileSync(wrongVerCatalog, JSON.stringify(c2), 'utf8');
    const verRes = runClassifier([
      '--verify-basis', corpusOld,
      '--basis', basisFixture,
      '--catalog', wrongVerCatalog,
    ]);
    assert(verRes.status === 1, `mwg-drift-classify: case 17c (registry version != catalog version) must exit 1, got ${verRes.status}`);

    // The two id representations must agree: a stale guideIds declaration
    // cannot mask a registry guide removed from the guides array.
    const staleDeclCatalog = join(tmp, 'mwg-catalog-stale-decl.json');
    const c3 = JSON.parse(readFileSync(catalogFixture, 'utf8'));
    c3.guides = c3.guides.filter((g) => g.id !== 'implemented-rule-guide');
    writeFileSync(staleDeclCatalog, JSON.stringify(c3), 'utf8');
    const declRes = runClassifier([
      '--verify-basis', corpusOld,
      '--basis', basisFixture,
      '--catalog', staleDeclCatalog,
    ]);
    assert(declRes.status === 1, `mwg-drift-classify: case 17d (guideIds vs guides[] disagreement) must exit 1, got ${declRes.status}`);

    // An empty --catalog value is a usage error, never a skipped validation.
    const emptyRes = runClassifier([
      '--verify-basis', corpusOld,
      '--basis', basisFixture,
      '--catalog', '',
    ]);
    assert(emptyRes.status === 64, `mwg-drift-classify: case 17e (empty --catalog) must exit 64, got ${emptyRes.status}`);

    // 17f. web-uplift-70im: OMITTING --catalog is the same class of error as passing an empty
    // one - a usage error, never a skipped validation. It used to exit 0 and print "OK: basis
    // verified" for a registry guide that had gone missing from the catalog, because the
    // registry-vs-catalog check only ran when the option was present. Assert the refusal, its
    // code, that it names the missing input, and that it does NOT report success.
    const noCatRes = runClassifier([
      '--verify-basis', corpusOld,
      '--basis', basisFixture,
    ]);
    assert(noCatRes.status === 64, `mwg-drift-classify: case 17f (omitted --catalog) must be a usage error 64, got ${noCatRes.status}: ${noCatRes.stderr || noCatRes.stdout}`);
    assert(/requires --catalog/.test(noCatRes.stderr), `mwg-drift-classify: case 17f must name the missing input: ${noCatRes.stderr}`);
    assert(!/OK: basis verified/.test(noCatRes.stdout), `mwg-drift-classify: case 17f must not report success without verifying: ${noCatRes.stdout}`);
  }

  // 19. A registry WITHOUT catalogueVersion fails validation: the binding
  // cannot be disabled by deleting the field.
  {
    const noVerBasis = join(tmp, 'mwg-basis-no-version.json');
    const b = JSON.parse(readFileSync(basisFixture, 'utf8'));
    delete b.catalogueVersion;
    writeFileSync(noVerBasis, JSON.stringify(b), 'utf8');
    const res = runClassifier([
      '--verify-basis', corpusOld,
      '--basis', noVerBasis,
      '--catalog', join(fixDir, 'catalog-fixture-set.json'),
    ]);
    assert(res.status === 1, `mwg-drift-classify: case 19 (missing catalogueVersion) must exit 1, got ${res.status}`);
    const resC = runClassifier([
      '--old-corpus', corpusOld,
      '--new-corpus', join(fixDir, 'corpus-new-cosmetic.json'),
      '--basis', noVerBasis,
    ]);
    assert(resC.status === 1, `mwg-drift-classify: case 19b (classify, missing catalogueVersion) must exit 1, got ${resC.status}`);
  }

  // 20. The committed registry stays honest against the committed catalog
  // (in-process, no spawn): every registered guide id is in the catalog's
  // guideIds and the registry catalogueVersion matches the catalog version.
  {
    const basis = readJson('knowledge/mwg-rule-basis.json');
    const catalog = readJson('knowledge/mwg-catalog.json');
    const catalogIds = new Set(catalog.guideIds || catalog.guides.map((g) => g.id));
    // A floor for the loop below: with no rules every assertion in it passes for the wrong
    // reason, and an empty shipped registry is exactly how reversal detection disappears
    // (web-uplift-uxr). The tool refuses one now; this asserts the committed one is not one.
    assert(
      Array.isArray(basis.rules) && basis.rules.length > 0,
      `mwg-drift-classify: case 20 the registry must declare at least one rule (got ${JSON.stringify(basis.rules)})`
    );
    for (const rule of basis.rules) {
      assert(
        catalogIds.has(rule.guide),
        `mwg-drift-classify: case 20 registry rule "${rule.id}" references guide "${rule.guide}" absent from catalog guideIds`
      );
    }
    // The two axes are separate (web-uplift-a1vf): the contract lets the ANALYSED catalogue advance on its own
    // when upstream guide text moves without applied-rule changes, keeping appliedRulesVersion, and the artefact
    // guard deliberately never compares the analysed pin to the rule basis. This case used to require the two
    // versions to be EQUAL, which forbade exactly the state the contract permits - the assertion was stronger
    // than the contract, so it is replaced by the invariants that do hold: both versions are well formed, and
    // the state's appliedRulesVersion agrees with the registry it describes. Found while actioning the 0.0.194
    // reanalysis (web-uplift-lcth), where the catalogue moved and the applied rules legitimately did not.
    assert(
      typeof basis.catalogueVersion === 'string' && /^\d+\.\d+\.\d+/.test(basis.catalogueVersion),
      `mwg-drift-classify: case 20 registry catalogueVersion must be a semver (got ${JSON.stringify(basis.catalogueVersion)})`
    );
    assert(
      typeof catalog.version === 'string' && /^\d+\.\d+\.\d+/.test(catalog.version),
      `mwg-drift-classify: case 20 catalog version must be a semver (got ${JSON.stringify(catalog.version)})`
    );
    const state = readJson('knowledge/mwg-state.json');
    assert(
      state.appliedRulesVersion === basis.catalogueVersion,
      `mwg-drift-classify: case 20 the state's appliedRulesVersion (${state.appliedRulesVersion}) must match the registry it describes (${basis.catalogueVersion})`
    );
  }
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
  testMwgDriftCheckGuard,
  testMwgArtefactGuard,
  testMwgDriftClassifierGuard,
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
