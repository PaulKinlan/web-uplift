# web-uplift audit report (fully agentic, live-product guard)

- **URL:** http://localhost:8080/ (the genuinely-fixed live
  [playground/](../playground/), default mode)
- **Audited at:** 2026-06-13T13:46:00Z
- **Mode under test:** live product (the false-positive / regression guard)
- **Status:** completed
- **Browser:** system Chrome (headless) over raw Chrome DevTools Protocol

This is the product guard: the same agentic evidence-gathering, run against the
live playground, which is correct by default. The model confirmed every seeded
condition is now satisfied, so it reports **none** of the nine ground-truth
findings. (The eval fixture's `?mode=fixed` run is an equivalent check for the
six CSS scenarios.)

## Verified conditions

| Scenario | Condition gathered | Result |
|---|---|---|
| no-dark-mode | computed `.ndm-card` background under `prefers-color-scheme: dark` | `rgb(30, 30, 30)` (adapts) |
| motion | `.mv-card` running animations under `prefers-reduced-motion: reduce` | 0 |
| fixed-layout | scenario element overflow at a 360x800 viewport | none (only the 58px playground-frame residual) |
| poor-focus | focused `.pf-btn` computed `outline-style`; axe color-contrast | `solid` (+ `:focus-visible`); 0 violations |
| no-container-queries | `.cq-narrow .cq-card` computed `flex-direction` | `column` |
| layout-shift | CLS from the layout-shift observer | 0.0041 (slot reserves space) |
| site-wide | meta description, favicon, Lighthouse | present; present (no 404); 100/100/100/100 |

## Findings (0)

_No findings. The live playground satisfies every seeded condition and scores
100 across the Lighthouse dimensions._

## TLDR

Zero findings on the live playground: the product guard passes. Every fixed
scenario is confirmed by re-gathering the same evidence the fixture audit used
(computed styles under emulated preferences, layout metrics at a narrow
viewport, focus and container probes, plus Lighthouse and an injected axe-core
run). Lighthouse a11y/best-practices/seo/perf all 100.
