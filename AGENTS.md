# AGENTS.md — web-uplift

Guidance for any coding agent that reads `AGENTS.md` (Codex, opencode, and
others). This repo is a fully agentic modern-web quality auditor: the model
(you) is the auditor. There is no deterministic check runner and no fast path.

## The one canonical skill

When asked to web-audit, UX-audit, uplift, modernise, or quality-audit a site,
read [`.claude/skills/web-audit/SKILL.md`](.claude/skills/web-audit/SKILL.md) and
follow it exactly. That single file is the source of truth for every agent
(Claude Code, Codex, Gemini CLI, Antigravity, GitHub Copilot, opencode, ...).
Do not reimplement the methodology; every per-agent entry point just points
here so it cannot drift.

Run as the slash command where available (`/web-audit <url>`), or use the raw
prompt in any agent:

> Read the file .claude/skills/web-audit/SKILL.md and follow its instructions
> exactly, with these arguments: <url>

## How you see the page (no MCP required)

Evidence is gathered with a plain Node CLI over raw Chrome DevTools Protocol
(chrome-remote-interface) — no browser-automation MCP server, no Playwright, no
Puppeteer:

```sh
node evidence/cli.mjs <screenshot|video|heap|layout|dom|evaluate> <url> [options]
```

You choose the conditions and tools at inspection time: `--emulate-media k=v,..`,
`--viewport WxH`, `--selector`, `--interact`, `--expr`, `--source`, `--out`. You
may also run `npx -y lighthouse ...`, inject axe-core via the `evaluate`
primitive, or write your own probes. Query Modern Web Guidance with
`npx -y modern-web-guidance@latest search "<query>"` / `retrieve "<id>"`.

The only host requirements: Node, `google-chrome-stable` (override `CHROME_BIN`),
`ffmpeg` (for the video primitive), and network access for `npx`.

## Knowledge layers

- Principles (spec, as outcomes): [`principles/principles.json`](principles/principles.json)
- Guidance (the how): the `modern-web-guidance` feed; [`guidance/lookup.md`](guidance/lookup.md)
- Findings schema: [`schema/findings.schema.json`](schema/findings.schema.json)
- Eval ground truth: [`eval/README.md`](eval/README.md)

## House rules

- Raw CDP only; never add Playwright or Puppeteer.
- ESM only; no Node `Buffer` (use `TextEncoder`/`Uint8Array`/`atob`/`btoa`).
- No em dashes in prose.
- Write `report.json` (valid against the schema) and `report.md`, recording the
  `evidenceUsed`.

## Codex specifics

`.codex/config.toml` registers only the optional `web-uplift` skills server
(SKILL.md distribution; not a browser). `.codex/skills/web-audit` symlinks the
canonical skill so `/web-audit` works. The `workspace-write` sandbox keeps file
edits inside the repo.

## opencode specifics

`.opencode/command/web-audit.md` is the `/web-audit` command (it points here and
at the skill). opencode also reads this `AGENTS.md` for project context.
