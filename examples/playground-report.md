# web-uplift audit report

- **URL:** http://localhost:8080/
- **Audited at:** 2026-06-13T11:51:08.845Z
- **Mode under test:** issues
- **Status:** completed
- **Browser:** system Chrome (headless) via Chrome DevTools Protocol (chrome-remote-interface)

## Eval vs ground truth

| Metric | Value |
|---|---|
| Expected scenarios | 6 |
| Detected (true positives) | 6 |
| Missed (false negatives) | 0 |
| Spurious (false positives) | 0 |
| **Precision** | **100%** |
| **Recall** | **100%** |


Principle alignment (ground truth uses pre-rename ids; mapped to current):

| Scenario | Expected principle | Found principle | Aligned |
|---|---|---|---|
| fixed-layout | adapt-to-the-form-factor | adapt-to-the-form-factor | yes |
| no-dark-mode | respect-user-preferences | respect-user-preferences | yes |
| poor-focus | adapt-to-the-form-factor | adapt-to-the-form-factor | yes |
| layout-shift | adapt-to-the-form-factor | adapt-to-the-form-factor | yes |
| motion | respect-user-preferences | respect-user-preferences | yes |
| no-container-queries | adapt-to-the-form-factor | adapt-to-the-form-factor | yes |

## Findings (6)

### F-001 - No dark-mode adaptation: the surface ignores prefers-color-scheme: dark.

- **Severity:** high (confidence high)
- **Principle:** respect-user-preferences / respects-color-scheme
- **Path:** http://localhost:8080/#no-dark-mode
- **Evidence:** Under emulated prefers-color-scheme: dark, .ndm-card background is rgb(255, 255, 255) (computed color-scheme: "light dark") with no color-scheme: dark declared, so it stays a light surface.
- **Suggested fix:** Declare color-scheme: light dark and use light-dark() (or a prefers-color-scheme: dark block) for surface and text colors so the card follows the user preference. See Modern Web Guidance id dark-mode.

### F-002 - Animation keeps running under prefers-reduced-motion: reduce.

- **Severity:** high (confidence high)
- **Principle:** respect-user-preferences / respects-reduced-motion
- **Path:** http://localhost:8080/#motion
- **Evidence:** Under emulated prefers-reduced-motion: reduce, .mv-card still has 1 running animation(s) (animation-name "mv-slide", duration 0.8s).
- **Suggested fix:** Gate the animation behind @media (prefers-reduced-motion: no-preference) so it only runs when the user has not requested reduced motion.

### F-003 - Horizontal overflow at a narrow mobile viewport.

- **Severity:** high (confidence high)
- **Principle:** adapt-to-the-form-factor / responsive-no-horizontal-scroll
- **Path:** http://localhost:8080/#fixed-layout
- **Evidence:** At 360px viewport, document scrollWidth 1518px exceeds innerWidth 1440px. Viewport meta present.
- **Suggested fix:** Replace fixed pixel widths with width: 100%; max-width: <n> and box-sizing: border-box so the layout adapts down to small screens. Ensure a meta viewport is present.

### F-004 - Focus outline removed with no :focus-visible replacement.

- **Severity:** high (confidence high)
- **Principle:** adapt-to-the-form-factor / input-modality-aware
- **Path:** http://localhost:8080/#poor-focus
- **Evidence:** .pf-btn sets outline: none and no :focus-visible rule restores an outline; when focused the computed outline is none / 3px, leaving keyboard users with no visible focus indicator.
- **Suggested fix:** Remove the blanket outline: none and add a .pf-btn:focus-visible { outline: 3px solid <color>; outline-offset: 2px } rule so keyboard focus is clearly indicated without affecting pointer clicks.

### F-005 - Cumulative layout shift from late content with no reserved space.

- **Severity:** medium (confidence high)
- **Principle:** adapt-to-the-form-factor / responsive-no-horizontal-scroll
- **Path:** http://localhost:8080/#layout-shift
- **Evidence:** Observed layout-shift score 0.012 after load (.ls-slot reserves 0px), as the late-injected banner pushes following content down.
- **Suggested fix:** Reserve the banner space up front with min-height (or aspect-ratio) on the slot so the late content does not shift surrounding layout.

### F-006 - Reused component does not adapt to its container (no container queries).

- **Severity:** medium (confidence medium)
- **Principle:** adapt-to-the-form-factor / component-level-responsiveness
- **Path:** http://localhost:8080/#no-container-queries
- **Evidence:** The same .cq-card stays flex-direction: row inside the 240px .cq-narrow container; no @container rule or container-type is declared, so the component responds only to the viewport, not its own width.
- **Suggested fix:** Add container-type: inline-size to the wrapper and a @container (max-width: 320px) rule that stacks the card, so the component adapts to its container rather than the viewport.

## Prioritised task list

1. No dark-mode adaptation: the surface ignores prefers-color-scheme: dark. - F-001
2. Animation keeps running under prefers-reduced-motion: reduce. - F-002
3. Horizontal overflow at a narrow mobile viewport. - F-003
4. Focus outline removed with no :focus-visible replacement. - F-004
5. Cumulative layout shift from late content with no reserved space. - F-005
6. Reused component does not adapt to its container (no container queries). - F-006
