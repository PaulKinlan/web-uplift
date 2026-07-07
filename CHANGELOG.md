# Changelog — web-uplift

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
