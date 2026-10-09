import { readFileSync, writeFileSync } from 'node:fs';
import { applyConditions, describeConditions, emit } from '../common.mjs';
import { evaluate, navigate, sleep } from '../cdp.mjs';

export async function evaluateCmd(client, url, opts, log) {
  await navigate(client, url, {
    settleMs: opts.wait,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  await sleep(150);
  if (opts.interact) await evaluate(client, opts.interact);
  const expr = opts.expr;
  if (!expr) throw new Error('evaluate requires --expr "<js>" or --expr-file <path>');
  const value = await evaluate(client, expr);
  // evaluate returns the model's own expression result, so emit() is not used.
  // When that result is a plain object, record the conditions it was measured
  // under (a diff of rendered dates/numbers across two locales is only meaningful
  // if each side states its conditions); primitives (string/number) pass through
  // unchanged, with the conditions still logged on stderr by applyConditions.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const conditions = describeConditions(opts);
    if (conditions && value.conditions === undefined) value.conditions = conditions;
  }
  if (opts.out) writeFileSync(opts.out, JSON.stringify(value, null, 2) + '\n');
  return value;
}

// axe: accessibility evidence via the VENDORED axe-core. The skill prescribes
// axe for be-inclusive (names/roles/labels, contrast, structure/focus), but
// fetching it from a CDN through the evaluate primitive silently fails on any
// site with a strict script-src - which is to say on exactly the
// well-configured sites. Here the script is read from node_modules at audit
// time (no CDN dependency, no network requirement) and Page.setBypassCSP is
// enabled for the INJECTION, so the injection cannot be refused.
//
// The page is navigated with its own policy ENFORCED. The bypass used to be
// enabled before navigation, so the page's own blocked inline scripts ran during
// the audit; a page's policy decides what a real visitor gets, so the audit sees
// that too now and the page's scripts stay blocked. What remains is the
// injection: a strict script-src refuses an injected script, so the policy is
// lifted for that one call and restored in the same breath, and the result
// records it (`cspBypassedForInjection`, `cspBypassNote`) so a reader can tell
// this run from one where no bypass happened. gather() gives every primitive a
// fresh Chrome session, so the headers/secrets primitives can never inherit the
// bypass - the security evidence stays valid.
//
// The result is DESCRIPTIVE, not a verdict: violations grouped by impact with
// node targets + failure summaries, plus counts. The model judges them against
// the principles.
