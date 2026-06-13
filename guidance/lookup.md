# Guidance lookup protocol

How the `web-audit` skill queries Modern Web Guidance during an audit. This is
prose+methodology (like the skill itself), not a code module: the feed is the
`modern-web-guidance` npm package and the agent shells out to it.

## During audit (critique)

For each principle check that a path triggers, take the check's
`guidanceQuery` (from `principles/principles.json`) and run:

```sh
npx -y modern-web-guidance@latest search "<guidanceQuery>" \
  --skill-version 2026_05_16-c5e7870
```

Use the top result(s) to:

1. Confirm what the *recommended modern approach* for this use case is.
2. Compare it against what the site actually does (from the DevTools
   snapshot, computed styles, and emulated-condition behaviour).
3. If they diverge, write a finding and record the guidance `id` in
   `findings[].guidanceId` and its `category` in `guidanceCategory`.

You can also search ad hoc for anything you observe that is not covered by a
principle check (e.g. a heavy custom date picker, a scroll-jacking hero). The
guidance feed is broader than the five principles; let it surface
improvements the principles do not name.

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
