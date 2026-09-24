# Hill-climb optimizer verification (bead ci5)

**Date:** 2026-09-24
**Bead:** `web-uplift-ci5` "Verify hill-climb optimizer against latest Baseline web standards"
**Lane:** `uplift-ds-flash` (deepseek-v4-flash), worktree `/home/paulkinlan/worktrees/uplift-ds-flash-aoo`
**Subject:** `eval/fixtures/seeded-issues/site` on `:8090`, `playground/` on `:8080`
**Verdict:** the model-driven hill-climb converges and uses native Baseline APIs, with no
libraries and no polyfills added. It also surfaced one real defect in the eval fixture's
false-positive guard, fixed on this branch.

This is a verification report on the fixer, not a coverage-complete site audit. No
`report.json` check manifest is claimed here, so no score or "audited site" claim is made.

## What was verified

| # | Claim | Method | Result |
|---|---|---|---|
| 1 | Recall: an audit of the fixture surfaces all nine findings | Direct CDP evidence per finding | 9 of 9 reproduced, exact mechanism |
| 2 | Precision: `?mode=fixed` clears the six CSS scenarios | Same probe per scenario in both modes | 6 of 6 clean **after** the shell fix (5 of 6 before) |
| 3 | Precision: the live playground is clean | Lighthouse, axe, overflow probe | 4 categories 100, axe 0 violations, 0 overflow |
| 4 | The hill-climb resolves every finding | Wrote guidance-backed fixes, re-ran the finding probe | 9 of 9 resolved |
| 5 | Fixes use native Baseline APIs only | Baseline status from the pinned guidance feed + functional check in Chrome | Yes, zero dependencies added |

## Recall: the nine findings, reproduced

Measured against the frozen fixture in issue mode.

| Finding | Check | Evidence | Matches ground truth |
|---|---|---|---|
| F-001 | `respects-color-scheme` | `.ndm-card` computed `background-color: rgb(255,255,255)` under `prefers-color-scheme: dark` | yes |
| F-002 | `respects-reduced-motion` | `getAnimations()` returns 1 running `mv-slide` under `prefers-reduced-motion: reduce` | yes |
| F-003 | `responsive-no-horizontal-scroll` | `horizontalOverflowPx: 928` at `360x800` | yes, magnitude restated (see below) |
| F-004 | `input-modality-aware` | `.pf-btn` focused, `:focus-visible` matches, computed `outline-style: none` | yes |
| F-005 | `visual-stability` | layout-shift observer records 1 shift at 817ms, CLS 0.00129; 0 in fixed mode | yes |
| F-006 | `component-level-responsiveness` | `.cq-card` stays `flex-direction: row` in a 240px container, `container-type: normal` | yes |
| F-007 | `sufficient-contrast` | `.pf-btn` 1.11:1 (`#ffffff` on `#f2f2f2`) under dark; axe `color-contrast`, impact `serious`, 3 nodes | yes |
| F-008 | `title-and-description` | no `<meta name="description">` | yes |
| F-009 | `no-console-errors` | HAR `httpErrors`: `/favicon.ico` 404 | yes |

### F-007 is dark-preference dependent, and Lighthouse does not see it

`expected-findings.json` says F-007 is detectable via "Lighthouse accessibility flags
color-contrast". That is not what happens on the current toolchain:

- Lighthouse on the fixture in its default (light) emulation reports
  **accessibility 100** and `color-contrast: score=1`.
- axe-core 4.10.2 injected under `prefers-color-scheme: dark` reports the violation
  exactly as documented: 1 violation, `color-contrast`, impact `serious`, 3 nodes, 1.11:1.
- A first-party WCAG probe agrees: 0 failing pairs in light, 3 failing in dark.

The mechanism is the seeded defect itself. `.pf-btn` fixes a light `#f2f2f2` background
while inheriting colour from a `color-scheme: light dark` root, so under dark the label
resolves to near-white on light grey. The contrast failure only exists in dark mode, so a
light-only Lighthouse run cannot see it. A correct audit must emulate the dark preference
for this check, or it will miss F-007 and report a clean accessibility score.

## Precision: the guard was broken, and the shell was the cause

The fixture's six-scenario false-positive guard did not hold as shipped. At `360x800`,
`?mode=fixed` still overflowed horizontally by **58px**, so `responsive-no-horizontal-scroll`
could not pass in fixed mode no matter how the scenario itself was written.

Root cause: the fixture's page shell kept `grid-template-columns: 230px 1fr` with no narrow
viewport collapse, so the 230px sidebar plus `main`'s min-content width exceeded a 360px
viewport. The live `playground/index.html` already carries the fix, with a comment naming
exactly this failure mode:

```css
/* Collapse the shell to a single column on narrow viewports so the fixed
   230px sidebar never squeezes main into horizontal overflow. */
@media (max-width: 640px) {
  .layout { grid-template-columns: 1fr; }
  nav { border-right: none; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
}
```

The fixture is documented as a frozen copy of the playground, but it predates that rule.

Two consequences, both now resolved on this branch:

1. The guard now reaches zero. `?mode=fixed` is 0px overflow at `360x800`.
2. The seeded defect is now isolated. Issue-mode overflow drops from 1158px to **928px**,
   because the remaining overflow is entirely the scenario's own `width: 1200px` rather than
   a mixture of scenario plus shell. That makes F-003 a cleaner ground truth, and
   `expected-findings.json` has been updated to the measured 928px with a `shellNote`
   recording the reason.

## Hill-climb: fixes written and verified

The climb was run in-session (the default subscription path: the model writes every edit),
against a copy of the fixture, never the frozen original.

| Finding | Fix written | Native API | Baseline status |
|---|---|---|---|
| F-001 | Custom properties plus a `prefers-color-scheme` fallback, refined inside `@supports` | `color-scheme`, `light-dark()`, `@media prefers-color-scheme`, `@supports` | `color-scheme` Widely available (2022-02-03), `light-dark()` Newly available (2024-05-13) |
| F-002 | Animation moved inside a no-preference gate | `@media (prefers-reduced-motion: no-preference)` | Widely available |
| F-003 | Fluid width plus `box-sizing`, and the shell collapse | `max-width`, `box-sizing`, `@media` | Widely available |
| F-004 | Blanket `outline: none` removed, focus ring added | `:focus-visible` | Widely available (2022-03-14) |
| F-005 | Slot reserves the banner height up front | `min-height` | Widely available |
| F-006 | Wrapper becomes a query container, card restacks | `container-type: inline-size`, `@container` | Widely available (2023-02-14) |
| F-007 | Explicit label colour on the known fixed background | `color` | Widely available |
| F-008 | Description added to the head | `<meta name="description">` | n/a |
| F-009 | Inline SVG icon declared, so no root probe is needed | `<link rel="icon">` with a data URI | n/a |

The reservation for F-005 is grounded: the banner measures 50px at 1280px wide and 68px at a
360px viewport, so the 76px reservation covers the wrap.

### The raw end state

Sweep over the patched fixture (`scratch/ev/sweep-result.txt`), one probe per finding in each
mode:

```
MODE=issue                          MODE=fixed
F-001 dark bg   rgb(255,255,255)    F-001 dark bg   rgb(30,30,30)
F-002 anims     count 1 mv-slide    F-002 anims     count 0 none
F-003 overflow  928 px              F-003 overflow  0 px
F-004 outline   none                F-004 outline   solid 3px
F-005 cls       0.00129, 1 shift    F-005 cls       0, 0 shifts
F-006 flexdir   row, normal         F-006 flexdir   column, inline-size
F-007 contrast  3 / 13 failing      F-007 contrast  3 / 13 failing  (by design, see below)
F-008 meta      False               F-008 meta      False          (by design)
F-009 404       favicon.ico         F-009 404       favicon.ico    (by design)
```

`?mode=fixed` is only expected to clear the six CSS scenarios. The three page-level findings
are document-level and are corrected in the live `playground/`, not toggled here, which is
what the fixture's own `falsePositiveCheck` says. In the hill-climbed build all three are
resolved as well: contrast 0 failing in both schemes, meta description present, and no
404 in the HAR (request count 11 to 10).

### Closing state of the hill-climbed build

- Lighthouse: performance 100, accessibility 100, best-practices 100, seo 100.
- axe-core 4.10.2 under dark: 0 violations (was 1 serious).
- Overflow at `360x800`: 0px on all six routes.
- No dependency changes. The fixes are CSS and two head tags, no libraries, no polyfills.

## Notable by-product: `light-dark()` needs a mandated fallback

The fixture's own reference `?mode=fixed` stylesheet for F-001 uses bare `light-dark()`
with no fallback. The pinned guidance feed marks `light-dark()` **Newly available**
(2024-05-13, Chrome 123) and states the fallback is **MANDATORY** for browsers that support
`color-scheme` but not `light-dark()`. Without it those browsers drop the whole declaration
and the card loses its background and text colour.

The fix written here therefore defines the colours as custom properties, sets them from a
`prefers-color-scheme` media query for the fallback path, and only opts into `light-dark()`
inside `@supports (color: light-dark(white, black))`. A hill-climb that copies the fixture's
reference stylesheet verbatim would reproduce the unfixed gap. Worth checking whether the
live `playground/scenarios/no-dark-mode.js` should adopt the same fallback pattern.

## Residual risk and limits

- Judged at one catalog version, `modern-web-guidance@0.0.172`. Baseline statuses above come
  from that feed plus a check against MDN and webstatus.dev for `:focus-visible` and
  `prefers-reduced-motion`.
- Exercised on Chrome Stable only. The fallback paths were reasoned from the guidance and
  verified to be syntactically active, not exercised in an older engine.
- F-005's CLS of 0.00129 is small in CLS units because the shift is one paragraph in a tall
  viewport. The finding is real (a shift fires at 817ms; fixed mode has none) but it should
  not be argued on the CLS magnitude alone.
- The fixture patch changes test ground truth. It is on branch `uplift/ci5-fixture-shell-fix`
  for independent review and should land through the project merger, not directly.
