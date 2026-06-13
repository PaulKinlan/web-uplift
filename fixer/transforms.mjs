// Deterministic, guidance-backed source transforms, one per playground issue
// class. Each transform takes the text of a scenario source file and returns
// the fixed text (or the same text if it does not apply).
//
// The architecture intentionally keeps each fix as a small, named, pure
// function keyed by the principle check id, so an LLM fix path can later be
// slotted in alongside (or ahead of) the deterministic path: the fixer asks
// each registered fixer "can you resolve finding X in this file?", a
// deterministic transform answers for the known classes, and an LLM transform
// could answer for the long tail. See fixer/fix.mjs.
//
// The fixes mirror the Modern Web Guidance techniques the playground's own
// "fixed" stylesheets demonstrate (light-dark(), :focus-visible, reserved
// min-height, prefers-reduced-motion gate, @container, fluid max-width).

function replaceFirst(text, pattern, replacement) {
  if (!pattern.test(text)) return { text, changed: false };
  return { text: text.replace(pattern, replacement), changed: true };
}

// respects-color-scheme: add color-scheme + light-dark() to the hard-coded
// white card (Modern Web Guidance id: dark-mode).
function fixColorScheme(text) {
  const pattern =
    /\.ndm-card\s*\{\s*background:\s*#ffffff;\s*color:\s*#111111;\s*border:\s*1px solid #ddd;\s*\n?\s*padding:\s*1rem;\s*border-radius:\s*8px;\s*\}/;
  const replacement = `.ndm-card { color-scheme: light dark;
            background: light-dark(#ffffff, #1e1e1e);
            color: light-dark(#111111, #eeeeee);
            border: 1px solid light-dark(#dddddd, #444444);
            padding: 1rem; border-radius: 8px; }`;
  return replaceFirst(text, pattern, replacement);
}

// respects-reduced-motion: gate the marquee animation behind
// prefers-reduced-motion: no-preference.
function fixReducedMotion(text) {
  const pattern =
    /\.mv-card\s*\{\s*background:\s*#34a853;\s*color:\s*#fff;\s*padding:\s*1\.5rem;\s*border-radius:\s*8px;\s*\n?\s*animation:\s*mv-slide 0\.8s ease-in-out infinite alternate;\s*\}/;
  const replacement = `.mv-card { background: #34a853; color: #fff; padding: 1.5rem; border-radius: 8px; }
          @media (prefers-reduced-motion: no-preference) {
            .mv-card { animation: mv-slide 0.8s ease-in-out infinite alternate; }
          }`;
  return replaceFirst(text, pattern, replacement);
}

// responsive-no-horizontal-scroll (fixed-layout): replace fixed pixel widths
// with a fluid width + max-width + box-sizing.
function fixHorizontalScroll(text) {
  let changed = false;
  let out = text;
  const heroPat = /\.fl-hero\s*\{\s*width:\s*1200px;\s*padding:\s*2rem;/;
  if (heroPat.test(out)) {
    out = out.replace(
      heroPat,
      '.fl-hero { width: 100%; max-width: 1200px; box-sizing: border-box; padding: 2rem;',
    );
    changed = true;
  }
  const bodyPat = /\.fl-body\s*\{\s*width:\s*1200px;\s*margin-top:\s*1rem;\s*\}/;
  if (bodyPat.test(out)) {
    out = out.replace(
      bodyPat,
      '.fl-body { width: 100%; max-width: 1200px; margin-top: 1rem; }',
    );
    changed = true;
  }
  return { text: out, changed };
}

// input-modality-aware / focus visibility (poor-focus): drop the blanket
// outline: none and add a :focus-visible outline.
function fixFocusVisible(text) {
  const pattern =
    /\.pf-btn\s*\{\s*outline:\s*none;\s*border:\s*1px solid #888;\s*background:\s*#f2f2f2;\s*\n?\s*padding:\s*0\.5rem 1rem;\s*border-radius:\s*6px;\s*margin-right:\s*0\.5rem;\s*\}/;
  const replacement = `.pf-btn { border: 1px solid #888; background: #f2f2f2;
            padding: 0.5rem 1rem; border-radius: 6px; margin-right: 0.5rem; }
          .pf-btn:focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; }`;
  return replaceFirst(text, pattern, replacement);
}

// CLS (layout-shift): reserve the banner's space up front with min-height.
function fixLayoutShift(text) {
  const pattern = /\.ls-slot\s*\{\s*\}/;
  return replaceFirst(text, pattern, '.ls-slot { min-height: 76px; }');
}

// component-level-responsiveness (no-container-queries): add container-type and
// a @container rule that stacks the card.
function fixContainerQueries(text) {
  const pattern =
    /\.cq-wide, \.cq-narrow \{ border: 1px solid #ccc; border-radius: 8px; padding: 0\.75rem; margin-bottom: 1rem; \}/;
  if (!pattern.test(text)) return { text, changed: false };
  let out = text.replace(
    pattern,
    '.cq-wide, .cq-narrow { border: 1px solid #ccc; border-radius: 8px; padding: 0.75rem; margin-bottom: 1rem; container-type: inline-size; }',
  );
  // Add the @container rule after the .cq-thumb declaration within the issue block.
  const thumbPat =
    /(\.cq-thumb \{ width: 80px; height: 80px; background: #1a73e8; border-radius: 6px; flex: none; \}\s*)/;
  out = out.replace(
    thumbPat,
    `$1
          @container (max-width: 320px) {
            .cq-card { flex-direction: column; align-items: stretch; }
            .cq-thumb { width: 100%; }
          }
        `,
  );
  return { text: out, changed: true };
}

// Map: scenario id -> { file (relative to target root), transform, guidanceQuery }
export const TRANSFORMS = {
  'no-dark-mode': {
    file: 'scenarios/no-dark-mode.js',
    transform: fixColorScheme,
    principleCheckId: 'respects-color-scheme',
  },
  motion: {
    file: 'scenarios/motion.js',
    transform: fixReducedMotion,
    principleCheckId: 'respects-reduced-motion',
  },
  'fixed-layout': {
    file: 'scenarios/fixed-layout.js',
    transform: fixHorizontalScroll,
    principleCheckId: 'responsive-no-horizontal-scroll',
  },
  'poor-focus': {
    file: 'scenarios/poor-focus.js',
    transform: fixFocusVisible,
    principleCheckId: 'input-modality-aware',
  },
  'layout-shift': {
    file: 'scenarios/layout-shift.js',
    transform: fixLayoutShift,
    principleCheckId: 'responsive-no-horizontal-scroll',
  },
  'no-container-queries': {
    file: 'scenarios/no-container-queries.js',
    transform: fixContainerQueries,
    principleCheckId: 'component-level-responsiveness',
  },
};
