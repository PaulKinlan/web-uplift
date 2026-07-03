---
mode: agent
description: "web-uplift: audit a URL for modern web quality; --fix to hill-climb."
---

Read the file `.web-uplift/skill/SKILL.md` (or `.claude/skills/web-audit/SKILL.md` if present) and follow its instructions exactly, with the arguments the user provides (a URL, plus optional flags like --out <dir>, --source <dir>, --fix, --findings <path>).

Arguments: ${input:args:URL plus optional flags}
