// SINGLE source of truth for how each agent is invoked HEADLESSLY (the CI /
// batch path that bills API tokens). Both the audit runner (runner/run-batch.mjs)
// and the fixer (fixer/fix.mjs) import this map, so adding an agent stays ONE
// entry here (plus a thin per-agent command file so the slash command works
// interactively; see runner/README.md, "How to add an agent").
//
// IMPORTANT: this headless path shells out to a CLI in `-p`/`exec` mode, which
// uses API TOKENS. The DEFAULT, subscription-friendly path is to run the skill
// INSIDE your own agent session (see README "Run it in your agent"); this map is
// only for unattended CI / batch fan-out.
//
// Each entry is a thin wrapper: { bin, prompt, args } all pointing at the SAME
// canonical skill (.claude/skills/web-audit/SKILL.md) against a URL. The runner
// ORCHESTRATES; it contains no checks. The agent (the model) follows SKILL.md.

// Prompts. Claude surfaces the skill as a slash command; the rest are pointed at
// the SKILL.md file directly (plain markdown any agent can follow). `extra` is
// appended verbatim so the fixer can pass `--source <dir> --fix ...`.
export const slashPrompt = (url, siteDir, extra = '') =>
  `/web-audit ${url} --out ${siteDir}${extra ? ` ${extra}` : ''}`;

export const skillPrompt = (url, siteDir, extra = '') =>
  `Read the file .claude/skills/web-audit/SKILL.md and follow its ` +
  `instructions exactly, with these arguments: ${url} --out ${siteDir}` +
  `${extra ? ` ${extra}` : ''}`;

export const AGENTS = {
  claude: {
    bin: 'claude',
    prompt: slashPrompt,
    args: (prompt, { maxTurns }) => [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', String(maxTurns),
      // Scoped permissions instead of a blanket bypass. Bash(node:*) lets the
      // agent run the evidence primitives (node evidence/cli.mjs ...); npx lets
      // it query the Modern Web Guidance feed and run Lighthouse if it chooses.
      '--allowedTools',
      'Read,Write,Edit,Glob,Grep,Bash(node:*),Bash(npx:*),Bash(mkdir:*),Bash(ffmpeg:*)',
    ],
  },
  codex: {
    bin: 'codex',
    prompt: skillPrompt,
    // workspace-write keeps file edits sandboxed to the repo. If Chrome can't
    // reach the network from the sandbox, run inside a container with
    // --dangerously-bypass-approvals-and-sandbox instead.
    args: (prompt) => ['exec', '--json', '--sandbox', 'workspace-write', prompt],
  },
  gemini: {
    bin: 'gemini',
    prompt: skillPrompt,
    // --yolo auto-approves every tool call: run untrusted sites in a container.
    args: (prompt) => ['-p', prompt, '--yolo', '--output-format', 'json'],
  },
  antigravity: {
    bin: 'agy',
    prompt: skillPrompt,
    // No reliable JSON output mode yet; we keep raw stdout in run.json.
    args: (prompt) => ['-p', prompt, '--dangerously-skip-permissions'],
  },
  copilot: {
    bin: 'copilot',
    prompt: skillPrompt,
    // GitHub Copilot CLI: headless prompt with auto tool approval. The repo's
    // .github/copilot-instructions.md + prompts/web-audit.prompt.md point it at
    // the same skill. Run untrusted sites in a container.
    args: (prompt) => ['-p', prompt, '--allow-all-tools'],
  },
  opencode: {
    bin: 'opencode',
    prompt: skillPrompt,
    // opencode headless run. It reads AGENTS.md and .opencode/command/web-audit
    // from the repo; here we pass the skill prompt directly for batch use.
    args: (prompt) => ['run', prompt],
  },
};

export const AGENT_NAMES = Object.keys(AGENTS);
