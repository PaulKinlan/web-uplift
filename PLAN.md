# Plan

Goal: a repeatable loop that, for any URL, produces a list of *actionable*
modern-web findings, and (when the source is available) climbs the site toward
modern web quality by applying fixes and re-auditing. Scales from "demo one site
live" to "survey the top 1,000 sites and tell us where the web is weakest."

## Architecture: fully agentic, no fast path

The defining decision: **the model is the auditor.** There is no deterministic
check runner, no per-principle check registry, no deterministic transforms, and
no tool invocation baked into a runtime. At inspection time the model decides
how to verify each principle, what evidence to gather, which tools to use
(Lighthouse, axe, raw CDP), and may write ad-hoc static tests on the fly.

Why, explicitly:

- **Lean on the model's capabilities.** Web quality is open-ended and the
  platform moves fast. A fixed check registry rots, misses context, and becomes
  the path tools quietly fall back to. We deliberately do not provide that
  fallback.
- **Tools and tests are inspection-time choices, not runtime constants.** The
  model may run Lighthouse for the Core Web Vitals / a11y / best-practices / SEO
  signal, inject axe-core, take a screenshot or a transition video, take a heap
  snapshot, read layout metrics, or write its own probe. Nothing in code mandates
  any of these.
- **The pieces stay separable and declarative.** Principles are the spec
  (outcomes + non-binding hints), SKILL.md is the method, the evidence primitives
  are generic senses, the guidance feed is the live how-to. Intelligence is the
  model's.

## What exists

- **Evidence primitives** ([evidence/cli.mjs](evidence/cli.mjs)) - generic,
  judgement-free capabilities over raw CDP (`chrome-remote-interface`, system
  `google-chrome-stable`, no Playwright/Puppeteer; `ffmpeg` for video):
  `screenshot`, `video` (screencast -> MP4), `heap` (snapshot -> readable
  summary), `layout` (metrics + CLS observer + long tasks), `dom` (DOM +
  computed styles + page/source HTML/CSS), `evaluate` (run a model-supplied
  probe in the page). Each accepts emulated conditions (media features,
  viewport) the model chooses. They return data/artifacts and make no decisions.
- **Principles** ([principles/principles.json](principles/principles.json)) -
  Una Kravets' five modern-UX principles plus four Lighthouse-dimension
  principles (`be-fast-and-stable`, `be-accessible`, `follow-best-practices`,
  `be-discoverable`). Each check is an outcome with a `detectableVia` HINT that
  may mention candidate evidence/tools without mandating them.
- **The methodology** ([.claude/skills/web-audit/SKILL.md](.claude/skills/web-audit/SKILL.md))
  - how a model recons, plans the evidence per principle, gathers it, reasons,
  judges every principle, reports against the schema, and (with `--source`)
  fixes and re-audits.
- **Guidance** ([guidance/](guidance/)) - the `modern-web-guidance` npm feed
  (`search`/`retrieve`/`list`), queried live for the recommended approach and the
  fix detail.
- **Runner** ([runner/](runner/)) - a generic fan-out that invokes the model
  per URL through a single `{agent: headless-command}` map
  (claude/codex/gemini/antigravity/copilot/opencode; adding an agent is one map
  entry). It orchestrates; it has no checks. No agent needs a browser-automation
  MCP server: the audit shells out to `node evidence/cli.mjs ...`, so any agent
  that can run shell + read the skill works.
- **Eval fixture** ([eval/](eval/)) - the seeded modern-UX issues are frozen as
  a dedicated ground-truth fixture (`eval/fixtures/seeded-issues/site` +
  `expected-findings.json`, nine findings F-001..F-009). The eval runs the
  agentic audit against the fixture and compares the model's findings to
  expected (precision/recall). The eval may score; the audit itself is
  model-driven.
- **Playground** ([playground/](playground/)) - the genuinely-correct demo site.
  Each scenario ships its Modern Web Guidance technique by default, so an audit
  finds zero seeded issues; it is the precision / regression guard. The fixture
  proves recall, the live playground proves precision.

## What was removed (and stays removed)

- The deterministic CDP check runner (`auditor/audit.mjs`, `checks.mjs`,
  `score.mjs`, `report.mjs`, `guidance.mjs`).
- The deterministic fixer and per-issue transforms (`fixer/fix.mjs`,
  `transforms.mjs`).
- The `npm run audit`/`npm run fix` deterministic scripts and the docs/CI that
  presented a deterministic "fast path."
- The chrome-devtools browser-automation MCP server (a parallel browser path);
  the model uses the evidence primitives instead.

These are not kept as an optional fast path. The system does not lean on a
fallback.

## Phases

- **Phase 0 - skeleton.** Done: repo layout, schema, principles, guidance
  integration, playground + ground truth, the SKILL.md methodology.
- **Phase 1 - single-URL agentic report, validated against ground truth.** Done.
  The model audits the frozen seeded-issues fixture
  ([eval/](eval/)) using the evidence primitives, judges the principles, and
  self-scores precision/recall vs `expected-findings.json` (nine findings, 100%
  recall); auditing the genuinely-fixed live playground is the false-positive
  guard (zero findings). See [examples/playground-report.md](examples/playground-report.md)
  and [eval/README.md](eval/README.md).
- **Cross-agent portability.** Done. One canonical skill + spec + evidence CLI;
  thin per-agent wrappers for Claude Code, Codex, Gemini CLI, Antigravity,
  GitHub Copilot, and opencode; the runner fans out via a single agent map; no
  MCP server is required. Adding an agent is one map entry plus one wrapper file.
- **Phase 2 - explore + plan quality.** Recon (classify SPA/MPA, framework, auth
  wall, cookie banner; enumerate routes/forms/overlays/flows) and a reviewable
  per-site plan of what to exercise under which conditions.
- **Phase 3 - batch over real sites.** Source URLs (HTTP Archive / CrUX, or
  Tranco fallback); fan out with bounded concurrency, isolated profiles,
  resumable, hardened against cookie walls / bot blocks; cost model on a pilot.
- **Phase 4 - cross-site study.** Aggregate into principle / guidance-category
  frequency, severity distributions, per-framework and per-agent breakdowns. A
  "State of modern web" summary.
- **Phase 5 - fix mode (the hill-climb).** With local source, the model writes
  guidance-backed fixes, re-gathers evidence to verify, and opens a PR. Loop
  until no findings above a chosen severity remain.

## Open questions

1. **Guidance feed caching / version pinning.** The feed is queried live. Pin a
   `--skill-version`, decide bump cadence, cache `list`/`retrieve` for offline
   batch runs.
2. **Eval design for an agentic audit.** Scoring the seeded scenarios joins on
   scenario id and checks principle alignment. Still open: how to score
   subjective/aesthetic findings, and whether a "should NOT flag" list guards
   false positives beyond `?mode=fixed`. Run-to-run variance (the model is not
   deterministic) means the eval should report a distribution, not a single
   number, once run at scale.
3. **Emulation fidelity.** Some issues (layout shift, container-query
   breakpoints, focus-visible, touch input) depend on real device
   characteristics. How faithfully does headless CDP emulation reproduce them
   (note: under a device-metrics override `window.innerWidth` can lag the
   override, so the `layout` primitive references `visualViewport.width`), and
   where do we need real-device or headed runs?
4. **Tool budget.** Lighthouse / axe / video / heap each cost wall-clock and
   tokens. The model chooses what to run; at batch scale we may want soft
   guidance on a per-site evidence budget without re-introducing a fixed
   pipeline.
