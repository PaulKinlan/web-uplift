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

import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// THE SKILL <-> HEADLESS-SANDBOX CONTRACT, declared ONCE and enforced by tests.
//
// The headless Claude allowlist and the commands SKILL.md instructs the agent
// to run are two halves of ONE contract. They drifted once (web-uplift-7tj):
// the scoped list admitted the evidence CLI but not the report validator, the
// compare, the scorecard, the Baseline oracle or the journey replay, and its
// prefix rules missed ABSOLUTE-PATH invocations of the very scripts they named,
// so a real headless audit was blocked 38 seconds in by permission denials for
// steps the skill itself mandates. The Bash rules below are therefore DERIVED
// from this table, and testHeadlessAllowlistMatchesSkillContract
// (tests/regression.mjs) re-reads SKILL.md and fails when either half changes
// without the other:
//   - a `node <script>` command SKILL.md instructs that is missing here is the
//     7tj defect (the sandbox forbids a mandated step);
//   - an entry here that SKILL.md nowhere instructs is speculative sandbox
//     widening, and is rejected the same way.
//
// Deliberately NOT in the table:
//   - `npx -y lighthouse` - optional per the skill ("skip it and gather the
//     same signal first-party with layout and evaluate"), and a bare prefix
//     would also match `npx -y lighthouse-evil` (web-uplift-tia P1a).
//   - the `web-uplift <subcommand>` / `npx -y web-uplift ...` bin forms - the
//     skill says "pick the first [invocation form] that exists", and the
//     headless runners always spawn with cwd = the project root, where the
//     repo and vendored forms exist, so the bin form is never the required one
//     (and `Bash(npx -y web-uplift:*)` would be a lookalike-package prefix).
//   - `aggregate/aggregate.mjs` - a cross-site operator summary, not a step the
//     skill instructs an audit run to perform.
export const SKILL_REQUIRED_COMMANDS = [
  { id: 'evidence-cli', script: 'evidence/cli.mjs', skillStep: 'The evidence primitives: every primitive call the audit gathers evidence with' },
  { id: 'validate-report', script: 'schema/validate-report.mjs', skillStep: 'step 6: MANDATORY before report.md, any score, aggregation or a completion claim' },
  { id: 'compare-runs', script: 'aggregate/compare.mjs', skillStep: 'step 6b: the before/after comparison (fix mode requires it)' },
  { id: 'scorecard', script: 'aggregate/scorecard.mjs', skillStep: 'step 6c: the close of every coverage-complete run' },
  { id: 'baseline-oracle', script: 'knowledge/baseline.mjs', skillStep: 'step 7.1: fix-mode Baseline status lookup' },
  { id: 'flow-replay', script: 'runner/flow.mjs', skillStep: 'step 1: user-journey replay when surfaces are reached by a journey' },
];

// The pinned Modern Web Guidance feed. The literal is tied to
// guidanceCatalogVersion in knowledge/principles.json by
// testGuidanceVersionPinnedInDocs and the contract test; bump them together.
const GUIDANCE_NPX_PREFIX = 'npx -y --ignore-scripts modern-web-guidance@0.0.172';

// Derive the headless Bash permission rules from SKILL_REQUIRED_COMMANDS.
// `root` is the directory the agent is spawned with as cwd (both runners pass
// their projectRoot explicitly; it defaults to the current cwd for dry-runs and
// tests). Every entry admits FOUR spellings of the SAME script, all legitimate
// for an agent whose cwd is the project root: the repo-relative form the skill
// documents, the vendored `.web-uplift/` per-project-install form, and the
// absolute form under the spawn root (repo and vendored) - the absolute form is
// exactly what a path-resolving agent writes and what the 7tj run was denied
// on. Any other spelling (quoted paths, `./`-prefixed, path traversal) is
// deliberately not admitted.
export function headlessBashRules({ root } = {}) {
  const cwd = resolve(root ?? process.cwd());
  const rules = [];
  for (const { script } of SKILL_REQUIRED_COMMANDS) {
    rules.push(`Bash(node ${script}:*)`);
    rules.push(`Bash(node .web-uplift/${script}:*)`);
    rules.push(`Bash(node ${join(cwd, script)}:*)`);
    rules.push(`Bash(node ${join(cwd, '.web-uplift', script)}:*)`);
  }
  rules.push(`Bash(${GUIDANCE_NPX_PREFIX}:*)`);
  rules.push('Bash(mkdir:*)');
  rules.push('Bash(ffmpeg:*)');
  return rules;
}

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
    args: (prompt, { maxTurns, root } = {}) => [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', String(maxTurns),
      // Scoped permissions instead of a blanket bypass. The old list granted
      // Bash(node:*) and Bash(npx:*), which match ANY trailing arguments, so a
      // page that talked the agent into `node -e '<code>'` or `npx -y <package>`
      // got arbitrary execution in the same process tree that ingests untrusted
      // page text (threat model I4, web-uplift-tia).
      //
      // The Bash entries are DERIVED from SKILL_REQUIRED_COMMANDS above - the
      // single declared skill contract - so the sandbox admits exactly the
      // scripts the skill instructs the agent to run (7tj); the contract test
      // in tests/regression.mjs keeps the table and SKILL.md in sync.
      //
      // These rules are STRING PREFIXES. The CLI's own help documents the glob
      // form `Bash(git *)` as well, but the binary is compiled and the exact
      // matcher could not be determined locally, so this list assumes the
      // conservative PREFIX reading. That shapes what is safe to write here:
      //   - The guidance prefix ends at `modern-web-guidance@0.0.172`, so a
      //     lookalike package (`modern-web-guidance-evil`) does NOT match it, and
      //     `modern-web-guidance@0.0.1721` is not a published version. The pin is
      //     guidanceCatalogVersion in knowledge/principles.json and is asserted by
      //     tests/regression.mjs.
      //   - A bare tool name would NOT be safe: `Bash(npx -y lighthouse:*)` is a
      //     prefix and also matches `npx -y lighthouse-evil`, so Lighthouse is
      //     deliberately not allowed here. Add it as
      //     `Bash(npx -y lighthouse@<exact version>:*)` if a run needs it.
      //   - The node entries are PATH prefixes that stop at a declared script
      //     (a sibling like `evidence/cli.mjs2` would still match), and the agent
      //     has Write, so it could write such a sibling and run it through the
      //     matching prefix. This list narrows which commands are reachable; it
      //     is NOT an execution sandbox, and container/VM isolation stays the
      //     enforcement boundary for untrusted sites (see README).
      '--allowedTools',
      ['Read,Write,Edit,Glob,Grep', ...headlessBashRules({ root })].join(','),
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
  pi: {
    bin: 'pi',
    prompt: skillPrompt,
    // pi print mode. -a (--approve) trusts project resources so an installed
    // .pi/skills/web-audit + AGENTS.md load in non-interactive mode; pi's default
    // tools include the shell it needs to run `node evidence/cli.mjs ...`. Run
    // untrusted sites in a container.
    args: (prompt) => ['-p', prompt, '-a', '--no-session', '--no-extensions'],
  },
};

export const AGENT_NAMES = Object.keys(AGENTS);
