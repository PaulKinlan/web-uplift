// User-flow record + replay: audit a real JOURNEY (checkout, signup, search),
// not just a landing page, for MPA and SPA sites.
//
//   web-uplift flow record <url> [--out flow.json]   capture a journey (we drive)
//   web-uplift flow replay <flow.json> [--url <start>] [--out <dir>]   replay + shots
//
// The flow format IS Chrome DevTools' Recorder JSON ({ title, steps: [...] }), so
// three inputs feed one replayer: (1) our own `flow record` (we inject a tiny
// recorder + overlay so the user never needs to know DevTools exists), (2) a
// Chrome DevTools Recorder export, (3) a hand-authored flow.json for CI. Replay
// drives the steps over raw CDP and captures a screenshot per step; the model
// (SKILL.md) then judges principles at each stop. No Playwright/Puppeteer.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, newSession, navigate, evaluate, sleep } from '../evidence/cdp.mjs';

// --- flow loading / normalisation -------------------------------------------

export function normalizeFlow(raw) {
  const flow = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!flow || !Array.isArray(flow.steps)) {
    throw new Error('Not a valid flow: expected an object with a `steps` array (Chrome DevTools Recorder JSON or a web-uplift flow.json).');
  }
  const steps = flow.steps.filter((s) => s && s.type);
  return { title: flow.title || 'Untitled flow', steps };
}

export function loadFlow(path) {
  return normalizeFlow(readFileSync(path, 'utf8'));
}

// Page-side element resolver, shared by replay. Chrome Recorder `selectors` is an
// array of alternatives (each usually a one-string array). We try each until one
// resolves, supporting aria/, xpath/, text/, pierce/ and plain CSS - the syntaxes
// the Recorder emits.
const RESOLVER_JS = `
function __wuResolve(alts){
  const one=(sel)=>{
    if(!sel) return null;
    try{
      if(sel.startsWith('aria/')){
        const name=sel.slice(5).trim();
        const els=[...document.querySelectorAll('button,a,[role],input,textarea,select,[aria-label],summary,label')];
        return els.find(e=>((e.getAttribute('aria-label')||e.textContent||e.value||'').trim())===name)||null;
      }
      if(sel.startsWith('xpath/')){
        const xp=sel.replace(/^xpath\\/+/,'/');
        const r=document.evaluate(xp,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null);
        return r.singleNodeValue;
      }
      if(sel.startsWith('text/')){
        const t=sel.slice(5).trim();
        const els=[...document.querySelectorAll('*')];
        return els.find(e=>e.childElementCount===0 && (e.textContent||'').trim()===t)||null;
      }
      if(sel.startsWith('pierce/')) sel=sel.slice(7);
      return document.querySelector(sel);
    }catch(e){ return null; }
  };
  for(const group of (alts||[])){
    const sel=Array.isArray(group)?group[0]:group;
    const el=one(sel);
    if(el) return el;
  }
  return null;
}`;

// Run a resolver-based action in the page. Returns { ok, detail }.
async function pageAction(client, selectors, body) {
  const expr = `(() => {
    ${RESOLVER_JS}
    const el = __wuResolve(${JSON.stringify(selectors ?? [])});
    if(!el) return { ok:false, detail:'no element matched the selectors' };
    ${body}
  })()`;
  return evaluate(client, expr);
}

async function screenshot(client, outDir, index, label, log) {
  try {
    const { data } = await client.Page.captureScreenshot({ format: 'png' });
    const name = `step-${String(index).padStart(2, '0')}-${label}.png`;
    const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    writeFileSync(join(outDir, name), bin);
    return `evidence/${name}`;
  } catch (e) {
    log(`[flow] screenshot failed at step ${index}: ${e.message}`);
    return null;
  }
}

// --- replay -----------------------------------------------------------------

export async function replayFlow(client, flow, { startUrl, outDir, log = () => {}, settleMs = 1200 } = {}) {
  if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const results = [];
  let index = 0;
  for (const step of flow.steps) {
    index++;
    const label = (step.type || 'step').toLowerCase();
    let outcome = { ok: true };
    try {
      switch (step.type) {
        case 'setViewport':
          await client.Emulation.setDeviceMetricsOverride({
            width: step.width || 1280, height: step.height || 800,
            deviceScaleFactor: step.deviceScaleFactor || 1, mobile: !!step.isMobile,
          });
          break;
        case 'navigate':
          await navigate(client, step.url || startUrl, { settleMs, log });
          break;
        case 'click':
        case 'doubleClick':
          outcome = await pageAction(client, step.selectors, `el.scrollIntoView({block:'center'}); el.click(); return { ok:true, detail: (el.tagName+' '+(el.textContent||'').trim().slice(0,40)) };`);
          await sleep(settleMs);
          break;
        case 'change':
          outcome = await pageAction(client, step.selectors, `
            const v=${JSON.stringify(step.value ?? '')};
            el.focus();
            if('value' in el){ el.value=v; }
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new Event('change',{bubbles:true}));
            return { ok:true, detail:'typed '+JSON.stringify(v) };`);
          break;
        case 'keyDown':
          if ((step.key || '').toLowerCase() === 'enter') {
            outcome = await evaluate(client, `(() => { const el=document.activeElement; const f=el&&el.form; if(f&&f.requestSubmit){f.requestSubmit();return {ok:true,detail:'submitted form'};} if(el){el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return {ok:true,detail:'Enter'};} return {ok:false,detail:'no active element'}; })()`);
            await sleep(settleMs);
          } else {
            outcome = { ok: true, detail: `keyDown ${step.key} (skipped)` };
          }
          break;
        case 'keyUp':
        case 'scroll':
          outcome = { ok: true, detail: `${step.type} (no-op)` };
          break;
        case 'waitForElement':
          outcome = { ok: false, detail: 'element did not appear' };
          for (let t = 0; t < 20; t++) {
            const r = await pageAction(client, step.selectors, `return { ok:true };`);
            if (r.ok) { outcome = { ok: true, detail: 'appeared' }; break; }
            await sleep(250);
          }
          break;
        default:
          outcome = { ok: true, detail: `unsupported step type "${step.type}" (skipped)` };
      }
    } catch (e) {
      outcome = { ok: false, detail: e.message };
    }
    const shot = outDir ? await screenshot(client, outDir, index, label, log) : null;
    const rec = { index, type: step.type, ok: outcome.ok, detail: outcome.detail || '', screenshot: shot, url: await currentUrl(client) };
    results.push(rec);
    log(`[flow] step ${index} ${step.type}: ${outcome.ok ? 'ok' : 'FAILED'}${outcome.detail ? ' - ' + outcome.detail : ''}`);
  }
  return { title: flow.title, steps: results };
}

async function currentUrl(client) {
  try {
    return await evaluate(client, 'location.href');
  } catch {
    return null;
  }
}

// --- CLI --------------------------------------------------------------------

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

  if (sub === 'replay') {
    const flowPath = positional[0];
    if (!flowPath) throw new Error('Usage: web-uplift flow replay <flow.json> [--url <startUrl>] [--out <dir>]');
    const flow = loadFlow(flowPath);
    const startUrl = opt('url');
    const outDir = opt('out') || `reports/flow-${Date.now()}/evidence`;
    const log = (m) => console.error(m);
    const chrome = await launchChrome({ log });
    try {
      const session = await newSession(chrome.port, { log });
      try {
        const res = await replayFlow(session.client, flow, { startUrl, outDir, log });
        const summaryPath = join(outDir, '..', 'flow-result.json');
        writeFileSync(summaryPath, JSON.stringify(res, null, 2) + '\n');
        const failed = res.steps.filter((s) => !s.ok).length;
        console.error(`[flow] replayed ${res.steps.length} step(s), ${failed} failed; screenshots + flow-result.json in ${join(outDir, '..')}`);
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      } finally {
        await session.close();
      }
    } finally {
      await chrome.close();
    }
  } else if (sub === 'record') {
    const url = positional[0];
    if (!url) throw new Error('Usage: web-uplift flow record <url> [--out <flow.json>]');
    const outPath = opt('out') || `flow-${Date.now()}.json`;
    const log = (m) => console.error(m);
    const { recordFlow } = await import('./flow-record.mjs');
    const chrome = await launchChrome({ log, headless: false });
    try {
      const session = await newSession(chrome.port, { log });
      try {
        const flow = await recordFlow(session.client, url, { log });
        writeFileSync(outPath, JSON.stringify(flow, null, 2) + '\n');
        console.error(`[flow] recorded ${flow.steps.length} step(s) -> ${outPath}`);
      } finally {
        await session.close();
      }
    } finally {
      await chrome.close();
    }
  } else {
    throw new Error('Usage: web-uplift flow <record|replay> ...');
  }
}
