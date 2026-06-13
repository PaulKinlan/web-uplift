# Sourcing top-site URL lists

Options for the Phase 3 batch run, in order of preference:

1. **CrUX rank via HTTP Archive / BigQuery** - the Chrome UX Report assigns
   rank buckets (top 1k, 10k, …). Query the public dataset:

   ```sql
   SELECT DISTINCT origin
   FROM `chrome-ux-report.experimental.global`
   WHERE experimental.popularity.rank <= 1000
     AND yyyymm = 202605
   ```

   Pros: reflects real Chrome traffic, matches the "help the most users"
   goal. Cons: needs a GCP project for BigQuery.

2. **Tranco** (https://tranco-list.eu) - research-grade ranked list, plain
   CSV download, no setup. Good enough for the pilot.

3. **Hand-picked pilot set** (~20 sites we know: a mix of SPAs, news sites,
   e-commerce, docs sites) - use this first to calibrate cost and test-plan
   quality before any large run.

Notes:
- Lists give origins; audit the landing page plus whatever the test plan
  discovers. Logged-in experiences are out of scope for the survey.
- Record blocked/bot-walled sites in reports (status: "blocked") rather than
  retrying - that rate is itself an interesting number.
- For a modern-UX survey, a framework mix matters: capture `page.framework`
  so the aggregate can break findings down per framework.
