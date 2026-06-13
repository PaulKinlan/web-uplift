# Knowledge layer: Modern Web Guidance

The knowledge layer is [Modern Web Guidance](https://developer.chrome.com/docs/modern-web-guidance/)
(repo: https://github.com/GoogleChrome/modern-web-guidance): use-case-based
best practices for the modern web. web-uplift uses it two ways:

- **To critique** a site: find where the site diverges from the recommended
  modern approach for a use case (e.g. it ships a custom JS modal where the
  guidance recommends the platform `<dialog>` / popover).
- **To fix** a site: the guidance *is* the how-to. A finding cites a guidance
  `id`; fix mode retrieves that guide and applies the technique.

This is deliberately the inverse of hard-coding hundreds of rules. The source
of truth lives in the feed; web-uplift queries it.

## There is a machine-readable feed (resolved open question)

The original plan flagged "feed vs scrape developer.chrome.com" as an open
question. It is resolved: **Modern Web Guidance ships as the
`modern-web-guidance` npm package**, a machine-readable feed with three
commands. No install is required; it runs via `npx`.

```sh
# List every guide (id, category, description). ~137 guides as of writing.
npx -y modern-web-guidance@latest list

# Semantic search: action-oriented query -> ranked guides with similarity.
npx -y modern-web-guidance@latest search "dark mode prefers-color-scheme" \
  --skill-version 2026_05_16-c5e7870

# Retrieve the full markdown guide(s) by id (comma-separated for several).
npx -y modern-web-guidance@latest retrieve "dark-mode"
```

`search` returns entries shaped like:

```json
{
  "id": "dark-mode",
  "description": "Implement dark mode support in a way that respects the user's light/dark theme preference and adapts browser UI",
  "category": "user-experience",
  "featuresUsed": ["color-scheme", "prefers-color-scheme media query", "light-dark()", "accent-color"],
  "tokenCount": 4123,
  "similarity": 0.6964
}
```

`retrieve` returns the full guide as markdown (implementation steps, code,
and browser-support / fallback notes).

## How the skill queries it

See [lookup.md](lookup.md) for the step-by-step query protocol the
`web-audit` skill follows (consult the mapped guides up front to set the bar,
retrieve the fix detail in fix mode). The principles layer
(`principles/principles.json`) seeds this: each principle check carries a
`guides` LIST of Modern Web Guidance ids and/or free-text query strings used as
`retrieve`/`search` arguments. All 137 catalog guides are mapped across the
checks (see `docs/principles-analysis.md` and `principles/principles.json`'s
`guidanceCatalogVersion`).

## Open questions

- **Version pinning.** `search` takes a `--skill-version` stamp
  (`2026_05_16-c5e7870` at time of writing) that warns when the local
  understanding is stale. We should pin a known-good version per release and
  bump deliberately.
- **Offline / batch caching.** Large batch runs shouldn't hit the network 137
  times. Cache `list` output (and frequently-used `retrieve` payloads) locally
  for the run; `npx --offline` is the fallback. Not yet implemented.
- **Mapping fidelity.** Each principle check now maps to a `guides` list of mwg
  ids (and/or query strings), pinned to `modern-web-guidance@0.0.172`. The ids
  make the mapping concrete and the eval more stable; the query strings keep it
  open to feed evolution. Bump the pin deliberately and re-verify the coverage
  map (none of the 137 guides orphaned).
