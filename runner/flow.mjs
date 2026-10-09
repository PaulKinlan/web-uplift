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
  return normalizeFlow(raw);
}

export function normalizeFlow(flow) {
  // A JSON string is accepted (the original contract: loadFlow handed the raw file
  // contents straight here), so hand-authored callers can pass either shape.
  if (typeof flow === 'string') {
    try {
      flow = JSON.parse(flow);
    } catch {
      throw new Error('Invalid flow.json: expected { title: string, steps: array }');
    }
  }
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
// We try each in order and run the action against the first one that resolves, so
// a stale CSS or xpath alternative falls back to text//pierce/.
//
// resolveSelectorCandidate is exported AND self-contained (no closure references)
// because it is serialized with .toString() into the page expression: the
// regression suite drives the exact function the page runs, against a DOM stub.
export function resolveSelectorCandidate(s, doc) {
  if (!s || typeof s !== 'string') return null;
  if (s.startsWith('aria/')) {
    const name = s.slice(5).trim();
    // Exact attribute equality: no selector-string escaping, so a name containing
    // a double-quote cannot break the match (CSS.escape is identifier-context and
    // is the wrong tool inside a quoted attribute selector).
    for (const cand of doc.querySelectorAll('[aria-label]')) {
      if (cand.getAttribute('aria-label') === name) return cand;
    }
    for (const cand of doc.querySelectorAll('button, a, input, [role=button]')) {
      if ((cand.textContent || '').trim() === name) return cand;
    }
    return null;
  }
  if (s.startsWith('xpath/')) {
    try {
      const FIRST = typeof XPathResult !== 'undefined' ? XPathResult.FIRST_ORDERED_NODE_TYPE : 9;
      const r = doc.evaluate(s.slice(6), doc, null, FIRST, null);
      return r.singleNodeValue;
    } catch { return null; }
  }
  if (s.startsWith('text/')) {
    const t = s.slice(5).trim();
    for (const cand of doc.querySelectorAll('*')) {
      if (cand.childElementCount === 0 && (cand.textContent || '').trim() === t) return cand;
    }
    return null;
  }
  if (s.startsWith('pierce/')) {
    // Recorder's pierce/ selector crosses (open) shadow roots: match the inner
    // selector in the light DOM first, then walk every open shadowRoot
    // recursively until it resolves.
    const inner = s.slice(7);
    const walk = (root) => {
      let found = null;
      try { found = root.querySelector(inner); } catch { return null; }
      if (found) return found;
      let all = [];
      try { all = root.querySelectorAll('*'); } catch { return null; }
      for (const el of all) {
        if (el.shadowRoot) {
          const hit = walk(el.shadowRoot);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walk(doc);
  }
  try { return doc.querySelector(s); } catch { return null; }
}

async function pageAction(client, selectorList, actionJs) {
  const list = Array.isArray(selectorList) ? selectorList : [selectorList].filter(Boolean);
  const jsonList = JSON.stringify(list);
  const expr = `(() => {
    const list = ${jsonList};
    const __wuResolveOne = ${resolveSelectorCandidate.toString()};
    const resolve = (cand) => __wuResolveOne(Array.isArray(cand) ? cand[0] : cand, document);
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

// What a click would DO, decided before it happens (web-uplift-d31).
//
// The old gate was keyword-and-form based: it blocked a submit button, a form
// owner, or a label containing delete/pay/confirm, so a <button>Update Profile
// </button> outside a form, a <div role="menuitem" onclick="..."> or a "Post" /
// "Apply" / "Continue" SPA control was clicked for REAL in a dry run. The gate is
// now default-deny for every interactive control, with one allowlist: read-only
// navigation (an <a>/[role=link] with no inline handler and no javascript:/data:
// href) and client-side disclosure (summary, [role=tab]), plus controls that can
// only take focus (a text field click focuses it and writes nothing). A label that
// names a write is still REPORTED in the reason, but it is no longer what decides:
// substring matching on labels refused ordinary links ("Site Credits" contains
// "edit", "Our Address" contains "add"), so a label only ever DECIDES for a link
// whose text contains a destructive verb as a whole word.
//
// Exported and self-contained: serialized with .toString() into the click
// expression, so the suite drives the exact predicate the page runs.
export function classifyClickControl(node) {
  const DENY = (reason) => ({ gated: true, reason });
  const ALLOW = (reason) => ({ gated: false, reason });
  if (!node || (node.nodeType && node.nodeType !== 1)) return ALLOW('not an element');
  const at = (el, key) => (el && typeof el.getAttribute === 'function' ? el.getAttribute(key) : null);
  // CONTROL roles only. A bare `[role]` was wrong: closest('[role]') from a span inside
  // <main role="main"> lifts a CONTAINER, which would refuse ordinary clicks.
  const CONTROL_ROLES = ['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'link', 'checkbox', 'radio',
    'switch', 'option', 'combobox', 'listbox', 'slider', 'spinbutton', 'textbox', 'searchbox', 'treeitem', 'gridcell'];
  // `a` and `label` MUST be in this selector, not only in the link arm below: the
  // Recorder resolves a click to whatever node it matched, and a leaf node is the common
  // case. A <span>Delete</span> inside <a href="/account/delete"> made closest() return
  // null, the span fell through to "not an interactive control", and el.click() bubbled
  // to the link and navigated for real (review finding 1). label is here for the same
  // reason: a click on it is forwarded to the control it labels.
  const interactive = 'button, input, select, textarea, summary, a, label, [contenteditable], [onclick], [onmousedown], [ontouchstart], [onpointerdown]'
    + CONTROL_ROLES.map((r) => ', [role="' + r + '"]').join('');
  const control = (typeof node.closest === 'function' ? node.closest(interactive) : null) || node;
  const tag = String(control.tagName || '').toUpperCase();
  const type = String(control.type || at(control, 'type') || '').toLowerCase();
  const role = String(at(control, 'role') || control.role || '').toLowerCase();
  const href = String(at(control, 'href') || at(control, 'data-href') || '');
  const label = String((control.textContent || control.value || '') + ' ' + (at(control, 'aria-label') || '')).trim();
  const name = String(control.name || control.id || '');
  const inline = ['onclick', 'onmousedown', 'ontouchstart', 'onpointerdown'].some((key) => at(control, key) != null);
  // WHOLE WORDS, not substrings (review finding 2), and this list is REPORTING ONLY:
  // it decorates a refusal another arm already decided. It never decides.
  const WRITE_TERMS = ['submit', 'save', 'delete', 'remove', 'destroy', 'purge', 'trash', 'checkout', 'pay', 'order',
    'confirm', 'send', 'buy', 'purchase', 'register', 'create', 'add', 'update', 'edit', 'modify', 'post', 'apply',
    'publish', 'upload', 'invite', 'move', 'rename', 'merge', 'deploy', 'revoke', 'deactivate', 'disable',
    'unsubscribe', 'logout', 'signout', 'sign out', 'sign-out', 'log out', 'cancel', 'reset', 'clear', 'archive',
    'unlink', 'disconnect', 'suspend', 'block', 'proceed', 'continue', 'finish', 'complete'];
  const wordMatch = (text, term) => new RegExp('(^|[^a-z0-9])' + term + '($|[^a-z0-9])', 'i').test(text);
  const named = WRITE_TERMS.find((term) => wordMatch(label, term) || wordMatch(name, term));
  const namedDetail = named ? ` labelled "${label.slice(0, 40)}"` : '';

  if (type === 'submit' || type === 'image' || type === 'reset' || type === 'file') {
    return DENY(`a form control (${tag.toLowerCase()} type=${type})${namedDetail}`);
  }
  if (control.form || at(control, 'form')) return DENY(`a control owned by a form${namedDetail}`);
  if (inline) return DENY(`an inline event handler${namedDetail}`);

  const codeHref = /^\s*(javascript|data|blob|vbscript):/i.test(href);
  // A link whose URL names a write is a write too: <a href="/account/delete"> is a GET
  // that deletes. The verb may be a whole segment with an optional extension, a bare
  // relative target, or a query verb (?action=delete), anchored on both sides so that
  // /deleted-items and /reset-password/<tok> stay reads (review finding 3).
  const WRITE_VERBS = ['delete', 'remove', 'destroy', 'purge', 'trash', 'wipe', 'logout', 'signout', 'sign-out',
    'unsubscribe', 'revoke', 'deactivate', 'disable', 'unlink', 'cancel', 'archive'];
  const verbs = WRITE_VERBS.join('|');
  const writeHref = new RegExp(`(^|/)(${verbs})(\\.[a-z0-9]+)?(/|$|[?#])|[?&](action|op|method|_method|do)=(${verbs})(&|$)`, 'i').test(href);
  if (codeHref) return DENY('a javascript:/data: link');
  if (tag === 'A' || role === 'link') {
    // The one prose signal kept for links: a DESTRUCTIVE verb as a whole word, from a
    // short list that is not also ordinary navigation nouns, so that <a>Delete</a> with
    // no href and no handler is still refused while "Site Credits", "Read Post",
    // "Product Updates", "Order History" and "How to Apply" are not.
    const DESTRUCTIVE_WORDS = ['delete', 'remove', 'destroy', 'purge', 'trash', 'wipe', 'revoke', 'deactivate',
      'unsubscribe', 'unlink', 'logout', 'signout', 'sign out', 'sign-out', 'log out'];
    if (DESTRUCTIVE_WORDS.some((word) => wordMatch(label, word))) {
      return DENY(`a link whose label names a write${namedDetail}`);
    }
    if (writeHref) return DENY(`a link to a URL that names a write (${href.slice(0, 40)})`);
    return ALLOW('read-only navigation link');
  }
  // Client-side disclosure: it changes what is on screen, not what is on the server.
  if (tag === 'SUMMARY' || role === 'tab') return ALLOW('a client-side disclosure toggle');
  if (role === 'presentation' || role === 'none') return ALLOW('a presentational element');

  if (tag === 'INPUT') {
    const acts = ['submit', 'image', 'reset', 'button', 'checkbox', 'radio', 'file', 'color', 'range'];
    if (acts.includes(type)) return DENY(`an input that acts on click (type=${type})${namedDetail}`);
    return ALLOW('a text field: a click only focuses it');
  }
  if (tag === 'TEXTAREA') return ALLOW('a text field: a click only focuses it');
  if (tag === 'BUTTON') return DENY(`a button that may write${namedDetail}`);
  if (tag === 'SELECT') return DENY(`a select that may write${namedDetail}`);
  if (tag === 'LABEL') return DENY('a label (it forwards the click to its control)');
  if (CONTROL_ROLES.includes(role)) return DENY(`an element with role=${role} that may write${namedDetail}`);
  return ALLOW('not an interactive control');
}

// Kept for callers (and the suite) that ask the older question "which element
// would this click mutate?". The serialized predicate the page runs is
// classifyClickControl, which answers the same question with default-deny.
export function findMutatingControl(node) {
  const verdict = classifyClickControl(node);
  if (!verdict.gated) return null;
  const CONTROL_ROLES = ['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'link', 'checkbox', 'radio',
    'switch', 'option', 'combobox', 'listbox', 'slider', 'spinbutton', 'textbox', 'searchbox', 'treeitem', 'gridcell'];
  const interactive = 'button, input, select, textarea, summary, a, label, [contenteditable], [onclick], [onmousedown], [ontouchstart], [onpointerdown]'
    + CONTROL_ROLES.map((r) => ', [role="' + r + '"]').join('');
  return (node && typeof node.closest === 'function' ? node.closest(interactive) : null) || node;
}

// A NAVIGATION whose URL names a write is gated in a dry run: a GET that deletes is
// still a delete (web-uplift-d31). Matched on whole path segments (an extension is
// stripped) in the path AND in an SPA hash route, so /delete, /account/delete,
// /delete.php and #/account/delete are writes while /reset-password/<token>,
// /checkout and /deleted-items are ordinary reads. Page names that are as often
// read-only as they are writes (archive, cancel) are deliberately NOT here:
// /news/archive is a listing and a payment return /checkout/cancel is a landing,
// and a dry run must be able to follow the journey. A CLICK on such a link is
// still gated - that is classifyClickControl's writeHref, the arm that acts.
const WRITE_URL_SEGMENTS = new Set(['delete', 'remove', 'destroy', 'purge', 'logout', 'signout', 'sign-out',
  'unsubscribe', 'revoke', 'deactivate', 'disable', 'unlink']);
export function isWriteUrl(raw) {
  if (!raw || typeof raw !== 'string') return false;
  let u;
  try { u = new URL(raw, 'http://relative.invalid'); } catch { return false; }
  const routes = [u.pathname, u.hash.replace(/^#!?/, '').split('?')[0]];
  for (const route of routes) {
    const segs = String(route).toLowerCase().split('/').filter(Boolean).map((seg) => seg.replace(/\.[a-z0-9]+$/, ''));
    if (segs.some((seg) => WRITE_URL_SEGMENTS.has(seg))) return true;
  }
  for (const [k, v] of u.searchParams.entries()) {
    if (['action', 'op', 'method', '_method', 'do'].includes(k.toLowerCase()) && WRITE_URL_SEGMENTS.has(String(v).toLowerCase())) return true;
  }
  return false;
}

export function isSubmitControl(el) {
  return !!findMutatingControl(el);
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
          // A dry run MUST be able to follow the journey's pages (a top-level GET is
          // read-only by the HTTP contract), so navigation is allowed - except a URL
          // that names a write, because a GET that deletes is still a delete
          // (web-uplift-d31).
          if (!allowMutations && isWriteUrl(step.url || startUrl)) {
            outcome = {
              ok: true,
              mutationBlocked: true,
              detail: `dry-run: navigation to a URL that names a write (${step.url || startUrl}) prevented (use --allow-mutations)`,
            };
            break;
          }
          await navigate(client, step.url || startUrl, { settleMs, log });
          break;
        case 'click':
        case 'doubleClick':
          outcome = await pageAction(client, step.selectors, `
            const classifyClickControl = ${classifyClickControl.toString()};

            const verdict = classifyClickControl(el);
            if (!${allowMutations ? 'true' : 'false'} && verdict.gated) {
              const label = (el.tagName || '') + ' ' + (el.textContent || el.value || '').trim().slice(0, 40);
              return {
                ok: true,
                detail: 'dry-run: click on ' + verdict.reason + ' prevented (' + label.trim() + '; use --allow-mutations)',
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
          // web-uplift-e4z: a password field is never filled in a dry run whatever the
          // flow says. An imported Chrome Recorder export or a hand-authored flow.json
          // carries no `redacted` flag, so the old check (redacted && empty) let a
          // captured password be typed into the live page.
          //
          // web-uplift-d31: neither is any OTHER field. Setting .value and dispatching
          // input/change is exactly what an autosave or inline-AJAX listener writes on,
          // and nothing can tell an autosave field from a plain one, so a dry run does
          // not type at all. --allow-mutations performs the step.
          outcome = await pageAction(client, step.selectors, `
            const v=${JSON.stringify(step.value ?? '')};
            const type=(el.type||'').toLowerCase();
            if (!${allowMutations ? 'true' : 'false'} && type === 'password') {
              return { ok:true, mutationBlocked:true, detail:'dry-run: password field not filled (use --allow-mutations)' };
            }
            if (!${allowMutations ? 'true' : 'false'}) {
              return { ok:true, mutationBlocked:true, detail:'dry-run: change step not dispatched because typing can trigger autosave/AJAX against the live target (use --allow-mutations)' };
            }
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
                  // isContentEditable, not getAttribute('contenteditable'): the
                  // attribute is "" (falsy) for contenteditable="" and the element
                  // is still editable.
                  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || el.isContentEditable) {
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
