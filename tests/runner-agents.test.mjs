#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assert, readJson, repoRoot, tmp, runSuite, runAsync } from "./test-helpers.mjs";
import { AGENTS, SKILL_REQUIRED_COMMANDS, headlessBashRules, buildAgentEnv, parseAgentEnvFlag } from "../runner/agents.mjs";


// The headless Claude allowlist must name the intended invocations, not the
// interpreter prefixes that match arbitrary trailing arguments: `Bash(node:*)`
// and `Bash(npx:*)` permitted `node -e '<code>'` and `npx -y <any-package>` in
// the same process tree that ingests untrusted page text (threat model I4,
// web-uplift-tia). The guidance entry must stay pinned to guidanceCatalogVersion,
// which is what ties this allowlist to the 2op documentation pin.
export function testHeadlessAllowlistIsScoped() {
  const args = AGENTS.claude.args('prompt', { maxTurns: 3 });
  const index = args.indexOf('--allowedTools');
  assert(
    index >= 0 && index + 1 < args.length,
    `claude headless args must carry --allowedTools: ${JSON.stringify(args)}`,
  );
  const allowed = args[index + 1];

  for (const blanket of ['Bash(node:*)', 'Bash(npx:*)']) {
    assert(
      !allowed.includes(blanket),
      `the headless allowlist must not grant ${blanket} (it matches arbitrary trailing arguments): ${allowed}`,
    );
  }

  for (const entry of [
    'Bash(node evidence/cli.mjs:*)',
    'Bash(node .web-uplift/evidence/cli.mjs:*)',
    'Bash(mkdir:*)',
    'Bash(ffmpeg:*)',
  ]) {
    assert(allowed.includes(entry), `the headless allowlist must keep the intended ${entry}: ${allowed}`);
  }

  // A bare tool name is a PREFIX, so `Bash(npx -y lighthouse:*)` would also match
  // `npx -y lighthouse-evil`: Lighthouse is deliberately absent, and if it is ever
  // added it must carry an exact version right after the package name.
  assert(
    !/Bash\(npx [^)]*lighthouse[^@:)]*:\*\)/.test(allowed),
    `the headless allowlist must not grant a bare tool prefix such as lighthouse: ${allowed}`,
  );

  const pinned = readJson('knowledge/principles.json').guidanceCatalogVersion;
  assert(
    allowed.includes(`Bash(npx -y --ignore-scripts ${pinned}:*)`),
    `the guidance allowlist entry must name the pinned ${pinned}: ${allowed}`,
  );
}


// The redaction itself, without a browser: every credential header name is
// replaced by the placeholder while a non-secret header is untouched, so the
// redaction cannot be satisfied by over-redacting everything (web-uplift-dxk).
// THE SKILL <-> SANDBOX CONTRACT DRIFT CHECK (web-uplift-7tj). The headless
// Claude allowlist and the commands SKILL.md instructs the agent to run are two
// halves of one contract, and nothing used to compare them: the scoped list
// omitted the report validator, the scorecard, the compare, the Baseline oracle
// and the journey replay, and its prefix rules missed absolute-path
// invocations, so a REAL headless audit was blocked 38s in by permission
// denials for steps the skill mandates - invisible to every check that read the
// allowlist on its own. This test re-reads SKILL.md and fails in BOTH
// directions: a `node <script>` command the skill instructs that the contract
// table does not declare (the sandbox forbids a mandated step), and a declared
// entry the skill nowhere instructs (speculative sandbox widening). It also
// replays the real failure mode under the documented STRING-PREFIX matching:
// every spelling the allowlist generates must admit the corresponding command,
// including the ABSOLUTE-PATH form the 7tj run was denied on, while lookalike
// commands stay refused.
export function testHeadlessAllowlistMatchesSkillContract() {
  const skill = readFileSync(join(repoRoot, '.claude/skills/web-audit/SKILL.md'), 'utf8');

  // 1. Every `node <path>.mjs` command SKILL.md instructs the agent to run
  //    (the vendored `.web-uplift/` spelling normalises to the same script).
  const instructed = new Set(
    [...skill.matchAll(/\bnode ((?:\.web-uplift\/)?[\w./-]+\.mjs)\b/g)]
      .map((m) => m[1].replace(/^\.web-uplift\//, '')),
  );
  assert(instructed.size > 0, 'could not extract any node commands from SKILL.md; the drift check is blind');
  const declared = new Set(SKILL_REQUIRED_COMMANDS.map((c) => c.script));
  for (const script of instructed) {
    assert(
      declared.has(script),
      `SKILL.md instructs the agent to run \`node ${script}\`, but runner/agents.mjs SKILL_REQUIRED_COMMANDS ` +
        `does not declare it, so the headless allowlist DENIES a step the skill requires (web-uplift-7tj). ` +
        `Add it to the contract table or change the skill to stop requiring it.`,
    );
  }
  for (const entry of SKILL_REQUIRED_COMMANDS) {
    assert(
      instructed.has(entry.script),
      `SKILL_REQUIRED_COMMANDS declares \`${entry.script}\` (${entry.skillStep}), but SKILL.md nowhere ` +
        `instructs \`node ${entry.script}\`. The allowlist must admit exactly what the skill requires, ` +
        `nothing speculative.`,
    );
  }

  // 2. Admission under the STRING-PREFIX semantics documented in agents.mjs:
  //    `Bash(<prefix>:*)` admits command C iff C starts with <prefix>.
  const root = '/srv/web-uplift-checkout';
  const rules = headlessBashRules({ root });
  const admits = (command) =>
    rules.some((rule) => {
      const m = /^Bash\((.*):\*\)$/.exec(rule);
      return m !== null && (command === m[1] || command.startsWith(m[1]));
    });

  for (const { script } of SKILL_REQUIRED_COMMANDS) {
    const admitted = [
      `node ${script} axe https://example.com --out evidence`,
      `node .web-uplift/${script} --help`,
      `node ${root}/${script} --help`, // the ABSOLUTE-PATH form the 7tj run was denied on
      `node ${root}/.web-uplift/${script} --help`,
    ];
    for (const command of admitted) {
      assert(admits(command), `the derived allowlist must admit \`${command}\` (a form of skill-required \`${script}\`): ${rules.join(', ')}`);
    }
  }

  const pinned = readJson('knowledge/principles.json').guidanceCatalogVersion;
  assert(
    admits(`npx -y --ignore-scripts ${pinned} search color-scheme`),
    `the derived allowlist must admit the pinned guidance feed invocation ${pinned}`,
  );

  // 3. Posture: the derivation may not have widened the sandbox. Refusals the
  //    tightening (e2138c9 + bd7de74) bought stay refused.
  const refused = [
    'node -e process.exit(0)',
    'node evidence/evil.mjs --help',
    `node ${root}/evidence/evil.mjs --help`,
    'node /etc/passwd',
    'npx -y some-package',
    'npx -y lighthouse https://example.com',
    'npx -y modern-web-guidance-evil search color-scheme',
    'npx -y web-uplift evidence screenshot https://example.com',
  ];
  for (const command of refused) {
    assert(!admits(command), `the derived allowlist must still refuse \`${command}\`: ${rules.join(', ')}`);
  }

  // 4. The production claude args carry EXACTLY the derived rules (so the
  //    contract cannot be bypassed by a hand-maintained copy in the args) -
  //    in BOTH directions: every derived rule is present, and nothing beyond
  //    the fixed file-tools prefix and the derived rules has been hand-added
  //    (a widening entry such as `Bash(node:*)` must fail here, not pass
  //    silently because the subset direction still holds).
  const args = AGENTS.claude.args('prompt', { maxTurns: 3, root });
  const allowed = args[args.indexOf('--allowedTools') + 1];
  const expected = ['Read,Write,Edit,Glob,Grep', ...rules].join(',');
  assert(
    allowed === expected,
    `claude --allowedTools must be EXACTLY the file tools plus the derived rules, nothing more, nothing less.\nexpected: ${expected}\nactual:   ${allowed}`,
  );
}

// The skill-vs-write-scope contract has its own dependency-free guard (same
// shape as tests/cdp-copy-sync.mjs, for the same reason: it must be runnable
// with no npm install). Drive it here so `npm test` covers the contract that
// refused a COMPLETED audit in web-uplift-ies run 4: SKILL.md instructed
// `scratch/` while allowedRoots allowed only the run's --out directory
// (web-uplift-16f). The guard carries its own mutation controls, so a neutered
// check fails there rather than here.
export function testSkillWriteContractGuard() {
  const guard = spawnSync(process.execPath, [join(repoRoot, 'tests', 'skill-write-contract.mjs')], { encoding: 'utf8' });
  assert(guard.status === 0, `skill-write-contract guard must pass: ${guard.stderr || guard.stdout}`);
}


// The agent-child environment allowlist (web-uplift-l6d): the spawned agent
// ingests untrusted page text with network egress, so it must NOT inherit the
// operator's shell env - a page that talks the agent into reading a credential
// can exfiltrate it. The child gets an explicit allowlist instead, sensitive
// withholdings are warned on BY NAME (never values), and --agent-env is the
// explicit opt-in.
export async function testAgentChildEnvAllowlist() {
  const { buildAgentEnv, parseAgentEnvFlag } = await import(pathToFileURL(join(repoRoot, 'runner/agents.mjs')).href);

  // 1. UNIT: what passes, what is withheld, what is warned.
  const warnings = [];
  const fakeEnv = {
    PATH: '/usr/bin', HOME: '/home/op', LANG: 'en_GB.UTF-8',
    ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-openai-secret', GEMINI_API_KEY: 'gemini-secret',
    WEB_UPLIFT_FETCH_DEADLINE_MS: '5000',
    GITHUB_TOKEN: 'ghp_secret', AWS_SECRET_ACCESS_KEY: 'aws-secret',
    SSH_AUTH_SOCK: '/tmp/ssh-agent', NPM_TOKEN: 'npm-secret', RANDOM_NOISE: 'harmless',
  };
  const built = buildAgentEnv({ env: fakeEnv, warn: (m) => warnings.push(m) });
  for (const kept of ['PATH', 'HOME', 'LANG', 'ANTHROPIC_API_KEY', 'WEB_UPLIFT_FETCH_DEADLINE_MS']) {
    assert(built[kept] === fakeEnv[kept], `the child needs ${kept}: it must pass the allowlist`);
  }
  for (const dropped of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK', 'NPM_TOKEN', 'RANDOM_NOISE']) {
    assert(built[dropped] === undefined, `${dropped} must NOT reach the agent child`);
  }
  assert(warnings.length === 1, `withheld variables must be warned on once: ${JSON.stringify(warnings)}`);
  for (const named of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK', 'NPM_TOKEN']) {
    assert(warnings[0].includes(named), `the warning must name the withheld ${named}: ${warnings[0]}`);
  }
  assert(
    !warnings[0].includes('ghp_secret') && !warnings[0].includes('aws-secret'),
    'the warning must name variables but NEVER carry their values',
  );
  assert(!warnings[0].includes('RANDOM_NOISE'), 'a harmless variable is dropped silently; only sensitive-looking ones are named');

  // 1b. PROVIDER SCOPING (web-uplift-5ta): a claude run gets the ANTHROPIC_
  //     family ONLY - an operator's OPENAI_/GEMINI_ keys are withheld from it;
  //     no agentName falls back to the broad union so an unmapped CLI never
  //     silently loses the credential it needs.
  const claudeBuilt = buildAgentEnv({ agentName: 'claude', env: fakeEnv, warn: () => {} });
  assert(claudeBuilt.ANTHROPIC_API_KEY === 'sk-ant-secret', 'a claude child keeps its own provider family');
  assert(claudeBuilt.OPENAI_API_KEY === undefined, 'a claude child must NOT receive OPENAI_API_KEY');
  assert(claudeBuilt.GEMINI_API_KEY === undefined, 'a claude child must NOT receive GEMINI_API_KEY');
  const broadBuilt = buildAgentEnv({ env: fakeEnv, warn: () => {} });
  assert(
    broadBuilt.OPENAI_API_KEY === 'sk-openai-secret' && broadBuilt.GEMINI_API_KEY === 'gemini-secret',
    'no agentName falls back to the broad provider union (the l6d behaviour)',
  );

  // 2. --agent-env parsing: explicit additions win, values may contain '=', bad
  //    shapes are rejected loudly.
  const extra = parseAgentEnvFlag(['COPILOT_GITHUB_TOKEN=ghp_scoped', 'WEIRD=a=b=c']);
  assert(extra.COPILOT_GITHUB_TOKEN === 'ghp_scoped' && extra.WEIRD === 'a=b=c', `--agent-env parsing: ${JSON.stringify(extra)}`);
  const withExtra = buildAgentEnv({ env: fakeEnv, extra, warn: () => {} });
  assert(withExtra.COPILOT_GITHUB_TOKEN === 'ghp_scoped', 'an --agent-env addition must reach the child');
  for (const bad of ['NOEQUALS', '=x', '1BAD=x', 'BAD-NAME=x']) {
    let threw = false;
    try { parseAgentEnvFlag([bad]); } catch { threw = true; }
    assert(threw, `--agent-env must reject ${JSON.stringify(bad)}`);
  }

  // 3. THE SPAWN SEAM, end to end: a stub agent records the environment it
  //    ACTUALLY received from the batch runner, proving the child gets the
  //    allowlist and nothing else - including the run-level launches.jsonl
  //    path, which is runner-set on top of the allowlist (4wx).
  const envTmp = mkdtempSync(join(tmpdir(), 'web-uplift-agent-env-'));
  try {
    const captureFile = join(envTmp, 'child-env-keys.txt');
    const binDir = join(envTmp, 'bin');
    mkdirSync(binDir);
    const stubPath = join(binDir, 'claude');
    writeFileSync(stubPath, `#!/bin/sh\nenv | cut -d= -f1 | sort > ${captureFile}\nexit 0\n`);
    chmodSync(stubPath, 0o755);
    const run = await runAsync(
      process.execPath,
      [join(repoRoot, 'runner', 'run-batch.mjs'), 'https://example.com', '--agent', 'claude', '--isolation', 'test-suite', '--out', join(envTmp, 'reports')],
      {
        env: {
          PATH: `${binDir}:${process.env.PATH}`,
          HOME: envTmp,
          GITHUB_TOKEN: 'ghp_parent_secret',
          ANTHROPIC_API_KEY: 'sk-ant-parent',
          OPENAI_API_KEY: 'sk-openai-parent',
          SSH_AUTH_SOCK: '/tmp/ssh-parent',
        },
      },
    );
    assert(existsSync(captureFile), `the stub agent must have run (runner stderr: ${run.stderr.slice(-400)})`);
    const childKeys = readFileSync(captureFile, 'utf8').trim().split('\n');
    assert(childKeys.includes('ANTHROPIC_API_KEY'), 'the child keeps its own provider credential');
    assert(childKeys.includes('PATH') && childKeys.includes('HOME'), 'the child keeps PATH/HOME');
    assert(childKeys.includes('WEB_UPLIFT_LAUNCH_LOG'), 'the run-level launches path must reach the child (4wx)');
    for (const dropped of ['GITHUB_TOKEN', 'SSH_AUTH_SOCK']) {
      assert(!childKeys.includes(dropped), `the operator's ${dropped} must NOT reach the agent child`);
    }
    assert(!childKeys.includes('OPENAI_API_KEY'), 'a claude spawn must NOT receive OPENAI_API_KEY (provider scoping, 5ta)');
    assert(
      run.stderr.includes('withheld') && run.stderr.includes('GITHUB_TOKEN'),
      `the runner must warn the withheld names on stderr: ${run.stderr.slice(-400)}`,
    );
  } finally {
    rmSync(envTmp, { recursive: true, force: true });
  }
}

// web-uplift-ql8a. A proxy URL can carry basic-auth userinfo, and AGENT_ENV_PASSTHROUGH copied the
// proxy variables VERBATIM, so the agent child - which is untrusted and page-driven - received a proxy
// credential while the same function warned about withholding GITHUB_TOKEN. The credential is now
// removed while the proxy HOST survives, and the full value returns only through --agent-env.
export async function testAgentChildEnvProxyCredentials() {
  const { buildAgentEnv } = await import(pathToFileURL(join(repoRoot, 'runner/agents.mjs')).href);
  const { redactUrlCredentialValues } = await import(pathToFileURL(join(repoRoot, 'evidence/credential-terms.mjs')).href);
  // Composed at runtime, so no credential-shaped literal is written into this repo, this test, or a commit.
  const userinfo = ['user', 'pass' + 'word'].join(':');
  const proxied = `http://${userinfo}@proxy.invalid:8080`;

  // 1. EVERY spelling the allowlist carries, not just the uppercase one. A guard that tested only
  // HTTPS_PROXY would pass while http_proxy leaked - one spelling standing in for a whole class.
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    const warnings = [];
    const built = buildAgentEnv({ env: { HOME: '/tmp/home', [name]: proxied }, warn: (m) => warnings.push(m) });
    const value = built[name];
    assert(typeof value === 'string', `${name} must still reach the child, or egress stops traversing the proxy`);
    assert(!value.includes('@') && !value.includes(userinfo), `${name}: the userinfo must NOT reach the child (got ${value})`);
    assert(value.includes('proxy.invalid:8080'), `${name}: the host and port must survive, so the egress path is unchanged`);
    assert(warnings.some((w) => w.includes(name)), `${name}: the operator must be told BY NAME that a credential was removed`);
    assert(!warnings.some((w) => w.includes(userinfo)), `${name}: the warning must never carry the value`);
  }

  // 2. CONTROL for the other direction: a credential-free proxy passes through byte-identical, so this
  // cannot be satisfied by breaking ordinary proxying.
  const plain = 'http://proxy.invalid:8080';
  const plainBuilt = buildAgentEnv({ env: { HOME: '/tmp/home', HTTPS_PROXY: plain }, warn: () => {} });
  assert(plainBuilt.HTTPS_PROXY === plain, 'a credential-free proxy must pass through untouched');

  // 3. The operator's explicit --agent-env choice still wins, which is what makes this a withholding
  // rather than removing the capability.
  const optIn = buildAgentEnv({
    env: { HOME: '/tmp/home', HTTPS_PROXY: proxied },
    extra: { HTTPS_PROXY: proxied },
    warn: () => {},
  });
  assert(optIn.HTTPS_PROXY === proxied, '--agent-env must still pass the full value, by explicit operator choice');

  // 4. FAIL CLOSED on userinfo that cannot be parsed, announced by name and never by value.
  const oddWarnings = [];
  const odd = buildAgentEnv({
    env: { HOME: '/tmp/home', HTTPS_PROXY: `${userinfo}@proxy.invalid:8080` },
    warn: (m) => oddWarnings.push(m),
  });
  assert(odd.HTTPS_PROXY === undefined, 'an unparseable credential-bearing proxy must be withheld, not guessed at');
  assert(oddWarnings.some((w) => w.includes('HTTPS_PROXY')), 'withholding it must be announced by name');
  assert(!oddWarnings.some((w) => w.includes(userinfo)), 'and never by value');

  // 4b. The OPPOSITE case, and the reason the two must be told apart: a PROTOCOL-RELATIVE value does have a
  // determinable host, so shape (c) applies to it - keep the proxy and drop the credential. Withholding it
  // would remove the PROXY and send the child out directly, the quiet egress-policy bypass that decision
  // rejected (web-uplift-2rw1, coordinator). The scheme-less value above has no host at all and stays
  // withheld; a proxy URL is what the operator set to make egress traverse it, and a warning does not
  // preserve egress.
  const relWarnings = [];
  const rel = buildAgentEnv({
    env: { HOME: '/tmp/home', HTTPS_PROXY: `//${userinfo}@proxy.invalid:8080` },
    warn: (m) => relWarnings.push(m),
  });
  assert(rel.HTTPS_PROXY === '//proxy.invalid:8080/',
    'a protocol-relative proxy must keep its host and lose only the userinfo, not be withheld');
  assert(relWarnings.length === 1 && /removed a credential/.test(relWarnings[0]),
    'and dropping the userinfo must be announced exactly once as a removal');
  assert(!relWarnings.some((w) => w.includes(userinfo)), 'never by value');

  // 5. A credential-named query value is the same class, and the SHARED rule is the arbiter: whatever
  // the sanitiser hands the child must be something that module would not redact again. This is the
  // property that keeps the proxy check and the artifact redactor from disagreeing (web-uplift-lsn3).
  const withQuery = 'http://proxy.invalid:8080/?token=abcdef';
  const queryBuilt = buildAgentEnv({ env: { HOME: '/tmp/home', HTTPS_PROXY: withQuery }, warn: () => {} });
  assert(queryBuilt.HTTPS_PROXY !== withQuery, 'a credential-named query value must not be passed raw');
  assert(!queryBuilt.HTTPS_PROXY.includes('abcdef'), 'the query credential value must not reach the child');
  assert(
    redactUrlCredentialValues(queryBuilt.HTTPS_PROXY) === queryBuilt.HTTPS_PROXY,
    'whatever is passed must be a value the shared rule would not redact again',
  );
  // and the control: a benign query parameter is not this class and must survive, or the rule is
  // simply deleting query strings.
  const benign = 'http://proxy.invalid:8080/?pool=corp';
  const benignBuilt = buildAgentEnv({ env: { HOME: '/tmp/home', HTTPS_PROXY: benign }, warn: () => {} });
  assert(benignBuilt.HTTPS_PROXY === benign, 'a non-credential query parameter must survive untouched');

  // 6. An injected NON-STRING value that carries no credential must not be reported as having had one
  // removed. The sanitiser decides on the STRING form of the value, so the caller has to compare in
  // that same form; comparing the stringified result against the raw value made the warning untrue for
  // exactly this input (found in review of this commit, and it was a real false claim, not a style nit).
  const boxedWarnings = [];
  const boxedBuilt = buildAgentEnv({
    env: { HOME: '/tmp/home', HTTPS_PROXY: new String(plain) },
    warn: (m) => boxedWarnings.push(m),
  });
  assert(boxedBuilt.HTTPS_PROXY === plain, 'a credential-free value must still arrive as that same value');
  assert(
    boxedWarnings.length === 0,
    `a credential-free value must not be reported as having had a credential removed: ${JSON.stringify(boxedWarnings)}`,
  );
  // 7. The withheld message must not assert a credential the value may not have. A credential-free value
  // whose PATH contains '@' on a URL the parser REJECTS takes the withheld path - measured here, and it is
  // the exact URL an earlier revision of the comment above cited as an ordinary example - so a message
  // saying the value "carries a credential" names a reason that is not the reason (web-uplift-k7ba).
  const pathAt = 'https://x.test:99999/a/b@2x.png';
  const pathWarnings = [];
  const pathBuilt = buildAgentEnv({ env: { HOME: '/tmp/home', HTTPS_PROXY: pathAt }, warn: (m) => pathWarnings.push(m) });
  assert(
    pathBuilt.HTTPS_PROXY === undefined,
    'this credential-free value is genuinely unclassifiable and must still fail closed',
  );
  assert(pathWarnings.length === 1, `exactly one warning, and it names the variable: ${JSON.stringify(pathWarnings)}`);
  assert(
    pathWarnings[0].includes('cannot be distinguished from'),
    `the warning must allow that the value may hold no credential: ${pathWarnings[0]}`,
  );
  assert(
    !/it carries a credential\b/.test(pathWarnings[0]),
    `and must not assert one, which is what it did for this input: ${pathWarnings[0]}`,
  );
  // CONTROL: the SAME path-@ URL on a port the parser accepts is unremarkable, and passes byte-identical
  // with no warning. That is the claim the comment's example makes, so binding it here keeps the comment
  // from being illustrated by a URL that quietly takes a different path.
  const pathAtValidPort = 'https://x.test:8080/a/b@2x.png';
  const validWarnings = [];
  const validBuilt = buildAgentEnv({
    env: { HOME: '/tmp/home', HTTPS_PROXY: pathAtValidPort },
    warn: (m) => validWarnings.push(m),
  });
  assert(validBuilt.HTTPS_PROXY === pathAtValidPort, 'a path-@ URL on a valid port must pass untouched');
  assert(validWarnings.length === 0, `and must not warn: ${JSON.stringify(validWarnings)}`);
  // 8. The three boundary shapes review found this sanitiser INHERITING from the shared rule
  // (web-uplift-nxsy). Every one of them came back VERBATIM before the fix - measured, not inferred -
  // which is precisely the disclosure this guard exists to prevent. The fix went into the shared rule,
  // so this section is also a check that the sanitiser really does inherit it rather than merely
  // appearing to. All four spellings again: one spelling standing in for the class is how the original
  // defect was shaped.
  const nxsySecret = 'sec' + 'ret' + 'value';
  const boundaryShapes = [
    [`http://user:pw${'#'}x@proxy.invalid:8080`, 'withheld',
      'a password truncated by # cannot be classified, so the value must be withheld, never passed through'],
    [`http://user:pw${'?'}x@proxy.invalid:8080`, 'withheld',
      'a password truncated by ? is the same shape and gets the same answer'],
    [`http://proxy.invalid:8080/#token=${nxsySecret}`, 'rewritten',
      'a credential-named FRAGMENT parameter must be stripped, not passed through'],
    [`http://proxy.invalid:8080/?pass=${nxsySecret}`, 'rewritten',
      'the ?pass= spelling must be stripped'],
  ];
  for (const [value, kind, why] of boundaryShapes) {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      const warnings = [];
      const built = buildAgentEnv({ env: { HOME: '/tmp/home', [name]: value }, warn: (m) => warnings.push(m) });
      const got = built[name];
      if (kind === 'withheld') {
        assert(got === undefined, `${why} (${name}): got ${JSON.stringify(got)}`);
        assert(warnings.length === 1, `the withholding must be reported exactly once (${name}): ${JSON.stringify(warnings)}`);
        assert(warnings[0].includes(name), `the warning must name the variable (${name}): ${warnings[0]}`);
        assert(!warnings[0].includes(nxsySecret) && !warnings[0].includes('pw'),
          'and must never carry the value it withheld');
      } else {
        assert(typeof got === 'string', `${why} (${name}): expected a value, got ${JSON.stringify(got)}`);
        assert(!got.includes(nxsySecret), `${why} (${name}): got ${JSON.stringify(got)}`);
        assert(redactUrlCredentialValues(got) === got,
          'whatever is passed must be a value the shared rule would not redact again');
      }
    }
  }
  // The controls. Each of these was byte-identical before the fix and must stay that way, because a
  // rule that withholds everything is as useless as one that withholds nothing: a comma list does not
  // parse yet carries no userinfo, an '@' in a path or in the query of a PARSEABLE value is not
  // userinfo, and a plain anchor is not a parameter string.
  for (const control of [
    'http://a.invalid:1,http://b.invalid:2',
    'http://proxy.invalid:8080/a/b@2x.png',
    'http://proxy.invalid:8080/?next=a@b',
    'http://proxy.invalid:8080#section-2',
  ]) {
    const controlWarnings = [];
    const built = buildAgentEnv({ env: { HOME: '/tmp/home', HTTPS_PROXY: control }, warn: (m) => controlWarnings.push(m) });
    assert(built.HTTPS_PROXY === control,
      `a credential-free value must still arrive byte-identically: ${control} -> ${JSON.stringify(built.HTTPS_PROXY)}`);
    assert(controlWarnings.length === 0, `and must not warn: ${JSON.stringify(controlWarnings)}`);
  }
}

export const runnerAgentsTests = [
  testAgentChildEnvProxyCredentials,
  testHeadlessAllowlistIsScoped,
  testHeadlessAllowlistMatchesSkillContract,
  testSkillWriteContractGuard,
  testAgentChildEnvAllowlist,
];

await runSuite(runnerAgentsTests, import.meta.url, { timeoutMs: 60000, concurrency: 1 });
