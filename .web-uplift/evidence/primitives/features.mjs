import { applyConditions, emit } from '../common.mjs';
import { evaluate, navigate, sleep } from '../cdp.mjs';

// --- features primitive: modern-CSS and semantic-overlay census ------------
//
// Which modern CSS the page actually ships, read from the LIVE CSSOM: every
// same-origin stylesheet, constructable/adopted sheets, shadow-root sheets and
// inline styles. That is the point of the primitive - the dom primitive's css
// string is capped, so a grep miss in it cannot be told from a feature the page
// does not use. Plus the semantic-overlay census: native dialog / [popover] /
// details against div-based modals (role=dialog, aria-modal, high z-index).
//
// Descriptive only. It deliberately carries NO Baseline table (a vendored table
// would go stale): confirm Baseline status through Modern Web Guidance or
// webstatus.dev before calling a feature unsupported.
const FEATURE_CONDITION_CAP = 60;
const FEATURE_PROPERTY_CAP = 400;

// The features the checks care about get an unambiguous 0-or-count row, so
// "not found in the census" is readable at a glance.
const FEATURES_TRACKED = {
  atRules: ['@container', '@starting-style', '@scope', '@view-transition', '@layer', '@supports', '@property', '@media'],
  properties: [
    'container-type', 'container-name', 'anchor-name', 'position-anchor', 'position-try', 'position-try-fallbacks',
    'animation-timeline', 'scroll-timeline', 'view-timeline', 'interpolate-size', 'field-sizing', 'text-wrap',
    'text-wrap-mode', 'text-wrap-style', 'view-transition-name', 'color-scheme', 'content-visibility',
  ],
  functions: ['light-dark', 'color-mix', 'oklch', 'clamp', 'min', 'max', 'anchor', 'calc', 'var', 'env'],
  selectors: [':has(', ':is(', ':where(', '::backdrop', ':popover-open', ':user-valid', ':focus-visible', '::part(', '::slotted('],
};

function featuresExpression() {
  return `(() => {
    const count = (map, key) => { if (key) map[key] = (map[key] || 0) + 1; };
    const atRules = {};
    const conditions = {};
    const properties = {};
    const functions = {};
    const selectors = {};
    const customProperties = new Set();
    let customPropertyDeclarations = 0;
    let rulesScanned = 0;
    let sheetsScanned = 0;
    let crossOriginSheetsSkipped = 0;
    const crossOriginSheetUrls = [];
    let importedSheetsFollowed = 0;

    const scanDeclarations = (decl) => {
      if (!decl) return;
      for (let i = 0; i < decl.length; i++) {
        const prop = decl.item(i);
        if (!prop) continue;
        const name = prop.toLowerCase();
        if (name.startsWith('--')) {
          customProperties.add(name);
          customPropertyDeclarations++;
          continue;
        }
        count(properties, name);
        let value = '';
        try { value = decl.getPropertyValue(prop) || ''; } catch {}
        for (const m of value.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\\(/g)) count(functions, m[1].toLowerCase());
      }
    };

    const scanRules = (rules) => {
      for (const rule of rules) {
        rulesScanned++;
        const text = rule.cssText || '';
        const at = /^@([a-zA-Z-]+)/.exec(text);
        if (at) {
          const name = '@' + at[1].toLowerCase();
          count(atRules, name);
          const brace = text.indexOf('{');
          const prelude = (brace === -1 ? text : text.slice(0, brace)).replace(/\\s+/g, ' ').trim();
          // The condition text of conditional at-rules is the signal (e.g.
          // "@media (prefers-color-scheme: dark)"); @font-face/@keyframes/@property
          // preludes are just names, so they are not conditions.
          if (prelude && ['@media', '@supports', '@container', '@scope'].includes(name)) {
            count(conditions, prelude.slice(0, 120));
            for (const m of prelude.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\\(/g)) count(functions, m[1].toLowerCase());
          }
          if (name === '@import') {
            try {
              const imported = rule.styleSheet;
              if (imported && imported.cssRules && imported.cssRules.length) { importedSheetsFollowed++; scanRules(imported.cssRules); }
            } catch { noteSkippedSheet(rule.styleSheet); }
          }
        }
        if (rule.selectorText) {
          // Functional and non-functional alike: ::backdrop and :popover-open are
          // the overlay/dismiss signals, and they carry no parentheses, so a
          // "("-only match would miss them.
          for (const m of rule.selectorText.matchAll(/(:{1,2}[a-zA-Z-]+)(\\(?)/g)) count(selectors, m[1].toLowerCase() + (m[2] ? '(' : ''));
        }
        scanDeclarations(rule.style);
        if (rule.cssRules && rule.cssRules.length) scanRules(rule.cssRules);
      }
    };

    // Where styles can live: document sheets, constructable/adopted sheets, and
    // per-shadow-root sheets (bounded, so a pathological page cannot stall this).
    const sheets = [];
    const seen = new Set();
    const addSheet = (sheet) => { if (sheet && !seen.has(sheet)) { seen.add(sheet); sheets.push(sheet); } };
    for (const s of document.styleSheets) addSheet(s);
    for (const s of document.adoptedStyleSheets || []) addSheet(s);
    const shadowRoots = [];
    const walkShadow = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && shadowRoots.length < 200) { shadowRoots.push(el.shadowRoot); walkShadow(el.shadowRoot); }
      }
    };
    walkShadow(document);
    for (const sr of shadowRoots) {
      for (const s of sr.styleSheets || []) addSheet(s);
      for (const s of sr.adoptedStyleSheets || []) addSheet(s);
    }
    const noteSkippedSheet = (sheet) => {
      crossOriginSheetsSkipped++;
      const href = sheet && typeof sheet.href === 'string' ? sheet.href : null;
      if (href && crossOriginSheetUrls.length < 5 && !crossOriginSheetUrls.includes(href)) crossOriginSheetUrls.push(href);
    };

    for (const sheet of sheets) {
      sheetsScanned++;
      try {
        const rules = sheet.cssRules;
        if (rules && rules.length) scanRules(rules);
      } catch { noteSkippedSheet(sheet); }
    }

    let inlineStyleElements = 0;
    for (const el of document.querySelectorAll('[style]')) {
      if (el.style && el.style.length) { inlineStyleElements++; scanDeclarations(el.style); }
    }

    // Native overlay primitives vs div-based modals.
    const overlays = {
      dialogElements: document.querySelectorAll('dialog').length,
      openDialogs: document.querySelectorAll('dialog[open]').length,
      popoverElements: document.querySelectorAll('[popover]').length,
      openPopovers: 0,
      detailsElements: document.querySelectorAll('details').length,
      roleDialogElements: document.querySelectorAll('[role="dialog"],[role="alertdialog"]').length,
      ariaModalElements: document.querySelectorAll('[aria-modal]').length,
    };
    try { overlays.openPopovers = document.querySelectorAll(':popover-open').length; } catch {}

    // High z-index elements are the div-based-modal smell; bounded scan.
    const HIGH_Z = 50;
    const all = document.querySelectorAll('*');
    const elementsScanned = Math.min(all.length, 2000);
    let highZIndexCount = 0;
    let highZIndexMax = 0;
    const highZIndexExamples = [];
    for (let i = 0; i < elementsScanned; i++) {
      const el = all[i];
      let z = NaN;
      try { z = parseInt(getComputedStyle(el).zIndex, 10); } catch {}
      if (Number.isFinite(z) && z >= HIGH_Z) {
        highZIndexCount++;
        if (z > highZIndexMax) highZIndexMax = z;
        if (highZIndexExamples.length < 5) {
          highZIndexExamples.push({ tag: el.tagName.toLowerCase(), id: el.id || null, class: typeof el.className === 'string' ? el.className.slice(0, 40) : null, zIndex: z });
        }
      }
    }

    return {
      sheets: { count: sheetsScanned, crossOriginSkipped: crossOriginSheetsSkipped, crossOriginSheetUrls, shadowRootsScanned: shadowRoots.length, importedSheetsFollowed, rulesScanned, inlineStyleElements },
      atRules, conditions, properties, functions, selectors,
      customProperties: { distinct: customProperties.size, declarations: customPropertyDeclarations, examples: [...customProperties].slice(0, 10) },
      overlays: { ...overlays, highZIndexThreshold: HIGH_Z, highZIndexCount, highZIndexMax, highZIndexExamples, elementsScanned, elementTotal: all.length, elementsCapped: all.length > elementsScanned },
    };
  })()`;
}

// Counts sorted by frequency, capped with the cap reported (the 1s8 convention).
function topFeatureCounts(map, cap) {
  const entries = Object.entries(map || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    items: Object.fromEntries(entries.slice(0, cap)),
    total: entries.length,
    truncated: entries.length > cap,
  };
}

function trackedFeatures(census, key, names) {
  return Object.fromEntries(names.map((name) => [name, census?.[key]?.[name] || 0]));
}

export async function features(client, url, opts, log) {
  await navigate(client, url, {
    settleMs: opts.wait ?? 1200,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  await sleep(150);
  const census = await evaluate(client, featuresExpression());
  const properties = topFeatureCounts(census.properties, FEATURE_PROPERTY_CAP);
  const conditions = topFeatureCounts(census.conditions, FEATURE_CONDITION_CAP);
  log(
    `[evidence] features: ${census.sheets.count} sheet(s), ${census.sheets.rulesScanned} rule(s), ` +
      `${properties.total} distinct propert${properties.total === 1 ? 'y' : 'ies'}, ${Object.keys(census.atRules).length} at-rule kind(s)`,
  );

  const result = {
    primitive: 'features',
    url,
    scannedAt: new Date().toISOString(),
    censusComplete: census.sheets.crossOriginSkipped === 0,
    sheets: census.sheets,
    tracked: {
      atRules: trackedFeatures(census, 'atRules', FEATURES_TRACKED.atRules),
      properties: trackedFeatures(census, 'properties', FEATURES_TRACKED.properties),
      functions: trackedFeatures(census, 'functions', FEATURES_TRACKED.functions),
      selectors: trackedFeatures(census, 'selectors', FEATURES_TRACKED.selectors),
    },
    atRules: census.atRules,
    conditions: conditions.items,
    conditionsTotal: conditions.total,
    conditionsTruncated: conditions.truncated,
    properties: properties.items,
    propertiesTotal: properties.total,
    propertiesTruncated: properties.truncated,
    functions: census.functions,
    selectors: census.selectors,
    customProperties: census.customProperties,
    overlays: census.overlays,
    note:
      'Modern-CSS and overlay census read from the LIVE CSSOM (document sheets, adopted/constructable sheets, shadow-root sheets, inline styles - see `sheets` for what was scanned) and the DOM. `censusComplete: false` means at least one sheet could not be read (cross-origin without CORS, listed in `sheets.crossOriginSheetUrls`), so the census is PARTIAL: a zero in `tracked` is only conclusive when censusComplete is true, and when it is false the missing sheets have to be checked another way before concluding a feature is unused. `tracked` gives a 0-or-count row per feature the relevant checks turn on, and a zero means "not found anywhere we looked", not "unsupported": Baseline status must be confirmed against Modern Web Guidance or webstatus.dev rather than from memory. Counts are declarations/rules, not elements, and declarations come back through the CSSOM, so a shorthand may be reported as its longhands (text-wrap as text-wrap-mode + text-wrap-style). `overlays` contrasts native dialog / [popover] / details with div-based modals (role=dialog, aria-modal, high z-index). Descriptive signal, not a verdict: judge against component-level-responsiveness, anchored-positioning, semantic-dismissible-primitives and respects-color-scheme.',
  };
  return emit(opts, result, client);
}

