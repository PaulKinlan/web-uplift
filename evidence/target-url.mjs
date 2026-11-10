// Target-URL scheme gate (web-uplift-fs20): the ONE allow-list a caller-supplied
// audited target must pass before it becomes a Chrome navigation.
//
// REDACTION NOTE (web-uplift-alwp): the policy RECORD redacts the URL through the
// repo's names-based URL redactor (redactUrlCredentialValues) before it is handed
// to any caller - a target like https://user:pass@host/ or .../?session=... would
// otherwise write its credentials into stdout JSON and every audit artifact that
// carries targetUrlPolicy. The NAVIGATION is deliberately NOT redacted: the browser
// must load the real target (a session'd page is the page being audited); only the
// recorded provenance is made safe to share, the same split the HAR and log
// redaction already make between what is fetched and what is kept.
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
// caller funnels through. The CLI passes the argv URL there; the MCP web-audit
// prompt (mcp/skills-server.mjs) embeds the SKILL whose ONLY invocation forms are
// this same CLI (`node evidence/cli.mjs`, `node .web-uplift/evidence/cli.mjs`,
// `web-uplift evidence`), so the MCP path has exactly one route to Chrome and that
// route ends at this gate. ONE allow-list, both paths, so they cannot drift apart
// the way flow replay and the audit target did. A surface-side constraint of the
// MCP url ARGUMENT itself (before it becomes instruction text) is a different
// fault - web-uplift-8m4y, a different owner - and can reuse this module's
// assertTargetUrlAllowed when it lands.
//
// THE OPT-IN: auditing a non-web target is sometimes deliberate (a local fixture
// file, a data: document). `--allow-scheme <scheme,..>` widens THIS RUN's allow-list
// scheme by scheme - one flag never grants every scheme - and the opt-in is
// RECORDED: gather() attaches the full policy (allow-list, opt-in, url, scheme) to
// the JSON result as `targetUrlPolicy`, and logs it, so an artifact produced under
// an opt-in says so on its face.
//
// SCOPE AND THE RECORDED GAP (web-uplift-fs20 acceptance 4): this gate decides the
// CALLER-SUPPLIED TARGET URL only, at the one place it becomes a navigation, and by
// SCHEME only. It does NOT police what happens after an allowed navigation: server
// redirects and page-initiated frame/subresource loads are the audited page's own
// behaviour, and blocking them here would change what an audit observes. Chrome's
// own rules still bound that surface: a page loaded from http(s) cannot load file:
// subresources, and per the fetch specification a navigation redirect to a
// non-http(s) scheme is not followed. The Node-side fetches a page can cause are
// covered separately and PER HOP by safeFetch (assertPageDerivedFetchAllowed in
// evidence/fetch.mjs: scheme plus private-address guards on every redirect hop),
// and flow replay keeps its own gate (classifyReplayUrl, web-uplift-w0zq) because a
// flow step is untrusted input rather than the operator's chosen target. The
// resolved-address half of that replay threat (private ranges behind an allowed
// scheme) is web-uplift-x1ru; the audited target keeps its operator-choice
// exemption here, the same principle as fetch.mjs's targetOrigin exemption.

import { redactUrlCredentialValues } from './credential-terms.mjs';

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
  // The refusal text and the policy record are both OUTPUTS: run the URL through the
  // names-based URL redactor first (web-uplift-alwp), so a credential-bearing target
  // never reaches stderr or an artifact verbatim. Navigation keeps the real URL.
  const shown = redactUrlCredentialValues(String(rawUrl ?? '')).slice(0, 120);
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
    url: redactUrlCredentialValues(parsed.href),
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
