// Browser verification probe for web-uplift-h6g (Invoker Commands scorecard openers).
// Drives the rendered scorecard in Chrome for Testing via raw CDP:
//   A) native path: button[commandfor][command=show-modal] opens the dialog with
//      no page JS involved (verified by clicking and by Enter key on the button);
//   B) fallback path: commandForElement deleted from the prototype before page
//      scripts run, so the guarded imperative fallback must open the dialog.
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchChrome, newSession, navigate, evaluate, sleep } from '/home/exedev/worktrees/web-uplift-mw-invoker/evidence/cdp.mjs';

const URL = 'file:///tmp/mw-invoker-scorecard.html';
const OUT = '/tmp/mw-invoker-evidence';
mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(m);
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

// Real trusted click via the CDP input pipeline (not el.click()).
async function realClick(session, selector) {
  const { client } = session;
  const box = await evaluate(client, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) fail('selector not found: ' + selector);
  await sleep(150);
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: box.x, y: box.y, button: 'none', pointerType: 'mouse' });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(250);
}

// Focus the opener and press Enter (native button semantics must fire click).
async function pressEnterOn(session, selector) {
  const { client } = session;
  await evaluate(client, `document.querySelector(${JSON.stringify(selector)}).focus()`);
  for (const { type, key, code, text } of [
    { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r' },
    { type: 'keyUp', key: 'Enter', code: 'Enter' },
  ]) {
    await client.Input.dispatchKeyEvent({ type, key, code, ...(text ? { text } : {}) });
  }
  await sleep(250);
}

async function shot(session, name) {
  const { data } = await session.client.Page.captureScreenshot({ format: 'png', captureBeyondViewport: false });
  const p = `${OUT}/${name}`;
  writeFileSync(p, Buffer.from(data, 'base64'));
  console.log(`[shot] ${p} (${(data.length / 1024).toFixed(0)} KB)`);
}

const dialogState = (session) => evaluate(session.client, `(() => {
  const btn = document.querySelector('button.fitem[commandfor]');
  const dlg = document.getElementById(btn.getAttribute('commandfor'));
  return { dialogId: dlg.id, open: dlg.open, modal: dlg.matches(':modal'),
           wiredTo: btn.commandForElement ? btn.commandForElement.id : null,
           support: 'commandForElement' in HTMLButtonElement.prototype };
})()`);

async function runSession(label, beforeLoad, expectSupport) {
  console.log(`\n=== ${label} ===`);
  const chrome = await launchChrome({ log });
  try {
    const session = await newSession(chrome.port, { log });
    const { client } = session;
    if (beforeLoad) await beforeLoad(client);
    await navigate(client, URL, { log, settleMs: 800 });
    await shot(session, `${label}-initial.png`);

    // The findings list lives behind the "findings" tab panel; activate it
    // through its real tab button so the openers are visible before clicking.
    await realClick(session, '.tab[data-tab="findings"]');
    const tabOk = await evaluate(client, `!!document.querySelector('#findings.panel.active')`);
    if (!tabOk) fail(label + ': findings tab did not activate');

    let st = await dialogState(session);
    console.log(`[state] support=${st.support} wiredTo=${st.wiredTo} open=${st.open}`);
    if (st.open) fail(label + ': dialog must start closed');
    if (st.support !== expectSupport) fail(`${label}: expected invoker support=${expectSupport}, got ${st.support}`);
    if (expectSupport && st.wiredTo !== st.dialogId) fail(label + ': commandForElement not wired to the dialog');

    // 1) Real mouse click opens the dialog.
    await realClick(session, 'button.fitem[commandfor]');
    st = await dialogState(session);
    console.log(`[click] open=${st.open} modal=${st.modal}`);
    if (!st.open || !st.modal) fail(label + ': real click did not open the dialog as modal');
    await shot(session, `${label}-dialog-open.png`);

    // 2) Close via the form method=dialog close button.
    await realClick(session, 'dialog[open] .dialog-head button.x');
    st = await dialogState(session);
    console.log(`[close] open=${st.open}`);
    if (st.open) fail(label + ': close button did not close the dialog');

    // 3) Keyboard: Enter on the focused opener must open it (native button
    //    semantics; no page keydown handler exists anymore).
    await pressEnterOn(session, 'button.fitem[commandfor]');
    st = await dialogState(session);
    console.log(`[enter] open=${st.open} modal=${st.modal}`);
    if (!st.open || !st.modal) fail(label + ': Enter key did not open the dialog');
    await shot(session, `${label}-dialog-open-enter.png`);

    await session.close();
  } finally {
    await chrome.close();
  }
  console.log(`${label}: PASS`);
}

// A) Native invoker-command path (Chrome for Testing 154 supports it).
await runSession('native', null, true);

// B) Fallback path: strip invoker support before any page script runs, so the
//    feature check attaches the imperative showModal() fallback.
await runSession('fallback', async (client) => {
  await client.Page.addScriptToEvaluateOnNewDocument({
    source: 'delete HTMLButtonElement.prototype.commandForElement;',
  });
}, false);

console.log('\nALL PASS');
