// User-flow record + replay: audit a real JOURNEY (checkout, signup, search),
// not just a landing page, for MPA and SPA sites.
//
//   web-uplift flow record <url> [--out flow.json] [--capture-hidden] [--capture-sensitive]   capture a journey (we drive)
//   web-uplift flow replay <flow.json> [--url <start>] [--out <dir>] [--allow-mutations]   replay + shots
//
// The flow format IS Chrome DevTools' Recorder JSON ({ title, steps: [...] }), so
// three inputs feed one replayer: (1) our own `flow record` (we inject a tiny
// recorder + overlay so the user never needs to know DevTools exists), (2) a
// Chrome DevTools Recorder export, (3) a hand-authored flow.json for CI. Replay
// drives the steps over raw CDP and captures a screenshot per step; the model
// (SKILL.md) then judges principles at each stop. No Playwright/Puppeteer.
//
// Replay safety gate (web-uplift-bwh):
// Mutating steps (submitting forms on Enter, clicking submit buttons or mutating
// controls) are protected by default in dry-run mode (mutationBlocked: true).
// Passing --allow-mutations is required to execute real form submissions against
// live targets.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, newSession, navigate, evaluate, sleep, recordLaunch } from '../evidence/cdp.mjs';

// --- format validation + normalisation ---------------------------------------

export function loadFlow(path) {
  const raw = readFileSync(path, 'utf8');
  return normalizeFlow(JSON.parse(raw));
}

export function normalizeFlow(flow) {
  if (!flow || typeof flow !== 'object' || !Array.isArray(flow.steps)) {
    throw new Error('Invalid flow.json: expected { title: string, steps: array }');
  }
  return {
    title: String(flow.title || 'User journey'),
    steps: flow.steps.filter((s) => s && typeof s === 'object' && s.type),
  };
}

// Resilient selector resolver: Chrome DevTools Recorder exports a matrix of
// selector alternatives per step: [ [ "aria/Search" ], [ "#q" ], [ "xpath//..." ] ].
// We try each in order and run the action against the first one that resolves.
async function pageAction(client, selectorList, actionJs) {
  const list = Array.isArray(selectorList) ? selectorList : [selectorList].filter(Boolean);
  const jsonList = JSON.stringify(list);
  const expr = `(() => {
    const list = ${jsonList};
    const resolve = (cand) => {
      const s = Array.isArray(cand) ? cand[0] : cand;
      if (!s || typeof s !== 'string') return null;
      if (s.startsWith('aria/')) {
        const name = s.slice(5).trim();
        const el = document.querySelector('[aria-label="' + CSS.escape(name) + '"]');
        if (el) return el;
        for (const cand of document.querySelectorAll('button, a, input, [role=button]')) {
          if ((cand.textContent || '').trim() === name) return cand;
        }
        return null;
      }
      if (s.startsWith('xpath/')) {
        try {
          const r = document.evaluate(s.slice(6), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          return r.singleNodeValue;
        } catch { return null; }
      }
      try { return document.querySelector(s); } catch { return null; }
    };
    let el = null;
    for (const cand of list) {
      el = resolve(cand);
      if (el) break;
    }
    if (!el) return { ok: false, detail: 'no selector resolved' };
    try {
      ${actionJs}
    } catch (e) {
      return { ok: false, detail: e.message || String(e) };
    }
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

export function isSubmitControl(el) {
  if (!el || (el.nodeType && el.nodeType !== 1)) return false;
  const target = (typeof el.closest === 'function' ? el.closest('button, input, [role="button"]') : null) || el;
  const tag = (target.tagName || '').toUpperCase();
  const type = (target.type || (typeof target.getAttribute === 'function' ? target.getAttribute('type') : '') || '').toLowerCase();

  if (type === 'submit' || type === 'image') return true;
  if (target.form || target.hasForm || (typeof target.closest === 'function' && target.closest('form')) || (typeof target.getAttribute === 'function' && target.getAttribute('form'))) {
    return true;
  }
  if (tag === 'BUTTON' || (typeof target.getAttribute === 'function' && target.getAttribute('role') === 'button')) {
    const text = (target.textContent || '').trim().toLowerCase();
    const aria = (typeof target.getAttribute === 'function' ? target.getAttribute('aria-label') : '') || '';
    const name = (target.name || target.id || '').toLowerCase();
    const MUTATING_TERMS = ['submit', 'save', 'delete', 'checkout', 'pay', 'order', 'confirm', 'send', 'buy', 'purchase', 'register', 'create'];
    if (MUTATING_TERMS.some((term) => text.includes(term) || aria.toLowerCase().includes(term) || name.includes(term))) {
      return true;
    }
  }
  return false;
}

// --- replay -----------------------------------------------------------------

export async function replayFlow(client, flow, { startUrl, outDir, log = () => {}, settleMs = 1200, allowMutations = false } = {}) {
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
          outcome = await pageAction(client, step.selectors, `
            const findMutatingControl = (node) => {
              if (!node || node.nodeType !== 1) return null;
              const target = (typeof node.closest === 'function' ? node.closest('button, input, [role="button"], a[onclick]') : null) || node;
              const tag = (target.tagName || '').toUpperCase();
              const type = (target.type || (typeof target.getAttribute === 'function' ? target.getAttribute('type') : '') || '').toLowerCase();

              if (type === 'submit' || type === 'image') return target;
              if (target.form || (typeof target.closest === 'function' && target.closest('form')) || (typeof target.getAttribute === 'function' && target.getAttribute('form'))) {
                return target;
              }
              if (tag === 'BUTTON' || (typeof target.getAttribute === 'function' && target.getAttribute('role') === 'button')) {
                const text = (target.textContent || '').trim().toLowerCase();
                const aria = (typeof target.getAttribute === 'function' ? target.getAttribute('aria-label') : '') || '';
                const name = (target.name || target.id || '').toLowerCase();
                const MUTATING_TERMS = ['submit', 'save', 'delete', 'checkout', 'pay', 'order', 'confirm', 'send', 'buy', 'purchase', 'register', 'create'];
                if (MUTATING_TERMS.some((term) => text.includes(term) || aria.toLowerCase().includes(term) || name.includes(term))) {
                  return target;
                }
              }
              return null;
            };

            const mutating = findMutatingControl(el);
            if (!${allowMutations ? 'true' : 'false'} && mutating) {
              const label = (mutating.tagName || '') + ' ' + (mutating.textContent || mutating.value || '').trim().slice(0, 40);
              return {
                ok: true,
                detail: 'dry-run: click on mutating control (' + label + ') prevented (use --allow-mutations)',
                mutationBlocked: true
              };
            }
            el.scrollIntoView({block:'center'});
            el.click();
            return { ok: true, detail: (el.tagName + ' ' + (el.textContent || '').trim().slice(0, 40)) };
          `);
          await sleep(settleMs);
          break;
        case 'change':
          // If the step was redacted (passwords, credentials, PII) and no real replacement
          // value was supplied in flow.json, SKIP setting an empty string so existing DOM values are never wiped.
          if (step.redacted && (!step.value || step.value === '')) {
            outcome = {
              ok: true,
              detail: 'skipped redacted sensitive field (no replacement value supplied in flow.json)',
              skipped: true
            };
            break;
          }
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
            outcome = await evaluate(client, `(() => {
              const el = document.activeElement;
              const f = el && (el.form || (typeof el.closest === 'function' && el.closest('form')));
              if (f && f.requestSubmit) {
                if (!${allowMutations ? 'true' : 'false'}) {
                  return { ok: true, detail: 'dry-run: form submission on Enter prevented (use --allow-mutations)', mutationBlocked: true };
                }
                f.requestSubmit();
                return { ok: true, detail: 'submitted form' };
              }
              if (el) {
                if (!${allowMutations ? 'true' : 'false'}) {
                  const tag = (el.tagName || '').toUpperCase();
                  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || (typeof el.getAttribute === 'function' && el.getAttribute('contenteditable'))) {
                    return { ok: true, detail: 'dry-run: Enter keydown on ' + tag.toLowerCase() + ' prevented (use --allow-mutations)', mutationBlocked: true };
                  }
                }
                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                return { ok: true, detail: 'Enter' };
              }
              return { ok: false, detail: 'no active element' };
            })()`);
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
    const rec = {
      index,
      type: step.type,
      ok: outcome.ok,
      detail: outcome.detail || '',
      mutationBlocked: !!outcome.mutationBlocked,
      skipped: !!outcome.skipped,
      screenshot: shot,
      url: await currentUrl(client)
    };
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

export function parseFlowArgs(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const VALUE_FLAGS = new Set(['--url', '--out', '--start-url']);
  const positional = [];
  const flags = new Set();
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (VALUE_FLAGS.has(arg)) {
      const key = arg.replace(/^--/, '');
      options[key] = rest[i + 1];
      i++;
    } else if (arg.startsWith('--')) {
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }
  return { sub, positional, flags, options };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

async function main() {
  const { sub, positional, flags, options } = parseFlowArgs(process.argv.slice(2));

  if (sub === 'replay') {
    const flowPath = positional[0];
    if (!flowPath) throw new Error('Usage: web-uplift flow replay <flow.json> [--url <startUrl>] [--out <dir>] [--allow-mutations]');
    const flow = loadFlow(flowPath);
    const startUrl = options.url || options['start-url'];
    const outDir = options.out || `reports/flow-${Date.now()}/evidence`;
    const allowMutations = flags.has('--allow-mutations');
    const log = (m) => console.error(m);
    const chrome = await launchChrome({ log });
    // Operator-present launch, attributed like every agent-run primitive
    // (web-uplift-6x7): env-unset is a no-op.
    recordLaunch({ primitive: 'flow-replay', url: startUrl ?? null, chrome });
    try {
      const session = await newSession(chrome.port, { log });
      try {
        const res = await replayFlow(session.client, flow, { startUrl, outDir, log, allowMutations });
        const summaryPath = join(outDir, '..', 'flow-result.json');
        writeFileSync(summaryPath, JSON.stringify(res, null, 2) + '\n');
        const failed = res.steps.filter((s) => !s.ok).length;
        const blocked = res.steps.filter((s) => s.mutationBlocked).length;
        console.error(`[flow] replayed ${res.steps.length} step(s), ${failed} failed${blocked > 0 ? ', ' + blocked + ' mutating step(s) blocked (dry-run)' : ''}; screenshots + flow-result.json in ${join(outDir, '..')}`);
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      } finally {
        await session.close();
      }
    } finally {
      await chrome.close();
    }
  } else if (sub === 'record') {
    const url = positional[0];
    if (!url) throw new Error('Usage: web-uplift flow record <url> [--out <flow.json>] [--capture-hidden] [--capture-sensitive]');
    const outPath = options.out || `flow-${Date.now()}.json`;
    const captureHidden = flags.has('--capture-hidden');
    const captureSensitive = flags.has('--capture-sensitive');
    const log = (m) => console.error(m);
    const { recordFlow } = await import('./flow-record.mjs');
    const chrome = await launchChrome({ log, headless: false });
    // Same attribution as the replay path (web-uplift-6x7).
    recordLaunch({ primitive: 'flow-record', url, chrome });
    try {
      const session = await newSession(chrome.port, { log });
      try {
        const flow = await recordFlow(session.client, url, { log, captureHidden, captureSensitive });
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
