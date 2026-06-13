# Seeded-issues eval fixture (frozen)

> This is the **eval ground truth**, not the live demo. It is a frozen copy of
> the seeded-issue playground. Its issues are deliberately left broken: a
> correct audit of this site must surface all nine findings in
> [`../expected-findings.json`](../expected-findings.json). The genuinely-fixed,
> correct-by-default version of the playground lives in the repo's top-level
> [`playground/`](../../../../playground/). Do not "fix" anything here. See
> [`eval/README.md`](../../../README.md).

Six deliberately seeded, labelled modern-UX issues, each tied to a principle
from [principles/principles.json](../../../../principles/principles.json) and a
Modern Web Guidance use case:

| Scenario | Principle | Issue | Detectable via |
|---|---|---|---|
| `#fixed-layout` | adapt-to-the-device | hard-coded 1200px width, no responsiveness | narrow viewport -> horizontal overflow |
| `#no-dark-mode` | adapt-to-the-user | hard-coded light theme, no color-scheme | `prefers-color-scheme: dark` |
| `#poor-focus` | adapt-to-the-device | `outline: none`, no focus indicator | keyboard-only Tab |
| `#layout-shift` | adapt-to-the-device | late content with no reserved space (CLS) | watch content jump on load |
| `#motion` | adapt-to-the-user | animates despite reduced-motion preference | `prefers-reduced-motion: reduce` |
| `#no-container-queries` | adapt-to-the-device | component ignores its container size | same card in wide vs narrow slot |

Each scenario carries the principle id, the principle check id, and a
`guidanceQuery` (and, where stable, a guidance `id`) in its source, so the
audit's findings can be scored against the principle and guidance layers.

**Modes:** default is **issue** (the seeded problems). Append `?mode=fixed`
to run the corrected implementations - the audit loop must find *nothing* in
fixed mode (the false-positive check).

```sh
npm run playground   # http://localhost:8080
```

## Demo script (live)

1. Open `http://localhost:8080` in issue mode.
2. Ask the agent: `/web-audit http://localhost:8080`.
3. Watch it: explore the page -> write a test plan with per-condition checks
   (dark, reduced-motion, narrow viewport, keyboard-only) -> emulate each
   condition and compare against the principles + Modern Web Guidance -> report
   each finding with its principle, guidance id, and fix.
4. The payoff: `/web-audit http://localhost:8080 --fix --source playground`,
   or just switch to `?mode=fixed`, re-run the audit, show zero findings.

## As an eval

[expected-findings.json](expected-findings.json) is the ground truth: compare
the audit's `report.json` against it - recall on issue mode, false positives
on fixed mode. See PLAN.md open question #4 on scoring partial matches.
