# web-uplift audit report (fully agentic, fixed-mode guard)

- **URL:** http://localhost:8080/?mode=fixed
- **Audited at:** 2026-06-13T13:16:00Z
- **Mode under test:** fixed (the false-positive guard)
- **Status:** completed
- **Browser:** system Chrome (headless) over raw Chrome DevTools Protocol

This is the false-positive check: the same agentic evidence-gathering, run
against `?mode=fixed`, where each scenario ships its corrected CSS. The model
confirmed every seeded condition is now satisfied, so it reports **none** of the
six seeded findings.

## Verified conditions

| Scenario | Condition gathered | Result |
|---|---|---|
| no-dark-mode | computed `.ndm-card` background under `prefers-color-scheme: dark` | `rgb(30, 30, 30)` (adapts) |
| motion | `.mv-card` running animations under `prefers-reduced-motion: reduce` | 0 |
| fixed-layout | scenario element overflow at a 360x800 viewport | none (only the 58px playground-frame residual) |
| poor-focus | focused `.pf-btn` computed `outline-style` | `solid` (plus a `:focus-visible` rule) |
| no-container-queries | `.cq-narrow .cq-card` computed `flex-direction` | `column` |
| layout-shift | CLS from the layout-shift observer | 0.0041 (slot reserves space) |

## Findings (0)

_No findings. The fixed implementations satisfy every seeded condition._

## TLDR

Zero findings in fixed mode: the false-positive guard passes. Every corrected
scenario is confirmed by re-gathering the same evidence the issue-mode audit
used (computed styles under emulated preferences, layout metrics at a narrow
viewport, focus and container probes).
