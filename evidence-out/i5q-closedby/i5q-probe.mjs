// i5q review/acceptance probe (web-uplift-mw-invoker). Raw CDP, no Playwright/Puppeteer.
// Verifies the claimed behaviour at the built revision, on BOTH paths:
//   NATIVE:   closedby="any" on the dialog -> a backdrop click light-dismisses it,
//             with the page's JS fallback skipped (its gate predicate is true).
//   FALLBACK: HTMLDialogElement.prototype.closedBy deleted before page scripts, so the
//             gate is false and the imperative backdrop listener must dismiss instead.
// Also checks Esc dismissal (platform behaviour) on the native path.
import { launchChrome, newSession, navigate, evaluate, sleep } from '/home/exedev/worktrees/web-uplift-mw-invoker/evidence/cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL_ = 'file:///tmp/i5q-scorecard.html';
const OUT = '/tmp/i5q-evidence';
mkdirSync(OUT, { recursive: true });
const log = (m) => console.log(m);
const results = { url: URL_, sha: 'fleet/i5q @ 1647fa0 + closedby change', checks: {} };
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS: ${name}`); } else { failed++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
  results.checks[name] = { pass: !!cond, detail: cond ? undefined : detail };
}
const fail = (m) => { console.error('ABORT: ' + m); process.exit(3); };

async function realClick(client, x, y) {
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await sleep(250);
}

const state = (client) => evaluate(client, `(() => {
  const d = document.querySelector('dialog.finding-dialog[open]') || document.querySelector('dialog.finding-dialog');
  return { open: !!document.querySelector('dialog.finding-dialog[open]'), id: d ? d.id : null,
           attr: d ? d.getAttribute('closedby') : null,
           support: 'closedBy' in HTMLDialogElement.prototype,
           rect: d ? (r => ({ x: r.x, y: r.y, w: r.width, h: r.height }))(d.getBoundingClientRect()) : null };
})()`);

async function openDialog(client) {
  // Activate the findings tab and settle layout programmatically, then measure the
  // opener's rect in a SEPARATE evaluate so the coordinates are fresh.
  await evaluate(client, `(() => { const t = document.querySelector('.tab[data-tab="findings"]'); if (t) t.click(); return !!t; })()`);
  await sleep(350);
  const geom = await evaluate(client, `(() => {
    const b = document.querySelector('button.fitem[commandfor]');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    return { cx, cy, top: r.top, bottom: r.bottom, w: r.width, h: r.height, vh: innerHeight,
             inView: r.top >= 0 && r.bottom <= innerHeight, cmd: b.getAttribute('commandfor') };
  })()`);
  if (!geom) fail('no opener button');
  console.log(`[opener] ${JSON.stringify(geom)}`);
  await sleep(300);
  await realClick(client, geom.cx, geom.cy);
}

async function shot(session, name) {
  const { data } = await session.client.Page.captureScreenshot({ format: 'png', captureBeyondViewport: false });
  const p = `${OUT}/${name}`;
  writeFileSync(p, Buffer.from(data, 'base64'));
  console.log(`[shot] ${p} (${(data.length / 1024).toFixed(0)} KB)`);
}

async function runSession(label, stripClosedBy) {
  console.log(`\n=== ${label} ===`);
  const chrome = await launchChrome({ log });
  try {
    const session = await newSession(chrome.port, { log });
    const { client } = session;
    if (stripClosedBy) {
      await client.Page.addScriptToEvaluateOnNewDocument({ source: 'delete HTMLDialogElement.prototype.closedBy;' });
    }
    await navigate(client, URL_, { log, settleMs: 800 });

    const st0 = await state(client);
    console.log(`[state] support=${st0.support} attr=${st0.attr}`);
    check(`${label}: closedby="any" present on the dialog`, st0.attr === 'any', st0);
    check(`${label}: support predicate is ${stripClosedBy ? 'false (fallback armed)' : 'true (fallback skipped)'}`,
      st0.support === !stripClosedBy, { support: st0.support });

    // 1) backdrop click dismisses
    await openDialog(client);
    const st1 = await state(client);
    if (!st1.open) { console.log(`[abort-detail] ${JSON.stringify(st1)}`); fail(`${label}: opener did not open the dialog`); }
    await shot(session, `${label}-dialog-open.png`);
    // click well outside the dialog box: (12,12) is backdrop when the dialog is centred
    await realClick(client, 12, 12);
    const st2 = await state(client);
    console.log(`[backdrop] open=${st2.open}`);
    check(`${label}: a backdrop click light-dismisses the dialog`, st2.open === false, st2);

    // 2) Esc dismisses (platform behaviour; true on both paths)
    await openDialog(client);
    const st3 = await state(client);
    if (!st3.open) { console.log(`[abort-detail] ${JSON.stringify(st3)}`); fail(`${label}: second open failed`); }
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(300);
    const st4 = await state(client);
    console.log(`[escape] open=${st4.open}`);
    check(`${label}: Escape dismisses the dialog`, st4.open === false, st4);

    await session.close();
  } finally {
    await chrome.close();
  }
}

await runSession('native', false);
await runSession('fallback', true);
results.passed = passed; results.failed = failed;
writeFileSync(`${OUT}/result.json`, JSON.stringify(results, null, 2));
console.log(`\nPROBE TALLY: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
