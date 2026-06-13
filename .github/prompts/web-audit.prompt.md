---
mode: agent
description: "Audit a URL for modern web quality, fully agentically: gather multi-modal evidence via raw-CDP primitives, choose your own tools, reason, and judge every principle (Una's five + the Lighthouse dimensions) against Modern Web Guidance; --fix to hill-climb."
---

Read the file `.claude/skills/web-audit/SKILL.md` and follow its instructions
exactly, with these arguments: ${input:args:URL plus optional flags, e.g. http://localhost:8080 --out reports/site}

Notes for this run:

- This is a FULLY AGENTIC audit. You are the auditor; there is no deterministic
  check runner and no fast path.
- Gather evidence with the repo's plain-shell CLI (no MCP server needed):
  `node evidence/cli.mjs <primitive> <url> [options]`. Choose your own tools
  (Lighthouse, axe via the `evaluate` primitive, your own probes).
- Cite Modern Web Guidance ids via `npx -y modern-web-guidance@latest search`.
- Write `report.json` (valid against `schema/findings.schema.json`) and
  `report.md`, recording `evidenceUsed`.
