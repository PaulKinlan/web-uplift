# Running audits

## Interactive (inside each CLI)

From this repo's root, `/web-audit <url>` works in every CLI - each one
discovers it through its own project-config mechanism, all pointing at the
single canonical [SKILL.md](../.claude/skills/web-audit/SKILL.md):

| CLI | Type it as | Wired up via |
|---|---|---|
| Claude Code | `/web-audit http://localhost:8080` | `.claude/skills/web-audit/` (native) |
| Codex | `/web-audit http://localhost:8080` | `.codex/skills/web-audit` - a symlink to the Claude skill (Codex uses the same SKILL.md format) |
| Gemini CLI | `/web-audit http://localhost:8080` | `.gemini/commands/web-audit.toml` (two-line wrapper, `{{args}}`) |
| Antigravity | `/web-audit http://localhost:8080` | `.agents/skills/web-audit.md` (two-line wrapper) |

If you'd rather not use the command, the raw prompt that works in *any*
agent run from the repo root is:

> Read the file .claude/skills/web-audit/SKILL.md and follow its
> instructions exactly, with these arguments: http://localhost:8080

Only the Claude copy is real; the rest are pointers, so the methodology can't
drift between agents. (Windows checkouts may need the Codex symlink replaced
with a copy.)

## Skills over MCP

[mcp/skills-server.mjs](../mcp/skills-server.mjs) additionally distributes
the skill through MCP itself (registered in `.mcp.json`,
`.gemini/settings.json`, `.codex/config.toml` as `web-uplift`), exposing it
two ways:

- **An MCP prompt** - in hosts with prompt discovery this surfaces as a slash
  command with no wrapper file at all: Claude Code shows it as
  `/mcp__web-uplift__web-audit (MCP)`, Gemini CLI similarly; Codex doesn't
  surface MCP prompts yet
  ([openai/codex#8342](https://github.com/openai/codex/issues/8342)).
- **A `skill://web-audit/SKILL.md` resource** - the
  [SEP-2640 Skills Extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640)
  convention from the
  [Skills Over MCP working group](https://modelcontextprotocol.io/community/skills-over-mcp/charter),
  so hosts that adopt skills-over-MCP will auto-discover the skill with zero
  config.

Both read the same canonical SKILL.md at request time, so they can't drift.
The file-based wrappers above remain the most reliable path today; the MCP
route is what makes the skill portable beyond this repo (point any MCP client
at the server and it has the workflow).

# Batch runner

```sh
npm run batch -- https://example.com                       # URLs as arguments
npm run batch -- --urls urls/sample.txt                    # …or from a file (the default file)
npm run batch -- https://example.com --agent gemini        # claude | gemini | antigravity | codex
npm run batch -- --urls urls/top-1k.txt --concurrency 4
npm run batch -- https://example.com --agent codex --dry-run   # print commands only
npm run batch -- https://example.com --verbose                 # stream agent output live
```

(`npm run batch` is `node runner/run-batch.mjs`; everything after `--` is
passed through.) URLs can mix positional arguments and a `--urls` file;
invalid URLs are warned about and skipped, and the runner errors out if it
ends up with none. `--verbose` echoes each spawned command and streams agent
stdout/stderr with a `[site-slug]` prefix per line (`[slug!]` for stderr);
`run.json` is written either way.

The batch runner runs **report mode** only. Fix mode (`--fix --source <dir>`)
is agentic and source-bound, best driven interactively per site; it is
intentionally not a fan-out flag.

Reports land in `reports/<agent>/<site>/`, so running the same URL list
through several agents gives a side-by-side comparison  - 
`aggregate/aggregate.mjs` adds a per-agent breakdown when it sees more than
one. Claude invokes the `/web-audit` skill; the other CLIs are pointed at
[.claude/skills/web-audit/SKILL.md](../.claude/skills/web-audit/SKILL.md)
directly (it's plain markdown instructions any agent can follow).

## Per-agent setup

There is no browser-automation MCP server to register. The agent drives a real
headless Chrome through this repo's own **evidence primitives**
([evidence/cli.mjs](../evidence/cli.mjs), raw CDP via chrome-remote-interface),
which it runs as `node evidence/cli.mjs <primitive> <url> ...`. So each agent
only needs permission to run Node and `npx` (for the Modern Web Guidance feed
and, if it chooses, Lighthouse), and read/write access to the repo.

| Agent | Binary | Headless invocation | Tooling it needs |
|---|---|---|---|
| Claude Code | `claude` | `-p --output-format json --allowedTools …` | `Bash(node:*)`, `Bash(npx:*)`, `Bash(ffmpeg:*)`, file tools (set by the runner) |
| Gemini CLI | `gemini` | `-p --yolo --output-format json` | node + npx + ffmpeg on PATH |
| Antigravity CLI | `agy` | `-p --dangerously-skip-permissions` | node + npx + ffmpeg on PATH |
| Codex CLI | `codex` | `exec --json --sandbox workspace-write` | node + npx + ffmpeg on PATH |

The only MCP server still registered (in `.mcp.json`, `.gemini/settings.json`,
`.codex/config.toml`) is `web-uplift` (the skills server), which distributes the
SKILL.md methodology itself; it is not a browser. The host machine needs
`google-chrome-stable` (override with `CHROME_BIN`) and `ffmpeg` for the video
primitive.

The agent also needs network access to query the Modern Web Guidance feed
(`npx -y modern-web-guidance@latest …`) and, optionally, to run Lighthouse
(`npx -y lighthouse …`). Claude's `--allowedTools` list includes `Bash(npx:*)`
for this.

## Caveats

- **Permissions:** `--yolo` (Gemini) and `--dangerously-skip-permissions`
  (Antigravity) auto-approve *every* tool call. Fine against the playground;
  for batch runs over arbitrary third-party sites, run inside a container or
  VM. Claude's invocation uses a scoped `--allowedTools` list instead. Codex
  uses the `workspace-write` sandbox - if Chrome can't reach the network from
  it, fall back to `--dangerously-bypass-approvals-and-sandbox` inside a
  container.
- **Output:** `run.json` stores raw agent stdout (JSON for claude/gemini,
  JSONL for codex, plain text for antigravity). The contract that matters is
  the same for all agents: `report.json` in the site directory, validating
  against `schema/findings.schema.json`.
- **Gemini CLI sunset:** for individual Pro/Ultra accounts Gemini CLI is
  scheduled to sunset on 2026-06-18 in favour of Antigravity CLI - keep both
  adapters until the dust settles.
- Flags drift fast in all four CLIs; if an invocation fails, `--dry-run`
  shows the exact command to debug.
