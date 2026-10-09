import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { applyConditions, announceCap, emit } from '../common.mjs';
import { evaluate, navigate, sleep } from '../cdp.mjs';

const require = createRequire(import.meta.url);

export async function axe(client, url, opts, log) {
  const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
  const axeSource = readFileSync(axePath, 'utf8');
  const { Page } = client;
  let bypassOn = false;
  try {
    await navigate(client, url, {
      settleMs: opts.wait,
      log,
      beforeTargetNavigate: () => applyConditions(client, opts, log),
    });
    await sleep(150);
    if (opts.interact) await evaluate(client, opts.interact);

    // The one step that needs the page's policy lifted: injecting the vendored
    // engine. Restored immediately, so the analysis below runs with the page's
    // policy in force and the page's own blocked scripts never ran.
    await Page.setBypassCSP({ enabled: true });
    bypassOn = true;
    await evaluate(client, axeSource);
    await Page.setBypassCSP({ enabled: false });
    bypassOn = false;

    const version = await evaluate(client, 'window.axe && window.axe.version');
    if (!version) throw new Error('axe-core injected but window.axe is undefined');
    log(`[evidence] axe-core ${version} injected (vendored; the page's CSP was lifted for the injection only)`);

    // Run axe in the page and return a compact, model-readable shape: full
    // results carry every passing node and are far too large to read. Nodes
    // are capped per violation; the cap is announced, never silent.
    const MAX_NODES = 25;
    const context = opts.selector ? JSON.stringify(opts.selector) : 'document';
    const runOpts = {};
    if (opts.rules) runOpts.runOnly = { type: 'rule', values: String(opts.rules).split(',') };
    else if (opts.tags) runOpts.runOnly = { type: 'tag', values: String(opts.tags).split(',') };
    const raw = await evaluate(
      client,
      `(async () => {
        const results = await axe.run(${context}, ${JSON.stringify(runOpts)});
        const pack = (v) => ({
          id: v.id,
          impact: v.impact ?? null,
          description: v.description,
          help: v.help,
          helpUrl: v.helpUrl,
          nodeCount: v.nodes.length,
          nodes: v.nodes.slice(0, ${MAX_NODES}).map((n) => ({
            target: n.target,
            html: typeof n.html === 'string' ? n.html.slice(0, 300) : '',
            failureSummary: n.failureSummary ?? '',
          })),
        });
        const byImpact = { critical: [], serious: [], moderate: [], minor: [], other: [] };
        for (const v of results.violations) (byImpact[v.impact] ?? byImpact.other).push(pack(v));
        return {
          toolVersion: axe.version,
          violations: byImpact,
          violationCount: results.violations.length,
          incomplete: results.incomplete.map(pack),
          counts: {
            violations: results.violations.length,
            incomplete: results.incomplete.length,
            passes: results.passes.length,
            inapplicable: results.inapplicable.length,
          },
        };
      })()`,
    );
    for (const list of [Object.values(raw.violations).flat(), raw.incomplete]) {
      for (const v of list) announceCap(`${v.id} nodes`, v.nodes.length, v.nodeCount, log);
    }
    const result = {
      url,
      cspBypassedForInjection: true,
      cspBypassNote:
        "The vendored axe-core source is injected with the page's Content-Security-Policy lifted (Page.setBypassCSP), because a strict script-src refuses an injected script. The page is navigated and analysed with its policy enforced, so the page's own blocked scripts never ran, and the bypass covers the injection call only. Read this with the rest of the run's evidence: what is reported here describes the page as its own policy allows it to behave.",
      ...raw,
    };
    return emit(opts, result, client);
  } finally {
    if (bypassOn) await Page.setBypassCSP({ enabled: false });
  }
}

// trace: record a DevTools performance trace via the Tracing domain over the
// load (and an optional --interact window), write a devtools-loadable trace.json
// AND a compact, model-readable summary (key timings, long tasks, blocking).
// The model reads the summary, never the multi-MB raw trace.
// EXPORTED FOR TESTS ONLY (web-uplift-4ux), following this file's existing test-support
// exports (safeFetch, waitForInteractEvidence): the tracing bounds guard BROWSER-fired
// events, which no stub can reach through gather() because gather launches a real
// Chrome - the regression suite drives trace() directly with a fake client to show the
// bounds fire; the only consumer of this export in this repo is that suite.
