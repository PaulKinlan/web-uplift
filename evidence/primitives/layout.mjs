import { navigate, evaluate, sleep } from '../cdp.mjs';
import { applyConditions, announceCap, emit, round } from '../common.mjs';

export async function layout(client, url, opts, log) {
  // Install observers BEFORE navigation completes settling so buffered entries
  // (and late shifts) are captured.
  await navigate(client, url, {
    settleMs: 0,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  await client.Runtime.evaluate({
    expression: `
      window.__cls = 0;
      window.__shifts = [];
      window.__longTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (!e.hadRecentInput) {
              window.__cls += e.value;
              window.__shifts.push({ value: e.value, startTime: e.startTime });
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__longTasks.push({ duration: e.duration, startTime: e.startTime });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {}
    `,
  });

  // If the model wants to exercise an interaction (e.g. trigger late content),
  // let it; otherwise just settle.
  if (opts.interact) {
    try {
      await evaluate(client, opts.interact);
    } catch (err) {
      log(`[evidence] interact script error: ${err.message.split('\n')[0]}`);
    }
  }
  await sleep(opts.wait);

  const metrics = await client.Page.getLayoutMetrics();
  const observed = await evaluate(
    client,
    // Under a device-metrics override (headless), the layout viewport that
    // matters for overflow is the VISUAL viewport (window.innerWidth can lag
    // the override and report the underlying window width). We reference
    // visualViewport.width so overflow at an emulated mobile size is measured
    // against the size the page is actually being rendered at.
    `(() => {
      const ref = (window.visualViewport && window.visualViewport.width) || window.innerWidth;
      const shifts = window.__shifts || [];
      const longTasks = window.__longTasks || [];
      return {
        cls: window.__cls || 0,
        shifts: shifts.slice(0, 50),
        shiftsTotal: shifts.length,
        shiftsTruncated: shifts.length > 50,
        longTasks: longTasks.slice(0, 50),
        longTasksTotal: longTasks.length,
        longTasksTruncated: longTasks.length > 50,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        visualViewportWidth: (window.visualViewport && window.visualViewport.width) || null,
        hasViewportMeta: !!document.querySelector('meta[name="viewport"]'),
        horizontalOverflowPx: Math.max(0, Math.round(document.documentElement.scrollWidth - ref))
      };
    })()`,
  );

  announceCap('layout.shifts', observed.shifts.length, observed.shiftsTotal, log);
  announceCap('layout.longTasks', observed.longTasks.length, observed.longTasksTotal, log);

  const result = {
    layoutViewport: metrics.layoutViewport,
    visualViewport: metrics.visualViewport,
    cssContentSize: metrics.cssContentSize,
    observed,
  };
  return emit(opts, result, client);
}

// dom: serialise the DOM, computed styles for a set of selectors, the page's
// outer HTML and collected CSS text, and (with --source) the local source tree,
// redacted on the way in (see readSourceTree).
