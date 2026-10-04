# paul.kinlan.me: bounded first increment (F-001 dark mode, F-005 fonts)

Bead: `web-uplift-aoo.1` (parent `web-uplift-aoo`). Branch: `fleet/aoo-increment`.
Date: 2026-10-04. Author: worker lane (web-uplift fleet).

Scope: live re-verification of the two HIGH findings from the 2026-09-25
report-mode audit, a bounded fix plan for them, and the T-001..T-010
implementability list. This is NOT a fresh audit; the other 10 findings were
not re-measured (two incidental corroborations fell out of the F-005 capture
and are noted in the appendix).

Evidence directory: `evidence-out/aoo-increment/` (committed: JSON summaries,
3 PNGs, 58KB each; gitignored locally: the raw HAR).

## 1. Live re-verification results

Both HIGH findings REPRODUCE against `https://paul.kinlan.me/` (2026-10-04,
Chrome 154.0.8037.92 via this repo's raw-CDP evidence primitives).

### F-001 (no dark mode): REPRODUCES

Method: `screenshot` primitive, viewport 1280x720, settle 3000ms. Two light
captures establish capture determinism; one capture under
`--emulate-media prefers-color-scheme=dark`.

| artifact | sha256 |
|---|---|
| `png/home-light-1.png` | `cf8c0b801444d4042004e4e62bb68a1d87692472819e40fef316440bfaacff76` |
| `png/home-light-2.png` | `cf8c0b801444d4042004e4e62bb68a1d87692472819e40fef316440bfaacff76` |
| `png/home-dark-1.png`  | `cf8c0b801444d4042004e4e62bb68a1d87692472819e40fef316440bfaacff76` |

Light-1 == light-2 proves the capture pipeline is deterministic for this page,
so dark == light is a real render identity: the page paints identical pixels
under an emulated dark preference. CSSOM corroboration
(`f001-cssom-probe-dark.json`): `<meta name="color-scheme" content="light">`,
computed root `color-scheme: light`, body `rgb(255,255,255)` on
`rgb(17,24,39)` text. The only `prefers-color-scheme` rule in any readable
sheet is a shadow tweak (`--shadow-color`/`--shadow-strength`). There is no
theme toggle, no `data-theme`, nothing.

### F-005 (1.19MB fonts, 2 render-blocking font CSS): REPRODUCES

Method: `har` primitive over the load (`f005-load-summary.json`) plus an
`evaluate` probe of the live DOM (`f001-f005-fontprobe.json`).

- Total transferred: **1,432,199 bytes** across 15 requests.
- Fonts: **1,186,459 bytes (82.8% of the page)** in 2 requests:
  - Material Symbols Outlined variable woff2 (wght 100..700 + FILL 0..1):
    **1,138,171 bytes**, 979.6ms.
  - Inter latin variable woff2: **48,288 bytes**, 720.8ms.
- Render-blocking font CSS: **2 parser-inserted `<link rel=stylesheet>`** to
  `fonts.googleapis.com` (HTML lines 116/117 per the HAR initiator; the live
  document's lines 117/118), VeryHigh priority, head placement, no
  print-media/preload pattern:
  - `.../css2?family=Outfit:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap`
  - `.../css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap`
- Material Symbols serves exactly **4 unique glyphs** on the homepage
  (`arrow_forward`, `alternate_email`, `rss_feed`, `mail`; 6 spans), and 3 on
  the measured article page.
- Outfit is declared in the CSS request but **unused on both measured
  templates** (0 elements resolve to Outfit, 0 Outfit faces load, no Outfit
  file transfers; the only in-repo consumer of Outfit is the `.article-prose`
  class, and no measured template applies that class).

Delta vs the 2026-09-25 audit: same findings, same magnitude (1.186MB vs
1.19MB fonts; 1.138MB vs 1.1MB Material Symbols). Could not test: nothing;
both findings were fully measurable.

## 2. Which repository backs paul.kinlan.me (CORRECTION)

> **The hub stated paul.kinlan.me is backed by `PaulKinlan/paulkinlan.github.io`.
> That premise is falsified by measurement. The live site is backed by
> `PaulKinlan/paul.kinlan.me`.**

`PaulKinlan/paul.kinlan.me` (public, default branch `main`, Hugo + Tailwind +
Vercel: `vercel.json` sets `"framework": "hugo"`, repo `homepage` is
`https://paul.kinlan.me/`). Verification over public HTTP only (nothing
cloned, modified, or pushed):

- `layouts/partials/head.html` matches the live HTML line-for-line on every
  F-001/F-005 marker: the preconnects, the two `fonts.googleapis.com`
  stylesheet links (F-005), `<meta name="color-scheme" content="light">` plus
  the legacy `supported-color-schemes` metas (F-001), `theme-color #000000`,
  the `gtag` snippet for `G-V4DZ9TE0NV`, and the fingerprinted
  `/css/tailwind.<sha256>.css` + `integrity` link produced by the Hugo
  `fingerprint` pipeline.
- The live inline `<style>` is exactly the head.html Hugo pipeline
  (`open-props.css` + `open-props-normalize-light.css` +
  `open-props-fonts.css` + `main.css`, concatenated then minified): the token
  block, the single shadow-only dark media query, and the trailing
  `:root{color-scheme:light}` all reproduce.
- `vercel.json` `headers` contains the exact CSP string the live response
  serves (including `script-src 'unsafe-inline'` and
  `font-src 'self' https://fonts.gstatic.com`).

`PaulKinlan/paulkinlan.github.io` was checked and does NOT match the live
site: it is a Jekyll source repo (`_config.yml`, `_layouts`, `_posts`)
serving a "Paul Kinlan — Projects" page at `paulkinlan.github.io` (canonical
`paulkinlan.github.io`), one branch (`master`), no `tailwind.*.css` anywhere,
while the live paul.kinlan.me serves a different title, canonical, and CSS
set via Vercel. A patch written against `paulkinlan.github.io` would NOT
apply to paul.kinlan.me.

**Applicability statement: the F-001/F-005 patches below apply as written in
`PaulKinlan/paul.kinlan.me` (verified against its `main` branch over public
HTTP at 2026-10-04), and do not apply in `PaulKinlan/paulkinlan.github.io`.**

Caveat noted for Paul: the repo's latest `main` commit is 2026-08-02, the
repo `pushed_at` is 2026-09-18, and the live site's `last-modified` is
2026-09-29, so the deployed build may be ahead of `main` (or built from a
preview/branch). Every F-001/F-005 marker still matches `main` exactly, so
the patches apply; the caveat only matters if newer unpushed work moved those
lines.

## 3. F-001 fix: dark mode in one bounded increment

The site already has every ingredient: Open Props tokens that exist precisely
to be flipped, a Tailwind config with `darkMode: "media"` already set
(`tailwind.config.cjs` line 24, with the comment "Drive dark utilities from
the user's system preference (no JS toggle)"), and a vendored
`open-props-normalize.css` whose dark block can be lifted. What blocks dark
mode today is three light pins plus hard-coded Tailwind light utilities.

Guidance: MWG guide `dark-mode` (mandatory steps 1 and 2 below mirror it:
declare `color-scheme` in a meta, apply `color-scheme` on `:root`, then flip
tokens; `light-dark()` is the optional modern alternative).

### Patch F-001a: `layouts/partials/head.html` metas

```diff
--- a/layouts/partials/head.html (line 30)
-  <meta name="supported-color-schemes" content="light dark">
--- a/layouts/partials/head.html (line 34)
-  <meta name="color-scheme" content="light">
+  <meta name="color-scheme" content="light dark">
```

(Two separate hunks; the lines between them stay untouched. The legacy
`supported-color-schemes` hint contradicted the standard `color-scheme` meta
(`light dark` vs `light`); keep only the standard one.)

### Patch F-001b: `assets/css/main.css` un-pin the scheme

```diff
-    /* The site is intentionally light-only (no authored dark theme yet).
-       Declaring color-scheme: light keeps native UI (scrollbars, form
-       controls, canvas) consistent with the light content for every user,
-       including those who prefer dark, rather than leaving it ambiguous. */
-    :root {
-        color-scheme: light;
-    }
+    /* Dark theme: native UI (scrollbars, form controls, canvas) follows the
+       user preference; the token flip lives in open-props-dark.css. This
+       :root declaration must win over the :where(html) rules, so it stays. */
+    :root {
+        color-scheme: light dark;
+    }
```

### Patch F-001c: new file `assets/css/open-props-dark.css`

Content: the dark block from the repo's own vendored `open-props-normalize.css`
(already in `assets/`), verbatim:

```css
@media (prefers-color-scheme: dark) {
  :where(html) {
    --link: var(--indigo-3);
    --link-visited: var(--purple-3);
    --text-1: var(--gray-1);
    --text-2: var(--gray-4);
    --surface-1: var(--gray-9);
    --surface-2: var(--gray-8);
    --surface-3: var(--gray-7);
    --surface-4: var(--gray-6);
    --scrollthumb-color: var(--gray-6);
    --shadow-color: 220 40% 2%;
    --shadow-strength: 10%;
    color-scheme: dark;
  }
}
```

Do NOT swap `open-props-normalize-light.css` for `open-props-normalize.css`
in the pipeline instead: the vendored `normalize.css` is an older Open Props
build (e.g. `--text-1: var(--gray-9)` vs the light file's `gray-12`, missing
`.btn` rules, no heading color rule) and would silently regress the light
theme. Appending the dark block keeps the light theme byte-identical.

### Patch F-001d: `layouts/partials/head.html` pipeline

```diff
       {{
         $openpropsnormalize:=resources.Get "css/open-props-normalize-light.css"
       }}

+      {{
+        $openpropsdark:=resources.Get "css/open-props-dark.css"
+      }}
+
       {{
         $main:=resources.Get "css/main.css"
       }}

       {{
-        $css:=slice $openprops $openpropsnormalize $openpropsfonts $main | resources.Concat "css/bundle.css"
+        $css:=slice $openprops $openpropsnormalize $openpropsdark $openpropsfonts $main | resources.Concat "css/bundle.css"
       }}
```

### Patch F-001e: dark: variants for the hard-coded Tailwind light utilities

The Open Props layer only paints the base (html background, links, form
controls). The templates hard-code light Tailwind utilities, so with
`darkMode: "media"` add `dark:` variants. Census over the 9 template files
(2026-10-04, `main`): `text-gray-900` x15, `text-gray-500` x7, `text-gray-600`
x6, `bg-white` x4, `border-gray-100` x3, `bg-gray-200` x3, `bg-gray-100` x3,
`border-gray-200` x2, `bg-gray-300` x2, `text-gray-700` x1, `text-slate-900`
x1, `text-slate-300` x1, `bg-slate-900`/`-800`/`-100` x1 each. The shared
chrome (first pass, 4 files) is exact:

```diff
--- a/layouts/_default/list.html      (line 2)
--- a/layouts/_default/single.html    (line 3)
--- a/layouts/entry/single.html       (line 3)
-<body class="... bg-white text-gray-900 min-h-screen antialiased">
+<body class="... bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 min-h-screen antialiased">

--- a/layouts/partials/menu.html      (line 1)
-<header class="w-full z-50 bg-white border-b border-gray-100 mb-12">
+<header class="w-full z-50 bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800 mb-12">
```

The remaining ~20 utilities (card text `text-gray-600`/`500`, `bg-gray-100`
chips, `border-gray-200` dividers, `moi.html` `bg-white text-slate-900`
subscribe button) follow the same mechanical pattern
(`dark:text-gray-300`-ish for `-600/-500`, `dark:bg-gray-800` for
`bg-gray-100/200`, `dark:border-gray-700` for borders) and are enumerated by
the census above; they are template-local one-liners, reviewable in a single
PR. Contrast must be re-checked per pair after landing (the audit's inclusive
checks re-run will catch any pair under 4.5:1).

### F-001 verification plan (after landing)

Re-run the exact capture from section 1: light vs dark screenshots must now
differ (dark body background ≈ `var(--gray-9)` = `#212529`), and a light
capture must remain visually identical to today's. `node evidence/cli.mjs
screenshot <url> --emulate-media prefers-color-scheme=dark` plus the CSSOM
probe in `evidence-out/aoo-increment/f001-cssom-probe-dark.json` (expect
`rootColorScheme: "light dark"` and dark computed tokens).

## 4. F-005 fix: kill 1.14MB for 4 icons, self-host the rest

Guidance: MWG `performance` guide (font bytes and render-blocking CSS), plus
`share-web-fonts-across-origins` / `visually-stable-font-fallbacks` for the
self-hosting details. The site already ships `font-display: swap` via the
Google CSS `display=swap` parameter; the fixes preserve swap semantics.

### Patch F-005a: `layouts/partials/head.html`, delete the Material Symbols link

```diff
   <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
-  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
```

### Patch F-005b: `layouts/partials/moi.html`, inline the 3 icons

Canonical Material Symbols Outlined 24px SVG paths (Apache-2.0, from
`google/material-design-icons`, fetched 2026-10-04; 1,502 bytes total for all
four icons vs the 1,138,171-byte variable font). `currentColor` inherits the
existing `text-tertiary`/`text-on-surface-variant` Tailwind colors; sized to
match the spans they replace; `aria-hidden` because the enclosing links keep
their `aria-label` (the "@" card is decorative):

```diff
--- a/layouts/partials/moi.html (line 18)
-    <span class="material-symbols-outlined text-[48px] text-tertiary mb-4">alternate_email</span>
+    <svg class="w-12 h-12 text-tertiary mb-4" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480v58q0 59-40.5 100.5T740-280q-35 0-66-15t-52-43q-29 29-65.5 43.5T480-280q-83 0-141.5-58.5T280-480q0-83 58.5-141.5T480-680q83 0 141.5 58.5T680-480v58q0 26 17 44t43 18q26 0 43-18t17-44v-58q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93h200v80H480Zm0-280q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35Z"/></svg>

--- a/layouts/partials/moi.html (line 27)
-    <span class="material-symbols-outlined">rss_feed</span>
+    <svg class="w-6 h-6" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M200-120q-33 0-56.5-23.5T120-200q0-33 23.5-56.5T200-280q33 0 56.5 23.5T280-200q0 33-23.5 56.5T200-120Zm480 0q0-117-44-218.5T516-516q-76-76-177.5-120T120-680v-120q142 0 265 53t216 146q93 93 146 216t53 265H680Zm-240 0q0-67-25-124.5T346-346q-44-44-101.5-69T120-440v-120q92 0 171.5 34.5T431-431q60 60 94.5 139.5T560-120H440Z"/></svg>

--- a/layouts/partials/moi.html (line 30)
-    <span class="material-symbols-outlined">mail</span>
+    <svg class="w-6 h-6" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm320-280L160-640v400h640v-400L480-440Zm0-80 320-200H160l320 200ZM160-640v-80 480-400Z"/></svg>
```

### Patch F-005c: `layouts/_default/list.html` (line 67), inline the arrow

```diff
-              <a href="{{ .Permalink }}" class="flex items-center gap-2 hover:underline">READ ARTICLE <span class="material-symbols-outlined !text-[16px]">arrow_forward</span></a>
+              <a href="{{ .Permalink }}" class="flex items-center gap-2 hover:underline">READ ARTICLE <svg class="w-4 h-4" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M647-440H160v-80h487L423-744l57-56 320 320-320 320-57-56 224-224Z"/></svg></a>
```

Minimal-diff alternative (if Paul prefers keeping the font): Google Fonts
supports icon subsetting via `&icon_names=arrow_forward,alternate_email,rss_feed,mail`
on the Material Symbols URL, which shrinks the payload to a few KB but keeps
a third-party render-blocking CSS request and a third-party font origin in
CSP. The inline-SVG option is strictly better on all three axes and is the
recommendation.

### Patch F-005d: fonts link, drop dead Outfit and self-host Inter

Two sub-steps, in order of certainty:

1. **Drop Outfit from the request** (measured dead on both templates: 0
   elements, 0 loaded faces, 0 bytes fetched). Before landing, one
   site-wide check Paul should run in the repo:
   `git grep -i "article-prose\|outfit"` across `content/` (raw-HTML posts
   could apply the class); if only `main.css` and the Google URL reference
   it, remove it from the URL and delete the dead `.article-prose` rules.
2. **Self-host Inter** and delete the remaining Google Fonts link: vendor the
   Inter variable woff2 subsets the site actually uses (latin measured 48,288
   bytes; check other subsets only if non-latin content exists) under
   `static/fonts/`, add `@font-face` rules with `font-display: swap` to a new
   `assets/css/fonts.css` appended to the head.html concat (same pattern as
   F-001d), and remove the last `fonts.googleapis.com` link. This takes the
   render-blocking third-party font CSS requests from 2 to 0 and later lets
   CSP drop both `style-src ... fonts.googleapis.com` and
   `font-src ... fonts.gstatic.com` (synergy with the unsafe-inline cleanup,
   item T-008 in section 6).

### Expected impact (homepage)

| metric | before (measured) | after (expected) |
|---|---|---|
| font bytes transferred | 1,186,459 | ~48,300 (Inter only; icons now ~1.5KB inline SVG) |
| font share of page | 82.8% | ~16% |
| render-blocking font CSS requests (third-party) | 2 | 0 |
| page total transferred | 1,432,199 | ~295,000 |

TBT (audit: 629ms under 4x CPU throttle) should drop sharply with the
1.14MB font parse and the two render-blocking CSS chains gone, but that is an
expectation to re-measure with the `trace`/`har` primitives under
`--network mobile-lighthouse`, not a claim.

### F-005 verification plan (after landing)

Re-run `har` (expect font requests 2 -> 1 first-party, Material Symbols gone)
and the `document.fonts` census probe (expect no Material Symbols face). The
byte table above turns into the acceptance check.

## 5. What landing this requires

The patches belong in **PaulKinlan/paul.kinlan.me**. Per the hub constraint
this fleet touches neither repo: no clone, no branch, no push. To land, Paul
(or anyone with a fork) applies the diffs as a PR; Vercel rebuilds via the
repo's `vercel.json` (framework hugo) with no dashboard changes needed.
Nothing here needs Vercel credentials. The auditor repo (web-uplift) has no
code to change for these two findings; its follow-up role is the
re-verification captures in sections 3 and 4 and, later, a
`web-uplift compare` run against the retained 2026-09-25 baseline once fixes
are live.

## 6. T-001..T-010 implementability list

The original taskList IDs lived in the gitignored `reports/` run on another
VM and are not recoverable here. The mapping below is inferred from the audit
summary's order (two HIGHs first, then MEDIUMs, then LOWs; the three LOWs
likely share T-010 or spill past it). If the original IDs differ, the finding
descriptions are the stable key.

Verdict up front: **0 of the 12 findings are implementable in
PaulKinlan/web-uplift. 12 of 12 are implementable only in
PaulKinlan/paul.kinlan.me** (the verified backing repo) or require decisions
only Paul can make there. Nothing needs this fleet's credentials; several
need Paul's product decisions.

| task (inferred) | finding | where it can be implemented | blocker / whose decision |
|---|---|---|---|
| T-001 | F-001 no dark mode | `PaulKinlan/paul.kinlan.me` only | Paul's call: `main.css` documents the light pin as intentional ("intentionally light-only (no authored dark theme yet)"). The "yet" reads as intent to add one; patches in section 3 make it one PR. |
| T-002 | F-005 1.19MB fonts + 2 render-blocking font CSS | `PaulKinlan/paul.kinlan.me` only | Paul's call on icon strategy (inline SVG recommended vs icon_names subset) and on dropping Outfit (needs his site-wide content grep). No credentials needed. |
| T-003 | TBT 629ms under 4x CPU | `PaulKinlan/paul.kinlan.me` only | Largely downstream of T-002 (font parse + render-blocking chains) plus T-004's analytics JS. Re-measure after those land before any further work. |
| T-004 | dual analytics: Vercel Insights + GA4 gtag (~170KB) + legacy analytics.js (~21KB) | `PaulKinlan/paul.kinlan.me` only | Paul's product decision: which analytics to keep. The legacy `analytics.js` (UA) loading alongside gtag looks vestigial and is the cheap deletion; finding its insertion point needs the repo (likely a partial). |
| T-005 | heading-order skips (axe) | `PaulKinlan/paul.kinlan.me` only | Template-level h1/h2/h3 structure in `layouts/` (list/single/moi). Cheap, no decision needed beyond visual sign-off. |
| T-006 | GA cookies SameSite=None + not Secure on .kinlan.me | partially not ours by nature | Cookie attributes are set by Google's scripts. Levers: remove/replace analytics (T-004 decision), or accept vendor behavior. No code this fleet can write makes Google's cookies Secure. |
| T-007 | article horizontal overflow 72px at 320px (WCAG reflow) | `PaulKinlan/paul.kinlan.me` only | CSS fix in the article template (likely pre/code or embedded media widths; the measured article page has no `.article-prose`, so it is in the Tailwind layer). Needs the repro URL from the original audit, which is lost with the artifacts; re-derivable with one `layout --viewport 320x568` run on any article. |
| T-008 | CSP `script-src 'unsafe-inline'` | `PaulKinlan/paul.kinlan.me` only | CSP lives in `vercel.json` `headers` (verified). Moving off unsafe-inline requires nonces/hashes or refactoring the inline gtag/head.js/speculationrules blocks; strategy is Paul's call. Synergy: F-005d lets `style-src`/`font-src` drop the Google origins. |
| T-009 | unbranded Vercel 404 | `PaulKinlan/paul.kinlan.me` only | Add a Hugo `layouts/404.html` (none exists in the tree; Vercel then serves it automatically). No Vercel credentials needed; design is Paul's call. |
| T-010 (lows) | manifest without SW; missing `autocomplete=email`; oversized author photo | `PaulKinlan/paul.kinlan.me` only | Three one-liners: add a service worker or drop the manifest claim (Paul's product call), add `autocomplete="email"` to the subscribe input in `moi.html`, resize `static/images/me.png`. |

Not implementable by us at all, ever: T-006's Google-set cookie attributes
beyond the remove-analytics lever. Everything else is ordinary site-repo
work this fleet must not do itself under the hub's hands-off constraint.

## 7. Residual uncertainty

- The deployed build may be ahead of `main` (dates in section 2); every
  F-001/F-005 marker matched `main`, so the patches apply, but the dark-utility
  census line numbers could drift if unpushed template work exists.
- The T-numbering in section 6 is inferred (original IDs lost with the
  gitignored reports).
- "Outfit unused" is measured on the homepage and one article template, not
  proven across all content; the doc gates the removal on Paul's grep.
- The 10 untested findings were not re-verified; two incidental signals from
  the F-005 capture: dual analytics still loads (Vercel Insights 2.3KB, gtag
  170,795B, analytics.js 21,409B) and CSP `unsafe-inline` is still served.
  Console stayed clean in every capture (0 errors; 2 warnings, both
  Permissions-Policy header feature warnings for `browsing-topics` and
  `interest-cohort`, i.e. first-party header feature warnings, not analytics).
