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
node -e '
const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const rawVer = process.argv[1] || cp.execSync("npm view modern-web-guidance version", { encoding: "utf8" }).trim();
const ver = rawVer.replace(/^modern-web-guidance@/, "");
const outPath = process.argv[2] || "knowledge/mwg-catalog.json";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mwg-"));
try {
  cp.execSync("npm pack modern-web-guidance@" + ver, { cwd: tmp, stdio: "ignore" });
  const tgz = fs.readdirSync(tmp).find(f => f.endsWith(".tgz"));
  cp.execSync("tar -xzf " + tgz + " package/skills/modern-web-guidance/modern-web.mjs package/skills/modern-web-guidance/guides", { cwd: tmp });
  const src = fs.readFileSync(path.join(tmp, "package/skills/modern-web-guidance/modern-web.mjs"), "utf8");
  const match = src.match(/var USE_CASES = (\[[\s\S]*?\n\];)/);
  const ucList = eval(match[1]);
  const ucMap = new Map(ucList.map(g => [g.id, g]));

  const guidesDir = path.join(tmp, "package/skills/modern-web-guidance/guides");
  const categories = fs.readdirSync(guidesDir).filter(c => fs.statSync(path.join(guidesDir, c)).isDirectory()).sort();

  const fileOnly = [];
  for (const cat of categories) {
    const catDir = path.join(guidesDir, cat);
    const files = fs.readdirSync(catDir).filter(f => f.endsWith(".md")).sort();
    for (const f of files) {
      const id = f.replace(/\.md$/, "");
      if (!ucMap.has(id)) {
        const content = fs.readFileSync(path.join(catDir, f), "utf8");
        let twin = null;
        for (const [otherId, otherG] of ucMap.entries()) {
          if (otherG.category === cat) {
            const otherPath = path.join(guidesDir, cat, otherId + ".md");
            if (fs.existsSync(otherPath) && fs.readFileSync(otherPath, "utf8") === content) {
              twin = otherG;
              break;
            }
          }
        }
        fileOnly.push({
          id,
          category: cat,
          twinId: twin ? twin.id : null,
          description: twin ? twin.description : "",
          featuresUsed: twin ? twin.featuresUsed : [],
          tokenCount: twin ? twin.tokenCount : Math.round(content.length / 3.8)
        });
      }
    }
  }

  const guides = [];
  for (const uc of ucList) {
    guides.push({
      id: uc.id,
      category: uc.category,
      description: uc.description,
      featuresUsed: uc.featuresUsed,
      tokenCount: uc.tokenCount
    });
    for (const fo of fileOnly) {
      if (fo.twinId === uc.id) {
        guides.push({
          id: fo.id,
          category: fo.category,
          description: fo.description,
          featuresUsed: fo.featuresUsed,
          tokenCount: fo.tokenCount
        });
      }
    }
  }

  for (const fo of fileOnly) {
    if (!guides.some(g => g.id === fo.id)) {
      guides.push({
        id: fo.id,
        category: fo.category,
        description: fo.description,
        featuresUsed: fo.featuresUsed,
        tokenCount: fo.tokenCount
      });
    }
  }

  const guideIds = guides.map(g => g.id).sort();
  const guideIdsSha256 = crypto.createHash("sha256").update(guideIds.join("\n")).digest("hex");

  const existingPath = "knowledge/mwg-catalog.json";
  let existing = null;
  try {
    if (fs.existsSync(existingPath)) {
      existing = JSON.parse(fs.readFileSync(existingPath, "utf8"));
    }
  } catch {}
  const retrievedAt = (existing && existing.version === ver && existing.retrievedAt)
    ? existing.retrievedAt
    : new Date().toISOString();

  const catalog = {
    source: "modern-web-guidance",
    version: ver,
    retrievedAt,
    regenerate: "See the \"How to Regenerate\" node extraction script in knowledge/mwg-catalog.md (unions the USE_CASES table from the package\x27s skills/modern-web-guidance/modern-web.mjs with the package guides/*/*.md file enumeration to ensure guides omitted from USE_CASES like prompt-api are included; the CLI `list` command does not emit featuresUsed/tokenCount)",
    guideCount: guides.length,
    guideIds,
    guideIdsSha256,
    comment: "Catalog extracted from modern-web-guidance@" + ver + ". The package CLI list command outputs id, category, and description; the package USE_CASES table and guides file enumeration additionally provide featuresUsed, tokenCount, and unlisted guides (such as prompt-api).",
    guides: guides.map(g => ({
      id: g.id,
      category: g.category,
      description: g.description,
      featuresUsed: g.featuresUsed,
      tokenCount: g.tokenCount
    }))
  };
  fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`Wrote ${guides.length} guides for modern-web-guidance@${ver} to ${outPath}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
' "$@"
```
