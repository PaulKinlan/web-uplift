# web-uplift — Copilot custom instructions

This repo is a fully agentic modern-web quality auditor. There is no
deterministic check runner and no fast path: the model (you) is the auditor.

## Auditing a URL

When asked to web-audit, UX-audit, uplift, modernise, or quality-audit a site,
follow the canonical methodology in
[`.claude/skills/web-audit/SKILL.md`](../.claude/skills/web-audit/SKILL.md)
exactly. That one file is the single source of truth for every agent; do not
reimplement it here. A ready-made prompt lives in
[`.github/prompts/web-audit.prompt.md`](prompts/web-audit.prompt.md).

## How you see the page (no MCP needed)

Gather evidence with the repo's generic, judgement-free CLI — plain shell
commands, no browser-automation MCP server required:

```sh
node evidence/cli.mjs <screenshot|video|heap|layout|dom|evaluate> <url> [options]
```

Options you choose at inspection time: `--emulate-media k=v,..`, `--viewport WxH`,
`--selector <css>`, `--interact "<js>"`, `--expr "<js>"`, `--source <dir>`,
`--wait <ms>`, `--out <path>`. You may also run any tool you judge useful, e.g.
`npx -y lighthouse <url> --output=json --quiet` and axe-core injected via the
`evaluate` primitive. Query Modern Web Guidance with
`npx -y modern-web-guidance@latest search "<query>"` / `retrieve "<id>"`.

## Knowledge layers

- Principles (the spec, as outcomes): [`knowledge/principles.json`](../knowledge/principles.json)
- Guidance (the how): the `modern-web-guidance` npm feed; see [`knowledge/guidance.md`](../knowledge/guidance.md)
- Findings schema: [`schema/findings.schema.json`](../schema/findings.schema.json)

## House rules

- Raw CDP only (chrome-remote-interface); never add Playwright or Puppeteer.
- ESM only; no Node `Buffer` (use `TextEncoder`/`Uint8Array`/`atob`/`btoa`).
- No em dashes in prose.
- Write `report.json` (valid against the schema) and `report.md` to the report
  directory, recording the `evidenceUsed` so the method stays honest.

<!-- web-uplift:install -->
## web-uplift

Audit a URL for modern web quality by following `.web-uplift/skill/SKILL.md`. Gather evidence with `node .web-uplift/evidence/cli.mjs <primitive> <url>`.
