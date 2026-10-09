# Modern Web Guidance Catalog

This directory contains `mwg-catalog.json`, a machine-readable enumeration of every guide in Modern Web Guidance retrieved directly from the published npm package (`modern-web-guidance`).

## Current Snapshot

- **Source:** `modern-web-guidance`
- **Published version:** `0.0.193`
- **Total guides:** 178
- **Artifact path:** `knowledge/mwg-catalog.json`

## CLI Verification

To list all available guides using the npm package CLI:

```sh
npx -y --ignore-scripts modern-web-guidance@0.0.193 list
```

To retrieve a specific guide in full:

```sh
npx -y --ignore-scripts modern-web-guidance@0.0.193 retrieve "<id>"
```

## How to Regenerate

While the package CLI `list` command outputs `id`, `category`, and `description`, the package entry point (`skills/modern-web-guidance/modern-web.mjs`) contains the `USE_CASES` array which additionally includes `featuresUsed` and `tokenCount`. However, the `USE_CASES` table omits guides (such as `prompt-api`) that are present as guide markdown files in `skills/modern-web-guidance/guides/`.

To ensure complete coverage without dropping unlisted guides, the extraction script below unions the package's `USE_CASES` table with the guide file enumeration (`skills/modern-web-guidance/guides/*/*.md`). It also emits a sorted `guideIds` array and `guideIdsSha256` for set-level divergence checking with consumers such as `mwg-train`.

### Canonical Ordering & Determinism
- **`guides` array order:** Retains the canonical upstream `USE_CASES` order from `skills/modern-web-guidance/modern-web.mjs`. Unlisted guide files (such as `prompt-api`, which is present as a markdown guide file in `guides/built-in-ai/` but omitted from `USE_CASES`) are inserted adjacent to their alias twin in the same category (e.g. `prompt-api` immediately follows `language-model`). Unlisted guides without an identical twin are appended.
- **`guideIds` array order:** Sorted lexicographically in ascending order, serving as a stable set-identity index for cross-project divergence checking with consumers like `mwg-train`.
- **`retrievedAt` timestamp:** When regenerating against the same version as the committed `knowledge/mwg-catalog.json`, the existing `retrievedAt` timestamp is preserved. This guarantees byte-for-byte reproducibility without spurious timestamp diffs or false pin changes when no upstream content has changed.

To regenerate `knowledge/mwg-catalog.json` from the latest published package:

```sh
# 1. Unpack the package (this reads a tarball; it runs no package code).
ver=$(npm view modern-web-guidance version)
tmp=$(mktemp -d)
npm pack modern-web-guidance@"$ver" --pack-destination "$tmp" >/dev/null
tar -xzf "$tmp"/modern-web-guidance-*.tgz -C "$tmp" package/skills/modern-web-guidance

# 2. Build the catalog with the committed generator.
#    It parses the package's USE_CASES table as DATA, never by evaluating it: the table is
#    a literal array (single-quoted strings, comments and a trailing comma are fine), and
#    anything that is not a literal - a call, an operator, an identifier - makes the run
#    fail instead of running. That matters because this package is DOWNLOADED: the recipe
#    this replaces called `eval` on it, so anything shipped inside that array ran with the
#    operator's privileges (web-uplift-w0y).
node tests/mwg-catalog.mjs --package-dir "$tmp/package" --version "$ver" --out knowledge/mwg-catalog.json
rm -rf "$tmp"

# 3. Refresh the artefact hashes the catalog changed, then verify.
node tests/mwg-artefact.mjs update
node tests/mwg-artefact.mjs verify
```

The generator (`tests/mwg-catalog.mjs`) is the single source of truth for the extraction: it
unions the `USE_CASES` table with the guide file enumeration, and `tests/mwg-catalog-extract.mjs`
tests it, including that a table containing an expression is refused without being executed.
The upstream package's own `list` command is not used for the catalog because it omits
`featuresUsed` and `tokenCount`.
