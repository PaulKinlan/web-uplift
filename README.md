# web-uplift

Agent-driven, constant web improvement. Point it at any website and it
hill-climbs the site toward modern web quality: explore, audit against modern
UX principles and [Modern Web Guidance](https://developer.chrome.com/docs/modern-web-guidance/),
report a prioritised task list, and (when the source is available) apply fixes
and re-audit until the principles are satisfied.

Built on the
[Chrome DevTools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp)
(navigate, click, fill, snapshot, emulate), in the shape of
[memory-tracer](https://github.com/PaulKinlan/memory-tracer): a prompt/skill
harness over an existing MCP engine, not its own MCP server. memory-tracer
audits for memory leaks; web-uplift audits for modern UX quality.

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
3. **Report mode** - emit a human-readable report plus a prioritised task list
   of fixes into `reports/<site>/` (gitignored).
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
   high-level qualities a modern interface should have. (Heads up: only two of
   the five are confirmed in this repo today; see the file and
   [PLAN.md](PLAN.md).)
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
reports/                    Audit output, one directory per site (gitignored)
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

# 4. Audit it (report mode) - /web-audit works inside Claude Code, Codex,
#    Gemini CLI, and Antigravity when run from this repo (see runner/README.md)
/web-audit http://localhost:8080

# 5. Fix mode (only when the source is local) - audit, apply guidance-backed
#    fixes, re-audit until principles are satisfied
/web-audit http://localhost:8080 --fix --source playground

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

See [PLAN.md](PLAN.md) for the roadmap and open questions (including the three
Una principles still to confirm from the talk, and the fix-mode scope for v1).

## License

[Apache 2.0](LICENSE)
