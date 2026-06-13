# Eval: seeded-issues fixture

This directory holds the eval ground truth for the agentic audit, kept
deliberately separate from the live product so the two never get confused.

```
eval/
  fixtures/
    seeded-issues/
      site/                  A frozen copy of the playground with all nine
                             modern-UX issues left broken (the ground truth).
      expected-findings.json The nine findings F-001..F-009 a correct audit
                             of site/ must surface.
```

## Why a separate fixture

The playground used to be both the demo and the eval subject: its issues were
the ground truth that proves the auditor's recall. But we also want the
playground to be a genuinely correct, exemplary modern site. Those two goals
conflict in one directory, so we split them:

- **`eval/fixtures/seeded-issues/site/`** is the frozen eval subject. Its issues
  stay broken on purpose. A correct audit of it surfaces **9** findings
  (F-001..F-009): six seeded CSS scenarios plus three page-level
  Lighthouse-dimension findings (button contrast, missing meta description,
  console 404). This is the recall ground truth.
- **`playground/`** (repo root) is the genuinely-fixed product. Each scenario
  ships its Modern Web Guidance technique by default and the page-level issues
  are fixed, so a correct audit surfaces **0** seeded findings. This is the
  false-positive / regression guard.

Same auditor, two subjects: the fixture proves it catches real issues (recall),
the live playground proves it does not invent them (precision).

## Running the eval

Serve the fixture and audit it, scoring against the ground truth:

```sh
# Ground truth: expect 9 findings.
npx -y serve eval/fixtures/seeded-issues/site -l 8090
/web-audit http://localhost:8090 --expected eval/fixtures/seeded-issues/expected-findings.json

# Product guard: expect 0 seeded findings.
npm run playground   # serves playground/ on :8080
/web-audit http://localhost:8080
```

The committed real run of both is in
[examples/playground-report.md](../examples/playground-report.md) (fixture, 9
findings, 100% recall) and
[examples/playground-report-fixed.md](../examples/playground-report-fixed.md)
(live playground, 0 findings).

## Last verified run (2026-06-13, headless Chrome over raw CDP)

| Check | Fixture (`:8090`) | Live playground (`:8080`) |
|---|---|---|
| `.ndm-card` bg under dark | rgb(255,255,255) | rgb(30,30,30) |
| overflow @360px | 1158px | 0px (shell collapses below 640px) |
| running anims under reduce | 1 | 0 |
| focused `.pf-btn` outline-style | none | solid |
| narrow `.cq-card` flex-direction | row | column |
| CLS (late banner) | 0.0118 | 0.0041 |
| meta description | absent | present |
| axe color-contrast violations | 1 (serious, 3 nodes) | 0 |
| Lighthouse a11y / bp / seo / perf | 91 / 96 / 90 / 100 | 100 / 100 / 100 / 100 |
| **seeded findings** | **9** | **0** |

### Re-baseline for the expanded 15-principle set (2026-06-13)

The principle set grew from 9 to 15 ([docs/principles-analysis.md](../docs/principles-analysis.md),
adopted). The fixture was re-audited under the wider set. Result: the seeded
ground truth stays at **9** (only change: F-007's principle id moved
`be-accessible` -> `be-inclusive` after the rename; F-009's guidance id moved off
the now-narrowed security framing). No net-new fixture finding was added,
because the only new-principle observations on the served site (no CSP header; a
client-rendered no-JS shell) are properties of the bare `npx serve` host and the
demo harness and are present identically on the genuinely-fixed live playground
- so they are reported as contextual `not-applicable` / `opted-out` (see
`expectedPrincipleOutcomes` in
[expected-findings.json](fixtures/seeded-issues/expected-findings.json)) rather
than counted as issues. This keeps recall meaningful and the precision guard
honest.
