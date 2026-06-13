# Guidance lookup protocol

How the `web-audit` skill queries Modern Web Guidance during an audit. This is
prose+methodology (like the skill itself), not a code module: the feed is the
`modern-web-guidance` npm package and the agent shells out to it.

## During audit (critique)

Each principle check in `principles/principles.json` carries a `guides` LIST:
an array of Modern Web Guidance ids and/or free-text query strings. These are
declarative pointers (intent), not tests. Consult them UP FRONT (before judging)
so you set the bar from the current recommended approach. For an id, `retrieve`
it directly; for a query string, `search` it:

```sh
# retrieve a guide by id (the common case now that checks map to mwg ids)
npx -y modern-web-guidance@0.0.172 retrieve "dark-mode"

# or search a free-text pointer
npx -y modern-web-guidance@0.0.172 search "high contrast prefers-contrast forced colors" \
  --skill-version 2026_05_16-c5e7870
```

Pin the catalog version to `principles.json`'s `guidanceCatalogVersion`
(currently `modern-web-guidance@0.0.172`) unless `web-uplift.json` overrides it.

Use the top result(s) to:

1. Confirm what the *recommended modern approach* for this use case is.
2. Compare it against what the site actually does (from the DevTools
   snapshot, computed styles, and emulated-condition behaviour).
3. If they diverge, write a finding and record the guidance `id` in
   `findings[].guidanceId` and its `category` in `guidanceCategory`.

You can also search ad hoc for anything you observe that is not covered by a
principle check (e.g. a heavy custom date picker, a scroll-jacking hero). The
guidance feed is broader than any single principle; let it surface
improvements the principles do not name. (As of the expanded principle set, all
137 catalog guides are mapped to a principle check's `guides` list; an ad-hoc
search is still useful for novel observations and for refining a query.)

Prefer a guidance `id` with high `similarity`. If nothing scores well, run
`list` and browse by `category` (e.g. `user-experience`, `accessibility`,
`performance`, `css`, `forms`).

## During fix mode (how-to)

For each task in the prioritised `taskList`, retrieve the full guide:

```sh
npx -y modern-web-guidance@latest retrieve "<guidanceId>"
```

Apply the technique from the retrieved markdown to the local source, honouring
its browser-support / fallback notes (assume Baseline Widely available is safe;
follow the guide's fallback advice otherwise, unless the project states a
custom browser-support policy). Then re-run the audit for that path and mark
the task `applied` -> `verified` if the finding is gone.

## Caching (batch runs)

For batch runs, cache `list` once at the start and reuse it; cache `retrieve`
payloads per `id`. Fall back to `npx --offline` if the network is unavailable.
Not yet implemented (see guidance/README.md open questions).
