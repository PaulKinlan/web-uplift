import { navigate, evaluate, sleep } from '../cdp.mjs';
import { lstatSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { applyConditions, announceCap, emit, round } from '../common.mjs';
import { redactBodyText } from '../redaction.mjs';

export async function dom(client, url, opts, log) {
  await navigate(client, url, {
    settleMs: opts.wait,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  await sleep(150);

  const selectors = opts.selector
    ? opts.selector.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const page = await evaluate(
    client,
    `(() => {
      const collectCss = () => {
        let css = '';
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch { continue; }
          if (!rules) continue;
          for (const rule of rules) css += rule.cssText + '\\n';
        }
        return css;
      };
      const computedFor = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const want = ['display','position','width','height','max-width','min-height',
          'flex-direction','color','background-color','color-scheme','outline','outline-width',
          'outline-style','animation-name','animation-duration','container-type','overflow',
          'box-sizing','font-size'];
        const out = {};
        for (const p of want) out[p] = cs.getPropertyValue(p);
        const r = el.getBoundingClientRect();
        out['__rect'] = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        return out;
      };
      const sels = ${JSON.stringify(selectors)};
      const computed = {};
      for (const s of sels) computed[s] = computedFor(s);
      // The 200000-character cap is REPORTED, never silent: a model that greps
      // the returned css and misses "@container" must be able to tell "the page
      // does not use it" from "the rule was past the cap".
      const html = document.documentElement.outerHTML;
      const css = collectCss();
      const CAP = 200000;
      return {
        title: document.title,
        url: location.href,
        lang: document.documentElement.lang || null,
        hasViewportMeta: !!document.querySelector('meta[name=viewport]'),
        outerHTML: html.slice(0, CAP),
        outerHTMLChars: html.length,
        outerHTMLTruncated: html.length > CAP,
        css: css.slice(0, CAP),
        cssChars: css.length,
        cssTruncated: css.length > CAP,
        computed
      };
    })()`,
  );

  announceCap('dom.outerHTML (characters)', page.outerHTML.length, page.outerHTMLChars, log);
  announceCap('dom.css (characters)', page.css.length, page.cssChars, log);
  if (page.cssTruncated || page.outerHTMLTruncated) {
    log(
      '[evidence] the returned outerHTML/css are INCOMPLETE: probe the live DOM/CSSOM with evaluate --expr (or read --source) before judging anything that depends on the truncated text.',
    );
  }

  const result = { page };

  if (opts.source) {
    const srcDir = resolve(opts.source);
    result.source = readSourceTree(srcDir);
    log(
      `[evidence] read ${result.source.files.length} source file(s) from ${srcDir}` +
        ` (redacted with the HAR names-based pass; ${result.source.redactedFiles} file(s) had a value replaced)` +
        (result.source.skippedFiles.length
          ? `; ${result.source.skippedFiles.length} credential-named file(s) skipped unread`
          : ''),
    );
  }

  return emit(opts, result, client);
}

// Read a local source tree (text files) so the model can reason over the actual
// authored HTML/CSS/JS, not just the rendered output. Skips node_modules, .git,
// binaries, and very large files.
//
// Every file that IS read is REDACTED before it is inlined (web-uplift-obl). A
// real source tree carries API keys, tokens and connection strings in its .json
// and .js, and this result is written into run evidence that is committed and
// republished (scorecard.html, evidence-out/), so a raw read is a disclosure
// waiting to happen on the next publish. The pass is the SAME names-based one
// the HAR path already applies to recorded bodies - redactBodyText - so the two
// artifact paths cannot drift apart and no second redaction implementation
// exists to keep in step.
//
// It is names-based, so it replaces the VALUE of a field whose NAME says
// credential and copies every other byte through untouched. A secret that no
// credential-looking name carries (an unlabelled 40-character string, a base64
// blob) therefore still reaches the artifact, and that residual is stated in
// `redaction.residual` rather than left for the reader to discover. Files AND
// DIRECTORIES whose NAME says credential defeat an in-text pass entirely, so
// they are not read at all: a matching directory is skipped WHOLESALE (the
// fail-closed decision recorded on web-uplift-xwr - descending into e.g.
// secret-utils/ would rely on the in-text pass catching every file inside, and
// one miss is a disclosure, so the deliberate evidence loss is preferred) and
// every skip, file or directory, is recorded in `skippedFiles` - never silent.
const SOURCE_SKIP_DIRS = new Set(['node_modules', '.git', 'reports', 'scratch', 'examples']);
const SOURCE_TEXT_EXT = /\.(html?|css|js|mjs|cjs|ts|tsx|jsx|json|svg|md|txt)$/i;
const SOURCE_HIGH_RISK_NAMES = [
  /^\.env(\..+)?$/i,
  /credential/i,
  /secret/i,
  /\.pem$/i,
  /^firebase\.json$/i,
  /^wrangler\.toml$/i,
];

function isHighRiskSourceName(name) {
  return SOURCE_HIGH_RISK_NAMES.some((re) => re.test(name));
}

// Recorded in every source-bearing artifact: what was applied, and what it does
// NOT cover. A reader must be able to tell a redacted tree from a raw one, and a
// redacted tree from a complete one.
const SOURCE_REDACTION = {
  applied: true,
  method: 'redactBodyText',
  basis:
    'names-based, the same pass the HAR bodies use: the VALUE of every field whose NAME looks like a credential becomes "[redacted]"; every other byte is unchanged',
  skippedNames: ['.env*', '*credentials*', '*secret*', '*.pem', 'firebase.json', 'wrangler.toml'],
  residual:
    'a secret that no credential-looking name carries (an unlabelled opaque string, a base64 blob) can still reach this artifact, and a credential-named file or directory is skipped unread rather than redacted - a matching DIRECTORY is dropped wholesale (fail-closed, recorded in skippedFiles) - so its contents are absent evidence. Treat a source read as sensitive whenever the tree handles credentials.',
};

export function readSourceTree(dir) {
  const acc = { files: [], skippedFiles: [], redactedFiles: 0 };
  walkSourceTree(resolve(dir), resolve(dir), acc, 0);
  return { ...acc, redaction: SOURCE_REDACTION };
}

// A symlink escapes the tree by definition unless it is resolved and checked
// against the root, so the fail-closed decision is to never follow one: an
// innocuous-named link (notes.txt -> ~/.ssh/id_rsa) is recorded as skipped
// evidence loss, not read; a link to a directory (vendor -> /etc) is not
// recursed; and a self-referential link loop can therefore never recurse.
const SOURCE_MAX_DEPTH = 64;

function walkSourceTree(dir, base, acc, depth) {
  if (depth > SOURCE_MAX_DEPTH) {
    // A cycle that survived the symlink skip (or an absurdly deep real tree) is
    // refused here, never recursed unboundedly.
    acc.skippedFiles.push({ path: relative(base, dir), reason: 'depth-limit' });
    return;
  }
  for (const name of readdirSync(dir)) {
    if (SOURCE_SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const path = relative(base, full);
    if (isHighRiskSourceName(name)) {
      acc.skippedFiles.push({ path, reason: 'high-risk-name' });
      continue;
    }
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      acc.skippedFiles.push({ path, reason: 'symlink' });
      continue;
    }
    if (st.isDirectory()) {
      walkSourceTree(full, base, acc, depth + 1);
    } else if (SOURCE_TEXT_EXT.test(name) && st.size < 256 * 1024) {
      const raw = readFileSync(full, 'utf8');
      const content = redactBodyText(raw);
      const redacted = content !== raw;
      if (redacted) acc.redactedFiles += 1;
      acc.files.push({ path, content, redacted });
    }
  }
}

// evaluate: run a model-supplied expression in the page. The model's escape
// hatch for ad-hoc probes and static tests it writes on the spot.
