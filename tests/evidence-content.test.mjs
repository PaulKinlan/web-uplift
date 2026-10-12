#!/usr/bin/env node
// content and structure primitives, plus the await census and the source-containment cases.
//
// SPLIT FROM tests/evidence.test.mjs (web-uplift-bop3). The gate runs each tests/*.test.mjs in
// its own node:test process and is bounded by its slowest single file, so one 121s file
// throttled the whole gate. Cases moved here unchanged; no case was dropped, relaxed or
// reordered, and every case remains independent (it builds its own server and browser).

import http from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { assert, run, runAsync, repoRoot, runSuite } from './test-helpers.mjs';
import {
  gather,
  waitForInteractEvidence,
  safeFetch,
  assertPageDerivedFetchAllowed,
} from '../evidence/cli.mjs';
import { launchChrome } from '../evidence/cdp.mjs';
import {
  testNoSourceArgumentOmitsSource,
  testAdversarialPageCannotInfluenceSource,
  testExplicitSourceHonoursOperatorSpecifiedRoot,
} from './evidence-cli-source-containment.mjs';
export async function testEvidenceTruncationReporting() {
  const filler = 'z'.repeat(1000);
  const bigCss = Array.from({ length: 300 }, (_, i) => `.pad${i}{--filler-${i}:"${filler}"}`).join('\n');
  const pixel = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='), (c) => c.charCodeAt(0));

  const server = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/pixel.gif') {
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(pixel);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (path === '/over-cap') {
      res.end(`<!doctype html><title>over</title><style>${bigCss}</style><h1>over</h1>`);
      return;
    }
    if (path === '/under-cap') {
      res.end('<!doctype html><title>under</title><style>.a{color:#123}</style><h1>under</h1>');
      return;
    }
    if (path === '/many-images') {
      const imgs = Array.from({ length: 40 }, (_, i) => `<img src="/pixel.gif?i=${i}" alt="pixel ${i}" width="1" height="1">`).join('');
      res.end(`<!doctype html><title>images</title>${imgs}`);
      return;
    }
    if (path === '/many-cookies') {
      res.end("<!doctype html><title>cookies</title><script>for (let i = 0; i < 51; i++) document.cookie = 'cap' + i + '=1;path=/';</script>");
      return;
    }
    res.end('<!doctype html><title>empty</title>');
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    // Over the cap, through the real CLI: the JSON reports what was cut, stderr
    // says it out loud, and the shown text is exactly the cap.
    const cli = await runAsync(process.execPath, ['evidence/cli.mjs', 'dom', `${base}/over-cap`, '--wait', '250']);
    assert(cli.status === 0, `truncation: dom CLI failed:\n${cli.stderr}\n${cli.stdout}`);
    const over = JSON.parse(cli.stdout);
    assert(
      over.page.cssTruncated === true && over.page.cssChars > 200000 && over.page.css.length === 200000,
      `truncation: the 200KB CSS cap was not reported: ${JSON.stringify({ cssChars: over.page.cssChars, shown: over.page.css.length, truncated: over.page.cssTruncated })}`,
    );
    assert(
      over.page.outerHTML.length === Math.min(over.page.outerHTMLChars, 200000),
      'truncation: outerHTML length does not match its reported total',
    );
    assert(
      /WARNING: dom\.css/.test(cli.stderr),
      `truncation: the CLI did not warn about the cut CSS:\n${cli.stderr}`,
    );

    // Under the cap the same fields have to prove completeness: not truncated,
    // and the shown text is the whole text.
    const under = await gather('dom', `${base}/under-cap`, { quiet: true, wait: 250 });
    assert(
      under.page.cssTruncated === false && under.page.cssChars === under.page.css.length && under.page.css.length > 0,
      `truncation: a complete CSS sample was not reported as complete: ${JSON.stringify({ cssChars: under.page.cssChars, shown: under.page.css.length, truncated: under.page.cssTruncated })}`,
    );

    // The list caps report the same way: 40 images on the page, 30 listed.
    const images = await gather('images', `${base}/many-images`, { quiet: true, wait: 250 });
    assert(images.totalImages === 40, `truncation: images total is wrong: ${images.totalImages}`);
    assert(
      images.imagesInspected === 40 && images.imagesInspectedTruncated === false,
      `truncation: images inspection cap misreported: ${JSON.stringify({ inspected: images.imagesInspected, truncated: images.imagesInspectedTruncated })}`,
    );
    assert(
      images.imagesTruncated === true && images.images.length === 30,
      `truncation: images listing cap misreported: ${JSON.stringify({ listed: images.images.length, truncated: images.imagesTruncated })}`,
    );

    // 51 cookies set, 50 listed.
    const cookies = await gather('cookies', `${base}/many-cookies`, { quiet: true, wait: 250 });
    assert(cookies.totalCookies === 51, `truncation: cookies total is wrong: ${cookies.totalCookies}`);
    assert(
      cookies.cookiesTruncated === true && cookies.cookies.length === 50,
      `truncation: cookies listing cap misreported: ${JSON.stringify({ listed: cookies.cookies.length, truncated: cookies.cookiesTruncated })}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// The checks that turn on which modern CSS a page actually ships need the LIVE
// CSSOM, not a grep of the dom primitive's capped css string. This fixture
// covers every census source (document sheet with @import/@layer/@container/
// @starting-style/@scope/@supports/@property, a cross-origin sheet that must be
// skipped rather than crash the walk, a shadow-root adopted sheet, inline
// styles), the tracked feature rows, the overlay census, and the condition cap
// (web-uplift-xci).

export async function testFeaturesPrimitive() {
  // The cross-origin sheet has to be a different origin, and a different port
  // is a different origin, so a second server is the cheapest honest fixture.
  const cross = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end('.cross { color: orange; }');
  });
  await new Promise((resolveListen) => cross.listen(0, '127.0.0.1', resolveListen));
  const crossPort = cross.address().port;

  const css = [
    '@layer base, theme;',
    '@layer base { .a { color: light-dark(#111, #eee); } }',
    '@media (prefers-color-scheme: dark) { .a { color-scheme: dark; } }',
    '@container card (min-width: 300px) { .b { color: red; } }',
    '@starting-style { .c { opacity: 0; } }',
    '@scope (.scope-root) { .d { color: blue; } }',
    '@supports (color: light-dark(black, white)) { .e { color: light-dark(black, white); } }',
    '.f { container-type: inline-size; container-name: card; anchor-name: --a; position-try: --t; text-wrap: balance; }',
    '.g:has(> .h) { color: green; }',
    'dialog::backdrop { background: rgb(0 0 0 / 0.5); }',
    '.pop:popover-open { color: purple; }',
    '@keyframes fade { from { opacity: 0; } to { opacity: 1; } }',
    "@property --my-prop { syntax: '<length>'; inherits: false; initial-value: 0px; }",
    ':root { --brand: #123; --space: 4px; }',
  ].join('\n');
  const manyConditions = Array.from({ length: 70 }, (_, i) => `@media (min-width: ${100 + i}px) { .m${i} { color: red; } }`).join('\n');

  const page = (many) => [
    '<!doctype html><html><head><title>features</title>',
    ...(many ? [] : [`<link rel="stylesheet" href="http://127.0.0.1:${crossPort}/cross.css">`]),
    '<style>',
    "@import url('/imported.css');",
    many ? manyConditions : css,
    '</style></head><body>',
    '<div class="scope-root"><p class="d">scoped</p></div>',
    '<dialog open>native dialog</dialog>',
    '<div popover id="pop">popover</div>',
    '<details><summary>more</summary>body</details>',
    '<div role="dialog" aria-modal="true">div dialog</div>',
    '<div id="stack" style="position:fixed;z-index:60">stacked</div>',
    '<div id="inline" style="container-type:inline-size">inline container</div>',
    '<div id="host"></div>',
    '<script>',
    "  const root = document.getElementById('host').attachShadow({ mode: 'open' });",
    '  const sheet = new CSSStyleSheet();',
    "  sheet.replaceSync('.shadowed { interpolate-size: allow-keywords; }');",
    '  root.adoptedStyleSheets = [sheet];',
    "  root.innerHTML = '<span class=\"shadowed\">shadow</span>';",
    '</script>',
    '</body></html>',
  ].join('\n');

  const main = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/imported.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('.imported { animation-timeline: --t; }');
      return;
    }
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page(path === '/many'));
  });

  await new Promise((resolveListen) => main.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = main.address();
    const base = `http://127.0.0.1:${port}`;

    const result = await gather('features', `${base}/`, { quiet: true, wait: 600 });

    // Every style source is visited, and the unreadable one is counted, named,
    // and makes the census explicitly partial rather than silently thin.
    assert(result.censusComplete === false, `features: a cross-origin sheet must make the census incomplete: ${result.censusComplete}`);
    assert(result.sheets.crossOriginSkipped === 1, `features: the cross-origin sheet should be skipped and counted: ${JSON.stringify(result.sheets)}`);
    assert(
      result.sheets.crossOriginSheetUrls.some((u) => u.includes('/cross.css')),
      `features: the skipped sheet should be named so it can be checked another way: ${JSON.stringify(result.sheets.crossOriginSheetUrls)}`,
    );
    assert(result.sheets.importedSheetsFollowed === 1, `features: the @import sheet should be followed: ${JSON.stringify(result.sheets)}`);
    assert(result.sheets.shadowRootsScanned === 1, `features: the shadow root should be scanned: ${JSON.stringify(result.sheets)}`);
    assert(result.sheets.inlineStyleElements === 2, `features: both inline styles should be scanned: ${JSON.stringify(result.sheets)}`);

    const atRules = result.tracked.atRules;
    assert(
      atRules['@container'] === 1 && atRules['@starting-style'] === 1 && atRules['@scope'] === 1 &&
        atRules['@supports'] === 1 && atRules['@property'] === 1 && atRules['@layer'] === 2 && atRules['@view-transition'] === 0,
      `features: at-rule census is wrong: ${JSON.stringify(atRules)}`,
    );
    const props = result.tracked.properties;
    assert(
      props['container-type'] >= 2 && props['anchor-name'] === 1 && props['position-try-fallbacks'] === 1 &&
        props['animation-timeline'] === 1 && props['interpolate-size'] === 1 && props['color-scheme'] === 1 &&
        props['content-visibility'] === 0,
      `features: property census is wrong: ${JSON.stringify(props)}`,
    );
    assert(result.tracked.functions['light-dark'] >= 2, `features: light-dark() usage was not counted: ${JSON.stringify(result.tracked.functions)}`);
    const sels = result.tracked.selectors;
    assert(
      sels[':has('] === 1 && sels['::backdrop'] === 1 && sels[':popover-open'] === 1 && sels[':is('] === 0,
      `features: selector census is wrong: ${JSON.stringify(sels)}`,
    );
    assert(result.customProperties.distinct === 2, `features: custom properties were not counted: ${JSON.stringify(result.customProperties)}`);
    const conditionNames = Object.keys(result.conditions);
    assert(
      conditionNames.includes('@media (prefers-color-scheme: dark)') && conditionNames.some((c) => c.startsWith('@container card')),
      `features: conditional at-rule preludes should be in the census: ${JSON.stringify(conditionNames)}`,
    );

    const overlays = result.overlays;
    assert(
      overlays.dialogElements === 1 && overlays.openDialogs === 1 && overlays.popoverElements === 1 &&
        overlays.detailsElements === 1 && overlays.roleDialogElements === 1 && overlays.ariaModalElements === 1,
      `features: overlay census is wrong: ${JSON.stringify(overlays)}`,
    );
    assert(
      overlays.highZIndexCount === 1 && overlays.highZIndexMax === 60 && overlays.highZIndexExamples[0]?.id === 'stack',
      `features: the high z-index div was not surfaced: ${JSON.stringify(overlays)}`,
    );

    // The condition map is capped, and the cap is reported rather than silent.
    // This page has no cross-origin sheet, so it also proves the complete case.
    const capped = await gather('features', `${base}/many`, { quiet: true, wait: 500 });
    assert(capped.censusComplete === true, `features: a same-origin-only page should report a complete census: ${JSON.stringify(capped.sheets)}`);
    assert(
      capped.conditionsTotal === 70 && capped.conditionsTruncated === true && Object.keys(capped.conditions).length === 60,
      `features: the condition cap was not reported: ${JSON.stringify({ total: capped.conditionsTotal, shown: Object.keys(capped.conditions).length, truncated: capped.conditionsTruncated })}`,
    );
  } finally {
    await new Promise((resolveClose) => main.close(resolveClose));
    await new Promise((resolveClose) => cross.close(resolveClose));
  }
}

export async function testDiscoverabilityHelpers() {
  const { stripHtmlToText, contentTokens, detectEmptyMounts, contentPresentInRaw } = await import('../evidence/cli.mjs');

  // stripHtmlToText drops scripts/styles/markup, keeps visible text.
  const text = stripHtmlToText('<html><head><style>.x{color:red}</style></head><body><h1>Hello There</h1><script>var a=1</script><p>Body &amp; content</p></body></html>');
  assert(text.includes('Hello There') && text.includes('Body & content'), `stripHtmlToText missed content: ${text}`);
  assert(!text.includes('color:red') && !text.includes('var a'), `stripHtmlToText leaked script/style: ${text}`);

  // contentTokens keeps >=4-char words, lowercased, de-duped.
  const toks = contentTokens('The Thylakoid MEMBRANE membrane a to');
  assert(toks.has('thylakoid') && toks.has('membrane'), 'contentTokens missing expected words');
  assert(!toks.has('the') && !toks.has('to'), 'contentTokens should skip short words');
  assert(toks.size === 2, `contentTokens should de-dupe case-insensitively, got ${toks.size}`);

  // detectEmptyMounts flags an empty SPA root but not a filled one.
  assert(detectEmptyMounts('<div id="root"></div>').includes('#root'), 'should detect empty #root');
  assert(detectEmptyMounts('<div id="root"><h1>hi</h1></div>').length === 0, 'should not flag a filled #root');
  assert(detectEmptyMounts('<div id="__next">   </div>').includes('#__next'), 'should detect empty #__next');

  // contentPresentInRaw: inline markup and line breaks must not hide a
  // server-rendered h1/title (web-uplift-406). innerText collapses them, so the
  // verbatim-substring compare reported the h1 of paul.kinlan.me as missing.
  const rawFixture = stripHtmlToText('<html><head><title>Hello. I am Paul Kinlan.</title></head><body><h1 class="x">\n          Hello. I am <span class="fn">Paul Kinlan</span>.\n        </h1></body></html>');
  assert(contentPresentInRaw('Hello. I am Paul Kinlan.', rawFixture), `inline-span h1 should be present in raw text: ${rawFixture}`);
  assert(contentPresentInRaw('Hello. I am\n          Paul Kinlan.', rawFixture), 'a rendered value with line breaks should still match');
  assert(!contentPresentInRaw('Client Injected Heading', rawFixture), 'a JS-only heading must not read as present');
  assert(!contentPresentInRaw('', rawFixture) && !contentPresentInRaw(null, rawFixture), 'empty values are not present');
  // A value with no >=4-char tokens still compares, so it is not present by default.
  assert(contentPresentInRaw('Hi', '<p>Hi there</p>'), 'short text should be found when present');
  assert(!contentPresentInRaw('Hi', '<p>Bye there</p>'), 'short text should not be found when absent');
}


// End to end, through the real primitive: a server-rendered h1 broken up by an
// inline span and line breaks must report h1PresentInRaw true (the paul.kinlan.me
// shape, web-uplift-406), and an h1 that only JavaScript inserts must stay false,
// so the fix cannot be paid for by weakening the shell detection.

export async function testDiscoverabilityH1InRaw() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if ((req.url || '').startsWith('/markup')) {
      res.end('<!doctype html><html><head><title>Inline markup</title></head><body>' +
        '<h1 class="page-title">\n          Hello. I am <span class="fn">Paul Kinlan</span>.\n        </h1>' +
        '<p>A server-rendered paragraph with enough words for the coverage measure to compare.</p>' +
        '</body></html>');
      return;
    }
    res.end('<!doctype html><html><head><title>Client rendered</title></head><body>' +
      '<div id="app"></div>' +
      '<p>A server-rendered paragraph with enough words for the coverage measure to compare.</p>' +
      '<script>document.querySelector("#app").innerHTML = "<h1>Client Injected Heading</h1>";</script>' +
      '</body></html>');
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const markup = await gather('discoverability', `${base}/markup`, { quiet: true, wait: 0, screenshots: false });
    assert(markup.rendered.h1Count === 1, `discoverability: expected the rendered h1: ${JSON.stringify(markup.rendered)}`);
    assert(
      markup.h1PresentInRaw === true,
      `discoverability: an inline-span h1 was reported missing from the raw HTML: ${JSON.stringify(markup.rendered)}`,
    );

    const injected = await gather('discoverability', `${base}/client`, { quiet: true, wait: 0, screenshots: false });
    assert(injected.rendered.h1Count === 1, `discoverability: expected the JS-injected h1: ${JSON.stringify(injected.rendered)}`);
    assert(
      injected.h1PresentInRaw === false,
      `discoverability: a JS-injected h1 read as present in the raw HTML: ${JSON.stringify(injected.rendered)}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// WCAG 2.2 SC 2.5.8 Target Size (Minimum) needs real geometry: the targets
// primitive enumerates pointer targets, flags anything under 24x24 CSS px, marks
// the inline-in-text and spacing exceptions it can read from geometry, and
// measures a desktop and a narrow layout by default (web-uplift-uz7).

export async function testTargetsPrimitive() {
  const page = [
    '<!doctype html><html><head><title>targets</title><style>',
    '  body { margin: 0; }',
    '  .tiny { width: 16px; height: 16px; padding: 0; border: 0; }',
    '  .big { width: 48px; height: 48px; }',
    '  .gap { margin-left: 200px; }',
    '  section, p { margin-bottom: 40px; }',
    '  p { font-size: 16px; line-height: 20px; }',
    '</style></head><body>',
    '<p>Read the <a class="tiny" href="#a" id="inline-link">text</a> in this sentence.</p>',
    '<section><button class="tiny" id="tight-a">a</button><button class="tiny" id="tight-b">b</button></section>',
    '<section><button class="tiny" id="spaced-a">a</button><button class="tiny gap" id="spaced-b">b</button></section>',
    '<section><button class="big" id="big-button">ok</button></section>',
    '<section><span style="display:none">hidden</span><a href="#z" style="width:0;height:0"></a></section>',
    '</body></html>',
  ].join('\n');
  const many = '<!doctype html><html><head><title>many</title><style>a{display:inline-block;width:8px;height:8px}</style></head><body>' +
    Array.from({ length: 420 }, (_, i) => `<a href="#${i}">${i}</a>`).join('') +
    '</body></html>';
  const empty = '<!doctype html><html><head><title>empty</title></head><body><p>No pointer targets at all here.</p></body></html>';

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (path === '/many') res.end(many);
    else if (path === '/empty') res.end(empty);
    else res.end(page);
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const result = await gather('targets', `${base}/page`, { quiet: true, wait: 250 });
    assert(result.minimumPx === 24, `targets: minimum should be 24 CSS px: ${result.minimumPx}`);
    assert(result.viewports.length === 2, `targets: expected a desktop and a narrow pass by default: ${result.viewports.length}`);
    const [desktop, narrow] = result.viewports;
    assert(
      desktop.name === 'desktop-1280x720' && desktop.viewport.width === 1280 && desktop.viewport.height === 720,
      `targets: the desktop pass did not measure a 1280x720 layout: ${JSON.stringify(desktop.viewport)}`,
    );
    assert(
      narrow.name === 'narrow-360x800' && narrow.viewport.width === 360 && narrow.viewport.height === 800,
      `targets: the narrow pass did not measure a 360x800 layout: ${JSON.stringify(narrow.viewport)}`,
    );

    const byId = new Map(desktop.targets.map((t) => [t.id, t]));
    const inline = byId.get('inline-link');
    assert(
      inline?.underMin === true && inline.inlineInText === true,
      `targets: an undersized link in a sentence should be flagged and marked inline-exempt: ${JSON.stringify(inline)}`,
    );
    for (const id of ['tight-a', 'tight-b']) {
      const t = byId.get(id);
      assert(
        t?.underMin === true && t.inlineInText === false && t.spacingPasses === false,
        `targets: ${id} is undersized with no spacing clearance and should say so: ${JSON.stringify(t)}`,
      );
    }
    for (const id of ['spaced-a', 'spaced-b']) {
      const t = byId.get(id);
      assert(
        t?.underMin === true && t.spacingPasses === true,
        `targets: ${id} is undersized but clears its neighbours and should say so: ${JSON.stringify(t)}`,
      );
    }
    const big = byId.get('big-button');
    assert(
      big?.underMin === false && big.spacingPasses === null,
      `targets: a 48x48 button is not undersized: ${JSON.stringify(big)}`,
    );
    assert(desktop.skippedZeroSizeCount === 1, `targets: the zero-size target should be skipped: ${desktop.skippedZeroSizeCount}`);
    assert(
      desktop.underMinCount === 5 &&
        desktop.underMinInlineExemptCount === 1 &&
        desktop.underMinSpacingExemptCount === 3 &&
        desktop.underMinNoKnownExemptionCount === 2,
      `targets: summary counts do not match the inventory: ${JSON.stringify({ underMin: desktop.underMinCount, inline: desktop.underMinInlineExemptCount, spacing: desktop.underMinSpacingExemptCount, none: desktop.underMinNoKnownExemptionCount })}`,
    );
    assert(
      narrow.underMinNoKnownExemptionCount === 2,
      `targets: the narrow pass should reach the same verdict on this fixture: ${narrow.underMinNoKnownExemptionCount}`,
    );

    // An explicit --viewport means one pass, and the inventory is capped with the
    // cap reported rather than silently trimmed.
    const manyResult = await gather('targets', `${base}/many`, { quiet: true, wait: 200, viewport: { w: 360, h: 800 } });
    assert(manyResult.viewports.length === 1, `targets: an explicit viewport should give one pass: ${manyResult.viewports.length}`);
    const capped = manyResult.viewports[0];
    assert(
      capped.matchedCount === 420 && capped.measuredCount === 400 && capped.omittedByCapCount === 20,
      `targets: the target cap was not reported: ${JSON.stringify({ matched: capped.matchedCount, measured: capped.measuredCount, omitted: capped.omittedByCapCount })}`,
    );
    assert(
      capped.underMinCount === 400 && capped.underMinNoKnownExemptionCount === 400,
      `targets: a wall of adjacent 8x8 links has no read exemption: ${JSON.stringify({ underMin: capped.underMinCount, noExemption: capped.underMinNoKnownExemptionCount })}`,
    );

    // No targets is a clean zero result, not an absent field: that is the
    // evidence a no-target page needs for the check to pass.
    const emptyResult = await gather('targets', `${base}/empty`, { quiet: true, wait: 200, viewport: { w: 360, h: 800 } });
    const none = emptyResult.viewports[0];
    assert(
      none.measuredCount === 0 && none.underMinNoKnownExemptionCount === 0 && none.targets.length === 0,
      `targets: a page with no targets should report zeroes: ${JSON.stringify({ measured: none.measuredCount, noExemption: none.underMinNoKnownExemptionCount })}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

export async function testA11yTreePrimitive() {
  const page = [
    '<!doctype html><html lang="en"><head><title>a11y fixture</title><style>',
    '  body { margin: 0; font-family: sans-serif; }',
    '  button, input, a { display: inline-block; margin: 4px; }',
    '  .no-outline:focus { outline: none; }',
    '  .visible:focus { outline: 3px solid #f00; }',
    '</style></head><body>',
    '<header><h1>Accessibility fixture</h1></header>',
    '<nav aria-label="Main navigation"><a href="#1" id="first" class="visible">One</a><a href="#2" id="second">Two</a></nav>',
    '<main>',
    '<button id="labelled" aria-label="Ignored label" aria-labelledby="lbl">x</button><span id="lbl">Labelled by text</span>',
    '<button id="titled" title="Name from title"></button>',
    '<button id="no-outline" class="no-outline">No outline</button>',
    '<div aria-hidden="true"><button id="hidden-button">Hidden button</button></div>',
    '<a href="#skipped" id="tabindex-minus" tabindex="-1">Not in tab order</a>',
    '<input id="email" type="email" aria-label="Email address">',
    '<h2 id="heading-2">Section</h2>',
    '</main>',
    '<footer><a href="#3" id="third">Three</a></footer>',
    '</body></html>',
  ].join('\n');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page);
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const { port } = server.address();
    const result = await gather('a11ytree', `http://127.0.0.1:${port}/`, { quiet: true, wait: 600 });

    const flat = [];
    const walk = (n) => {
      if (!n) return;
      flat.push(n);
      for (const child of n.children || []) walk(child);
    };
    walk(result.tree.root);
    const accessible = flat.filter((n) => !n.ignored);
    const named = (role, name) => accessible.find((n) => n.role === role && n.name === name);

    assert(
      named('navigation', 'Main navigation') && named('main') && named('contentinfo'),
      `a11ytree: landmark roles/names missing from the computed tree: ${JSON.stringify(result.tree.roleCounts)}`,
    );
    assert(
      !!named('button', 'Labelled by text'),
      `a11ytree: aria-labelledby should win over aria-label in the computed name: ${JSON.stringify(accessible.filter((n) => n.role === 'button'))}`,
    );
    assert(
      !!named('button', 'Name from title'),
      `a11ytree: a name coming from title should appear in the computed tree: ${JSON.stringify(accessible.filter((n) => n.role === 'button'))}`,
    );
    assert(
      !accessible.some((n) => n.role === 'button' && n.name === 'Hidden button'),
      'a11ytree: a button inside aria-hidden must not be exposed as an accessible button',
    );
    assert(result.tree.ignoredCount >= 1, `a11ytree: the aria-hidden subtree should be ignored: ${result.tree.ignoredCount}`);
    assert(
      result.tree.truncated === false && result.tree.maxDepth >= 3 && result.tree.totalNodes > 10,
      `a11ytree: the tree census looks wrong: ${JSON.stringify({ total: result.tree.totalNodes, projected: result.tree.nodesProjected, depth: result.tree.maxDepth })}`,
    );
    assert(
      result.tree.maxNodes === 400 && result.focusOrder.maxStops === 60,
      `a11ytree: the effective caps should be reported: ${JSON.stringify({ maxNodes: result.tree.maxNodes, maxStops: result.focusOrder.maxStops })}`,
    );

    // The real tab order: DOM order, tabindex=-1 skipped, and aria-hidden content
    // still reachable (which the tree says is hidden).
    const ids = result.focusOrder.stops.filter((s) => !s.isBody).map((s) => s.id);
    assert(
      JSON.stringify(ids) === JSON.stringify(['first', 'second', 'labelled', 'titled', 'no-outline', 'hidden-button', 'email', 'third']),
      `a11ytree: focus order is wrong: ${JSON.stringify(ids)}`,
    );
    assert(
      !ids.includes('tabindex-minus'),
      `a11ytree: tabindex=-1 must stay out of the tab order: ${JSON.stringify(ids)}`,
    );
    assert(
      result.focusOrder.stopsInsideAriaHidden === 1 && result.focusOrder.stops.some((s) => s.id === 'hidden-button' && s.insideAriaHidden === true),
      `a11ytree: the focusable element inside aria-hidden should be recorded as such: ${JSON.stringify(result.focusOrder.stops.map((s) => [s.id, s.insideAriaHidden]))}`,
    );
    assert(result.focusOrder.cycleDetected === true, 'a11ytree: the walk should detect the tab cycle wrapping');

    // Focus indicators: the author-suppressed one reads as none, the styled one
    // as visible.
    const noOutline = result.focusOrder.stops.find((s) => s.id === 'no-outline');
    const firstStop = result.focusOrder.stops.find((s) => s.id === 'first');
    assert(
      noOutline?.hasVisibleIndicator === false && noOutline.outline.style === 'none',
      `a11ytree: outline:none should read as no visible indicator: ${JSON.stringify(noOutline)}`,
    );
    assert(
      firstStop?.hasVisibleIndicator === true,
      `a11ytree: a 3px outline should read as a visible indicator: ${JSON.stringify(firstStop)}`,
    );

    // The caps are the model's to widen, and a widened or lowered cap is echoed
    // in the output rather than applied silently.
    const narrowCaps = await gather('a11ytree', `http://127.0.0.1:${port}/`, { quiet: true, wait: 400, maxNodes: 5, maxStops: 2 });
    assert(
      narrowCaps.tree.maxNodes === 5 && narrowCaps.tree.nodesProjected <= 5 && narrowCaps.tree.truncated === true,
      `a11ytree: --max-nodes should cap the projection and say so: ${JSON.stringify({ maxNodes: narrowCaps.tree.maxNodes, projected: narrowCaps.tree.nodesProjected, truncated: narrowCaps.tree.truncated })}`,
    );
    assert(
      narrowCaps.focusOrder.maxStops === 2 && narrowCaps.focusOrder.stopCount === 2 && narrowCaps.focusOrder.truncated === true,
      `a11ytree: --max-stops should cap the walk and say so: ${JSON.stringify({ maxStops: narrowCaps.focusOrder.maxStops, stops: narrowCaps.focusOrder.stopCount, truncated: narrowCaps.focusOrder.truncated })}`,
    );

    // A bad value must fall back to the documented default rather than
    // producing an empty tree.
    const badCaps = await gather('a11ytree', `http://127.0.0.1:${port}/`, { quiet: true, wait: 400, maxNodes: 0, maxStops: Number.NaN });
    assert(
      badCaps.tree.maxNodes === 400 && badCaps.focusOrder.maxStops === 60 && badCaps.tree.nodesProjected > 5,
      `a11ytree: invalid caps should fall back to the defaults: ${JSON.stringify({ maxNodes: badCaps.tree.maxNodes, maxStops: badCaps.focusOrder.maxStops, projected: badCaps.tree.nodesProjected })}`,
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}


// web-uplift-17o, the census ENFORCED. The completeness claim is arithmetic, and this test is
// what keeps it true rather than read: every non-comment await line across the evidence modules
// must match exactly one disposition rule below, and each rule's count must equal its
// expectation. A NEW await that matches nothing fails HERE, naming the file, the line number
// and the text, so the next author classifies it (bounds it, or records the exclusion with
// its reason) in the census comment next to withDeadline in evidence/cdp.mjs - and a
// classification that drifts fails the same way. The expected counts live here, not in
// prose, so this is the one authoritative list; the comment summarises and points here.

export function testAwaitCensus() {
  // The rules match the ACTUAL bounded call sites, not shapes that merely look bounded: the
  // fetch rule requires the AbortSignal on the same line, so removing the signal leaves the
  // site UNCLASSIFIED (loud) rather than still "bounded"; and the primitive dispatch is
  // excluded, because it can run the unbounded content probes. Each site must match EXACTLY
  // ONE rule (checked below): first-match-permissive is how a dispatch got called bounded.
  // THE CENSUS'S LIMIT, stated plainly: it verifies that every site is CLASSIFIED. It cannot
  // verify that a bound is still PRESENT at a classified site - that is what review and the
  // targeted tests are for.
  const rules = [
    ['bounded:withDeadline', /await withDeadline\(|await withRetry\(/],
    ['bounded:navigate-helper', /await navigate\(/],
    // web-uplift-j3re listed the pipe readiness probe here as bounded by the enclosing
    // waitForPipeReady(). web-uplift-xnte proved that false - the loop consulted its deadline only in the
    // catch - and moved the probe into a race that owns its bound. The shape is therefore dropped from
    // this rule rather than left looking classified: a bare await of it reappearing is now UNCLASSIFIED
    // and loud, which is the truthful disposition, because no caller bounds it.
    ['bounded:transitive-caller-wraps', /await client\.Emulation\.(setEmulatedMedia|setDeviceMetricsOverride|setCPUThrottlingRate|setLocaleOverride|setTimezoneOverride)|await client\.Network\.emulateNetworkConditions|await client\.ServiceWorker\.enable/],
    ['bounded:sleep', /await sleep\(|await new Promise\(\(r\) => setTimeout/],
    ['bounded:pre-existing-mechanism', /await waitForProcExit|await waitForGroupDrain|port = await new Promise|await close\(\)|await result\.handle\.close\(\)|await launchChromeOnce|return await fn\(\)/],
    // web-uplift-4rv added two sites whose bound belongs to the CALLEE, which is why they are
    // classified here rather than wrapped: `connect(host, port, timeoutMs)` is handed its deadline
    // explicitly (the regex requires that argument, so removing it leaves the site UNCLASSIFIED
    // instead of quietly still 'bounded'), and `exposureProbe` is an injected probe whose
    // production default, cdpEndpointExposure, bounds its own sockets by PROBE_TIMEOUT_MS. Same
    // shape as `await launchChromeOnce`, which is bounded by the mechanism it contains.
    ['bounded:own-deadline', /await waitForNetworkIdle|await waitForInteractEvidence|await Promise\.race|await (?:fetch|pinnedFetch)\(.*AbortSignal|await fetched\.text\(\)|await docPromise|await exposureProbe\(|await waitForPipeReady\([^)]*deadlineMs|await Promise\.allSettled\(hosts\.map\(async \(host\) => connect\([^)]*timeoutMs\)\)\)/],
    ['bounded:gather-spine', /await launchChrome\(|await newSession\(|await attachConsoleCollector|await session\.close\(\)|await chrome\.close\(\)|await gather\(/],
    ['excluded:page-side-template', /await navigator\.|await fetch\(\$\{JSON\.stringify\(su\)\}, \{ signal: controller\.signal \}\)|const t = await res\.text\(\);/],
    ['excluded:primitive-probe', /await evaluate\(|captureScreenshot|getResponseBody|[Ss]creencast|HeapProfiler|axeSource|axe\.run|Accessibility|Input\.|getCookies|getLayoutMetrics|safeFetch\(|assertPageDerivedFetchAllowed|await lookup\(|await reader\.|res\.body|client\.Runtime\.evaluate|setBypassCSP|setScriptExecutionDisabled|getFullAXTree|await task\(item\)|await Promise\.all\(workers\)|await mapBounded\(|await fn\(session/],
  ];
  const expected = {
    'evidence/cdp.mjs': {
      // lsn3 and j3re moved these: the console redaction work, and then the pipe transport, which
      // adds five withDeadline-wrapped pipe calls, one bounded retry sleep, one grace-bounded
      // `await close()` on the pipe-readiness failure path, the readiness wait itself and the
      // Browser.getVersion probe inside its bounded loop. Every one is classified by the mechanism
      // that bounds it; none is a catch-all.
      'bounded:withDeadline': 17,
      // 9, not 7: the exposure verdict added a SECOND grace-bounded `await close()` on the path that
      // refuses an exposed launch (web-uplift-4rv), and every site in this bucket is the same
      // mechanism (waitForProcExit, waitForGroupDrain, the deadline-bounded endpoint wait, the
      // idempotent teardown, launchChromeOnce, withRetry's pass-through). The old count was never
      // wrong to the point of failing loudly: the unmatched-site assertion fires first and its
      // message hid this one behind it.
      // web-uplift-690r replaced the serial per-host probe loop with one Promise.all: the same number of
      // awaited sites in this file (the loop's await connect became the awaited Promise.all), so the
      // total is unchanged. The aggregate is bounded by the deadline each probe carries, not by their
      // sum - which is the point of the change.
      // web-uplift-py0e added four: the two liveness checks, each a bounded waitForProcExit settle plus
      // a teardown through the same `await close()` as every other launch failure - deliberately, so the
      // retry logic treats a browser that died during launch exactly like any other failed attempt.
      // web-uplift-uuod added one: the throwing-probe path now attributes the attempt and tears the
      // browser down exactly like every other launch failure, so it gained one `await close()`.
      // web-uplift-l93f added two: the finally's reap of an unhanded-off browser, and the
      // recovered-handle close in launchChrome when a caller's log throws after a successful attempt.
      'bounded:pre-existing-mechanism': 16,
      'bounded:sleep': 5,
      'bounded:gather-spine': 4,
      'excluded:primitive-probe': 2,
      // web-uplift-4rv: the exposure probe's own connect (handed timeoutMs) and the injected
      // exposureProbe, both bounded by the callee rather than by a wrapper at the call site.
      // web-uplift-j3re added a third: the pipe readiness wait, which takes deadlineMs.
      // web-uplift-xnte added a fourth: that wait now RACES its Browser.getVersion send against the
      // remaining budget and against process exit, so the send itself is bounded rather than only the
      // loop around it. The rule catches it because it matches await Promise.race.
      'bounded:own-deadline': 4,
      // web-uplift-j3re: the Browser.getVersion probe inside waitForPipeReady's bounded loop.
      // web-uplift-xnte moved that probe OUT of an awaited line and into the race that owns its bound, so
      // the rule matches nothing on this tree now. It is kept rather than deleted because applyConditions
      // and sw.enable still rely on it (see the rule above), and a bare await of the probe reappearing
      // would now be unclassified and loud - the truthful disposition, not an accident.
      'bounded:transitive-caller-wraps': 0,
    },
    'evidence/cli.mjs': {
      'bounded:gather-spine': 6,
      'excluded:primitive-probe': 1,
    },
    'evidence/common.mjs': {
      'bounded:transitive-caller-wraps': 6,
    },
    'evidence/fetch.mjs': {
      'excluded:primitive-probe': 3,
      'bounded:withDeadline': 1,
      'bounded:own-deadline': 1,
    },
    'evidence/primitives/a11ytree.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 5,
    },
    'evidence/primitives/axe.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 8,
    },
    'evidence/primitives/console.mjs': {
      'bounded:sleep': 2,
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 1,
      'bounded:own-deadline': 1,
    },
    'evidence/primitives/cookies.mjs': {
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 1,
    },
    'evidence/primitives/discoverability.mjs': {
      'excluded:primitive-probe': 6,
      'bounded:own-deadline': 1,
      'bounded:navigate-helper': 2,
      'bounded:sleep': 1,
    },
    'evidence/primitives/dom.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 1,
    },
    'evidence/primitives/evaluate.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 2,
    },
    'evidence/primitives/features.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 1,
    },
    'evidence/primitives/har.mjs': {
      'excluded:primitive-probe': 5,
      'bounded:sleep': 2,
      'bounded:navigate-helper': 1,
      'bounded:own-deadline': 1,
    },
    'evidence/primitives/headers.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:own-deadline': 1,
    },
    'evidence/primitives/heap.mjs': {
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 4,
      'bounded:sleep': 1,
    },
    'evidence/primitives/images.mjs': {
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 1,
    },
    'evidence/primitives/layout.mjs': {
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 4,
      'bounded:sleep': 1,
    },
    'evidence/primitives/resilience.mjs': {
      'bounded:transitive-caller-wraps': 1,
      'bounded:withDeadline': 4,
      'bounded:navigate-helper': 1,
      'bounded:sleep': 3,
      'excluded:primitive-probe': 6,
      'excluded:page-side-template': 1,
      'bounded:own-deadline': 3,
    },
    'evidence/primitives/screenshot.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 2,
    },
    'evidence/primitives/secrets.mjs': {
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 7,
      'excluded:page-side-template': 1,
    },
    'evidence/primitives/targets.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
      'excluded:primitive-probe': 1,
    },
    'evidence/primitives/trace.mjs': {
      'bounded:withDeadline': 8,
      'bounded:sleep': 2,
    },
    'evidence/primitives/trackers.mjs': {
      'bounded:navigate-helper': 1,
      'bounded:sleep': 1,
    },
    'evidence/primitives/video.mjs': {
      'bounded:navigate-helper': 1,
      'excluded:primitive-probe': 4,
      'bounded:sleep': 2,
    },
  };
  function findEvidenceFiles(dir) {
    const res = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) res.push(...findEvidenceFiles(full));
      else if (ent.isFile() && ent.name.endsWith('.mjs')) res.push(full);
    }
    return res;
  }
  const allEvidenceFiles = findEvidenceFiles(join(repoRoot, 'evidence')).map((p) => relative(repoRoot, p));
  for (const f of allEvidenceFiles) {
    const content = readFileSync(join(repoRoot, f), 'utf8');
    const hasAwait = content.split('\n').some((ln) => ln.includes('await ') && !ln.trim().startsWith('//'));
    if (hasAwait) {
      assert(expected[f], `await census: ${f} contains non-comment await statements but is not covered in expected map!`);
    }
  }
  for (const [file, expect] of Object.entries(expected)) {
    const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
    const counts = {};
    const unmatched = [];
    let total = 0;
    lines.forEach((ln, i) => {
      if (!ln.includes('await ') || ln.trim().startsWith('//')) return;
      total += 1;
      const matches = rules.filter(([, re]) => re.test(ln));
      if (matches.length !== 1) {
        unmatched.push(
          `${file}:${i + 1} [${matches.length === 0 ? 'NO' : matches.length + ' (' + matches.map((m) => m[0]).join(',') + ')'} rule match(es)]: ${ln.trim().slice(0, 100)}`,
        );
        return;
      }
      counts[matches[0][0]] = (counts[matches[0][0]] || 0) + 1;
    });
    assert(
      unmatched.length === 0,
      `await census: ${unmatched.length} await site(s) in ${file} match NO disposition rule - classify them in the census comment next to withDeadline in evidence/cdp.mjs and in this test:\n  ${unmatched.join('\n  ')}`,
    );
    const expectTotal = Object.values(expect).reduce((a, b) => a + b, 0);
    assert(
      total === expectTotal,
      `await census: ${file} has ${total} non-comment await sites but the census expects ${expectTotal} - a site was added or removed without updating the census (testAwaitCensus + the comment next to withDeadline)`,
    );
    for (const [name, n] of Object.entries(expect)) {
      assert(
        (counts[name] || 0) === n,
        `await census: ${file} disposition '${name}' holds ${counts[name] || 0} site(s), expected ${n} - a classification drifted; update the census with the reason`,
      );
    }
  }
}

export const evidenceContentTests = [
  testEvidenceTruncationReporting,
  testFeaturesPrimitive,
  testDiscoverabilityHelpers,
  testDiscoverabilityH1InRaw,
  testTargetsPrimitive,
  testA11yTreePrimitive,
  testAwaitCensus,
  testNoSourceArgumentOmitsSource,
  testAdversarialPageCannotInfluenceSource,
  testExplicitSourceHonoursOperatorSpecifiedRoot,
];

export {
  testNoSourceArgumentOmitsSource,
  testAdversarialPageCannotInfluenceSource,
  testExplicitSourceHonoursOperatorSpecifiedRoot,
};

await runSuite(evidenceContentTests, import.meta.url, { timeoutMs: 120000, concurrency: 1 });
