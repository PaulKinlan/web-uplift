---
name: web-audit
description: "Audit a URL for modern web quality and (optionally) fix it. This is a FULLY AGENTIC audit. YOU (the model) gather multi-modal evidence about the page with the generic evidence primitives, decide for yourself which tools to run (Lighthouse, axe, your own ad-hoc static tests), reason over that evidence, and judge every principle, then emit a findings report. There are no hard-coded checks and no fast path. The principles are the spec, this skill is the method, and you supply all the intelligence. Use when asked to web-audit, UX-audit, uplift, modernise, or quality-audit a site."
---

# Web audit (fully agentic)

Audit `$ARGUMENTS`: a URL, plus optional flags:

- `--out <dir>` - report directory (default `reports/<host>/`).
- `--source <dir>` - path to the site's local source, so you can read the
  authored HTML/CSS/JS, not just the rendered output.
- `--fix` - after auditing, apply fixes to local source and re-audit (requires
  `--source`). Without `--fix`, this is report mode (critique only).
- `--findings <path>` - a pre-aggregated `report.json` to start fix mode from,
  so you can skip the baseline audit and go straight to the hill-climb.
- `--max-iterations <n>` - cap on fix-mode passes (default ~4); stop earlier if
  no outstanding `issues` remain.
- `--expected <file>` - a ground-truth file to self-score against (used for the
  playground eval).

## The two ways to run this (the DEFAULT is your own session)

1. **In your own agent session (DEFAULT, uses your subscription).** You are
   already a capable model in a session (Claude Code, Codex, Gemini, Antigravity,
   Copilot, opencode). Just follow this file: run `/web-audit <url>` for an audit,
   or `/web-audit <url> --source <dir> --fix` for the hill-climb, doing the
   reasoning yourself and calling `node evidence/cli.mjs ...` for evidence. No
   headless runner, no `claude -p`, no extra API billing. This is the path an
   individual should use.
2. **Headless / CI / batch (uses API tokens).** `npm run audit`/`npm run fix`
   (or `web-uplift audit`/`web-uplift fix`) spawn an agent CLI in `-p`/`exec`
   mode to drive this same skill unattended. That bills API tokens, so it is for
   automation, not the default for a person. Same methodology either way.

## The contract: you are the auditor, not a runner

There is **no deterministic check runner** and there are **no fast paths** in
this project. Nothing decides for you whether a principle passes. You decide,
by gathering evidence and reasoning over it. The repo gives you two declarative
inputs and one generic capability:

1. **Principles** - [knowledge/principles.json](../../../knowledge/principles.json)
   in this repo, or `../knowledge/principles.json` when this skill is installed
   under `.web-uplift/skill/`:
   the spec of what good looks like, as OUTCOMES. Seventeen principles: Una
   Kravets' five modern-UX principles (respect-user-preferences,
   implement-natural-interactions, provide-guided-navigation,
   maximize-content-reduce-noise, adapt-to-the-form-factor);
   support-core-task-success; two
   widened/narrowed Lighthouse-dimension principles (be-inclusive - the former
   be-accessible, widened beyond WCAG conformance; follow-best-practices -
   narrowed so it is no longer the catch-all for security and forms); two
   unchanged Lighthouse-dimension principles (be-fast-and-stable,
   be-discoverable); six framework-derived principles
   (be-private-and-secure, be-resilient, be-internationalised, be-trustworthy,
   be-sustainable, be-agent-ready); and be-memory-efficient (derived from the
   memory-tracer leak-audit methodology). Each check has a `detectableVia` HINT (may
   MENTION candidate evidence/tools, MANDATES nothing), a `guides` list of
   Modern Web Guidance ids and/or query strings, and may have `references` for
   non-MWG standards, methods, or optional tools. These are declarative pointers
   you consult to set the bar, not hard-coded tests. Each principle also has an
   `applicability` block (`expectation: default | contextual`); see step 0 and
   step 4. The full coverage map (all 137 mwg guides -> principles) and the
   rationale for the set is in
   [docs/principles-analysis.md](../../../docs/principles-analysis.md).
2. **Guidance** - Modern Web Guidance via the `modern-web-guidance` npm feed
   (the *how*). See [knowledge/guidance.md](../../../knowledge/guidance.md) in
   this repo, or `../knowledge/guidance.md` when installed: `search`
   to find the recommended approach, `retrieve` to get the fix detail. Pin the
   catalog version in `principles.json` (`guidanceCatalogVersion`, currently
   `modern-web-guidance@0.0.172`) unless `web-uplift.json` overrides it.
3. **Evidence primitives** - [evidence/cli.mjs](../../../evidence/cli.mjs): a
   generic, judgement-free CLI you call to gather evidence. It launches the
   system Chrome and drives it over raw CDP (chrome-remote-interface). It returns
   data and artifacts; it never decides anything.

## The evidence primitives (your senses)

```sh
node evidence/cli.mjs <primitive> <url> [options]
```

Use whichever invocation resolves in your context (they run the SAME CLI):

- **In this repo:** `node evidence/cli.mjs <primitive> <url> [options]`.
- **Per-project install** (files vendored under `.web-uplift/`):
  `node .web-uplift/evidence/cli.mjs <primitive> <url> [options]`.
- **Global package install** (e.g. this skill loaded from a pi package, so no
  local copy exists): `web-uplift evidence <primitive> <url> [options]`, or
  `npx -y web-uplift evidence <primitive> <url> [options]` if `web-uplift` is not
  on `PATH`. This form works from any cwd and needs nothing vendored.

Pick the first that exists; the rest of this file writes `node evidence/cli.mjs`
for brevity, but the `web-uplift evidence ...` form is equivalent everywhere.

**This applies to EVERY web-uplift command this skill uses**, not just evidence.
The scorecard, run-compare, and user-flow scripts are vendored alongside the
evidence CLI, so translate the same three ways:

| In this repo | Per-project install | Global package |
|---|---|---|
| `node aggregate/scorecard.mjs <host>` | `node .web-uplift/aggregate/scorecard.mjs <host>` | `web-uplift scorecard <host>` |
| `node aggregate/compare.mjs <host>` | `node .web-uplift/aggregate/compare.mjs <host>` | `web-uplift compare <host>` |
| `node runner/flow.mjs replay <flow>` | `node .web-uplift/runner/flow.mjs replay <flow>` | `web-uplift flow replay <flow>` |

If none resolves (an older install that predates these scripts), say so in the
report rather than skipping silently, and point the user at `web-uplift
scorecard <host>` via `npx -y web-uplift`.

Primitives, all content- and tool-agnostic:

| Primitive | What it gives you | Key CDP |
|---|---|---|
| `screenshot` | a PNG (full or `--selector`-clipped) under any emulated condition | Page.captureScreenshot |
| `video` | an MP4 of an interaction window, frames assembled with ffmpeg; `--interact "<js>"` triggers the transition/animation | Page.startScreencast |
| `heap` | a readable heap summary (types/constructors by size); `--interact` to exercise first, for leak hunting. Take a baseline and a post-interaction snapshot and compare retained growth (the memory-tracer methodology) to judge `be-memory-efficient` | HeapProfiler.takeHeapSnapshot |
| `layout` | layout metrics, a CLS/layout-shift observer, long tasks, overflow at the current viewport | Page.getLayoutMetrics + observers |
| `dom` | DOM, computed styles for `--selector` list, page HTML/CSS, and (`--source <dir>`) the local source files | DOM/CSS/Runtime |
| `evaluate` | runs your own `--expr "<js>"` in the page: ad-hoc probes and static tests you write on the spot | Runtime.evaluate |
| `trace` | a DevTools performance trace over the load (+ `--interact`): a devtools-loadable `trace.json` AND a compact `*-summary.json` (FCP/LCP, long tasks, total blocking time). Read the summary, never the raw trace | Tracing.start/end |
| `har` | a valid HAR 1.2 of the network over the load (+ `--interact`/`--duration`; `--bodies` to include response bodies) AND a compact `*-summary.json` of network SIGNALS: totals + by-resource-type, first/third-party origins by bytes, render-blocking candidates (grounded in the CDP initiator + priority + renderBlockingStatus when exposed, each with a stated `basis`; confirm against the DOM), weight offenders (largest/slowest), and hygiene (uncompressed text, missing cache headers, redirects, HTTP errors). Read the HAR summary, never the raw HAR. Feeds be-fast-and-stable (request weight, render-blocking), be-sustainable (bytes over the wire), and be-private-and-secure (third parties) | Network domain |
| `discoverability` | how much of the page a crawler that does NOT run JavaScript can see: fetches the RAW server HTML (a plain request, no JS) and diffs it against the rendered DOM, reporting `coveragePct` (share of rendered content words also present in the raw HTML), `isJsShell`, empty SPA mounts (`#root`/`#app`/`#__next` shipped empty), and whether the title/h1/meta-description survive without JS. Also captures a **browser-view vs crawler-view screenshot pair** (`-rendered.png` with JS on, `-crawler.png` with JS disabled) - for a shell site the crawler view is blank, the single most legible evidence. Reference both in the finding's `artifacts` so they render in the report and scorecard. This is the url-influence failure mode (JS-rendered SPAs reach AI crawlers and search as empty shells) made measurable per-site. Feeds `be-discoverable` and `be-agent-ready` | fetch + DOM |

Common options the harness simply applies (you choose them, it does not):
`--emulate-media prefers-color-scheme=dark,prefers-reduced-motion=reduce`,
`--viewport 360x800`, `--wait <ms>`, `--selector <css>`, `--interact "<js>"`,
`--out <path>`, `--source <dir>`.

You may also run **any other tool you judge useful** at inspection time. None of
these is wired into the runtime; you invoke them yourself when they help:

- **Lighthouse**: `npx -y lighthouse <url> --output=json --quiet
  --chrome-flags="--headless=new --no-sandbox"` for LCP/CLS/TBT and the a11y /
  best-practices / SEO audits. Use it to corroborate the Lighthouse-dimension
  principles, or skip it and gather the same signal first-party with `layout`
  and `evaluate`.
- **axe-core**: inject it and run it via the `evaluate` primitive, e.g. fetch
  the script text and `--expr` a call to `axe.run()`, to enumerate accessibility
  violations. Or write your own contrast/label/role probes with `evaluate`.
- **Chrome DevTools MCP skills** (optional): if your agent environment exposes
  Chrome DevTools MCP, its `memory-leak-debugging` skill provides a stronger
  workflow for `be-memory-efficient`: baseline, target and final heap snapshots,
  memlab analysis, and common leak-pattern diagnosis. Do not make it a
  dependency; the package native `heap` primitive is still the default evidence
  path.
- **Your own static tests**: when no tool fits, write a probe with `evaluate`
  (e.g. focus an element and read its computed outline; diff two heap summaries;
  measure the same component in two containers). This is the point of leaning on
  the model: you can invent the test the situation needs.

## Method

### 0. Read the project config (if present) and set the bar

Before anything else:

1. **Read `web-uplift.json`** if one exists (at the site root, the `--source`
   dir, or passed explicitly). It conforms to
   [schema/config.schema.json](../../../schema/config.schema.json) and lets the
   developer declare `siteType`, `scope`, per-principle `optOut` (with a
   reason), and `intent`. **Honour it.** A declared `optOut` means you report
   that principle as `opted-out` with the developer's reason and do NOT count it
   as an issue. `intent` sets context you judge against; it does not silence
   findings. If no config is present, proceed with judgement (step 4). Record in
   the report's `config` field whether one was loaded.
2. **Consult the mapped guidance UP FRONT.** For each principle you will judge,
   look at its checks' `guides` lists and `search`/`retrieve` the relevant
   Modern Web Guidance guides from the live feed (at the pinned
   `guidanceCatalogVersion`) BEFORE you judge, so you set the bar from the
   current recommended approach rather than from memory. Also read any
   check-level `references`; these cover non-MWG standards, methods, and optional
   tools such as the Chrome DevTools MCP memory-leak-debugging skill for memory
   analysis. The `guides` and `references` entries are declarative pointers, not
   tests; you still decide what evidence proves the outcome. Cache
   `list`/`retrieve` for the run.

### 1. Recon and coverage (decide which pages to audit)

Use `dom` (with `--source` if you have it) and a `screenshot` to understand the
entry page: SPA or MPA, framework, the meaningful surfaces (routes, forms,
overlays, key flows). For a hash-routed SPA each route is reached as
`<url>#<route>` and a real reload is needed to re-run per-route styles; the
primitives navigate via about:blank already, so just pass the route URL. Note an
auth wall or bot block and stop with `status: blocked` if you cannot proceed.

Then decide COVERAGE, do not just audit the homepage. A site is its templates,
and most quality problems hide on the pages people actually use (articles,
product or detail pages, listings, forms, checkout, search, account). Work out
whether to navigate and where:

- Discover candidate routes: read the nav/menu and prominent internal links from
  the DOM; fetch `/sitemap.xml` and `/robots.txt` (an `evaluate` `fetch(...)`, or
  point a primitive at those URLs); check the web app manifest (the
  `<link rel="manifest">` target) for `start_url` and `shortcuts`; for an SPA,
  enumerate routes from the router or the visible links.
- Select a REPRESENTATIVE set, not every URL: the homepage PLUS one example of
  each distinct page archetype/template the site has, e.g. a content/article or
  detail page, a section or listing/index page, a primary form or interactive
  flow, search results, and any surface a specific principle targets. Aim for a
  handful (roughly 4 to 8) covering the distinct templates and the
  highest-traffic or highest-risk journeys. De-duplicate pages that share a
  template (audit one, note it represents the rest).
- Justify it: in the plan and in the report's `paths`, list each page you will
  audit and WHY (which archetype or journey it represents), and state explicitly
  what you are NOT covering and why. No silent homepage-only. If the site
  genuinely is a single page, say so as an explicit judgement, do not assume it.

Principles are then judged across this set: some are global (security headers,
manifest, transport) and judged once; many are per-page (layout, color-scheme,
headings, content, forms) and must be checked on the representative pages, not
only the entry URL. Aggregate findings across pages and record which page each
came from.

**User flows.** When the important surfaces are reached by a JOURNEY (a checkout,
a signup, a search, an SPA route sequence) rather than a static URL, replay a
recorded flow instead of guessing selectors: `node runner/flow.mjs replay
<flow.json> --out <dir>` (accepts web-uplift's own `flow record` output, a Chrome
DevTools Recorder export, or a hand-authored flow.json). It drives the steps over
CDP and captures a screenshot per step into `<dir>`; judge the per-step states as
additional paths and record the flow in `paths`.

### 2. Plan the evidence you need, per principle

Read every principle check, its `detectableVia` HINT, its `guides`, and any
`references` (which you already consulted up front in step 0). For each, decide
what evidence WOULD let you judge it, and under which condition. Examples (not a
script; you adapt to the actual page):

- respects-color-scheme -> `screenshot`/`dom --selector` under
  `--emulate-media prefers-color-scheme=dark`; does the surface re-tint?
- respects-reduced-motion -> `video --interact` or an `evaluate` of
  `getAnimations()` under `--emulate-media prefers-reduced-motion=reduce`.
- responsive-no-horizontal-scroll -> `layout --viewport 360x800`; is there
  horizontal overflow? a `screenshot` shows the clipping.
- component-level-responsiveness -> `dom --selector` of the same component in a
  wide vs narrow container, or CSS inspection for `@container`.
- input-modality-aware (focus) -> an `evaluate` probe that focuses the control
  and reads the computed outline.
- be-fast-and-stable -> `layout` (CLS + long tasks) AND a `trace` (capture a
  performance trace; read its `*-summary.json` for navigationStart->FCP/LCP, long
  tasks, total blocking time), and/or Lighthouse. Record the trace artifact path
  in the finding so the perf claim is backed by concrete evidence.
- network-relevant principles (be-fast-and-stable's request weight,
  be-private-and-secure's transport/third-party surface, be-sustainable's bytes
  over the wire) -> a `har` capture; read its `*-summary.json` (totals,
  by-resource-type, first/third-party origins, render-blocking candidates, weight
  offenders, hygiene signals), NEVER the raw multi-MB HAR, and record the `.har`
  artifact path in the finding. renderBlockingCandidates are GROUNDED in the real
  CDP signals the har capture records per request - the rich `_initiator`
  (parser|script|preload, with the inserting document url/line or the script call
  frame), the `_priority` (initial + final), and `_renderBlockingStatus` when the
  Chrome build exposes it - and each candidate carries an explicit `basis`. The
  HAR alone is partial (it does not by itself show `<head>` placement or
  async/defer/type=module), so treat the list as the STARTING signal and CONFIRM
  it against the live DOM: use `dom`/`evaluate` to read the real element's
  placement and its `async` / `defer` / `type=module` attributes before asserting
  a resource is render-blocking (e.g. a parser-inserted module script is deferred
  by spec and is not render-blocking). The harness as a whole CAN determine this;
  combine the HAR initiator/priority with the DOM.
- be-memory-efficient -> the memory-tracer-style before/after methodology with
  the `heap` primitive: take a BASELINE `heap` snapshot, then take a POST snapshot
  after repeating a representative interaction ~10x via `--interact` (open/close a
  modal, navigate a route and back, infinite-scroll a list), and COMPARE the two
  summaries for retained growth (totals: nodeCount/totalSelfSizeBytes; and by
  constructor: a growing Detached* population). Corroborate with
  Performance.getMetrics (JSHeapUsedSize, Nodes) across the same window, and an
  `evaluate` probe sampling listener/timer counts before vs after. If Chrome
  DevTools MCP is available, consult its `memory-leak-debugging` skill: capture
  baseline, target and final snapshots, then use memlab or the provided compare
  workflow to identify leak traces. The package-native `heap` primitive remains
  the default path. Read the heap SUMMARY, never the raw .heapsnapshot unless a
  dedicated heap-analysis tool is doing the analysis. This pairs naturally with
  the multi-page coverage (step 1): run the leak test on the INTERACTIVE
  archetypes (SPA routes, feeds, editors, modal-heavy pages), not a static
  content page. If a page has no representative interaction to repeat, do not
  fabricate one - mark no-leak-under-repeated-interaction not-applicable with a
  rationale (bounded-footprint and the detached-DOM/listener check still apply
  from a single state). detached nodes can be intentional caches, so judge
  confidence rather than asserting a bug.
- be-inclusive -> axe via `evaluate`, and/or Lighthouse a11y, and/or your own
  contrast/label probes; plus a screenshot to judge legibility/alignment.
- follow-best-practices / be-discoverable -> a `dom`/`evaluate` probe for
  doctype, charset, title, meta description, viewport, anchor hrefs; and/or
  Lighthouse.
- be-discoverable / be-agent-ready -> the `discoverability` primitive: it
  reports how much of the rendered content is present in the RAW server HTML
  (`coveragePct`), whether the page is a JS shell, and whether title/h1/meta
  survive without JavaScript. A low coverage / `isJsShell: true` means AI
  crawlers and search see little to nothing (the url-influence failure mode) -
  a real `be-discoverable`/`be-agent-ready` finding. Confirm a surprising result
  against the raw HTML and the `dom` primitive before asserting it.

You own this mapping. If the HINT names a tool you do not want to use, use a
different one. If you want evidence the HINT does not mention, gather it.

### 3. Gather the evidence

Run the primitives and tools you planned. Keep artifacts (screenshots, videos,
heap summaries, layout JSON, Lighthouse JSON) under the report directory or
`scratch/` (gitignored). Capture enough that a reader could verify each finding.

### 4. Reason and judge every principle (quality without shaming)

For each principle, first decide **applicability**, then **verdict**, and record
both in `principleOutcomes`:

- **Opted out.** If `web-uplift.json` declared an `optOut` for this principle
  (or check), report it as `opted-out` with the developer's reason and move on.
  Do not raise findings against it.
- **Applicability by expectation.** Read the principle's
  `applicability.expectation`:
  - `default` principles (respect-user-preferences,
    implement-natural-interactions, provide-guided-navigation,
    maximize-content-reduce-noise, adapt-to-the-form-factor, be-fast-and-stable,
    be-inclusive, follow-best-practices, be-discoverable, be-private-and-secure,
    be-trustworthy, be-memory-efficient) are expected of essentially every site;
    absence is a finding. (be-memory-efficient is `default`, but its
    no-leak-under-repeated-interaction check is contextual on the page having a
    representative interaction to repeat - see below.)
  - `contextual` principles (be-resilient's offline/installable aspect,
    be-internationalised, be-sustainable's absolute weight bar, be-agent-ready,
    and public discoverability for a deliberately gated site) legitimately may
    not apply. If there is no declared `intent`/`optOut`, **make a judgement
    call** on applicability from the recon (siteType, surfaces). If you judge it
    does not apply, mark it `not-applicable` WITH A RATIONALE rather than
    penalising the site. If you judge it does apply, judge it normally.
- **Verdict.** For each applicable principle check, weigh the evidence and decide
  pass or issue. Be honest about `confidence` for subjective judgements.

So the four reported statuses are distinct: `pass`, `issues`, `not-applicable`
(you judged it does not apply, with a reason), and `opted-out` (the developer
declared it, with their reason). Never silently drop a `default` principle, and
never penalise a `contextual` one you reasonably judged out of scope.

For each issue, use the check's `guides` (already consulted in step 0) to cite
the most relevant Modern Web Guidance `id`; run a fresh `search` if you need to
refine. Search the feed ad hoc for anything you observe that no principle names.

### 5. Findings and task list

Classify each divergence into a finding tied to a `principleId` /
`principleCheckId` and/or a guidance `id`. Severity: `critical` (core
content/flow unusable under a common condition), `high` (principle clearly
violated on a primary path), `medium` (meaningful divergence or partial
support), `low` (polish / missed modern technique). Every finding needs a
concrete `evidence` string naming the modality you used (e.g. "screenshot under
prefers-color-scheme: dark shows .ndm-card still #fff" or "layout primitive
reported CLS 0.18 from a banner injected at ~600ms"). Then derive a prioritised,
deduplicated `taskList` (highest leverage first), each task citing its
`findingIds` and a `guidanceId`.

### 6. Report (and where it goes: retained, comparable runs)

Runs are RETAINED so they can be compared over time. Write each run into its own
timestamped directory and keep a `latest` pointer:

- Default report dir: `reports/<host>/<runId>/` where `<runId>` is a real
  timestamp (an ISO timestamp with `:`/`.` replaced by `-`, e.g.
  `2026-06-13T17-30-00-000Z`; use the actual current time). `--out <dir>`
  overrides this.
- After writing, point `reports/<host>/latest` at the run dir (a symlink, or a
  `latest.txt` naming the run dir where symlinks are unavailable). The
  `runner/run-history.mjs` helpers (`runDir`, `updateLatest`) compute these for
  you if you drive them from a script; otherwise just follow the layout.
- Keep evidence artifacts under the run dir (e.g. `<runId>/evidence/...`) so a
  run is self-contained and its before/after artifacts move with it.

Write two files in the run dir:

- `report.json` - MUST validate against
  [schema/findings.schema.json](../../../schema/findings.schema.json). Set
  `evidenceUsed` (the modalities and tools you actually ran), `config` (whether a
  `web-uplift.json` was loaded), `principleOutcomes` (per-principle
  applicability + status, so `opted-out` and `not-applicable` show distinctly
  from pass/issue, each with its reason), and the structured `artifacts` manifest
  (one entry per evidence file you kept: `{type, path, caption, condition,
  findingIds}` with `path` relative to the run dir). Each finding SHOULD list the
  artifact paths that evidence it in `finding.artifacts`, so every "action to fix"
  ties back to concrete before-evidence. If scoring against `--expected`, include
  your own precision/recall under an `eval` field.
- `report.md` - human-readable: page profile, the evidence you gathered, an
  artifacts-manifest table, findings grouped by principle (embed screenshots
  inline with `![](path)` and link video/trace/har/heap), the prioritised task
  list, and anything skipped or low-confidence.

### 6b. Compare runs (before/after)

To measure progress across runs, diff two retained runs:

```sh
node aggregate/compare.mjs <host|url> [runA] [runB]   # web-uplift compare ...
```

Defaults to the two most recent runs (older = before, newer = after) and writes
`compare.md` + `compare.json` into the newer run: principle status changes,
per-finding resolved/new/persisting, metric deltas (LCP/INP/CLS, Lighthouse
scores where present), network/HAR deltas (request count, transferred bytes),
and PAIRED before/after screenshots (matched by capture condition). Fix mode
(below) runs this automatically at the end, so a fix run shows the before->after.

### 6c. Scorecard (build it, then present it — this is how a run ends)

After the report is written (and after any compare in fix mode), generate the
interactive scorecard and use it as the close of your reply:

```sh
node aggregate/scorecard.mjs <host|url>   # web-uplift scorecard <host>
```

This rolls ALL retained runs for the host into a self-contained
`reports/<host>/scorecard.html` (Lighthouse-style outcome gauges, a top-3, a
per-finding deep-dive, a score-over-time history with per-run and per-outcome
deltas, and a before/after panel). It also prints a compact **text scorecard**
to stdout.

End your run by:

1. Showing that text scorecard inline (overall score, the six outcome scores,
   and the top-3 "do these first"). It leads with outcomes, not a raw findings
   dump. Do NOT re-type a long list of every finding above it.
2. Linking the interactive report: `reports/<host>/scorecard.html` (and mention
   the History tab shows the deltas over time once there is more than one run).

Fix mode emits the scorecard automatically; for a report-only run, run the
command above yourself so the user always gets the same close.

### 7. Fix mode (`--fix --source <dir>`, the model-driven hill-climb)

Only with local source. This is a MODEL-DRIVEN hill-climb: YOU write every edit
based on Modern Web Guidance. There are no canned transforms anywhere. You can
run this loop entirely INSIDE your own session (the default, subscription path)
- you do not need the headless runner; you ARE the model.

Inputs: the findings + `taskList` you just produced (step 5), or a pre-aggregated
report passed with `--findings <path>` (in which case you may skip the baseline
audit and go straight to the climb).

The loop, highest-leverage task first:

1. `retrieve` the task's guidance guide and read its technique + browser-support
   notes (assume Baseline Widely available is safe; follow the guide's fallback
   advice otherwise, unless `web-uplift.json` states a custom policy).
2. Write the fix into the local source under `<dir>`. You are the coding agent.
   Honour `web-uplift.json`: never "fix" a principle reported `opted-out` or
   `not-applicable` - those are out of scope, not issues.
3. Re-gather the relevant evidence (the SAME primitive and emulated condition you
   used to find it) and confirm the issue is gone. Compare against a known-good
   reference where one exists (e.g. a `?mode=fixed` variant). If a fix introduces
   a new issue, log it and continue.
4. After a pass, recount the OUTSTANDING issue-findings: findings whose
   `principleId` is NOT one you reported `not-applicable`/`opted-out`. This is the
   number that must climb DOWN; print it so the descent is visible (e.g.
   `9 -> 5 -> 0`).
5. Repeat passes until there are zero outstanding `issues` (a clean audit may
   still carry `not-applicable`/`opted-out` principles - that is a pass), or a
   pass makes no further progress, or `--max-iterations` is hit. Record
   `budget.auditPasses`. Optionally open a PR (branch, commit only the source
   changes, `gh pr create`).
   - **Goal-directed stop (`--goal-overall <n>` / `--goal-min <outcome>=<n>` /
     `--goal-max-critical <n>` / `--goal-max-high <n>`):** when a goal is set,
     also stop as soon as the scorecard meets it, so you can climb to a target
     (e.g. `overall>=80`, no criticals) without chasing every last low-severity
     issue. Print the score per pass.
6. **Emit the before/after comparison.** Preserve the baseline as a `-before`
   run and the final state as an `-after` run (see step 6's run layout) and run
   the compare (step 6b) so the fix produces a `compare.md` showing the measurable
   before->after: outstanding `9 -> 0`, which findings resolved, and the metric /
   network / screenshot deltas. The headless `web-uplift fix` does this for you;
   in-session, run `node aggregate/compare.mjs <host> <before> <after>` yourself.

Never edit source outside `<dir>`. Never run fix mode against a site whose
source you do not have locally.

The headless `web-uplift fix` / `npm run fix` command drives exactly this loop
unattended via an agent CLI (API tokens); the in-session path above is the same
methodology with no extra billing.

## Why fully agentic (and why no fast path)

Tooling normally bakes in a check registry and falls back to it. This project
deliberately does not: web quality is open-ended, the modern platform moves
fast, and a fixed registry rots and misses context. By leaning on the model,
the method stays current (you query the live guidance feed), it generalises
(you can judge a principle you have never seen a check for), and tool choice is
an inspection-time decision, not a runtime constant. The principles say what
good is; you work out how to see it.

## Cross-agent note (this is NOT Claude-only)

This skill is plain markdown methodology any agent can follow. It runs as
`/web-audit <url>` in Claude Code, Codex, Gemini CLI, Antigravity, GitHub
Copilot, and opencode from this repo, and as a raw prompt in anything else
("Read the file .claude/skills/web-audit/SKILL.md and follow its instructions
exactly, with these arguments: <url>"). Each CLI is wired to this one canonical
SKILL.md via a thin per-agent entry point; see the support matrix and the
"How to add an agent" section in [README.md](../../../README.md) and
[runner/README.md](../../../runner/README.md).

**No MCP server is required.** The evidence primitives are a plain Node CLI
(`node evidence/cli.mjs <primitive> <url> ...`, raw CDP via
chrome-remote-interface) that any agent able to run shell commands and read this
file can use directly. The repo's `web-uplift` MCP server only *distributes*
this SKILL.md to MCP-aware hosts as a convenience; it is optional and there is no
browser-automation MCP server anywhere in this project. The only hard
requirements on the host are: Node, a `google-chrome-stable` (override with
`CHROME_BIN`), `ffmpeg` (for the video primitive), and network access for the
Modern Web Guidance feed and optional Lighthouse (`npx`).

Finish your reply with a one-paragraph TLDR: finding count by severity, which
evidence modalities and tools you actually used, the single highest-leverage
fix, and (in fix mode) how many findings you verified fixed.
