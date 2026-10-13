// Flag parsing for the suite entry points (web-uplift-dipf).
//
// WHY THIS IS ITS OWN MODULE: it used to live in tests/test-helpers.mjs, which every suite entry point
// names, and that file is FULL-GATE-ONLY by policy (web-uplift-5y2w) - so ANY change to flag parsing - a
// one-line guard - refused the fast gate and demanded the full union gate. A flag change is iteration-loop
// work, so it now selects THIS module's own suite instead (speed is a design constraint; docs/speed.md).

const FILTER_USAGE = [
  'usage: node <suite-file>.mjs [--only|--filter|--grep|-o|-f|-g <substring>]... [--list|-l] [--help|-h]',
  '       with no flags the suite runs every case it declares',
].join('\n');

export function parseFilterArgs(argv) {
  const filters = [];
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list' || arg === '-l') {
      list = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(FILTER_USAGE);
      process.exit(0);
    } else if (arg === '--only' || arg === '-o' || arg === '--filter' || arg === '-f' || arg === '--grep' || arg === '-g') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        filters.push(argv[++i]);
      } else {
        console.error(`missing argument for filter flag: ${arg}`);
        process.exit(1);
      }
    } else if (arg.startsWith('--only=')) {
      const val = arg.slice('--only='.length);
      if (!val) { console.error('missing value for --only='); process.exit(1); }
      filters.push(val);
    } else if (arg.startsWith('--filter=')) {
      const val = arg.slice('--filter='.length);
      if (!val) { console.error('missing value for --filter='); process.exit(1); }
      filters.push(val);
    } else if (arg.startsWith('--grep=')) {
      const val = arg.slice('--grep='.length);
      if (!val) { console.error('missing value for --grep='); process.exit(1); }
      filters.push(val);
    } else if (!arg.startsWith('-')) {
      filters.push(arg);
    } else if (arg !== '-') {
      // AN UNKNOWN FLAG REFUSES RATHER THAN RUNS (web-uplift-rpc9). Every branch above is a recognised flag,
      // so before this change anything else was IGNORED and the caller got a full suite run with no
      // indication that the flag meant nothing: `node tests/regression.mjs --help` printed live case output
      // within seconds and kept going. On this CPU-starved shared VM the aggregator is the most expensive
      // command in the repository, so a lane exploring its CLI, or a typo, silently competed with the
      // merger's gate. A bare '-' is left as it was (ignored) rather than refused, since it is not a flag.
      console.error(`unknown flag: ${arg}`);
      console.error(FILTER_USAGE);
      process.exit(1);
    }
  }
  return { filters, list };
}
