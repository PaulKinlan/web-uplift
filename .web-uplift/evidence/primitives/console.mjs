import { applyConditions, emit } from '../common.mjs';
import { evaluate, withDeadline, sleep, navigate } from '../cdp.mjs';

const CONSOLE_INTERACT_DEADLINE_MS = 250;
const CONSOLE_INTERACT_SILENCE_MS = 250;
const CONSOLE_INTERACT_POLL_MS = 25;

export async function waitForInteractEvidence(collector, beforeCount, deadlineMs) {
  // The loop is the authority on boundedness, not the CLI parser: the
  // programmatic API (gather) never goes through parseArgs, and NaN/Infinity are
  // not nullish, so an `?? default` at the call site does not catch them. A
  // non-finite or non-positive deadline therefore degrades to the default
  // bounded wait instead of making `elapsed >= NaN` false forever (so the
  // silence exit never fires) with sleep(NaN) spinning at 0ms. A numeric string
  // is coerced, so '500' behaves like 500. The parser keeps its own fail-fast
  // guard for CLI typos, which is the better UX there.
  const requested = Number(deadlineMs);
  const effective = Number.isFinite(requested) && requested > 0 ? requested : CONSOLE_INTERACT_DEADLINE_MS;
  const started = Date.now();
  let seen = beforeCount;
  let observed = false;
  let lastEntryAt = 0;
  for (;;) {
    const elapsed = Date.now() - started;
    if (elapsed >= effective) {
      // The deadline ended the wait. It only truncated something if evidence was
      // live; a genuinely quiet interaction is not a pending failure.
      return { waitedMs: elapsed, observed, pending: observed, deadlineMs: effective };
    }
    const count = collector.entries.length;
    if (count > seen) {
      observed = true;
      lastEntryAt = Date.now();
      seen = count;
    }
    if (observed && Date.now() - lastEntryAt >= CONSOLE_INTERACT_SILENCE_MS) {
      return { waitedMs: Date.now() - started, observed, pending: false, deadlineMs: effective };
    }
    // Clamp the final poll to the remaining budget so the deadline is a ceiling.
    await sleep(Math.min(CONSOLE_INTERACT_POLL_MS, Math.max(0, effective - (Date.now() - started))));
  }
}

export async function consolePrimitive(client, url, opts, log, collector) {
  await navigate(client, url, {
    settleMs: opts.wait ?? 1500,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  const beforeInteract = collector.entries.length;
  let interactDeadlineMs = null;
  let interactWaitMs = null;
  let interactObserved = null;
  let interactPending = null;
  if (opts.interact) {
    try {
      await evaluate(client, opts.interact);
    } catch (err) {
      log(`[evidence] interact script error: ${err.message.split('\n')[0]}`);
    }
    const settled = await waitForInteractEvidence(
      collector,
      beforeInteract,
      opts.interactDeadlineMs ?? CONSOLE_INTERACT_DEADLINE_MS,
    );
    interactDeadlineMs = settled.deadlineMs;
    interactWaitMs = settled.waitedMs;
    interactObserved = settled.observed;
    interactPending = settled.pending;
    log(
      `[evidence] console interact: waited ${interactWaitMs}ms; observed=${interactObserved}` +
        (interactPending ? ' (the deadline truncated a still-active wait)' : ''),
    );
  } else {
    // Nothing to wait for beyond the load itself: keep the short settle so
    // entries still in flight over CDP from the load are captured.
    await sleep(250);
  }

  const block = collector.summary();
  log(
    `[evidence] console: ${block.consoleErrorCount} console error(s), ${block.warningCount} warning(s), ${block.exceptionCount} uncaught exception(s), ${block.networkErrorCount} failed request(s)`,
  );
  const result = {
    primitive: 'console',
    url,
    scannedAt: new Date().toISOString(),
    ...(opts.interact
      ? { interactDeadlineMs, interactWaitMs, interactObserved, interactEvidencePending: interactPending }
      : {}),
    console: block,
  };
  return emit(opts, result, client);
}

