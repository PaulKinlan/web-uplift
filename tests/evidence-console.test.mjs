#!/usr/bin/env node
// Console evidence: what the page logged DURING load (invisible to a post-load probe) and the
// interact-deadline validation that bounds the wait.
//
// SPLIT FROM tests/evidence.test.mjs / tests/evidence-network.test.mjs (web-uplift-f5mb). The gate runs
// each tests/*.test.mjs in its own node:test process and is bounded by the files on its critical path, so
// the heaviest cases in those two files throttled every landing. The cases moved here unchanged: none was
// dropped, relaxed or reordered, and each remains independent (it builds its own server and browser).
// tests/regression.mjs discovers this file automatically, and testSuiteListsMatchRegressionRegistry pins
// that the union of the suite lists is unchanged.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, runAsync, tmp, runSuite } from './test-helpers.mjs';
import { gather, waitForInteractEvidence } from '../evidence/cli.mjs';
import { launchChrome } from '../evidence/cdp.mjs';
import { testConsoleEvidenceRedaction } from './console-evidence-redaction.mjs';



// follow-best-practices/no-console-errors needs first-party evidence: what the
// page logged DURING load is invisible to a post-load evaluate probe, so the
// console primitive collects Runtime + Log events from before the navigation.
// The counts are split by source so a failed subresource request is not
// confused with a page-authored console error (web-uplift-2dg).

export async function testConsoleEvidence() {
  const noisy = [
    '<!doctype html><html><head><title>noisy</title><script>',
    "  console.warn('fixture warning');",
    "  console.error('fixture console error');",
    "  console.error('fixture console error');",
    "  setTimeout(function () { throw new Error('fixture uncaught exception'); }, 0);",
    "  fetch('/missing.json').catch(function () {});",
    '</script></head><body><p>Deterministic console story.</p></body></html>',
  ].join('\n');
  const clean = '<!doctype html><html><head><title>clean</title></head><body><p>Nothing is logged here.</p>' +
    '<button id="boom">boom</button>' +
    "<script>document.querySelector('#boom').addEventListener('click', function () { throw new Error('fixture interact exception'); });</script>" +
    '</body></html>';

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === '/clean') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(clean);
      return;
    }
    if (path === '/noisy') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(noisy);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  // One browser for the six console loads this case drives (web-uplift-t2mr): the console collector is
  // attached per SESSION, so a fresh session/target per gather keeps console events isolated between them,
  // and no load here depends on a fresh profile - the pages come from this case's own server, whose content
  // differs per path. The "a page that logs nothing reports zeroes" assertion is the functional check that
  // nothing leaked from the noisy load into the clean ones.
  let browser = null;
  try {
    browser = await launchChrome({ log: () => {} });
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const result = await gather('console', `${base}/noisy`, { quiet: true, wait: 500, browser });
    const block = result.console;
    assert(
      block.exceptionCount === 1 && block.entries.some((e) => e.kind === 'exception' && e.text.includes('fixture uncaught exception')),
      `console: the load-time exception was not captured: ${JSON.stringify(block)}`,
    );
    assert(
      block.consoleErrorCount === 1 && block.entries.some((e) => e.text.includes('fixture console error')),
      `console: the load-time console error was not captured: ${JSON.stringify(block)}`,
    );
    assert(
      block.warningCount === 1 && block.entries.some((e) => e.text.includes('fixture warning')),
      `console: the console warning was not captured: ${JSON.stringify(block)}`,
    );
    assert(
      block.networkErrorCount === 1 && block.entries.some((e) => e.source === 'network' && (e.url || '').endsWith('/missing.json')),
      `console: the failed subresource request was not captured separately: ${JSON.stringify(block)}`,
    );
    assert(block.hasErrors === true, `console: a page that threw should report errors: ${JSON.stringify(block)}`);
    const repeated = block.entries.find((e) => e.text.includes('fixture console error'));
    assert(repeated.repeat === 2, `console: identical messages should collapse into a repeat count: ${JSON.stringify(repeated)}`);
    const exception = block.entries.find((e) => e.kind === 'exception');
    assert(Array.isArray(exception.stack) && exception.stack.length > 0, `console: an exception should carry a stack frame: ${JSON.stringify(exception)}`);

    // Every primitive carries the block, and the artifact a primitive writes has
    // to agree with its stdout: that is what emit() is for.
    const out = join(tmp, 'console-dom-artifact.json');
    const cli = await runAsync(process.execPath, [
      'evidence/cli.mjs', 'dom', `${base}/noisy`, '--wait', '300', '--out', out, '--interact-deadline', '2000',
    ]);
    assert(cli.status === 0, `console: dom CLI failed:\n${cli.stderr}`);
    const artifact = JSON.parse(readFileSync(out, 'utf8'));
    const stdout = JSON.parse(cli.stdout);
    assert(
      artifact.console?.exceptionCount === 1 && stdout.console?.exceptionCount === 1,
      `console: the console block should ride along on other primitives, in the artifact and stdout:\n${JSON.stringify({ artifact: artifact.console, stdout: stdout.console })}`,
    );

    // A page that logs nothing reports zeroes: the empty block is the evidence
    // that the check can pass, not the absence of evidence.
    const cleanResult = await gather('console', `${base}/clean`, { quiet: true, wait: 400, browser });
    assert(
      cleanResult.console.entryCount === 0 && cleanResult.console.hasErrors === false && cleanResult.console.entries.length === 0,
      `console: a page that logs nothing must report zeroes: ${JSON.stringify(cleanResult.console)}`,
    );

    // Interaction errors count too: the same page throws only when its button is
    // clicked, which is exactly the error class a post-load probe cannot see.
    const interactResult = await gather('console', `${base}/clean`, {
      quiet: true,
      browser,
      wait: 400,
      // An explicit deadline: under load the zero-delay click's exception can
      // cross the old fixed 250ms window, which was the 7kl flake.
      interactDeadlineMs: 2000,
      interact: "setTimeout(() => document.querySelector('#boom').click(), 0)",
    });
    assert(
      interactResult.console.exceptionCount === 1 &&
        interactResult.console.entries.some((e) => e.text.includes('fixture interact exception')),
      `console: an error raised by --interact was not captured: ${JSON.stringify(interactResult.console)}`,
    );
    assert(
      interactResult.interactObserved === true && interactResult.interactEvidencePending === false,
      `console: a captured interact must report observed evidence and no truncation: ${JSON.stringify({ observed: interactResult.interactObserved, pending: interactResult.interactEvidencePending, wait: interactResult.interactWaitMs })}`,
    );

    // AC1: a benign entry at +0ms must not mask a throw at +100ms. A poll that
    // returns on the FIRST new entry misses the exception; the trailing silence
    // window is what catches it.
    const mixedResult = await gather('console', `${base}/clean`, {
      quiet: true,
      browser,
      wait: 400,
      interactDeadlineMs: 2000,
      interact:
        "setTimeout(() => console.warn('fixture benign entry'), 0);" +
        "setTimeout(() => document.querySelector('#boom').click(), 100)",
    });
    assert(
      mixedResult.console.warningCount === 1 &&
        mixedResult.console.entries.some((e) => e.text.includes('fixture benign entry')),
      `console: the benign interact entry was not captured: ${JSON.stringify(mixedResult.console)}`,
    );
    assert(
      mixedResult.console.exceptionCount === 1 &&
        mixedResult.console.entries.some((e) => e.text.includes('fixture interact exception')),
      `console: a throw after an earlier benign entry was missed (first-entry-only exit): ${JSON.stringify(mixedResult.console)}`,
    );

    // AC2: a quiet interaction costs the default settle, not the hard deadline,
    // and is not reported as a pending failure.
    const quietResult = await gather('console', `${base}/clean`, { quiet: true, wait: 400, interact: 'void 0', browser });
    assert(
      quietResult.interactObserved === false && quietResult.interactEvidencePending === false,
      `console: a quiet interact must not report observed or pending evidence: ${JSON.stringify({ observed: quietResult.interactObserved, pending: quietResult.interactEvidencePending })}`,
    );
    assert(
      quietResult.interactWaitMs >= 200 && quietResult.interactWaitMs < 1000,
      `console: a quiet interact must return on the default settle, not the hard deadline: ${quietResult.interactWaitMs}ms`,
    );

    // AC3: with an explicit longer deadline, an entry that only arrives at +700ms
    // is still captured, and the reported wait reflects it.
    const delayedResult = await gather('console', `${base}/clean`, {
      quiet: true,
      browser,
      wait: 400,
      interactDeadlineMs: 2000,
      interact: "setTimeout(() => document.querySelector('#boom').click(), 700)",
    });
    assert(
      delayedResult.console.exceptionCount === 1 &&
        delayedResult.console.entries.some((e) => e.text.includes('fixture interact exception')),
      `console: an interact error raised after the old 250ms window was not captured: ${JSON.stringify(delayedResult.console)}`,
    );
    assert(
      delayedResult.interactEvidencePending === false,
      `console: the poll must report that evidence arrived rather than pending: ${JSON.stringify({ wait: delayedResult.interactWaitMs, pending: delayedResult.interactEvidencePending })}`,
    );
    assert(
      typeof delayedResult.interactWaitMs === 'number' && delayedResult.interactWaitMs >= 650,
      `console: the poll must wait for the delayed entry and report how long it waited: ${delayedResult.interactWaitMs}`,
    );

    // A typo'd --interact-deadline must fail fast at parse time rather than
    // becoming an unbounded wait (NaN / Infinity) or a vacuous one (<= 0). These
    // are parse errors, so no browser is launched (web-uplift-3t2 review).
    for (const bad of ['foo', '0', '-5', 'Infinity', 'NaN', '']) {
      const rejected = await runAsync(process.execPath, [
        'evidence/cli.mjs', 'console', `${base}/clean`, '--interact', 'void 0', '--interact-deadline', bad,
      ]);
      assert(
        rejected.status !== 0 && /--interact-deadline must be a positive number/.test(rejected.stderr),
        `console: --interact-deadline ${bad} must be rejected with a usage error, got status ${rejected.status}: ${rejected.stderr}`,
      );
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}




// The interact deadline must be validated in the LOOP, not only in the CLI
// parser: a caller that passes opts.interactDeadlineMs directly to gather()
// bypasses parseArgs, and a non-finite or non-positive value would make
// `elapsed >= NaN` false forever with sleep(NaN) spinning at 0ms. No browser is
// needed here: the helper only reads collector.entries.
// The interact deadline must be bounded by the LOOP, not only by the CLI parser:
// gather() calls never go through parseArgs, and NaN/Infinity are not nullish, so
// a bad programmatic value used to make `elapsed >= NaN` false forever with
// sleep(NaN) spinning at 0ms. A bad value must degrade to the default bounded
// wait (the parser keeps its fail-fast usage error for CLI typos). No browser is
// needed here: the helper only reads collector.entries.

export async function testConsoleInteractDeadlineValidation() {
  const fake = { entries: [] };
  for (const bad of [NaN, Infinity, -Infinity, 0, -5, null, undefined, '']) {
    const r = await waitForInteractEvidence(fake, 0, bad);
    assert(
      r.deadlineMs === 250 && r.observed === false && r.pending === false && r.waitedMs >= 200 && r.waitedMs < 1000,
      `a bad deadline (${String(bad)}) must degrade to the default bounded wait: ${JSON.stringify(r)}`,
    );
  }

  // A numeric string is coerced, and a valid number is honoured.
  const str = await waitForInteractEvidence(fake, 0, '500');
  assert(str.deadlineMs === 500 && str.waitedMs >= 450, `a numeric string deadline must be coerced: ${JSON.stringify(str)}`);
  const num = await waitForInteractEvidence(fake, 0, 60);
  assert(num.deadlineMs === 60 && num.waitedMs >= 55, `a valid deadline must be honoured: ${JSON.stringify(num)}`);

  // An entry that arrives during the wait is observed and not reported pending.
  const collector = { entries: [] };
  setTimeout(() => collector.entries.push({ kind: 'exception', level: 'error', source: 'runtime', text: 'x' }), 20);
  const seen = await waitForInteractEvidence(collector, 0, 500);
  assert(
    seen.observed === true && seen.pending === false,
    `an entry during the wait must be observed and not pending: ${JSON.stringify(seen)}`,
  );
}

export const evidenceConsoleTests = [
  testConsoleEvidence,
  testConsoleEvidenceRedaction,
  testConsoleInteractDeadlineValidation,
];

await runSuite(evidenceConsoleTests, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
