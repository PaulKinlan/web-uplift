# Changelog — web-uplift

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
