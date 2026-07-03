# CLAUDE.md - web-uplift

This project is agent-agnostic: `AGENTS.md` is the single source of truth for
project context, the one canonical skill, how evidence is gathered, the house
rules, and the **Releases & versioning** procedure. Read it first:

➡️ **[AGENTS.md](AGENTS.md)**

Do not duplicate guidance here. Any change to project process belongs in
`AGENTS.md`; this file stays a pointer so the two cannot drift.

## Quick pointers

- Canonical skill: [`.claude/skills/web-audit/SKILL.md`](.claude/skills/web-audit/SKILL.md)
- Bump / publish procedure: the **Releases & versioning** section of [AGENTS.md](AGENTS.md)
- Current release: **v0.1.3**

## Claude Code specifics

`.claude/skills/web-audit/` holds the canonical skill, so `/web-audit <url>`
works in-session by default. `.claude-plugin/` provides the Claude Code plugin
manifest. The same skill also ships to Codex, Gemini, Antigravity, Copilot,
opencode, and pi via `web-uplift install --agent <name|all>`; all of those entry
points just point back at this skill, so they cannot drift.
