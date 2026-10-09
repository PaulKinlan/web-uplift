import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyConditions, derivedOut, uint8FromBase64 } from '../common.mjs';
import { sleep, evaluate, navigate } from '../cdp.mjs';

export async function video(client, url, opts, log) {
  await navigate(client, url, {
    settleMs: opts.wait,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });

  const frameDir = mkdtempSync(join(tmpdir(), 'web-uplift-frames-'));
  const frames = [];
  let frameIndex = 0;

  client.Page.screencastFrame(async (params) => {
    const idx = String(frameIndex++).padStart(5, '0');
    const file = join(frameDir, `frame-${idx}.png`);
    writeFileSync(file, uint8FromBase64(params.data));
    frames.push({ file, ts: params.metadata.timestamp });
    try {
      await client.Page.screencastFrameAck({ sessionId: params.sessionId });
    } catch {
      // session may already be stopping
    }
  });

  const durationMs = opts.duration || 3000;
  await client.Page.startScreencast({
    format: 'png',
    everyNthFrame: 1,
    maxWidth: 1280,
    maxHeight: 800,
  });
  log(`[evidence] recording screencast for ${durationMs}ms`);

  // Run the model-supplied interaction (e.g. navigate a route, open a dialog,
  // dispatch events) so the recorded window captures the transition.
  if (opts.interact) {
    try {
      await evaluate(client, opts.interact);
    } catch (err) {
      log(`[evidence] interact script error: ${err.message.split('\n')[0]}`);
    }
  }

  await sleep(durationMs);
  await client.Page.stopScreencast();
  await sleep(100);

  const out = opts.out || derivedOut(url, 'transition', 'mp4');
  const fps = opts.fps || 10;
  let assembled = false;
  let ffmpegNote = '';
  if (frames.length > 0) {
    const res = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-framerate',
        String(fps),
        '-pattern_type',
        'glob',
        '-i',
        join(frameDir, 'frame-*.png'),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-vf',
        'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        out,
      ],
      { encoding: 'utf8' },
    );
    assembled = res.status === 0 && existsSync(out);
    if (!assembled) ffmpegNote = (res.stderr || res.error?.message || '').slice(-400);
  }
  rmSync(frameDir, { recursive: true, force: true });
  return {
    artifact: assembled ? out : null,
    frames: frames.length,
    fps,
    durationMs,
    note: assembled
      ? `MP4 assembled from ${frames.length} screencast frames`
      : `screencast captured ${frames.length} frames but ffmpeg did not produce a file: ${ffmpegNote}`,
  };
}

// heap: HeapProfiler.takeHeapSnapshot, summarised into something readable. We do
// NOT hand the model the raw multi-MB snapshot; we stream it, parse the node
// table, and return aggregate counts by constructor/type plus totals.
