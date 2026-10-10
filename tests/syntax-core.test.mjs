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
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  gather,
  assertPageDerivedFetchAllowed,
  iconSatisfies,
  isFirstPartyHost,
  isThirdPartyCookie,
  readSourceTree,
  safeFetch,
} from '../evidence/cli.mjs';
import { testSafeFetchDnsRebindingGuard, testSafeFetchContentDecoding } from './safe-fetch.mjs';
import {
  testSourceTreeSkipsSymlinkFileEscape,
  testSourceTreeSkipsSymlinkDirEscape,
  testSourceTreeSkipsSymlinkCycle,
  testSourceTreeDepthGuard,
} from './source-tree-symlink.mjs';

export function testSyntaxChecks() {
  for (const file of listFiles(repoRoot, (p) => p.endsWith('.mjs'))) {
    const result = run(process.execPath, ['--check', file]);
    assert(result.status === 0, `syntax check failed for ${file}:\n${result.stderr || result.stdout}`);
  }
}


export function testPackageRootImportIsSideEffectFree() {
  const result = run(process.execPath, [
    '--input-type=module',
    '-e',
    "import 'web-uplift'; console.log('import-ok')",
  ]);
  assert(result.status === 0, `package root import failed:\n${result.stderr || result.stdout}`);
  assert(result.stdout.trim() === 'import-ok', `package root import produced side effects:\n${result.stdout}`);
}


// iconSatisfies memoises its size matcher; the cache must not change what it
// classifies. This pins the cached path against the direct construction over a
// matrix that includes 'any', multiple and padded sizes, a non-matching size,
// the exact call-site sizes, and a string size argument (web-uplift-33h).
export function testIconSatisfiesMatrix() {
  const direct = (icons, size) => {
    const re = new RegExp(`(^|\\s)${size}x${size}(\\s|$)`);
    return (icons || []).some((i) => {
      const sizes = String(i?.sizes || '');
      return /any/i.test(sizes) || re.test(sizes);
    });
  };
  const iconSets = [
    [{ sizes: '192x192' }, { sizes: '512x512' }],
    [{ sizes: '512x512 192x192' }],
    [{ sizes: 'any' }],
    [{ sizes: 'ANY' }],
    [{ sizes: '192x192 ' }],
    [{ sizes: ' 512x512' }],
    [{ sizes: '' }],
    [{ sizes: null }],
    [{}],
    [],
    null,
    [{ sizes: '48x48' }],
    [{ sizes: '192x192x192' }],
    [{ sizes: '512x512' }, null, { sizes: '192x192' }],
  ];
  for (const icons of iconSets) {
    for (const size of [192, 512, 96, '192']) {
      assert(
        iconSatisfies(icons, size) === direct(icons, size),
        `iconSatisfies must classify like the direct construction for ${size}: ${JSON.stringify(icons)}`,
      );
    }
  }
}


// The label-boundary comparison is shared by the trackers first-party test and
// the cookies domain test. The raw suffix match it replaced called lookalikes
// first-party ('evil-example.com' for a page on 'example.com', or the reverse),
// and the cookies call site kept its own copy of that bug until web-uplift-yu8,
// which is why there is now one helper. This pins it over the lookalike matrix,
// including full-width subdomains and the cookie leading-dot form.
export function testFirstPartyHostMatrix() {
  const core = [
    ['example.com', 'example.com', true],
    ['sub.example.com', 'example.com', true],
    ['a.b.example.com', 'example.com', true],
    ['evil-example.com', 'example.com', false],
    ['notexample.com', 'example.com', false],
    ['example.com.evil.net', 'example.com', false],
    ['example.com', 'sub.example.com', false],
    [undefined, 'example.com', false],
    ['example.com', '', false],
    ['example.com', undefined, false],
  ];
  for (const [host, base, expected] of core) {
    assert(
      isFirstPartyHost(host, base) === expected,
      `isFirstPartyHost(${JSON.stringify(host)}, ${JSON.stringify(base)}) must be ${expected}`,
    );
  }

  const cookie = [
    ['example.com', 'example.com', false],
    ['sub.example.com', '.example.com', false],
    ['a.b.example.com', 'example.com', false],
    ['example.com', 'evil-example.com', true],
    ['evil-example.com', 'example.com', true],
    ['notexample.com', 'example.com', true],
    ['example.com', undefined, false],
    ['example.com', '', false],
    ['', 'example.com', true],
  ];
  for (const [pageHost, domain, expected] of cookie) {
    assert(
      isThirdPartyCookie(pageHost, domain) === expected,
      `isThirdPartyCookie(${JSON.stringify(pageHost)}, ${JSON.stringify(domain)}) must be ${expected}`,
    );
  }
}


// A page controls the manifest href and the redirects the raw fetch follows, and
// both are fetched by the privileged Node process. The guard must refuse every
// private target, including every IP literal encoding, and fail closed on a name
// it cannot resolve (threat model I2 / F-003, web-uplift-2kh).
export async function testPageDerivedFetchGuard() {
  const refused = [
    'file:///etc/passwd',
    'data:text/plain,hi',
    'blob:https://example.com/x',
    'ftp://example.com/x',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://127.0.0.1/',
    'http://0.0.0.0/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'https://198.18.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://localhost:1234/m.webmanifest',
    'http://no-such-name.invalid/m.webmanifest',
  ];
  for (const candidate of refused) {
    let error = null;
    try {
      await assertPageDerivedFetchAllowed(candidate, { targetOrigin: 'https://example.com' });
    } catch (e) {
      error = e;
    }
    assert(error && /refused:/.test(error.message), `the fetch guard must refuse ${candidate}: ${error?.message}`);
  }

  // The exemption is ORIGIN-scoped: the same host on a different port is another
  // local service and must be refused (adversarial review P1a: a page served from
  // 127.0.0.1:8080 must not be able to read 127.0.0.1:2375).
  let crossPort = null;
  try {
    await assertPageDerivedFetchAllowed('http://127.0.0.1:2375/containers/json', { targetOrigin: 'http://127.0.0.1:8080' });
  } catch (e) {
    crossPort = e;
  }
  assert(crossPort && /refused:/.test(crossPort.message), `the exemption must not cross ports: ${crossPort?.message}`);

  // Public IP literals need no DNS and must stay fetchable (this direction is what
  // catches an over-blocking classification bug); the audited target's own ORIGIN
  // is exempt so a deliberate local audit keeps working; a relative href resolves
  // against the target.
  for (const publicUrl of ['http://93.184.216.34/m.webmanifest', 'http://8.8.8.8/', 'http://1.1.1.1/', 'http://[2606:4700:4700::1111]/']) {
    const allowedUrl = await assertPageDerivedFetchAllowed(publicUrl, { targetOrigin: 'https://example.com' });
    assert(allowedUrl.href.length > 0, `a public address must stay fetchable: ${publicUrl}`);
  }
  const exempt = await assertPageDerivedFetchAllowed('http://127.0.0.1:8080/m.webmanifest', { targetOrigin: 'http://127.0.0.1:8080' });
  assert(exempt.port === '8080', `the audited target ORIGIN must be exempt: ${exempt.href}`);
  const relative = await assertPageDerivedFetchAllowed('/m.webmanifest', {
    base: 'http://127.0.0.1:8080/deep/page',
    targetOrigin: 'http://127.0.0.1:8080',
  });
  assert(relative.pathname === '/m.webmanifest', `a relative manifest href must resolve against the target: ${relative.href}`);
}


// The redirect is where a first-URL-only check fails: Node's fetch follows
// redirects internally, so the guard has to re-validate every hop, bound the hop
// count and cap the body. A legitimate same-host fetch must still go through.
export async function testSafeFetchRedirectAndSizeGuard() {
  // A second local service on another port: the P1a exploit shape is a page on the
  // audited origin pointing its manifest at this one.
  const secret = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"Secret":"cross-port local service"}');
  });
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/ok.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (path === '/redirect-private') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    if (path === '/redirect-file') {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      res.end();
      return;
    }
    if (path === '/redirect-loop') {
      res.writeHead(302, { Location: '/redirect-loop' });
      res.end();
      return;
    }
    if (path === '/sw-redirect') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    if (path === '/huge.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('x'.repeat(4096));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((resolveListen) => secret.listen(0, '127.0.0.1', resolveListen));
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const targetOrigin = base;

    // POSITIVE, end to end: the body really arrives through the guard (an
    // over-blocking bug fails here, not just in the URL validation above).
    const ok = await safeFetch(`${base}/ok.json`, { targetOrigin });
    assert(
      JSON.parse(await ok.text()).ok === true,
      'a legitimate same-origin fetch must fetch and return its body through the guard',
    );

    // P1a: same host, different port is a different origin and must be refused.
    const secretOrigin = `http://127.0.0.1:${secret.address().port}`;
    let crossPortError = null;
    try {
      await safeFetch(`${secretOrigin}/containers/json`, { targetOrigin });
    } catch (e) {
      crossPortError = e;
    }
    assert(crossPortError && /refused:/.test(crossPortError.message), `a same-host different-port fetch must be refused: ${crossPortError?.message}`);

    // P1b: the worker-script URL starts same-origin, but a redirect to a private
    // address must be refused on that path too.
    let swError = null;
    try {
      await safeFetch(`${base}/sw-redirect`, { targetOrigin });
    } catch (e) {
      swError = e;
    }
    assert(swError && /refused:/.test(swError.message), `a worker-script redirect to a private address must be refused: ${swError?.message}`);

    for (const path of ['/redirect-private', '/redirect-file', '/redirect-loop']) {
      let error = null;
      try {
        await safeFetch(`${base}${path}`, { targetOrigin });
      } catch (e) {
        error = e;
      }
      assert(error && /refused:/.test(error.message), `${path} must be refused: ${error?.message}`);
    }

    let capError = null;
    try {
      const big = await safeFetch(`${base}/huge.json`, { targetOrigin, maxBytes: 1024 });
      await big.text();
    } catch (e) {
      capError = e;
    }
    assert(capError && /exceeded/.test(capError.message), `an oversized body must be refused: ${capError?.message}`);

    const relativeFetch = await safeFetch('/ok.json', { base: `${base}/deep/page`, targetOrigin });
    assert(JSON.parse(await relativeFetch.text()).ok === true, 'a relative href must resolve against the base and fetch');
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await new Promise((resolveClose) => secret.close(resolveClose));
  }
}


export function testSchemaValidation() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const configSchema = readJson('schema/config.schema.json');
  const findingsSchema = readJson('schema/findings.schema.json');
  ajv.compile(configSchema);
  ajv.compile(findingsSchema);

  validateJson(ajv, configSchema, 'web-uplift.json');
  validateJson(ajv, configSchema, 'web-uplift.example.json');
  validateJson(ajv, findingsSchema, 'examples/playground-report.json');
  validateJson(ajv, findingsSchema, 'examples/playground-report-fixed.json');
}


// Modern Web Guidance is mandatory: a report with issue-findings must record the
// guides it consulted, and every issue-finding must cite a guidanceId drawn from
// that list. This is what stops the "audit judged from memory, never called MWG"
// failure users reported — a report that skipped guidance fails validation here.
export function testAtomicCoverageValidator() {
  const validator = join(repoRoot, 'schema', 'validate-report.mjs');
  const catalog = join(repoRoot, 'knowledge', 'principles.json');
  const valid = run(process.execPath, [validator, catalog, join(repoRoot, 'examples', 'playground-report.json')]);
  assert(valid.status === 0, `atomic coverage: valid fixture failed:\n${valid.stderr}\n${valid.stdout}`);

  const incomplete = JSON.parse(readFileSync(join(repoRoot, 'examples', 'playground-report.json'), 'utf8'));
  incomplete.checkOutcomes = incomplete.checkOutcomes.slice(1);
  incomplete.status = 'partial';
  incomplete.coverage = { ...incomplete.coverage, recorded: incomplete.checkOutcomes.length, judged: incomplete.checkOutcomes.length, missing: 1, complete: false };
  delete incomplete.overallScore;
  const incompletePath = join(tmp, 'incomplete-report.json');
  writeFileSync(incompletePath, JSON.stringify(incomplete));
  const rejected = run(process.execPath, [validator, catalog, incompletePath]);
  assert(rejected.status !== 0, `atomic coverage: missing check was not rejected:\n${rejected.stderr}\n${rejected.stdout}`);
}


// web-uplift-17o rev4: the raw-fetch exchange is bounded AND the bound is configurable, and
// a timed-out raw fetch is never reported as evidence about the page. The slow-but-successful
// control only passes because the budget was raised - a fixed bound would be a product
// regression (a slow response recorded as a fetch error, then an empty raw document compared
// against the rendered page, manufacturing a JS-shell signal from a network condition).
export async function testFetchDeadlineAndRawComparison() {
  const { safeFetch, readBodyCapped, configureFetchDeadline } = await import(
    pathToFileURL(join(repoRoot, 'evidence/cli.mjs')).href
  );

  const slow = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>slow</title><h1>Slow Canary Heading</h1><p>slow but successful content, present in the raw document</p>');
    }, 800);
  });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const slowUrl = `http://127.0.0.1:${slow.address().port}/`;
  const slowOrigin = new URL(slowUrl).origin;

  const stallBody = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write('<!doctype html><title>stall</title>');
    // never ends the body
  });
  await new Promise((r) => stallBody.listen(0, '127.0.0.1', r));
  const stallUrl = `http://127.0.0.1:${stallBody.address().port}/`;
  const stallOrigin = new URL(stallUrl).origin;

  try {
    // 1. THE BOUND: a 200ms budget against an 800ms server fails loudly,
    let fastErr = null;
    try {
      await safeFetch(slowUrl, { targetOrigin: slowOrigin, deadlineMs: 200 });
    } catch (e) {
      fastErr = e;
    }
    assert(fastErr, 'fetch deadline: a slow response under a small budget must fail rather than hang');
    // 2. ...and the SAME fetch under a raised budget SUCCEEDS. WHAT THIS DEMONSTRATES,
    //    stated narrowly: the budget override is APPLIED and effective at a small scale
    //    (800ms server vs 200ms/5000ms budgets). What it does NOT demonstrate: a response
    //    exceeding the PRODUCTION default (30s) remaining usable when an operator raises
    //    the budget - exercising that literally would need a response slower than the
    //    default, which does not belong in a suite. Say what was demonstrated.
    const raised = await safeFetch(slowUrl, { targetOrigin: slowOrigin, deadlineMs: 5000 });
    const raisedText = await raised.text();
    assert(
      raisedText.includes('Slow Canary Heading'),
      `fetch deadline: a slow-but-successful response must arrive intact under a raised budget (${raisedText.length} chars)`,
    );

    // 3. STALLED BODY: headers arrive, the body never does -> the read times out loudly.
    const stalled = await safeFetch(stallUrl, { targetOrigin: stallOrigin, deadlineMs: 1500 });
    let bodyErr = null;
    try {
      await stalled.text();
    } catch (e) {
      bodyErr = e;
    }
    assert(
      bodyErr && bodyErr.message.includes('did not complete within'),
      `fetch deadline: a stalled body must fail loudly, naming the bound (${bodyErr && bodyErr.message})`,
    );

    // 4. STALLED CANCELLATION: a reader whose read() AND cancel() never resolve. The timeout
    //    must throw WITHOUT awaiting the cancellation - cleanup awaited after a deadline is
    //    how a bounded operation still hangs (the rev2 class, one layer down).
    const neverReader = { read: () => new Promise(() => {}), cancel: () => new Promise(() => {}) };
    const mockRes = { body: { getReader: () => neverReader } };
    const t0 = Date.now();
    let cancelErr = null;
    try {
      await readBodyCapped(mockRes, 1024 * 1024, 150);
    } catch (e) {
      cancelErr = e;
    }
    const cancelElapsed = Date.now() - t0;
    assert(
      cancelErr && cancelErr.message.includes('did not complete within 150ms'),
      `fetch deadline: a stalled read must fail loudly (${cancelErr && cancelErr.message})`,
    );
    assert(
      cancelElapsed < 3000,
      `fetch deadline: the throw must NOT await a stalled cancellation (${cancelElapsed}ms)`,
    );

    // 5. THE DISTINCTION, end to end: a discoverability run whose raw fetch times out must
    //    record the comparison as NOT USABLE - a timeout is a network condition, never
    //    evidence that the page lacked raw content.
    configureFetchDeadline(400); // the server answers at 800ms: the raw fetch times out
    const timed = await gather('discoverability', slowUrl, { quiet: true, wait: 300, screenshots: false });
    assert(timed && timed.fetchError, `discoverability: the timed-out raw fetch must be recorded as an error (${JSON.stringify(timed && { fetchError: timed.fetchError })})`);
    assert(timed.rawComparisonUsable === false, 'discoverability: the gate itself must be false when the raw fetch failed');
    assert(
      typeof timed.rawComparisonNote === 'string' && timed.rawComparisonNote.includes('network condition'),
      'discoverability: the summary must SAY the comparison is not evidence about the page',
    );
    assertUnknownRawSurface(timed, 'timeout', assert);

    // 6a. THE NON-2XX ROUTE: a 404 page is a response ABOUT the resource, not the document
    //     - the gate must not treat it as usable, and the STATUS is still recorded, so the
    //     operator sees the 404 as a status rather than as a misleading "not a JS shell".
    const nf = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Not Found</title><h1>404</h1>');
    });
    await new Promise((r) => nf.listen(0, '127.0.0.1', r));
    const nfSummary = await gather('discoverability', `http://127.0.0.1:${nf.address().port}/`, { quiet: true, wait: 300, screenshots: false });
    assert(
      nfSummary.rawComparisonUsable === false &&
        nfSummary.fetchedStatus === 404 &&
        typeof nfSummary.rawComparisonNote === 'string' &&
        nfSummary.rawComparisonNote.includes('404'),
      `discoverability: a non-2xx must be unusable with the status recorded and named (${JSON.stringify({ usable: nfSummary.rawComparisonUsable, status: nfSummary.fetchedStatus })})`,
    );
    assertUnknownRawSurface(nfSummary, 'non-2xx', assert);
    nf.close();

    // 6a-ii. THE BODY-READ ROUTE, end to end: the SAME server cannot stall the raw fetch
    //        and serve the browser (a uniformly stalling body also hangs the navigation -
    //        correct, but a different route), so split by user agent: the crawler fetch
    //        stalls mid-body and the budget fires; the browser gets a complete page. The
    //        summary gets the same whole-surface guard, not a hand-written field list.
    const bodyStall = http.createServer((req, res) => {
      if ((req.headers['user-agent'] || '').includes('web-uplift-discoverability')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write('<!doctype html><title>crawler-half</title>');
        return; // never ends the body for the raw fetch
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Browser Half</title><h1>Browser Half Heading</h1><p>complete for the browser</p>');
    });
    await new Promise((r) => bodyStall.listen(0, '127.0.0.1', r));
    configureFetchDeadline(400);
    const stalledSummary = await gather('discoverability', `http://127.0.0.1:${bodyStall.address().port}/`, { quiet: true, wait: 300, screenshots: false });
    assert(
      stalledSummary.rawComparisonUsable === false && typeof stalledSummary.fetchError === 'string',
      `discoverability: a body-read failure must be unusable with the error recorded (${JSON.stringify({ usable: stalledSummary.rawComparisonUsable, fetchError: stalledSummary.fetchError && stalledSummary.fetchError.slice(0, 60) })})`,
    );
    assertUnknownRawSurface(stalledSummary, 'body-read', assert);
    bodyStall.close();

    // 6b. THE EMPTY-200 ROUTE STAYS USABLE: a completed empty response is OBSERVED evidence
    //     that the raw document was empty - the real empty-document signal the tool exists
    //     to report, deliberately distinct from "not retrieved".
    const empty = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('');
    });
    await new Promise((r) => empty.listen(0, '127.0.0.1', r));
    const emptySummary = await gather('discoverability', `http://127.0.0.1:${empty.address().port}/`, { quiet: true, wait: 300, screenshots: false });
    assert(
      emptySummary.rawComparisonUsable === true && emptySummary.fetchedStatus === 200 && emptySummary.raw.htmlBytes === 0,
      `discoverability: an empty 200 must stay usable with the emptiness observed (${JSON.stringify({ usable: emptySummary.rawComparisonUsable, status: emptySummary.fetchedStatus, raw: emptySummary.raw })})`,
    );
    empty.close();

    // 6c. THE RAISED-BUDGET CONTROL, end to end: the same page with the budget raised yields
    //    a real comparison - this passes only because the budget is configurable.
    configureFetchDeadline(5000);
    const ok = await gather('discoverability', slowUrl, { quiet: true, wait: 300, screenshots: false });
    assert(
      ok.rawComparisonUsable === true &&
        ok.coveragePct !== null &&
        ok.isJsShell === false &&
        ok.titlePresentInRaw === true &&
        ok.h1PresentInRaw === true &&
        Array.isArray(ok.emptyMounts) &&
        ok.raw.htmlBytes > 0,
      `discoverability: with the budget raised, the slow-but-successful page must compare for real, siblings included (${JSON.stringify({ coveragePct: ok.coveragePct, isJsShell: ok.isJsShell, rawComparisonUsable: ok.rawComparisonUsable, titlePresentInRaw: ok.titlePresentInRaw, h1PresentInRaw: ok.h1PresentInRaw, emptyMounts: ok.emptyMounts, raw: ok.raw })})`,
    );
  } finally {
    configureFetchDeadline(30000); // restore the production default for the rest of the suite
    slow.close();
    stallBody.close();
  }
}


// The comparison record is untrusted input: it is written by an agent whose context
// includes page content. Its run identifiers are joined into the directory the
// before/after screenshots are read from, so they become the BASE for those reads -
// and `join` normalises a `..` in them BEFORE the path containment check runs, so
// that check validates the screenshot path against a base the record itself chose.
// The earlier artifact-path fix validated the PATH; this validates the BASE
// (web-uplift-9li).
export async function testScorecardRejectsEscapingComparisonRunIds() {
  const { renderScorecard, scoreReport } = await import('../aggregate/scorecard.mjs');
  const hostRoot = join(tmp, 'scorecard-runs', 'example');
  // Bytes that must never reach the published report, sitting one level above the
  // host's run directory - exactly where a record-supplied `..` points.
  const outsideDir = join(hostRoot, '..', 'scorecard-outside');
  const secret = Buffer.from('SECRET-BYTES-FROM-OUTSIDE-THE-REPORTS-TREE');
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'secret.png'), secret);

  const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  const runIds = ['20260101-000000', '20260102-000000'];
  const dirs = runIds.map((id) => join(hostRoot, id));
  mkdirSync(hostRoot, { recursive: true });
  dirs.forEach((dir, index) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report));
    writeFileSync(join(dir, index === 0 ? 'before.png' : 'after.png'), Buffer.from(`screenshot-bytes-${index}`));
  });
  const data = (compare) => ({
    host: 'example',
    generatedAt: '2026-01-01 00:00',
    runs: runIds.map((runId, index) => ({ runId, dir: dirs[index], report, compare: null, ...scoreReport(report) })),
    latest: { runId: runIds[1], dir: dirs[1], report, compare, ...scoreReport(report) },
  });

  // Positive control: a comparison naming its two sibling runs still renders both.
  const ok = renderScorecard(data({
    runA: runIds[0],
    runB: runIds[1],
    metrics: [],
    summary: {},
    screenshotPairs: [{ before: 'before.png', after: 'after.png', caption: 'hero' }],
  }));
  assert(
    (ok.match(/data:image\/png;base64,/g) || []).length === 2,
    "scorecard: a normal comparison must still render both runs' screenshots",
  );

  // The attack: an identifier that climbs out of the host's run directory must be
  // refused rather than used as the base, so bytes from outside never reach the report.
  const escaped = renderScorecard(data({
    runA: '../scorecard-outside',
    runB: '../../..',
    metrics: [],
    summary: {},
    screenshotPairs: [{ before: 'secret.png', after: 'secret.png', caption: 'evil' }],
  }));
  assert(
    !escaped.includes(secret.toString('base64')),
    'scorecard: a record-supplied run identifier must not read outside the reports tree',
  );
  // A comparison record with no identifiers at all used to throw from join().
  const noIds = renderScorecard(data({ metrics: [], summary: {}, screenshotPairs: [{ before: 'before.png', after: 'after.png', caption: 'no ids' }] }));
  assert(
    !noIds.includes(secret.toString('base64')),
    'scorecard: a comparison with no run identifiers must not read outside the reports tree',
  );
}


// The report inlines its screenshots as data URIs, so the browser takes no network
// hop that could tell it the size: unless the image element carries its width and
// height, its box is zero high until the bitmap decodes and everything below it moves
// when it does. This checks, structurally, the sizes the renderer derives from the
// bytes for every format it claims to handle, the shapes it must refuse, and the
// stylesheet that lets those sizes reserve the box. It does NOT measure the box in a
// browser; that needs a fixture whose image is visible and not yet fetched, which is
// web-uplift-x4d (web-uplift-xq5).
export async function testScorecardReservesImageBoxes() {
  const { renderScorecard, scoreReport } = await import('../aggregate/scorecard.mjs');
  const { evaluate, sleep, withSession } = await import('../evidence/cdp.mjs');

  const root = join(tmp, 'xq5-runs');
  const runIds = ['20260101-000000', '20260102-000000'];
  const dirs = runIds.map((id) => join(root, id));
  dirs.forEach((dir) => mkdirSync(dir, { recursive: true }));
  const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));

  // Byte shapes the browser cannot be asked to produce here, plus the malformed and
  // truncated ones whose whole point is that they must NOT yield a size.
  const pngHeader = (w, h) => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR', 'latin1'),
    (() => { const b = Buffer.alloc(8); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); return b; })(),
    Buffer.from([8, 6, 0, 0, 0]),
    Buffer.alloc(4),
  ]);
  const webpVp8l = (w, h) => {
    const b = Buffer.alloc(40);
    b.write('RIFF', 0, 'latin1');
    b.writeUInt32LE(32, 4);
    b.write('WEBP', 8, 'latin1');
    b.write('VP8L', 12, 'latin1');
    b.writeUInt32LE(20, 16);
    b[20] = 0x2f;
    b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
    return b;
  };
  const gif = (() => {
    const g = Buffer.alloc(16);
    g.write('GIF89a', 0, 'latin1');
    g.writeUInt16LE(64, 6);
    g.writeUInt16LE(48, 8);
    return g;
  })();
  // Which fixtures are real and which are not, since it matters: the PNG, JPEG and
  // WebP below are produced by Chrome's own encoder, and the fill-byte JPEG is a real
  // encoded JPEG with padding injected before its start-of-frame. The GIF is synthetic
  // because this environment has no GIF encoder, and the VP8L, the two counterexamples
  // and the malformed files are synthetic because the malformed ones cannot come from
  // an encoder by definition.
  writeFileSync(join(dirs[0], 'plain.gif'), gif);
  writeFileSync(join(dirs[1], 'vp8l.webp'), webpVp8l(130, 70));
  // Malformed or truncated: a PNG signature with no IHDR, a GIF too short to hold a
  // logical screen descriptor, a JPEG that ends inside its frame header, a WebP whose
  // lossy frame sync code is wrong, and bytes that are not an image at all.
  writeFileSync(join(dirs[0], 'bad.png'), pngHeader(400, 250).subarray(0, 16));
  writeFileSync(join(dirs[0], 'bad.gif'), Buffer.from('GIF89aabc', 'latin1'));
  writeFileSync(join(dirs[0], 'bad.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00]));
  writeFileSync(join(dirs[1], 'bad.webp'), (() => {
    const b = Buffer.alloc(40);
    b.write('RIFF', 0, 'latin1');
    b.writeUInt32LE(32, 4);
    b.write('WEBP', 8, 'latin1');
    b.write('VP8 ', 12, 'latin1');
    b.writeUInt32LE(20, 16);
    return b;
  })());
  // The reviewer's two counterexamples for this round: a chunk whose declared extent
  // runs past its own container, and a start-of-frame whose declared length cannot hold
  // the component entries it claims.
  writeFileSync(join(dirs[0], 'oversized-chunk.webp'), (() => {
    const b = Buffer.alloc(40);
    b.write('RIFF', 0, 'latin1');
    b.writeUInt32LE(32, 4);
    b.write('WEBP', 8, 'latin1');
    b.write('VP8X', 12, 'latin1');
    b.writeUInt32LE(9999, 16);
    b.writeUIntLE(5, 24, 3);
    b.writeUIntLE(5, 27, 3);
    return b;
  })());
  writeFileSync(join(dirs[0], 'short-sof-components.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x0b, 0x00, 0x05, 0x01, 0x00, 0x00, 0x00, 0x00]));
  // A PNG whose declared chunk is not fully present: 24 bytes carry the signature, the
  // chunk length and type, and the dimension fields, but the rest of the 13-byte IHDR
  // data and its checksum are missing. The earlier check accepted this on length alone
  // and read dimensions out of a chunk the file does not contain.
  writeFileSync(join(dirs[0], 'short-ihdr.png'), pngHeader(400, 250).subarray(0, 24));
  // A WebP whose container declares four bytes, so the chunk header sits outside the
  // range the container claims. This is a BEHAVIOUR PIN and not a regression test for the
  // guard added alongside it: the chunk-extent check further down already rejects this
  // input, so the outcome is the same with and without that guard. It is here because the
  // invariant should hold independently of which guard enforces it.
  writeFileSync(join(dirs[0], 'malformed-container.webp'), (() => {
    const b = Buffer.alloc(34);
    b.write('RIFF', 0, 'latin1');
    b.writeUInt32LE(4, 4);
    b.write('WEBP', 8, 'latin1');
    b.write('VP8X', 12, 'latin1');
    b.writeUInt32LE(10, 16);
    b.writeUIntLE(5, 24, 3);
    b.writeUIntLE(5, 27, 3);
    return b;
  })());
  writeFileSync(join(dirs[0], 'junk.png'), Buffer.from('not an image at all'));
  // The two counterexamples from the review: shapes the EARLIER parser sized from
  // bytes the file does not claim to contain, which is what makes these fixtures
  // distinguish validation from its absence. A start-of-frame whose declared segment
  // length (2) cannot hold the dimension fields the old walk read past its end, and a
  // RIFF container declaring size 0 while the fields sit at offsets 24-29.
  writeFileSync(
    join(dirs[0], 'short-sof.jpg'),
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x02, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]),
  );
  writeFileSync(join(dirs[0], 'undersized-riff.webp'), (() => {
    const b = Buffer.alloc(30);
    b.write('RIFF', 0, 'latin1');
    b.writeUInt32LE(0, 4);
    b.write('WEBP', 8, 'latin1');
    b.write('VP8X', 12, 'latin1');
    b.writeUInt32LE(10, 16);
    return b;
  })());

  await withSession(async (client) => {
    const encode = async (type, w, h) => {
      const url = await evaluate(client, `(() => { const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h}; const x = c.getContext('2d'); x.fillStyle = '#123456'; x.fillRect(0, 0, ${w}, ${h}); return c.toDataURL('${type}'); })()`);
      return Buffer.from(String(url).split(',')[1], 'base64');
    };
    writeFileSync(join(dirs[0], 'before.png'), await encode('image/png', 400, 250));
    // A real JPEG with marker FILL bytes injected before its start-of-frame: the fill
    // path exercised on a structurally valid image rather than on hand-built arithmetic,
    // and it stays decodable, which the browser is asked to confirm below.
    const realJpeg = await encode('image/jpeg', 222, 111);
    const sofAt = (() => {
      for (let i = 2; i + 3 < realJpeg.length; i += 1) {
        if (realJpeg[i] !== 0xff) continue;
        const marker = realJpeg[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return i;
      }
      return -1;
    })();
    assert(sofAt > 0, 'xq5: the encoded JPEG must contain a start-of-frame to pad before');
    const fillJpeg = Buffer.concat([realJpeg.subarray(0, sofAt), Buffer.from([0xff, 0xff, 0xff]), realJpeg.subarray(sofAt)]);
    writeFileSync(join(dirs[0], 'fill.jpg'), fillJpeg);
    const decodedFill = await evaluate(
      client,
      `(async () => { const i = new Image(); i.src = ${JSON.stringify('data:image/jpeg;base64,' + fillJpeg.toString('base64'))}; await i.decode(); return { w: i.naturalWidth, h: i.naturalHeight }; })()`,
    );
    assert(
      decodedFill.w === 222 && decodedFill.h === 111,
      `xq5: the fill-byte fixture must be a real decodable JPEG of 222x111, got ${JSON.stringify(decodedFill)}`,
    );
    writeFileSync(join(dirs[1], 'after.jpg'), await encode('image/jpeg', 300, 180));
    writeFileSync(join(dirs[1], 'extra.webp'), await encode('image/webp', 200, 120));
    // A screenshot attached to a finding: the third emission site, inside the finding
    // dialog, which the pair and gallery sites do not cover. It is written into the
    // latest run's directory because that is the one the dialogs render from.
    const dialogPng = await encode('image/png', 111, 77);
    for (const dir of dirs) writeFileSync(join(dir, 'dialog.png'), dialogPng);
    const evidenceReport = {
      ...report,
      __runId: 'xq5',
      artifacts: [{ path: 'dialog.png', type: 'screenshot', caption: 'dialog evidence', findingIds: [report.findings[0].id] }],
    };

    // The report is shared by both runs, but each side of a pair resolves against its
    // OWN run directory, so every fixture is placed in both.
    for (const dir of dirs) {
      for (const other of dirs) {
        if (dir === other) continue;
        for (const name of readdirSync(other)) {
          if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), readFileSync(join(other, name)));
        }
      }
    }

    const compare = {
      runA: runIds[0],
      runB: runIds[1],
      metrics: [],
      summary: {},
      screenshotPairs: [
        { before: 'before.png', after: 'after.jpg', caption: 'real PNG and JPEG' },
        { before: 'plain.gif', after: 'extra.webp', caption: 'GIF header and real WebP' },
        { before: 'fill.jpg', after: 'vp8l.webp', caption: 'JPEG fill bytes and VP8L' },
        { before: 'bad.png', after: 'before.png', caption: 'truncated PNG' },
        { before: 'bad.gif', after: 'fill.jpg', caption: 'truncated GIF' },
        { before: 'bad.jpg', after: 'vp8l.webp', caption: 'truncated JPEG' },
        { before: 'bad.webp', after: 'after.jpg', caption: 'bad WebP sync' },
        { before: 'short-ihdr.png', after: 'after.jpg', caption: 'chunk not fully present' },
        { before: 'malformed-container.webp', after: 'after.jpg', caption: 'container smaller than its chunk header' },
        { before: 'junk.png', after: 'after.jpg', caption: 'not an image' },
        { before: 'short-sof.jpg', after: 'before.png', caption: 'segment too short for its fields' },
        { before: 'undersized-riff.webp', after: 'after.jpg', caption: 'container too small for its fields' },
        { before: 'oversized-chunk.webp', after: 'after.jpg', caption: 'chunk extends past its container' },
        { before: 'short-sof-components.jpg', after: 'before.png', caption: 'frame cannot hold its components' },
        { before: 'missing.png', after: 'after.jpg', caption: 'absent file' },
        // Neither side readable: the pair is dropped, which is the production rule and
        // was left uncovered when this test was rewritten.
        { before: 'missing.png', after: 'also-missing.png', caption: 'nothing-readable' },
      ],
    };
    const html = renderScorecard({
      host: 'example',
      generatedAt: '2026-01-01 00:00',
      runs: runIds.map((runId, index) => ({ runId, dir: dirs[index], report: evidenceReport, compare: index === 1 ? compare : null, ...scoreReport(evidenceReport) })),
      latest: { runId: runIds[1], dir: dirs[1], report: evidenceReport, compare, ...scoreReport(evidenceReport) },
    });

    // Every readable image carries the size read from its own bytes. PNG, JPEG and
    // WebP here are real encoder output; the GIF, the JPEG with fill bytes and the
    // VP8L file are the shapes the browser cannot be asked to produce.
    for (const [label, size] of [
      ['PNG', ' width="400" height="250"'],
      ['JPEG', ' width="300" height="180"'],
      ['GIF', ' width="64" height="48"'],
      ['WebP', ' width="200" height="120"'],
      ['JPEG with fill bytes', ' width="222" height="111"'],
      ['WebP VP8L', ' width="130" height="70"'],
      ['the finding-dialog screenshot', ' width="111" height="77"'],
    ]) {
      assert(html.includes(size), `xq5: the rendered markup must carry the ${label} size, missing ${JSON.stringify(size)}`);
    }
    // ...and nothing unreadable gets one. Each malformed fixture still renders as an
    // image, so the tag carrying those exact bytes is the thing to check: it must not
    // have been given a size.
    const escRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const [name, ext, bytes] of [
      ['bad.png', 'png', readFileSync(join(dirs[0], 'bad.png'))],
      ['bad.gif', 'gif', readFileSync(join(dirs[0], 'bad.gif'))],
      ['bad.jpg', 'jpeg', readFileSync(join(dirs[0], 'bad.jpg'))],
      ['bad.webp', 'webp', readFileSync(join(dirs[1], 'bad.webp'))],
      ['junk.png', 'png', readFileSync(join(dirs[0], 'junk.png'))],
      ['short-ihdr.png', 'png', readFileSync(join(dirs[0], 'short-ihdr.png'))],
      ['malformed-container.webp', 'webp', readFileSync(join(dirs[0], 'malformed-container.webp'))],
      ['short-sof.jpg', 'jpeg', readFileSync(join(dirs[0], 'short-sof.jpg'))],
      ['undersized-riff.webp', 'webp', readFileSync(join(dirs[0], 'undersized-riff.webp'))],
      ['oversized-chunk.webp', 'webp', readFileSync(join(dirs[0], 'oversized-chunk.webp'))],
      ['short-sof-components.jpg', 'jpeg', readFileSync(join(dirs[0], 'short-sof-components.jpg'))],
    ]) {
      const src = `src="data:image/${ext};base64,${bytes.toString('base64')}"`;
      const tag = html.match(new RegExp(`<img[^>]*${escRe(src)}[^>]*>`))?.[0];
      assert(tag, `xq5: ${name} must still render as an image`);
      assert(!tag.includes('width="'), `xq5: ${name} is not readable, so it must carry no size, got: ${tag.slice(0, 140)}`);
    }
    assert(
      (html.match(/<div class="noimg">n\/a<\/div>/g) || []).length === 1,
      'xq5: a side with nothing to show must still render the placeholder',
    );
    assert(!html.includes('nothing-readable'), 'xq5: a pair with nothing readable on either side must stay dropped');
    for (const rule of ['.media img,.media video{width:100%;height:auto;', '.ba-pair img{width:100%;height:auto;']) {
      assert(html.includes(rule), `xq5: the stylesheet must let the reserved box follow the image ratio, missing ${JSON.stringify(rule)}`);
    }
  });
}


// The report's inlined screenshots carry a size so the layout can reserve their box
// before the bitmap arrives. xq5 shipped the structural half of that; this measures the
// behaviour in a browser, and it measures BOTH shapes so the apparatus is proven able to
// see the difference: an image carrying the size attributes keeps the content below it
// still while its bitmap is in flight, and the same image without them shifts that
// content when the bitmap lands.
//
// Purpose-built because three earlier attempts could not establish it: a source-less
// clone (Chrome gives such an image no aspect ratio), a deliberately slow response (the
// page's load event waits for it, and the reading came back at zero geometry) and the
// scorecard's own imagery (a hidden tab panel never requests a lazy image, and a closed
// dialog never lays one out). So the fixture is a minimal page whose two images are in
// the normal flow, whose image rules are the REPORT'S OWN extracted from its stylesheet
// rather than a copy, and whose requests are held at the CDP layer so both bitmaps are
// genuinely in flight at the first reading (web-uplift-x4d).
export async function testReservedImageBoxInBrowser() {
  const { evaluate, sleep, withSession } = await import('../evidence/cdp.mjs');
  const { renderScorecard, scoreReport } = await import('../aggregate/scorecard.mjs');

  // The report's stylesheet, so the measurement is of what ships and not of a copy of it.
  const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  const run = { runId: 'x4d', dir: tmp, report, compare: null, ...scoreReport(report) };
  const html = renderScorecard({ host: 'example', generatedAt: '2026-01-01 00:00', runs: [run], latest: run });
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert(style && style.includes('.ba-pair img') && style.includes('.media img'), 'x4d: the report stylesheet must carry the two image rules');

  const reader = `(() => {
    const read = (imgId, markerId) => {
      const img = document.getElementById(imgId);
      const marker = document.getElementById(markerId);
      return { height: img.getBoundingClientRect().height, pending: !img.complete, decoded: img.complete && img.naturalWidth > 0, markerTop: marker.getBoundingClientRect().top };
    };
    return { ready: document.readyState, sized: read('withSize', 'markerA'), unsized: read('withoutSize', 'markerB') };
  })()`;

  const measured = await withSession(async (client) => {
    const encoded = await evaluate(client, `(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 250; const x = c.getContext('2d'); x.fillStyle = '#123456'; x.fillRect(0, 0, 400, 250); return c.toDataURL('image/png'); })()`);
    const png = Buffer.from(String(encoded).split(',')[1], 'base64');
    // The report's own rules, plus a marker element after each block so the movement of
    // the content below an image is measurable.
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>reserved box</title><style>${style}
      body{margin:0;font:16px sans-serif} .x4d-pane{width:400px} .x4d-marker{height:24px;background:#eee}
    </style></head><body>
      <div class="x4d-pane media"><figure><img id="withSize" width="400" height="250" src="/shot-a.png" alt="with size"><figcaption>sized</figcaption></figure></div>
      <div class="x4d-marker" id="markerA">below the sized image</div>
      <div class="x4d-pane ba-pair"><figure><img id="withoutSize" src="/shot-b.png" alt="without size"></figure></div>
      <div class="x4d-marker" id="markerB">below the unsized image</div>
    </body></html>`;
    const server = http.createServer((req, res) => {
      if ((req.url || '').startsWith('/shot-a.png') || (req.url || '').startsWith('/shot-b.png')) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(png);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(Buffer.from(page));
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const url = `http://127.0.0.1:${server.address().port}/`;
      // Hold both image requests: while they are paused the bitmaps are certainly in
      // flight and the layout is settled, so the first reading is the pre-decode state.
      await client.Fetch.enable({ patterns: [{ urlPattern: '*shot-*.png*', requestStage: 'Request' }] });
      const held = [];
      client.Fetch.requestPaused((event) => { held.push(event.requestId); });
      await client.Page.navigate({ url });
      for (let i = 0; i < 60 && (held.length < 2 || (await evaluate(client, 'document.readyState')) === 'loading'); i += 1) await sleep(50);
      assert(held.length === 2, `x4d: both images must be in flight at the first reading, held ${held.length}`);
      const pending = await evaluate(client, reader);
      for (const requestId of held) await client.Fetch.continueRequest({ requestId });
      await client.Fetch.disable();
      for (let i = 0; i < 60; i += 1) {
        const done = await evaluate(client, `document.getElementById('withSize').complete && document.getElementById('withoutSize').complete`);
        if (done) break;
        await sleep(50);
      }
      const decoded = await evaluate(client, reader);
      return { pending, decoded };
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  // The page is parsed and both bitmaps really were in flight: without these the
  // measurement could be of an empty document, which is how an earlier attempt read zero.
  assert(['interactive', 'complete'].includes(measured.pending.ready), `x4d: the document must be parsed at the first reading, got ${measured.pending.ready}`);
  assert(measured.pending.sized.pending === true && measured.pending.unsized.pending === true, `x4d: both bitmaps must be pending at the first reading, got ${JSON.stringify(measured.pending)}`);
  assert(measured.decoded.sized.decoded === true && measured.decoded.unsized.decoded === true, `x4d: both bitmaps must have arrived by the second reading, got ${JSON.stringify(measured.decoded)}`);

  // The shape the fix ships: the box is reserved before the bitmap arrives, and the
  // content below it does not move.
  assert(measured.pending.sized.height > 0, `x4d: an image with size attributes must reserve a box while pending, got ${measured.pending.sized.height}px`);
  assert(
    Math.abs(measured.pending.sized.height - measured.decoded.sized.height) < 1,
    `x4d: the reserved box must equal the decoded box, got ${measured.pending.sized.height}px then ${measured.decoded.sized.height}px`,
  );
  assert(
    Math.abs(measured.pending.sized.markerTop - measured.decoded.sized.markerTop) < 1,
    `x4d: content below a sized image must not move when the bitmap arrives, got ${measured.pending.sized.markerTop} then ${measured.decoded.sized.markerTop}`,
  );

  // The shape before the fix, which is what proves the apparatus can see the difference.
  // Its pending height is not zero: the report's own rule puts a 1px border on the image,
  // and a border is the one part of the box that does not depend on the bitmap. What
  // matters is that it reserves essentially none of the height it will occupy.
  assert(
    measured.pending.unsized.height < 0.1 * measured.decoded.unsized.height,
    `x4d: an image with no size attributes must reserve essentially nothing while pending, got ${measured.pending.unsized.height}px of ${measured.decoded.unsized.height}px`,
  );
  // The movement is most of the image's height rather than all of it: while the bitmap is
  // missing the inline-block figure still occupies its baseline line box, so the shift is
  // the image's height less that line box. Tying the bound to the measured height keeps
  // the assertion independent of font metrics.
  const unsizedShift = measured.decoded.unsized.markerTop - measured.pending.unsized.markerTop;
  assert(
    unsizedShift > 0.5 * measured.decoded.unsized.height,
    `x4d: content below an unsized image must move by most of that image's height when the bitmap arrives, moved ${unsizedShift.toFixed(1)}px of ${measured.decoded.unsized.height}px - without this contrast the measurement would not show it can see the difference`,
  );

  // The numbers, so the gate log carries them rather than only the verdict.
  console.log(
    `[x4d] sized: ${measured.pending.sized.height}px pending -> ${measured.decoded.sized.height}px decoded, marker moved ` +
      `${(measured.decoded.sized.markerTop - measured.pending.sized.markerTop).toFixed(1)}px | unsized: ` +
      `${measured.pending.unsized.height}px pending -> ${measured.decoded.unsized.height}px decoded, marker moved ` +
      `${(measured.decoded.unsized.markerTop - measured.pending.unsized.markerTop).toFixed(1)}px`,
  );
}


// The `latest` pointer is a file in a tree the audited agent can write, and a consumer
// reads it as the directory to load a run's report from. A planted target must not be able
// to name a directory outside the host's run root (web-uplift-9t8), and EACH pointer form
// has its own positive control.
//
// The positive controls are written so that only a working pointer resolution can satisfy
// them: the tree holds two runs and the pointer names the OLDER one, while the fallback
// returns the newest by name. A branch that resolves nothing - or one masked by a leftover
// pointer of the other form - returns the newest run and fails the assertion, which is the
// distinction a negative-only test cannot make (web-uplift-uz9).
export async function testLatestPointerCannotEscapeTheRunRoot() {
  const { resolveLatest } = await import('../runner/run-history.mjs');
  const hostRoot = join(tmp, 'pointer-host');
  const older = join(hostRoot, '20260101-000000');
  const newest = join(hostRoot, '20260102-000000');
  const outside = join(tmp, 'pointer-outside');
  for (const dir of [older, newest, outside]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.json'), '{}');
  }

  // Positive control, text form: names the OLDER run, so the fallback cannot satisfy it.
  writeFileSync(join(hostRoot, 'latest.txt'), '20260101-000000\n');
  assert(
    resolveLatest(hostRoot) === older,
    `pointer: a legitimate text pointer must resolve to its run dir, got ${resolveLatest(hostRoot)}`,
  );

  // Negative, text form: parent segments must not escape the run root.
  writeFileSync(join(hostRoot, 'latest.txt'), '../pointer-outside\n');
  const escapedTxt = resolveLatest(hostRoot);
  assert(
    escapedTxt !== outside && !String(escapedTxt ?? '').includes('pointer-outside'),
    `pointer: a planted latest.txt must not resolve outside the run root, got ${escapedTxt}`,
  );

  // Positive control, symlink form: the text pointer is removed first, so a symlink branch
  // that resolves nothing cannot be masked by it and cannot lean on the fallback.
  rmSync(join(hostRoot, 'latest.txt'), { force: true });
  rmSync(join(hostRoot, 'latest'), { force: true });
  symlinkSync('20260101-000000', join(hostRoot, 'latest'), 'dir');
  assert(
    resolveLatest(hostRoot) === older,
    `pointer: a legitimate symlink pointer must resolve to its run dir, got ${resolveLatest(hostRoot)}`,
  );

  // Negative, symlink form: the planted target is refused.
  rmSync(join(hostRoot, 'latest'), { force: true });
  symlinkSync('../pointer-outside', join(hostRoot, 'latest'), 'dir');
  const escapedLink = resolveLatest(hostRoot);
  assert(
    escapedLink !== outside && !String(escapedLink ?? '').includes('pointer-outside'),
    `pointer: a planted symlink must not resolve outside the run root, got ${escapedLink}`,
  );

  // ...and a refused pointer falls back to the newest run INSIDE the tree, not to the
  // directory the pointer named.
  assert(
    escapedLink === newest,
    `pointer: a refused pointer must fall back to a run inside the tree, got ${escapedLink}`,
  );
}


// A compare between two PARTIAL runs used to print "Outstanding
// issue-findings: 0 -> 0" while checks never concluded in either run, which
// reads as "nothing left to do". compare.mjs had its own findings-only copy of
// countOutstanding (fix.mjs had already grown completionState); the shared
// runner/remaining-work.mjs module is now the single definition both callers
// use, and compare reports the unconcluded checks for BOTH sides with a delta.
export async function testCompareReportsUnconcludedChecks() {
  const { compareReports, renderCompareMd } = await import('../aggregate/compare.mjs');
  const clean = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  assert((clean.findings ?? []).length === 0, 'compare: the fixed fixture should have no findings');

  const makePartial = (blocked, notRun) => {
    const r = structuredClone(clean);
    r.status = 'partial';
    const rows = r.checkOutcomes;
    for (let i = 0; i < blocked; i++) { rows[i].status = 'blocked'; rows[i].reason = 'Auth wall blocked this path'; }
    for (let i = blocked; i < blocked + notRun; i++) { rows[i].status = 'not-run'; rows[i].reason = 'Never attempted'; }
    r.coverage = { ...r.coverage, judged: rows.length - blocked - notRun, blocked, notRun, complete: false };
    delete r.overallScore;
    return r;
  };

  const before = makePartial(3, 2); // 5 unconcluded
  const after = makePartial(1, 0);  // 1 unconcluded: four concluded, no finding resolved
  const cmp = compareReports(before, after);
  assert(cmp.summary.unconcludedBefore === 5,
    `compare: unconcludedBefore should be 5, got ${cmp.summary.unconcludedBefore}`);
  assert(cmp.summary.unconcludedAfter === 1,
    `compare: unconcludedAfter should be 1, got ${cmp.summary.unconcludedAfter}`);
  assert(cmp.before.unconcluded === 5 && cmp.after.unconcluded === 1,
    'compare: before/after blocks should carry the unconcluded counts');

  const md = renderCompareMd(cmp, { hostName: 'example.test' });
  assert(md.includes('Outstanding issue-findings:** 0 -> 0'),
    `compare: findings line should still render:\n${md}`);
  assert(md.includes('Unconcluded checks (blocked/not-run):** 5 -> 1 (-4)'),
    `compare: the unconcluded line must state BOTH sides and the delta:\n${md}`);

  // Same module, same counts as the hill-climb gate: fix.mjs and compare.mjs
  // must never disagree about what remains.
  const { countOutstanding, completionState, remaining } = await import('../runner/remaining-work.mjs');
  assert(countOutstanding(before) === 0 && completionState(before).blocked === 3 && completionState(before).notRun === 2,
    'remaining-work: shared module should see the partial before-run');
  assert(remaining(before).total === 5 && remaining(after).total === 1,
    'remaining-work: total should be findings + blocked + not-run');

  // web-uplift-1as: a report that claims complete coverage while recording no
  // checks has zero blocked/not-run rows, so the unconcluded line reads "0 -> 0"
  // and the comparison looks clean. Say the coverage is unaccounted instead of
  // counting nothing.
  const unaccounted = structuredClone(clean);
  unaccounted.checkOutcomes = [];
  unaccounted.coverage = { recorded: 0, judged: 0, missing: 0, complete: true };
  unaccounted.status = 'completed';
  const unaccountedMd = renderCompareMd(compareReports(unaccounted, unaccounted), { hostName: 'example.test' });
  assert(
    unaccountedMd.includes('**Coverage:**') && unaccountedMd.includes('records no checks'),
    `compare: an unaccounted report must be called out, not counted as clean:\n${unaccountedMd}`,
  );
  const completeMd = renderCompareMd(compareReports(clean, clean), { hostName: 'example.test' });
  assert(
    !completeMd.includes('**Coverage:**'),
    `compare: a complete pair must not grow a coverage caveat:\n${completeMd}`,
  );
}


export async function testScorecardScoringAndRender() {
  const { scoreReport, renderScorecard, renderTextScorecard, scorecardSummary, evaluateGates, OUTCOMES } = await import('../aggregate/scorecard.mjs');
  const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));

  const scored = scoreReport(report);
  const incomplete = structuredClone(report);
  incomplete.coverage.complete = false;
  let refusedIncomplete = false;
  try { scoreReport(incomplete); } catch (error) { refusedIncomplete = /Refusing to score/.test(error.message); }
  assert(refusedIncomplete, 'scorecard: incomplete atomic coverage must be refused');
  // The 9-finding playground should not be perfect, and must not exceed 100.
  assert(typeof scored.overall === 'number', 'scorecard: overall should be numeric for the playground report');
  assert(scored.overall > 0 && scored.overall < 100, `scorecard: expected an imperfect overall, got ${scored.overall}`);
  assert(scored.outcomes.length === OUTCOMES.length, 'scorecard: every outcome should be represented');
  for (const o of scored.outcomes) {
    assert(o.score === null || (o.score >= 0 && o.score <= 100), `scorecard: ${o.key} score out of range: ${o.score}`);
  }
  // A clean report scores 100 with no findings.
  const fixed = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report-fixed.json'), 'utf8'));
  assert(scoreReport(fixed).overall === 100, 'scorecard: a findings-free report should score 100');

  // The rendered page must be self-contained and well-formed enough to open.
  report.__runId = 'r1';
  const html = renderScorecard({
    host: 'example',
    generatedAt: '2026-01-01 00:00',
    runs: [{ runId: 'r1', dir: join(repoRoot, 'examples'), report, compare: null, ...scored }],
    latest: { runId: 'r1', dir: join(repoRoot, 'examples'), report, compare: null, ...scored },
  });
  assert(html.startsWith('<!doctype html>'), 'scorecard: HTML should start with a doctype');
  assert(!html.includes('${'), 'scorecard: HTML contains an unresolved template placeholder');
  assert(!/>\s*undefined\s*</.test(html), 'scorecard: HTML contains a literal undefined');
  // Count dialogs by their generated id rather than by the bare tag name: the
  // inline script is part of this HTML, so prose that mentions a dialog element
  // must not be counted as one (a TODO comment naming tag-and-attribute once
  // unbalanced this very assertion).
  const openDialogs = (html.match(/<dialog\s+id="fd-/g) || []).length;
  const closeDialogs = (html.match(/<\/dialog>/g) || []).length;
  assert(openDialogs === closeDialogs && openDialogs >= report.findings.length, 'scorecard: dialog tags are unbalanced');

  // Finding openers are Invoker Command buttons (commandfor/command="show-modal")
  // with a support-gated imperative fallback, not fake-button list items.
  assert(html.includes('commandfor="fd-'), 'scorecard: openers must carry commandfor dialog ids');
  assert(html.includes('command="show-modal"'), 'scorecard: openers must request show-modal');
  assert(!html.includes('data-open'), 'scorecard: legacy data-open openers must be gone');
  assert(!html.includes('openFor'), 'scorecard: imperative openFor helper must be gone');
  assert(!html.includes('role="button"'), 'scorecard: fake-button roles must be gone (real buttons instead)');
  assert(html.includes("('commandForElement' in HTMLButtonElement.prototype)"), 'scorecard: fallback must be gated on commandForElement support');

  // The history chart's axis labels must not scale below the legibility floor. The CSS
  // rule is always in the page, but the CHART only renders with two or more runs, so the
  // markup assertions run against an explicit two-run render rather than against a page
  // where the chart is absent: an assertion that silently cannot apply is the vacuity
  // this guards against (the single-run fixture here is why the wrapper assertion failed
  // on its first gate run).
  assert(html.includes('.history .axis{fill:var(--muted);font-size:12px}'), 'scorecard: axis labels must use the 12px floor, not the old 10px');
  const chartHtml = renderScorecard({
    host: 'example',
    generatedAt: '2026-01-01 00:00',
    runs: [
      { runId: 'r1', dir: join(repoRoot, 'examples'), report, compare: null, ...scored, overall: 71 },
      { runId: 'r2', dir: join(repoRoot, 'examples'), report, compare: null, ...scored },
    ],
    latest: { runId: 'r2', dir: join(repoRoot, 'examples'), report, compare: null, ...scored },
  });
  assert(chartHtml.includes('class="history-scroll"'), 'scorecard: the chart needs its scroll wrapper');
  assert(chartHtml.includes('style="min-width:640px"'), 'scorecard: the chart must keep its natural width inside the scroll wrapper');
  assert(
    chartHtml.includes('role="region"') && chartHtml.includes('aria-label="Score history trend"') && chartHtml.includes('tabindex="0"'),
    'scorecard: the scroll wrapper must be keyboard focusable and named',
  );

  // Light dismiss is native via closedby="any" on each dialog, with a
  // support-gated imperative fallback for browsers without the attribute.
  assert(html.includes('closedby="any"'), 'scorecard: dialogs must request native light dismiss');
  assert(html.includes("('closedBy' in HTMLDialogElement.prototype)"), 'scorecard: the dismiss fallback must be gated on closedBy support');

  // The sticky topbar is a scroll-state query container and the stuck-state cue
  // lives on its descendant surface (a container query cannot style its own
  // container), so both halves must survive.
  assert(html.includes('container-type:scroll-state') && html.includes('container-name:topbar'), 'scorecard: the topbar must be a named scroll-state container');
  assert(html.includes('@container topbar scroll-state(stuck: top)'), 'scorecard: the stuck-state rule must query the topbar container');
  assert(html.includes('class="topbar-surface"'), 'scorecard: the topbar must keep its queryable surface element');

  // The inline text scorecard leads with the overall + a link, same numbers.
  const text = renderTextScorecard(
    { host: 'example', latest: { runId: 'r1', dir: join(repoRoot, 'examples'), report, ...scored } },
    { htmlPath: 'reports/example/scorecard.html' },
  );
  assert(text.includes(`Overall: ${scored.overall}/100`), 'scorecard text: overall line missing/mismatched');
  assert(text.includes('reports/example/scorecard.html'), 'scorecard text: HTML link missing');
  assert(text.includes('Do these first:'), 'scorecard text: top-3 section missing');

  // CI gate: machine summary + threshold evaluation.
  const data = { host: 'example', generatedAt: 'now', latest: { runId: 'r1', dir: join(repoRoot, 'examples'), report, ...scored } };
  const summary = scorecardSummary(data);
  assert(summary.overall === scored.overall, 'scorecardSummary: overall mismatch');
  assert(summary.findingsTotal === report.findings.length, 'scorecardSummary: findings total mismatch');
  assert(typeof summary.outcomes.discoverable !== 'undefined', 'scorecardSummary: outcomes map missing keys');

  // An impossible bar fails; a trivially-met bar passes.
  const fail = evaluateGates(summary, { min: {}, minOverall: 100, maxCritical: 0 });
  assert(fail.passed === false && fail.checks.some((c) => !c.ok), 'gate: overall=100 should fail an imperfect report');
  const pass = evaluateGates(summary, { min: {}, minOverall: 1, maxHigh: 999 });
  assert(pass.passed === true, 'gate: trivial thresholds should pass');
  // A not-applicable outcome never fails its gate.
  const naGate = evaluateGates({ overall: 50, outcomes: { memory: null }, findingsBySeverity: { critical: 0, high: 0 } }, { min: { memory: 90 } });
  assert(naGate.passed === true, 'gate: a null (N/A) outcome must not fail its gate');
}


// web-uplift-2zj: artifact paths in a report are untrusted input, so resolving one
// outside its run directory must not read the file, and must not be emitted as a
// relative src either. Before the fix, `join(dir, relPath)` collapsed `..` and the
// scorecard read and inlined an arbitrary image into the published HTML.
export async function testScorecardArtifactContainment() {
  const { scoreReport, renderScorecard } = await import('../aggregate/scorecard.mjs');
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-artifact-'));
  try {
    const runDir = join(root, 'host', 'r1');
    const prevDir = join(root, 'host', 'r0');
    const outsideDir = join(root, 'outside');
    for (const d of [runDir, prevDir, outsideDir]) mkdirSync(d, { recursive: true });

    // Distinct markers so each assertion names the exact file it is about.
    const relSecret = Buffer.from('TRAVERSAL-REL-MARKER');
    const absSecret = Buffer.from('TRAVERSAL-ABS-MARKER');
    const legitBytes = Buffer.from('LEGIT-INLINE-MARKER');
    writeFileSync(join(outsideDir, 'rel-secret.png'), relSecret);
    writeFileSync(join(outsideDir, 'abs-secret.png'), absSecret);
    writeFileSync(join(outsideDir, 'clip.mp4'), Buffer.from('outside-video'));
    writeFileSync(join(runDir, 'shot.png'), legitBytes);

    // Non-vacuity: the planted file must actually be reachable the way the old
    // unguarded `join(dir, relPath)` resolved it, or the escape assertions below
    // would pass against a fixture that could never have leaked anyway.
    assert(
      existsSync(join(runDir, '../../outside/rel-secret.png')),
      'scorecard: the traversal fixture must be reachable through a plain join, or the escape test is vacuous',
    );

    const report = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));
    report.__runId = 'r1';
    const findingId = report.findings[0].id;
    report.artifacts = [
      { path: 'shot.png', type: 'screenshot', findingIds: [findingId], caption: 'legit' },
      { path: '../../outside/rel-secret.png', type: 'screenshot', findingIds: [findingId], caption: 'escape' },
      { path: join(outsideDir, 'abs-secret.png'), type: 'screenshot', findingIds: [findingId], caption: 'absolute' },
      { path: '../../outside/clip.mp4', type: 'video', findingIds: [findingId], caption: 'escape video' },
    ];
    const scored = scoreReport(report);
    const html = renderScorecard({
      host: 'example',
      generatedAt: '2026-01-01 00:00',
      runs: [{ runId: 'r1', dir: runDir, report, compare: null, ...scored }],
      latest: { runId: 'r1', dir: runDir, report, compare: null, ...scored },
    });

    // The positive control matters as much as the negative ones: a guard that
    // simply stopped inlining would pass every escape assertion below.
    assert(
      html.includes(legitBytes.toString('base64')),
      'scorecard: a contained in-run screenshot must still be inlined',
    );
    assert(
      !html.includes(relSecret.toString('base64')),
      'scorecard: a ../ artifact path must not be read and inlined',
    );
    assert(
      !html.includes(absSecret.toString('base64')),
      'scorecard: an absolute artifact path must not be read and inlined',
    );
    // The base64 check above is NOT sufficient on its own: pre-fix, `join(dir,
    // absPath)` produced a nonexistent path, so the file was never inlined and
    // the assertion passed anyway - the leak was the emitted relative URL. Assert
    // on the filename so this fails against the pre-fix code.
    assert(
      !html.includes('abs-secret.png'),
      'scorecard: an absolute artifact path must not be emitted into the HTML at all',
    );
    assert(
      !html.includes('../../outside'),
      'scorecard: an escaping artifact path must not be emitted as a relative src',
    );

    // The compare panel resolves before/after paths against OTHER run directories
    // and goes through the same read, so it needs the same containment guard.
    const cmp = {
      runA: 'r0',
      runB: 'r1',
      summary: {},
      metrics: [],
      screenshotPairs: [{ before: '../../outside/rel-secret.png', after: 'shot.png', caption: 'pair' }],
    };
    const cmpHtml = renderScorecard({
      host: 'example',
      generatedAt: '2026-01-01 00:00',
      runs: [
        { runId: 'r0', dir: prevDir, report, compare: null, ...scored },
        { runId: 'r1', dir: runDir, report, compare: cmp, ...scored },
      ],
      latest: { runId: 'r1', dir: runDir, report, compare: cmp, ...scored },
    });
    assert(
      cmpHtml.includes(legitBytes.toString('base64')),
      'scorecard: the compare panel must still inline a contained after-shot',
    );
    assert(
      !cmpHtml.includes(relSecret.toString('base64')),
      'scorecard: a ../ before/after compare path must not be read and inlined',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


// web-uplift-2zj (reviewer finding): aggregate/compare.mjs had the same
// uncontained-artifact shape as the scorecard - `resolveArtifact` fell back to a
// bare `join(dir, p)`, and it ALSO passed absolute paths straight through, so a
// report-supplied HAR path could be read from anywhere on disk. compare.md also
// emitted before/after paths verbatim.
export async function testCompareArtifactContainment() {
  const { compareReports, renderCompareMd } = await import('../aggregate/compare.mjs');
  const root = mkdtempSync(join(tmpdir(), 'web-uplift-compare-'));
  try {
    const dirA = join(root, 'host', 'r0');
    const dirB = join(root, 'host', 'r1');
    const outsideDir = join(root, 'outside');
    for (const d of [dirA, dirB, outsideDir]) mkdirSync(d, { recursive: true });

    // Same 2-entry HAR inside and outside, so "was it read?" is answered by the
    // entry count alone: 2 means it was read, null means the guard refused.
    const har = { log: { entries: [{ response: { _transferSize: 100 } }, { response: { _transferSize: 200 } }] } };
    writeFileSync(join(outsideDir, 'rel-secret.har'), JSON.stringify(har));
    // diffNetwork reads the A side against dirA and the B side against dirB, so
  // the contained control has to exist in BOTH run dirs.
  writeFileSync(join(dirA, 'run.har'), JSON.stringify(har));
  writeFileSync(join(dirB, 'run.har'), JSON.stringify(har));
    writeFileSync(join(outsideDir, 'rel-secret.png'), Buffer.from('COMPARE-TRAVERSAL-MARKER'));
    writeFileSync(join(dirA, 'shot.png'), Buffer.from('COMPARE-LEGIT-MARKER'));

    const base = JSON.parse(readFileSync(join(repoRoot, 'examples/playground-report.json'), 'utf8'));
    const withArtifact = (path) => {
      const r = structuredClone(base);
      r.artifacts = [{ type: 'har', path }];
      return r;
    };
    const contained = withArtifact('run.har');
    const escaping = withArtifact('../../outside/rel-secret.har');
    const absolute = withArtifact(join(outsideDir, 'rel-secret.har'));

    // If either HAR had been read, its count would be 2. `null` on the unsafe
    // side and 2 on the contained side is the containment proof AND the positive
    // control in one assertion.
    const blocked = compareReports(escaping, contained, { dirA, dirB });
    assert(
      blocked.network?.requestCount.before === null && blocked.network?.requestCount.after === 2,
      `compare: an escaping HAR path must not be read while a contained one is (got ${JSON.stringify(blocked.network)})`,
    );
    const blockedAbs = compareReports(absolute, contained, { dirA, dirB });
    assert(
      blockedAbs.network?.requestCount.before === null,
      `compare: an absolute HAR path must not be read (got ${JSON.stringify(blockedAbs.network)})`,
    );

    // compare.md must not emit an escaping or absolute image reference.
    const cmp = {
      ...compareReports(base, base, { dirA, dirB }),
      screenshotPairs: [
        { before: '../../outside/rel-secret.png', after: join(outsideDir, 'rel-secret.png'), caption: 'escape' },
        { before: 'shot.png', after: 'shot.png', caption: 'legit' },
      ],
    };
    const md = renderCompareMd(cmp, { hostName: 'example.test', runAId: 'r0', runBId: 'r1', dirA, dirB });
    assert(!md.includes('../../outside'), 'compare.md: an escaping before/after path must not be emitted');
    assert(!md.includes(outsideDir), 'compare.md: an absolute before/after path must not be emitted');
    // Positive control: a contained path is still rendered (rewritten relative to
    // runB's dir, which is why the legitimate reference itself starts with ../).
    assert(md.includes('![before](../r0/shot.png)'), `compare.md: a contained before path must still be emitted:\n${md}`);
    assert(md.includes('![after](shot.png)'), 'compare.md: a contained after path must still be emitted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


export const syntaxCoreTests = [
  testSyntaxChecks,
  testPackageRootImportIsSideEffectFree,
  testIconSatisfiesMatrix,
  testFirstPartyHostMatrix,
  testPageDerivedFetchGuard,
  testSafeFetchRedirectAndSizeGuard,
  testSafeFetchDnsRebindingGuard,
  testSafeFetchContentDecoding,
  testSchemaValidation,
  testAtomicCoverageValidator,
  testFetchDeadlineAndRawComparison,
  testScorecardRejectsEscapingComparisonRunIds,
  testScorecardReservesImageBoxes,
  testReservedImageBoxInBrowser,
  testLatestPointerCannotEscapeTheRunRoot,
  testSourceTreeSkipsSymlinkFileEscape,
  testSourceTreeSkipsSymlinkDirEscape,
  testSourceTreeSkipsSymlinkCycle,
  testSourceTreeDepthGuard,
  testCompareReportsUnconcludedChecks,
  testScorecardScoringAndRender,
  testScorecardArtifactContainment,
  testCompareArtifactContainment,
];

export {
  testSafeFetchDnsRebindingGuard,
  testSafeFetchContentDecoding,
  testSourceTreeSkipsSymlinkFileEscape,
  testSourceTreeSkipsSymlinkDirEscape,
  testSourceTreeSkipsSymlinkCycle,
  testSourceTreeDepthGuard,
};

await runSuite(syntaxCoreTests, import.meta.url);
