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
npx -y web-uplift@latest install --agent pi            # pi (Earendil pi-coding-agent)
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

### Chrome's OS sandbox is on by default

Every evidence primitive navigates a page you do not control, so web-uplift
launches Chrome with its **OS sandbox enabled**: renderers run in their own user
namespace, and a renderer exploit reached through an audited page is not
automatic code execution as you.

`--no-sandbox` is passed in exactly two cases:

- **`WEB_UPLIFT_NO_SANDBOX=1`** - you explicitly opted out, for an environment
  where the sandbox genuinely cannot start (a container without unprivileged
  user namespaces, a restricted seccomp profile).
- **You are running as root (uid 0)** - Chrome refuses to start its sandbox as
  root, so the flag is added automatically rather than failing every launch.

Any other value (`0`, empty, unset) keeps the sandbox on. A launch with the
sandbox disabled says so on stderr:
`[browser] launching ... [OS sandbox DISABLED: <reason>]`. The trade-off is
real in both directions: with the sandbox off, a hostile page that exploits the
renderer holds your account; with it on, an environment that cannot start it
reports three failed launches and no evidence.

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
| pi | `npx -y web-uplift@latest install --agent pi` | `.pi/skills/web-audit/SKILL.md` + `AGENTS.md` snippet | `/skill:web-audit <url>` |
| all | `npx -y web-uplift@latest install --agent all` | everything above | per agent |

Every install also vendors the evidence CLI, the scorecard/compare scripts, the
user-flow record/replay scripts, principles, schemas, and guidance lookup notes
under `.web-uplift/` so the in-session model can call them directly (generate the
scorecard, diff runs, replay a journey). It also writes `.web-uplift/manifest.json`
with the package version that produced the installed copy, plus `vendoredDependencies`:
the name and version of every package the install vendored into
`.web-uplift/node_modules`. Those packages are in no consumer lockfile, so that list
is the only record of what is on disk, and it is what makes the vendored tree
auditable from the project itself.

### pi: per-project or global package

The `--agent pi` install above is per-project. Because web-uplift also declares
a `pi.skills` entry in its `package.json`, pi can instead load the skill from the
**installed package globally** - add web-uplift as a pi package once and
`/skill:web-audit` is available in every project, with no per-repo file drop. In
that global mode nothing is vendored locally, so the skill calls the evidence CLI
through the `web-uplift evidence <primitive> <url>` bin (or `npx -y web-uplift
evidence ...`), which resolves from any directory. web-uplift needs no pi
*extension* (custom tools/commands) - a skill is all it is.

## Keeping Installs Current

Use `@latest` whenever you install or refresh the skill:

```sh
npx -y web-uplift@latest update --agent all
```

`web-uplift update` refreshes the canonical skill, evidence CLI, schemas,
principles, guidance notes, wrappers, and `.web-uplift/manifest.json`. If an
older manifest is present, the CLI prints the installed version and the version
it is updating to.

The CLI can perform a lightweight npm registry update check at most once every
24 hours and print a warning to stderr when a newer package is available. The
check makes network egress, so it is **opt-in**: set `WEB_UPLIFT_UPDATE_CHECK=1`
to enable it (and `WEB_UPLIFT_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1`, or
`CI` to keep it off). The registry response is treated as untrusted: only a
strict version shape is ever printed. For serious broken releases,
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

1. Audit the site (searching Modern Web Guidance for every principle first).
2. Read the prioritised task list.
3. Retrieve the relevant Modern Web Guidance — **required**: every fix must be
   backed by a live guidance lookup, never the model's memory.
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
# NOTE: agent runs inside a batch are scope-accounted one at a time, so --concurrency
# applies to the queue but the spawned audits themselves run serially by design.
web-uplift audit --urls ./urls.txt --concurrency 2 --agent claude

# Audit a URL AND a user journey: the flow is replayed into each run first, then
# the agent judges the journey's per-step states as extra paths.
web-uplift audit https://example.com --flow ./checkout.json

# Model-driven fix hill climb against local source.
# --isolation is REQUIRED and it RECORDS an assertion - it does NOT isolate anything
# itself. Run the tool from INSIDE a boundary you have already built, and name it here.
# See "Running it safely" below for what that boundary has to guarantee.
web-uplift fix --target ./src --audit-url http://localhost:8080 --agent claude --max-iterations 4 \
  --isolation <your-boundary>
web-uplift fix --target ./src --audit-url http://localhost:8080 --dry-run

# Hill-climb to a SCORE target instead of chasing every last issue.
web-uplift fix --target ./src --audit-url http://localhost:8080 \
  --isolation <your-boundary> --goal-overall 80 --goal-min discoverable=70 --goal-max-critical 0

# Aggregate findings across retained reports.
web-uplift aggregate

# Compare the two most recent runs for a host.
web-uplift compare localhost_8080
web-uplift compare http://localhost:8080 <runId-before> <runId-after>
```

### Running it safely: the isolation is YOURS, and this tool cannot check it

Fix mode hands a write-capable agent a task while its context carries untrusted
page content, so it will not start without you saying which boundary is
protecting that agent:

**There is no command here to copy, deliberately.** A single outer `bwrap` cannot
be presented as protecting the report history: the fixer parent and its agent child
share one namespace, and therefore the same write access to the reports tree and the
publication pointer. A copy-pasteable command that is wrong for some operator layouts
is worse than no command, so here is what your boundary MUST guarantee instead:

- **The tool tree is not writable by the agent.** It contains the skill and the
  vendored evidence CLI, which later iterations execute; if the agent can rewrite it,
  the next iteration runs the agent's code.
- **The dependency tree is not writable by the agent**, for the same reason.
- **Your provider credentials, SSH keys, cloud config and other checkouts are not
  writable by the agent** - and ideally not readable either, except for the single
  credential the agent CLI needs to authenticate.
- **The agent's boundary does NOT include write access to the report history or the
  publication pointer.** This is the one a naive outer wrapper gets wrong: if the
  agent shares the fixer's mount, it can rewrite the reports it is being judged by.
- **The source tree is the only writable area**, plus whatever directory the run
  writes its own report into.
- **Network egress is explicitly out of scope.** The agent must reach the audited
  page, the guidance feed and its provider, so whatever boundary you build almost
  certainly leaves it with network access - which means it can exfiltrate any
  credential it can read. A filesystem boundary does not address that; if you need it
  addressed, use a VM or an egress policy you control.

**What the tool guarantees, precisely.** It refuses to spawn the agent unless you
assert a boundary; it records that assertion as *unverified* in
`<out>/run-security.json`; it warns on stderr that it did not check it; and it
snapshots the tree around every agent run and refuses the run when a change lands
outside `--target`/`--out`. The snapshot covers the trees the tool itself
EXECUTES: the first-party executed set (`evidence/`, `runner/`, `fixer/`,
`aggregate/`, `schema/`, `knowledge/`, `bin/`, `install-surface.mjs` and the
vendored `.web-uplift/` tree including its dependency closure) is stamped with
content hashes, so even a rewrite preserving size and mtime is a detected change,
and the project `node_modules/` tree is walked at stat strength. Batch runs
additionally re-verify the hashed set against a batch-start baseline BEFORE every
agent spawn: any drift refuses that spawn and aborts the remaining URLs, so an
audit that tampered with the vendored CLI can never have its tampering executed
by the next URL.

The agent child's environment is an explicit allowlist (runner/agents.mjs
`buildAgentEnv`): PATH/HOME/locale/proxies, the child CLI's own provider
credential (only the targeted CLI's own family - a claude run gets ANTHROPIC_*,
never OPENAI_API_KEY), and
WEB_UPLIFT_* tunables pass; everything else your shell carries - GITHUB_TOKEN,
cloud keys, SSH agent sockets, registry tokens - is withheld, and the withheld
sensitive-looking names (never values) are warned on. `--agent-env KEY=VALUE` is
the explicit opt-in for anything else a run genuinely needs. RESIDUAL: the child
still holds its own provider credential and whatever `--agent-env` adds, and it
keeps network egress, so a page can still talk it into exfiltrating THAT
credential - the allowlist removes every other credential from reach, it does
not make the held one safe.

That is detection of realistic escapes, not confinement: the agent still runs as
you, with your network, and the snapshot walk has documented gaps (writes
outside the walked roots, through pre-existing symlinks or hard links,
metadata-only changes, and - on stat-stamped paths only, i.e. the project
dependency tree - content rewrites that preserve both size and mtime are not
seen). If you need a guarantee rather than a tripwire, the boundary has to be
yours - docker, bwrap, a VM, or a permission model you control - and
`--isolation` is where you say so.

The headless runner orchestrates. It still does not contain checks. The spawned
model follows the same [SKILL.md](.claude/skills/web-audit/SKILL.md).

## User flows (audit a journey, not just a page)

Audit a real journey - checkout, signup, search - for MPA **and** SPA sites, so
the audit covers the pages a user actually reaches.

```sh
# Record a journey. Opens a headed browser with a small "Recording... Done"
# overlay - just click through your journey and press Done. No DevTools needed.
# By default, passwords, hidden inputs, payment details, and credential/PII-shaped
# fields (email, phone, name, address, tokens) are sanitized/redacted from flow.json,
# and so are sensitive navigation URLs: credential-named query parameters (?code=,
# ?key=, ?session=), token-shaped path segments and fragments (/reset-password/<tok>),
# and URL userinfo. Innocent parameters (postalCode, sortKey, a numeric order id)
# keep their values so the journey still replays.
# Recording only captures REAL user gestures: an event a page script dispatches itself
# (element.click(), dispatchEvent(new MouseEvent(...))) is not recorded, so a page cannot
# script steps into your journey. The recorder also runs in its own browser execution world,
# which page scripts cannot see into, so the recording channel cannot be reached or forged.
# Use --capture-hidden to explicitly retain hidden inputs, or --capture-sensitive
# to record sensitive values for test replay. Flows needing entered sensitive
# values cannot replay faithfully without the opt-in or hand-authored test data.
web-uplift flow record https://example.com --out checkout.json

# Replay it (or a Chrome DevTools Recorder export, or a hand-authored flow.json),
# capturing a screenshot per step. A DRY RUN is the default and is read-only: it
# follows navigation and read-only links, and refuses everything that can write -
# any submit button, checkbox, select, ARIA control, inline handler or label,
# whatever it says; a change step (typing can trigger autosave/AJAX); a password
# field; a link or navigation whose URL names a write; and Enter on a form field.
# An explicitly typed type="button" is followed: it has no default action, so a
# "Details" toggle still replays (a bare <button> is type=submit and is refused). A link's own
# TEXT can refuse it too, but only for a destructive verb ("Delete" yes, "Site
# Credits" no). Pass --allow-mutations to authorize those steps against a live
# target.
web-uplift flow replay checkout.json --out reports/checkout/evidence
```

The flow format **is** Chrome DevTools' Recorder JSON (`{ title, steps }`), so
three inputs feed one replayer: web-uplift's own recorder, a Chrome DevTools
Recorder export, or a hand-authored `flow.json` for CI. Replay drives the steps
over raw CDP (resilient selectors - `data-testid` / `aria` / role+text before a
CSS path - so SPA re-renders don't break it) and writes `flow-result.json` plus
a screenshot per step; an audit then judges the principles at each stop.

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
| `console` | what the page logged while it was being measured: console errors and warnings, uncaught exceptions, and browser log errors/warnings (failed subresource requests, CSP violations), deduplicated with repeat counts and split by source | `Runtime` + `Log` domains |
| `secrets` | exposed API keys, tokens and credentials in page HTML, inline scripts, external JS and meta tags (redacted matches, descriptive signal). External scripts it could NOT read (HTTP error, HTML response, fetch deadline) are reported in `externalScriptFailures` with redacted URLs and are NOT counted in `externalScriptsScanned`, so a miss there is not evidence of absence. The artifact is not credential-redacted everywhere yet: the `console` block every primitive carries still records a failed subresource URL verbatim, which is filed as web-uplift-lsn3 | `Runtime.evaluate` + `fetch` |
| `headers` | the main document's security response headers: CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy | `Network` domain |
| `cookies` | every cookie the page sets, with Secure / SameSite / HttpOnly / expiry / third-party flags and per-cookie issues | `Network` domain |
| `trackers` | third-party request origins matched against a built-in list of known tracker and analytics domains | `Network` domain |
| `images` | image inventory: width/height attributes, lazy-loading, srcset, legacy vs modern format, oversized images, missing alt | `Runtime.evaluate` |
| `resilience` | offline and installable evidence: service worker registrations and versions from the ServiceWorker CDP domain (attributed per origin) plus the page controller, the resolved manifest fields and icons, and a real offline reload - net error or rendered fallback - with a screenshot of that state | `ServiceWorker` + `Network` + `Page` |
| `a11ytree` | what assistive technology actually receives: the computed accessibility tree (Accessibility.getFullAXTree) projected to role, computed name, ignored subtrees with reasons and the flag properties the checks use; plus the real tab order walked with CDP key events, recording each stop, its on-screen state, its focus indicator, and whether it sits inside aria-hidden | `Accessibility` + `Input` |
| `targets` | WCAG 2.2 SC 2.5.8 target-size inventory: every pointer target box in CSS px, undersized flags, and the inline-in-text and spacing exceptions read from geometry, measured at both a 1280x720 desktop and a 360x800 narrow layout | `DOM` / `Runtime` |
| `features` | modern-CSS and overlay census from the LIVE CSSOM (document, adopted and shadow-root sheets plus inline styles): at-rules, conditions, properties, functions and selectors with counts, the tracked feature rows the checks turn on, and native dialog / [popover] / details vs div-based modals | `CSS` / `DOM` / `Runtime` |

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
--cdp-deadline <ms>
--fetch-deadline <ms>
```

`--cdp-deadline` bounds every CDP attach/navigation wait (default 30000; env
`WEB_UPLIFT_CDP_DEADLINE_MS`); `--fetch-deadline` bounds each raw-HTML fetch
exchange, per hop (default 30000; env `WEB_UPLIFT_FETCH_DEADLINE_MS`). One
behaviour matters when you shorten the fetch budget: when the raw fetch fails
or times out - or the response is not a success (a 404 page is ABOUT the
resource, not the document) - the discoverability comparison is reported as
UNKNOWN: every raw-derived COMPARISON field is null (`coveragePct`, `isJsShell`,
the presence comparisons, the empty-mount list, the raw size stats), not a
finding about the page. The RUN FACTS survive by design - `fetchedStatus`
records the status when one arrived, `fetchError` records the failure,
`finalUrl` records the final URL once the exchange resolves (the requested URL only when it failed before a response) - precisely so an operator reads a 404 as
a status rather than as an absence. A completed, empty 200 stays usable: observed emptiness is real
evidence. A short budget therefore produces ABSENCE OF EVIDENCE, never evidence
of absence.

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

## Why one skill, not seventeen?

Every agent now has a skills mechanism, so the obvious question is: why isn't
this just seventeen skills, one per principle? web-uplift *is* a skill - but
deliberately **one** skill (the audit method) over a **declarative** principle
set and a **shared** evidence/scoring/fix engine. The principles aren't skills
because they're the *rubric the one skill applies*, not tasks in their own
right. Four reasons that matters:

1. **Evidence is gathered once and shared.** The expensive part of an audit is
   gathering evidence - launch Chrome, screenshot, trace, HAR, heap, the no-JS
   crawler view. One trace feeds `be-fast-and-stable` *and* `be-sustainable`;
   one HAR feeds performance, sustainability, *and* third-party privacy; the
   rendered DOM feeds inclusivity, discoverability, and forms. Seventeen
   independent skills would each re-gather (17× the Chrome launches) or share no
   evidence at all. web-uplift gathers once and judges every principle over it.
2. **The value lives *above* any single principle.** A set of skills gives you
   seventeen disconnected checklists; you still have to run each, weigh them, and
   assemble a picture - the "another long list of findings" problem. The whole
   point here is the cross-principle synthesis: one prioritised top-3, one
   [scorecard](#the-scorecard) rolling seventeen principles into six outcomes,
   before/after deltas, a trend over time, a CI gate. None of that can live in a
   per-principle skill, because it only exists when something sees *all* the
   findings together.
3. **The fix loop is cross-cutting.** Hill-climbing to a goal means re-judging
   the *whole* set after each edit, because a fix for one principle can regress
   another (killing render-blocking JS can shift layout). That needs an
   orchestrator tracking the aggregate, not seventeen independent skills.
4. **Principles as data buy what prose can't.** Because they're declarative
   (outcomes + guidance pointers + applicability), they're versioned, mapped 1:1
   to Modern Web Guidance, scored, reweighted, and opted-out per project - all
   without touching the method or the tools. A skill-per-principle recouples the
   *what* to the *how* every time, and tends to ossify into "here's how to check
   X" - the checklist tool this is positioned against.

The honest boundary: at small scale a single skill *is* enough - if you only
want "check my colour contrast," one skill does it. web-uplift's architecture
earns its keep the moment you care about more than one dimension at once, where
the shared-evidence and synthesis layer is the whole point.

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
