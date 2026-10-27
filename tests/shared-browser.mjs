// One browser per suite instead of one per primitive call (web-uplift-91lr).
//
// Measured on this VM (idle, load 0.7) with the repo's own launcher, three runs each:
//
//   launch -> CDP ready      3.3-4.7s   (the process, the profile dir, the DevTools handshake)
//   first session on it      5.0s       (renderer start, profile init, Page/Runtime/DOM/CSS/Network enable)
//   later sessions on it     1.9s each  (same enables, warm browser)
//   about:blank navigation   0.1-0.6s
//   127.0.0.1 stub page      0.7-1.5s
//
// gather() with no browser supplied does the whole dance per call, so a caller that drives several
// primitives pays ~10s per call and ~2.5s when it is handed a browser it does not own. tests/redaction.test.mjs
// alone makes 8 gather() calls, evidence-content 16, evidence-conditions 16: those suites were spending
// minutes in browser STARTS, which is why browser-bound tests in them hit their 30s suite budgets on an idle
// machine (web-uplift-91lr) and took the full gate down with them.
//
// Deliberately opt-in, per suite, and closed by the suite that opened it. A shared browser shares its
// PROFILE - cookies, storage, service workers, HTTP cache - so only a suite whose cases do not need a fresh
// profile may ask for this; evidence/cli.mjs states the same boundary for its own per-call `browser` option,
// and this is the suite-scoped version of it. The alternative (sharing whenever a suite has more than one
// gather call) would silently change the meaning of tests that rely on a clean profile.
import { launchChrome } from '../evidence/cdp.mjs';

let handle = null;
let pending = null;

// Resolves to the browser for this suite, launching it on first use. Concurrent callers share one launch.
export async function sharedBrowser(log = () => {}) {
  if (handle) return handle;
  if (!pending) {
    pending = launchChrome({ log }).then(
      (launched) => {
        handle = launched;
        return launched;
      },
      (err) => {
        // A failed launch must not poison the suite: clear it so the next case retries rather than
        // seeing the same rejection forever.
        pending = null;
        throw err;
      },
    );
  }
  return pending;
}

// Closes the suite's browser. Safe when none was ever launched, and safe to call twice.
export async function closeSharedBrowser() {
  const launched = handle;
  handle = null;
  pending = null;
  if (launched) await launched.close();
}
