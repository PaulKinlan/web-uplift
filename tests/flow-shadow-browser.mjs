#!/usr/bin/env node
// Browser-driven guard for pierce/ shadow-root resolution (web-uplift-pai).
//
// WHY THIS EXISTS, and why the stub in tests/flow.mjs is not enough: that stub
// is a hand-rolled MiniDocument/MiniElement pair, so it can only show the walk
// agreeing with itself. What actually has to work is `resolveSelectorCandidate`
// running INSIDE a real page against real ShadowRoot objects, because
// `replayFlow` serializes that function with .toString() into the page
// expression (runner/flow.mjs pageAction). So this test drives the real replay
// path in headless Chrome against a page whose target lives in a NESTED open
// shadow root (host -> open shadowRoot -> host -> open shadowRoot -> button)
// and asserts the click was actually DELIVERED to that node.
//
// It also pins the Recorder semantics the resolver claims:
//   - pierce/ crosses nested open shadow roots;
//   - a light-DOM match wins before any shadow walk (so pierce/ never shadows
//     a normal CSS selector that already resolves);
//   - a plain document.querySelector cannot reach the nested target at all
//     (the negative control that makes the positive assertions meaningful).
//
// No new dependency: Chrome is already the repo's evidence tool, and this runs
// through evidence/cdp.mjs and the exported replay path.
//
// Run directly: node tests/flow-shadow-browser.mjs
// It is also imported by tests/regression.mjs so the full gate covers it.
import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Two levels of open shadow root. #nestedBtn is only reachable by piercing;
// #dup exists BOTH in the light DOM and inside the nested shadow root, so the
// resolver's light-DOM-first order is observable (the light one must fire).
const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>pierce shadow</title>
<button id="dup" type="button">LightDup</button>
<div id="outerHost"></div>
<script>
  window.__clicks = [];
  document.getElementById('dup').addEventListener('click', () => window.__clicks.push('light-duplicate'));

  const outer = document.getElementById('outerHost').attachShadow({ mode: 'open' });
  const innerHost = document.createElement('div');
  innerHost.id = 'innerHost';
  outer.appendChild(innerHost);
  const inner = innerHost.attachShadow({ mode: 'open' });

  const nestedBtn = document.createElement('button');
  nestedBtn.id = 'nestedBtn';
  nestedBtn.type = 'button'; // a bare <button> is type=submit, which the dry-run gate blocks
  nestedBtn.textContent = 'Details';
  nestedBtn.addEventListener('click', () => window.__clicks.push('nested'));
  inner.appendChild(nestedBtn);

  const dupBtn = document.createElement('button');
  dupBtn.id = 'dup';
  dupBtn.type = 'button';
  dupBtn.textContent = 'ShadowDup';
  dupBtn.addEventListener('click', () => window.__clicks.push('shadow-duplicate'));
  inner.appendChild(dupBtn);
</script>`;

export async function testFlowPierceShadowRootBrowser() {
  const { launchChrome, newSession, navigate, evaluate } = await import('../evidence/cdp.mjs');
  const { replayFlow, resolveSelectorCandidate } = await import('../runner/flow.mjs');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ready);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const log = () => {};

  const chrome = await launchChrome({ log });
  try {
    const session = await newSession(chrome.port, { log });
    try {
      const client = session.client;
      await navigate(client, url, { settleMs: 300, log });

      // 0. The fixture must really be what the test claims, or every assertion
      // below is vacuous: two nested OPEN shadow roots, and the target
      // invisible to a document-level selector.
      const shape = await evaluate(client, `(() => {
        const outer = document.getElementById('outerHost').shadowRoot;
        const innerHost = outer && outer.querySelector('#innerHost');
        const inner = innerHost && innerHost.shadowRoot;
        const lightDup = document.querySelector('#dup');
        return {
          outerOpen: !!outer,
          innerOpen: !!inner,
          nestingDepth: outer && inner ? 2 : (outer ? 1 : 0),
          lightNestedReachable: !!document.querySelector('#nestedBtn'),
          nestedText: inner && inner.querySelector('#nestedBtn') ? inner.querySelector('#nestedBtn').textContent : null,
          lightDupText: lightDup ? lightDup.textContent : null,
          lightDupInShadow: !!(inner && inner.querySelector('#dup')),
        };
      })()`);
      assert(shape.nestingDepth === 2, `the fixture must nest two open shadow roots (got ${JSON.stringify(shape)})`);
      assert(shape.lightNestedReachable === false,
        `#nestedBtn must be invisible to document.querySelector, else this test proves nothing (${JSON.stringify(shape)})`);
      assert(shape.nestedText === 'Details', `#nestedBtn must exist inside the nested root (${JSON.stringify(shape)})`);
      assert(shape.lightDupText === 'LightDup' && shape.lightDupInShadow === true,
        `#dup must exist in BOTH the light DOM and the nested shadow root (${JSON.stringify(shape)})`);

      // 1. The resolver itself, serialized into the page exactly as replayFlow
      // does, resolving a target two shadow roots deep.
      const resolved = await evaluate(client, `(() => {
        const resolve = ${resolveSelectorCandidate.toString()};
        const el = resolve('pierce/#nestedBtn', document);
        if (!el) return { found: false };
        const root = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
        return { found: true, id: el.id, text: el.textContent, inShadow: !!root && root !== document };
      })()`);
      assert(resolved.found === true && resolved.id === 'nestedBtn',
        `pierce/ must resolve the target inside a NESTED open shadow root (${JSON.stringify(resolved)})`);
      assert(resolved.inShadow === true,
        `the resolved node must genuinely live in a shadow root, not the light one (${JSON.stringify(resolved)})`);

      // 2. The path users actually run: replayFlow's click step, whose
      // pageAction expression is built from the same serialized resolver.
      const nestedFlow = { title: 'nested pierce', steps: [
        { type: 'navigate', url },
        { type: 'click', selectors: [['pierce/#nestedBtn']] },
      ] };
      const nestedRes = await replayFlow(client, nestedFlow, { startUrl: url, settleMs: 50, log });
      assert(nestedRes.steps[1].ok === true,
        `a pierce/ click on a nested shadow button must succeed (${JSON.stringify(nestedRes.steps[1])})`);
      assert(!nestedRes.steps[1].mutationBlocked,
        `a type=button "Details" control is not mutating and must not be dry-run blocked (${JSON.stringify(nestedRes.steps[1])})`);
      const clicks = await evaluate(client, 'window.__clicks.slice()');
      assert(Array.isArray(clicks) && clicks.length === 1 && clicks[0] === 'nested',
        `the click must be delivered to the nested shadow button, saw ${JSON.stringify(clicks)}`);

      // 3. Light-DOM precedence: a CSS selector that already resolves in the
      // light DOM must win before the shadow walk, so pierce/ can never hijack
      // a normal selector. #dup exists in both places; the light one must fire.
      const dupFlow = { title: 'dup precedence', steps: [{ type: 'click', selectors: [['pierce/#dup']] }] };
      const dupRes = await replayFlow(client, dupFlow, { startUrl: url, settleMs: 50, log });
      assert(dupRes.steps[0].ok === true, `the pierce/ #dup click must succeed (${JSON.stringify(dupRes.steps[0])})`);
      const afterDup = await evaluate(client, 'window.__clicks.slice()');
      assert(afterDup.length === 2 && afterDup[1] === 'light-duplicate',
        `a light-DOM match must win before the shadow walk, saw ${JSON.stringify(afterDup)}`);
    } finally {
      await session.close();
    }
  } finally {
    await chrome.close();
    await new Promise((done) => server.close(done));
  }
}

// Run directly (node tests/flow-shadow-browser.mjs), not when imported by the
// regression suite, which calls the exported function itself.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await testFlowPierceShadowRootBrowser();
  console.log('tests OK');
}
