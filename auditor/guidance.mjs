// Modern Web Guidance feed integration.
//
// The knowledge layer is the `modern-web-guidance` npm package (a
// machine-readable feed: list / search / retrieve). During an audit we take a
// principle check's guidanceQuery and `search` for the best-matching guide id,
// so findings can cite a concrete, current guidance id rather than a hard-coded
// rule. Network access is best-effort: if the feed is unreachable, the audit
// still completes (findings just lack a resolved guidanceId).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SKILL_VERSION = '2026_05_16-c5e7870';
const searchCache = new Map();

export async function searchGuidance(query, { log = () => {}, timeoutMs = 60000 } = {}) {
  if (searchCache.has(query)) return searchCache.get(query);
  try {
    const { stdout } = await execFileAsync(
      'npx',
      ['-y', 'modern-web-guidance@latest', 'search', query, '--skill-version', SKILL_VERSION],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout);
    const results = Array.isArray(parsed) ? parsed : parsed.results || [];
    const top = results[0] || null;
    searchCache.set(query, top);
    if (top) log(`[guidance] "${query}" -> ${top.id} (sim ${top.similarity?.toFixed?.(3)})`);
    return top;
  } catch (err) {
    log(`[guidance] search failed for "${query}": ${err.message.split('\n')[0]}`);
    searchCache.set(query, null);
    return null;
  }
}

// Enrich a finding in place with a resolved guidance id/category, unless it
// already carries one. Uses the principle check's guidanceQuery as the search.
export async function enrichWithGuidance(finding, principlesIndex, opts) {
  if (finding.guidanceId) return finding;
  const check = principlesIndex.get(
    `${finding.principleId}:${finding.principleCheckId}`,
  );
  const query = check?.guidanceQuery;
  if (!query) return finding;
  const top = await searchGuidance(query, opts);
  if (top) {
    finding.guidanceId = top.id;
    if (!finding.guidanceCategory && top.category) {
      finding.guidanceCategory = top.category;
    }
  }
  return finding;
}

// Build a lookup of "principleId:checkId" -> check (with guidanceQuery) from
// principles.json.
export function indexPrinciples(principles) {
  const index = new Map();
  for (const p of principles.principles) {
    for (const c of p.checks || []) {
      index.set(`${p.id}:${c.id}`, { ...c, principleId: p.id });
    }
  }
  return index;
}
