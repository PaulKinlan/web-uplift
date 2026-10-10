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
import { redactUrlCredentialValues } from '../evidence/credential-terms.mjs';

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
const GUIDANCE_NPX_PREFIX = 'npx -y --ignore-scripts modern-web-guidance@0.0.193';

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

// ---------------------------------------------------------------------------
// THE AGENT CHILD ENVIRONMENT (web-uplift-l6d): an explicit allowlist, NEVER a
// process.env spread. The spawned agent ingests untrusted page text and has
// network egress, so every variable it inherits is one prompt injection away
// from exfiltration (threat model C3). What the child legitimately needs:
//   - how to find binaries and where its own config/auth lives: PATH, HOME,
//     TMPDIR, SHELL, USER/LOGNAME, TERM, locale/timezone, XDG dirs, proxies;
//   - its OWN provider authentication when the operator authenticates the agent
//     CLI by environment variable - SCOPED to the CLI being spawned (a claude
//     run receives the ANTHROPIC_ family, never OPENAI_API_KEY; web-uplift-5ta);
//   - WEB_UPLIFT_* tunables, which the evidence-CLI grandchildren read.
// Everything else the operator's shell happens to carry - GITHUB_TOKEN, cloud
// keys, SSH agent sockets, registry tokens - stays out, and its NAME (never its
// value) is warned on so an operator learns what was withheld. Anything else a
// specific run genuinely needs goes through --agent-env KEY=VALUE, an explicit
// operator choice (e.g. a fine-grained token for the Copilot CLI, whose
// GITHUB_TOKEN auth is deliberately not passed by default).
//
// RESIDUAL, stated plainly: the child still holds its own provider credential
// and whatever --agent-env adds, and it keeps network egress, so a page can
// still talk the agent into exfiltrating THAT credential. The allowlist removes
// every OTHER credential from reach; it does not make the held one safe, which
// is why the README's operator-supplied isolation boundary stays the rule.
const AGENT_ENV_PASSTHROUGH = [
  'PATH', 'HOME', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME', 'TERM', 'COLORTERM',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

// Proxy variables are the only allowlisted entry whose VALUE can itself carry a credential, because a
// proxy URL may embed basic-auth userinfo ("http://user:password@proxy.example:8080"). Passing it
// verbatim handed that credential to the agent child, which is untrusted and page-driven, while the
// block comment above promised that every other credential "stays out" - the allowlist's stated
// guarantee and its behaviour disagreed at exactly the point the guarantee exists for
// (web-uplift-ql8a).
//
// The credential is removed, NOT the proxy. Dropping the variable outright would silently remove the
// operator's PROXY as well, and the child would egress DIRECTLY: an operator who set that proxy
// because egress must traverse it would get a quiet egress-policy bypass in place of a credential
// disclosure, with nothing in the child's environment to show the variable had been dropped. Keeping
// the host preserves the egress path, and if the proxy genuinely required that auth the child now
// fails loudly with a 407 instead of quietly holding a secret.
//
// "Does this value carry a credential" is answered by the SHARED rule in evidence/credential-terms.mjs
// rather than by a second regex here. That module already redacts URL userinfo and credential-named
// query values out of every artifact, and a private detector is exactly how the proxy check and the
// artifact redactor end up disagreeing about what a credential is (web-uplift-lsn3). The invariant
// enforced below is therefore checkable and shared: the value handed to the child is one the shared
// rule would NOT redact.
const PROXY_ENV_NAMES = new Set(AGENT_ENV_PASSTHROUGH.filter((n) => /_proxy$/i.test(n)));

// An '@' before the first '/', '?' or '#' is userinfo in the authority. A PATH may contain '@'
// ("https://x.test:8080/a/b@2x.png"), so a plain substring test is not enough - that distinction is
// the one web-uplift-73y3 established for the redactor, and it is kept here. The example has to be a
// URL the parser ACCEPTS for that claim to hold: with an invalid port ("...:99999/a/b@2x.png") the
// value is unparseable and takes the withheld path below instead, which is a different story about a
// different value - the earlier revision of this comment cited that very URL (web-uplift-k7ba).
function authorityCarriesUserinfo(value) {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)?([^/?#]*)/.exec(value);
  return Boolean(m) && m[2].includes('@');
}

// -> { value } for a credential-free value to pass, or { withheld: true } when the value carries a
// credential that could not be removed OR cannot be shown not to, which is the fail-closed answer for a
// value we cannot classify. The second half is why the warning below is worded as it is: a
// credential-free value the parser REJECTS and whose sweep leaves an '@' before a break lands here too,
// and it is not distinguishable from one whose credential was left behind (web-uplift-k7ba).
function sanitizeProxyEnvValue(raw) {
  const text = String(raw);
  if (!authorityCarriesUserinfo(text) && redactUrlCredentialValues(text) === text) {
    return { value: text }; // nothing credential-shaped: pass it through untouched
  }
  let candidate = text;
  if (authorityCarriesUserinfo(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return { withheld: true }; // userinfo we cannot parse: do not guess at a partial URL
    }
    url.username = '';
    url.password = '';
    candidate = url.href;
  }
  candidate = redactUrlCredentialValues(candidate); // also covers credential-named query values
  if (authorityCarriesUserinfo(candidate) || redactUrlCredentialValues(candidate) !== candidate) {
    return { withheld: true };
  }
  return { value: candidate };
}
const AGENT_ENV_ALWAYS_PREFIXES = ['WEB_UPLIFT_'];
// Provider credential families, scoped to the CLI being spawned (5ta): an
// operator with several provider keys in their shell exposes only the one the
// targeted agent needs. A CLI with no entry - or no agentName given - gets the
// BROAD union, the l6d behaviour, so an unmapped CLI never silently loses the
// credential it needs. copilot maps to NONE on purpose: it authenticates from
// its own config dir, and GITHUB_TOKEN stays withheld unless --agent-env adds
// a deliberately scoped token.
const AGENT_ENV_PROVIDER_BROAD = { prefixes: ['ANTHROPIC_', 'OPENAI_', 'GEMINI_'], names: ['GOOGLE_API_KEY'] };
const AGENT_ENV_PROVIDER_FAMILIES = {
  claude: { prefixes: ['ANTHROPIC_'], names: [] },
  codex: { prefixes: ['OPENAI_'], names: [] },
  gemini: { prefixes: ['GEMINI_'], names: ['GOOGLE_API_KEY'] },
  antigravity: { prefixes: ['GEMINI_'], names: ['GOOGLE_API_KEY'] },
  copilot: { prefixes: [], names: [] },
};

// A name reads as sensitive when it carries a credential-shaped token, or is a
// known credential channel. Used ONLY to warn about withheld variables - the
// allowlist above decides what passes, never this pattern.
const SENSITIVE_ENV_NAME = new RegExp(
  '(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_?KEY|PRIVATE_?KEY|AUTH|SESSION|CONNECTION_?STRING)(_|$)' +
    '|^(SSH_AUTH_SOCK|SSH_AGENT_PID|KUBECONFIG|DOCKER_AUTH_CONFIG|GOOGLE_APPLICATION_CREDENTIALS)$' +
    '|^(AWS|GITHUB|GH|NPM|DOCKER|STRIPE|TWILIO|SLACK|DIGITALOCEAN|HEROKU)_[A-Z]',
);

export function buildAgentEnv({ agentName, extra = {}, env = process.env, warn = (m) => console.error(m) } = {}) {
  const out = {};
  const family = (agentName && AGENT_ENV_PROVIDER_FAMILIES[agentName]) || AGENT_ENV_PROVIDER_BROAD;
  const prefixes = [...AGENT_ENV_ALWAYS_PREFIXES, ...family.prefixes];
  const names = new Set(family.names);
  const proxyWarnings = [];
  for (const name of AGENT_ENV_PASSTHROUGH) {
    if (env[name] === undefined) continue;
    if (!PROXY_ENV_NAMES.has(name)) {
      out[name] = env[name];
      continue;
    }
    const safe = sanitizeProxyEnvValue(env[name]);
    if (safe.value === undefined) {
      // "or cannot be distinguished from" rather than asserting a credential, because a value reaching
      // this branch may hold none at all: one the parser REJECTS whose sweep leaves an '@' before a break
      // cannot be told apart from one whose credential survived, and fail-closed treats both the same. The
      // earlier wording claimed a credential for such a value, naming a reason that was not the reason
      // (web-uplift-k7ba).
      proxyWarnings.push(
        `[agent-env] withheld ${name}: it carries, or cannot be distinguished from, a credential that ` +
          `could not be removed safely, so the child gets no proxy from it. Pass it explicitly with ` +
          `--agent-env ${name}=... if this run needs it.`,
      );
      continue;
    }
    out[name] = safe.value;
    // Compare in the STRING form, which is the form the sanitiser decided on. Comparing against the
    // raw value made an injected non-string credential-free value warn that a credential had been
    // removed from it - a claim that was simply untrue (review finding). Working from one canonical
    // string form is also what keeps a value with a stateful toString() from being judged as one
    // thing and then stringified as another when the child is spawned.
    if (safe.value !== String(env[name])) {
      proxyWarnings.push(
        `[agent-env] removed a credential from ${name} before handing it to the agent child (the ` +
          `credential was not passed; the proxy host still was, so egress still traverses it). Pass the ` +
          `full value with --agent-env ${name}=... if this run genuinely needs proxy authentication.`,
      );
    }
  }
  for (const message of proxyWarnings) warn(message);
  for (const [name, value] of Object.entries(env)) {
    if (out[name] !== undefined) continue;
    if (prefixes.some((p) => name.startsWith(p)) || names.has(name)) {
      out[name] = value;
    }
  }
  // The operator's explicit choices always win, including over the allowlist.
  for (const [name, value] of Object.entries(extra)) out[name] = value;

  const withheld = Object.keys(env)
    .filter((name) => out[name] === undefined && SENSITIVE_ENV_NAME.test(name))
    .sort();
  if (withheld.length) {
    warn(
      `[agent-env] withheld ${withheld.length} sensitive-looking variable(s) from the agent child ` +
        `(names only): ${withheld.join(', ')} - if the agent genuinely needs one, pass it ` +
        `explicitly with --agent-env KEY=VALUE`,
    );
  }
  return out;
}

// Parse the repeatable --agent-env KEY=VALUE flag. Values may themselves
// contain '='; only the first one splits the pair.
export function parseAgentEnvFlag(values) {
  const extra = {};
  for (const entry of [].concat(values ?? [])) {
    const text = String(entry);
    const eq = text.indexOf('=');
    if (eq < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text.slice(0, eq))) {
      throw new Error(`--agent-env expects KEY=VALUE with a shell-style KEY; got "${text}"`);
    }
    extra[text.slice(0, eq)] = text.slice(eq + 1);
  }
  return extra;
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
      //   - The guidance prefix ends at `modern-web-guidance@0.0.193`, so a
      //     lookalike package (`modern-web-guidance-evil`) does NOT match it, and
      //     `modern-web-guidance@0.0.1931` is not a published version. The pin is
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
