export function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Meaningful content words (>=4 chars, lowercased) for the overlap measure, so
// coverage reflects real content rather than boilerplate/markup.
export function contentTokens(text) {
  const set = new Set();
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []) set.add(w);
  return set;
}

// Is a rendered string visible to a crawler that does NOT run JavaScript?
// Compare CONTENT TOKENS, not a raw substring: innerText collapses inline markup
// and line breaks, so a server-rendered `<h1>Hello. I am <span>Paul Kinlan</span>.</h1>`
// renders as "Hello. I am Paul Kinlan." and never appears verbatim in the
// stripped raw text - which reported server-rendered headings as missing
// (web-uplift-406). Asking whether every content word reaches the raw HTML does
// not care about the punctuation or markup between the words. Values too short
// to tokenise ("Hi") fall back to a whitespace-normalised comparison so a short
// string is not reported as present by default.
export function contentPresentInRaw(renderedValue, rawText) {
  const value = String(renderedValue ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return false;
  const tokens = contentTokens(value);
  if (tokens.size === 0) {
    const haystack = String(rawText ?? '').replace(/\s+/g, ' ').toLowerCase();
    return haystack.includes(value.toLowerCase());
  }
  const rawTokens = contentTokens(rawText);
  for (const token of tokens) if (!rawTokens.has(token)) return false;
  return true;
}

// Known SPA mount roots that ship EMPTY in the server HTML and are filled by JS
// - a strong "invisible to non-JS crawlers" tell.
export function detectEmptyMounts(html) {
  const found = [];
  const patterns = [
    ['#root', /<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i],
    ['#app', /<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i],
    ['#__next', /<div[^>]+id=["']__next["'][^>]*>\s*<\/div>/i],
    ['#__nuxt', /<div[^>]+id=["']__nuxt["'][^>]*>\s*<\/div>/i],
  ];
  for (const [name, re] of patterns) if (re.test(html)) found.push(name);
  return found;
}

// A host belongs to a base name when it IS that name or a subdomain of it: the
// label-boundary form, never a bare suffix match, so 'evil-example.com' is not
// part of 'example.com'. The trackers first-party test and the cookies domain
// test both go through this ONE helper, because the cookies call site survived
// the trackers fix (web-uplift-w1t) by keeping its own copy of the raw suffix
// comparison (web-uplift-yu8).
export function isFirstPartyHost(host, base) {
  return (
    typeof host === 'string' &&
    typeof base === 'string' &&
    base !== '' &&
    (host === base || host.endsWith('.' + base))
  );
}

// A cookie belongs to the page when its domain (RFC 6265, maybe dot-prefixed)
// labels the page host: the same label-boundary comparison, after the leading dot
// is stripped. So 'evil-example.com' does not label 'example.com' and a page on
// 'evil-example.com' is not labelled by 'example.com', while a real subdomain of
// the cookie domain still is (web-uplift-yu8).
export function isThirdPartyCookie(pageHost, domain) {
  const host = typeof domain === 'string' ? domain.replace(/^\./, '') : '';
  return !!domain && !isFirstPartyHost(pageHost, host);
}
