# Plan

Goal: a repeatable loop that, for any URL, produces a list of *actionable*
modern-UX findings, and (when the source is available) climbs the site toward
modern web quality by applying fixes and re-auditing. Scales from "demo one
site live" to "survey the top 1,000 sites and tell us where the web is
weakest against modern UX."

## What already exists (don't rebuild)

- `chrome-devtools-mcp` exposes the browser: navigation, input (`click`,
  `fill`, `hover`), `take_snapshot` (the accessibility/DOM snapshot),
  screenshots, CSS/network inspection, performance traces, and (importantly
  for this project) device and preference emulation: viewport resize,
  `emulate_cpu`/`emulate_network`, and CDP overrides for things like
  `prefers-color-scheme`, `prefers-reduced-motion`, and device metrics.
  `--isolated`/`--headless` give clean repeatable sessions.
- **Modern Web Guidance** ships as a real, machine-readable feed: the
  `modern-web-guidance` npm package exposes `search "<query>"`,
  `retrieve "<id>"`, and `list` (137 guides as of writing, each with an `id`,
  `category`, `description`, and `featuresUsed`). This is the knowledge layer;
  see [guidance/README.md](guidance/README.md). (This resolves the original
  open question of feed-vs-scrape: there is a feed.)

This project is the layer above: test-plan generation, principle/guidance
evaluation, structured output, batch execution, aggregation, the fix-mode
hill-climb, and ground-truth evals.

## Phase 0 - Skeleton

- [x] Repo layout, `.mcp.json`, findings/report schema, runner/aggregator.
- [x] Principles layer (`principles/principles.json`) - all 5 confirmed, each
  with detectable `checks` + `guidanceQuery`.
- [x] Guidance integration plan (`guidance/`) - uses the npm feed.
- [x] Playground with seeded modern-UX issues + `expected-findings.json`.
- [x] `web-audit` skill draft (report mode + fix mode).

## Phase 0.5 - Deterministic CDP auditor + fix engine (shipped)

Done. The agent skill is great for open-ended exploration, but for a
repeatable, CI-runnable, scored loop we also ship a deterministic engine that
drives the system Chrome over the Chrome DevTools Protocol directly
(`chrome-remote-interface`, no Playwright/Puppeteer):

- [x] `auditor/audit.mjs` (`npm run audit -- <url>`): launches headless Chrome,
  parses the ephemeral DevTools port, and runs the detectable checks via Page /
  Runtime / DOM / CSS / Emulation (setEmulatedMedia for color-scheme +
  reduced-motion, setDeviceMetricsOverride for narrow viewport) and a
  layout-shift PerformanceObserver.
- [x] Findings conform to `schema/findings.schema.json` (validated with ajv
  2020) plus a markdown report; scored for precision/recall against
  `playground/expected-findings.json`.
- [x] Real run on the playground: **issues mode precision 100% / recall 100%**
  (6/6 seeded issues, principle alignment 6/6), **`?mode=fixed` 0 findings**.
- [x] `fixer/fix.mjs` (`npm run fix -- --target <path>`): the audit -> fix ->
  re-audit hill-climb. Deterministic, guidance-backed transforms per issue
  class (light-dark(), prefers-reduced-motion gate, fluid max-width,
  :focus-visible, reserved min-height, @container). Real run takes the
  playground **6 findings -> 0 in one pass**. `--pr` opens a demo PR via gh.
  Architecture leaves a seam for an LLM transform path alongside the
  deterministic one.
- [x] Committed example report in `examples/` and a GitHub Actions workflow
  (`.github/workflows/audit-playground.yml`) that re-audits on push to master
  and commits the refreshed report.

## Phase 1 - Single-URL report loop, validated against ground truth

Done by the deterministic auditor (Phase 0.5). Exit criteria met: full recall
on the playground's labelled issues (6/6), zero findings on fixed mode, and the
report validates against `schema/findings.schema.json`. The agent-skill variant
can be tuned on top of the same ground truth.

- [x] Find **all** seeded playground issues mapped to the right principle, and
  **none** in `?mode=fixed`. The false-positive check matters as much as recall.
- [x] Severity thresholds and guidance-id citation wired in (guidance ids are
  resolved live from the `modern-web-guidance` feed when not run with
  `--no-guidance`).
- [x] Exit criteria: full recall, zero findings on fixed mode, schema-valid.

## Phase 2 - Explore + test-plan quality

- Recon step: snapshot the page, classify the app (SPA/MPA, framework, auth
  wall, cookie banner), enumerate meaningful paths: landing, primary nav
  routes, forms, modals/overlays, key flows (search, checkout, sign-up).
- For each path, the plan records what to *exercise* and under which
  *conditions* to evaluate (e.g. narrow viewport, dark preference, reduced
  motion, keyboard-only, slow CPU/network).
- Persist plans to `testplans/<host>.json` so they're reviewable, editable,
  and reused on re-runs (plan generation is the expensive/flaky step).
- Validate on 5-10 real sites we know well before going wide.

## Phase 3 - Batch runner over real sites

- Source URLs: HTTP Archive / CrUX (BigQuery, rank <= 1000), or Tranco as a
  zero-setup fallback (see `urls/README.md`).
- `runner/run-batch.mjs` fans out headless agent runs, one isolated browser
  profile each, bounded concurrency, per-site report directory, resumable
  (skip sites with an existing report).
- Hardening: cookie-consent dismissal, bot detection / blocked pages (record
  and skip), per-site time and token budget, retries.
- Cost model: measure tokens + wall-clock per site on a 20-site pilot before
  committing to 1,000.

## Phase 4 - Cross-site study

- `aggregate/aggregate.mjs` merges `reports/*/report.json` into principle and
  guidance-category frequency, severity distributions, per-framework
  breakdowns, and a per-agent breakdown when more than one agent has run.
- Output: a "State of modern web UX" summary, the headline artifact for
  pointing developers at the highest-leverage improvements.

## Phase 5 - Fix mode (the hill-climb)

- When the site's source is available locally, hand the prioritised task list
  to a coding agent that applies fixes following the relevant Modern Web
  Guidance guide (retrieved by `id`), then re-runs the audit.
- Loop: audit -> fix -> re-audit until no findings above a chosen severity
  remain (or no further progress is made).
- The playground is the rehearsal space: find issue -> cite the principle and
  the guidance fix -> edit playground source (or switch to `?mode=fixed`) ->
  re-audit -> show it's gone.

## Resolved

- **Una's five principles (was open #1).** RESOLVED: all five are confirmed
  from the talk transcript and encoded in `principles/principles.json`
  (respect-user-preferences, implement-natural-interactions,
  provide-guided-navigation, maximize-content-reduce-noise,
  adapt-to-the-form-factor), each with detectable `checks` and a
  `guidanceQuery`.
- **Browser engine for the deterministic auditor.** RESOLVED: the system Chrome
  driven directly over the Chrome DevTools Protocol via `chrome-remote-interface`
  (a thin CDP client, not an automation framework). No Playwright or Puppeteer.
  The ephemeral DevTools port is parsed from Chrome's stderr.
- **Scoring partial matches (was part of open #4).** RESOLVED for v1: the join
  key is the stable scenario id; principle alignment is reported separately and
  maps the ground truth's pre-rename principle ids to the current ones. Fixed
  mode is the false-positive guard (any finding is spurious).

## Open questions (to discuss)

1. **Guidance feed caching / version pinning.** The `modern-web-guidance` npm
   feed is machine-readable (`search`/`retrieve`/`list`). The auditor resolves
   guidance ids live via `search` (skip with `--no-guidance`, which CI uses for
   determinism). Remaining: pin a `--skill-version`, decide how often to bump,
   and cache `list`/`retrieve` payloads locally for offline batch runs.
2. **Fix-mode scope beyond the playground.** Shipped: (a) report-only task list,
   (b) PR mode (`--pr`), and (c) in-place source fixes + automatic re-audit, all
   real on the playground. Open: which becomes the default for third-party
   open-source sites, and standing up the LLM transform path (the architecture
   already leaves a seam for it next to the deterministic transforms) for issue
   classes the deterministic transforms do not cover.
3. **Eval ground-truth design (remainder).** Scoring of the seeded scenarios is
   resolved (see Resolved above). Still open: how to handle
   subjective/aesthetic findings that resist a binary pass/fail, and whether to
   add a "should NOT flag" list of acceptable patterns to guard against false
   positives beyond fixed mode.
4. **Emulation fidelity.** Some modern-UX issues (layout shift, container-query
   breakpoints, focus-visible behaviour) depend on real device characteristics
   and input modality. How faithfully can headless DevTools emulation
   reproduce them, and where do we need real-device or headed runs?
