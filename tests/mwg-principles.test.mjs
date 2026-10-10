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


// Validates that every guide in the current Modern Web Guidance catalog (0.0.193)
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

  // Assert canonical catalog has 178 guides, includes prompt-api, and has a sorted guideIds list
  assert(
    catalog.guideCount === 178,
    `mwg-catalog.json guideCount must be 178, got ${catalog.guideCount}`,
  );
  assert(
    catalog.guides.length === 178,
    `mwg-catalog.json guides array must contain 178 entries, got ${catalog.guides.length}`,
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
    Array.isArray(catalog.guideIds) && catalog.guideIds.length === 178,
    'mwg-catalog.json must declare a sorted guideIds array of 178 items',
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
  if (catalog.guideIdsSha256) {
    const computedHash = createHash('sha256').update(catalog.guideIds.join('\n')).digest('hex');
    assert(
      catalog.guideIdsSha256 === computedHash,
      `mwg-catalog.json guideIdsSha256 must match sha256 of newline-joined guideIds (expected ${computedHash}, got ${catalog.guideIdsSha256})`,
    );
  }

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

  const runCheck = (args, envOverrides) => {
    return spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
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

  // 2. upstream-newer -> exit 2, stdout mentions the delta and "0.0.200".
  {
    const res = runCheck([], {
      MWG_DRIFT_STATE: stateFixture,
      MWG_DRIFT_CATALOG: catalogFixture,
      MWG_DRIFT_UPSTREAM_FILE: join(fixDir, 'upstream-newer.json'),
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
    const validResults = new Set(['never-run', 'in-sync', 'delta']);
    assert(
      validResults.has(committedState.lastCheckResult),
      `mwg-drift: case 12 lastCheckResult (${committedState.lastCheckResult}) must be one of never-run, in-sync, delta`
    );
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

  // 2. committed state shape: artifactId === "web-uplift/mwg-catalog", catalogSha256 matches /^[0-9a-f]{64}$/, canonicalisation is the exact rule string, appliedRulesVersion === "0.0.193", and analysedVersion and appliedRulesVersion are both present as distinct fields.
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
      'json: recursive lexicographic key sort; array order preserved; compact (no insignificant whitespace); UTF-8; sha256 hex; object keys are emitted in JS property-enumeration order (integer-like keys sort ascending numeric, not lexicographic); tests/mwg-artefact.mjs is the normative implementation';
    assert(
      state.canonicalisation === expectedCanon,
      `mwg-artefact: case 2 canonicalisation mismatch:\nexpected: ${expectedCanon}\ngot:      ${state.canonicalisation}`
    );
    assert(
      state.appliedRulesVersion === '0.0.193',
      `mwg-artefact: case 2 appliedRulesVersion must be "0.0.193", got ${state.appliedRulesVersion}`
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
    ]);
    assert(res.status === 1, `mwg-drift-classify: case 9 (sabotaged anchor) must exit 1, got ${res.status}:\n${res.stderr || res.stdout}`);
  }

  // 10. --verify-basis with basis-fixture.json against corpus-old.json -> exit 0.
  {
    const res = runClassifier([
      '--verify-basis', corpusOld,
      '--basis', basisFixture,
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
    assert(
      basis.catalogueVersion === catalog.version,
      `mwg-drift-classify: case 20 registry catalogueVersion (${basis.catalogueVersion}) must match catalog version (${catalog.version})`
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
  testMwgDriftExtractPipe,
  testMwgDriftBasisFloor,
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
