# web-uplift

Agent-driven, constant web improvement. Point it at any website and it
hill-climbs the site toward modern web quality: explore, audit against modern
UX principles and [Modern Web Guidance](https://developer.chrome.com/docs/modern-web-guidance/),
report a prioritised task list, and (when the source is available) apply fixes
and re-audit until the principles are satisfied.

There are two complementary front ends:

1. **A deterministic, runnable auditor + fixer** (this is what `npm run audit`
   and `npm run fix` drive). It talks to the system Chrome directly over the
   **Chrome DevTools Protocol** using the thin `chrome-remote-interface` client
   (no Playwright, no browser-automation framework). This is the path CI runs
   and the path the committed example report comes from.
2. **An agent skill** in the shape of
   [memory-tracer](https://github.com/PaulKinlan/memory-tracer): a prompt/skill
   harness over the
   [Chrome DevTools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp)
   (navigate, click, fill, snapshot, emulate). memory-tracer audits for memory
   leaks; web-uplift audits for modern UX quality. The skill is for open-ended,
   LLM-driven exploration; the deterministic auditor is for repeatable,
   CI-friendly, scored runs.

### How the auditor drives the browser (Chrome DevTools Protocol)

`auditor/audit.mjs` launches the system Chrome
(`/usr/bin/google-chrome-stable`, override with `CHROME_BIN`) headless with
`--headless=new --remote-debugging-port=0 --no-sandbox --user-data-dir=<temp>`,
parses the chosen port from Chrome's stderr ("DevTools listening on ws://..."),
and connects with `chrome-remote-interface`. It uses the CDP domains directly:

- **Page / Runtime** - navigate and `evaluate` DOM/CSS state.
- **DOM / CSS** - inspect author stylesheets and computed styles.
- **Emulation.setEmulatedMedia** - `prefers-color-scheme: dark`,
  `prefers-reduced-motion: reduce` (and the same plumbing for
  `prefers-contrast` / `forced-colors`).
- **Emulation.setDeviceMetricsOverride** - narrow mobile viewport to surface
  horizontal overflow.
- **PerformanceObserver** (installed via `Runtime.evaluate`) - `layout-shift`
  entries for a real CLS measurement.

The playground is a hash-routed SPA whose per-scenario CSS only exists while
its route is active, so the auditor navigates each scenario route (routing
through `about:blank` to force a real load), sets the relevant emulated
condition, lets it settle, and reads the result.

## How it works

The DevTools MCP server provides the *engine* (a real browser the agent can
drive and inspect, including device and preference emulation). web-uplift adds
the *orchestration* around it, plus two knowledge layers (below):

1. **Explore + plan** - an agent explores the site (navigate, click, fill,
   snapshot), enumerates the meaningful user paths and test cases (routes,
   forms, modals, key flows), and persists a reviewable test plan to
   `testplans/<site>.json`.
2. **Audit** - run each path and evaluate the site against the two knowledge
   layers, emitting structured findings
   (see [schema/findings.schema.json](schema/findings.schema.json)). Each
   finding is `{id, path/url, principle or guidance violated, severity,
   evidence, suggestedFix}`.
3. **Report mode** - emit findings as JSON (validated against
   `schema/findings.schema.json`) plus a human-readable markdown report and a
   prioritised task list. Ad-hoc runs land in `reports/<site>/` (gitignored);
   the playground's latest report is committed to `examples/` so it is visible
   on GitHub, and CI keeps it fresh on every push to master.
4. **Fix mode** - if the site's source is available locally, hand the task
   list to a coding agent that applies fixes following Modern Web Guidance,
   then re-runs the audit. This is the hill-climb loop: audit, fix, re-audit
   until the principles are satisfied.
5. **Batch + aggregate** - a [runner/](runner/) fans out headless audits over
   a URL list (`--agent claude | codex | gemini | antigravity`,
   `--concurrency N`), and [aggregate/](aggregate/) merges reports into a
   cross-site summary of where the web is weakest.

## The two knowledge layers

web-uplift judges a site against two complementary layers:

1. **Principles layer** - [principles/principles.json](principles/principles.json):
   Una Kravets' five core principles for modern UX, from her Google I/O 2026
   talk *What's new in Web UI*
   (https://www.youtube.com/watch?v=uT7MVcCQ4rw). These are the *why*: the
   high-level qualities a modern interface should have. All five are now
   confirmed from the talk transcript, each with programmatically-detectable
   checks carrying a `guidanceQuery`; see the file.
2. **Knowledge layer** - Modern Web Guidance
   (https://developer.chrome.com/docs/modern-web-guidance/, repo
   https://github.com/GoogleChrome/modern-web-guidance): use-case-based best
   practices. These are the *how*: the recommended modern approach for a given
   task. web-uplift uses them both to **critique** a site (find divergence
   from the recommended approach) and to **fix** it (the guidance is the
   how-to). See [guidance/README.md](guidance/README.md) for the integration
   plan.

The principles set the goal; the guidance provides the concrete, citable
techniques to get there.

## Layout

```
auditor/                    CDP auditor: launches Chrome over chrome-remote-interface, runs the checks, scores vs ground truth
fixer/                      Fix + PR engine: applies guidance-backed fixes, re-audits (hill-climb), opens a PR
examples/                   Committed example audit report (issues + fixed mode) so runs are visible on GitHub
.github/workflows/          CI: audit the playground on push to master and commit the refreshed example report
.claude/skills/web-audit/   The orchestration skill (explore -> plan -> audit -> report -> fix)
.mcp.json                   chrome-devtools-mcp config (isolated + the interaction/inspection tools)
principles/                 Una Kravets' modern-UX principles (the "why")
guidance/                   Modern Web Guidance integration plan (the "how")
schema/                     Findings + report JSON schema
playground/                 Seeded modern-UX issues, issue vs fixed mode, ground truth
runner/                     Batch runner (headless agent run per URL)
aggregate/                  Merge reports into a cross-site summary
urls/                       URL lists + notes on sourcing top-site lists
testplans/                  Generated per-site test plans (committed, reviewable)
reports/                    Ad-hoc audit output, one directory per site (gitignored)
```

## Quickstart

```sh
# 1. Get the DevTools MCP server (one of):
#    a) Claude Code plugin:
#       /plugin install chrome-devtools-mcp@chrome-devtools-plugins
#    b) Or rely on this repo's .mcp.json (server only).

# 2. The Modern Web Guidance feed is fetched on demand via npx; no install
#    needed (see guidance/README.md). Verify it works:
npx -y modern-web-guidance@latest list | head

# 3. Run the playground
npm run playground          # serves playground/ on http://localhost:8080

# 4a. Deterministic CDP auditor (this is what CI runs). Issues mode finds all
#     six seeded issues; ?mode=fixed must find none. Auto-scores precision/
#     recall against playground/expected-findings.json and writes a JSON report
#     (schema/findings.schema.json) plus a markdown report.
npm run audit -- http://localhost:8080/
npm run audit -- "http://localhost:8080/?mode=fixed"
#     Flags: --out <dir> --name <base> --expected <file> --no-guidance --quiet
#     The committed example output lives in examples/playground-report.md.

# 4b. Or the agent skill (open-ended, LLM-driven) - /web-audit works inside
#     Claude Code, Codex, Gemini CLI, and Antigravity (see runner/README.md)
/web-audit http://localhost:8080

# 5. Fix + PR engine (the hill-climb). Audit the target, apply guidance-backed
#    fixes to its source, re-audit until clean, optionally open a PR. Serve the
#    --target dir at --audit-url so the re-audit sees the edits.
npm run fix -- --target playground --audit-url http://localhost:8080/
#    Add --pr to branch, commit the fixes, and open a PR via gh.
#    Add --dry-run to compute fixes without writing.

# 6. Batch mode - URLs as arguments or --urls <file> (defaults to
#    urls/sample.txt). Runs with Claude Code by default; also supports
#    --agent gemini | antigravity | codex. Reports land in
#    reports/<agent>/<site>/ for cross-agent comparison.
npm run batch -- https://example.com
npm run batch -- --urls urls/sample.txt --concurrency 2
npm run batch -- --urls urls/sample.txt --agent gemini

# 7. Aggregate findings across reports
npm run aggregate
```

## Example report and CI

[examples/playground-report.md](examples/playground-report.md) is a real,
committed run of the CDP auditor against the playground in issues mode
(precision 100%, recall 100% against the six seeded issues), and
[examples/playground-report-fixed.md](examples/playground-report-fixed.md) is
the `?mode=fixed` false-positive check (zero findings). The
[audit-playground workflow](.github/workflows/audit-playground.yml) re-runs the
auditor on every push to master, installs/locates Chrome in the runner, and
commits the refreshed report (skipping the commit when nothing changed), so the
example always reflects the current code.

See [PLAN.md](PLAN.md) for the roadmap and remaining open questions. The five
Una principles are now all confirmed in `principles/principles.json`; the CDP
auditor, the fix/PR hill-climb, the committed example report, and CI are all
shipped.

## License

[Apache 2.0](LICENSE)
