# Modern Web Guidance

web-uplift uses [Modern Web Guidance](https://developer.chrome.com/docs/modern-web-guidance/)
as the how-to layer for critique and fixes.

The principles in [principles.json](principles.json) define the outcomes a site
should satisfy. Modern Web Guidance provides the current recommended techniques
for satisfying those outcomes.

## Feed

Modern Web Guidance ships as the `modern-web-guidance` npm package. The audit
skill queries it with `npx`; there is no local feed to build or bundle.

The commands below name the version pinned in [principles.json](principles.json)
as `guidanceCatalogVersion` (see [Version Pinning](#version-pinning)), never
`@latest`: an unpinned resolution has no lockfile entry and no integrity check,
so it would make audits irreproducible and let a compromised publish run on the
audit host. `--ignore-scripts` keeps the fetched package's install scripts from
running, which is the part of the exposure that needs no luck at all.

```sh
# List every guide.
npx -y --ignore-scripts modern-web-guidance@0.0.193 list

# Semantic search.
npx -y --ignore-scripts modern-web-guidance@0.0.193 search "dark mode prefers-color-scheme"

# Retrieve a full guide by id.
npx -y --ignore-scripts modern-web-guidance@0.0.193 retrieve "dark-mode"
```

`search` returns entries shaped like:

```json
{
  "id": "dark-mode",
  "description": "Implement dark mode support in a way that respects the user's light/dark theme preference and adapts browser UI (e.g. scrollbars, form controls, etc)",
  "category": "visual-design",
  "featuresUsed": [
    "color-scheme",
    "prefers-color-scheme media query",
    "light-dark()",
    "light-dark() image values",
    "image()",
    "accent-color"
  ],
  "tokenCount": 4509,
  "similarity": 0.6964
}
```

`retrieve` returns the full guide as markdown, including implementation steps,
code examples, and browser-support notes.

## During Audit

Each principle check in [principles.json](principles.json) carries a `guides`
list when Modern Web Guidance has relevant material: ids and/or free-text query
strings. Some checks also carry non-MWG `references` for standards,
methodologies, or optional tools. These are declarative pointers, not tests.

The model consults them up front, before judging, so the bar comes from the
current recommended approach rather than memory:

```sh
npx -y --ignore-scripts modern-web-guidance@0.0.193 retrieve "dark-mode"
npx -y --ignore-scripts modern-web-guidance@0.0.193 search "high contrast prefers-contrast forced colors"
```

Use the result to:

1. Confirm the recommended approach for the use case.
2. Compare it with what the site actually does.
3. Write a finding when the site diverges.
4. Record `findings[].guidanceId` and `findings[].guidanceCategory`.

The model may also search ad hoc for observations that no principle names
directly. The guidance feed is broader than any one principle set.

For checks with `references` but no MWG guides, use the referenced method or
tooling to set the bar. For example, the memory checks point to the
memory-tracer methodology and the optional Chrome DevTools MCP
`memory-leak-debugging` skill. That skill documents a baseline, target and final
snapshot workflow, memlab analysis, and common leak patterns; the repo-native
`heap` primitive remains the default evidence path when MCP is unavailable.

## During Fix Mode

For each task in `taskList`, retrieve the full guide:

```sh
npx -y --ignore-scripts modern-web-guidance@0.0.193 retrieve "<guidanceId>"
```

Apply the guide's technique to the local source, respecting browser-support and
fallback notes. Then re-run the relevant evidence and mark the task verified if
the finding is gone.

## Version Pinning

The pinned feed version lives in `principles.json` as
`guidanceCatalogVersion`, currently `modern-web-guidance@0.0.193`, unless a
project config overrides it with `web-uplift.json`.

Bump the pin deliberately and re-verify the coverage map in
[../docs/principles-analysis.md](../docs/principles-analysis.md).

## Batch Caching

For batch runs, cache `list` once at the start and reuse it. Cache `retrieve`
payloads by guide id. Fall back to `npx --offline` if the network is
unavailable.

This caching layer is not implemented yet; today the model or runner invokes
the feed directly.
