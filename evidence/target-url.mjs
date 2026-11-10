// Target-URL scheme gate (web-uplift-fs20): the ONE allow-list a caller-supplied
// audited target must pass before it becomes a Chrome navigation.
//
// The bug this closes: flow replay has refused non-web schemes since web-uplift-w0zq
// (classifyReplayUrl, runner/flow.mjs), but the AUDIT target had no gate at all -
// `node evidence/cli.mjs <primitive> <url>` drove the URL straight into
// Page.navigate. The URL can arrive from the MCP surface (web-uplift-8m4y, where
// caller-supplied args are concatenated into the agent's instructions), so the chain
// was caller -> instruction -> target URL -> Chrome with nothing in between:
// `file:` reads the local disk into the browser, and `javascript:`/`data:` execute
// in a page context - a disclosure/execution primitive rather than a fetch.
//
// WHERE THE GATE LIVES: gather() in evidence/cli.mjs, the harness boundary every
// caller funnels through - the CLI passes the argv URL there, and the MCP web-audit
// prompt (mcp/skills-server.mjs) validates its url argument with THIS SAME function
// before it renders the skill into instructions (the agent then runs this CLI, whose
// gather() re-checks at the navigation boundary). One allow-list, two doors, so the
// two surfaces cannot drift apart the way they did before.
//
// THE OPT-IN: auditing a non-web target is sometimes deliberate (a local fixture
// file, a data: document). `--allow-scheme <scheme,..>` widens THIS RUN's allow-list
// scheme by scheme - one flag never grants every scheme - and the opt-in is
// RECORDED: gather() attaches the full policy (allow-list, opt-in, url, scheme) to
// the JSON result as `targetUrlPolicy`, and logs it, so an artifact produced under
// an opt-in says so on its face.
//
// SCOPE AND THE RECORDED GAP (web-uplift-fs20 acceptance 4): this gate decides the
// CALLER-SUPPLIED TARGET URL only, at the one place it becomes a navigation. It does
// NOT police what happens after an allowed navigation: server redirects and
// page-initiated frame/subresource loads are the audited page's own behaviour, and
// blocking them here would change what an audit observes. Chrome's own rules still
// bound that surface: a page loaded from http(s) cannot load file: subresources, and
// per the fetch specification a navigation redirect to a non-http(s) scheme is not
// followed. The Node-side fetches a page can cause are covered separately and PER
// HOP by safeFetch (assertPageDerivedFetchAllowed in evidence/fetch.mjs: scheme plus
// private-address guards on every redirect hop), and flow replay keeps its own gate
// (classifyReplayUrl, web-uplift-w0zq) because a flow step is untrusted input rather
// than the operator's chosen target.

export const TARGET_URL_SCHEMES = new Set(['http:', 'https:']);

// 'file' -> 'file:' ; 'HTTPS:' -> 'https:' ; anything else is a typo, and a typo
// must be refused, not silently dropped from the opt-in (an opt-in that does not
// apply is an audit that fails confusingly later).
export function normalizeScheme(raw) {
  const s = String(raw).trim().toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:?$/.test(s)) {
    throw new Error(`refused: "${String(raw).slice(0, 40)}" is not a URL scheme (expected e.g. "file" or "file:")`);
  }
  return s.endsWith(':') ? s : `${s}:`;
}

// Accepts the CLI's `--allow-scheme file,data` string or an array of the same.
export function parseSchemeOptIn(raw) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return list.map((v) => normalizeScheme(v));
}

// Validate a caller-supplied audited target, or throw a clear refusal. Returns
// { url, scheme, optIn, policy }; `policy` is the record that goes on the result.
export function assertTargetUrlAllowed(rawUrl, { optInSchemes } = {}) {
  const optIn = parseSchemeOptIn(optInSchemes);
  const shown = String(rawUrl ?? '').slice(0, 120);
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    // A scheme-less value like "example.com" is the operator mistake this message
    // exists to fix fast, so say THAT rather than "Invalid URL".
    if (/^[a-z][a-z0-9+.-]*:/i.test(String(rawUrl ?? ''))) {
      throw new Error(`refused: "${shown}" is not a valid URL (the scheme is there but the rest does not parse; an absolute URL is required)`);
    }
    throw new Error(`refused: "${shown}" has no URL scheme - the audited target must be an absolute URL, e.g. https://${shown}`);
  }
  if (!TARGET_URL_SCHEMES.has(parsed.protocol) && !optIn.includes(parsed.protocol)) {
    const name = parsed.protocol.replace(/:$/, '');
    throw new Error(
      `refused: target URL scheme "${parsed.protocol}" is not http(s) or https - the audited target must be a web page (web-uplift-fs20). ` +
        `To audit this scheme deliberately, pass --allow-scheme ${name} (the opt-in is recorded in the output).`,
    );
  }
  const policy = {
    allowed: [...TARGET_URL_SCHEMES],
    optIn,
    url: parsed.href,
    scheme: parsed.protocol,
  };
  return { url: parsed, scheme: parsed.protocol, optIn, policy };
}

// Attach the policy record to a primitive result so an artifact produced under an
// opt-in (or a plainly allowed target) carries its own provenance. Primitives that
// do not return an object (evaluate can return a bare string/number) cannot carry a
// field; the CLI log line is the record there, which is why gather() logs too.
export function recordTargetUrlPolicy(result, policy) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    result.targetUrlPolicy = policy;
  }
  return result;
}
