// fb6 acceptance probe (web-uplift-mw-invoker). CSS-only change, so the acceptance is
// VISUAL plus computed-style: the sticky topbar must look flat at the top and gain the
// stuck cue (shadow + accented border) once it is stuck, with no layout shift.
// Raw CDP via evidence/cdp.mjs. No Playwright/Puppeteer.
import { launchChrome, newSession, navigate, evaluate, sleep } from '/home/exedev/worktrees/web-uplift-mw-invoker/evidence/cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL_ = 'file:///tmp/fb6-scorecard.html';
const OUT = '/tmp/fb6-evidence';
mkdirSync(OUT, { recursive: true });
const log = (m) => console.log(m);
const results = { url: URL_, checks: {} };
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS: ${name}`); } else { failed++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
  results.checks[name] = { pass: !!cond, detail: cond ? undefined : detail };
}

const styles = (client) => evaluate(client, `(() => {
  const bar = document.querySelector('.topbar');
  const s = document.querySelector('.topbar-surface');
  const cs = getComputedStyle(s);
  const r = bar.getBoundingClientRect();
  const sr = s.getBoundingClientRect();
  return { scrollY: Math.round(window.scrollY), barTop: Math.round(r.top), barH: Math.round(r.height),
           surfaceH: Math.round(sr.height), shadow: cs.boxShadow, border: cs.borderBottomColor,
           containerType: getComputedStyle(bar).containerType, containerName: getComputedStyle(bar).containerName };
})()`);

async function shot(session, name) {
  const { data } = await session.client.Page.captureScreenshot({ format: 'png', captureBeyondViewport: false });
  writeFileSync(`${OUT}/${name}`, Buffer.from(data, 'base64'));
  console.log(`[shot] ${OUT}/${name} (${(data.length / 1024).toFixed(0)} KB)`);
}

const chrome = await launchChrome({ log });
try {
  const session = await newSession(chrome.port, { log });
  const { client } = session;
  await navigate(client, URL_, { log, settleMs: 900 });

  // 1) at the top: not stuck, no cue
  const top = await styles(client);
  console.log(`[at-top] ${JSON.stringify(top)}`);
  await shot(session, 'fb6-at-top.png');
  check('the topbar is a named scroll-state container', top.containerType.includes('scroll-state') && top.containerName === 'topbar', top);
  check('at the top the bar is not stuck (barTop=0 but page not scrolled)', top.scrollY === 0, top);
  check('at the top there is NO stuck cue (shadow none)', top.shadow === 'none' || top.shadow === 'none none', top);

  // 2) scroll down: stuck, cue appears, no layout shift
  await evaluate(client, `window.scrollTo(0, 900); true`);
  await sleep(700);
  const stuck = await styles(client);
  console.log(`[stuck] ${JSON.stringify(stuck)}`);
  await shot(session, 'fb6-stuck.png');
  check('after scrolling the page really moved', stuck.scrollY > 500, stuck);
  check('the bar is stuck to the top (barTop === 0)', stuck.barTop === 0, stuck);
  check('stuck: the bar gains a shadow', stuck.shadow !== 'none' && stuck.shadow !== 'none none', stuck);
  check('stuck: the bottom border accents (colour changes)', stuck.border !== top.border, { stuck: stuck.border, top: top.border });
  check('no layout shift: the bar height is identical stuck vs not stuck', stuck.barH === top.barH, { stuck: stuck.barH, top: top.barH });

  // 3) no scroll-state support emulation: neutralise container-type so the query cannot
  //    match, which is effectively what a browser without scroll-state queries gets.
  await evaluate(client, `(() => { const st = document.createElement('style'); st.textContent = '.topbar{container-type:normal !important}'; document.head.append(st); return true; })()`);
  await sleep(400);
  const unsupported = await styles(client);
  console.log(`[no-container] ${JSON.stringify(unsupported)}`);
  check('fallback: with the query container neutralised the bar is flat (no cue) while still sticky',
    (unsupported.shadow === 'none' || unsupported.shadow === 'none none') && unsupported.barTop === 0, unsupported);
  await shot(session, 'fb6-no-scroll-state.png');

  writeFileSync(`${OUT}/result.json`, JSON.stringify({ ...results, passed, failed }, null, 2));
  await session.close();
} finally {
  await chrome.close();
}
console.log(`\nPROBE TALLY: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
