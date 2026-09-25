# Baseline Oracle Research and Specification (bead dwg)

**Date:** 2026-09-25
**Bead:** `web-uplift-dwg` "no Baseline oracle: fix mode decides browser support from model memory"
**Lane:** `uplift-gemini` (gemini-3.8-flash), worktree `/home/paulkinlan/worktrees/uplift-gemini-dwg`
**Subject:** Integration of `web-features` as the deterministic Baseline support oracle

---

## 1. Problem Statement

In `SKILL.md` (section 7, fix mode), the model is instructed to:
> "assume Baseline Widely available is safe; follow the guide's fallback advice otherwise, unless `web-uplift.json` states a custom policy".

Currently, nothing in `web-uplift` provides a live Baseline support query mechanism. Modern Web Guidance (`modern-web-guidance@0.0.172`) offers qualitative best practices, but it is not an executable or queryable support oracle for all web platform features.

As a result, the single decision determining whether a proposed fix is safe to ship (or requires a mandatory fallback like `light-dark()`) relies completely on the LLM's parametric memory. Model memory is notoriously prone to hallucination, temporal distortion, and rapid obsolescence. Features transition across status boundaries over time (e.g. from limited to newly available, or newly available to widely available after 30 months), making memory an unreliable oracle for reproducible audits and fixes.

---

## 2. Package Evaluation: `web-features`

The canonical registry for Baseline statuses across the web platform is `web-features` (managed by the WebDX Community Group and W3C):
- **Package:** `web-features` (currently `3.40.0`).
- **Dependencies:** 0 runtime dependencies.
- **Payload:** 411 KB compressed tarball, ~4.8 MB unpacked (primarily `data.json`).
- **Performance:** In Node.js 24, parsing `data.json` requires ~32ms and consumes ~23 MB heap memory. Cold execution time via CLI is under 60ms.

### 2.1 Data Schema

The package exports `features`, a mapping of feature identifiers to feature metadata objects:

```json
{
  "name": "light-dark()",
  "description": "The light-dark() CSS function accepts two colors and uses one depending on the current color scheme.",
  "status": {
    "baseline": "low",
    "baseline_low_date": "2024-05-13",
    "support": {
      "chrome": "123",
      "chrome_android": "123",
      "edge": "123",
      "firefox": "120",
      "firefox_android": "120",
      "safari": "17.5",
      "safari_ios": "17.5"
    }
  },
  "compat_features": [
    "css.types.color.light-dark"
  ],
  "kind": "feature"
}
```

Key observations:
1. `status.baseline`:
   - `"high"`: Baseline Widely available (supported across major engines for at least 30 months). Includes `baseline_low_date` and `baseline_high_date`.
   - `"low"`: Baseline Newly available (supported across major engines, but less than 30 months). Includes `baseline_low_date`.
   - `false`: Limited availability (missing in one or more core engines).
2. Aliases and redirects: 12 entries have `kind: "moved"` or `kind: "redirect_target"` without a `name`, pointing to canonical feature IDs via `redirect_target` or `redirect_targets` (e.g. `masonry` -> `grid-lanes`). The lookup engine must resolve redirects automatically.
3. BCD Compat keys: 15,487 `compat_features` entries connect feature IDs to exact browser-compat-data identifiers (such as `css.properties.color-scheme`, `css.types.color.light-dark`, `html.elements.dialog`).

---

## 3. Architecture and Implementation Design

### 3.1 Module & CLI: `knowledge/baseline.mjs`

A lightweight module and CLI providing:
1. Exact feature ID lookup (e.g. `anchor-positioning`, `light-dark`, `subgrid`).
2. Alias/redirect resolution.
3. Compat-key index (e.g. `css.properties.position-anchor` or `position-anchor`).
4. Human-readable name match (case-insensitive).
5. Substring / fuzzy keyword search across IDs and descriptions.

#### CLI Interface
```bash
# Query status by feature ID or keyword
node knowledge/baseline.mjs light-dark
# Output:
# light-dark: Baseline Newly available (since 2024-05-13)
# Chrome 123 | Firefox 120 | Safari 17.5 | Edge 123
# Fallback: MANDATORY (not yet Widely available)

# JSON output for programmatic integration
node knowledge/baseline.mjs light-dark --json
```

Also expose via the main CLI in `bin/web-uplift.mjs`:
```bash
web-uplift baseline <feature-query>
```

### 3.2 Version Pinning

To guarantee reproducibility:
1. Pin `web-features` in `package.json` dependencies:
   `"web-features": "3.40.0"`.
2. Add catalog pin to `knowledge/principles.json`:
   `"baselineCatalogVersion": "web-features@3.40.0"`.
3. Record `baselineCatalogVersion` in `report.json` under `coverage`.

### 3.3 Findings Schema Extension (`schema/findings.schema.json`)

Extend the finding object definition with an optional `baseline` object:

```json
"baseline": {
  "type": "object",
  "description": "Baseline status of any modern web platform API proposed in suggestedFix.",
  "required": ["featureId", "status"],
  "properties": {
    "featureId": { "type": "string" },
    "featureName": { "type": "string" },
    "status": {
      "type": "string",
      "enum": ["widely", "newly", "limited"]
    },
    "lowDate": { "type": "string", "format": "date" },
    "highDate": { "type": "string", "format": "date" },
    "fallbackMandatory": { "type": "boolean" }
  }
}
```

### 3.4 Integration into `SKILL.md`

Update `SKILL.md` Section 7 (Fix Mode):
- Replace the instruction to guess Baseline status from memory.
- Instruct agents:
  > Before proposing or writing a modern CSS/JS feature in a fix, run:
  > `node knowledge/baseline.mjs <feature>` (or `npx web-uplift baseline <feature>`).
  > - If `widely`: safe to use directly across all modern browsers.
  > - If `newly` or `limited`: a fallback pattern (such as `@supports`, `prefers-*` media queries, or feature detection) is MANDATORY. State the Baseline status and availability date in the fix summary and report findings.

---

## 4. Verification and Test Plan

1. **Unit tests (`tests/baseline.test.mjs`):**
   - Exact ID lookups (`color-scheme`, `light-dark`, `subgrid`).
   - Suffix/compat lookups (`position-anchor` -> `anchor-positioning`).
   - Redirect resolution (`masonry` -> `grid-lanes`).
   - Unrecognized queries handled gracefully with suggested near-matches.
2. **Schema validation:**
   - Validate reports containing `baseline` annotations against `schema/findings.schema.json`.
3. **House rules audit:**
   - Confirm zero em dashes in documentation and CLI output.
   - Confirm ESM imports and no Node `Buffer` usage.
