/**
 * Baseline Oracle for web-uplift.
 * Queries web-features for the canonical Baseline browser support status of any
 * web platform feature (CSS property, function, at-rule, selector, HTML element, JS API).
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

// 1. Build exact BCD index (lowercase BCD key -> feature ID)
const exactBcdIndex = new Map();
// 2. Build suffix index tracking all feature IDs with that suffix
const suffixMap = new Map();
// 3. Name index (lowercase feature name -> feature ID)
const nameIndex = new Map();

for (const [id, f] of Object.entries(features)) {
  if (f.name) {
    nameIndex.set(f.name.toLowerCase(), id);
  }
  if (Array.isArray(f.compat_features)) {
    for (const k of f.compat_features) {
      const lowerKey = k.toLowerCase();
      exactBcdIndex.set(lowerKey, id);
      const dotIndex = lowerKey.lastIndexOf('.');
      if (dotIndex !== -1) {
        const suffix = lowerKey.slice(dotIndex + 1);
        if (!suffixMap.has(suffix)) {
          suffixMap.set(suffix, new Set());
        }
        suffixMap.get(suffix).add(id);
      }
    }
  }
}

/**
 * Resolve redirects if a feature entry is an alias, moved, or split record.
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

  if (Array.isArray(f.redirect_targets) && f.redirect_targets.length > 0) {
    const targets = f.redirect_targets
      .map((tId) => resolveFeature(tId, new Set(visited)))
      .filter(Boolean);
    return { id, feature: f, targets, redirectedFrom: null };
  }

  return { id, feature: f, redirectedFrom: null };
}

function computeFeatureStatus(f) {
  const baseline = f.status?.baseline ?? false;
  const status = baseline === 'high' ? 'widely' : baseline === 'low' ? 'newly' : 'limited';
  const fallbackMandatory = status !== 'widely';
  const lowDate = f.status?.baseline_low_date || null;
  const highDate = f.status?.baseline_high_date || null;
  return { status, baseline, fallbackMandatory, lowDate, highDate };
}

/**
 * Look up Baseline status for a feature ID, CSS property, function, selector, or keyword.
 *
 * @param {string} rawQuery
 * @returns {object}
 */
export function lookupBaseline(rawQuery) {
  if (!rawQuery || typeof rawQuery !== 'string') {
    return { found: false, query: String(rawQuery ?? ''), error: 'Query must be a non-empty string' };
  }

  const raw = rawQuery.toLowerCase().trim();
  const query = raw.replace(/\(\)$/, '');
  const stripped = query.replace(/^(:{1,2}|@)/, '');

  if (!query) {
    return { found: false, query: rawQuery, error: 'Empty query' };
  }

  let resolved = null;

  // A. Exact feature ID match (try query, stripped, raw)
  for (const q of [query, stripped, raw]) {
    if (features[q]) {
      resolved = resolveFeature(q);
      break;
    }
  }

  // B. Exact feature name match
  if (!resolved) {
    for (const q of [query, stripped, raw]) {
      if (nameIndex.has(q)) {
        resolved = resolveFeature(nameIndex.get(q));
        break;
      }
    }
  }

  // C. Exact BCD key match
  if (!resolved) {
    for (const q of [query, stripped, raw]) {
      if (exactBcdIndex.has(q)) {
        resolved = resolveFeature(exactBcdIndex.get(q));
        break;
      }
    }
  }

  // D. Standard CSS prefixes against stripped and query
  if (!resolved) {
    const prefixes = [
      'css.properties.',
      'css.types.',
      'css.at-rules.',
      'css.selectors.',
    ];
    for (const q of [stripped, query]) {
      for (const prefix of prefixes) {
        const key = prefix + q;
        if (exactBcdIndex.has(key)) {
          resolved = resolveFeature(exactBcdIndex.get(key));
          break;
        }
      }
      if (resolved) break;
    }
  }

  // E. Suffix match (only if unambiguous)
  if (!resolved) {
    for (const q of [stripped, query]) {
      const owners = suffixMap.get(q);
      if (owners) {
        if (owners.size === 1) {
          const singleId = [...owners][0];
          resolved = resolveFeature(singleId);
          break;
        } else {
          return {
            found: false,
            ambiguous: true,
            query: rawQuery,
            candidates: [...owners],
            error: `Query "${rawQuery}" is ambiguous and matches ${owners.size} features: ${[...owners].join(', ')}`,
          };
        }
      }
    }
  }

  if (resolved) {
    // Case 1: Plural redirect targets (e.g. text-wrap-style)
    if (Array.isArray(resolved.targets) && resolved.targets.length > 0) {
      const targetDetails = resolved.targets.map((t) => {
        const f = t.feature;
        const s = computeFeatureStatus(f);
        return {
          id: t.id,
          featureId: t.id,
          name: f.name || t.id,
          featureName: f.name || t.id,
          description: f.description || '',
          ...s,
          support: f.status?.support || {},
        };
      });

      // Combined status: weakest link determines safety
      const hasLimited = targetDetails.some((t) => t.status === 'limited');
      const hasNewly = targetDetails.some((t) => t.status === 'newly');
      const combinedStatus = hasLimited ? 'limited' : hasNewly ? 'newly' : 'widely';
      const fallbackMandatory = combinedStatus !== 'widely';

      return {
        found: true,
        id: resolved.id,
        featureId: resolved.id,
        name: resolved.feature.name || resolved.id,
        featureName: resolved.feature.name || resolved.id,
        description: resolved.feature.description || '',
        status: combinedStatus,
        baseline: combinedStatus === 'widely' ? 'high' : combinedStatus === 'newly' ? 'low' : false,
        fallbackMandatory,
        targets: targetDetails,
        redirectedFrom: resolved.redirectedFrom || null,
      };
    }

    // Case 2: Single feature
    if (resolved.feature) {
      const { id, feature: f, redirectedFrom } = resolved;
      const s = computeFeatureStatus(f);

      return {
        found: true,
        id,
        featureId: id,
        name: f.name || id,
        featureName: f.name || id,
        description: f.description || '',
        ...s,
        support: f.status?.support || {},
        compatFeatures: f.compat_features || [],
        spec: f.spec || [],
        redirectedFrom: redirectedFrom || null,
      };
    }
  }

  // Not found: gather suggestions
  const suggestions = [];
  for (const [id, f] of Object.entries(features)) {
    if (f.name && f.name.toLowerCase().includes(stripped)) {
      suggestions.push(id);
    } else if (id.includes(stripped)) {
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
    if (result?.ambiguous) {
      return `Query "${result.query}" is ambiguous and matches ${result.candidates.length} features: ${result.candidates.join(', ')}. Please query with a more specific feature ID or BCD key.`;
    }
    const sug = result?.suggestions?.length
      ? ` Did you mean: ${result.suggestions.join(', ')}?`
      : '';
    return `Unknown web platform feature "${result?.query || ''}".${sug}`;
  }

  if (Array.isArray(result.targets) && result.targets.length > 0) {
    const lines = [
      `${result.name} (${result.id}) [split into ${result.targets.length} features]:`,
    ];
    for (const t of result.targets) {
      const statusLabel =
        t.status === 'widely'
          ? 'Widely available'
          : t.status === 'newly'
            ? 'Newly available'
            : 'Limited availability';
      const dateInfo = t.lowDate ? ` (since ${t.lowDate})` : '';
      lines.push(`  - ${t.name} (${t.id}): Baseline ${statusLabel}${dateInfo}`);
    }
    lines.push(`  Combined status: Baseline ${result.status === 'widely' ? 'Widely available' : result.status === 'newly' ? 'Newly available' : 'Limited availability'}`);
    lines.push(`  Fallback: ${result.fallbackMandatory ? 'MANDATORY (contains limited or newly available features)' : 'optional (all targets widely available)'}`);
    return lines.join('\n');
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
      '  node knowledge/baseline.mjs @container\n' +
      '  node knowledge/baseline.mjs :has\n' +
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
