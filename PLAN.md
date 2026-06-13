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

## Phase 0 - Skeleton (this commit)

- [x] Repo layout, `.mcp.json`, findings/report schema, runner/aggregator.
- [x] Principles layer (`principles/principles.json`) - 2 confirmed, 3 TODO.
- [x] Guidance integration plan (`guidance/`) - uses the npm feed.
- [x] Playground with seeded modern-UX issues + `expected-findings.json`.
- [x] `web-audit` skill draft (report mode + fix mode).

## Phase 1 - Single-URL report loop, validated against ground truth

- Run `/web-audit http://localhost:8080` until it reliably finds **all**
  seeded playground issues mapped to the right principle/guidance, and finds
  **none** in `?mode=fixed`. The false-positive check matters as much as
  recall.
- Tune: how aggressively the agent emulates devices/preferences, how it cites
  guidance IDs, severity thresholds, token budget.
- Exit criteria: full recall on the playground's labelled issues, zero
  findings on fixed mode, report validates against
  `schema/findings.schema.json`.

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

## Open questions (to discuss)

1. **Una's three remaining principles.** Only two of the five are confirmed
   here: *adapt to the user* and *adapt to the device*. The other three are
   placeholders in `principles/principles.json` and MUST be filled in from the
   talk (https://www.youtube.com/watch?v=uT7MVcCQ4rw) before the principles
   layer is complete. Do not invent them. Likely candidates from the modern
   Web UI space (NOT confirmed, do not encode as fact): adapt to context/state
   (container queries, `:has()`, scroll-driven), respect motion/interaction
   preferences (reduced motion, smooth view transitions), and resilient/
   accessible interactions (focus states, popover/dialog semantics) - but the
   talk is the source of truth.
2. **How Modern Web Guidance exposes use cases programmatically.** RESOLVED in
   v1: the `modern-web-guidance` npm package is a machine-readable feed
   (`search`/`retrieve`/`list`). Remaining sub-questions: version pinning (the
   skill uses a `--skill-version` stamp), how often the feed updates, and
   whether to cache `list` output locally for offline batch runs.
3. **Fix-mode scope for v1.** Three options, in increasing ambition:
   (a) task-list only (report the fixes, apply nothing); (b) generate a diff /
   open a PR for human review; (c) apply real source fixes in place and
   re-audit automatically. v1 ships (a) as the reliable default and (c) behind
   `--fix` against the local playground; (b) (PR mode) is the natural next
   step for real repos. Which becomes the default for third-party open-source
   sites is open.
4. **Eval ground-truth design.** `playground/expected-findings.json` labels
   each seeded issue with the principle it violates, the guidance `id` that
   fixes it, and a `detectableVia` note (e.g. emulate `prefers-color-scheme:
   dark`). Open: how to score partial matches (right principle, wrong
   guidance id?), how to handle subjective/aesthetic findings that resist a
   binary pass/fail, and whether to add a "should NOT flag" list of acceptable
   patterns to guard against false positives beyond fixed mode.
5. **Emulation fidelity.** Some modern-UX issues (layout shift, container-query
   breakpoints, focus-visible behaviour) depend on real device characteristics
   and input modality. How faithfully can headless DevTools emulation
   reproduce them, and where do we need real-device or headed runs?
