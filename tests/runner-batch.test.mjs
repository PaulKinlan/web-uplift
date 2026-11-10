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
import { spawn, spawnSync } from "node:child_process";
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
import { snapshotTree, diffTrees, executableIntegrity, EXECUTABLE_HASH_ROOTS } from "../runner/write-scope.mjs";
import { testBatchResumeIsolation } from "./batch-resume-isolation.mjs";
import {
  testSnapshotRunStructure,
  testSnapshotRunCopiesArtifacts,
  testSnapshotRunMissingArtifactsBestEffort,
  testSnapshotRunCopyErrorTolerance,
} from "./snapshot-run.mjs";
import { testFlowNormalize, testFlowRecordSensitiveRedaction, testFlowReplayMutationGate, testFlowReplaySchemeGate } from "./flow.mjs";
import { testFlowPierceShadowRootBrowser } from "./flow-shadow-browser.mjs";



// The batch isolation gate (web-uplift-odx): the batch runner drives the SAME
// write-capable, prompt-injectable agent as fix mode, so it must refuse to
// spawn until the operator names a boundary - or explicitly acknowledges none -
// exactly like the fixer. A stub agent on PATH proves whether a spawn happened, and WHEN IT DID NOT the
// assertion reports the run's status, stderr and whether the security record was written (web-uplift-y741):
// a refusal from the pre-spawn integrity gate, a spawn failure and a runner abort all leave no capture file.
export async function testBatchIsolationGate() {
  const isoTmp = mkdtempSync(join(tmpdir(), 'web-uplift-isolation-'));
  try {
    const captureFile = join(isoTmp, 'spawned.txt');
    const binDir = join(isoTmp, 'bin');
    mkdirSync(binDir);
    const stubPath = join(binDir, 'claude');
    writeFileSync(stubPath, `#!/bin/sh\ntouch ${captureFile}\nexit 0\n`);
    chmodSync(stubPath, 0o755);
    const baseEnv = { PATH: `${binDir}:${process.env.PATH}`, HOME: isoTmp };
    // WHEN THE CAPTURE FILE IS MISSING THE ASSERTION HAS TO SAY WHY (web-uplift-y741). A missing file means
    // the runner never spawned the agent and not that the file was late - runAgent resolves on the child's
    // 'close' event and rejects on a non-zero exit, so the stub's touch has already happened if the child
    // ran at all. But SEVERAL different fates produce the missing file: the pre-spawn integrity gate
    // refusing the spawn because the executed set changed since the batch started (a deliberate refusal),
    // a spawn failure such as ENOENT, or the runner aborting before the spawn. The original assertion
    // discarded the status and the stderr, so every one of them read as the same bare 'must spawn the
    // agent' - which is why this case could not be diagnosed when it failed under load. The assertion stays
    // exactly as strict; only what it prints on failure changes.
    const spawnFailure = (label, run, outDir) =>
      `${label} must spawn the agent: status=${run.status} signal=${run.signal} recordWritten=${existsSync(join(outDir, 'run-security.json'))} stderr=${JSON.stringify((run.stderr || '').slice(-300))}`;
    const driveBatch = (extra) =>
      runAsync(process.execPath, [join(repoRoot, 'runner', 'run-batch.mjs'), 'https://example.com', '--agent', 'claude', ...extra], { env: baseEnv });

    // 1. NO ASSERTION: refused BEFORE any spawn, exit 1, stderr names the
    //    contract, the refusal is recorded, the stub never ran.
    const refused = await driveBatch(['--out', join(isoTmp, 'r1')]);
    assert(refused.status === 1, `no assertion must refuse with exit 1: ${refused.status} ${refused.stderr.slice(-200)}`);
    assert(refused.stderr.includes('REFUSED') && refused.stderr.includes('--isolation'), `the refusal must name the flag: ${refused.stderr.slice(-300)}`);
    assert(!existsSync(captureFile), 'a refused run must NOT spawn the agent');
    const refusedRecord = JSON.parse(readFileSync(join(isoTmp, 'r1', 'run-security.json'), 'utf8'));
    assert(refusedRecord.isolation === 'refused', `the refusal must be recorded: ${JSON.stringify(refusedRecord)}`);

    // 2. AN ASSERTION: proceeds (the stub spawns), records operator-supplied +
    //    UNVERIFIED, warns. The stub writes no report.json, so the run ends as
    //    a reportless failure (exit 1) - what is asserted is that the GATE
    //    passed: a spawn happened and no REFUSED was printed.
    const asserted = await driveBatch(['--isolation', 'docker', '--out', join(isoTmp, 'r2')]);
    assert(existsSync(captureFile), spawnFailure('an asserted run', asserted, join(isoTmp, 'r2')));
    assert(!asserted.stderr.includes('REFUSED'), `an asserted run must not be refused: ${asserted.stderr.slice(-200)}`);
    rmSync(captureFile);
    const okRecord = JSON.parse(readFileSync(join(isoTmp, 'r2', 'run-security.json'), 'utf8'));
    assert(
      okRecord.isolation === 'operator-supplied:docker' && okRecord.unverified === true,
      `the record must say operator-supplied and UNVERIFIED: ${JSON.stringify(okRecord)}`,
    );
    assert(asserted.stderr.includes('UNVERIFIED'), 'an asserted run must warn on stderr');

    // 3. THE EXPLICIT ACKNOWLEDGEMENT: proceeds, recorded as acknowledged-none.
    const acked = await driveBatch(['--i-know-this-is-unisolated', '--out', join(isoTmp, 'r3')]);
    assert(existsSync(captureFile), spawnFailure('an acknowledged run', acked, join(isoTmp, 'r3')));
    assert(!acked.stderr.includes('REFUSED'), `an acknowledged run must not be refused: ${acked.stderr.slice(-200)}`);
    const ackRecord = JSON.parse(readFileSync(join(isoTmp, 'r3', 'run-security.json'), 'utf8'));
    assert(ackRecord.isolation === 'operator-acknowledged-none', `the acknowledgement must be recorded: ${JSON.stringify(ackRecord)}`);

    // 4. DRY-RUN EXEMPTION: spawns nothing, so no assertion is required.
    const dry = await driveBatch(['--dry-run', '--out', join(isoTmp, 'r4')]);
    assert(dry.status === 0, `a dry run must not require the assertion: ${dry.status} ${dry.stderr.slice(-200)}`);

    // 5. THE CONTROL: an acknowledged run whose agent cannot be spawned at all must leave NO capture file.
    //    Without this the assertions above could pass for a runner that never spawned anything, and the
    //    case would be measuring its own stub rather than the gate (web-uplift-y741). Measured on this
    //    path: status 1 and stderr naming 'spawn claude ENOENT'. The file from step 3 is removed first, so
    //    the absence asserted here is an absence and not an oversight.
    rmSync(captureFile, { force: true });
    const noAgent = await runAsync(
      process.execPath,
      [join(repoRoot, 'runner', 'run-batch.mjs'), 'https://example.com', '--agent', 'claude', '--i-know-this-is-unisolated', '--out', join(isoTmp, 'r5')],
      { env: { PATH: '/nonexistent', HOME: isoTmp } },
    );
    assert(noAgent.status !== 0, `a run whose agent cannot be spawned must not report success: ${noAgent.status} ${noAgent.stderr.slice(-200)}`);
    assert(!existsSync(captureFile), 'and must leave no capture file: this is what proves the spawn assertions above can fail');
  } finally {
    rmSync(isoTmp, { recursive: true, force: true });
  }
}


export function testBatchDryRunUsesRetainedDirs() {
  const reports = join(tmp, 'reports');
  const result = run(process.execPath, [
    'runner/run-batch.mjs',
    '--dry-run',
    '--agent',
    'codex',
    '--out',
    reports,
    'https://example.com',
  ]);
  assert(result.status === 0, `batch dry-run failed: ${result.stderr || result.stdout}`);
  assert(
    result.stdout.includes(`${reports}/example_com/<timestamp>`),
    `batch dry-run did not use retained run dir:\n${result.stdout}`,
  );
  assert(!result.stdout.includes(`${reports}/codex/`), `batch dry-run still used old agent prefix:\n${result.stdout}`);
}


export function testBatchFlowDryRun() {
  const reports = join(tmp, 'reports-flow');
  const flowPath = join(tmp, 'flow.json');
  writeFileSync(flowPath, JSON.stringify({
    title: 'Signup',
    steps: [{ type: 'navigate', url: 'https://example.com/' }, { type: 'click', selectors: [['#go']] }],
  }));
  const result = run(process.execPath, [
    'runner/run-batch.mjs', '--dry-run', '--agent', 'claude', '--out', reports, '--flow', flowPath, 'https://example.com',
  ]);
  assert(result.status === 0, `batch --flow dry-run failed: ${result.stderr || result.stdout}`);
  assert(result.stdout.includes('would replay') && result.stdout.includes('Signup'), `batch --flow dry-run did not announce the replay:\n${result.stdout}`);
  assert(result.stdout.includes('already replayed for you'.toLowerCase()) || result.stdout.includes('ALREADY replayed'), `batch --flow dry-run did not pass flow guidance to the agent:\n${result.stdout}`);
}


// web-uplift-wy6: the batch audit path gets the same write-scope accounting as fix
// mode, with FOUR things a review found missing: the DEFAULT output must be walked
// (the generic exclusion skips a directory named reports/), a refused run must not be
// usable as the current result for its URL, concurrent runs must not refuse each
// other's clean work, and the escape path must be exercised with a FAILING agent.
export function testBatchWriteScope() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-batchscope-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const findings = join(repoRoot, 'examples', 'playground-report.json');

    const drive = ({ args = [], body, extraArgs = [], cwd = root }) => {
      const bin = join(binDir, 'claude');
      if (body) {
        writeFileSync(bin, `#!/bin/sh\n${body}\n`);
        chmodSync(bin, 0o755);
      }
      const res = run(process.execPath, [join(repoRoot, 'runner', 'run-batch.mjs'), ...args, '--agent', 'claude', '--isolation', 'test-suite', ...extraArgs],
        { cwd, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } });
      return res;
    };
    const writesReport = (outAbs) => [
      `d=$(ls -dt ${JSON.stringify(outAbs)}/*/*/ 2>/dev/null | head -1)`,
      `cp ${JSON.stringify(findings)} "$d/report.json"`,
    ].join('\n');
    const hostDir = (outName) => {
      const abs = join(root, outName);
      const host = readdirSync(abs)[0];
      return { root: join(abs, host), run: readdirSync(join(abs, host)).find((e) => !e.startsWith('latest')) };
    };

    // 1. THE DEFAULT OUTPUT (no --out at all, i.e. `reports/`) must be walked and
    //    recorded as an allowed change. A positive control on a convenient custom
    //    output name hid exactly this: the default tree is dropped by the generic
    //    exclusion, so it was unwatched in both directions.
    const dflt = drive({ args: ['https://example.com/'], extraArgs: ['--concurrency', '1'], body: writesReport(join(root, 'reports')) });
    assert(dflt.status === 0, `batch default output: a normal audit must exit 0 (got ${dflt.status})\n${dflt.stdout}${dflt.stderr}`);
    assert(/done \(coverage complete\)/.test(dflt.stdout), `batch default output: the audit must complete:\n${dflt.stdout}`);
    const dfltRun = hostDir('reports');
    const dfltScope = JSON.parse(readFileSync(join(dfltRun.root, dfltRun.run, 'write-scope.json'), 'utf8'));
    assert(dfltScope.escapedOutsideScope.length === 0, `batch default output: nothing refused (${JSON.stringify(dfltScope.escapedOutsideScope)})`);
    assert(
      dfltScope.changed.added.some((p) => p.includes(join('reports', 'example_com'))),
      `batch default output: the DEFAULT output tree must be recorded as an allowed change, got ${JSON.stringify(dfltScope.changed.added)}`,
    );

    // 2. A REFUSED RUN MUST NOT BE THE CURRENT RESULT. The refusal skips the pointer,
    //    but latest resolution falls back to the newest run CONTAINING a report, so a
    //    refused run could become what --resume treats as done and skip the URL.
    const refused = drive({ args: ['https://refused.example/'], extraArgs: ['--concurrency', '1', '--out', 'r-out'],
      body: `${writesReport(join(root, 'r-out'))}\nprintf 'pwned' > ${JSON.stringify(join(root, 'escaped.txt'))}` });
    assert(refused.status !== 0, `batch refusal: an escaping audit must exit non-zero (${refused.status})`);
    const refusedHost = join(root, 'r-out', readdirSync(join(root, 'r-out'))[0]);
    const refusedRun = readdirSync(refusedHost).find((e) => !e.startsWith('latest'));
    assert(existsSync(join(refusedHost, refusedRun, 'run-refused.json')), 'batch refusal: the run must be marked as refused');
    assert(!existsSync(join(refusedHost, refusedRun, 'report.json')), 'batch refusal: a refused run must not leave a report where resolution looks');
    assert(existsSync(join(refusedHost, refusedRun, 'report.refused.json')), 'batch refusal: the report must be RENAMED out of the way, so the exclusion does not depend on a deletion succeeding');
    // NOTE ON WHAT THIS CONTROL COVERS: it exercises the REAL runner end to end -
    // orchestration, the scope accounting, the refusal path and the report schema
    // validation - with a stand-in agent. It is NOT a real skill/browser/evidence
    // audit (that needs an external agent CLI and token spend, which is a deliberate
    // acceptance step rather than a unit gate), so it must not be read as end-to-end
    // coverage of the audit itself.
    const resume = drive({ args: ['https://refused.example/'], extraArgs: ['--concurrency', '1', '--out', 'r-out', '--resume'], body: writesReport(join(root, 'r-out')) });
    assert(!/resume skip/.test(resume.stdout), `batch refusal: --resume must NOT skip a URL whose only run was refused:\n${resume.stdout}`);
    assert(/done \(coverage complete\)\s+https:\/\/refused\.example\//.test(resume.stdout), `batch refusal: --resume must RE-AUDIT and COMPLETE that URL, not merely "not skip" it:\n${resume.stdout}`);

    // 3. CONCURRENCY MUST NOT REFUSE CLEAN WORK. Two URLs, one escaping agent: the
    //    clean URL shares the project tree, so an overlapping snapshot window would
    //    catch the other agent's write and refuse it too. The scope windows are
    //    serialized; the clean URL must complete.
    const twoUp = drive({
      args: ['https://clean.example/', 'https://dirty.example/'],
      extraArgs: ['--concurrency', '2', '--out', 'c-out'],
      // The stub locates its own run dir by pure shell parameter expansion on the
      // prompt it is given (`--out <dir>`), with no external commands, no regex and no
      // nested quoting: an earlier version of this used grep/sed inside $( ) and the
      // generated script failed to parse, which is what a gate is for.
      body: [
        'd=""',
        'for a in "$@"; do',
        '  case "$a" in',
        '    *c-out/*) rest=${a#*c-out/}; d="' + join(root, 'c-out') + '/${rest%% *}";;',
        '  esac',
        'done',
        `cp ${JSON.stringify(findings)} "$d/report.json"`,
        `case "$*" in *dirty.example*) printf 'pwned' > ${JSON.stringify(join(root, 'c-escaped.txt'))};; esac`,
      ].join('\n'),
    });
    assert(twoUp.status !== 0, 'batch concurrency: the dirty URL must still fail the batch');
    assert(
      /done \(coverage complete\)\s+https:\/\/clean\.example\//.test(twoUp.stdout),
      `batch concurrency: the CLEAN url must still complete when a neighbour escapes:\n${twoUp.stdout}`,
    );

    // 4. THE ESCAPE PATH WITH A FAILING AGENT: the diff must still be computed and the
    //    refusal still recorded when the agent exits non-zero (the earlier stub always
    //    exited 0, so this path was untested).
    const failing = drive({ args: ['https://failing.example/'], extraArgs: ['--concurrency', '1', '--out', 'f-out'],
      body: `printf 'pwned' > ${JSON.stringify(join(root, 'f-escaped.txt'))}\nexit 7` });
    assert(failing.status !== 0, `batch failing agent: must exit non-zero (${failing.status})`);
    assert(/CONFINEMENT FAILURE/.test(failing.stderr), `batch failing agent: the escape must still be diagnosed:\n${failing.stderr}`);
    const failingHost = join(root, 'f-out', readdirSync(join(root, 'f-out'))[0]);
    const failingRun = readdirSync(failingHost).find((e) => !e.startsWith('latest'));
    const failingScope = JSON.parse(readFileSync(join(failingHost, failingRun, 'write-scope.json'), 'utf8'));
    assert(
      failingScope.escapedOutsideScope.some((p) => p.endsWith('f-escaped.txt')),
      `batch failing agent: the escaped path must be recorded even though the agent died (${JSON.stringify(failingScope.escapedOutsideScope)})`,
    );
    // 5. THE CLEANUP-FAILURE PATH (the P1): the agent plants a DANGLING symlink where the
    //    refusal marker goes, so writing the marker fails. With the old single try block
    //    that failure suppressed the report removal and left a resumable report. The
    //    report must still be renamed out of the way.
    const marker = drive({ args: ['https://marker.example/'], extraArgs: ['--concurrency', '1', '--out', 'm-out'],
      body: `d=$(ls -dt ${JSON.stringify(join(root, 'm-out'))}/*/*/ 2>/dev/null | head -1); d=${'${d%/}'}\ncp ${JSON.stringify(findings)} "$d/report.json"\nln -s /nonexistent/target "$d/run-refused.json"\nprintf 'pwned' > ${JSON.stringify(join(root, 'm-escaped.txt'))}` });
    assert(marker.status !== 0, `batch cleanup: the escape must still refuse (${marker.status})`);
    const markerHost = join(root, 'm-out', readdirSync(join(root, 'm-out'))[0]);
    const markerRun = readdirSync(markerHost).find((e) => !e.startsWith('latest'));
    assert(
      existsSync(join(markerHost, markerRun, 'report.refused.json')) && !existsSync(join(markerHost, markerRun, 'report.json')),
      `batch cleanup: a failing marker write must NOT suppress quarantining the report (${JSON.stringify(readdirSync(join(markerHost, markerRun)))})`,
    );

    // 6. A SYMLINKED RUN DIRECTORY (the P2a): the agent replaces its run dir with a link
    //    to another run under the output root. Nothing may be renamed or deleted through
    //    that link - the innocent run must be untouched.
    const innocent = join(root, 'innocent', 'RUN');
    mkdirSync(innocent, { recursive: true });
    writeFileSync(join(innocent, 'report.json'), '{"innocent":true}\n');
    const swapped = drive({ args: ['https://swap.example/'], extraArgs: ['--concurrency', '1', '--out', 's-out'],
      body: `d=$(ls -dt ${JSON.stringify(join(root, 's-out'))}/*/*/ 2>/dev/null | head -1); d=${'${d%/}'}\nrm -rf "$d"\nln -s ${JSON.stringify(innocent)} "$d" || exit 9\n[ -d "$d" ] || exit 9\nprintf 'pwned' > ${JSON.stringify(join(root, 's-escaped.txt'))}` });
    assert(swapped.status !== 0, `batch symlinked run: the escape must still refuse (${swapped.status})`);
    assert(/not a real path below the output root/.test(swapped.stderr), `batch symlinked run: the refusal must say it did not touch anything through the link:\n${swapped.stderr}`);
    assert(existsSync(join(innocent, 'report.json')), 'batch symlinked run: the innocent run report must be untouched');
    assert(!existsSync(join(innocent, 'report.refused.json')), 'batch symlinked run: nothing may be renamed through the agent-controlled link');
    // The reviewer's point: the scope record is written THROUGH the run directory, so a
    // swapped link would have overwritten the innocent run's record too.
    writeFileSync(join(innocent, 'write-scope.json'), '{"innocent":"scope-record"}\n');
    const swapped2 = drive({ args: ['https://swap2.example/'], extraArgs: ['--concurrency', '1', '--out', 's2-out'],
      body: `d=$(ls -dt ${JSON.stringify(join(root, 's2-out'))}/*/*/ 2>/dev/null | head -1); d=${'${d%/}'}\nrm -rf "$d"\nln -s ${JSON.stringify(innocent)} "$d" || exit 9\nprintf 'pwned' > ${JSON.stringify(join(root, 's2-escaped.txt'))}` });
    assert(swapped2.status !== 0, `batch symlinked run: the escape must still refuse (${swapped2.status})`);
    assert(
      readFileSync(join(innocent, 'write-scope.json'), 'utf8').includes('innocent'),
      'batch symlinked run: the innocent run\'s SCOPE RECORD must not be overwritten through the link',
    );

    // 7. A REFUSED RUN MUST NEVER RESOLVE AS CURRENT, whatever the agent plants: with a
    //    DIRECTORY sitting where the quarantined report would go, the rename cannot
    //    happen, so completion must still not resolve - the decision comes from the
    //    pointer this tool writes, not from what is on disk.
    mkdirSync(join(root, 'd-out'), { recursive: true });
    const blocked = drive({ args: ['https://blocked.example/'], extraArgs: ['--concurrency', '1', '--out', 'd-out'],
      body: `d=$(ls -dt ${JSON.stringify(join(root, 'd-out'))}/*/*/ 2>/dev/null | head -1); d=${'${d%/}'}\ncp ${JSON.stringify(findings)} "$d/report.json"\nmkdir -p "$d/report.refused.json"\nprintf 'pwned' > ${JSON.stringify(join(root, 'd-escaped.txt'))}` });
    assert(blocked.status !== 0, `batch blocked quarantine: the escape must still refuse (${blocked.status})`);
    assert(/NOT QUARANTINED/.test(blocked.stderr), `batch blocked quarantine: a quarantine that cannot happen must be LOUD:\n${blocked.stderr}`);
    const blockedResume = drive({ args: ['https://blocked.example/'], extraArgs: ['--concurrency', '1', '--out', 'd-out', '--resume'], body: writesReport(join(root, 'd-out')) });
    assert(!/resume skip/.test(blockedResume.stdout), `batch blocked quarantine: --resume must not treat a refused run as done, however it is blocked:\n${blockedResume.stdout}`);
    assert(/done \(coverage complete\)\s+https:\/\/blocked\.example\//.test(blockedResume.stdout), `batch blocked quarantine: the URL must be RE-AUDITED and complete:\n${blockedResume.stdout}`);

    // 8. A URL THAT DESTROYS ITS OWN RUN DIRECTORY MUST NOT TAKE THE BATCH DOWN: a LATER
    //    URL still has to complete.
    const deletes = drive({
      args: ['https://deleter.example/', 'https://later.example/'],
      extraArgs: ['--concurrency', '1', '--out', 'del-out'],
      body: `d=$(ls -dt ${JSON.stringify(join(root, 'del-out'))}/*/*/ 2>/dev/null | head -1); d=${'${d%/}'}\ncase "$*" in *deleter.example*) rm -rf "$d";; *) cp ${JSON.stringify(findings)} "$d/report.json";; esac`,
    });
    assert(/done \(coverage complete\)\s+https:\/\/later\.example\//.test(deletes.stdout), `batch deleted run dir: a LATER url must still complete:\n${deletes.stdout}`);
    assert(
      /https:\/\/deleter\.example\/: run directory unusable/.test(deletes.stdout),
      `batch deleted run dir: the destructive URL must carry its own failure REASON in the summary, not merely appear somewhere:\n${deletes.stdout}`,
    );
    // 9. THE RESUME POINTER-FILE PATH MUST ACTUALLY WORK. It was silently dead because
    //    readFileSync was missing from the runner's imports: the lookup threw, the catch
    //    swallowed it, and no run could ever be resolved from latest.txt. This case would
    //    have failed then, which is the point of adding it.
    const txtHost = join(root, 'txt-out', 'txt_example');
    const txtRun = join(txtHost, 'RUN1');
    mkdirSync(txtRun, { recursive: true });
    writeFileSync(join(txtRun, 'report.json'), readFileSync(findings));
    writeFileSync(join(txtHost, 'latest.txt'), 'RUN1\n');
    const txtResume = drive({ args: ['https://txt.example/'], extraArgs: ['--concurrency', '1', '--out', 'txt-out', '--resume'], body: writesReport(join(root, 'txt-out')) });
    assert(/resume skip/.test(txtResume.stdout), `batch resume: a valid run named by latest.txt must count as done (the pointer-FILE path was silently dead):\n${txtResume.stdout}`);

    // 10. And the symlink pointer path, positively: complete a URL, then resume skips it.
    //     The refused-run cases above only ever asserted that a URL was NOT skipped.
    const firstDone = drive({ args: ['https://done.example/'], extraArgs: ['--concurrency', '1', '--out', 'p-out'], body: writesReport(join(root, 'p-out')) });
    assert(firstDone.status === 0, `batch resume: the first run must complete (${firstDone.status})`);
    const secondDone = drive({ args: ['https://done.example/'], extraArgs: ['--concurrency', '1', '--out', 'p-out', '--resume'], body: writesReport(join(root, 'p-out')) });
    assert(/resume skip/.test(secondDone.stdout), `batch resume: a completed URL must be SKIPPED on resume:\n${secondDone.stdout}`);


    // 11. A PUBLICATION FAILURE MUST NOT MARK THE URL COMPLETE. The in-memory set used to be
    //     updated BEFORE the publication call, so when publication threw (here: the output
    //     root is made unwritable, so both the symlink and its pointer-file fallback fail)
    //     a DUPLICATE url later in the same resume batch was skipped even though nothing had
    //     been published for it.
    const dupOut = join(root, 'dup-out');
    mkdirSync(dupOut, { recursive: true });
    try {
      const dup = drive({
        args: ['https://dup.example/', 'https://dup.example/'],
        extraArgs: ['--concurrency', '1', '--out', 'dup-out', '--resume'],
        // Make the HOST directory unwritable (that is where the pointer is published), so
        // the symlink AND its pointer-file fallback both fail - and so the duplicate's own
        // run directory cannot be created either, which is itself proof it was attempted
        // rather than skipped by the in-memory set.
        body: `d=$(ls -dt ${JSON.stringify(dupOut)}/*/*/ 2>/dev/null | head -1); d=${'${d%/}'}\ncp ${JSON.stringify(findings)} "$d/report.json"\nchmod 0500 "$(dirname \"$d\")"`,
      });
      assert(/could not publish completion/.test(dup.stderr), `batch publication failure: the failure must be reported:\n${dup.stderr}`);
      // Counting APPEARANCES was too weak: it could be satisfied by the URL being mentioned
      // without the duplicate ever being attempted. Assert the duplicate's OWN failure
      // REASON instead - a second, DISTINCT reason in the summary is proof the second attempt
      // actually ran rather than being skipped by the in-memory set.
      const reasons = [...dup.stdout.matchAll(/https:\/\/dup\.example\/: ([^\n]+)/g)].map((m) => m[1].trim());
      assert(
        reasons.some((r) => /completion could not be published|could not publish completion/.test(r)),
        `batch publication failure: the publication failure must appear as its own reason (saw ${JSON.stringify(reasons)})`,
      );
      assert(
        reasons.length >= 2 && new Set(reasons).size >= 2,
        `batch publication failure: the duplicate must be ATTEMPTED and carry its own reason, not merely be mentioned (saw ${JSON.stringify(reasons)})`,
      );
    } finally {
      // Restore what the fixture made read-only, or the suite's own cleanup cannot
      // descend into it (this cost one run to learn).
      try {
        for (const entry of readdirSync(dupOut)) {
          try {
            chmodSync(join(dupOut, entry), 0o755);
          } catch { /* best effort */ }
        }
        chmodSync(dupOut, 0o755);
      } catch { /* best effort */ }
    }

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


// web-uplift-dzd: the tripwire used to skip any path with a `node_modules` or
// `.web-uplift` segment - exactly the trees the tool EXECUTES from. This pins the
// new coverage: hash strength on the executed first-party set (including the
// vendored tree and its dependency closure), stat strength on the project
// dependency tree, `reports` still excluded unless walked, and the integrity
// snapshot the pre-spawn gate compares. Includes the mutation control: at stat
// strength alone, the same-size+mtime rewrite the hash catches is invisible -
// so the hash assertions above cannot pass vacuously.
export function testWriteScopeCoversExecutedTrees() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-dzd-scope-'));
  try {
    mkdirSync(join(root, 'evidence'), { recursive: true });
    mkdirSync(join(root, 'schema'), { recursive: true });
    mkdirSync(join(root, 'bin'), { recursive: true });
    mkdirSync(join(root, '.web-uplift', 'evidence'), { recursive: true });
    mkdirSync(join(root, '.web-uplift', 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(root, 'reports', 'site'), { recursive: true });
    writeFileSync(join(root, 'evidence', 'cli.mjs'), 'console.log(1);\n');
    writeFileSync(join(root, 'schema', 'validate-report.mjs'), 'console.log(2);\n');
    writeFileSync(join(root, 'bin', 'web-uplift.mjs'), 'console.log(3);\n');
    writeFileSync(join(root, 'install-surface.mjs'), 'export const x = 1;\n');
    writeFileSync(join(root, '.web-uplift', 'evidence', 'cli.mjs'), 'console.log(1);\n');
    writeFileSync(join(root, '.web-uplift', 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(root, 'reports', 'site', 'report.json'), '{}\n');

    const snap = () => snapshotTree(root, { hashUnder: EXECUTABLE_HASH_ROOTS });
    const before = snap();
    // Executed first-party set, the vendored tree (including its vendored
    // dependencies) and the single-file root: CONTENT-HASH strength.
    for (const k of ['evidence/cli.mjs', 'schema/validate-report.mjs', 'bin/web-uplift.mjs',
      'install-surface.mjs', '.web-uplift/evidence/cli.mjs', '.web-uplift/node_modules/dep/index.js']) {
      assert(String(before.get(k) || '').startsWith('sha256:'), `dzd coverage: ${k} must be hash-stamped, got ${before.get(k)}`);
    }
    // Project dependency tree: COVERED (no longer excluded), at stat strength.
    const depKey = join('node_modules', 'dep', 'index.js');
    assert(before.has(depKey) && !String(before.get(depKey)).startsWith('sha256:'),
      `dzd coverage: the project dependency tree must be walked at stat strength, got ${before.get(depKey)}`);
    // Published output stays excluded unless the caller walks it (the fixer must
    // not trip over its own report writes).
    assert(!before.has(join('reports', 'site', 'report.json')),
      'dzd coverage: reports must stay excluded when not named by walkUnder');

    // The blind spot the hashes close: a rewrite preserving BOTH size and mtime.
    const cliPath = join(root, 'evidence', 'cli.mjs');
    const st = statSync(cliPath);
    writeFileSync(cliPath, 'console.log(9);\n');
    utimesSync(cliPath, st.atime, st.mtime);
    assert(statSync(cliPath).size === st.size, 'dzd fixture: the rewrite must preserve size');
    const d = diffTrees(before, snap());
    assert(d.modified.length === 1 && d.modified[0] === 'evidence/cli.mjs',
      `dzd coverage: a same-size+mtime rewrite of executed code must be a detected change, got ${JSON.stringify(d)}`);

    // MUTATION CONTROL: at stat strength alone the identical rewrite is invisible,
    // proving the hash stamp (not the walk) is what the assertion above owes to.
    writeFileSync(cliPath, 'console.log(1);\n');
    utimesSync(cliPath, st.atime, st.mtime);
    const statOnly = snapshotTree(root);
    writeFileSync(cliPath, 'console.log(9);\n');
    utimesSync(cliPath, st.atime, st.mtime);
    const d2 = diffTrees(statOnly, snapshotTree(root));
    assert(!d2.modified.includes('evidence/cli.mjs'),
      'dzd control: at stat strength the same-size+mtime rewrite must be invisible (else the hash assertion proves nothing)');
    writeFileSync(cliPath, 'console.log(1);\n');
    utimesSync(cliPath, st.atime, st.mtime);

    // The stat-strength residual, stated as behaviour rather than hidden: the same
    // trick on a project dependency is NOT caught. Hash strength is reserved for
    // the executed first-party set to keep the walk affordable (module header).
    // NOTE the baseline is taken AFTER normalising the mtime: utimesSync with Date
    // values truncates sub-millisecond fractions, so a restore against a
    // never-truncated baseline leaves a fractional delta - which is itself a
    // (correct) detection, not the blind spot being documented here.
    const depPath = join(root, 'node_modules', 'dep', 'index.js');
    const dst0 = statSync(depPath);
    utimesSync(depPath, dst0.atime, dst0.mtime);
    const beforeDep = snap();
    const dst = statSync(depPath);
    writeFileSync(depPath, 'module.exports = 2;\n');
    utimesSync(depPath, dst.atime, dst.mtime);
    const d3 = diffTrees(beforeDep, snap());
    assert(!d3.modified.includes(depKey),
      'dzd residual: stat-strength paths keep the documented same-size+mtime blind spot');
    writeFileSync(depPath, 'module.exports = 1;\n');
    utimesSync(depPath, dst.atime, dst.mtime);

    // executableIntegrity: the pre-spawn gate's own snapshot. Hashes the executed
    // set only (fast), and drifts on both a content tamper and a symlink swap.
    const baseline = executableIntegrity(root);
    assert(String(baseline.get('.web-uplift/evidence/cli.mjs') || '').startsWith('sha256:'),
      'dzd integrity: the vendored CLI must be in the integrity set');
    assert(!baseline.has(depKey),
      'dzd integrity: the project dependency tree must NOT be in the fast integrity set (the snapshot stat-covers it instead)');
    assert(diffTrees(baseline, executableIntegrity(root)).modified.length === 0,
      'dzd integrity: an untouched tree must diff clean');
    writeFileSync(join(root, '.web-uplift', 'evidence', 'cli.mjs'), 'console.log("pwned");\n');
    let drift = diffTrees(baseline, executableIntegrity(root));
    assert(drift.modified.length === 1 && drift.modified[0] === '.web-uplift/evidence/cli.mjs',
      `dzd integrity: a vendored-CLI tamper must drift, got ${JSON.stringify(drift)}`);
    rmSync(join(root, '.web-uplift', 'evidence', 'cli.mjs'));
    symlinkSync('../../evidence/cli.mjs', join(root, '.web-uplift', 'evidence', 'cli.mjs'));
    drift = diffTrees(baseline, executableIntegrity(root));
    assert(drift.modified.length === 1 && String(executableIntegrity(root).get('.web-uplift/evidence/cli.mjs')).startsWith('link:'),
      'dzd integrity: a symlink swap of executed code must drift and be recorded as a link');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


// web-uplift-dzd: the bead's threat scenario end to end on the REAL batch runner.
// An agent tampers with the vendored evidence CLI during URL 1. The old behaviour:
// the exclusion made the tamper invisible, URL 1 "completed", and URL 2's agent
// EXECUTED the tampered tree (its own diff was clean - the tamper predated its
// snapshot). The new behaviour this pins: URL 1 is refused with the executed-tree
// path in its escape list (hash coverage sees the tamper), and URL 2's agent is
// NEVER SPAWNED because the pre-spawn integrity gate compares against the
// batch-start baseline, refuses and aborts the remaining URLs.
export function testBatchIntegrityGateAbortsOnTamperedExecutedTree() {
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-dzd-batch-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(root, '.web-uplift', 'evidence'), { recursive: true });
    const vendoredCli = join(root, '.web-uplift', 'evidence', 'cli.mjs');
    writeFileSync(vendoredCli, 'console.log("vendored");\n');
    const findings = join(repoRoot, 'examples', 'playground-report.json');
    const outAbs = join(root, 'o1');
    // The spawn counter lives under the OUTPUT root so it is an allowed change:
    // the only escape URL 1 commits is the executed-tree tamper itself.
    const spawnCount = join(outAbs, 'spawns.txt');
    mkdirSync(outAbs, { recursive: true });
    writeFileSync(spawnCount, '0\n');

    const bin = join(binDir, 'claude');
    writeFileSync(bin, [
      '#!/bin/sh',
      `n=$(cat ${JSON.stringify(spawnCount)} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${JSON.stringify(spawnCount)}`,
      `if [ "$n" = "1" ]; then printf 'console.log("pwned");\\n' > ${JSON.stringify(vendoredCli)}; fi`,
      `d=$(ls -dt ${JSON.stringify(outAbs)}/*/*/ 2>/dev/null | head -1)`,
      `cp ${JSON.stringify(findings)} "$d/report.json"`,
      `echo '{"agent":"stub"}'`,
    ].join('\n') + '\n');
    chmodSync(bin, 0o755);

    const res = run(
      process.execPath,
      [join(repoRoot, 'runner', 'run-batch.mjs'), 'https://i1.example/', 'https://i2.example/',
        '--agent', 'claude', '--isolation', 'test-suite', '--concurrency', '1', '--out', 'o1'],
      { cwd: root, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } },
    );

    assert(res.status !== 0, `dzd batch: a tampering batch must exit non-zero (got ${res.status})\n${res.stdout}${res.stderr}`);
    // THE CORE CONTROL: exactly one spawn. Without the pre-spawn gate the second
    // agent runs the tampered tree (and its own clean diff lets it "complete").
    assert(readFileSync(spawnCount, 'utf8').trim() === '1',
      `dzd batch: the agent must be spawned EXACTLY once - URL 2's spawn must be refused by the integrity gate (count: ${readFileSync(spawnCount, 'utf8').trim()})`);
    assert(/INTEGRITY FAILURE/.test(res.stderr) && /aborting the remaining URLs/.test(res.stderr),
      `dzd batch: the integrity refusal must be loud and name the abort:\n${res.stderr}`);
    assert(/CONFINEMENT FAILURE/.test(res.stderr) && /\.web-uplift/.test(res.stderr),
      `dzd batch: URL 1 must be refused with the executed-tree path in the escape list:\n${res.stderr}`);

    // URL 1's scope record names the vendored tamper as the escape.
    const hosts = readdirSync(outAbs).filter((e) => !e.includes('spawns'));
    const hostDirs = hosts.filter((e) => statSync(join(outAbs, e)).isDirectory());
    assert(hostDirs.length === 2, `dzd batch: both URLs get host directories, got ${JSON.stringify(hostDirs)}`);
    let scope = null;
    for (const h of hostDirs) {
      const hAbs = join(outAbs, h);
      for (const r of readdirSync(hAbs).filter((e) => !e.startsWith('latest'))) {
        const p = join(hAbs, r, 'write-scope.json');
        if (existsSync(p)) scope = JSON.parse(readFileSync(p, 'utf8'));
      }
    }
    assert(scope, 'dzd batch: URL 1 must leave a scope record');
    assert(scope.escapedOutsideScope.some((p) => p.includes(join('.web-uplift', 'evidence', 'cli.mjs'))),
      `dzd batch: the escape list must name the tampered vendored CLI: ${JSON.stringify(scope.escapedOutsideScope)}`);
    // URL 2 published nothing and left no scope record (refused before spawn).
    const reports = hostDirs.flatMap((h) => readdirSync(join(outAbs, h)).filter((e) => !e.startsWith('latest'))
      .map((r) => join(outAbs, h, r, 'report.json')).filter((p) => existsSync(p)));
    assert(reports.length === 0, `dzd batch: no URL may publish a report after a tamper: ${JSON.stringify(reports)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const runnerBatchTests = [
  testBatchIsolationGate,
  testBatchDryRunUsesRetainedDirs,
  testBatchFlowDryRun,
  testSnapshotRunStructure,
  testSnapshotRunCopiesArtifacts,
  testSnapshotRunMissingArtifactsBestEffort,
  testSnapshotRunCopyErrorTolerance,
  testBatchWriteScope,
  testBatchResumeIsolation,
  testWriteScopeCoversExecutedTrees,
  testBatchIntegrityGateAbortsOnTamperedExecutedTree,
  testFlowNormalize,
  testFlowRecordSensitiveRedaction,
  testFlowReplayMutationGate,
  testFlowReplaySchemeGate,
  testFlowPierceShadowRootBrowser,
];

export {
  testSnapshotRunStructure,
  testSnapshotRunCopiesArtifacts,
  testSnapshotRunMissingArtifactsBestEffort,
  testSnapshotRunCopyErrorTolerance,
  testBatchResumeIsolation,
  testFlowNormalize,
  testFlowRecordSensitiveRedaction,
  testFlowReplayMutationGate,
  testFlowReplaySchemeGate,
  testFlowPierceShadowRootBrowser,
};

await runSuite(runnerBatchTests, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
