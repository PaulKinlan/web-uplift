# Modern Web UX Playground

Six labelled modern-UX scenarios, each tied to a principle from
[knowledge/principles.json](../knowledge/principles.json) and a Modern Web
Guidance use case:

| Scenario | Principle | Technique demonstrated | Inspect under |
|---|---|---|---|
| `#fixed-layout` | adapt-to-the-form-factor | fluid `width: 100%; max-width` + `box-sizing` | narrow viewport, no overflow |
| `#no-dark-mode` | respect-user-preferences | `color-scheme` + `light-dark()` | `prefers-color-scheme: dark` |
| `#poor-focus` | adapt-to-the-form-factor | `:focus-visible` outline, WCAG-contrast buttons | keyboard-only Tab |
| `#layout-shift` | be-fast-and-stable | reserved `min-height` (no CLS) | watch content stay put on load |
| `#motion` | respect-user-preferences | `@media (prefers-reduced-motion: no-preference)` gate | `prefers-reduced-motion: reduce` |
| `#no-container-queries` | adapt-to-the-form-factor | `container-type` + `@container` | same card in wide vs narrow slot |

**This playground is genuinely correct by default.** Each scenario ships the
Modern Web Guidance technique in its default ("issue") stylesheet, so an audit
of `http://localhost:8080` finds **zero** seeded modern-UX issues, and the
page-level `index.html` carries a `color-scheme` meta, a meta description, and a
favicon. `?mode=fixed` runs an equivalent corrected stylesheet (kept as a parity
check). Each scenario still carries its principle id, principle check id, and a
`guidanceQuery` in source so its technique is traceable.

```sh
npm run playground   # http://localhost:8080
```

## Where the seeded issues went (the eval)

The deliberately-broken versions of these scenarios are preserved as the eval
ground truth in
[eval/fixtures/seeded-issues/](../eval/fixtures/seeded-issues/). That frozen
fixture is what proves the auditor's recall: a correct audit of the fixture
surfaces all nine findings (F-001..F-009), and a correct audit of this live
playground surfaces none of them. See [eval/README.md](../eval/README.md).

## Demo script (live)

1. Audit the eval fixture and watch the model surface the nine seeded findings:
   `/web-audit http://localhost:8080 --expected eval/fixtures/seeded-issues/expected-findings.json`
   (serve `eval/fixtures/seeded-issues/site` on `:8080`).
2. Audit this live playground and watch it report zero seeded findings - the
   genuinely-fixed product.
