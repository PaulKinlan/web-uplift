---
name: web-audit
description: Audit a URL for modern web UX quality and (optionally) fix it. Explores the site, writes a per-site test plan of meaningful user paths, evaluates each against Una Kravets' modern-UX principles and Modern Web Guidance, and writes a structured findings report plus a prioritised task list. In fix mode (local source only) it applies guidance-backed fixes and re-audits in a hill-climb loop. Use when asked to web-audit, UX-audit, uplift, or modernise a site.
---

# Web audit

Audit `$ARGUMENTS`: a URL, plus optional flags:

- `--plan-only` - stop after writing the test plan.
- `--path <id>` - run a single path from the plan.
- `--out <dir>` - override the report directory (default `reports/<host>/`).
- `--replan` - regenerate the test plan even if one exists.
- `--fix` - fix mode: apply fixes to local source and re-audit (requires
  `--source <dir>`). Without `--fix`, this is report mode (critique only).
- `--source <dir>` - path to the site's local source, required for `--fix`.

You need the `chrome-devtools` MCP server (this repo's `.mcp.json` starts it
with `--isolated`). The two knowledge layers are:

- **Principles** - [principles/principles.json](../../../principles/principles.json):
  Una Kravets' modern-UX principles (the *why*). NOTE: only two are confirmed
  (`adapt-to-the-user`, `adapt-to-the-device`); three are TODO placeholders.
  Audit against the confirmed ones and their checks. Do NOT invent findings
  for the placeholder principles.
- **Guidance** - Modern Web Guidance, queried via the `modern-web-guidance`
  npm feed (the *how*). Follow [guidance/lookup.md](../../../guidance/lookup.md):
  `search` to find the recommended approach, `retrieve` to get the fix detail.

Drive the browser through the chrome-devtools MCP tools (navigate, click,
fill, hover, take_snapshot, screenshot, resize, and preference/device
emulation). Do not write your own puppeteer/CDP automation. If you need an
ad-hoc helper script or screenshot, write it under `scratch/` (gitignored),
never the repo root; deliverables belong only in the report directory and
`testplans/`.

## Phase 1 - Explore and test plan

Reuse `testplans/<host>.json` if it exists (regenerate only on `--replan`).
Otherwise:

1. `new_page` -> navigate to the URL. Dismiss cookie/consent banners if
   present. If the page is blocked (bot wall, login required), record that in
   the report and stop.
2. Take a snapshot + screenshot. Classify the app: SPA or MPA, framework if
   detectable, and the meaningful surfaces: primary nav routes, forms,
   modals/overlays, and key flows (search, sign-up, checkout, media).
3. Write `testplans/<host>.json`: an array of paths, each with `id`,
   `description`, `url` (or how to reach it), `steps` (the interaction to
   exercise), and `conditions` (which emulated conditions to evaluate it
   under). Conditions are the heart of the audit, drawn from the principle
   checks, for example:
   - `prefers-color-scheme: dark` (adapt-to-the-user / respects-color-scheme)
   - `prefers-reduced-motion: reduce` (adapt-to-the-user / respects-reduced-motion)
   - `viewport: 360x800` (adapt-to-the-device / responsive)
   - `keyboard-only` (focus states and reachability)
   Always include a `landing` path. Add one path per primary route, per form,
   and per overlay discovered in recon. Cap at ~6 paths; prefer the
   highest-traffic flows.

Stop here if `--plan-only`.

## Phase 2 - Audit (per path, per condition)

For each path, and for each condition on it:

1. Fresh navigation to the path's start state. Apply the condition via
   emulation (resize for viewport; CDP preference overrides for
   `prefers-color-scheme` / `prefers-reduced-motion` / `prefers-contrast`;
   keyboard-only = navigate with Tab/Enter only).
2. Exercise the path's `steps`, taking snapshots/screenshots and reading
   computed styles where needed.
3. Evaluate against the confirmed principle checks relevant to the condition.
   For each check, run the guidance `search` (its `guidanceQuery`) to confirm
   the recommended modern approach, then compare. See
   [guidance/lookup.md](../../../guidance/lookup.md).
4. Also search the guidance feed for anything notable you observe that no
   principle check names (the feed is broader than the five principles).

## Phase 3 - Findings and task list

Classify each divergence into a finding tied to a principle check and/or a
guidance `id`. Severity:

- `critical` - core content/flow unusable under a common condition (e.g. site
  unreadable in dark mode, primary nav broken on mobile).
- `high` - a principle clearly violated on a primary path.
- `medium` - a meaningful divergence on a secondary path or partial support.
- `low` - polish, or a missed-opportunity to adopt a modern technique.

Be honest about `confidence`. Some modern-UX judgements are subjective; mark
them so rather than asserting a bug. Detached/intentional exceptions exist
(e.g. a brand area that is intentionally always-light) - note them rather than
flagging blindly.

Then derive a prioritised, deduplicated `taskList` (highest leverage first),
each task referencing its `findingIds` and a `guidanceId`.

## Phase 4 - Report

Write two files in `reports/<host>/` (or `--out`):

- `report.json` - MUST validate against
  [schema/findings.schema.json](../../../schema/findings.schema.json). Every
  finding needs: severity, a one-line `summary`, concrete `evidence` (what you
  observed), the violated `principleId`/`principleCheckId` and/or `guidanceId`,
  and a concrete `suggestedFix` citing the guidance (the technique to apply,
  e.g. "Declare color-scheme: light dark and use light-dark() for surfaces;
  see guidance id dark-mode" - not "support dark mode").
- `REPORT.md` - human-readable: page profile, paths and conditions run,
  findings table grouped by principle, the prioritised task list with fix
  sketches, and anything skipped or low-confidence.

## Phase 5 - Fix mode (`--fix`, the hill-climb)

Only with `--fix --source <dir>` (the site's local source). Then, for each
task in the prioritised list:

1. `retrieve` the task's guidance guide and read its technique + browser
   support notes.
2. Apply the fix to the local source under `<dir>`.
3. Re-run the relevant path/condition from Phase 2.
4. Mark the task `applied`, then `verified` if the finding is gone. If a fix
   introduces a new finding, log it and continue.

Repeat passes until no findings above your chosen severity remain, or a pass
makes no further progress. Record `budget.auditPasses`. Never edit source
outside `<dir>`; never run fix mode against a site whose source you do not
have locally.

## Cross-agent note

This skill is plain markdown methodology any agent can follow. It runs as
`/web-audit <url>` in Claude Code, Codex, Gemini CLI, and Antigravity from
this repo (each CLI is wired to this one canonical SKILL.md; see
[runner/README.md](../../../runner/README.md)).

Finish your reply with a one-paragraph TLDR: finding count by severity, the
single highest-leverage fix, and (in fix mode) how many findings were
verified-fixed.
