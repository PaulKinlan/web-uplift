# web-audit

Audit a URL for modern web quality, fully agentically: gather multi-modal
evidence with the repo's evidence primitives, choose your own tools, reason, and
judge every principle (Una's five + the Lighthouse dimensions) against Modern
Web Guidance; --fix to write guidance-backed fixes and re-audit.

Read the file `.claude/skills/web-audit/SKILL.md` and follow its instructions
exactly. Treat the text the user typed after the command as the arguments (the
URL, plus optional flags like `--out <dir>`, `--source <dir>`, `--fix`,
`--expected <file>`).
