# Post-reanalysis End-to-End Verification Evidence (web-uplift-24o)

**Date:** 2026-10-08  
**Bead:** `web-uplift-24o` ("Post-reanalysis end-to-end verification: drive the updated tool (pin 0.0.193) on a real public site")  
**Target:** `https://paul.kinlan.me/`  
**Master Commit:** `6393d91`  
**Guidance Pin:** `modern-web-guidance@0.0.193`  
**Run ID:** `2026-10-08T14-10-00-000Z`  
**Reports Dir:** `reports/paul_kinlan_me/2026-10-08T14-10-00-000Z/`  

---

## 1. Executive Summary & Verification Mandate

Following the landing of `web-uplift-cy8` (updating `knowledge/principles.json`, guidance docs, tests, and runner pins to `modern-web-guidance@0.0.193`), `web-uplift-24o` mandates functional, browser-driven verification on a real public site.

Per AGENTS.md, "tests pass" is not evidence "it works". This verification:
1. Drove live Chrome over raw CDP against `https://paul.kinlan.me/` across all core evidence primitives.
2. Verified atomic coverage completeness (58/58 checks judged, complete: true, 0 blocked, 0 not-run) with `coverage.catalogVersion = modern-web-guidance@0.0.193`.
3. Executed a dedicated probe on CHANGED/REVERSED rules (CSP mandatory directives `object-src 'none'`, `frame-ancestors 'self'`, and `require-trusted-types-for 'script'`).
4. Recomputed scorecards and generated before/after diffs against the 2026-10-06 baseline.

---

## 2. Multi-Modal Evidence Collection

All evidence primitives were driven directly against `https://paul.kinlan.me/` via `node evidence/cli.mjs`:

| Primitive | Output Artifact | Notes |
|---|---|---|
| `headers` | `evidence/home-headers.json` | Captured live CSP, HSTS, Permissions-Policy, X-Content-Type-Options |
| `cookies` | `evidence/home-cookies.json` | 4 GA cookies inspected (_ga, _gat, _gid, _ga_V4DZ9TE0NV) |
| `trackers` | `evidence/home-trackers.json` | 5 origins, 4 third-party tracker domains identified |
| `secrets` | `evidence/home-secrets.json` | 0 leaked sensitive keys, 3 external scripts scanned |
| `features` | `evidence/home-features.json` | 589 CSS rules scanned; @view-transition, field-sizing, text-wrap-mode detected |
| `screenshot` (light) | `evidence/home-desktop.png` | 1280x900 viewport capture |
| `screenshot` (dark) | `evidence/home-dark.png` | Emulated `prefers-color-scheme: dark` |
| `axe` | `evidence/home-axe.json` | Accessibility tree inspection |
| `console` | `evidence/home-console.json` | Permissions-Policy unrecognized feature warnings |
| `har` | `evidence/home-har.json` | Full network stream |
| `discoverability` | `evidence/home-discoverability.json` | Crawler vs rendered DOM analysis and screenshots |
| `resilience` | `evidence/home-resilience.json` | Offline reload capture (`home-resilience-offline.png`) |
| `dom` | `evidence/home-dom.json` | Full DOM and computed style inspection |
| `layout` | `evidence/home-layout.json` | Layout bounds and container sizing |
| `a11ytree` | `evidence/home-a11ytree.json` | Accessibility tree node census |
| `heap` | `evidence/home-heap.json` | V8 heap size and memory allocations |
| `targets` | `evidence/home-targets.json` | WCAG 2.2 pointer target size analysis |
| `images` | `evidence/home-images.json` | Image formats and dimensions check |
| `trace` | `evidence/home-trace.json` | Performance timeline, 27,016 events, FCP 468.8ms, LCP 627.9ms |

Process hygiene: Every primitive closed its Chrome instance immediately; 0 orphaned Chrome processes remained.

---

## 3. Dedicated Probe of Changed & Reversed Guidance (CSP & Security)

Under `modern-web-guidance@0.0.193` and `knowledge/principles.json` (lines 723, 760), security guidance explicitly mandates:
- `object-src 'none'` to eliminate plugin/Flash execution vectors.
- `frame-ancestors 'self'` (or `'none'`) for clickjacking mitigation, obsoleting legacy `X-Frame-Options`.
- `base-uri 'self'` to block `<base href>` injection.
- `require-trusted-types-for 'script'` in Content-Security-Policy to enforce Trusted Types against DOM XSS.
- Rejection of `'unsafe-inline'` in `script-src` in favor of nonces or hashes.
- Enforcement of `Secure` on all HTTPS cookies, and `HttpOnly` specifically for auth/session cookies (principles.json:722-723).

Artifact: `evidence-out/web-uplift-24o/csp-evaluation-0.0.193.json`

Observed Results on `https://paul.kinlan.me/`:
1. `object-src 'none'`: **PASS**. Observed directive matches 0.0.193 requirement.
2. `frame-ancestors 'self'`: **PASS**. Observed directive supersedes missing `X-Frame-Options` per 0.0.193.
3. `base-uri 'self'`: **PASS**. Verified present.
4. `require-trusted-types-for 'script'`: **FINDING (F18)**. Header omits mandatory Trusted Types enforcement directive (principles.json:723, 760); DOM sinks remain unconstrained. Flagged as an issue under both `secure-transport-and-headers` and `defensive-browser-policies`.
5. `script-src`: **FINDING (F18)**. Contains `'unsafe-inline'` and host allowlists (`googletagmanager.com`, `google-analytics.com`, `cdn.commento.io`).
6. Cookie security: **FINDING (F18)**. All 4 Google Analytics cookies lack the `Secure` attribute. `HttpOnly` is not expected for these tracking cookies since client-side analytics scripts require DOM access.

---

## 4. Coverage Validation & Scorecard

### Coverage Validation
Command:
```bash
node schema/validate-report.mjs knowledge/principles.json reports/paul_kinlan_me/2026-10-08T14-10-00-000Z/report.json
```
Output:
```json
{
  "expected": 58,
  "recorded": 58,
  "judged": 58,
  "blocked": 0,
  "notRun": 0,
  "missing": 0,
  "unknown": 0,
  "duplicates": 0,
  "complete": true,
  "errors": 0
}
```
Confirmed: `coverage.catalogVersion` is exactly `modern-web-guidance@0.0.193`, catalogChecksum is `sha256:0ee674454bf37eda807a9bf76d9ec03a8cffbe1a9ceb7173069f8d239cc44efe`.

### Scorecard
Command:
```bash
node aggregate/scorecard.mjs paul_kinlan_me
```
Output:
```
Overall: 81/100 (needs work)

Speed & Stability      65  #######...  needs work
Memory Health         100  ##########  good
Usability & UX         77  ########..  needs work
Inclusivity & Reach    77  ########..  needs work
Discoverability & AI   95  ##########  good
Trust & Resilience     71  #######...  needs work
```
Published artifacts:
- `reports/paul_kinlan_me/scorecard.html` (270 KB interactive HTML)
- `reports/paul_kinlan_me/scorecard.json`

### Run-to-Run Comparison
Command:
```bash
node aggregate/compare.mjs paul_kinlan_me
```
Output:
- Before: `2026-10-06T13-17-07-499Z` (26 findings, 0 unconcluded)
- After: `2026-10-08T14-10-00-000Z` (26 findings, 0 unconcluded)
- Resolved: 0 | New: 0 | Persisting: 26
- Paired screenshots: 3 pairs with both before and after paths matched in `compare.json` (rendered homepage, crawler view, and desktop light viewport), plus 2 after-only captures (emulated dark mode and offline reload resilience). All 5 captured images are preserved under `evidence-out/web-uplift-24o/evidence/` with self-contained links in `evidence-out/web-uplift-24o/compare.md`.

---

## 5. Explicitly Unverified Items

1. **Fix Application (`--fix`)**: Modifying source code was not performed because `https://paul.kinlan.me/` is an external production site without local write access (conforming to repository permissions and the parked guard established in `web-uplift-ies`).
2. **Headless Agent Runner Sandbox**: The audit was driven directly using the in-session SKILL.md evidence primitives rather than `runner/run-batch.mjs --agent pi/claude` to guarantee zero runner-vs-reaper race conditions and prevent uncontained scratch escapes.
