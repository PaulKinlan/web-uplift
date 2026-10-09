import { applyConditions, emit } from '../common.mjs';
import { evaluate, navigate, sleep } from '../cdp.mjs';

// --- targets primitive: WCAG 2.2 SC 2.5.8 Target Size (Minimum) -----------
//
// Enumerates pointer targets, measures their boxes, and applies the exception
// structure the spec defines as far as geometry and DOM context can decide it:
// anything smaller than 24x24 CSS px is flagged, targets inline in a sentence
// are marked exempt, and the spacing exception is computed as a 24px-diameter
// circle centred on the box clearing every other target (and every other
// undersized target's circle). The user-agent-control and essential exceptions
// are NOT detected; the model judges those from the element itself. Descriptive
// signal, not a verdict.
//
// Measured at two viewports by default (a fixed 1280x720 desktop and 360x800
// mobile, because the answer differs by form factor); passing --viewport gives
// the single condition you asked for instead.
const TARGET_SELECTOR =
  'a,button,input,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="menuitem"],[role="option"],[role="radio"],[role="switch"],[role="tab"]';
const TARGET_MIN_PX = 24;
const TARGET_CAP = 400;

// The in-page probe. Kept as one expression so both viewport passes measure
// identically, and capped so a link-dense page cannot flood the evidence.
function targetsExpression() {
  return `(() => {
    const selector = ${JSON.stringify(TARGET_SELECTOR)};
    const MIN = ${TARGET_MIN_PX};
    const CAP = ${TARGET_CAP};
    const round1 = (n) => Math.round(n * 10) / 10;
    const els = [...document.querySelectorAll(selector)];
    const boxes = [];
    const targets = [];
    let skippedZeroSize = 0;
    let omittedByCap = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) { skippedZeroSize++; continue; }
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') { skippedZeroSize++; continue; }
      if (targets.length >= CAP) { omittedByCap++; continue; }
      const ownText = (el.textContent || '').trim();
      const name = (el.getAttribute('aria-label') || el.value || ownText || el.getAttribute('title') || '')
        .replace(/\\s+/g, ' ').trim().slice(0, 60);
      // "Inline" per 2.5.8 means the target is in a sentence, so look for text
      // the target sits between: direct text nodes beside it in its parent
      // (counting the parent's accumulated textContent would call every link in
      // a long list inline, since the siblings' text is part of it).
      const inText = el.parentElement
        ? [...el.parentElement.childNodes].some((n) => n.nodeType === 3 && (n.nodeValue || '').trim().length > 0)
        : false;
      boxes.push({ x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 });
      targets.push({
        tag: el.tagName.toLowerCase(),
        ...(el.tagName === 'INPUT' ? { inputType: el.type || 'text' } : {}),
        role: el.getAttribute('role') || null,
        id: el.id || null,
        name,
        width: round1(r.width),
        height: round1(r.height),
        areaPx: Math.round(r.width * r.height),
        display: cs.display,
        underMin: r.width < MIN || r.height < MIN,
        // "Inline" per 2.5.8 means the target is in a sentence: text beside it
        // in the same parent, and not a block-level box.
        inlineInText: inText && !['block', 'flex', 'grid', 'table'].includes(cs.display),
        spacingPasses: null,
        nearestTargetEdgeDistancePx: null,
        nearestTargetCenterDistancePx: null,
      });
    }
    // Spacing exception: a MIN-px-diameter circle centred on the box must not
    // intersect another target, or the circle of another undersized target.
    const radius = MIN / 2;
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      let nearestEdge = Infinity;
      let nearestCenter = Infinity;
      let nearestUndersizedCenter = Infinity;
      for (let j = 0; j < boxes.length; j++) {
        if (i === j) continue;
        const b = boxes[j];
        const centerDistance = Math.hypot(a.cx - b.cx, a.cy - b.cy);
        nearestCenter = Math.min(nearestCenter, centerDistance);
        if (targets[j].underMin) nearestUndersizedCenter = Math.min(nearestUndersizedCenter, centerDistance);
        const dx = Math.max(b.x - a.cx, 0, a.cx - (b.x + b.w));
        const dy = Math.max(b.y - a.cy, 0, a.cy - (b.y + b.h));
        nearestEdge = Math.min(nearestEdge, Math.hypot(dx, dy));
      }
      const finite = (n) => (Number.isFinite(n) ? round1(n) : null);
      targets[i].nearestTargetEdgeDistancePx = finite(nearestEdge);
      targets[i].nearestTargetCenterDistancePx = finite(nearestCenter);
      targets[i].spacingPasses = targets[i].underMin
        ? nearestEdge >= radius && nearestUndersizedCenter >= MIN
        : null;
    }
    const under = targets.filter((t) => t.underMin);
    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      matchedCount: els.length,
      measuredCount: targets.length,
      skippedZeroSizeCount: skippedZeroSize,
      omittedByCapCount: omittedByCap,
      underMinCount: under.length,
      underMinInlineExemptCount: under.filter((t) => t.inlineInText).length,
      underMinSpacingExemptCount: under.filter((t) => t.spacingPasses === true).length,
      underMinNoKnownExemptionCount: under.filter((t) => !t.inlineInText && t.spacingPasses !== true).length,
      targets,
    };
  })()`;
}

export async function targets(client, url, opts, log) {
  // Pure LAYOUT sizes: SC 2.5.8 measures CSS px geometry, so the primitive wants
  // a 360px-wide layout, not Chrome's mobile emulation (which lays a page with
  // no viewport meta out at 980 CSS px and would silently measure that instead).
  // `viewport` on each result reports the layout width actually measured.
  const passes = opts.viewport
    ? [{ name: `custom-${opts.viewport.w}x${opts.viewport.h}`, viewport: opts.viewport }]
    : [
        { name: 'desktop-1280x720', viewport: { w: 1280, h: 720 } },
        { name: 'narrow-360x800', viewport: { w: 360, h: 800 } },
      ];

  const viewports = [];
  for (const pass of passes) {
    const conditions = { ...opts, viewport: pass.viewport, viewportMobile: false };
    await navigate(client, url, {
      settleMs: opts.wait ?? 800,
      log,
      beforeTargetNavigate: () => applyConditions(client, conditions, log),
    });
    await sleep(150);
    const measured = await evaluate(client, targetsExpression());
    log(
      `[evidence] targets ${pass.name}: ${measured.underMinCount} of ${measured.measuredCount} target(s) under ${TARGET_MIN_PX}px, ` +
        `${measured.underMinNoKnownExemptionCount} without a read exemption`,
    );
    viewports.push({ name: pass.name, mobile: false, ...measured });
  }

  const result = {
    primitive: 'targets',
    url,
    scannedAt: new Date().toISOString(),
    minimumPx: TARGET_MIN_PX,
    selector: TARGET_SELECTOR,
    viewports,
    note:
      'WCAG 2.2 SC 2.5.8 Target Size (Minimum): pointer targets should be at least 24x24 CSS px unless an exception applies. The two exceptions geometry can read are marked per target: inlineInText (the target sits in a sentence - its parent has text nodes beside it - and it is not a block-level box) and spacingPasses (a 24px-diameter circle centred on the box clears every other target box and every other undersized target circle). The user-agent-control and essential exceptions are NOT detected here, so judge those from the element itself. underMinNoKnownExemptionCount is the mechanical "needs your judgement" set, not a verdict, and geometry is in CSS px. Each entry in `viewports` is a pure layout size (no mobile emulation, so a page without a viewport meta is measured at the width asked for rather than Chrome\'s 980px default); `viewport` reports the layout width and height each pass actually measured. Targets are enumerated by the selector in `selector` and measured once per entry in `viewports`.',
  };
  return emit(opts, result, client);
}

