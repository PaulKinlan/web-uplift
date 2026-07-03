# web-uplift

**Find the handful of changes that make your site faster, easier to use, and
more visible to search and AI - then fix them, and prove the improvement.**

Point web-uplift at a URL and it tells you where the site stands on the outcomes
that matter to your visitors and to search & AI crawlers - **Speed & Stability,
Memory Health, Usability, Inclusivity, Discoverability & AI, Trust &
Resilience** - scores each out of 100, and hands you the top three things to do
first. When it can reach your source it applies the fixes and re-audits until
the score climbs. You get a shareable [scorecard](#the-scorecard), not an
80-item list you have to triage.

It is not another checklist tool. There is no fixed list of coded checks and no
canned fixer: the model is the auditor. It gathers real browser evidence
(screenshots, traces, network, memory, a no-JS crawler view), reasons over what
it sees, consults Modern Web Guidance, and judges the site against modern
web-quality principles - then, with local source, fixes and re-audits until the
issues are gone.

Install it into a web project and run `/web-audit <url>` inside your coding
agent, or run it headless in CI (see [CI](#continuous-integration-gate-on-score)).

## Quick Start

Install the audit skill and evidence tools into your project:

```sh
npx -y web-uplift@latest install --agent codex
```

Use the agent you actually run:

```sh
npx -y web-uplift@latest install --agent claude        # Claude Code
npx -y web-uplift@latest install --agent codex         # Codex
npx -y web-uplift@latest install --agent gemini        # Gemini CLI
npx -y web-uplift@latest install --agent opencode      # opencode
npx -y web-uplift@latest install --agent all           # install every wrapper
npx -y web-uplift@latest install --dry-run --agent all # preview files without writing
```

Then, inside your agent session:

```sh
/web-audit https://example.com
```

To fix a local site, pass the served URL and source directory:

```sh
/web-audit http://localhost:8080 --source ./src --fix
```

Reports are retained under `reports/<host>/<runId>/`, with a `latest` pointer.
Fix mode also emits a before/after comparison so you can see what changed.

## What You Get

An audit writes:

- `report.md` - a readable report with evidence, findings, and a prioritised
  task list.
- `report.json` - structured findings that validate against
  [schema/findings.schema.json](schema/findings.schema.json).
- `evidence/` artifacts - screenshots, layout JSON, trace summaries, HARs,
  heap summaries, videos, Lighthouse output, or other probes the model chose.
- `scorecard.html` - a self-contained, shareable interactive scorecard that
  leads with outcomes an owner cares about (see below).

### The scorecard

`web-uplift scorecard <host>` rolls a site's retained runs into a single
`reports/<host>/scorecard.html` that leads with **outcomes**, not a raw list of
findings. `fix` runs emit it automatically. It shows:

- Lighthouse-style circular score gauges, one per owner outcome - **Speed &
  Stability, Memory Health, Usability & UX, Inclusivity & Reach, Discoverability
  & AI, Trust & Resilience** - each 0-100, computed from the model's principle
  verdicts weighted by finding severity (not-applicable / opted-out principles
  are excluded, never penalised).
- A **"if you do nothing else, do these"** top-3 pulled from the prioritised
  task list.
- A findings deep-dive where every finding opens a native dialog with its
  evidence, suggested fix, effort, and the actual screenshots/video captured.
- A **history** view: the overall score across every retained run, a per-run
  **delta** column, and a per-outcome trend (sparkline + change since the first
  run) - so you can see the deltas over time, not just the latest state.
- A **before/after** panel from the latest `compare.json` (resolved count, Core
  Web Vitals deltas, paired before/after screenshots).

The page is a single HTML file with all CSS/JS inline and screenshots inlined as
data URIs, so it makes no external requests and is safe to publish as a CI
artifact.

Running `web-uplift scorecard <host>` also prints a compact **text scorecard**
to stdout (overall + the six outcome scores + the top-3). An in-agent `/web-audit`
run ends by showing that inline and linking the HTML, so you get the headline in
chat and the deep-dive one click away.

Each finding is tied to:

- a principle from [knowledge/principles.json](knowledge/principles.json),
- the evidence used to prove it,
- a suggested fix backed by Modern Web Guidance,
- and a deduplicated task in `taskList`.

## Requirements

The machine running the audit needs:

- Node 20 or newer.
- Chrome or Chromium. The evidence CLI checks common paths and honours
  `CHROME_BIN`.
- `ffmpeg` if the agent records transition videos.
- Network access for `npx`, Modern Web Guidance, and optional Lighthouse.
- A coding agent that can read files and run shell commands.

No Playwright, Puppeteer, or browser-automation MCP server is required.
web-uplift drives Chrome directly over the Chrome DevTools Protocol.

## Agent Install Matrix

`web-uplift install` copies the one canonical audit skill plus the raw-CDP
evidence tools into your project. Each agent gets only a thin wrapper pointing
at the same `SKILL.md`, so the method does not drift.

| Agent | Install | What gets placed | Run |
|---|---|---|---|
| Claude Code | `npx -y web-uplift@latest install --agent claude` | `.claude/skills/web-audit/SKILL.md` | `/web-audit <url>` |
| Codex | `npx -y web-uplift@latest install --agent codex` | `.codex/skills/web-audit/SKILL.md` + `AGENTS.md` snippet | `/web-audit <url>` |
| Gemini CLI | `npx -y web-uplift@latest install --agent gemini` | `.gemini/commands/web-audit.toml` | `/web-audit <url>` |
| Antigravity | `npx -y web-uplift@latest install --agent antigravity` | `.agents/skills/web-audit.md` | `/web-audit <url>` |
| GitHub Copilot | `npx -y web-uplift@latest install --agent copilot` | `.github/prompts/web-audit.prompt.md` + instructions snippet | `/web-audit <url>` |
| opencode | `npx -y web-uplift@latest install --agent opencode` | `.opencode/command/web-audit.md` + `AGENTS.md` snippet | `/web-audit <url>` |
| all | `npx -y web-uplift@latest install --agent all` | everything above | per agent |

Every install also vendors the evidence CLI, principles, schemas, and guidance
lookup notes under `.web-uplift/` so the in-session model can call them
directly. It also writes `.web-uplift/manifest.json` with the package version
that produced the installed copy.

## Keeping Installs Current

Use `@latest` whenever you install or refresh the skill:

```sh
npx -y web-uplift@latest update --agent all
```

`web-uplift update` refreshes the canonical skill, evidence CLI, schemas,
principles, guidance notes, wrappers, and `.web-uplift/manifest.json`. If an
older manifest is present, the CLI prints the installed version and the version
it is updating to.

The CLI also performs a lightweight npm registry update check at most once every
24 hours and prints a warning to stderr when a newer package is available. Set
`WEB_UPLIFT_NO_UPDATE_CHECK=1` to disable it. For serious broken releases,
maintainers can additionally use `npm deprecate` on old versions so npm itself
warns during install.

### Claude Code Plugin

This repo also ships a Claude plugin manifest at
[.claude-plugin/plugin.json](.claude-plugin/plugin.json) and marketplace entry
at [.claude-plugin/marketplace.json](.claude-plugin/marketplace.json). In Claude
Code you can add the marketplace and install `web-uplift` as a plugin to get the
same `/web-audit` skill.

## Default Path: Run In Your Agent

For individual use, run the audit inside your normal agent session. That uses
your existing agent subscription or plan. The agent does the reasoning and calls
the local evidence CLI only when it needs browser evidence.

```sh
# Audit a live site.
/web-audit https://example.com

# Audit a local app.
/web-audit http://localhost:8080

# Audit and fix local source.
/web-audit http://localhost:8080 --source ./src --fix

# Choose a report directory.
/web-audit https://example.com --out reports/example
```

Fix mode is a model-driven hill climb:

1. Audit the site.
2. Read the prioritised task list.
3. Retrieve the relevant Modern Web Guidance.
4. Edit the source under `--source`.
5. Re-gather the same evidence.
6. Repeat until no outstanding `issues` remain, or the iteration cap is hit.

## Headless Runner For CI And Batch Work

For unattended work, use the headless commands. These spawn an agent CLI in
`-p` or `exec` mode and can bill API tokens, so they are not the default path
for personal use.

```sh
# Batch audit one or more URLs.
web-uplift audit https://example.com
web-uplift audit --urls ./urls.txt --concurrency 2 --agent claude

# Model-driven fix hill climb against local source.
web-uplift fix --target ./src --audit-url http://localhost:8080 --agent claude --max-iterations 4
web-uplift fix --target ./src --audit-url http://localhost:8080 --dry-run

# Hill-climb to a SCORE target instead of chasing every last issue.
web-uplift fix --target ./src --audit-url http://localhost:8080 \
  --goal-overall 80 --goal-min discoverable=70 --goal-max-critical 0

# Aggregate findings across retained reports.
web-uplift aggregate

# Compare the two most recent runs for a host.
web-uplift compare localhost_8080
web-uplift compare http://localhost:8080 <runId-before> <runId-after>
```

The headless runner orchestrates. It still does not contain checks. The spawned
model follows the same [SKILL.md](.claude/skills/web-audit/SKILL.md).

## Continuous integration: gate on score

`web-uplift scorecard <host>` always writes a machine-readable `scorecard.json`
(overall + per-outcome scores, finding counts by severity) next to the HTML, and
can **fail the build** when the site slips below thresholds you set:

```sh
web-uplift scorecard http://localhost:8080 \
  --min-overall 80 \        # fail if the overall score drops below 80
  --min discoverable=70 \   # fail if the Discoverability & AI outcome drops below 70
  --max-critical 0 \        # fail on any critical finding
  --max-high 2              # fail if more than two high findings
```

It prints a PASS/FAIL line per threshold and **exits non-zero** if any gate
fails (exit 0 when all pass, or when no gate flags are given). A not-applicable
outcome (`null`) never fails its gate. Outcome keys: `speed`, `memory`,
`usability`, `inclusive`, `discoverable`, `trust`.

A GitHub Actions recipe lives at
[.github/workflows/web-uplift-scorecard.example.yml](.github/workflows/web-uplift-scorecard.example.yml):
audit a preview URL, generate the scorecard, gate on thresholds, and upload
`scorecard.html` + `scorecard.json` as build artifacts (the self-contained HTML
is safe to publish and share).

### URL Lists For Batch Audits

`web-uplift audit` accepts URLs as command arguments or from a text file:

```txt
# urls.txt
# One URL per line. Lines starting with # are ignored.
https://example.com
https://developer.chrome.com/
```

```sh
web-uplift audit --urls ./urls.txt --concurrency 2
web-uplift audit https://example.com https://developer.chrome.com/
```

For broader surveys, good URL sources are:

1. **CrUX rank via HTTP Archive / BigQuery** - best when you want traffic-weighted
   origins that reflect real Chrome usage.
2. **Tranco** - a research-grade ranked list with CSV downloads and little setup.
3. **A hand-picked pilot set** - useful for calibrating cost, blocked-site rate,
   and report quality before running many sites.

Lists usually provide origins. The audit should start at the landing page and
then let recon decide which public paths matter. Logged-in experiences are out
of scope unless you provide access and explicit instructions. Bot-walled sites
should be reported as `blocked`, not retried indefinitely.

## How It Works

```
principles  ->  declarative spec of what good looks like
SKILL.md    ->  methodology the model follows
evidence/   ->  generic raw-CDP browser evidence primitives
guidance    ->  Modern Web Guidance lookup protocol
model       ->  method selection, reasoning, judging, and fixing
```

The important design choice: web-uplift provides the spec, method, and tools,
but the model supplies the judgement. The model may run Lighthouse, inject axe,
take screenshots, record video, inspect layout metrics, capture a HAR, compare
heap snapshots, or write its own ad-hoc probe. Tool choice is an inspection-time
decision, not a runtime constant.

### Evidence Primitives

[evidence/cli.mjs](evidence/cli.mjs) is a small CLI of generic, content-agnostic
browser primitives:

```sh
node evidence/cli.mjs <primitive> <url> [options]
```

| Primitive | Returns | CDP |
|---|---|---|
| `screenshot` | PNG screenshot, full viewport or selector clipped | `Page.captureScreenshot` |
| `video` | MP4 screencast assembled with `ffmpeg` | `Page.startScreencast` |
| `heap` | readable V8 heap summary | `HeapProfiler.takeHeapSnapshot` |
| `layout` | layout metrics, CLS observer, long tasks, overflow | `Page.getLayoutMetrics` + observers |
| `dom` | DOM, computed styles, page HTML/CSS, optional local source | `DOM` / `CSS` / `Runtime` |
| `evaluate` | model-supplied JavaScript probe result | `Runtime.evaluate` |
| `trace` | DevTools trace plus compact summary | `Tracing.start/end` |
| `har` | HAR 1.2 plus compact network summary | `Network` domain |
| `discoverability` | raw server HTML (no JS) vs the rendered DOM: how much content a non-JS crawler sees (`coveragePct`, `isJsShell`, empty SPA mounts), plus a browser-view/crawler-view screenshot pair | `fetch` + `DOM` |

Common options:

```sh
--emulate-media prefers-color-scheme=dark,prefers-reduced-motion=reduce
--viewport 360x800
--wait <ms>
--selector <css>
--interact "<js>"
--duration <ms>
--bodies
--source <dir>
--out <path>
```

These primitives make no quality judgement. They only return evidence.

## The Quality Model

web-uplift uses two knowledge layers:

1. **Principles** - [knowledge/principles.json](knowledge/principles.json)
   defines seventeen modern web-quality principles. The set draws from Una
   Kravets' five modern-UX principles, Lighthouse dimensions, privacy/security,
   resilience, internationalisation, core task success, trust, sustainability,
   agent readiness, and memory efficiency. Each check is phrased as an outcome,
   with evidence hints, source metadata, Modern Web Guidance pointers, and
   non-MWG references where useful.
2. **Modern Web Guidance** - [knowledge/guidance.md](knowledge/guidance.md)
   documents how the model queries the `modern-web-guidance` npm feed before
   judging and while fixing.

Not every principle applies to every site. A project can add
[web-uplift.json](web-uplift.example.json) to declare `siteType`, `scope`,
principle opt-outs with reasons, and intent. Reports keep `pass`, `issues`,
`not-applicable`, and `opted-out` separate so contextual principles are not
treated as failures.

## Example And Eval

- [examples/playground-report.md](examples/playground-report.md) is a real
  agentic audit of the seeded-issues fixture.
- [examples/playground-report-fixed.md](examples/playground-report-fixed.md) is
  the product guard against the fixed playground and reports zero findings.
- [eval/README.md](eval/README.md) explains the ground truth.

The CI workflow at
[.github/workflows/audit-playground.yml](.github/workflows/audit-playground.yml)
smoke-tests the evidence primitives and eval ground truth. A full audit still
needs a model in the loop.

## Repository Layout

```
evidence/                   Raw-CDP evidence primitives
.claude/skills/web-audit/   Canonical audit methodology
knowledge/                  Principles and Modern Web Guidance protocol
schema/                     Findings and config schemas
playground/                 Fixed demo site
eval/                       Seeded-issues fixture and expected findings
examples/                   Committed example reports
runner/                     Headless batch orchestration
aggregate/                  Cross-site summaries, run comparison, scorecard
reports/                    Retained audit output, gitignored
```

## Development

```sh
npm test
npm run playground
npm run evidence -- dom "http://localhost:8080/#no-dark-mode" --selector ".ndm-card"
```

Before publishing:

```sh
npm test
npm publish --dry-run
npm publish --access public
```

No build step is required. The package ships source ESM files directly.

## More Detail

- [PLAN.md](PLAN.md) covers the roadmap and architectural rationale.
- [docs/principles-analysis.md](docs/principles-analysis.md) explains the
  principle expansion and guidance coverage map.
- [runner/README.md](runner/README.md) documents headless agent orchestration.

## License

[Apache 2.0](LICENSE)
