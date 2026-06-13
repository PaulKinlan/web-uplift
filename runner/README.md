# Running audits

## Cross-agent support matrix

`web-uplift` is **not Claude-only**. One canonical methodology
([SKILL.md](../.claude/skills/web-audit/SKILL.md)) plus one declarative spec
([principles.json](../principles/principles.json)) plus one generic evidence CLI
([evidence/cli.mjs](../evidence/cli.mjs), plain `node` shell commands over raw
CDP) are all agent-agnostic. Each agent gets only a **thin wrapper** that points
at the same canonical skill, so the methodology cannot drift.

| Agent | Interactive entry point | Headless `--agent` | Status |
|---|---|---|---|
| Claude Code | `.claude/skills/web-audit/` (native skill) | `claude` | wired + real run verified |
| Codex | `.codex/skills/web-audit` -> symlink to the Claude skill; `AGENTS.md` | `codex` | wired (dry-run verified) |
| Gemini CLI | `.gemini/commands/web-audit.toml` (`{{args}}` wrapper) | `gemini` | wired (dry-run verified) |
| Antigravity | `.agents/skills/web-audit.md` (wrapper) | `agy` | wired (dry-run verified) |
| GitHub Copilot | `.github/copilot-instructions.md` + `.github/prompts/web-audit.prompt.md` | `copilot` | wired (dry-run verified) |
| opencode | `.opencode/command/web-audit.md` + `AGENTS.md` + `opencode.json` | `opencode` | wired (dry-run verified) |
| anything else | raw prompt (below) | add one map entry | n/a |

From the repo root, `/web-audit <url>` works in every CLI that surfaces commands
(each discovers it through its own project-config mechanism). The raw prompt that
works in **any** agent, command support or not, is:

> Read the file .claude/skills/web-audit/SKILL.md and follow its
> instructions exactly, with these arguments: http://localhost:8080

Only the Claude copy of the skill is real; the rest are pointers, so the
methodology can't drift between agents. (Windows checkouts may need the Codex
symlink replaced with a copy.)

## How to add an agent (one thin wrapper)

Adding a new agent is deliberately a one-file-plus-one-map-entry job:

1. **Interactive wrapper** - add the file the agent reads for project commands,
   and have it say nothing more than "read `.claude/skills/web-audit/SKILL.md`
   and follow it with these arguments: <args>". Examples already in the repo:
   a Gemini `.toml`, an Antigravity `.md`, a Copilot prompt file, an opencode
   command file, a Codex symlink. Never copy the methodology - point at it.
2. **Headless entry** - add one entry to the `AGENTS` map in
   [run-batch.mjs](run-batch.mjs): `{ bin, prompt, args }`, where `prompt` is
   `slashPrompt` (if the agent has the slash command) or `skillPrompt` (the raw
   prompt), and `args` returns the agent's headless CLI flags. That single entry
   is the entire batch integration.
3. **Verify** with `node runner/run-batch.mjs <url> --agent <new> --dry-run`.

No MCP server, no browser automation, no per-principle wiring is needed: the
agent only has to run shell (`node evidence/cli.mjs ...`) and read the skill.

## Skills over MCP (optional)

This layer is **optional** - it adds nothing the file wrappers and the evidence
CLI don't already provide; it just distributes the skill to MCP-aware hosts.
[mcp/skills-server.mjs](../mcp/skills-server.mjs) distributes the skill through
MCP itself (registered in `.mcp.json`, `.gemini/settings.json`,
`.codex/config.toml`, `opencode.json` as `web-uplift`), exposing it two ways:

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
npm run batch -- https://example.com --agent gemini        # claude | codex | gemini | antigravity | copilot | opencode
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

**No MCP server is required, and there is no browser-automation MCP anywhere.**
The agent drives a real headless Chrome through this repo's own **evidence
primitives** ([evidence/cli.mjs](../evidence/cli.mjs), raw CDP via
chrome-remote-interface), which it runs as `node evidence/cli.mjs <primitive>
<url> ...`. So each agent only needs permission to run Node and `npx` (for the
Modern Web Guidance feed and, if it chooses, Lighthouse), and read/write access
to the repo.

| Agent | Binary | Headless invocation | Tooling it needs |
|---|---|---|---|
| Claude Code | `claude` | `-p --output-format json --allowedTools …` | `Bash(node:*)`, `Bash(npx:*)`, `Bash(ffmpeg:*)`, file tools (set by the runner) |
| Codex CLI | `codex` | `exec --json --sandbox workspace-write` | node + npx + ffmpeg on PATH |
| Gemini CLI | `gemini` | `-p --yolo --output-format json` | node + npx + ffmpeg on PATH |
| Antigravity CLI | `agy` | `-p --dangerously-skip-permissions` | node + npx + ffmpeg on PATH |
| GitHub Copilot | `copilot` | `-p --allow-all-tools` | node + npx + ffmpeg on PATH |
| opencode | `opencode` | `run <prompt>` | node + npx + ffmpeg on PATH |

The `web-uplift` MCP server (registered in `.mcp.json`, `.gemini/settings.json`,
`.codex/config.toml`, `opencode.json`) is **optional**: it only distributes the
SKILL.md methodology to MCP-aware hosts as a convenience, it is not a browser,
and the audit works fine with it disabled. The host machine needs
`google-chrome-stable` (override with `CHROME_BIN`) and `ffmpeg` for the video
primitive.

The agent also needs network access to query the Modern Web Guidance feed
(`npx -y modern-web-guidance@latest …`) and, optionally, to run Lighthouse
(`npx -y lighthouse …`). Claude's `--allowedTools` list includes `Bash(npx:*)`
for this.

## Caveats

- **Permissions:** `--yolo` (Gemini), `--dangerously-skip-permissions`
  (Antigravity), and `--allow-all-tools` (Copilot) auto-approve *every* tool
  call. Fine against the playground; for batch runs over arbitrary third-party
  sites, run inside a container or VM. Claude's invocation uses a scoped
  `--allowedTools` list instead. Codex uses the `workspace-write` sandbox - if
  Chrome can't reach the network from it, fall back to
  `--dangerously-bypass-approvals-and-sandbox` inside a container. opencode's
  `run` follows its own configured permissions.
- **Output:** `run.json` stores raw agent stdout (JSON for claude/gemini,
  JSONL for codex, plain text for antigravity/copilot/opencode). The contract
  that matters is the same for all agents: `report.json` in the site directory,
  validating against `schema/findings.schema.json`.
- **Gemini CLI sunset:** for individual Pro/Ultra accounts Gemini CLI is
  scheduled to sunset on 2026-06-18 in favour of Antigravity CLI - keep both
  adapters until the dust settles.
- Flags drift fast across all six CLIs; if an invocation fails, `--dry-run`
  shows the exact command to debug.
