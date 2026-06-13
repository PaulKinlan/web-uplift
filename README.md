# web-uplift

Agent-driven, constant web improvement. Point it at any website and a **model**
audits it against modern web quality, reports a prioritised task list, and (when
the source is available) applies fixes and re-audits until the principles are
satisfied.

web-uplift is **fully agentic**. There is no deterministic check runner and no
fast path. The model is the auditor: at inspection time it gathers multi-modal
evidence, decides for itself which tools to use, reasons over what it sees, and
judges every principle. The repo supplies only declarative inputs and generic
capabilities; all the intelligence is the model's.

## The architecture (and why)

```
principles  ->  the declarative SPEC of what good looks like (outcomes + hints)
SKILL.md    ->  the METHODOLOGY a model follows to audit a URL
evidence/   ->  GENERIC, judgement-free primitives the model calls to see the page
guidance    ->  the live how-to feed the model cites and fixes from
model       ->  supplies all the intelligence: method selection, reasoning, judging
```

**No hard-coded checks. No per-principle registry. No deterministic transforms.
No "call Lighthouse" baked into a runner.** Earlier versions had a deterministic
CDP check-runner and a deterministic fixer; both were deleted. The reason is a
deliberate architectural decision: web quality is open-ended and the platform
moves fast, so a fixed check registry rots, misses context, and becomes the
thing tools quietly fall back to. By leaning on the model the method stays
current (it queries the live guidance feed), it generalises (it can judge a
principle it has no canned check for), and **tool and test choice is an
inspection-time decision, not a runtime constant**. The model may run
Lighthouse, inject axe, take a screenshot, record a transition video, take a
heap snapshot, read layout metrics, or write its own ad-hoc static test on the
spot, whatever the situation calls for.

### Evidence primitives (the model's senses)

[evidence/cli.mjs](evidence/cli.mjs) is a small CLI of generic, content-agnostic
primitives. Each one launches the system Chrome
(`/usr/bin/google-chrome-stable`, override with `CHROME_BIN`) headless and drives
it purely over the **Chrome DevTools Protocol** via the thin
`chrome-remote-interface` client (no Playwright, no Puppeteer). They return data
and artifacts; they make **no judgements**.

```sh
node evidence/cli.mjs <primitive> <url> [options]
```

| Primitive | Returns | CDP |
|---|---|---|
| `screenshot` | a PNG (full or `--selector`-clipped) under any emulated condition | Page.captureScreenshot |
| `video` | an MP4 of an interaction window (frames assembled with the system `ffmpeg`); `--interact "<js>"` triggers the transition | Page.startScreencast |
| `heap` | a readable heap-snapshot summary (types/constructors by size); never the raw multi-MB snapshot | HeapProfiler.takeHeapSnapshot |
| `layout` | layout metrics, a CLS/layout-shift observer, long tasks, overflow at the current viewport | Page.getLayoutMetrics + observers |
| `dom` | DOM, computed styles for a `--selector` set, page HTML/CSS, and (`--source <dir>`) the local source files | DOM / CSS / Runtime |
| `evaluate` | the value of a model-supplied `--expr "<js>"` run in the page: ad-hoc probes and static tests the model writes on the spot | Runtime.evaluate |

Common options the model chooses and the harness simply applies (it never
decides them): `--emulate-media prefers-color-scheme=dark,prefers-reduced-motion=reduce`,
`--viewport 360x800`, `--wait <ms>`, `--selector <css>`, `--interact "<js>"`,
`--source <dir>`, `--out <path>`.

## The two knowledge layers

1. **Principles** - [principles/principles.json](principles/principles.json):
   the spec of what good looks like, as OUTCOMES. Nine principles: Una Kravets'
   five modern-UX principles from her Google I/O 2026 talk *What's new in Web UI*
   (https://www.youtube.com/watch?v=uT7MVcCQ4rw) plus four Lighthouse-dimension
   principles (`be-fast-and-stable`, `be-accessible`, `follow-best-practices`,
   `be-discoverable`). Each check is phrased as an outcome and carries a
   `detectableVia` HINT that may *mention* candidate evidence or tools without
   mandating any. Nothing here is wired to a code path.
2. **Modern Web Guidance** - the `modern-web-guidance` npm feed
   (https://developer.chrome.com/docs/modern-web-guidance/): use-case-based best
   practices, the *how*. The model `search`es it while auditing (to confirm the
   recommended modern approach and cite a guidance id) and `retrieve`s it while
   fixing. See [guidance/README.md](guidance/README.md).

The principles set the goal; the guidance provides the concrete, citable
techniques to get there.

## The audit (model-driven)

The methodology lives in [.claude/skills/web-audit/SKILL.md](.claude/skills/web-audit/SKILL.md).
In outline, the model:

1. **Recon** - uses `dom` (with `--source` if available) and a `screenshot` to
   understand the page and its surfaces.
2. **Plan the evidence** - reads every principle check and decides what evidence
   would let it judge that check, and under which emulated condition.
3. **Gather** - runs the primitives and any tools it judges useful (Lighthouse,
   axe via `evaluate`, its own probes).
4. **Reason and judge** - weighs the evidence and decides pass / issue /
   not-applicable for every principle, citing guidance ids.
5. **Report** - writes findings conforming to
   [schema/findings.schema.json](schema/findings.schema.json) plus a markdown
   report, recording the `evidenceUsed` so the method is honest.
6. **Fix (optional)** - with `--source`, writes guidance-backed fixes, re-gathers
   the same evidence to verify, and can open a PR. The model is the coding agent;
   there are no canned transforms.

## Layout

```
evidence/                   Generic, judgement-free CDP evidence primitives (the model's senses)
.claude/skills/web-audit/   The audit METHODOLOGY a model follows (the heart of the system)
principles/                 The declarative spec: Una's five + the four Lighthouse-dimension principles
guidance/                   Modern Web Guidance feed integration (the how)
schema/                     Findings + report JSON schema
playground/                 The genuinely-correct demo site (modern-UX techniques applied by default)
eval/                       Eval ground truth: the frozen seeded-issues fixture + expected-findings (9)
examples/                   A committed real agentic audit (fixture -> 9 findings; live playground -> 0)
runner/                     Batch fan-out: one fully-agentic audit per URL (any agent via a single config map)
aggregate/                  Merge reports into a cross-site summary
urls/                       URL lists + notes on sourcing top-site lists
testplans/                  Reviewable per-site plans (when an agent persists one)
reports/                    Ad-hoc audit output, one directory per site (gitignored)
.github/workflows/          CI: smoke-tests the evidence primitives against the playground on push
```

## Quickstart

```sh
# 1. The Modern Web Guidance feed is fetched on demand via npx; no install
#    needed. Verify it works:
npx -y modern-web-guidance@latest list | head

# 2. Run the playground (serves playground/ on http://localhost:8080)
npm run playground

# 3. Gather evidence directly (the building blocks the model uses)
npm run evidence -- dom        "http://localhost:8080/#no-dark-mode" --selector ".ndm-card" --emulate-media prefers-color-scheme=dark
npm run evidence -- screenshot "http://localhost:8080/#no-dark-mode" --emulate-media prefers-color-scheme=dark --out shot.png
npm run evidence -- layout     "http://localhost:8080/#fixed-layout" --viewport 360x800
npm run evidence -- video      "http://localhost:8080/#motion" --out motion.mp4 --duration 2500
npm run evidence -- heap       "http://localhost:8080/#motion" --out heap.json
npm run evidence -- evaluate   "http://localhost:8080/#motion" --emulate-media prefers-reduced-motion=reduce --expr "document.querySelector('.mv-card').getAnimations().length"

# 4. Run the agentic audit (the model follows SKILL.md). Inside Claude Code,
#    Codex, Gemini CLI, Antigravity, GitHub Copilot, or opencode:
/web-audit http://localhost:8080

# 5. Batch: fan out one agentic audit per URL (defaults to Claude; also
#    --agent codex|gemini|antigravity|copilot|opencode). Orchestrates; no checks.
npm run batch -- https://example.com
npm run batch -- --urls urls/sample.txt --concurrency 2 --agent claude

# 6. Aggregate findings across reports
npm run aggregate
```

## Cross-agent (not Claude-only)

The methodology is one canonical file
([SKILL.md](.claude/skills/web-audit/SKILL.md)), the spec is one file
([principles.json](principles/principles.json)), and the way the model sees a
page is one plain Node CLI ([evidence/cli.mjs](evidence/cli.mjs), raw CDP shell
commands). All three are agent-agnostic. Each agent gets only a thin wrapper
pointing at the same skill, so nothing can drift, and **no MCP server is
required** (the `web-uplift` skills server is an optional convenience, and there
is no browser-automation MCP anywhere).

| Agent | Entry point | `--agent` | Status |
|---|---|---|---|
| Claude Code | `.claude/skills/web-audit/` (native skill) | `claude` | real run verified |
| Codex | `.codex/skills/web-audit` (symlink to the skill) + `AGENTS.md` | `codex` | dry-run verified |
| Gemini CLI | `.gemini/commands/web-audit.toml` | `gemini` | dry-run verified |
| Antigravity | `.agents/skills/web-audit.md` | `agy` | dry-run verified |
| GitHub Copilot | `.github/copilot-instructions.md` + `.github/prompts/web-audit.prompt.md` | `copilot` | dry-run verified |
| opencode | `.opencode/command/web-audit.md` + `AGENTS.md` + `opencode.json` | `opencode` | dry-run verified |

**How to add an agent (one thin wrapper):** add the agent's command/instructions
file saying only "read `.claude/skills/web-audit/SKILL.md` and follow it with
these arguments", then add one `{ bin, prompt, args }` entry to the `AGENTS` map
in [runner/run-batch.mjs](runner/run-batch.mjs), and verify with
`node runner/run-batch.mjs <url> --agent <new> --dry-run`. Full detail in
[runner/README.md](runner/README.md).

## Example report and the eval

[examples/playground-report.md](examples/playground-report.md) is a real
agentic audit of the **seeded-issues eval fixture**
([eval/fixtures/seeded-issues/site](eval/fixtures/seeded-issues/site)): the model
launched headless Chrome, gathered DOM/computed-styles, screenshots, layout
metrics, a heap summary and a transition video via the evidence primitives,
chose to run Lighthouse and axe, reasoned over them, and judged the nine
principles, surfacing all nine ground-truth findings (100% recall).
[examples/playground-report-fixed.md](examples/playground-report-fixed.md) is the
product guard: the same audit against the genuinely-fixed live
[playground/](playground/), which surfaces **zero** of them. The fixture proves
recall; the live playground proves the fixes are real. See
[eval/README.md](eval/README.md). The
[evidence-smoke workflow](.github/workflows/audit-playground.yml) smoke-tests the
primitives and the eval ground truth on every push (the full audit needs a model
in the loop, so it is refreshed by running the agent, not by CI).

See [PLAN.md](PLAN.md) for the roadmap and the rationale for the fully-agentic,
no-fast-path design.

## License

[Apache 2.0](LICENSE)
