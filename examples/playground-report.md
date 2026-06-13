# web-uplift audit report (fully agentic)

- **URL:** http://localhost:8090/ (the seeded-issues eval fixture,
  [eval/fixtures/seeded-issues/site](../eval/fixtures/seeded-issues/site))
- **Audited at:** 2026-06-13T13:45:00Z
- **Mode under test:** issues (default)
- **Status:** completed
- **How:** fully agentic. The model (not a deterministic runner) gathered
  multi-modal evidence with the repo's evidence primitives, chose its own tools,
  reasoned over the evidence, and judged all fifteen principles (the expanded
  set, [docs/principles-analysis.md](../docs/principles-analysis.md), adopted
  2026-06-13).
- **Browser:** system Chrome (headless) over raw Chrome DevTools Protocol
  (chrome-remote-interface). Video assembled with the system ffmpeg.

> This audit's subject is the frozen **eval fixture**, which preserves the
> seeded modern-UX issues as ground truth. The genuinely-fixed live
> [playground/](../playground/) reports **zero** of these findings (see the eval
> section below). This separation is the point: the fixture proves recall, the
> live playground proves the fixes are real.

## Evidence the model gathered

| Modality | Tool | Used for |
|---|---|---|
| DOM + local source | `evidence dom --source` | recon, CSS inspection, confirming hard-coded values |
| Computed styles + ad-hoc probes | `evidence dom --selector`, `evidence evaluate --expr` | colour-scheme adaptation, focus outline, animation state, container flex-direction |
| Screenshot | `evidence screenshot` | the white card under dark; the clipped hero at 360px; the focused button |
| Transition video | `evidence video --emulate-media prefers-reduced-motion=reduce` | the marquee still sliding under reduced-motion |
| Layout metrics + CLS + long tasks | `evidence layout` | horizontal overflow at 360px; CLS from the late banner |
| Heap summary | `evidence heap` | object population baseline (no leak found this run) |
| Lighthouse | `npx lighthouse` (model's choice) | be-fast-and-stable / be-inclusive / follow-best-practices / be-discoverable |
| axe-core | injected from CDN via `evidence evaluate` (model's choice) | independent confirmation of the contrast violation |

### Artifacts manifest

Each artifact below is recorded in `report.json` under `artifacts[]` with its
type, path, capture condition, and the findings it evidences. Screenshots are
embedded inline at the findings they back; the rest are linked. All paths are
under [examples/evidence/](evidence/).

| Type | Artifact | Condition | Evidences |
|---|---|---|---|
| screenshot | [no-dark-mode-dark.png](evidence/no-dark-mode-dark.png) | prefers-color-scheme: dark | F-001 |
| video | [motion-under-reduce.mp4](evidence/motion-under-reduce.mp4) | prefers-reduced-motion: reduce | F-002 |
| screenshot | [fixed-layout-360.png](evidence/fixed-layout-360.png) | viewport: 360x800 | F-003 |
| screenshot | [poor-focus.png](evidence/poor-focus.png) | keyboard focus | F-004, F-007 |
| trace | [trace.json](evidence/trace.json) (devtools-loadable) + [trace-summary.json](evidence/trace-summary.json) | default load | F-005 |
| har | [network.har](evidence/network.har) (HAR 1.2) | default load | F-009 |
| heap | [heap-summary.json](evidence/heap-summary.json) | default load | - |
| lighthouse | [lighthouse-summary.json](evidence/lighthouse-summary.json) | default load | F-007, F-008, F-009 |

The `trace` primitive recorded FCP/LCP at ~33ms with 0 long tasks and 0ms total
blocking time over a ~1.7s window; the `har` primitive captured 11 requests
(10x 200, 1x 404 - the favicon, which backs F-009). The raw `trace.json` opens
in the DevTools Performance panel; the model reads `trace-summary.json` instead.

## Eval vs ground truth

The audit found **all nine ground-truth findings** in
[eval/fixtures/seeded-issues/expected-findings.json](../eval/fixtures/seeded-issues/expected-findings.json),
each mapped to the correct principle check, with zero false positives. The
genuinely-fixed live [playground/](../playground/), audited the same way,
surfaced **none** of them.

| Metric | Value |
|---|---|
| Ground-truth findings (fixture) | 9 |
| Found (true positives) | 9 |
| Missed (false negatives) | 0 |
| Spurious | 0 |
| **Recall on the fixture** | **100% (9/9)** |
| **Precision** | **100%** |
| **Live playground seeded findings** | **0** |

Six findings are the seeded CSS scenarios; three (F-007 contrast, F-008 meta
description, F-009 console 404) are document-level findings the model surfaced by
choosing to run Lighthouse and axe. That is the point of the agentic design: the
model judged principles (be-inclusive, be-discoverable, follow-best-practices)
that no hand-written check covered.

### Applicability under the expanded set (quality without shaming)

The expansion from 9 to 15 principles added no spurious fixture findings. The
nine default-expectation principles in play were judged for real (six surfaced
the seeded findings; implement-natural-interactions, provide-guided-navigation,
maximize-content-reduce-noise and be-trustworthy passed). The contextual
framework-derived principles were judged **not-applicable** / **opted-out** with
a rationale rather than penalised:

| Principle | Outcome | Why |
|---|---|---|
| be-private-and-secure | not-applicable | bare localhost static host; no transport/headers/auth to assess (the favicon 404 is captured under follow-best-practices as F-009) |
| be-resilient | not-applicable | client-rendered CSS-scenario demo; offline/installable out of scope, the no-JS shell is a shared harness property |
| be-internationalised | not-applicable | single-locale English demo, no locale-sensitive data |
| be-sustainable | not-applicable | tiny hand-authored demo, weight already minimal (judged proportionally) |
| be-agent-ready | opted-out | static UX demo with no agent-facing surface |

The two new-principle observations on the served site (no CSP header; a blank
no-JS shell) are properties of the bare `npx serve` host and demo harness, and
are present identically on the genuinely-fixed live playground. Counting them as
fixture findings would be dishonest, so the seeded ground truth stays at nine.

## Findings (9)

### F-001 (high) Surface ignores prefers-color-scheme: dark and stays a light card

- **Principle:** respect-user-preferences / respects-color-scheme
- **Guidance:** dark-mode (user-experience)
- **Evidence:** under emulated `prefers-color-scheme: dark`, a computed-style
  probe and a clipped screenshot of `.ndm-card` show background
  `rgb(255, 255, 255)`. The card hard-codes `#ffffff` with no `light-dark()`.
- **Fix:** declare `color-scheme: light dark` and use
  `light-dark(#ffffff, #1e1e1e)` for surfaces. Guidance id `dark-mode`.

![.ndm-card white under prefers-color-scheme: dark](evidence/no-dark-mode-dark.png)

### F-002 (high) Animation keeps running under prefers-reduced-motion: reduce

- **Principle:** respect-user-preferences / respects-reduced-motion
- **Evidence:** under emulated `prefers-reduced-motion: reduce`,
  `.mv-card.getAnimations()` returned 1 running animation (`mv-slide`); a 2.5s
  transition video recorded under the reduce preference shows it still sliding.
- **Fix:** gate the animation behind
  `@media (prefers-reduced-motion: no-preference)`.
- **Artifact:** [motion-under-reduce.mp4](evidence/motion-under-reduce.mp4)
  (transition video under the reduce preference).

### F-003 (high) Fixed 1200px layout overflows a narrow mobile viewport

- **Principle:** adapt-to-the-form-factor / responsive-no-horizontal-scroll
- **Evidence:** at an emulated 360x800 viewport the layout primitive reported
  **1158px** of horizontal overflow (scrollWidth vs visualViewport.width 360); a
  360px screenshot shows `.fl-hero` (~1264px) clipped.
- **Fix:** `width: 100%; max-width: 1200px; box-sizing: border-box`.

![.fl-hero clipped at a 360px viewport](evidence/fixed-layout-360.png)

### F-004 (high) Focus outline removed with no :focus-visible replacement

- **Principle:** adapt-to-the-form-factor / input-modality-aware
- **Evidence:** an evaluate probe that focuses `.pf-btn` reads
  `outline-style: none`; CSS has `outline: none` and no `:focus-visible` rule.
- **Fix:** add
  `.pf-btn:focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px }`.

![focused .pf-btn with no visible outline](evidence/poor-focus.png)

### F-005 (medium) Cumulative layout shift from a late banner with no reserved space

- **Principle:** be-fast-and-stable / visual-stability
- **Evidence:** the layout primitive's layout-shift observer recorded CLS
  **0.0118** across 2 shifts as a banner injected at ~600ms pushed content down;
  `.ls-slot` reserves no height.
- **Fix:** reserve the banner's height up front with `min-height` (or
  `aspect-ratio`) on `.ls-slot`.
- **Artifact:** [trace-summary.json](evidence/trace-summary.json) (FCP/LCP ~33ms,
  0 long tasks, 0ms total blocking) and the devtools-loadable
  [trace.json](evidence/trace.json).

### F-006 (medium) Reused component does not adapt to its container

- **Principle:** adapt-to-the-form-factor / component-level-responsiveness
- **Guidance:** size-aware-styling (user-experience)
- **Evidence:** an evaluate probe found `.cq-card` stays `flex-direction: row`
  inside the 240px `.cq-narrow` container, with no `@container`/`container-type`.
- **Fix:** `container-type: inline-size` on the wrapper and a
  `@container (max-width: 320px)` rule that stacks the card.

### F-007 (high) Buttons fail WCAG colour-contrast minimums

- **Principle:** be-inclusive / sufficient-contrast
- **Evidence:** Lighthouse (accessibility 91) flagged `color-contrast: 0` on the
  three `.pf-btn` buttons; axe-core, injected from CDN via the evaluate
  primitive and run in-page, independently reported one serious
  `color-contrast` violation across 3 nodes. Not a seeded CSS scenario; surfaced
  by the Lighthouse-dimension principles.
- **Fix:** raise button text/background contrast to at least 4.5:1; re-verify
  with axe / Lighthouse.

### F-008 (low) No meta description

- **Principle:** be-discoverable / title-and-description
- **Evidence:** Lighthouse SEO (90) reported `meta-description: 0`; the recon
  DOM dump confirms a `<title>` but no `<meta name="description">`.
- **Fix:** add a concise `<meta name="description">` to the head.

### F-009 (low) A resource 404s in the console on load

- **Principle:** follow-best-practices / no-console-errors
- **Evidence:** Lighthouse best-practices (96) reported `errors-in-console: 0`
  with one 404 (the favicon, under the bare static server with no
  `<link rel=icon>`). Adding a favicon eliminates it.
- **Fix:** add a favicon (e.g. an inline `data:` SVG `<link rel="icon">`).
- **Artifact:** [network.har](evidence/network.har) - the 404 entry (request 11
  of 11) is the missing favicon.

## Prioritised task list

1. Adopt color-scheme + light-dark() so the card follows the dark preference (F-001, guidance: dark-mode)
2. Gate the marquee animation behind prefers-reduced-motion: no-preference (F-002)
3. Make the fixed 1200px layout fluid (F-003)
4. Restore a visible keyboard focus indicator with :focus-visible (F-004)
5. Raise button colour contrast to meet WCAG AA (F-007)
6. Reserve space for the late banner to remove the layout shift (F-005)
7. Use a container query so the reused card adapts to its container (F-006, guidance: size-aware-styling)
8. Add a meta description (F-008)
9. Add a favicon to eliminate the console 404 on load (F-009)

## TLDR

9 findings: 4 high, 2 medium, 3 low. Modalities used: DOM+source, computed-style
and ad-hoc evaluate probes, screenshots, a reduced-motion transition video,
layout metrics + a CLS observer, a heap summary, plus Lighthouse and an
injected axe-core run. Recall on the nine ground-truth findings was 100% with
zero false positives, and the genuinely-fixed live playground surfaced none of
them (Lighthouse 100/100/100/100). Highest-leverage fix: adopt `color-scheme` +
`light-dark()` so the UI respects the user's dark preference.
