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
   the spec of what good looks like, as OUTCOMES. Nine principles: Una Kravets'
   five modern-UX principles (respect-user-preferences,
   implement-natural-interactions, provide-guided-navigation,
   maximize-content-reduce-noise, adapt-to-the-form-factor) plus four
   Lighthouse-dimension principles (be-fast-and-stable, be-accessible,
   follow-best-practices, be-discoverable). Each check has a `detectableVia`
   HINT. The hint may MENTION candidate evidence or tools; it MANDATES nothing.
2. **Guidance** - Modern Web Guidance via the `modern-web-guidance` npm feed
   (the *how*). See [guidance/lookup.md](../../../guidance/lookup.md): `search`
   to find the recommended approach, `retrieve` to get the fix detail.
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

### 1. Recon

Use `dom` (with `--source` if you have it) and a `screenshot` to understand the
page: SPA or MPA, framework, the meaningful surfaces (routes, forms, overlays,
key flows). For a hash-routed SPA each route is reached as `<url>#<route>` and a
real reload is needed to re-run per-route styles; the primitives navigate via
about:blank already, so just pass the route URL. Note an auth wall or bot block
and stop with `status: blocked` if you cannot proceed.

### 2. Plan the evidence you need, per principle

Read every principle check and its `detectableVia` HINT. For each, decide what
evidence WOULD let you judge it, and under which condition. Examples (not a
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
- be-fast-and-stable -> `layout` (CLS + long tasks) and/or Lighthouse.
- be-accessible -> axe via `evaluate`, and/or Lighthouse a11y, and/or your own
  contrast/label probes.
- follow-best-practices / be-discoverable -> a `dom`/`evaluate` probe for
  doctype, charset, title, meta description, viewport, anchor hrefs; and/or
  Lighthouse.

You own this mapping. If the HINT names a tool you do not want to use, use a
different one. If you want evidence the HINT does not mention, gather it.

### 3. Gather the evidence

Run the primitives and tools you planned. Keep artifacts (screenshots, videos,
heap summaries, layout JSON, Lighthouse JSON) under the report directory or
`scratch/` (gitignored). Capture enough that a reader could verify each finding.

### 4. Reason and judge every principle

For each principle check, weigh the evidence and decide: pass, issue, or
not-applicable (e.g. a brand area intentionally always-light). Be honest about
`confidence` for subjective judgements. For each issue, run the guidance
`search` (its `guidanceQuery`) to confirm the recommended modern approach and to
get a `guidanceId` to cite. Search the feed ad hoc for anything you observe that
no principle names.

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
  `evidenceUsed` (the modalities and tools you actually ran) so the report is
  honest about method. If scoring against `--expected`, include your own
  precision/recall under an `eval` field.
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

## Cross-agent note

This skill is plain markdown methodology any agent can follow. It runs as
`/web-audit <url>` in Claude Code, Codex, Gemini CLI, and Antigravity from this
repo (each CLI is wired to this one canonical SKILL.md; see
[runner/README.md](../../../runner/README.md)). The evidence primitives are a
plain Node CLI any agent can shell out to.

Finish your reply with a one-paragraph TLDR: finding count by severity, which
evidence modalities and tools you actually used, the single highest-leverage
fix, and (in fix mode) how many findings you verified fixed.
