# AGENTS.md - web-uplift

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

**Two ways to run, default first.** The DEFAULT for an individual is to run the
skill INSIDE this session (it uses your subscription): `/web-audit <url>` to
audit, `/web-audit <url> --source <dir> --fix` for the model-driven fix
hill-climb. The HEADLESS / CI path (`npm run audit`, `npm run fix`,
`web-uplift audit|fix`) spawns an agent CLI in `-p`/`exec` mode and bills API
tokens; it is for automation, not the individual default. Both follow this same
SKILL.md. Fix mode is a MODEL-DRIVEN hill-climb: you write every guidance-backed
edit and re-audit until no outstanding `issues` remain (there are no canned
transforms).

## How you see the page (no MCP required)

Evidence is gathered with a plain Node CLI over raw Chrome DevTools Protocol
(chrome-remote-interface), no browser-automation MCP server, no Playwright, no
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

- Principles (spec, as outcomes): [`knowledge/principles.json`](knowledge/principles.json)
- Guidance (the how): the `modern-web-guidance` feed; [`knowledge/guidance.md`](knowledge/guidance.md)
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

## Releases & versioning

The single source of truth for the version is `package.json` (`version` field).
`bin/web-uplift.mjs` reads it via `pkg.version` and stamps it into the install
manifest at install/update time, so bumping `package.json` is the only manual
edit. `.web-uplift/manifest.json` is tracked and should be kept in sync (it is
also regenerated on every `install`/`update`).

**Where the version literal must agree** (grep `0.1.x` before tagging):

- `package.json` (canonical)
- `.web-uplift/manifest.json` (regenerated on install; keep in sync in-repo)

**Skill files are version-coupled.** `.claude/skills/web-audit/SKILL.md` is the
canonical skill; every per-agent entry point (`.codex`, `.opencode`, `.github`,
`.agents`, `.pi`, the vendored `.web-uplift/skill/SKILL.md`) is a copy produced by
`web-uplift install`. If you change the skill, bump the version and republish so
`npx web-uplift install` ships the fix.

**SKILL.md frontmatter must be valid YAML.** The `description:` value is a long
single-line scalar that frequently contains `word: word` (colon + space). An
unquoted plain scalar with `: ` inside is parsed as a nested mapping and throws
`Nested mappings are not allowed in compact mappings`, which makes agent skill
loaders (pi, Claude Code, Codex) silently reject the skill. Therefore:

- Keep `description` wrapped in double quotes: `description: "..."`.
- Before tagging, sanity-check with the agent's own parser, e.g.
  `node -e 'import("yaml").then(y=>y.parse(require("fs").readFileSync(".claude/skills/web-audit/SKILL.md","utf8").split("---")[1]))'`
  must not throw.
- Avoid em dashes in the description and body (house rule).

**Bump procedure** (use semver: patch for fixes, minor for new features, major
for breaking skill/schema changes):

1. Edit `package.json` and `.web-uplift/manifest.json` to the new version.
2. Regenerate installed skill copies so the repo is self-consistent:
   `node bin/web-uplift.mjs install --agent all`.
3. `npm test` (regression suite) and spot-check the frontmatter parser above.
4. `git commit -m "chore: release v<VERSION>"`.
5. `npm publish` (publishes `bin/`, `evidence/`, `runner/`, `fixer/`,
   `aggregate/`, `index.mjs`, `mcp/`, `knowledge/`, `schema/`, `tests/`, and the
   `.claude/skills/web-audit/SKILL.md` per the `files` allowlist).
6. `git tag v<VERSION> && git push && git push --tags`.

### Current release: v0.4.1

Patch over v0.4.0. `a11ytree` gains `--max-nodes <n>` and `--max-stops <n>`. Its
tree projection and focus walk were fixed at 400 nodes and 60 stops, which a
content-heavy page blows through (a live run against a personal blog measured
831 AX nodes), and there was no way to ask for the rest even though the caps
were reported. The defaults are unchanged, the effective values are echoed in
the output (`tree.maxNodes`, `focusOrder.maxStops`), and the skill row says how
to widen them.

v0.4.0, the previous release, introduced the six evidence primitives built since
v0.3.0 (`axe`, `console`, `targets`, `features`, `resilience`, `a11ytree`), the
evidence-honesty work (every cap reported, report-shape validation, the
`censusComplete` and truncation signals) and the skill rule that a miss in a
truncated sample is not absence.

<!-- web-uplift:install -->
## web-uplift (modern-web audit + fix)

When asked to web-audit, UX-audit, uplift, modernise, or quality-audit a site, read `.web-uplift/skill/SKILL.md` and follow it exactly. Gather evidence with `node .web-uplift/evidence/cli.mjs <primitive> <url> [options]` (raw CDP). `--fix --source <dir>` runs the model-driven hill-climb.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
