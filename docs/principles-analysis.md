# Proposal: an expanded principle set for web-uplift

Status: PROPOSAL for sign-off. This document does NOT change
`principles/principles.json`. It is the evidence and reasoning behind a
recommended expansion, so Paul can decide what (if anything) to encode.

Author: Paul Kinlan. Analysis assembled by Claude.

## TL;DR

- The Modern Web Guidance (mwg) catalog has **137 guides across 12 categories**
  (pinned: `modern-web-guidance@0.0.172`). Enumerated bottom-up, they cluster
  into ~13 themes.
- The current 9 principles cover the bulk of the **user-experience**,
  **performance**, **accessibility**, **css/layout** and **html** clusters well.
- They do **not** cover several whole clusters that the catalog and external
  frameworks both treat as first-class web quality: **privacy and security**
  (3 guides: `privacy`, `security`, plus the 6 `passkeys` guides), **forms as a
  trust/correctness surface** (15 `forms` guides, only thinly touched today),
  **internationalisation and locale-correct data** (the `built-in-ai`
  translate/detect guides plus ~9 i18n-flavoured UX guides), **resilience /
  graceful degradation**, **agentic/machine readability** (the 3 `webmcp`
  guides), and **sustainability** (not in the catalog at all, but a recognised
  external framework).
- Recommendation: keep all 9, lightly rename 2, and add **5 net-new
  principles**: be private and secure; be resilient; be internationalised; be
  trustworthy (no dark patterns); be sustainable. A 6th candidate, be agent
  ready, is flagged as optional/forward-looking.

---

## 1. The Modern Web Guidance catalog, bottom-up

### How it was enumerated

```sh
npx --yes modern-web-guidance@0.0.172 list --json
```

Returns a JSON array of `{ id, category, description }`. The CLI in this version
(`list`, `search`, `retrieve`, `install`) exposes **no `featuresUsed` field** on
either `list` or `retrieve`; the per-guide metadata is `id`, `category`,
`description` only. The featuresUsed concept mentioned in the task brief is not
surfaced by this CLI version, so the clustering below is derived from
id + category + description (and spot-checked with `retrieve`). This is an
honest limitation: the clusters are semantic, not driven by a structured
feature taxonomy the package does not ship.

Total: **137 guides**. Categories as the package reports them:

| Category | Count |
|---|---|
| user-experience | 79 |
| performance | 22 |
| forms | 15 |
| passkeys | 6 |
| built-in-ai | 4 |
| accessibility | 2 |
| css | 2 |
| webmcp | 3 |
| css-layout | 1 |
| html | 1 |
| privacy | 1 |
| security | 1 |

The package's own categories are uneven (one giant `user-experience` bucket,
several singletons). So the clustering below is bottom-up by *intent*, not by
the package's category labels.

### Bottom-up thematic clusters

**A. Motion, transitions and animation.** view transitions
(`same-document-transitions`, `cross-document-transitions`,
`consistent-cross-document-transitions`, `directional-navigation-transitions`,
`group-element-transitions`, `faster-spa-view-transitions`), entry/exit and
top-layer animation (`animate-element-entry-exit`, `animate-to-from-top-layer`,
`animate-to-intrinsic-sizes`, `dynamic-sibling-animations`), easing and
transforms (`physics-based-easing`, `individual-transform-properties`).
-> Covered by **implement-natural-interactions**.

**B. Scroll-driven UX.** `scrollytelling`, `parallax-scroll-effects`,
`scroll-entry-exit-effects`, `carousel-slide-effects`, `carousel-snap-highlights`,
`scroll-snap-realtime-feedback`, `scroll-snap-state-sync`,
`scroll-target-on-load`, `shrinking-header-on-scroll`,
`scroll-position-aware-elements`, `scroll-progress-indicator`,
`scrollability-affordance-hints`, `soft-edge-content-fade`, `pull-to-reveal`,
`swipe-to-remove`. -> Split across **implement-natural-interactions** (the
motion) and **provide-guided-navigation** (progress, position awareness,
affordance hints).

**C. Overlays, popovers, dialogs, menus.** `declarative-dialog-popover-control`,
`light-dismiss-a-dialog`, `platform-controls-dismiss-dialog`,
`persistent-top-layer-ui`, `persistent-toast-notifications`,
`persistent-app-tours`, `navigation-drawer`, `interest-triggered-tooltips`,
`interest-triggered-action-previews`, `position-aware-tooltips`,
`anchor-positioning-tab-underline`, `resilient-context-menus-and-nested-dropdowns`,
`declarative-button-actions`. -> Covered by **maximize-content-reduce-noise**
(semantic dismissible primitives) and **provide-guided-navigation** (anchored
positioning).

**D. Responsive / adaptive layout.** `fluid-scaling`, `size-aware-styling`,
`content-based-styling`, `child-state-based-styling`, `design-token-reactivity`,
`calculate-with-intrinsic-sizes`, `css-layout`, `reduce-style-repetition`,
`style-parent-with-has`, `dynamic-sibling-styling`. -> Covered by
**adapt-to-the-form-factor** and (partially) **follow-best-practices**.

**E. Theming and user-preference reactivity.** `dark-mode`,
`component-specific-light-dark-theme`, `adapt-scrollbar-to-contrast-preferences`,
`customize-scrollbar-color-and-thickness`. -> Covered by
**respect-user-preferences**.

**F. Typography, legibility, visual stability.** `improve-text-layout-and-legibility`,
`precise-text-alignment`, `prevent-text-wrapping`, `visually-stable-font-fallbacks`,
`visually-stable-mixed-fonts`. -> Split between **be-accessible**/**be-fast-and-stable**
(font-swap CLS) and a UX legibility concern that currently has no clean home.

**G. Decorative / expressive visuals.** `complex-shapes`, `shaped-cutouts`,
`overflow-clipping-control`, `visually-texture-content`, `apply-webgl-shaders`,
`interactive-content-in-3d-scenes`, `interactive-content-reveal`,
`highlight-text-ranges`, `resolution-optimized-pseudo-elements`,
`deliver-optimized-decorative-images`, `export-html-media-from-canvas`,
`expose-canvas-content-to-browser-features`. -> Mostly **maximize-content-reduce-noise**;
`deliver-optimized-decorative-images` is also **be-fast-and-stable**;
`expose-canvas-content-to-browser-features` is **be-accessible**.

**H. Performance and main-thread discipline.** the whole `performance` category:
`break-up-long-tasks`, `identify-inp-causes`, `identify-heavy-scripts`,
`schedule-tasks-by-priority`, `optimize-image-priority`,
`optimize-script-priority`, `optimize-preload-priority`,
`defer-rendering-heavy-content`, `defer-work-until-scroll-ends`,
`deprioritize-background-fetches`, `conditional-async-dependencies`,
`improve-next-page-load-performance`, `interactions-in-complex-layouts`,
`detect-initial-visibility-state`, `efficient-background-processing`,
`sequence-distributed-events`. -> Covered by **be-fast-and-stable**.

**I. Analytics / measurement.** `batch-analytics-events`, `full-session-analytics`,
`calculate-total-foreground-time`. -> Loose fit; these are a privacy and
performance concern (background work, data collection) more than UX. Currently
homeless. Mapped below to **be-private-and-secure** (data minimisation) with a
performance secondary.

**J. Accessibility (explicit).** `accessibility`, `accessible-error-announcement`,
`search-hidden-content`, `move-dom-element-without-losing-state`. -> Covered by
**be-accessible**.

**K. Forms, input and validation.** the whole `forms` category plus
`form-fields-automatically-fit-contents`. autofill (`autofill-address-form`,
`autofill-payment-form`, `autofill-sign-in-form`, `autofill-sign-up-form`,
`autofill-highlight-inputs`), humane validation (`validate-input-after-interaction`,
`required-field-feedback`, `select-menu-interaction`), custom-but-native
controls (`brand-consistent-forms`, `branded-select-styling`,
`custom-select-picker-layouts`, `animated-select-picker`, `rich-media-picker`).
-> **Partially** covered today: validation timing and labels touch
**be-accessible**; autofill correctness touches **follow-best-practices**. But
"forms are a trust and conversion surface" is not stated anywhere in the current
9. This is a real gap; see proposal.

**L. Privacy, security, authentication.** `privacy`, `security`, and the six
`passkeys` guides (`passkeys`, `passkey-registration`, `passkey-authentication`,
`passkey-reauthentication`, `passkey-conditional-create`, `passkey-management`).
-> **NOT covered.** The only adjacent check is `follow-best-practices`
> "HTTPS, no obvious security smells", which is one line and does not mention
data handling, CSP, cookies, permissions, or modern auth. **Clear gap.**

**M. Internationalisation and locale-correct data.** the `built-in-ai`
translate/detect guides (`translator`, `language-detection`) plus date/time and
locale UX: `support-global-calendar-systems`, `coordinate-global-events`,
`capture-location-agnostic-data`, `model-partial-time-concepts`,
`format-human-readable-durations`, `manage-recurring-intervals`,
`calculate-event-differentials`, `stabilize-reactive-state`. -> **NOT covered.**
No principle mentions language, locale, time zones, or calendar systems.
**Clear gap.**

**N. Agentic / machine readability.** `webmcp`, `agentic-forms`,
`agentic-javascript-tools`, plus on-device inference (`language-model`,
`summarizer`). -> **NOT covered.** Forward-looking. Optional.

### What the current 9 cover well vs not

| Cluster | Current coverage |
|---|---|
| A Motion/transitions | Well covered (natural-interactions) |
| B Scroll UX | Well covered (natural-interactions + guided-navigation) |
| C Overlays/dialogs | Well covered (maximize-content + guided-navigation) |
| D Responsive layout | Well covered (adapt-to-form-factor) |
| E Theming/preferences | Well covered (respect-user-preferences) |
| F Typography/stability | Partial (CLS yes, legibility has no clean home) |
| G Decorative visuals | Well covered (maximize-content + fast-and-stable) |
| H Performance | Well covered (fast-and-stable) |
| I Analytics/measurement | Not covered (privacy/perf) |
| J Accessibility | Well covered (be-accessible) |
| K Forms | **Partial / weak** |
| L Privacy/security/auth | **Not covered** |
| M i18n/locale | **Not covered** |
| N Agentic/machine | **Not covered** |
| (Sustainability) | **Not in catalog, not covered** |

---

## 2. External principle frameworks and what they would add

Each row: the framework, a source link, and what it contributes that the
current 9 do not capture.

**WCAG 2.2 / POUR (Perceivable, Operable, Understandable, Robust).**
https://www.w3.org/TR/WCAG22/ . `be-accessible` already encodes most of P, O,
and R. The gap is **Understandable**: predictable behaviour, input assistance,
error prevention and recovery, consistent navigation. That maps onto the forms
cluster (K) and onto a trustworthiness principle (clear errors, no surprises).
Also reinforces i18n via the `lang` attribute and reading-level guidance.

**Nielsen's 10 usability heuristics.**
https://www.nngroup.com/articles/ten-usability-heuristics/ . Several map to
existing principles (visibility of system status -> guided-navigation;
aesthetic and minimalist design -> maximize-content; match between system and
real world -> natural-interactions). The ones with **no current home**: "error
prevention", "help users recognise, diagnose and recover from errors", "user
control and freedom" (undo, escape hatches), and "consistency and standards".
These argue for a **trustworthy / humane** principle and reinforce forms.

**Google RAIL (Response, Animation, Idle, Load).**
https://web.dev/articles/rail . Fully subsumed by `be-fast-and-stable` plus
Core Web Vitals. No new principle; useful as backing evidence for the INP/long-
task checks.

**Core Web Vitals (LCP, INP, CLS).**
https://web.dev/articles/vitals . Already the backbone of `be-fast-and-stable`.
No new principle.

**Baseline (browser support tiers).**
https://web.dev/baseline . Not a quality principle per se, but a **decision
rule**: it is how an auditor decides whether a modern technique is safe to
recommend without a fallback. It strengthens the case for a **be-resilient**
principle (use modern features, but degrade gracefully below Baseline Widely
available). The fix-mode method already references Baseline; making resilience a
principle makes that explicit.

**Lighthouse categories (Performance, Accessibility, Best Practices, SEO, PWA).**
https://developer.chrome.com/docs/lighthouse/overview . Four of the five are
already principles 6-9. The fifth, the historical **PWA / installability**
category (now partly retired in Lighthouse but still a real expectation:
installable, works offline, service worker, manifest), is **not covered**. This
backs **be-resilient** (offline) and an installability concern.

**Inclusive Design Principles (the 7).**
https://inclusivedesignprinciples.info/ . Provide comparable experience; consider
situation; be consistent; give control; offer choice; prioritise content; add
value. `be-accessible` is a floor (WCAG conformance); these are a ceiling.
"Consider situation" (low bandwidth, bright sun, one-handed, stress) and "offer
choice / give control" go **beyond contrast and ARIA** and argue for an
**inclusive** framing broader than the Lighthouse a11y category, plus they
reinforce **respect-user-preferences** and **be-resilient**.

**Web Sustainability Guidelines (W3C, WSG 1.0).**
https://w3c.github.io/sustainableweb-wsg/ (80 guidelines, ~225 success criteria
across UX, web development, infrastructure, business). **Nothing in the current
9 or in the mwg catalog addresses sustainability** (page weight budgets,
efficient assets, avoiding wasteful background work, carbon-aware choices). This
is the clearest net-new external framework. Note: it partly overlaps
performance (lighter pages are usually faster), but its *intent* (resource and
carbon efficiency) is distinct and worth its own principle.

**Resilience / progressive enhancement.**
https://resilientwebdesign.com/ (Jeremy Keith) and
https://developer.mozilla.org/en-US/docs/Glossary/Progressive_enhancement .
Core content and flows should work without JS, on slow networks, on old
browsers, and offline. The current 9 assume a rendered, scripted page and never
test the degraded case. **Clear gap**, and it ties the offline/PWA and Baseline
threads together.

**Privacy and security expectations.**
https://web.dev/articles/security-privacy (HTTPS, CSP, secure cookies,
permission hygiene, no over-collection). The mwg `privacy` and `security` guides
encode the same. `follow-best-practices` mentions HTTPS in passing but nothing
about CSP, cookies, permissions prompts, third-party data, or modern auth
(passkeys). **Clear gap.**

**Internationalisation / localisation.**
https://www.w3.org/International/techniques/authoring-html and
https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl .
`lang`/`dir`, logical properties, locale-aware dates/numbers/currency, calendar
systems, translation-readiness. Backed by an entire mwg cluster (M). **Clear
gap.**

**Offline / PWA / installability.**
https://web.dev/explore/progressive-web-apps . Service worker offline fallback,
web app manifest, installability, works on flaky networks. Folds into
**be-resilient**. **Clear gap.**

**Trust and transparency / no dark patterns.**
https://www.deceptive.design/ (Deceptive Design / Harry Brignull) and
https://www.ftc.gov/business-guidance/blog/2022/09/bringing-dark-patterns-light .
No forced continuity, no confirmshaming, no disguised ads, no nagging consent
walls, honest defaults, easy unsubscribe/cancel, clear pricing. Nielsen's "user
control and freedom" and WCAG's error-prevention reinforce this. `maximize-
content-reduce-noise` bans intrusive popups but says nothing about deceptive
*intent*. **Clear gap.**

### Frameworks that add nothing new

RAIL and Core Web Vitals are already inside `be-fast-and-stable`. Baseline is a
decision rule, not a principle (but it motivates resilience).

---

## 3. Proposed principle set

Cross-referencing the bottom-up clusters (section 1) against the external
frameworks (section 2) against the current 9.

### Keep as-is (5 Una Kravets modern-UX principles)

1. `respect-user-preferences` - keep. (Cluster E; backed by WCAG, Inclusive
   Design "give control".)
2. `implement-natural-interactions` - keep. (Clusters A, B-motion; backed by
   Nielsen "match real world".)
3. `provide-guided-navigation` - keep. (Clusters B-progress, C-anchoring;
   backed by Nielsen "visibility of system status".)
4. `maximize-content-reduce-noise` - keep. (Clusters C, G; backed by Nielsen
   "aesthetic and minimalist", Inclusive Design "prioritise content".)
5. `adapt-to-the-form-factor` - keep. (Cluster D; backed by responsive design
   and Inclusive Design "consider situation".)

### Keep, with a light rename to broaden scope (2)

6. `be-accessible` -> **rename to `be-inclusive`** (keep `be-accessible` as an
   alias/origin). Rationale: WCAG conformance is the floor; the Inclusive Design
   Principles are the ceiling (comparable experience, choice, situation). The
   rename signals "beyond contrast and ARIA" without losing the Lighthouse-a11y
   backing. Net change is framing, not net-new. *(If you prefer minimal churn,
   leave the id as `be-accessible` and just widen the description.)*

7. `follow-best-practices` - keep id, but **narrow its description** so it stops
   being the catch-all that weakly owns security and forms. After adding the new
   principles below, `follow-best-practices` should mean "soundly built and
   served" (no console errors, valid doctype/charset, correct image dimensions,
   no deprecated APIs) and explicitly **hand off** security to
   `be-private-and-secure`.

### Keep as-is (2 remaining Lighthouse principles)

8. `be-fast-and-stable` - keep. (Clusters H, F-CLS; backed by CWV, RAIL, WSG-perf.)
9. `be-discoverable` - keep. (SEO/shareability; backed by Lighthouse SEO.)

### NET-NEW principles (proposed)

> **N1. `be-private-and-secure`** *(NET-NEW)*
> Short description: the site protects users by default. Served over HTTPS with
> a sensible CSP, secure/SameSite cookies, no over-collection or leaky third
> parties, permission prompts requested in context (not on load), and modern
> auth (passkeys over passwords where relevant).
> Rationale: the single biggest gap. `follow-best-practices` only says "HTTPS,
> no obvious smells". The mwg catalog has dedicated `privacy`, `security`, and a
> 6-guide `passkeys` cluster with no principle to attach them to.
> mwg guides: `security`, `privacy`, `passkeys`, `passkey-registration`,
> `passkey-authentication`, `passkey-reauthentication`,
> `passkey-conditional-create`, `passkey-management`,
> `batch-analytics-events`, `full-session-analytics`,
> `calculate-total-foreground-time` (the analytics trio = data-minimisation /
> background-work concern).
> Backed by: web.dev security and privacy guidance; WSG (third-party audits,
> data handling); WCAG-adjacent trust expectations.

> **N2. `be-resilient`** *(NET-NEW)*
> Short description: core content and primary flows work under adverse
> conditions - no JS, slow or offline network, older or non-Baseline browsers.
> Modern features are progressive enhancements with graceful fallbacks; the page
> is installable and offers an offline fallback where it is an app.
> Rationale: the current 9 only ever judge the fully-rendered, scripted, online
> page. Progressive enhancement, offline/PWA, and Baseline-aware fallbacks are
> all unowned. This also makes the fix-mode Baseline rule an explicit principle.
> mwg guides: `flicker-free-client-side-ab-testing`,
> `consistent-cross-document-transitions` (stable-before-transition),
> `detect-initial-visibility-state`, `efficient-background-processing`,
> `deprioritize-background-fetches`, `conditional-async-dependencies`,
> `resilient-context-menus-and-nested-dropdowns` (never-cut-off overlays),
> `move-dom-element-without-losing-state`, `persistent-top-layer-ui`,
> `stabilize-reactive-state`.
> Backed by: Resilient Web Design (Keith); MDN progressive enhancement; the
> retired-but-real Lighthouse PWA category; Baseline.

> **N3. `be-internationalised`** *(NET-NEW)*
> Short description: the site works for users in any language and locale.
> Correct `lang`/`dir`, logical CSS properties, locale-aware dates, numbers,
> currencies, and calendar systems, translation-ready markup, and time handling
> that survives time zones and DST.
> Rationale: an entire mwg cluster (locale-correct data + on-device translate)
> with no principle. Globally relevant and currently invisible to the auditor.
> mwg guides: `translator`, `language-detection`,
> `support-global-calendar-systems`, `coordinate-global-events`,
> `capture-location-agnostic-data`, `model-partial-time-concepts`,
> `format-human-readable-durations`, `manage-recurring-intervals`,
> `calculate-event-differentials`.
> Backed by: W3C Internationalisation; MDN `Intl`; WCAG `lang` requirements.

> **N4. `be-trustworthy`** *(NET-NEW)*
> Short description: the site is honest and humane. No dark patterns
> (confirmshaming, forced continuity, disguised ads, nagging consent walls),
> honest defaults, clear pricing and consent, easy reversal of actions, and
> humane error handling that prevents and recovers from mistakes rather than
> blaming the user.
> Rationale: covers the Nielsen heuristics and WCAG-Understandable criteria that
> have no home today (error prevention, recovery, user control/freedom,
> consistency), plus the explicit anti-dark-pattern stance. Distinct from
> `maximize-content-reduce-noise`, which bans the *form* (popups) but not the
> deceptive *intent*. The forms cluster's "validate after interaction / no
> premature errors" guides live here as humane-error-handling.
> mwg guides (humane forms + recovery): `forms`,
> `validate-input-after-interaction`, `required-field-feedback`,
> `select-menu-interaction`, `accessible-error-announcement`,
> `style-parent-with-has` (signalling invalid fields),
> `autofill-address-form`, `autofill-payment-form`, `autofill-sign-in-form`,
> `autofill-sign-up-form`, `autofill-highlight-inputs`,
> `form-fields-automatically-fit-contents`, `search-hidden-content`
> (deep-linkable, indexable hidden content = honest, no hidden-text tricks),
> `declarative-button-actions` (predictable actions).
> Backed by: Nielsen heuristics (#3 user control, #5 error prevention, #9 error
> recovery, #4 consistency); WCAG 2.2 Understandable; Deceptive Design / FTC
> dark-patterns guidance.

> **N5. `be-sustainable`** *(NET-NEW)*
> Short description: the site is resource-efficient. It respects a page-weight
> budget, ships optimised assets at appropriate resolutions, avoids wasteful
> background work and over-fetching, and prefers the lightest technique that
> achieves the result.
> Rationale: a recognised W3C framework (WSG 1.0) with zero coverage in the
> current 9 or the mwg catalog. Overlaps performance on outcomes (lighter is
> faster) but its intent (resource/carbon efficiency) is distinct and worth
> naming so the auditor weighs asset weight and wasted work, not just perceived
> speed.
> mwg guides: `deliver-optimized-decorative-images`,
> `optimize-image-priority`, `resolution-optimized-pseudo-elements`,
> `defer-rendering-heavy-content`, `defer-work-until-scroll-ends`,
> `improve-next-page-load-performance`.
> (These also serve `be-fast-and-stable`; sustainability is the secondary lens.)
> Backed by: W3C Web Sustainability Guidelines 1.0; Sustainable Web Design.

> **N6. `be-agent-ready`** *(NET-NEW, OPTIONAL / forward-looking)*
> Short description: the site exposes its capabilities to AI agents and on-device
> intelligence in a structured, safe way (WebMCP tools, agentic forms), and uses
> on-device inference appropriately.
> Rationale: a small but real and growing mwg cluster (`webmcp`) with no home.
> Flagged optional because it is emerging, narrow, and arguably premature as a
> universal web-quality bar. Include only if web-uplift wants to lead here.
> mwg guides: `webmcp`, `agentic-forms`, `agentic-javascript-tools`,
> `language-model`, `summarizer`.
> Backed by: WebMCP guidance (emerging; no settled external framework yet).

---

## Coverage map (every one of the 137 guides assigned)

Format: `guide-id -> primary principle [secondary]`. Principle short codes:
RUP=respect-user-preferences, INI=implement-natural-interactions,
PGN=provide-guided-navigation, MCR=maximize-content-reduce-noise,
AFF=adapt-to-the-form-factor, INC=be-inclusive (was be-accessible),
FBP=follow-best-practices, FAST=be-fast-and-stable, DISC=be-discoverable,
SEC=be-private-and-secure (N1), RES=be-resilient (N2), I18N=be-internationalised
(N3), TRUST=be-trustworthy (N4), SUS=be-sustainable (N5), AGENT=be-agent-ready
(N6).

### accessibility (2)
- accessibility -> INC
- accessible-error-announcement -> INC [TRUST]

### built-in-ai (4)
- language-detection -> I18N
- language-model -> AGENT
- summarizer -> AGENT
- translator -> I18N

### css (2)
- css -> FBP
- highlight-text-ranges -> MCR [INC]

### css-layout (1)
- css-layout -> AFF

### forms (15)
- animated-select-picker -> MCR [INI]
- autofill-address-form -> TRUST [SEC]
- autofill-highlight-inputs -> TRUST
- autofill-payment-form -> TRUST [SEC]
- autofill-sign-in-form -> TRUST [SEC]
- autofill-sign-up-form -> TRUST [SEC]
- brand-consistent-forms -> MCR [INC]
- branded-select-styling -> MCR
- custom-select-picker-layouts -> MCR [INC]
- form-fields-automatically-fit-contents -> AFF [TRUST]
- forms -> TRUST [INC, SEC]
- required-field-feedback -> TRUST [INC]
- rich-media-picker -> MCR
- select-menu-interaction -> TRUST
- validate-input-after-interaction -> TRUST [INC]

### html (1)
- html -> FBP

### passkeys (6)
- passkey-authentication -> SEC
- passkey-conditional-create -> SEC
- passkey-management -> SEC
- passkey-reauthentication -> SEC
- passkey-registration -> SEC
- passkeys -> SEC

### performance (22)
- batch-analytics-events -> SEC [SUS]
- break-up-long-tasks -> FAST
- calculate-total-foreground-time -> SEC [SUS]
- conditional-async-dependencies -> RES [FAST]
- defer-rendering-heavy-content -> FAST [SUS]
- defer-work-until-scroll-ends -> FAST [SUS]
- deprioritize-background-fetches -> SUS [FAST]
- detect-initial-visibility-state -> RES [SUS]
- efficient-background-processing -> SUS [FAST]
- faster-spa-view-transitions -> INI [FAST]
- full-session-analytics -> SEC [SUS]
- identify-heavy-scripts -> FAST [SUS]
- identify-inp-causes -> FAST
- improve-next-page-load-performance -> FAST [SUS]
- interactions-in-complex-layouts -> FAST
- optimize-image-priority -> SUS [FAST]
- optimize-preload-priority -> FAST
- optimize-script-priority -> FAST [SUS]
- performance -> FAST
- resolution-optimized-pseudo-elements -> SUS [FAST]
- schedule-tasks-by-priority -> FAST
- sequence-distributed-events -> RES [FAST]

### privacy (1)
- privacy -> SEC

### security (1)
- security -> SEC

### user-experience (79)
- adapt-scrollbar-to-contrast-preferences -> RUP [INC]
- anchor-positioning-tab-underline -> PGN [INI]
- animate-element-entry-exit -> INI
- animate-to-from-top-layer -> INI [MCR]
- animate-to-intrinsic-sizes -> INI
- apply-webgl-shaders -> MCR
- calculate-event-differentials -> I18N
- calculate-with-intrinsic-sizes -> AFF
- capture-location-agnostic-data -> I18N
- carousel-slide-effects -> INI
- carousel-snap-highlights -> PGN [INI]
- child-state-based-styling -> AFF
- complex-shapes -> MCR
- component-specific-light-dark-theme -> RUP
- consistent-cross-document-transitions -> RES [INI]
- content-based-styling -> AFF
- coordinate-global-events -> I18N
- cross-document-transitions -> INI
- customize-scrollbar-color-and-thickness -> MCR [RUP]
- dark-mode -> RUP
- declarative-button-actions -> TRUST [PGN]
- declarative-dialog-popover-control -> MCR
- deliver-optimized-decorative-images -> SUS [FAST]
- design-token-reactivity -> AFF
- directional-navigation-transitions -> PGN [INI]
- dynamic-sibling-animations -> INI
- dynamic-sibling-styling -> AFF
- export-html-media-from-canvas -> MCR
- expose-canvas-content-to-browser-features -> INC
- flicker-free-client-side-ab-testing -> RES [FAST]
- fluid-scaling -> AFF
- format-human-readable-durations -> I18N
- group-element-transitions -> INI
- improve-text-layout-and-legibility -> INC [MCR]
- individual-transform-properties -> INI
- interactive-content-in-3d-scenes -> MCR
- interactive-content-reveal -> INI [MCR]
- interest-triggered-action-previews -> PGN [INI]
- interest-triggered-tooltips -> PGN
- light-dismiss-a-dialog -> MCR
- manage-recurring-intervals -> I18N
- model-partial-time-concepts -> I18N
- move-dom-element-without-losing-state -> RES [INC]
- navigation-drawer -> PGN [MCR]
- overflow-clipping-control -> MCR
- parallax-scroll-effects -> INI
- persistent-app-tours -> PGN [MCR]
- persistent-toast-notifications -> PGN [MCR]
- persistent-top-layer-ui -> RES [MCR]
- physics-based-easing -> INI
- platform-controls-dismiss-dialog -> MCR [RES]
- position-aware-tooltips -> PGN
- precise-text-alignment -> INC [MCR]
- prevent-text-wrapping -> MCR [INC]
- pull-to-reveal -> INI [PGN]
- reduce-style-repetition -> FBP
- resilient-context-menus-and-nested-dropdowns -> RES [PGN]
- same-document-transitions -> INI
- scroll-entry-exit-effects -> INI
- scroll-position-aware-elements -> PGN
- scroll-progress-indicator -> PGN
- scroll-snap-realtime-feedback -> PGN [INI]
- scroll-snap-state-sync -> PGN
- scroll-target-on-load -> PGN [RES]
- scrollability-affordance-hints -> PGN [INC]
- scrollytelling -> INI
- search-hidden-content -> TRUST [INC, DISC]
- shaped-cutouts -> MCR
- shrinking-header-on-scroll -> PGN [INI]
- size-aware-styling -> AFF
- soft-edge-content-fade -> PGN [MCR]
- stabilize-reactive-state -> RES
- stack-drill-down -> PGN [RES]
- style-parent-with-has -> TRUST [INC]
- support-global-calendar-systems -> I18N
- swipe-to-remove -> INI [TRUST]
- visually-stable-font-fallbacks -> FAST [INC]
- visually-stable-mixed-fonts -> INC [FAST]
- visually-texture-content -> MCR

### webmcp (3)
- agentic-forms -> AGENT
- agentic-javascript-tools -> AGENT
- webmcp -> AGENT

### Coverage check

All 137 guides are assigned a primary principle; none orphaned. If the optional
`be-agent-ready` (N6) is rejected, its 5 guides (`webmcp`, `agentic-forms`,
`agentic-javascript-tools`, `language-model`, `summarizer`) would otherwise be
orphans, since nothing else fits them. That is itself a data point: those 5
guides have no home in the current 9 and would remain unowned without N6.

Per-principle guide counts (primary assignment, with N6 included):

| Principle | New? | Primary guides |
|---|---|---|
| respect-user-preferences | no | 4 |
| implement-natural-interactions | no | 19 |
| provide-guided-navigation | no | 18 |
| maximize-content-reduce-noise | no | 18 |
| adapt-to-the-form-factor | no | 9 |
| be-inclusive (was be-accessible) | rename | 5 |
| follow-best-practices | no (narrowed) | 3 |
| be-fast-and-stable | no | 13 |
| be-discoverable | no | 0 (SEO; no mwg guide maps cleanly) |
| be-private-and-secure | NET-NEW | 13 |
| be-resilient | NET-NEW | 11 |
| be-internationalised | NET-NEW | 9 |
| be-trustworthy | NET-NEW | 11 |
| be-sustainable | NET-NEW | 6 |
| be-agent-ready | NET-NEW (optional) | 5 |

Note: `be-discoverable` gets 0 primary mwg guides because the catalog has no
SEO-specific guidance; it remains justified by the Lighthouse SEO dimension and
is judged from the page itself (title, meta, crawlable links), not from mwg.

---

## Recommendation summary

- **Keep** the 5 Una Kravets principles and `be-fast-and-stable`,
  `be-discoverable` unchanged.
- **Rename** `be-accessible` -> `be-inclusive` (widen framing; optional, low
  churn alternative: keep the id, widen the description).
- **Narrow** `follow-best-practices` so it stops being a weak catch-all for
  security and forms.
- **Add 5 net-new principles**: `be-private-and-secure`, `be-resilient`,
  `be-internationalised`, `be-trustworthy`, `be-sustainable`.
- **Optionally add** `be-agent-ready` (forward-looking; the only thing that
  homes the WebMCP/on-device-AI guides).

This takes the set from 9 to 14 (or 15 with the optional agent principle) and
brings every one of the 137 mwg guides under a principle, while aligning with
WCAG/POUR, Nielsen, Inclusive Design, WSG, RAIL/CWV, Baseline, progressive
enhancement, PWA/offline, i18n, security/privacy, and anti-dark-pattern
frameworks.

### Honest caveats

- The mwg CLI (v0.0.172) does not expose `featuresUsed`; clusters are derived
  from id + category + description, not a structured feature taxonomy.
- The package's own categories are uneven (a 79-guide `user-experience` bucket),
  so the bottom-up clustering is interpretive.
- Some guides are dual-purpose; the coverage map records a primary and one or
  two secondaries, and a few assignments (e.g. the analytics trio to
  `be-private-and-secure`) are judgement calls flagged in-line.
- This is intent analysis only. Nothing here has been encoded into
  `principles/principles.json`, and no checks or `detectableVia` hints have been
  drafted; that is the next step if you sign off.

### Sources

- WCAG 2.2 / POUR: https://www.w3.org/TR/WCAG22/
- Nielsen's 10 usability heuristics: https://www.nngroup.com/articles/ten-usability-heuristics/
- Google RAIL: https://web.dev/articles/rail
- Core Web Vitals: https://web.dev/articles/vitals
- Baseline: https://web.dev/baseline
- Lighthouse: https://developer.chrome.com/docs/lighthouse/overview
- Inclusive Design Principles: https://inclusivedesignprinciples.info/
- W3C Web Sustainability Guidelines 1.0: https://w3c.github.io/sustainableweb-wsg/
- Resilient Web Design: https://resilientwebdesign.com/
- Progressive enhancement (MDN): https://developer.mozilla.org/en-US/docs/Glossary/Progressive_enhancement
- Web security and privacy (web.dev): https://web.dev/articles/security-privacy
- Progressive Web Apps (web.dev): https://web.dev/explore/progressive-web-apps
- W3C Internationalisation: https://www.w3.org/International/techniques/authoring-html
- Intl (MDN): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl
- Deceptive Design (dark patterns): https://www.deceptive.design/
- FTC on dark patterns: https://www.ftc.gov/business-guidance/blog/2022/09/bringing-dark-patterns-light
