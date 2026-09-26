/**
 * Baseline Oracle for web-uplift.
 * Queries web-features for the canonical Baseline browser support status of any
 * web platform feature (CSS property, function, at-rule, HTML element, JS API).
 *
 * Usage:
 *   import { lookupBaseline, formatBaseline } from './baseline.mjs';
 *   const result = lookupBaseline('light-dark');
 *
 * CLI:
 *   node knowledge/baseline.mjs <query> [--json]
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { features } from 'web-features';

// Pre-index BCD compat keys and names for fast lookup.
const compatIndex = new Map();
const nameIndex = new Map();

for (const [id, f] of Object.entries(features)) {
  if (f.name) {
    nameIndex.set(f.name.toLowerCase(), id);
  }
  if (Array.isArray(f.compat_features)) {
    for (const k of f.compat_features) {
      const lowerKey = k.toLowerCase();
      compatIndex.set(lowerKey, id);
      // Index by the last segment (e.g. "position-anchor" from "css.properties.position-anchor")
      const dotIndex = lowerKey.lastIndexOf('.');
      if (dotIndex !== -1) {
        const prop = lowerKey.slice(dotIndex + 1);
        if (!compatIndex.has(prop)) {
          compatIndex.set(prop, id);
        }
      }
    }
  }
}

/**
 * Resolve redirects if a feature entry is an alias / moved record.
 */
function resolveFeature(id, visited = new Set()) {
  const f = features[id];
  if (!f) return null;
  if (visited.has(id)) return null; // Avoid circular redirects
  visited.add(id);

  if (f.redirect_target && features[f.redirect_target]) {
    const target = resolveFeature(f.redirect_target, visited);
    if (target) {
      target.redirectedFrom = target.redirectedFrom || id;
      return target;
    }
  }

  if (Array.isArray(f.redirect_targets) && f.redirect_targets[0] && features[f.redirect_targets[0]]) {
    const target = resolveFeature(f.redirect_targets[0], visited);
    if (target) {
      target.redirectedFrom = target.redirectedFrom || id;
      return target;
    }
  }

  return { id, feature: f, redirectedFrom: null };
}

/**
 * Look up Baseline status for a feature ID, CSS property, function, or keyword.
 *
 * @param {string} rawQuery
 * @returns {object}
 */
export function lookupBaseline(rawQuery) {
  if (!rawQuery || typeof rawQuery !== 'string') {
    return { found: false, query: String(rawQuery ?? ''), error: 'Query must be a non-empty string' };
  }

  const query = rawQuery.toLowerCase().trim().replace(/\(\)$/, '');
  if (!query) {
    return { found: false, query: rawQuery, error: 'Empty query' };
  }

  let resolved = null;

  // 1. Exact feature ID match
  if (features[query]) {
    resolved = resolveFeature(query);
  }

  // 2. Exact feature name match
  if (!resolved && nameIndex.has(query)) {
    resolved = resolveFeature(nameIndex.get(query));
  }

  // 3. Exact BCD compat key or property suffix match
  if (!resolved && compatIndex.has(query)) {
    resolved = resolveFeature(compatIndex.get(query));
  }

  // 4. Try common CSS prefixes if not found
  if (!resolved) {
    for (const prefix of ['css.properties.', 'css.types.', 'css.at-rules.']) {
      const prefixed = prefix + query;
      if (compatIndex.has(prefixed)) {
        resolved = resolveFeature(compatIndex.get(prefixed));
        break;
      }
    }
  }

  if (resolved && resolved.feature) {
    const { id, feature: f, redirectedFrom } = resolved;
    const baseline = f.status?.baseline ?? false;
    const status = baseline === 'high' ? 'widely' : baseline === 'low' ? 'newly' : 'limited';
    const fallbackMandatory = status !== 'widely';
    const lowDate = f.status?.baseline_low_date || null;
    const highDate = f.status?.baseline_high_date || null;

    return {
      found: true,
      id,
      name: f.name || id,
      description: f.description || '',
      status,
      baseline,
      lowDate,
      highDate,
      fallbackMandatory,
      support: f.status?.support || {},
      compatFeatures: f.compat_features || [],
      spec: f.spec || [],
      redirectedFrom,
    };
  }

  // Not found: gather suggestions
  const suggestions = [];
  for (const [id, f] of Object.entries(features)) {
    if (f.name && f.name.toLowerCase().includes(query)) {
      suggestions.push(id);
    } else if (id.includes(query)) {
      suggestions.push(id);
    }
    if (suggestions.length >= 5) break;
  }

  return {
    found: false,
    query: rawQuery,
    suggestions,
  };
}

/**
 * Format a lookup result for terminal or log output.
 */
export function formatBaseline(result) {
  if (!result || !result.found) {
    const sug = result?.suggestions?.length
      ? ` Did you mean: ${result.suggestions.join(', ')}?`
      : '';
    return `Unknown web platform feature "${result?.query || ''}".${sug}`;
  }

  const statusLabel =
    result.status === 'widely'
      ? 'Baseline Widely available'
      : result.status === 'newly'
        ? 'Baseline Newly available'
        : 'Baseline Limited availability';

  const dateInfo = result.lowDate
    ? ` (since ${result.lowDate}${result.highDate ? `, widely since ${result.highDate}` : ''})`
    : '';

  const engines = [];
  if (result.support?.chrome) engines.push(`Chrome ${result.support.chrome}`);
  if (result.support?.firefox) engines.push(`Firefox ${result.support.firefox}`);
  if (result.support?.safari) engines.push(`Safari ${result.support.safari}`);
  if (result.support?.edge) engines.push(`Edge ${result.support.edge}`);
  const supportStr = engines.length ? ` [${engines.join(', ')}]` : '';

  const fallbackStr = result.fallbackMandatory
    ? 'Fallback: MANDATORY (not yet Widely available; use @supports, media queries, or feature detection)'
    : 'Fallback: optional (widely available across modern engines)';

  const redirectStr = result.redirectedFrom ? ` (redirected from "${result.redirectedFrom}")` : '';

  return (
    `${result.name} (${result.id}): ${statusLabel}${dateInfo}${redirectStr}\n` +
    `  Support:${supportStr}\n` +
    `  ${fallbackStr}`
  );
}

// CLI entry point
const isDirectCall =
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    pathToFileURL(process.argv[1]).href === import.meta.url);

if (isDirectCall) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const query = args.find((a) => !a.startsWith('--'));

  if (!query || args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: node knowledge/baseline.mjs <feature-query> [--json]\n' +
      'Check the Baseline status of a web platform feature, CSS property, function or API.\n\n' +
      'Examples:\n' +
      '  node knowledge/baseline.mjs light-dark\n' +
      '  node knowledge/baseline.mjs position-anchor\n' +
      '  node knowledge/baseline.mjs color-scheme --json'
    );
    process.exit(query ? 0 : 1);
  }

  const res = lookupBaseline(query);
  if (jsonMode) {
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.found ? 0 : 1);
  } else {
    if (res.found) {
      console.log(formatBaseline(res));
      process.exit(0);
    } else {
      console.error(formatBaseline(res));
      process.exit(1);
    }
  }
}
