---
description: Audit a URL for modern web quality, fully agentically — gather raw-CDP evidence, choose your own tools, judge every principle (Una's five + Lighthouse dimensions) against Modern Web Guidance; --fix to hill-climb.
---

Read the file `.claude/skills/web-audit/SKILL.md` and follow its instructions
exactly, with these arguments: $ARGUMENTS

This is a FULLY AGENTIC audit. You are the auditor; there is no deterministic
check runner and no fast path. Gather evidence with the repo's plain-shell CLI
(no MCP server needed):

```sh
node evidence/cli.mjs <screenshot|video|heap|layout|dom|evaluate> <url> [options]
```

Choose your own tools (Lighthouse via `npx -y lighthouse`, axe-core injected via
the `evaluate` primitive, your own probes). Cite Modern Web Guidance ids via
`npx -y modern-web-guidance@latest search "<query>"`. Write `report.json` (valid
against `schema/findings.schema.json`) and `report.md`, recording `evidenceUsed`.
See [AGENTS.md](../../AGENTS.md) for project rules.
