# Changelog — web-uplift

> **Reconstructed entries.** The 0.3.0, 0.4.0 and 0.4.1 entries below were
> written after the fact from git history, not at release time: the release
> commits for those versions (`2ba024c`, `23e9f76`, `6301563`) did not touch this
> file, so it stopped at 0.2.3 while the package moved on. Each entry names the
> commit range it was reconstructed from and summarises only what those commits
> say; nothing here is inferred. `RELEASING.md` now makes a contemporaneous
> entry mandatory, and `tests/changelog-version-check.mjs` fails a version that
> has no entry here.

## [Unreleased]

- **axe primitive**: the page is now navigated and analysed with its own
  Content-Security-Policy enforced; the policy is lifted only for the injection
  of the vendored axe-core (a strict `script-src` otherwise refuses it) and
  restored immediately afterwards. Previously the policy was lifted before
  navigation, so a page's own blocked inline scripts could run during the audit.
  The result now records that the injection bypass happened
  (`cspBypassedForInjection`, `cspBypassNote`) so a reader can tell this run from
  one where the policy was never lifted.

## [0.4.2] - 2026-10-05

### Fixed
- **Intermittent `No inspectable targets` failure in the evidence harness.**
  `newSession()` read Chrome's `/json/list` through a bare `CDP({ port })` and
  assumed a default page target existed. Chrome for Testing 154 sometimes boots
  with an empty list because the default New Tab fails to load (`incorrect
  profile type`), so roughly 1 in 3 browser boots threw and `npm test` could not
  be used as a merge gate. `newSession()` now creates its own target through the
  `/json/new` HTTP endpoint and attaches to the returned WebSocket URL directly,
  with a bounded retry only for the start-up race, so a real browser-start
  failure still fails loudly. The public API is unchanged.

### Added
- `tests/launch-loop.mjs`, a guard that runs the launch plus session loop and
  fails on any miss, wired into `tests/regression.mjs`.
- `docs/aoo-first-increment.md` and `evidence-out/aoo-increment/`: the first
  increment proposal for the two high findings (F-001 no dark mode, F-005 1.19MB
  fonts) on paul.kinlan.me, with the live re-verification artifacts.
  Documentation and evidence only, no runtime behaviour.

## [0.4.1] - 2026-09-25

Reconstructed from `23e9f76..6301563`.

### Added
- `a11ytree` gained `--max-nodes <n>` and `--max-stops <n>`, so the tree
  projection and the focus-order walk can be widened past their fixed caps of
  400 nodes and 60 stops. A live run against a personal blog measured 831 AX
  nodes and more than 60 focusables, so later articles and the footer landmarks
  fell outside the projection with no way to ask for the rest, even though the
  caps were already reported. The defaults are unchanged, the effective values
  are echoed in the output (`tree.maxNodes`, `focusOrder.maxStops`) and logged,
  and an invalid or missing value falls back to the default rather than emptying
  the tree. The skill's `a11ytree` row and common-options list carry both flags.

### Internal
- Regression coverage for the new flags: a small-caps run asserts the requested
  caps are used and reported as truncated, the default run asserts 400/60 are
  echoed, and a bad-caps run asserts the fallback.
- The release commit regenerated the install
  (`node bin/web-uplift.mjs install --agent all`) so the canonical skill, the
  `.pi` copy, the vendored `.web-uplift/skill` copy, the manifest and the
  vendored evidence CLI are all byte-identical to their sources at 0.4.1, and
  rewrote `AGENTS.md`'s "Current release" section to describe v0.4.1.

## [0.4.0] - 2026-09-25

Reconstructed from `2ba024c..23e9f76`.

### Added
- Six new evidence primitives, all raw CDP:
  - `console`: first-party load-time console evidence from
    `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` and `Log.entryAdded`,
    enabled before the navigation so output fired during load is captured.
    Entries dedupe by kind/level/source/url/text with a repeat count and cap at
    100 shown / 500 buffered. Counts are split into console errors, warnings,
    exceptions, network errors (failed subresources, including Chrome's
    automatic favicon 404) and browser log errors. The same block rides along on
    every other primitive, so any measurement reports what it heard, and
    `emit()` joins it before the JSON artifact is written so artifact and stdout
    agree. This was the missing first-party path for `no-console-errors`.
  - `targets`: WCAG 2.2 SC 2.5.8 target size. Enumerates pointer targets (native
    `a`/`button`/`input`/`select`/`summary` plus the common interactive roles,
    with the exact selector in the output), records each box in CSS px, and
    applies the exception structure the spec spells out: `inlineInText` and
    `spacingPasses` (a 24px-diameter circle centred on the box clears every
    other target box and every other undersized target circle). The
    user-agent-control and essential exceptions are left to the model;
    `underMinNoKnownExemptionCount` is the mechanical "needs judgement" set, not
    a verdict. Measured at a 1280x720 desktop and a 360x800 narrow layout by
    default, as pure layout sizes, because mobile emulation would lay a page
    with no viewport meta out at Chrome's 980px default and silently measure
    that instead. Caps reported at 400 targets.
  - `axe`: vendored axe-core read from disk as an npm dependency (no CDN, no
    network at audit time), with `Page.setBypassCSP` enabled before navigation
    and disabled in a `finally` so the bypass is scoped to this primitive only.
    It replaces the skill's prescribed inject-through-`evaluate` path, which
    silently failed on any site with a strict `script-src`, i.e. exactly the
    well-configured ones. Violations come back grouped by impact with node
    targets and failure summaries, descriptive only; the model still judges.
  - `features`: a census of modern CSS and overlay primitives taken from the
    LIVE CSSOM rather than a grep of `dom`'s capped css string. Walks document
    sheets (following same-origin `@import`s and counting cross-origin sheets it
    is not allowed to read instead of crashing), constructable/adopted sheets,
    shadow-root sheets and inline styles, and returns at-rules, conditional
    preludes, declared properties, functions and pseudo-selectors with counts, a
    `tracked` block giving a 0-or-count row per feature the checks turn on,
    distinct custom properties, and the overlay census (native `dialog`,
    `[popover]` and `details` against div-based modals). Caps reported at 60
    conditions and 400 properties. No Baseline table is vendored, on purpose,
    because it would go stale.
  - `resilience`: loads the page online first so a worker can install, activate
    and cache, then reports service worker registrations and versions from the
    `ServiceWorker` domain (each tagged with whether it belongs to the audited
    origin, because the domain also reports the browser's own component-extension
    workers) cross-checked against the page's own view; the resolved manifest's
    installability-relevant fields, icons and the mechanical signals Chrome uses;
    and a real offline reload under `Network.emulateNetworkConditions` with the
    net error, what actually painted, and a screenshot of that state. Also the
    failure-injection path for `network-and-http-failure-states`.
  - `a11ytree`: `Accessibility.getFullAXTree` projected to role, computed name,
    description, ignored plus reasons, the flag properties the checks turn on,
    child count and depth, nested in reading order with a role histogram of
    non-ignored nodes; plus the REAL tab order, walked by dispatching Tab with
    CDP key events and recording each stop's element, rect and on-screen state,
    its computed outline and box-shadow with a mechanical `hasVisibleIndicator`
    reading, and whether it sits inside an `aria-hidden` subtree, which removes
    it from the accessibility tree but not from the tab order.
- Throttling conditions available to every primitive: `--cpu-throttle <rate>`
  (`Emulation.setCPUThrottlingRate`) and `--network <profile>`
  (`Network.emulateNetworkConditions`). Named profiles carry the exact DevTools
  preset numbers plus `mobile-lighthouse`, the configuration Core Web Vitals
  thresholds are calibrated against; unknown profiles fail loudly. Before this,
  every primitive measured on an unthrottled headless desktop, the one
  configuration guaranteed to pass.
- `--locale <bcp47>` (`Emulation.setLocaleOverride`) and `--timezone <iana>`
  (`Emulation.setTimezoneOverride`), both validated up front so a typo fails
  instead of silently judging the default locale. These make the three
  `be-internationalised` checks observable from a rendered two-locale / two-zone
  diff rather than source reading alone.
- Every primitive's output now records the conditions it ran under (network
  profile and numbers, CPU rate, viewport, emulated media, locale, timezone), so
  a finding states the device class it was measured on; an unthrottled,
  unemulated run carries no conditions block at all.
- `runner/remaining-work.mjs`: `countOutstanding`, `completionState` and
  `remaining` lifted into one shared module after being defined twice with
  identical findings-only logic in `fixer/fix.mjs` and `aggregate/compare.mjs`.
  `compare.json` gains `unconcludedBefore`/`unconcludedAfter` and `compare.md`
  renders the delta, so concluding a blocked check reads as the progress it is
  instead of "Outstanding issue-findings: 0 -> 0".

### Changed
- **The atomic coverage contract became mandatory.** The skill now requires a
  materialised coverage manifest of every expected `(principleId, checkId)` pair
  with exactly one `checkOutcomes` row each, carrying status, confidence, method,
  evidence and reason; `blocked` and `not-run` derive an `incomplete` principle
  and a `partial` run, never a `completed` one, and a partial run reports exact
  executed/expected counts instead of a score. `schema/findings.schema.json`
  gained the `coverage` accounting block (expected, recorded, judged, blocked,
  notRun, missing, unknown, duplicates, complete) and the `checkOutcomes` rows,
  `schema/validate-report.mjs` was added to enforce them, and `scoreReport` now
  refuses to score a report whose `coverage.complete` is not true. Both example
  reports were expanded to the new shape.
- **Truncated evidence is not absence.** A new skill rule: a miss in a capped
  sample cannot produce a `pass`, so gather the rest (`evaluate --expr` against
  the live DOM/CSSOM, `--source`, or re-run the primitive under the condition
  that moves the cap) or judge the check partial. The `detectableVia` hints for
  the eleven checks the new primitives serve were re-pointed at the first-party
  path instead of leaving the model to invent a probe, which moved the
  `principles.json` checksum and so re-pinned `coverage.catalogChecksum` in both
  example reports. The checks themselves are unchanged, only the hints.
- Fix mode measures progress on findings PLUS unconcluded checks, so a climb
  that spends an iteration unblocking a check registers as progress instead of
  stopping early. `completionState` takes the worse of the recorded rows and the
  report's own `coverage.complete` declaration, so a wrong self-declaration can
  only cost a run its pass and never grant one, and a report with no coverage
  accounting at all is treated as unverifiable rather than clean. Goal mode gets
  the same guard, checked before the score.
- The batch runner gates audits on atomic coverage and resumes only after a
  validated report; `pi` batch audit sessions are isolated and no longer take an
  extension lock.

### Fixed
- Every cap that drops data now says so, in the JSON (a sibling
  `<name>Total`/`<name>Chars` plus `<name>Truncated`) and on stderr, across
  `dom` (outerHTML and css at 200000 chars), `secrets`, `cookies`, `images`,
  `trackers`, `layout`, `trace` and all eight of `har`'s ranked lists, with
  honest pre-slice totals. Under the cap the same fields prove completeness, so
  absence is evidence again. Before this a model grepping `dom`'s capped css for
  `@container` or `anchor-name` could not tell "the page does not use it" from
  "the rule was past the cap", which silently converted truncation into a false
  pass on four checks.
- Fix mode no longer crashes on a structurally malformed report. `readReport`
  validates the shape once, where parse failures are already wrapped, and fails
  with a named error pointing at the offending field instead of a raw
  `TypeError` from whichever helper touched it first. A malformed
  `checkOutcomes` was worse than a crash: it went silently ignored and, with zero
  findings, printed `PASS: no outstanding issues remain and every check
  concluded.` and exited 0. Absent and null stay legal so pre-contract reports
  keep working.
- Fix mode no longer dies on an unscoreable report, i.e. a partial run or any
  report written before the coverage contract existed, which are exactly the
  reports most in need of fixing. `reportSummary` became `reportSummarySafe` and
  returns `{ scoreable, reason, summary }`; severity counts come off the findings
  and stay accurate either way, and the climb proceeds on outstanding findings
  while printing why the score is unavailable. Goal evaluation needed an explicit
  guard too, because `evaluateGates` reads a null outcome as not-applicable and
  passes it, so an all-null summary satisfied every `--goal-min`.
- Fix mode can no longer pass a partial run on findings alone: a report with zero
  findings and unconcluded checks used to print
  `PASS: no outstanding issues remain.` and exit 0, and did so even when it
  declared `coverage.complete` true while still carrying blocked rows.
- `discoverability` compared rendered coverage by verbatim substring, so
  `h1PresentInRaw` reported false for any server-rendered heading containing
  inline markup or line breaks, because `innerText` collapses both. It now goes
  through a normalised content-token comparison sharing the primitive
  `coveragePct` already used, with a whitespace-normalised fallback for values
  that have no tokens; the title comparison used the same broken approach and
  shares the helper. On paul.kinlan.me this flipped `h1PresentInRaw`
  false -> true while `coveragePct` was already 100, i.e. the primitive had been
  calling a fully server-rendered h1 missing from the crawler view.
- The playground gave `light-dark()` its mandated fallback: colours are declared
  as custom properties set from `prefers-color-scheme` for the fallback path,
  with `light-dark()` opted into only inside
  `@supports (color: light-dark(white, black))`. The guidance feed marks the
  fallback mandatory for browsers that support `color-scheme` but not
  `light-dark()`, where a bare declaration is dropped whole and the card loses
  its background, text colour and border. The other five scenarios' APIs are all
  Baseline widely available, so this was the only mandated fallback missing.
- The frozen eval fixture mirrored the playground's
  `@media (max-width: 640px)` collapse, so `?mode=fixed` no longer overflows
  horizontally by 58px at 360x800. `responsive-no-horizontal-scroll` could not
  pass in fixed mode no matter how the scenario was written, which broke the
  six-scenario precision guard; issue mode still overflows, at the measured
  928px, so recall is intact and the seeded defect is isolated to the scenario
  rather than mixed with a shell defect.

### Internal
- `PLAN.md` recorded the product contract: the product is the complete decision
  package, not the runner, a score or an aggregate dashboard; for every check the
  user must be able to inspect what was tested, how, the retained evidence, the
  verdict and confidence, the exact failure or blocker, why it matters and a
  prioritised action, with missing collection visibly different from a tested
  failure.
- Hill-climb optimizer verification written up (recall 9 of 9 in issue mode,
  precision 6 of 6 in fixed mode), with the exact climb diff appended so the
  applied fixes are reviewable from the branch rather than only from a gitignored
  scratch copy. It recorded two findings that became fixes above: F-007 button
  contrast is dark-preference dependent and invisible to Lighthouse, and the
  fixture's reference `light-dark()` fix carried no mandated fallback.
- Beads issue tracking initialised.
- The release commit regenerated the install and brought in the vendored
  `.web-uplift/knowledge/principles.json`, `.web-uplift/schema/`,
  `.web-uplift/aggregate/` and `.web-uplift/runner/` trees, which were a release
  behind. `AGENTS.md`'s "Current release" section described v0.1.3 and now
  describes v0.4.0. `npm publish` and the `v0.4.0` tag were deliberately not
  done in that commit: publishing has real-world effect, so it wants the
  maintainer to call it.

## [0.3.0] - 2026-07-10

Reconstructed from `aaaae59..2ba024c`.

### Added
- Five new evidence primitives, all documented in `SKILL.md`:
  - `secrets`: scans the page for exposed API keys, tokens and credentials. The
    skill instructs the auditor to reason about what it finds, legitimate public
    keys versus sensitive secrets, for `be-private-and-secure`.
  - `headers`: security response headers.
  - `cookies`: a `Secure`/`SameSite`/`HttpOnly` audit.
  - `trackers`: third-party tracker enumeration.
  - `images`: a CLS, optimization and format audit.

## [0.2.3] - 2026-07-07

### Added
- Descriptive `guides` search terms for the checks that had none: the three
  `be-memory-efficient` checks (they carry rich `references` to the memory-tracer
  methodology but had no searchable term) and a color-scheme term. Also added the
  genuinely-relevant `manage-recurring-intervals` guide to the detached-DOM/
  listeners check. Add-only; no existing ids changed. Every check now has at
  least one guide entry (id or search term).

## [0.2.2] - 2026-07-07

### Fixed
- **Reverted the over-aggressive guide "pinning" from 0.2.1.** That change had
  replaced whole `guides` lists with a single id, dropping legitimate related
  guide ids (e.g. view-transitions lost same-document-transitions,
  group-element-transitions, faster-spa-view-transitions), and force-pinned
  SEO/console checks to `html` when a search term + the model's own knowledge is
  the right call for concepts Modern Web Guidance does not cover. Restored the
  original lists.
- Kept the one genuine fix: the stale guide id `declarative-button-actions`
  (not in the catalog) -> `custom-button-actions`.

### Note on the `guides` field
Each check's `guides` is intentionally a MIX: several explicit Modern Web
Guidance ids (retrieved directly) PLUS, usually, one descriptive search term
(the model runs `search` with it, or leans on its own knowledge for topics MWG
does not cover, like SEO). Both forms are valid by design; a search term is not
a bug.

## [0.2.1] - 2026-07-07

### Fixed
- **Firmed up the Modern Web Guidance mappings in principles.json.** A validation
  audit found several checks whose `guides` query strings semantic-searched to the
  wrong guide (contrast -> highlight-text-ranges, meta-description -> accessibility,
  console-errors -> security, no-dark-patterns -> dark-mode, visual-stability ->
  css, view-transitions -> directional-navigation-transitions, and more). Pinned
  13 of them to explicit, verified guide ids so the audit retrieves the right
  guidance deterministically instead of drifting. Also fixed 2 stale guide ids
  (`declarative-button-actions`, not in the catalog -> `custom-button-actions`).
- Note: MWG is a capabilities feed, so a few checks (SEO title/description,
  canonical/indexing, structured metadata) have no dedicated guide and are pinned
  to the closest broad guide (`html`); those checks lean more on their non-MWG
  `references`.

## [0.2.0] - 2026-07-07

### Changed
- **Modern Web Guidance is now mandatory in both the audit and the fix**, not an
  optional "consult if you like". The canonical skill
  (`.claude/skills/web-audit/SKILL.md`) now requires the model to `search`/
  `retrieve` the live MWG feed for every principle it judges (up front) and to
  `retrieve` a guide before writing any fix. Judging or fixing from memory is a
  skill violation. This addresses the top user report: the audit/fix wasn't
  actually calling Modern Web Guidance.

### Added
- `guidanceConsulted` on the report (schema/findings.schema.json): the MWG guide
  ids actually retrieved this run. Must be non-empty whenever there are
  issue-findings, and each issue-finding's `guidanceId` must come from it.
- A regression test enforcing the above (a report that skipped guidance fails).
- Example reports now carry `guidanceConsulted` to model the requirement.

### Fixed
- Re-synced the vendored/agent skill copies (`.web-uplift/skill/SKILL.md`,
  `.pi/skills/web-audit/SKILL.md`) with the canonical `.claude/` skill; they had
  drifted.
