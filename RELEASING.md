# Releasing web-uplift

A release here is a version bump plus the regenerated install plus a CHANGELOG
entry, landed as its own commit. It is not an npm publish: publishing and tagging
are separate, deliberate acts that need the maintainer (see "Not part of a normal
release" below).

`package.json`'s `version` field is the single source of truth. Everything else
either derives from it or must agree with it.

## The version bump file set

Bump all of these in the release commit, or the tree is inconsistent.

| File | What changes |
| --- | --- |
| `package.json` | `version`. Canonical; every other literal must match it. |
| `.web-uplift/manifest.json` | Generated automatically by `npm run prepare` (or `node install-surface.mjs`) from `package.json`. It is gitignored, not tracked. |
| `package-lock.json` | Two places: the top-level `version` and `packages[""].version`. `npm install` syncs both. |
| `AGENTS.md` | The `### Current release: vX.Y.Z` prose, including what shipped. |
| The per-agent `SKILL.md` copies | Only if they carry a version literal. They currently do not. `.claude/skills/web-audit/SKILL.md` is canonical; `.pi/skills/web-audit/SKILL.md` and `.web-uplift/skill/SKILL.md` are copies of it (`.codex/skills/web-audit` is a symlink); none of the three embeds the package version. The "catalog version" they mention is `guidanceCatalogVersion` from `knowledge/principles.json`, a different number. They change at release time only when the skill itself changed, through the regeneration step. |

Grep the outgoing version literal before declaring the bump done:

```sh
grep -rn "0\.4\.1" package.json package-lock.json AGENTS.md
```

`package-lock.json` is the one that gets missed. It was already stale at the
v0.3.0 release, where it read `0.2.3` while `package.json` said `0.3.0`, and
neither the v0.4.0 nor the v0.4.1 release commit bumped it either: it sat at
`0.3.0` while `package.json` read `0.4.0` and then `0.4.1`, and was only synced
later by an unrelated commit that added a dependency.

## The CHANGELOG entry is mandatory

Every released version gets a `## [X.Y.Z] - YYYY-MM-DD` entry in
`CHANGELOG.md`, written at release time, in the file's existing format
(`### Added` / `### Changed` / `### Fixed` subsections, newest entry at the top,
above the entry for the version it supersedes). It goes in the release commit
itself, so a version cannot be bumped without one.

This was not always enforced and the file rotted: 0.3.0, 0.4.0 and 0.4.1 all
shipped with no entry, and the entries now at the top of `CHANGELOG.md` had to be
reconstructed from git history after the fact. `tests/changelog-version-check.mjs`
exists so that cannot recur silently; see "Enforcement" below.

## Keep the release commit separate

The version bump lands in its own `chore: release vX.Y.Z` commit, on top of the
change commits it releases, never mixed into them. Two reasons, both observed in
this repo's history:

- Version churn reverts independently. Reverting a feature commit must not unwind
  the version, and abandoning a release must not lose the work under it.
- The release commit carries the regenerated per-agent wrappers, keeping change
  commits clean. `.web-uplift/` is generated via `prepare` and gitignored.

The release commit message records what was regenerated and what was
deliberately not done.

## Landing

Rebase the release branch onto the current master tip, then fast-forward master.
Never force-push master. Where two releases stack, base the later one on the
earlier release commit and land them in version order, as v0.4.1 was based on the
v0.4.0 release commit.

`npm test` must be green before landing.

## Not part of a normal release

These need Paul's explicit authorisation. Do not do them as part of a bump, and
do not do them unprompted.

- **`npm publish`.** A release action with real-world effect, and it needs npm
  credentials. The v0.4.0 release commit left it undone on purpose, saying
  publishing "wants the maintainer/coordinator to call it" and that the branch is
  publish-ready.
- **`git tag vX.Y.Z` and pushing tags.** Same authorisation. For what it is
  worth, only `v0.1.3` is actually tagged in this repo; 0.4.0 and 0.4.1 were
  released without tags.

One step sits between the two groups, and the distinction matters:

- **`node bin/web-uplift.mjs install --agent all`** is the documented
  regeneration step (`AGENTS.md`, and both the v0.4.0 and v0.4.1 release commits
  ran it). It is local and needs no credentials. But it rewrites the contended
  vendored trees in one shot: `.web-uplift/**`, the `.pi` skill copy, every
  agent's command wrapper, and the `<!-- web-uplift:install -->` managed block in
  the agent instruction files. So during a multi-lane release an agent must not
  run it unprompted; the release owner runs it, last, before the release commit.

## Enforcement

```sh
node tests/changelog-version-check.mjs         # checks package.json's version
node tests/changelog-version-check.mjs 0.4.1   # checks an explicit version
```

Exit 0 when `CHANGELOG.md` has an entry for that version. Exit 1 when it does
not, naming both the missing version and the newest entry the file does have.
Exit 2 on a usage error. It is dependency-free on purpose: it reads two files, so
it runs on a bare checkout before `npm ci`.

`.github/workflows/changelog-version.yml` runs it on every push and pull request.
