// Programmatically-detectable checks implied by principles/principles.json.
//
// Each check drives the page through the Chrome DevTools Protocol (navigate,
// emulate a media feature or device metric, evaluate DOM/CSS state) and returns
// zero or more findings. Findings conform to schema/findings.schema.json.
//
// The playground is a hash-routed SPA: each scenario injects its scoped CSS only
// while its hash route is active. So most checks navigate to a specific
// "<base>#<scenarioHash>" route, set the relevant emulated condition, let it
// settle, then read computed styles / layout via Runtime.evaluate.

import { navigate } from './browser.mjs';

// --- CDP emulation helpers -------------------------------------------------

async function setMedia(client, features) {
  // features: [{ name: 'prefers-color-scheme', value: 'dark' }, ...]
  await client.Emulation.setEmulatedMedia({ features });
}

async function clearMedia(client) {
  await client.Emulation.setEmulatedMedia({ features: [] });
}

async function setViewport(client, width, height, mobile = true) {
  await client.Emulation.setDeviceMetricsOverride({
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
}

async function clearViewport(client) {
  await client.Emulation.clearDeviceMetricsOverride();
}

async function evaluate(client, fn, ...args) {
  const expression = `(${fn.toString()})(${args
    .map((a) => JSON.stringify(a))
    .join(',')})`;
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(
      `evaluate failed: ${exceptionDetails.text} ${
        exceptionDetails.exception?.description ?? ''
      }`,
    );
  }
  return result.value;
}

function routeUrl(baseUrl, hash) {
  // baseUrl may already carry ?mode=fixed. Preserve query, set hash.
  const u = new URL(baseUrl);
  u.hash = hash;
  return u.toString();
}

// --- Individual checks -----------------------------------------------------
//
// Every check returns { pathId, conditions, findings: [...] }. A finding omits
// principleId-only-known fields it cannot fill. The runner assigns final ids.

// respect-user-preferences / respects-color-scheme
async function checkColorScheme(client, baseUrl, log) {
  const url = routeUrl(baseUrl, '#no-dark-mode');
  await navigate(client, url, { settleMs: 300, log });
  await setMedia(client, [{ name: 'prefers-color-scheme', value: 'dark' }]);
  await new Promise((r) => setTimeout(r, 150));

  const data = await evaluate(client, () => {
    const card = document.querySelector('.ndm-card');
    if (!card) return { present: false };
    const cs = getComputedStyle(card);
    // Does this element (or its own rule) actually adapt the surface for dark?
    // We treat an explicitly-set light surface that does not change under the
    // dark preference as "not adapted". (A root color-scheme: light dark is
    // inherited but does NOT re-tint an explicit background color, which is
    // exactly the issue this scenario seeds.)
    return {
      present: true,
      bg: cs.backgroundColor,
      color: cs.color,
      colorScheme: cs.colorScheme,
    };
  });

  await clearMedia(client);

  const findings = [];
  if (data.present) {
    // Under an emulated dark preference, a high-luminance ("light") surface
    // means the card ignores dark mode. In fixed mode the card uses light-dark()
    // and renders a dark (low-luminance) surface here, so it is not flagged.
    const lum = relLuminanceFromCss(data.bg);
    const ignoresDark = lum !== null && lum > 0.6;
    if (ignoresDark) {
      findings.push({
        principleId: 'respect-user-preferences',
        principleCheckId: 'respects-color-scheme',
        severity: 'high',
        confidence: 'high',
        summary:
          'No dark-mode adaptation: the surface ignores prefers-color-scheme: dark.',
        evidence: `Under emulated prefers-color-scheme: dark, .ndm-card background is ${data.bg} (computed color-scheme: "${data.colorScheme}") with no color-scheme: dark declared, so it stays a light surface.`,
        suggestedFix:
          'Declare color-scheme: light dark and use light-dark() (or a prefers-color-scheme: dark block) for surface and text colors so the card follows the user preference. See Modern Web Guidance id dark-mode.',
        effort: 'small',
        scenario: 'no-dark-mode',
      });
    }
  }
  return { pathId: 'no-dark-mode', conditions: ['prefers-color-scheme: dark'], findings };
}

// respect-user-preferences / respects-reduced-motion
async function checkReducedMotion(client, baseUrl, log) {
  const url = routeUrl(baseUrl, '#motion');
  await navigate(client, url, { settleMs: 300, log });
  await setMedia(client, [{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await new Promise((r) => setTimeout(r, 200));

  const data = await evaluate(client, () => {
    const card = document.querySelector('.mv-card');
    if (!card) return { present: false };
    const anims = card.getAnimations ? card.getAnimations() : [];
    const running = anims.filter((a) => a.playState === 'running');
    const cs = getComputedStyle(card);
    return {
      present: true,
      runningCount: running.length,
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
    };
  });

  await clearMedia(client);

  const findings = [];
  if (data.present) {
    const stillAnimating =
      data.runningCount > 0 ||
      (data.animationName &&
        data.animationName !== 'none' &&
        parseFloat(data.animationDuration) > 0);
    if (stillAnimating) {
      findings.push({
        principleId: 'respect-user-preferences',
        principleCheckId: 'respects-reduced-motion',
        severity: 'high',
        confidence: 'high',
        summary:
          'Animation keeps running under prefers-reduced-motion: reduce.',
        evidence: `Under emulated prefers-reduced-motion: reduce, .mv-card still has ${data.runningCount} running animation(s) (animation-name "${data.animationName}", duration ${data.animationDuration}).`,
        suggestedFix:
          'Gate the animation behind @media (prefers-reduced-motion: no-preference) so it only runs when the user has not requested reduced motion.',
        effort: 'trivial',
        scenario: 'motion',
      });
    }
  }
  return {
    pathId: 'motion',
    conditions: ['prefers-reduced-motion: reduce'],
    findings,
  };
}

// adapt-to-the-form-factor / responsive-no-horizontal-scroll (mobile overflow)
async function checkHorizontalScroll(client, baseUrl, log) {
  const url = routeUrl(baseUrl, '#fixed-layout');
  await navigate(client, url, { settleMs: 200, log });
  await setViewport(client, 360, 800, true);
  await new Promise((r) => setTimeout(r, 150));

  const data = await evaluate(client, () => {
    const doc = document.documentElement;
    const scrollWidth = doc.scrollWidth;
    const clientWidth = doc.clientWidth;
    const innerWidth = window.innerWidth;
    const hasViewportMeta = !!document.querySelector('meta[name="viewport"]');
    // Find the widest offending element for evidence.
    let widest = null;
    for (const node of document.querySelectorAll('body *')) {
      const w = node.getBoundingClientRect().width;
      if (w > innerWidth + 1 && (!widest || w > widest.w)) {
        widest = { sel: node.className || node.tagName, w: Math.round(w) };
      }
    }
    return { scrollWidth, clientWidth, innerWidth, hasViewportMeta, widest };
  });

  await clearViewport(client);

  const findings = [];
  const overflow = data.scrollWidth > data.innerWidth + 1;
  if (overflow) {
    findings.push({
      principleId: 'adapt-to-the-form-factor',
      principleCheckId: 'responsive-no-horizontal-scroll',
      severity: 'high',
      confidence: 'high',
      summary: 'Horizontal overflow at a narrow mobile viewport.',
      evidence: `At 360px viewport, document scrollWidth ${data.scrollWidth}px exceeds innerWidth ${data.innerWidth}px${data.widest ? ` (widest element .${data.widest.sel} is ${data.widest.w}px wide)` : ''}. Viewport meta ${data.hasViewportMeta ? 'present' : 'MISSING'}.`,
      suggestedFix:
        'Replace fixed pixel widths with width: 100%; max-width: <n> and box-sizing: border-box so the layout adapts down to small screens. Ensure a meta viewport is present.',
      effort: 'small',
      scenario: 'fixed-layout',
    });
  }
  return {
    pathId: 'fixed-layout',
    conditions: ['viewport: 360x800'],
    findings,
  };
}

// adapt-to-the-form-factor / input-modality-aware (focus visibility)
// (poor-focus scenario: outline:none with no :focus-visible replacement)
async function checkFocusVisible(client, baseUrl, log) {
  const url = routeUrl(baseUrl, '#poor-focus');
  await navigate(client, url, { settleMs: 200, log });

  const data = await evaluate(client, () => {
    const btn = document.querySelector('.pf-btn');
    if (!btn) return { present: false };
    // Inspect author stylesheets for outline removal and any :focus-visible rule
    // that restores a visible outline.
    let outlineNone = false;
    let focusVisibleOutline = false;
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;
      for (const rule of rules) {
        const text = rule.cssText || '';
        if (/\.pf-btn\b/.test(text) && /outline\s*:\s*none/.test(text)) {
          outlineNone = true;
        }
        if (/:focus-visible/.test(text) && /outline/.test(text) && !/outline\s*:\s*none/.test(text)) {
          focusVisibleOutline = true;
        }
      }
    }
    // Also measure the computed focus outline by focusing the button.
    btn.focus();
    const cs = getComputedStyle(btn);
    return {
      present: true,
      outlineNone,
      focusVisibleOutline,
      computedOutlineWidth: cs.outlineWidth,
      computedOutlineStyle: cs.outlineStyle,
    };
  });

  const findings = [];
  if (data.present) {
    const noVisibleFocus =
      data.outlineNone &&
      !data.focusVisibleOutline &&
      (data.computedOutlineStyle === 'none' ||
        parseFloat(data.computedOutlineWidth) === 0);
    if (noVisibleFocus) {
      findings.push({
        principleId: 'adapt-to-the-form-factor',
        principleCheckId: 'input-modality-aware',
        severity: 'high',
        confidence: 'high',
        guidanceCategory: 'accessibility',
        summary: 'Focus outline removed with no :focus-visible replacement.',
        evidence: `.pf-btn sets outline: none and no :focus-visible rule restores an outline; when focused the computed outline is ${data.computedOutlineStyle} / ${data.computedOutlineWidth}, leaving keyboard users with no visible focus indicator.`,
        suggestedFix:
          'Remove the blanket outline: none and add a .pf-btn:focus-visible { outline: 3px solid <color>; outline-offset: 2px } rule so keyboard focus is clearly indicated without affecting pointer clicks.',
        effort: 'trivial',
        scenario: 'poor-focus',
      });
    }
  }
  return {
    pathId: 'poor-focus',
    conditions: ['keyboard-only'],
    findings,
  };
}

// adapt-to-the-form-factor / responsive-no-horizontal-scroll (CLS)
// (layout-shift scenario: late banner with no reserved space)
async function checkLayoutShift(client, baseUrl, log) {
  const url = routeUrl(baseUrl, '#layout-shift');
  // Install a layout-shift PerformanceObserver before the banner injects, then
  // wait past the 600ms injection.
  await navigate(client, url, { settleMs: 0, log });
  await client.Runtime.evaluate({
    expression: `
      window.__cls = 0;
      window.__clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__cls += entry.value;
        }
      });
      window.__clsObserver.observe({ type: 'layout-shift', buffered: true });
      // Also record whether the slot reserves space.
      const slot = document.querySelector('.ls-slot');
      window.__slotReserved = slot ? (parseFloat(getComputedStyle(slot).minHeight) || 0) : 0;
    `,
  });
  await new Promise((r) => setTimeout(r, 1100));

  const data = await evaluate(client, () => ({
    cls: window.__cls ?? 0,
    slotReserved: window.__slotReserved ?? 0,
  }));

  const findings = [];
  // The banner injection should shift content when no space is reserved.
  if (data.cls > 0.01 && data.slotReserved < 1) {
    findings.push({
      principleId: 'adapt-to-the-form-factor',
      principleCheckId: 'responsive-no-horizontal-scroll',
      severity: 'medium',
      confidence: 'high',
      guidanceCategory: 'performance',
      summary: 'Cumulative layout shift from late content with no reserved space.',
      evidence: `Observed layout-shift score ${data.cls.toFixed(3)} after load (.ls-slot reserves ${data.slotReserved}px), as the late-injected banner pushes following content down.`,
      suggestedFix:
        'Reserve the banner space up front with min-height (or aspect-ratio) on the slot so the late content does not shift surrounding layout.',
      effort: 'trivial',
      scenario: 'layout-shift',
    });
  }
  return {
    pathId: 'layout-shift',
    conditions: ['post-load layout-shift observation'],
    findings,
  };
}

// adapt-to-the-form-factor / component-level-responsiveness (container queries)
async function checkContainerQueries(client, baseUrl, log) {
  const url = routeUrl(baseUrl, '#no-container-queries');
  await navigate(client, url, { settleMs: 200, log });

  const data = await evaluate(client, () => {
    const narrow = document.querySelector('.cq-narrow');
    if (!narrow) return { present: false };
    // Is there any @container rule in author stylesheets?
    let hasContainerRule = false;
    let hasContainerType = false;
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;
      for (const rule of rules) {
        const text = rule.cssText || '';
        if (/@container/.test(text)) hasContainerRule = true;
        if (/container-type\s*:/.test(text)) hasContainerType = true;
      }
    }
    // In the narrow (240px) slot, does the card actually stack? Measure the
    // card's flex-direction inside the narrow container.
    const cardInNarrow = narrow.querySelector('.cq-card');
    const dir = cardInNarrow
      ? getComputedStyle(cardInNarrow).flexDirection
      : null;
    return { present: true, hasContainerRule, hasContainerType, narrowFlexDir: dir };
  });

  const findings = [];
  if (data.present && !data.hasContainerRule && !data.hasContainerType) {
    findings.push({
      principleId: 'adapt-to-the-form-factor',
      principleCheckId: 'component-level-responsiveness',
      severity: 'medium',
      confidence: 'medium',
      summary:
        'Reused component does not adapt to its container (no container queries).',
      evidence: `The same .cq-card stays flex-direction: ${data.narrowFlexDir} inside the 240px .cq-narrow container; no @container rule or container-type is declared, so the component responds only to the viewport, not its own width.`,
      suggestedFix:
        'Add container-type: inline-size to the wrapper and a @container (max-width: 320px) rule that stacks the card, so the component adapts to its container rather than the viewport.',
      effort: 'small',
      scenario: 'no-container-queries',
    });
  }
  return {
    pathId: 'no-container-queries',
    conditions: ['component reused at multiple container widths'],
    findings,
  };
}

// --- color helpers ---------------------------------------------------------

function relLuminanceFromCss(cssColor) {
  // Parse rgb()/rgba() into a relative luminance in [0,1]. Returns null if not
  // parseable.
  const m = String(cssColor).match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/,
  );
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number(v) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// The ordered set of detectors the runner executes against a target.
export const checks = [
  checkColorScheme,
  checkReducedMotion,
  checkHorizontalScroll,
  checkFocusVisible,
  checkLayoutShift,
  checkContainerQueries,
];
