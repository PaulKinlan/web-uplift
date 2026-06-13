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
| fixed-layout | horizontal overflow at a 360x800 viewport | 0px (the shell grid collapses below 640px) |
| poor-focus | focused `.pf-btn` computed `outline-style`; axe color-contrast | `solid` (+ `:focus-visible`); 0 violations |
| no-container-queries | `.cq-narrow .cq-card` computed `flex-direction` | `column` |
| layout-shift | CLS from the layout-shift observer | 0.0041 (slot reserves space) |
| site-wide | meta description, favicon, Lighthouse | present; present (no 404); 100/100/100/100 |

## Findings (0)

_No findings. The live playground satisfies every seeded condition and scores
100 across the Lighthouse dimensions._

## Applicability under the expanded set

The audit honoured the repo's [web-uplift.json](../web-uplift.json). All nine
default-expectation principles in play **pass**. The contextual framework-derived
principles are reported **not-applicable** / **opted-out** with a rationale, the
same way as on the fixture, so nothing is shamed:

| Principle | Outcome | Why |
|---|---|---|
| be-private-and-secure | not-applicable | bare localhost static host; no transport/headers/auth to assess |
| be-resilient | opted-out (web-uplift.json) | client-rendered modern-UX demo; offline/installable out of scope |
| be-internationalised | not-applicable | single-locale English demo, no locale-sensitive data |
| be-sustainable | not-applicable | tiny demo, weight already minimal (web-uplift.json intent) |
| be-agent-ready | opted-out (web-uplift.json) | static UX demo, no agent-facing surface |

This is the precision guard: the wider principle set adds zero false positives,
and the contextual principles resolve to n/a / opted-out rather than issues.

## TLDR

Zero findings on the live playground: the product guard passes. Every fixed
scenario is confirmed by re-gathering the same evidence the fixture audit used
(computed styles under emulated preferences, layout metrics at a narrow
viewport, focus and container probes, plus Lighthouse and an injected axe-core
run). Lighthouse a11y/best-practices/seo/perf all 100.
