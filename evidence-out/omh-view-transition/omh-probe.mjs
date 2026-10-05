// omh acceptance probe (web-uplift-mw-invoker). The change is a view transition on
// the playground's hash-router swap, so the acceptance is browser-driven:
//   NATIVE:   a hash navigation requests a view transition, the transition actually
//             runs (pseudo-element animations exist), and the view swaps.
//   NO-SUPPORT: with document.startViewTransition deleted before page scripts, the
//             view still swaps with no error, which is the required fallback.
// Raw CDP via evidence/cdp.mjs; no Playwright/Puppeteer.
import { launchChrome, newSession, navigate, evaluate, sleep } from '../../evidence/cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL_ = 'http://127.0.0.1:8123/';
const OUT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
mkdirSync(OUT, { recursive: true });
const log = (m) => console.log(m);
const results = { url: URL_, checks: {} };
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS: ${name}`); } else { failed++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
  results.checks[name] = { pass: !!cond, detail: cond ? undefined : detail };
}

// Records every view-transition request and whether its callback ran.
const VT_RECORDER = `(() => {
  window.__vt = { calls: 0, callbacks: 0, threw: null, supported: typeof document.startViewTransition === 'function' };
  window.__errors = [];
  addEventListener('error', (e) => window.__errors.push(String(e.message)));
  if (document.startViewTransition) {
    const orig = document.startViewTransition.bind(document);
    document.startViewTransition = (cb) => {
      window.__vt.calls += 1;
      return orig(() => { window.__vt.callbacks += 1; return cb(); });
    };
  }
})();`;

async function shot(session, name) {
  const { data } = await session.client.Page.captureScreenshot({ format: 'png', captureBeyondViewport: false });
  writeFileSync(`${OUT}/${name}`, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  console.log(`[shot] ${OUT}/${name} (${(data.length / 1024).toFixed(0)} KB)`);
}

const viewState = (client) => evaluate(client, `(() => ({
  hash: location.hash,
  heading: document.querySelector('#view h2')?.textContent ?? null,
  vt: window.__vt ?? null,
  errors: window.__errors ?? [],
  animations: typeof document.getAnimations === 'function' ? document.getAnimations().length : null
}))()`);

async function clickNav(client) {
  const rect = await evaluate(client, `(() => {
    const links = [...document.querySelectorAll('#nav a')];
    // Pick a link that renders a DIFFERENT scenario than the one on screen: comparing
    // hrefs is not enough because the rendered default is scenarios[0] with an empty hash.
    const activeHref = document.querySelector('#nav a.active')?.getAttribute('href') ?? null;
    const target = links.find((a) => a.getAttribute('href') !== activeHref) ?? links[links.length - 1];
    const r = target.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, href: target.getAttribute('href'), activeHref };
  })()`);
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', pointerType: 'mouse' });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  return rect;
}

async function runSession(label, strip) {
  console.log(`\n=== ${label} ===`);
  const chrome = await launchChrome({ log });
  try {
    const session = await newSession(chrome.port, { log });
    const { client } = session;
    // ORDER MATTERS: the delete must be installed BEFORE the recorder, because the
    // recorder captures the availability flag when it runs.
    if (strip) {
      // startViewTransition lives on Document.prototype, so deleting the own property on
      // the document instance is a silent no-op and the session would silently re-measure
      // the native path. Delete the prototype member.
      await client.Page.addScriptToEvaluateOnNewDocument({ source: 'delete Document.prototype.startViewTransition; try { delete document.startViewTransition; } catch (e) {}' });
    }
    await client.Page.addScriptToEvaluateOnNewDocument({ source: VT_RECORDER });
    await navigate(client, URL_, { log, settleMs: 700 });
    await shot(session, `${label}-initial.png`);

    const before = await viewState(client);
    console.log(`[before] ${JSON.stringify(before)}`);
    check(`${label}: the initial view rendered`, typeof before.heading === 'string' && before.heading.length > 0, before);
    check(`${label}: API availability is ${strip ? 'false (fallback path)' : 'true (native path)'}`,
      before.vt?.supported === !strip, before.vt);

    const clicked = await clickNav(client);
    // Sample rapidly: a running view transition exposes pseudo-element animations, but
    // they start a frame or two after the click, so poll briefly and keep the maximum.
    let maxAnimations = 0;
    for (let i = 0; i < 20; i += 1) {
      const n = await evaluate(client, `document.getAnimations().length`);
      if (typeof n === 'number' && n > maxAnimations) maxAnimations = n;
      await sleep(15);
    }
    const during = { animations: maxAnimations, state: await viewState(client) };
    await shot(session, `${label}-right-after-click.png`);
    await sleep(700);
    const after = await viewState(client);
    console.log(`[after] hash=${after.hash} heading=${JSON.stringify(after.heading)} vt=${JSON.stringify(after.vt)} maxAnimations=${maxAnimations} errors=${JSON.stringify(after.errors)}`);

    check(`${label}: the hash actually changed on click`, clicked.href != null && after.hash === clicked.href, { clicked: clicked.href, hash: after.hash });
    check(`${label}: the view swapped (heading changed)`, after.heading !== before.heading, { before: before.heading, after: after.heading });
    check(`${label}: no uncaught errors on the page`, (after.errors ?? []).length === 0, after.errors);

    if (strip) {
      check('no-support: the swap happened WITHOUT any view-transition call', after.vt.calls === 0, after.vt);
    } else {
      check('native: the hash swap requested exactly one view transition', after.vt.calls === 1, after.vt);
      check('native: the transition callback ran (the swap happened inside the transition)', after.vt.callbacks === 1, after.vt);
      check('native: a transition genuinely ran (pseudo-element animations observed after the click)', maxAnimations > 0, during);
    }

    await session.close();
  } finally {
    await chrome.close();
  }
}

await runSession('native', false);
await runSession('no-support', true);
results.passed = passed; results.failed = failed;
writeFileSync(`${OUT}/result.json`, JSON.stringify(results, null, 2));
console.log(`\nPROBE TALLY: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
