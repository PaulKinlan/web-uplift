# Modern Web Guidance Catalog

This directory contains `mwg-catalog.json`, a machine-readable enumeration of every guide in Modern Web Guidance retrieved directly from the published npm package (`modern-web-guidance`).

## Current Snapshot

- **Source:** `modern-web-guidance`
- **Published version:** `0.0.193`
- **Total guides:** 177
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

While the package CLI `list` command outputs `id`, `category`, and `description`, the package entry point (`skills/modern-web-guidance/modern-web.mjs`) contains the full `USE_CASES` array which additionally includes `featuresUsed` and `tokenCount`.

To regenerate `knowledge/mwg-catalog.json` from the latest published package:

```sh
node -e '
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ver = process.argv[1] || cp.execSync("npm view modern-web-guidance version", { encoding: "utf8" }).trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mwg-"));
try {
  cp.execSync(`npm pack modern-web-guidance@${ver}`, { cwd: tmp, stdio: "ignore" });
  const tgz = fs.readdirSync(tmp).find(f => f.endsWith(".tgz"));
  cp.execSync(`tar -xzf ${tgz} package/skills/modern-web-guidance/modern-web.mjs`, { cwd: tmp });
  const src = fs.readFileSync(path.join(tmp, "package/skills/modern-web-guidance/modern-web.mjs"), "utf8");
  const match = src.match(/var USE_CASES = (\[[\s\S]*?\n\];)/);
  const list = eval(match[1]);
  const catalog = {
    source: "modern-web-guidance",
    version: ver,
    retrievedAt: new Date().toISOString(),
    regenerate: "See the \"How to Regenerate\" node extraction script in knowledge/mwg-catalog.md (extracts the USE_CASES table from the package's skills/modern-web-guidance/modern-web.mjs; the CLI `list` command does not emit featuresUsed/tokenCount)",
    guideCount: list.length,
    comment: `Catalog extracted from modern-web-guidance@${ver}. The package CLI list command outputs id, category, and description; the package USE_CASES table additionally provides featuresUsed and tokenCount.`,
    guides: list.map(g => ({
      id: g.id,
      category: g.category,
      description: g.description,
      featuresUsed: g.featuresUsed,
      tokenCount: g.tokenCount
    }))
  };
  fs.writeFileSync("knowledge/mwg-catalog.json", JSON.stringify(catalog, null, 2) + "\n");
  console.log(`Wrote ${list.length} guides for modern-web-guidance@${ver} to knowledge/mwg-catalog.json`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
'
```
