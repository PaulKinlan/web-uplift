# aoo first increment — durability bundle for the paul.kinlan.me fix branch

This directory is the durability copy required because this fleet has **no write
route** to `PaulKinlan/paul.kinlan.me` (the internal mirror is read-only for that
repo; there is no github.com token).

- **Target repo:** `PaulKinlan/paul.kinlan.me` (Hugo + Tailwind + Vercel)
- **Fix branch:** `fleet/aoo-increment`
- **Base:** `a7f42d4` (`origin/main` at the time of the work)
- **TIP (recorded 2026-10-08):** `d2675d5853e6ff1f6a5185c5c0155fc2c80129d6`
  (`d2675d5`)
- **Commits:** `df4fa71` (F-001 dark mode + F-005 font/icon fix), `37568fa`
  (first evidence), `b14b51c` (review fixes: dark article text, moi slate dark,
  open-props order, 400/500/600 `@font-face` for light identity), `d2675d5`
  (refreshed evidence).

## Contents

- `fleet-aoo-increment.bundle` — git bundle of `a7f42d4..fleet/aoo-increment`
  (self-contained delta). Recover with:
  `git clone PaulKinlan/paul.kinlan.me && cd paul.kinlan.me && git fetch /path/to/fleet-aoo-increment.bundle fleet/aoo-increment:fleet/aoo-increment`
- `patches/*.patch` — the same four commits as `git format-patch --binary`,
  appliable in order with `git am`.

## What this is

The plan is `/home/exedev/web-uplift/docs/aoo-first-increment.md` (F-001 dark
mode, F-005 font/icon optimisation). The change was verified in a real headless
Chrome: light mode byte-identical (0 pixel diff), dark mode active
(`color-scheme: light dark`, dark body, light article text), render-blocking
third-party font CSS 2 -> 0, font bytes 1,186,459 -> 48,445 (-95.92%).
Independent cross-family review PASS-with-findings (one no-effect
declaration-order nit; the plan snippet's shadow order conflicts with its own
"copy the vendored block verbatim" instruction).

## IMPORTANT

Nothing here has been merged. Merging to `main` on the target repo **is the live
deployment of Paul's personal site** and is a separate decision for Paul. This
bundle exists only so the reviewed branch is recoverable and reviewable.
