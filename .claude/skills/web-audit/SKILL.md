---
name: web-audit
description: Audit a URL for modern web quality and (optionally) fix it. This is a FULLY AGENTIC audit: YOU (the model) gather multi-modal evidence about the page with the generic evidence primitives, decide for yourself which tools to run (Lighthouse, axe, your own ad-hoc static tests), reason over that evidence, and judge every principle, then emit a findings report. There are no hard-coded checks and no fast path: the principles are the spec, this skill is the method, and you supply all the intelligence. Use when asked to web-audit, UX-audit, uplift, modernise, or quality-audit a site.
---

# Web audit (fully agentic)

Audit `$ARGUMENTS`: a URL, plus optional flags:

- `--out <dir>` - report directory (default `reports/<host>/`).
- `--source <dir>` - path to the site's local source, so you can read the
  authored HTML/CSS/JS, not just the rendered output.
- `--fix` - after auditing, apply fixes to local source and re-audit (requires
  `--source`). Without `--fix`, this is report mode (critique only).
- `--expected <file>` - a ground-truth file to self-score against (used for the
  playground eval).

## The contract: you are the auditor, not a runner

There is **no deterministic check runner** and there are **no fast paths** in
this project. Nothing decides for you whether a principle passes. You decide,
by gathering evidence and reasoning over it. The repo gives you two declarative
inputs and one generic capability:

1. **Principles** - [principles/principles.json](../../../principles/principles.json):
   the spec of what good looks like, as OUTCOMES. Fifteen principles: Una
   Kravets' five modern-UX principles (respect-user-preferences,
   implement-natural-interactions, provide-guided-navigation,
   maximize-content-reduce-noise, adapt-to-the-form-factor); two
   widened/narrowed Lighthouse-dimension principles (be-inclusive - the former
   be-accessible, widened beyond WCAG conformance; follow-best-practices -
   narrowed so it is no longer the catch-all for security and forms); two
   unchanged Lighthouse-dimension principles (be-fast-and-stable,
   be-discoverable); and six framework-derived principles
   (be-private-and-secure, be-resilient, be-internationalised, be-trustworthy,
   be-sustainable, be-agent-ready). Each check has a `detectableVia` HINT (may
   MENTION candidate evidence/tools, MANDATES nothing) and a `guides` list of
   Modern Web Guidance ids and/or query strings - declarative pointers you
   consult to set the bar, not hard-coded tests. Each principle also has an
   `applicability` block (`expectation: default | contextual`); see step 0 and
   step 4. The full coverage map (all 137 mwg guides -> principles) and the
   rationale for the set is in
   [docs/principles-analysis.md](../../../docs/principles-analysis.md).
2. **Guidance** - Modern Web Guidance via the `modern-web-guidance` npm feed
   (the *how*). See [guidance/lookup.md](../../../guidance/lookup.md): `search`
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

Primitives, all content- and tool-agnostic:

| Primitive | What it gives you | Key CDP |
|---|---|---|
| `screenshot` | a PNG (full or `--selector`-clipped) under any emulated condition | Page.captureScreenshot |
| `video` | an MP4 of an interaction window, frames assembled with ffmpeg; `--interact "<js>"` triggers the transition/animation | Page.startScreencast |
| `heap` | a readable heap summary (types/constructors by size); `--interact` to exercise first, for leak hunting | HeapProfiler.takeHeapSnapshot |
| `layout` | layout metrics, a CLS/layout-shift observer, long tasks, overflow at the current viewport | Page.getLayoutMetrics + observers |
| `dom` | DOM, computed styles for `--selector` list, page HTML/CSS, and (`--source <dir>`) the local source files | DOM/CSS/Runtime |
| `evaluate` | runs your own `--expr "<js>"` in the page: ad-hoc probes and static tests you write on the spot | Runtime.evaluate |

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
   current recommended approach rather than from memory. The `guides` entries
   are declarative pointers (mwg ids and/or query strings), not tests; you still
   decide what evidence proves the outcome. Cache `list`/`retrieve` for the run.

### 1. Recon

Use `dom` (with `--source` if you have it) and a `screenshot` to understand the
page: SPA or MPA, framework, the meaningful surfaces (routes, forms, overlays,
key flows). For a hash-routed SPA each route is reached as `<url>#<route>` and a
real reload is needed to re-run per-route styles; the primitives navigate via
about:blank already, so just pass the route URL. Note an auth wall or bot block
and stop with `status: blocked` if you cannot proceed.

### 2. Plan the evidence you need, per principle

Read every principle check, its `detectableVia` HINT, and its `guides` (which
you already consulted up front in step 0). For each, decide what evidence WOULD
let you judge it, and under which condition. Examples (not a script; you adapt to
the actual page):

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
- be-fast-and-stable -> `layout` (CLS + long tasks) and/or Lighthouse.
- be-inclusive -> axe via `evaluate`, and/or Lighthouse a11y, and/or your own
  contrast/label probes; plus a screenshot to judge legibility/alignment.
- follow-best-practices / be-discoverable -> a `dom`/`evaluate` probe for
  doctype, charset, title, meta description, viewport, anchor hrefs; and/or
  Lighthouse.

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
    be-trustworthy) are expected of essentially every site; absence is a
    finding.
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

### 6. Report

Write two files in `reports/<host>/` (or `--out`):

- `report.json` - MUST validate against
  [schema/findings.schema.json](../../../schema/findings.schema.json). Set
  `evidenceUsed` (the modalities and tools you actually ran), `config` (whether a
  `web-uplift.json` was loaded), and `principleOutcomes` (per-principle
  applicability + status, so `opted-out` and `not-applicable` show distinctly
  from pass/issue, each with its reason). If scoring against `--expected`,
  include your own precision/recall under an `eval` field.
- `report.md` - human-readable: page profile, the evidence you gathered (with
  artifact paths), findings grouped by principle, the prioritised task list, and
  anything skipped or low-confidence.

### 7. Fix mode (`--fix --source <dir>`, the hill-climb)

Only with local source. For each task, highest leverage first:

1. `retrieve` the task's guidance guide and read its technique + browser-support
   notes (assume Baseline Widely available is safe; follow the guide's fallback
   advice otherwise).
2. Write the fix into the local source under `<dir>`. You are the coding agent;
   there are no canned transforms.
3. Re-gather the relevant evidence (the same primitive/condition you used to
   find it) and confirm the issue is gone. If a fix introduces a new issue, log
   it and continue.
4. Repeat passes until no findings above your chosen severity remain or a pass
   makes no further progress. Record `budget.auditPasses`. Optionally open a PR
   (branch, commit only the source changes, `gh pr create`).

Never edit source outside `<dir>`. Never run fix mode against a site whose
source you do not have locally.

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
