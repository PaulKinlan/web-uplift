// yh6 acceptance probe (web-uplift-mw-invoker). The defect is a RENDERED-size
// problem, not a nominal one: the history chart is an SVG with viewBox 0 0 640 180 and
// width:100%, so a CSS font-size in user units is scaled by the rendered chart width.
// So this measures the RENDERED pixel height of an axis label at a wide viewport and a
// narrow one, before (10px, the shipped rule) and after (12px plus the min-width floor),
// and checks the labels cannot collide with the plot area.
// Raw CDP via evidence/cdp.mjs; no Playwright/Puppeteer.
import { launchChrome, newSession, navigate, evaluate, sleep } from '../../evidence/cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const FIXTURES = {
  before: 'file:///tmp/yh6-before.html',
  after: 'file:///tmp/yh6-after.html',
};
const VIEWPORTS = [
  { label: 'wide', width: 1280, height: 900 },
  { label: 'narrow', width: 400, height: 900 },
];
const FLOOR_PX = 12; // the bead's ask; every other scorecard text size is >= 0.7rem (~11.2px)
const OUT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
mkdirSync(OUT, { recursive: true });
const log = (m) => console.log(m);
const results = { floorPx: FLOOR_PX, measurements: [], checks: {} };
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS: ${name}`); } else { failed++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
  results.checks[name] = { pass: !!cond, detail: cond ? undefined : detail };
}

async function shot(session, name) {
  const { data } = await session.client.Page.captureScreenshot({ format: 'png', captureBeyondViewport: false });
  writeFileSync(`${OUT}/${name}`, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  console.log(`[shot] ${OUT}/${name} (${(data.length / 1024).toFixed(0)} KB)`);
}

// Measures the WIDEST axis label (the "100" tick) in RENDERED CSS pixels.
const measure = (client) => evaluate(client, `(() => {
  const labels = [...document.querySelectorAll('.history text.axis')];
  if (!labels.length) return { error: 'no axis labels found' };
  const widest = labels.reduce((a, b) => (a.getBoundingClientRect().width >= b.getBoundingClientRect().width ? a : b));
  const r = widest.getBoundingClientRect();
  const grid = document.querySelector('.history line.grid')?.getBoundingClientRect() ?? null;
  const svg = document.querySelector('svg.history')?.getBoundingClientRect() ?? null;
  const holder = document.querySelector('svg.history')?.parentElement ?? null;
  return {
    text: widest.textContent.trim(),
    renderedHeight: Math.round(r.height * 100) / 100,
    renderedWidth: Math.round(r.width * 100) / 100,
    fontSizeComputed: getComputedStyle(widest).fontSize,
    labelRight: Math.round(r.right * 100) / 100,
    plotLeft: grid ? Math.round(grid.left * 100) / 100 : null,
    svgWidth: svg ? Math.round(svg.width) : null,
    holderScrollWidth: holder ? holder.scrollWidth : null,
    holderClientWidth: holder ? holder.clientWidth : null,
    viewportWidth: window.innerWidth,
  };
})()`);

const chrome = await launchChrome({ log });
try {
  const session = await newSession(chrome.port, { log });
  const { client } = session;
  for (const [state, url] of Object.entries(FIXTURES)) {
    for (const vp of VIEWPORTS) {
      await client.Emulation.setDeviceMetricsOverride({ width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false });
      await navigate(client, url, { log, settleMs: 500 });
      // The history chart lives in its own tab panel (.panel{display:none} unless
      // .active), so without activating the tab every rect measures zero and the
      // checks would pass or fail while measuring nothing.
      const tabbed = await evaluate(client, `(() => { const t = document.querySelector('.tab[data-tab="history"]'); if (t) t.click(); return !!t; })()`);
      await sleep(250);
      const m = await measure(client);
      check(`${state}/${vp.label}: the chart is actually laid out (non-zero geometry)`, m.svgWidth > 0 && m.renderedHeight > 0, { ...m, tabbed });
      const row = { state, viewport: vp.label, vpWidth: vp.width, ...m };
      results.measurements.push(row);
      console.log(`[measure] ${state}/${vp.label}: ${JSON.stringify(m)}`);
      if (state === 'after') {
        // The chart sits in a tab panel far down a narrow page, so a viewport capture
        // without scrolling produced an EMPTY picture once (the numbers were right, the
        // evidence showed nothing). Scroll it in and ASSERT it is on screen first.
        const onScreen = await evaluate(client, `(() => {
          const el = document.querySelector('svg.history');
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, visible: r.bottom > 0 && r.top < window.innerHeight };
        })()`);
        check(`${vp.label}: the chart is inside the viewport at capture time, so the picture is not empty`, !!onScreen?.visible, onScreen);
        await sleep(150);
        await shot(session, `yh6-${vp.label}-after.png`);
      }
      if (state === 'after') {
        check(`${vp.label}: the widest axis label renders at least ${FLOOR_PX}px high (measured, not nominal)`, m.renderedHeight >= FLOOR_PX, m);
        check(`${vp.label}: the label does not overlap the plot area`, m.plotLeft == null || m.labelRight <= m.plotLeft, m);
      }
    }
  }
  // The narrow case must stay legible by NOT shrinking below the chart's natural width,
  // which means the holder scrolls horizontally instead.
  const narrowBefore = results.measurements.find((m) => m.state === 'before' && m.viewport === 'narrow');
  const narrowAfter = results.measurements.find((m) => m.state === 'after' && m.viewport === 'narrow');
  console.log(`[narrow before] height=${narrowBefore?.renderedHeight}px  [narrow after] height=${narrowAfter?.renderedHeight}px`);
  check('the narrow case improved over the shipped 10px rule', (narrowAfter?.renderedHeight ?? 0) > (narrowBefore?.renderedHeight ?? 0), { before: narrowBefore, after: narrowAfter });
  check('narrow: the chart no longer shrinks below its natural width (holder scrolls instead)',
    narrowAfter?.holderScrollWidth != null && narrowAfter.holderClientWidth != null && narrowAfter.holderScrollWidth > narrowAfter.holderClientWidth, narrowAfter);

  writeFileSync(`${OUT}/result.json`, JSON.stringify({ ...results, passed, failed }, null, 2));
  await session.close();
} finally {
  await chrome.close();
}
console.log(`\nPROBE TALLY: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
