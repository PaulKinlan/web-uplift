// The zero-knowledge flow recorder. `web-uplift flow record <url>` opens a headed
// browser and WE inject a tiny recorder + an on-page overlay, so the user just
// clicks through their journey and presses Done - they never need to know Chrome
// DevTools' Recorder panel exists. Output is Chrome-Recorder-compatible flow.json,
// so it replays through the same runner/flow.mjs replayer.
//
// Mechanics (raw CDP, no Playwright): a capture script is injected on every new
// document (so it survives MPA navigations and SPA route changes); it records
// clicks and input changes with resilient selectors (data-testid / aria / role+
// text before a CSS path) and reports each step to Node through a CDP binding.
// Main-frame navigations are captured from Page.frameNavigated.

// The page-side capture script. Kept as a string so it can be injected via
// Page.addScriptToEvaluateOnNewDocument (runs before page scripts, every load).
const CAPTURE_JS = `
(() => {
  if (window.__wuRec) return;
  window.__wuRec = true;
  const send = (step) => { try { window.__wuRecordStep(JSON.stringify(step)); } catch (e) {} };

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let sel = node.tagName.toLowerCase();
      const p = node.parentElement;
      if (p) {
        const sibs = [...p.children].filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      if (node.id) { parts[0] = '#' + CSS.escape(node.id); break; }
      node = p;
    }
    return parts.join(' > ');
  };

  const selectorsFor = (el) => {
    const alts = [];
    if (el.id) alts.push(['#' + CSS.escape(el.id)]);
    const tid = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (tid) alts.push(['[data-testid="' + tid + '"]']);
    const aria = el.getAttribute('aria-label');
    if (aria) alts.push(['aria/' + aria]);
    const txt = (el.textContent || '').trim();
    if (txt && txt.length <= 40 && ['A', 'BUTTON', 'SUMMARY', 'LABEL'].includes(el.tagName)) alts.push(['aria/' + txt]);
    alts.push([cssPath(el)]);
    return alts;
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('a,button,[role=button],input[type=submit],input[type=button],summary,[onclick]') || e.target;
    if (el && el.id === '__wu_done') return; // the Done control itself
    send({ type: 'click', selectors: selectorsFor(el), target: 'main' });
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !('value' in el)) return;
    const val = el.type === 'password' ? '' : el.value; // never record passwords
    send({ type: 'change', selectors: selectorsFor(el), value: val, target: 'main' });
  }, true);

  // Overlay: a small always-on-top banner with a Done button.
  const mount = () => {
    if (document.getElementById('__wu_bar')) return;
    const bar = document.createElement('div');
    bar.id = '__wu_bar';
    bar.setAttribute('style', 'position:fixed;z-index:2147483647;top:12px;right:12px;background:#171b21;color:#e6e9ee;font:14px system-ui;border:1px solid #5b8def;border-radius:10px;padding:10px 12px;box-shadow:0 6px 20px rgba(0,0,0,.4);display:flex;gap:10px;align-items:center');
    bar.innerHTML = '<span style="color:#f04438">\\u25CF</span> Recording your journey' +
      '<button id="__wu_done" style="background:#5b8def;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit">Done</button>';
    document.documentElement.appendChild(bar);
    document.getElementById('__wu_done').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      send({ type: '__done' });
    }, true);
  };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
`;

export async function recordFlow(client, url, { log = () => {} } = {}) {
  const steps = [{ type: 'setViewport', width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false }];
  let lastNav = null;
  let done;
  const finished = new Promise((r) => { done = r; });

  // Receive steps from the page over the CDP binding.
  await client.Runtime.addBinding({ name: '__wuRecordStep' });
  client.Runtime.bindingCalled(({ name, payload }) => {
    if (name !== '__wuRecordStep') return;
    let step;
    try { step = JSON.parse(payload); } catch { return; }
    if (step.type === '__done') { done(); return; }
    steps.push(step);
    log(`[flow-record] captured ${step.type}${step.value != null ? ' = ' + JSON.stringify(step.value) : ''}`);
  });

  // Capture main-frame navigations (dedupe consecutive identical urls).
  client.Page.frameNavigated(({ frame }) => {
    if (frame.parentId) return; // main frame only
    if (frame.url && frame.url !== lastNav && !frame.url.startsWith('about:')) {
      lastNav = frame.url;
      steps.push({ type: 'navigate', url: frame.url });
      log(`[flow-record] navigate ${frame.url}`);
    }
  });

  await client.Page.addScriptToEvaluateOnNewDocument({ source: CAPTURE_JS });
  await client.Page.navigate({ url });
  log('[flow-record] recording... interact with the page, then click Done.');

  await finished;
  return { title: `Recorded flow (${new URL(url).host})`, steps };
}
