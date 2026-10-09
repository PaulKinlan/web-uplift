import { writeFileSync } from 'node:fs';
import { applyConditions, describeConditions, derivedOut, uint8FromBase64, emit } from '../common.mjs';
import { withDeadline, navigate, evaluate, sleep } from '../cdp.mjs';

export async function screenshot(client, url, opts, log) {
  await navigate(client, url, {
    settleMs: opts.wait,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  await sleep(250);

  let clip;
  if (opts.selector) {
    const box = await evaluate(
      client,
      `(() => {
        const el = document.querySelector(${JSON.stringify(opts.selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`,
    );
    if (box && box.width > 0 && box.height > 0) {
      clip = { ...box, scale: 1 };
    }
  }

  const { data } = await client.Page.captureScreenshot({
    format: 'png',
    captureBeyondViewport: !!opts.fullPage,
    ...(clip ? { clip } : {}),
  });
  const out = opts.out || derivedOut(url, 'screenshot', 'png');
  writeFileSync(out, uint8FromBase64(data));
  const shot = { artifact: out, bytes: data.length, clip: clip || 'full viewport' };
  // Screenshots bypass emit() (the artifact is binary), so attach the
  // conditions here: a rendered screenshot is only interpretable against the
  // locale/timezone/viewport it was taken under.
  const conditions = describeConditions(opts);
  if (conditions) shot.conditions = conditions;
  return shot;
}

// video: record a screencast over an interaction window, assemble with ffmpeg.
// --interact <js> (or --interact-file) is model-supplied code run after capture
// starts, so the model can trigger the transition/animation it wants to record.
