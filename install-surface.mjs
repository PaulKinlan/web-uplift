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
