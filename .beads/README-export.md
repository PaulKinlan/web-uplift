# Passive Beads Board Export (`.beads/issues.jsonl`)

## Overview

This repository uses [Beads](https://github.com/gastownhall/beads) for issue tracking. While the Dolt remote database ref (`refs/dolt/data`) is temporarily blocked by GitHub push protection due to a fabricated secret-shaped test fixture in an issue comment, `.beads/issues.jsonl` serves as a **passive export** that travels via ordinary Git.

## Key Invariants

1. **Dolt remains authoritative**: The local Dolt database is the canonical source of truth for beads, comments, labels, and memories.
2. **Passive export only**: `.beads/issues.jsonl` is a snapshot generated from the Dolt database. Do **not** hand-edit this file; any direct edits will be overwritten upon regeneration.
3. **Redaction is mandatory upon regeneration**: Issue `web-uplift-73y3` carries a historical comment documenting secret scanner behaviours that contains a fabricated Stripe live-key-shaped string (`sk_live_...`). Additional comments hold fabricated fixtures for GitHub PATs (`ghp_...`), AWS keys (`AKIA...`), Google API keys (`AIza...`), and GitLab PATs (`glpat-...`). GitHub push protection blocks pushes containing provider-secret-shaped strings matching these patterns. Therefore, **the redaction pass is an integral part of the regeneration workflow**. Running a raw `bd export` and committing it directly will silently re-introduce the blocked patterns and fail Git push.

## Regeneration Workflow

To regenerate `.beads/issues.jsonl`, run the export followed by the redaction pass:

```bash
# 1. Export all issues and memories from Dolt
bd export --all -o .beads/issues.jsonl

# 2. Run the redaction pass to replace provider-secret shapes with safe placeholders
node -e '
import fs from "fs";

let content = fs.readFileSync(".beads/issues.jsonl", "utf8");

const replacements = [
  { pattern: /sk_live_[0-9a-zA-Z]{16,}/g, replacement: "sk_live_REDACTED" },
  { pattern: /sk_test_[0-9a-zA-Z]{16,}/g, replacement: "sk_test_REDACTED" },
  { pattern: /ghp_[0-9a-zA-Z]{16,}/g, replacement: "ghp_REDACTED" },
  { pattern: /github_pat_[0-9a-zA-Z_]{16,}/g, replacement: "github_pat_REDACTED" },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "AKIA_REDACTED" },
  { pattern: /ASIA[0-9A-Z]{16}/g, replacement: "ASIA_REDACTED" },
  { pattern: /wJalrXUtnFEMI\/K7/g, replacement: "AWS_SECRET_REDACTED" },
  { pattern: /xox[baprs]-[0-9a-zA-Z-]{10,}/g, replacement: "xox_REDACTED" },
  { pattern: /AIza[-0-9A-Za-z_]{11,}/g, replacement: "AIza_REDACTED" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED PRIVATE KEY]" },
  { pattern: /glpat-[-0-9a-zA-Z_]{16,}/g, replacement: "glpat_REDACTED" }
];

for (const { pattern, replacement } of replacements) {
  content = content.replace(pattern, replacement);
}

fs.writeFileSync(".beads/issues.jsonl", content, "utf8");
'

# 3. Assert zero secret pattern hits and valid JSON
grep -nE "sk_live_[0-9a-zA-Z]{16,}|sk_test_[0-9a-zA-Z]{16,}|ghp_[0-9a-zA-Z]{16,}|github_pat_[0-9a-zA-Z_]{16,}|(AKIA|ASIA)[0-9A-Z]{16}|xox[baprs]-[0-9a-zA-Z-]{10,}|AIza[-0-9A-Za-z_]{11,}|glpat-[-0-9a-zA-Z_]{16,}" .beads/issues.jsonl && echo "FAIL: secret pattern hit" || echo "PASS: no secret pattern hits"
grep -nE -e "-----BEGIN [A-Z ]*PRIVATE KEY-----" .beads/issues.jsonl && echo "FAIL: private key hit" || echo "PASS: no private key hits"
node -e '
import fs from "fs";
const lines = fs.readFileSync(".beads/issues.jsonl", "utf8").split("\n");
let count = 0;
for (const line of lines) {
  if (!line.trim()) continue;
  JSON.parse(line);
  count++;
}
console.log(`Validated ${count} lines.`);
'
bd import --dry-run .beads/issues.jsonl
```
