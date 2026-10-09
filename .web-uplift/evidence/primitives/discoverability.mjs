import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { applyConditions, emit, byteLength, round, derivedOut, uint8FromBase64 } from '../common.mjs';
import { safeFetch, CRAWLER_UA, targetOriginOf } from '../fetch.mjs';
import { stripHtmlToText, contentTokens, contentPresentInRaw, detectEmptyMounts } from '../html-text.mjs';
import { evaluate, navigate, sleep } from '../cdp.mjs';

export async function discoverability(client, url, opts, log) {
  // 1. Raw HTML as a non-JS crawler sees it: a plain fetch, no JS execution.
  let rawHtml = '';
  let rawStatus = null;
  let fetchError = null;
  let finalUrl = url;
  try {
    const fetched = await safeFetch(url, {
      // The audited target is the operator's explicit choice, so its own ORIGIN is
      // exempt from the private-address rule (this suite audits 127.0.0.1); every
      // redirect hop is still validated before it is requested.
      targetOrigin: targetOriginOf(url),
      headers: { 'user-agent': CRAWLER_UA, accept: 'text/html' },
    });
    rawStatus = fetched.res.status;
    finalUrl = fetched.url;
    rawHtml = await fetched.text();
    log(`[evidence] discoverability: raw HTML ${rawStatus}, ${byteLength(rawHtml)} bytes`);
  } catch (e) {
    fetchError = String(e?.message || e);
    log(`[evidence] discoverability: raw fetch failed: ${fetchError}`);
  }

  // 2. Rendered DOM after JS runs, via CDP. SPAs often need more than the
  // default 1s to hydrate and paint their content, so settle for longer here
  // unless the caller asked for a specific --wait.
  await navigate(client, url, {
    settleMs: Math.max(opts.wait ?? 0, 3500),
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  await sleep(150);
  const rendered = await evaluate(
    client,
    `(() => {
      // Collect rendered visible text, DESCENDING into open shadow roots so
      // web-component sites (Lit/Polymer/Stencil) aren't mistaken for empty -
      // document.body.innerText does not pierce shadow DOM.
      const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);
      const parts = [];
      const walk = (node) => {
        if (!node) return;
        if (node.nodeType === 3) {
          const t = (node.nodeValue || '').trim();
          if (t) {
            const p = node.parentElement;
            if (!p || p.getClientRects().length) parts.push(t);
          }
          return;
        }
        if (node.nodeType === 1) {
          if (SKIP.has(node.tagName)) return;
          if (node.shadowRoot) node.shadowRoot.childNodes.forEach(walk);
        }
        (node.childNodes || []).forEach(walk);
      };
      walk(document.body);
      const txt = parts.join(' ');
      const h1s = [];
      const collectH1 = (root) => {
        root.querySelectorAll && root.querySelectorAll('h1').forEach((h) => { const t = (h.innerText || h.textContent || '').trim(); if (t) h1s.push(t); });
        root.querySelectorAll && root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) collectH1(el.shadowRoot); });
      };
      collectH1(document);
      return {
        title: document.title || '',
        metaDescription: (document.querySelector('meta[name="description"]') || {}).content || '',
        h1: h1s,
        text: txt.replace(/\\s+/g, ' ').trim(),
        framework: (window.__NEXT_DATA__ ? 'Next.js' : window.__NUXT__ ? 'Nuxt'
          : document.querySelector('[ng-version]') ? 'Angular'
          : (window.React || document.querySelector('[data-reactroot],#root')) ? 'React-like' : null),
      };
    })()`,
  );

  // 3. Compare rendered content against the raw HTML - as ONE block derived from the
  // usability condition, so no sibling field can emit a false "absent" on the sole basis
  // that the fetch failed. (rev5: coverage and the shell verdict were gated, but the
  // presence comparisons still emitted false from an empty string - the same class one
  // level down, and gating per-line is how a fourth sibling gets missed in a later
  // revision.) When the raw document was never retrieved, EVERY comparison field - the
  // shell verdict included, since it consumes the gated fields - is null, and the summary
  // says why. Fields that describe the RENDERED page (renderedEmpty,
  // rendered.*, the screenshots) stay computed: the render exists regardless of the raw
  // fetch, so they are not comparisons and they remain meaningful - that is the answer to
  // "is any field legitimately meaningful without raw HTML".
  // THE USABILITY GATE - the single authority on whether the raw document was retrieved,
  // with the routes by which it was NOT ENUMERATED here so a route added later must be
  // classified rather than silently defaulting to "usable" (the same failure the fields
  // had before the surface was asserted; the route coverage is stated narrowly below).
  // USABLE MEANS WE RETRIEVED THE DOCUMENT THE URL NAMES (coord's ruling):
  //   1. the exchange threw - a network error, an abort/timeout, or a refusal by the
  //      page-derived fetch guard (including the redirect hop-limit);
  //   2. the body read threw or exceeded the cap (it happens inside the same try, so it
  //      arrives through route 1 as a fetchError);
  //   3. the final response is not a SUCCESS (2xx): a 404 or 500 page is a response ABOUT
  //      the resource, not the document, and comparing the rendered page against it
  //      manufactures exactly the false claim this gate exists to prevent. A LOCATION-LESS
  //      3xx lands here too: the fetch helper returns it as a response (it does not throw),
  //      so the status check is what rejects it. A 3xx that resolves to a 2xx is fine.
  //      The status is still RECORDED, so nothing is lost: the operator sees the 404 as a
  //      status, not as a misleading "not a JS shell".
  // A genuinely EMPTY 200 body is DIFFERENT AND STAYS USABLE: a completed empty response is
  // observed evidence that the raw document was empty - the real empty-document signal the
  // tool exists to report. The distinction is deliberate, not incidental.
  // ROUTE COVERAGE, STATED NARROWLY: the timeout, body-read and non-2xx routes are
  // exercised END-TO-END through discoverability by testFetchDeadlineAndRawComparison; the
  // guard-refusal and size-cap mechanisms are exercised at the safeFetch level by
  // testSafeFetchRedirectAndSizeGuard; a location-less 3xx is NOT exercised through
  // discoverability - it lands on the same status check the 404 route exercises, and
  // saying that is more useful than claiming a coverage the tests do not have.
  const rawComparisonUsable =
    fetchError === null && rawStatus !== null && rawStatus >= 200 && rawStatus < 300;
  const renderedTokens = contentTokens(rendered.text);
  // If the rendered page produced essentially no content, coverage is undefined
  // (not 100%) - the render likely failed, redirected, or the page is genuinely
  // empty. Surface that honestly rather than manufacture a perfect score.
  const renderedEmpty = renderedTokens.size < 3;
  const { coveragePct, emptyMounts, titleInRaw, h1InRaw, metaInRaw, rawStats, isJsShell } = rawComparisonUsable
    ? (() => {
        const rawText = stripHtmlToText(rawHtml);
        const rawTokens = contentTokens(rawText);
        let overlap = 0;
        for (const t of renderedTokens) if (rawTokens.has(t)) overlap++;
        const coverage = renderedEmpty ? null : Math.round((overlap / renderedTokens.size) * 100);
        const mounts = detectEmptyMounts(rawHtml);
        return {
          coveragePct: coverage,
          emptyMounts: mounts,
          titleInRaw: rendered.title ? contentPresentInRaw(rendered.title, rawText) : null,
          h1InRaw: rendered.h1.length ? rendered.h1.some((h) => contentPresentInRaw(h, rawText)) : null,
          metaInRaw: rendered.metaDescription ? /name=["']description["']/i.test(rawHtml) : null,
          rawStats: { htmlBytes: byteLength(rawHtml), textChars: rawText.length, contentTokens: rawTokens.size },
          // The verdict consumes the gated fields, so it is produced under the SAME
          // condition: unknown (null) whenever coverage is undefined, whether the raw
          // document is missing or the render was empty. "Not a shell" is a claim; it must
          // never be emitted for a comparison that did not happen.
          isJsShell:
            coverage == null
              ? null
              : (mounts.length > 0 && coverage < 25) ||
                (renderedTokens.size >= 50 && coverage < 10),
        };
      })()
    : {
        coveragePct: null,
        emptyMounts: null,
        titleInRaw: null,
        h1InRaw: null,
        metaInRaw: null,
        // "0 bytes / 0 tokens" would be a claim about a document that was never retrieved.
        rawStats: { htmlBytes: null, textChars: null, contentTokens: null },
        isJsShell: null,
      };
  // Visual proof: a browser view (JS on, already loaded) vs a crawler view (JS
  // disabled, reloaded). For a shell site the crawler view is blank/near-empty -
  // the single most legible evidence for this finding. Unless --no-screenshots.
  let screenshots = null;
  if (opts.screenshots !== false) {
    try {
      const base = (opts.out ? opts.out.replace(/\.json$/i, '') : derivedOut(url, 'discoverability', '').replace(/\.$/, ''));
      const renderedPng = `${base}-rendered.png`;
      const crawlerPng = `${base}-crawler.png`;
      const shotOn = await client.Page.captureScreenshot({ format: 'png' });
      writeFileSync(renderedPng, uint8FromBase64(shotOn.data));
      // Reload with JavaScript disabled to see exactly what a non-JS crawler gets.
      await client.Emulation.setScriptExecutionDisabled({ value: true });
      await navigate(client, url, { settleMs: Math.max(opts.wait ?? 0, 1200), log });
      const shotOff = await client.Page.captureScreenshot({ format: 'png' });
      writeFileSync(crawlerPng, uint8FromBase64(shotOff.data));
      await client.Emulation.setScriptExecutionDisabled({ value: false });
      screenshots = { rendered: renderedPng, crawler: crawlerPng };
      log(`[evidence] discoverability: wrote browser + crawler screenshots`);
    } catch (e) {
      log(`[evidence] discoverability: screenshot capture failed: ${String(e?.message || e)}`);
    }
  }

  const summary = {
    type: 'discoverability',
    url,
    finalUrl,
    fetchedStatus: rawStatus,
    fetchError,
    crawlerUserAgent: CRAWLER_UA,
    coveragePct, // share of rendered content words that also appear in the raw server HTML (null if the render was empty OR the raw fetch failed/timed out)
    rawComparisonUsable, // false when the raw document was never retrieved: coveragePct and isJsShell are then NOT evidence about the page, and must not be reported as such
    ...(rawComparisonUsable
      ? {}
      : {
          rawComparisonNote:
            (fetchError
              ? `The raw HTML fetch failed or timed out (${fetchError})`
              : `The raw HTML fetch returned a non-success status (${rawStatus}) - a response ABOUT the resource, not the document`) +
            ', so there is no raw document to compare against the rendered page. A fetch failure is a network condition, not a property of the page; the status, when one arrived, is recorded as fetchedStatus.',
        }),
    contentVisibleWithoutJs: coveragePct,
    isJsShell,
    renderedEmpty,
    emptyMounts,
    titlePresentInRaw: titleInRaw,
    h1PresentInRaw: h1InRaw,
    metaDescriptionPresentInRaw: metaInRaw,
    rendered: {
      textChars: rendered.text.length,
      contentTokens: renderedTokens.size,
      title: rendered.title,
      h1Count: rendered.h1.length,
      framework: rendered.framework,
    },
    raw: rawStats,
    screenshots, // { rendered, crawler } - browser view (JS on) vs crawler view (JS off)
    signalsFor: ['be-discoverable', 'be-agent-ready'],
    note:
      'coveragePct = the share of the rendered page\'s content words that also appear in the RAW server HTML - what a crawler that does not run JavaScript (many AI crawlers, per the url-influence research) can see. Low coverage with an empty SPA mount means the content is effectively invisible to non-JS crawlers and unlikely to enter model training or search. High coverage means it is server-rendered and reachable. Descriptive signal, not a verdict: judge against be-discoverable / be-agent-ready, and confirm surprising results against the raw HTML and the dom primitive.',
  };

  return emit(opts, summary, client);
}

// --- secrets primitive ----------------------------------------------------
// Scans page HTML, inline scripts, external JS resources, and meta tags for
// exposed API keys, tokens, and credentials. Returns structured findings.
// The MODEL must reason about each finding: legitimate public keys (e.g. Google
// Maps) vs actual sensitive secrets (AWS keys, Stripe secret keys, JWTs, private keys).
