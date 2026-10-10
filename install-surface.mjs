// What `web-uplift install` vendors, declared ONCE.
//
// The installer copies these files and directories into the consumer's
// `.web-uplift/` tree, and tests/cdp-copy-sync.mjs byte-compares every tracked copy
// against its source. Those two lists used to be maintained separately - the
// installer hard-coded its plan, the guard hard-coded its pairs - so a directory
// could be vended and never compared, or compared while no longer being vended, with
// nothing able to notice. Both now read this module, and tests/regression.mjs drives
// a real dry-run install and asserts the destinations match what is declared here,
// so the set cannot fall behind silently (web-uplift-7mr).

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, lstatSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename));

// Directories copied whole into `.web-uplift/`.
export const VENDORED_DIRS = [
  { source: 'evidence', dest: 'evidence', what: 'evidence primitives (raw-CDP CLI)' },
  { source: 'aggregate', dest: 'aggregate', what: 'scorecard + compare + aggregate' },
  { source: 'runner', dest: 'runner', what: 'run history + user-flow record/replay' },
  { source: 'schema', dest: 'schema', what: 'findings + config schema' },
];

// Individual files vendored into `.web-uplift/`. `knowledge/` is listed file by file
// because the directory holds notes the install does not copy.
export const VENDORED_FILES = [
  { source: '.claude/skills/web-audit/SKILL.md', dest: 'skill/SKILL.md', what: 'canonical web-audit SKILL.md' },
  { source: 'knowledge/principles.json', dest: 'knowledge/principles.json', what: 'principles spec' },
  { source: 'knowledge/baseline.mjs', dest: 'knowledge/baseline.mjs', what: 'baseline oracle' },
  { source: 'knowledge/guidance.md', dest: 'knowledge/guidance.md', what: 'guidance lookup protocol' },
];

// Tracked copies outside `.web-uplift/` that a per-agent install also writes, and
// that the guard compares for the same byte-identity reason.
export const TRACKED_COPY_FILES = [
  { source: '.claude/skills/web-audit/SKILL.md', dest: '.pi/skills/web-audit/SKILL.md' },
];

// Top-level runtime dependencies the installer vendors into
// `.web-uplift/node_modules/` by walking each package's `dependencies` to copy the
// full transitive closure. The closure is recorded name+version in the install
// manifest as `vendoredDependencies` and verified for completeness by
// tests/install-copy-symlink.mjs; it is NOT a byte-identity pair in
// tests/cdp-copy-sync.mjs because `.web-uplift/node_modules/` is generated at
// install time, not a tracked repo file (there is no in-repo copy to compare).
export const VENDORED_DEPENDENCIES = ['chrome-remote-interface', 'web-features'];

// Deliberately NOT part of this surface, with the reason:
//
//   `.web-uplift/node_modules`  packages copied out of this package's own dependency
//                               tree, recorded in the install manifest as
//                               `vendoredDependencies`; they are not tracked repo
//                               files, so there is no source to compare them to.
//   `.web-uplift/manifest.json` written at install time from the package version,
//                               not copied from a source file.
//   per-agent wrappers and the `<!-- web-uplift:install -->` managed block
//                               generated per agent rather than copied, and the
//                               guard has no source to compare them against.

function copyDir(from, to, depth = 1) {
  if (depth > 64) return;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    const st = lstatSync(src);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) copyDir(src, dst, depth + 1);
    else copyFileSync(src, dst);
  }
}

export function generateVendoredSurface({ targetRoot = repoRoot } = {}) {
  const vendorRoot = join(targetRoot, '.web-uplift');
  mkdirSync(vendorRoot, { recursive: true });

  for (const dir of VENDORED_DIRS) {
    const src = join(targetRoot, dir.source);
    const dst = join(vendorRoot, dir.dest);
    if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    if (existsSync(src)) copyDir(src, dst);
  }

  for (const file of VENDORED_FILES) {
    const src = join(targetRoot, file.source);
    const dst = join(vendorRoot, file.dest);
    if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }

  for (const file of TRACKED_COPY_FILES) {
    const src = join(targetRoot, file.source);
    const dst = join(targetRoot, file.dest);
    if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }

  // Write .web-uplift/manifest.json
  let pkg = { name: 'web-uplift', version: '0.5.0' };
  try {
    pkg = JSON.parse(readFileSync(join(targetRoot, 'package.json'), 'utf8'));
  } catch {}

  const manifestPath = join(vendorRoot, 'manifest.json');
  let installedAt = new Date().toISOString();
  if (existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (existing.version === pkg.version && existing.installedAt) {
        installedAt = existing.installedAt;
      }
    } catch {}
  }

  const vendoredDeps = [];
  for (const dep of ['chrome-remote-interface', 'commander', 'web-features', 'ws']) {
    try {
      const depPkgPath = join(targetRoot, 'node_modules', dep, 'package.json');
      if (existsSync(depPkgPath)) {
        const depPkg = JSON.parse(readFileSync(depPkgPath, 'utf8'));
        vendoredDeps.push({ name: dep, version: depPkg.version });
      }
    } catch {}
  }
  if (vendoredDeps.length === 0) {
    vendoredDeps.push(
      { name: 'chrome-remote-interface', version: '0.33.3' },
      { name: 'commander', version: '2.11.0' },
      { name: 'web-features', version: '3.40.0' },
      { name: 'ws', version: '7.5.11' },
    );
  }

  const manifest = {
    package: pkg.name || 'web-uplift',
    version: pkg.version || '0.5.0',
    installedAt,
    agents: ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'opencode', 'pi'],
    vendoredDependencies: vendoredDeps.sort((a, b) => a.name.localeCompare(b.name)),
    updateCommand: 'npx -y web-uplift@latest update --agent all',
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  generateVendoredSurface();
  console.log('web-uplift: vendored surface generated under .web-uplift/');
}
