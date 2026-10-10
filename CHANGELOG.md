# Changelog — web-uplift

## [0.5.1] - 2026-10-10

### Security

- **Write-scope accounting in batch audit mode.** The batch audit runner now enforces the same write-scope tracking as fix mode: it takes a before/after filesystem snapshot per URL, restricts permitted changes strictly to `--out`, records write diffs, renames any refused report file to `report.refused.json`, and refuses to promote it as the latest run. (wy6: c5323c2, ba38a49, 112b55a, f82c321, 8b22cc4, b4e5fda)
- **Strict environment allowlist for agent subprocesses.** Subprocesses spawned by the runner no longer inherit the host process environment. An explicit allowlist passes only essential execution variables (such as PATH, locale, and HOME) along with provider credentials, sensitive variables withheld from the child process are warned on stderr, and operators can pass specific overrides using the `--agent-env KEY=VALUE` flag. (l6d: a625fee, b293cf6)
- **Provider credential scoping for mapped agents.** By default, mapped agent CLIs receive only their corresponding provider credential family (Claude receives Anthropic keys, Codex receives OpenAI keys, and Gemini receives Google keys); unmapped CLIs receive the broad provider set and operators can pass specific overrides using `--agent-env`. (5ta: 32aab14, c91a3b6)
- **Executable tree integrity verification.** The write-scope tripwire covers key execution roots (`evidence`, `runner`, `fixer`, `aggregate`, `schema`, `knowledge`, `bin`, `install-surface.mjs`, and vendored dependencies in `.web-uplift`). The batch audit runner enforces a pre-spawn integrity check that aborts subsequent URLs immediately if any executed file under these roots is modified during execution. (dzd: 6fed32c, eaf665b, 9f37810)
- **Mandatory isolation assertions for batch audits.** The headless batch audit runner requires an explicit isolation assertion (`--isolation <mechanism>`) or an acknowledgement flag (`--i-know-this-is-unisolated`) before launching agents, recording the boundary in `run-security.json` matching the contract used by fix mode. (odx: c467e67, f205296)
- **Unisolated batch resume is refused.** `--resume` cannot be combined with `--i-know-this-is-unisolated`; an asserted isolation boundary remains unverified and must protect the agent-writable latest pointer. (4m2: 09d52f2, 985ef46)
- **Hardened credential redaction across network artifacts.** The names-based redaction pipeline (`redactBodyText`) uses parse-to-locate and splice-to-redact algorithms across URLs, query strings, headers, request bodies, redirects, and responses. Pattern matching recognizes camel-case and snake-case naming conventions, handles TypeScript type annotations and destructuring shapes, and descends into nested containers to redact recognized credential names in retained evidence (unnamed, encoded, or out-of-vocabulary secrets remain unredacted). (dsj: 66c22bf, af8c57c, ff38035, cfbc821, 7f44c57, aa33215, 30e3616, e53bb44; xwr: b66e3ba, e1f38ab, cea1901)
- **Local source code redaction in DOM evidence.** When gathering DOM evidence with `--source`, local source trees are sanitized before inlining: credential-named files and directories are skipped without reading, file contents are passed through the redaction engine, and skipped files and redaction counts are recorded in the artifact metadata. (obl: 072c02f, 0f48415)
- **Reporting pointer and scorecard path containment.** Reporting consumers reject latest-pointer targets outside the host run directory, and scorecard comparison identifiers must name direct child directories. Batch `--resume` still trusts an unauthenticated agent-writable latest pointer and requires an operator-provided boundary. (9t8: b2050c1, f72d16f)
- **Symlink traversal defenses.** Directory traversal guards in `readSourceTree` and the package installer refuse symlinks, preventing symlink escape attacks during source audits and installation. (etp: 8becadf; z34: f9dd253)
- **DNS rebinding protections via IP pinning in fetch.** `safeFetch` pins each request to the previously validated IP address (`pinnedFetch`) to protect against DNS rebinding attacks between DNS resolution and HTTP fetching, and properly handles decoding of pinned responses. (16e: 29dce99, d91a14f)
- **Dependency vulnerability remediation.** Upgraded `@modelcontextprotocol/sdk` to `^1.31.0` to resolve GHSA-6qxp-vccf-f47h / CVE-2026-104850. (7av: d68dc81, c611e0f)
- **OS sandbox enforcement on audit browsers.** Chrome's OS renderer sandbox is kept enabled by default during all audits, preventing untrusted web content from executing unsandboxed; disabling the sandbox requires an explicit `WEB_UPLIFT_NO_SANDBOX=1` opt-out, and it is enabled automatically when running as root, with skill guidance aligned to omit `--no-sandbox` flags. (d2l: 73fc31a; 17q: 0ce09dc)
- **Default pipe transport eliminates loopback network exposure.** Replaced the default loopback TCP port transport with Chrome's native pipe transport (`--remote-debugging-pipe`, standard file descriptors 3 and 4), eliminating local network endpoint exposure to other processes on the host. When port transport is explicitly requested, the endpoint is verified against kernel socket tables to strictly bind loopback addresses. (j3re: 4f32f95, c5ca50f; 4rv: 2f23302, 490fbe6, 18751fb, a4cd289; 03da: 18751fb; sj4c: 18751fb)
- **Form input sanitization and PII protection in flow recording.** The flow recorder automatically sanitizes recorded form inputs, redacting passwords, credit cards, one-time passwords, and sensitive PII, while guarding hidden input fields by default to prevent leaking session and CSRF tokens into recorded journey scripts. (r5t: a2133a6, f63bd56, df6c5ba, 6cb610f, fb9af75; fejl: 14a7218, 526a1ed; ngjq: 39ede41, 62bd3c1; kyez: 526a1ed; vj2q: 526a1ed)
- **Safety gate for flow replay form mutations.** Journey flow replay introduces a mandatory `--allow-mutations` gate for form submissions and mutative button clicks. In read-only dry-run mode, form submissions, write URLs, typing steps, and destructive actions (delete, submit, checkout, remove) are strictly denied by default to prevent accidental production mutations. (bwh: 7cd580b, 0abe197, 5b8321c, 6cb610f, fb9af75; d31/e4z: e9bb75f, 3b8caf6, 385a6c2, cedbb35, 3473b6d; lw6: 5b8321c)
- **Authenticated and gesture-verified flow recording bindings.** The in-page recording binding (`__wuRecordStep`) is isolated in a separate script world, authenticated with a per-session random token, and validated to ensure recorded interactions originate from genuine user gestures rather than synthetic page scripts. (sg5: 46e4035, 2bd3495; q7s6: 869d652; qgz3: 759a4cf; g8yf: 7e4b1d7)
- **URL userinfo credential redaction across unparseable and protocol-relative shapes.** The URL credential redactor redacts username and password credentials in authorities (`scheme://user:pass@host`), preserves the host in protocol-relative URLs (`//host/path`), handles empty usernames (`//:pass@host`), and sweeps unparseable URLs without leaking userinfo across whitespace or delimiters. (73y3: 1c67ea4, fdf7880, dcafbb0, 5385cb6, 85873dc, a2637f3, 6224344; 53o1: e976a29; 5m9f: db26365)
- **Comprehensive credential redaction in console evidence and runner logs.** Failed subresource request URLs and error messages captured by console evidence are routed through the credential redactor, redacting sensitive query parameters and URL userinfo before entries are written to retained evidence. Printed runner log lines and target URLs are also scrubbed to prevent leaking credential-bearing query strings to stdout. (lsn3: c813f05, 3e085ab, 967a631, e6942a8, f06c6eb, 03b9277; b9p/s0x: 8823f7a, 1011a7c, 8f10ce8; glar: 314ba4b, f078d16; 6fe: 9d87e91)
- **Resource limits and deadlines on in-page script secrets scanning.** The secrets primitive enforces the configured 2 MiB byte cap and the configured fetch deadline (30 s default) when fetching external scripts in page context, preventing hangs and memory exhaustion when auditing pages with oversized or stalled script resources. (61i: a39dd3d)
- **Opt-in CLI update check with untrusted registry handling.** The automatic npm update check is disabled by default, requiring an explicit opt-in, and response data from the npm registry is validated before use to prevent untrusted registry responses from influencing execution. (wgy: d7501af)
- **Installer destination symlink refusal.** The package installer refuses pre-existing destination symlinks in target project directories, preventing symlink traversal attacks during installation. (yel3: 33d481d)
- **Safe parser for downloaded Modern Web Guidance use-cases table.** The downloaded `USE_CASES` table is parsed as data using a dedicated tokenizer rather than via `eval()`, preventing code execution during catalog updates. (w0y: 2a291f7, 5e1820c, 1bbe8cf, f31811b)

### Added

- **Browser launch-time process attribution.** Batch audits log each browser process invocation to a run-level `launches.jsonl` record, and operator flows record to the file named by `WEB_UPLIFT_LAUNCH_LOG`, capturing primitive name, target URL, PID, profile directory, and launch outcome. (4wx: 85933e0, 3e3f748, 6572d69; 6x7: 3499119, 318e83e)
- **Automated Modern Web Guidance drift monitoring.** Introduced a scheduled six-hour drift detection pipeline and GitHub Actions workflow to audit upstream Modern Web Guidance npm releases against the local canonical rule catalog, tracking reversal-first rule deltas, binding basis-registry version provenance, verifying set hashes, and generating structured reports. (dfk: 246445d; vbv: 852706f, 9a12b51, 72446f8, b920777, 1b56982; 0o6/6ov: ffb82c1; ef7: b0227d0, 60a9821, 55b5633, 3454901; 968: 02c2322; z5j: ba89042, 8ada339)
- **Vendored copy synchronization guard and resync command.** Introduced `tests/cdp-copy-sync.mjs` and `npm run sync:vendored` to ensure vendored files under `.web-uplift/` match their source equivalents across the project, preventing one-sided fixes from leaving stale code in vendored surfaces. (6ha1: 64122de; 2gdo: 4bdb2e7; i406: 0617bf8)

### Changed

- **Modern Web Guidance upgraded to 0.0.193.** Principles, guidance docs, runner permissions allowlist, and skills pinned in lockstep to `modern-web-guidance@0.0.193`. (cy8/bxl: b9676b8, 2205951, 3b02a47; cp8: dcfab3c, 0b3e5c1)
- **Full 178-guide canonical catalog coverage.** The principles catalog (`knowledge/principles.json`) and catalog specification cover all 178 guides in Modern Web Guidance 0.0.193, including `prompt-api` in `built-in-ai`. Publishes a sorted guide ID array with SHA-256 set hash `bc041692e3d9631a997427252ce2e54d8a5a0dd7e28387b4dcae6a4b9d3d5ab2`, verified identical to `mwg-train`. (ddf: bbb0fc6, 4039425; 968: 852706f, 9a12b51, 02c2322)
- **Guidance rule reanalysis and reversals.** Updated enforcement rules for Content Security Policy (mandatory `object-src 'none'`, `frame-ancestors 'self'`, and `require-trusted-types-for 'script'`), HttpOnly session cookies, Firefox 129+ top-layer animation support, and async WebMCP `registerTool` with structured error return. Removed obsolete guide `prevent-text-wrapping` and migrated `declarative-button-actions` to `custom-button-actions`. (cy8/bxl: b9676b8, 2205951)
- **Unified installer vendored surface.** The vendored file/directory surface is declared in a single source (`install-surface.mjs`) shared by both the installer and the byte-identity guard, backed by real-install drift tests. (7mr: bc47f23, 8d3bcd4)
- **Agent scratch now stays inside its run directory.** A guard checks that skill-instructed write paths remain consistent with the runner's write scope. (16f: b66de21, 34dd337, 195b845)
- **Documentation of URL contracts and discoverability timeout behavior.** Documentation clarifies the distinction between the requested target `url` and the post-redirect `finalUrl`, names all deadline options, and establishes that a timed-out raw document fetch in the discoverability check represents an unknown verdict rather than a negative pass. (1th: d6a0679, f71881d, f3c955e, be0c302)
- **Pre-compiled regex patterns in redaction.** Compiles `redactBodyText` regular expressions once rather than allocating per call, speeding up scans over large bodies. (eqo: 66edd5d)
- **Fast concurrent snapshot copying.** `snapshotRun` copies run artifacts concurrently during fix iterations, reducing disk snapshot overhead. (9kz: 49fdb48)
- **Generated, gitignored `.web-uplift/` vendored directory.** The `.web-uplift/` tree is gitignored and generated automatically on `npm run prepare` (postinstall lifecycle), reducing repository footprint while keeping install surfaces reproducible. (diaq: c6c626d)
- **Modularized evidence primitives.** Decomposed the monolithic `evidence/cli.mjs` file into modular per-primitive files under `evidence/primitives/` (`dom.mjs`, `har.mjs`, `headers.mjs`, `trace.mjs`), with shared utilities in `evidence/common.mjs`. (ypds: 02bdec3; 1lif: d036374)
- **Allocation-free whole-word matcher in flow click classification.** Replaced dynamic regular expression compilation in `classifyClickControl` with a self-contained, allocation-free substring search, improving click handling performance during in-page flow execution. (geqc: f289c81)
- **Concurrent non-loopback exposure probing.** Host exposure verification probes non-loopback addresses concurrently while preserving diagnostic verdict ordering. (690r: 30e533e, cf9f7ec, 5e3a18e, e528ab8, 90d271b)

### Fixed

- **Pre-reserved layout boxes for report screenshots.** Intrinsic image dimensions are read directly from screenshot bytes (supporting PNG, JPEG, GIF, and WebP VP8/VP8L/VP8X chunks) and embedded in the report markup so browsers reserve the correct display box before image decoding, preventing layout shifts. Truncated WebP chunks are bounds-checked before their header fields are read. (xq5: 2418d52, 83debe1, 18bf67e, 18c0c65, 4c1ff63; 93s: 98256e7, fdcc031, 77c09f2)
- **Scorecard comparison run validation and failure tolerance.** Scorecard comparison run identifiers are validated as single-segment child directories within the run root. Missing or invalid comparison identifiers no longer crash scorecard generation. (9li: b6b3e18, 6832599)
- **Batch audit resilience to vanished run directories.** A missing or deleted run directory during a batch audit fails only the affected URL rather than aborting the entire batch. (9li: a26ff3c)
- **Batch completion no longer infers a published run from a fallback directory.** Resume checks the tool's latest pointer, and failed completion bookkeeping is reported rather than counted as success. (wy6: 7323f2e, f14c2e7, 02718ac)
- **Script URL quote escaping in secrets scanning.** Page-derived external script URLs containing quotes are escaped using `JSON.stringify` before expression evaluation, preventing syntax errors from silently skipping external scripts during secret scans. (991: 3abdf86, eeafd00)
- **Service worker registration settle detection.** Resilience audit primitives wait a bounded observation window for late service worker registrations, recording that no registration was observed within the bounded window rather than immediately reporting false absence before service worker installation completes. (5jd: 2d7ac96, 0e1ea0d, 4a0df1f, 7a1e144)
- **Bounded evidence collection and raw document gating.** Direct navigation and CDP operations enforce configurable timeouts (`--cdp-deadline`, `--fetch-deadline`), validate `--out` before launching browsers, and report the shell verdict as unknown if raw document retrieval fails or returns non-2xx responses. (17o: 1ca169f, 5105fad, 8d34a4c, 05b2a1c, 9d2c0e4, 294f6a6, b0afd01, f8d77e5, 818f142, 01fd86e, a013778, 0e68e99)
- **Headless Claude audit permission compatibility.** Derived the headless Bash tool allowlist directly from the audit skill contract, enabling headless Claude sessions to run mandated inspection commands without permission refusals. (7tj: 5a04a88, 1acc13a, b521fbb, 5c0ab59)
- **Packaged CLI startup integrity.** Included `install-surface.mjs` in the npm package files allowlist, resolving startup `ERR_MODULE_NOT_FOUND` errors in packaged tarball installations. (7mr: 9347b77, 8d3bcd4)
- **Pipe transport send rejection, readiness bounds, and liveness verification.** The pipe transport rejects in-flight and queued sends immediately if file descriptor 4 closes, bounds readiness handshakes with actionable diagnostics when Chrome fails to respond, and verifies browser process liveness with a bounded exit settle after launch. (h6yn: f9456eb; xnte: e2c3a71; py0e: 7ff6efc)
- **Port transport stderr listener leak.** Detaches the stderr listener once the DevTools listening port is identified, preventing listener accumulation over long-lived browser sessions. (ctft: 317d129)
- **`headers()` response wait scaled with navigation deadline.** Response collection for the `headers` primitive scales dynamically with the configured navigation deadline, preventing false-negative "missing header" findings on slow or CPU-loaded targets. (met0: 072b46e)
- **Stream pipe buffering for large corpus extraction.** Fixed stream writing to prevent corpus truncation at 64 KiB pipe boundaries during classification exports. (as3: 5f59da1, 651b110, e6c236e, 0b22f8d)
- **Empty basis registry validation in drift monitoring.** Drift checks reject basis registries declaring zero rules, preventing false-positive green runs. (uxr: 8917d2c, 0741529)
- **Userinfo sweep across tab, LF, and CR characters.** Unparseable userinfo sweeps treat tab, line feed, and carriage return characters as transparent to match WHATWG URL parser stripping rules, preventing credential truncation in HTTP headers. (k99c: 2729963)
- **Flow recorder timeout CLI option plumbing.** Plumbed the `--timeout` option through `runner/flow.mjs` to configure flow recording session duration. (w2s0: 526a1ed)

## [0.5.0] - 2026-10-06

### Security

- **Fix mode requires an operator-supplied isolation assertion.** It will not spawn
  a write-capable agent until you name the boundary you are providing
  (`--isolation docker|bwrap|vm|host-permission-model|...`); the assertion is
  recorded as unverified in `<out>/run-security.json`, warned about on stderr, and
  travelled into the retained run. A run with no assertion is refused before any
  spawn and records `isolation: refused`. The tool does not sandbox the agent and
  cannot verify the boundary. README.md ("Running it safely") documents what that boundary
  must guarantee; the tool ships no command for it, deliberately, because a copy-pasteable
  command would be wrong for some operator layouts and an outer wrapper cannot protect the
  report history when the fixer parent and its agent share one mount.
- **Fix mode scopes every agent run.** The tree is snapshotted around each spawn
  (the baseline audit included) and the run is refused when a change lands outside
  `--target`/`--out`, with a per-run diff written for review. This is DETECTION,
  not confinement, and its gaps are documented in `runner/write-scope.mjs`.
- **A refused run no longer publishes.** The retained after-run, the `latest`
  pointer and the scorecard are written only after a climb completes, so a refused
  or failed run leaves the reports tree exactly as it found it.

### Added
- **The install manifest records the vendored dependency tree.** `install` copies
  `chrome-remote-interface` and `web-features` (with their dependencies) into
  `.web-uplift/node_modules`. Those packages are in no consumer lockfile, so
  nothing in the project named them or their versions. The manifest now carries
  `vendoredDependencies`, the name and version of every package that was copied,
  so the tree a project received can be inventoried and audited from the project
  itself. (Landed in web-uplift-92b without its own entry; written here by the
  release owner.)

### Fixed
- **axe primitive**: the page is now navigated and analysed with its own
  Content-Security-Policy enforced; the policy is lifted only for the injection
  of the vendored axe-core (a strict `script-src` otherwise refuses it) and
  restored immediately afterwards. Previously the policy was lifted before
  navigation, so a page's own blocked inline scripts could run during the audit.
  The result now records that the injection bypass happened
  (`cspBypassedForInjection`, `cspBypassNote`) so a reader can tell this run from
  one where the policy was never lifted.
- **headers primitive**: response header names are now matched case-insensitively.
  A capitalised response - the shape an HTTP/1.1 response arrives in - previously
  had every security header read as absent, so a site that really sends a
  content-security-policy, strict-transport-security or the others could be
  reported as sending none of them. A header that is present but EMPTY is now
  recorded as its own state (`empty`, with a `present but empty` issue) instead of
  reading as absent or as a clean pass, and the HAR path's request content-type and
  redirect location lookups now go through the same lower-casing.
- **conditions**: an artifact now records the emulation profile it was measured
  under, not only the dimensions: `conditions.viewport` carries `profile` (`mobile`
  or `desktop`), `width`, `height`, `deviceScaleFactor` and `mobile`, built by the
  same helper that applies the metrics, so the record cannot disagree with what the
  run used. A reader of the JSON can now tell a mobile emulation from a narrow
  desktop window. A run with no device-metrics override still records no viewport at
  all, rather than an invented profile.

### Changed
- **`x-content-type-options.present` now means the response sent the header**, not
  that the value was `nosniff`. A non-nosniff value now reports `present: true`
  with a `not nosniff` issue, and an empty value reports `present: true,
  empty: true` with a `present but empty` issue, where both previously read as
  `present: false`. Consumers that treated `present` as "the value is correct"
  should read `issues` for this header.

> **Reconstructed entries.** The 0.3.0, 0.4.0 and 0.4.1 entries below were
> written after the fact from git history, not at release time: the release
> commits for those versions (`2ba024c`, `23e9f76`, `6301563`) did not touch this
> file, so it stopped at 0.2.3 while the package moved on. Each entry names the
> commit range it was reconstructed from and summarises only what those commits
> say; nothing here is inferred. `RELEASING.md` now makes a contemporaneous
> entry mandatory, and `tests/changelog-version-check.mjs` fails a version that
> has no entry here.

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
