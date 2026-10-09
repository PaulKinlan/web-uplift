import { announceCap, emit, round } from '../common.mjs';
import { evaluate, navigate, sleep } from '../cdp.mjs';

export async function images(client, url, opts, log) {
  log('[images] auditing ' + url);
  await navigate(client, url, { settleMs: opts.wait || 3000, log });
  const data = await evaluate(client, `(() => {
    const imgs = [...document.querySelectorAll('img')];
    const vh = window.innerHeight;
    return { total: imgs.length, items: imgs.slice(0, 100).map(img => {
      const r = img.getBoundingClientRect();
      const nw = img.naturalWidth || 0;
      const dw = Math.round(r.width) || 0;
      return {
        src: (img.src || '').slice(0, 120), alt: img.alt || null,
        hasWidth: img.hasAttribute('width'), hasHeight: img.hasAttribute('height'),
        loading: img.getAttribute('loading'),
        srcset: img.hasAttribute('srcset') || !!img.querySelector('source'),
        naturalWidth: nw, displayWidth: dw,
        oversized: nw > 0 && dw > 0 && nw > dw * 2,
        belowFold: r.top > vh,
        format: (() => { try { const p = new URL(img.src).pathname; const parts = p.split('.'); return parts.length > 1 ? parts.pop().toLowerCase().slice(0,5) : null; } catch { return null; } })(),
      };
    }) };
  })()`);
  const imgs = data?.items || [];
  const totalImages = data?.total ?? imgs.length;
  announceCap('images.inspected', imgs.length, totalImages, log);
  announceCap('images.images', Math.min(imgs.length, 30), imgs.length, log);
  const summary = {
    primitive: 'images', url,
    scannedAt: new Date().toISOString(),
    totalImages,
    imagesInspected: imgs.length,
    imagesInspectedTruncated: totalImages > imgs.length,
    issues: {
      missingDimensions: imgs.filter(i => !i.hasWidth || !i.hasHeight).length,
      notLazyBelowFold: imgs.filter(i => i.belowFold && i.loading !== 'lazy').length,
      oversized: imgs.filter(i => i.oversized).length,
      missingSrcset: imgs.filter(i => !i.srcset && i.displayWidth > 100).length,
      legacyFormat: imgs.filter(i => i.format && ['jpg','jpeg','png','gif'].includes(i.format)).length,
      modernFormat: imgs.filter(i => i.format && ['avif','webp','svg'].includes(i.format)).length,
      missingAlt: imgs.filter(i => !i.alt).length,
    },
    images: imgs.slice(0, 30),
    imagesTruncated: totalImages > 30,
    note: 'Descriptive signal. Judge against be-fast-and-stable (missing width/height causes CLS, oversized images), be-sustainable (legacy formats, missing srcset), be-inclusive (missing alt).',
  };
  return emit(opts, summary, client);
}

// console: what the page logged while it loaded and (with --interact) while it
// was driven - console errors and warnings, uncaught exceptions, and browser
// log errors (failed resource loads, CSP violations, deprecations). This is the
// first-party evidence path for follow-best-practices/no-console-errors: a probe
// that runs after load cannot see what fired during it. The collector is
// attached for every primitive, so the same block also rides along on whatever
// else happened to be running when the page logged something.
// The interact probe used to read the collector after a fixed 250ms sleep, which
// is the 7kl flake: evaluate(opts.interact) resolves as soon as the SCRIPT's own
// value resolves (typically a setTimeout id), so the click -> throw ->
// Runtime.exceptionThrown -> CDP -> Node chain had to finish inside 250ms of
// wall clock or the capture read zero entries (web-uplift-3t2).
//
// The wait is two-phase and bounded:
//   1. poll for the first new entry, up to the deadline;
//   2. once entries appear, keep polling until a trailing silence window passes
//      with no further entries, so a benign entry at +0ms cannot mask a throw at
//      +100ms the way a first-entry-only exit would;
// and it never runs past the deadline.
//
// The default deadline is the 250ms settle this probe always had, so a quiet
// interaction costs what it always did and is not reported as a failure; a
// caller that knows it expects late evidence raises it with --interact-deadline.
