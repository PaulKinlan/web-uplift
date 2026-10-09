import { writeFileSync } from 'node:fs';
import { attachConsoleEvidence } from './cdp.mjs';

// PredefinedNetworkConditions.ts, which mirrors ChromeDevTools/devtools-frontend
// NetworkManager.ts. `mobile-lighthouse` is Lighthouse's APPLIED mobile
// throttling (150ms RTT, 1638.4 kbit/s down / 750 kbit/s up, 4x CPU) - the
// configuration Core Web Vitals thresholds are calibrated against, so it is the
// default archetype a mobile CWV measurement should be taken under.
export const NETWORK_PROFILES = {
  'slow-3g': { latencyMs: 2000, downloadThroughputBps: 50000, uploadThroughputBps: 50000 },
  'fast-3g': { latencyMs: 562.5, downloadThroughputBps: 180000, uploadThroughputBps: 84375 },
  // DevTools/Puppeteer alias of fast-3g (crbug.com/342406608).
  'slow-4g': { latencyMs: 562.5, downloadThroughputBps: 180000, uploadThroughputBps: 84375 },
  'fast-4g': { latencyMs: 165, downloadThroughputBps: 1012500, uploadThroughputBps: 168750 },
  'mobile-lighthouse': {
    latencyMs: 150,
    downloadThroughputBps: (1638.4 * 1000) / 8,
    uploadThroughputBps: (750 * 1000) / 8,
    cpuSlowdownMultiplier: 4,
  },
};

// The device-metrics profile a run is measured under, built in ONE place so the
// emulation and the recorded conditions cannot disagree about it. The profile NAME
// matters as much as the size: mobile emulation changes the layout viewport, the
// meta-viewport handling, touch and the device pixel ratio, so an artifact that
// records only `width`/`height` leaves a reader unable to tell a mobile profile from
// a narrow desktop window. Device metrics default to MOBILE (the long-standing
// --viewport behaviour); a primitive that wants a desktop condition at a fixed size
// passes viewportMobile: false (web-uplift-99i).
export function viewportEmulation(opts) {
  const { w, h } = opts.viewport;
  const mobile = opts.viewportMobile !== false;
  return {
    profile: mobile ? 'mobile' : 'desktop',
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile,
  };
}

export async function applyConditions(client, opts, log) {
  if (opts.emulateMedia && opts.emulateMedia.length) {
    await client.Emulation.setEmulatedMedia({ features: opts.emulateMedia });
    log(
      `[evidence] emulated media: ${opts.emulateMedia
        .map((f) => `${f.name}=${f.value}`)
        .join(', ')}`,
    );
  }
  if (opts.viewport) {
    const { width, height, deviceScaleFactor, mobile } = viewportEmulation(opts);
    await client.Emulation.setDeviceMetricsOverride({
      width,
      height,
      deviceScaleFactor,
      mobile,
      screenWidth: width,
      screenHeight: height,
    });
    log(`[evidence] viewport: ${width}x${height}${mobile ? ' (mobile)' : ''}`);
  }
  if (opts.network) {
    const profile = NETWORK_PROFILES[opts.network];
    if (!profile) {
      throw new Error(
        `Unknown network profile "${opts.network}". One of: ${Object.keys(NETWORK_PROFILES).join(', ')}`,
      );
    }
    await client.Network.emulateNetworkConditions({
      offline: false,
      latency: profile.latencyMs,
      downloadThroughput: profile.downloadThroughputBps,
      uploadThroughput: profile.uploadThroughputBps,
    });
    log(
      `[evidence] network: ${opts.network} (${profile.latencyMs}ms RTT, ` +
        `${profile.downloadThroughputBps} B/s down, ${profile.uploadThroughputBps} B/s up)`,
    );
  }
  const cpuRate = opts.cpuThrottle ?? (opts.network && NETWORK_PROFILES[opts.network]?.cpuSlowdownMultiplier);
  if (cpuRate) {
    if (!(cpuRate >= 1)) throw new Error(`--cpu-throttle must be >= 1, got ${cpuRate}`);
    await client.Emulation.setCPUThrottlingRate({ rate: cpuRate });
    log(`[evidence] cpu throttle: ${cpuRate}x slowdown`);
  }
  if (opts.locale) {
    // Validate loudly up front: a typo'd locale must fail here, not silently
    // judge the page under the default locale.
    try {
      Intl.getCanonicalLocales(opts.locale);
    } catch {
      throw new Error(`Invalid --locale "${opts.locale}" (expected a BCP 47 tag, e.g. de-DE, ar-EG, ja-JP)`);
    }
    await client.Emulation.setLocaleOverride({ locale: opts.locale });
    log(`[evidence] locale: ${opts.locale}`);
  }
  if (opts.timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: opts.timezone });
    } catch {
      throw new Error(`Invalid --timezone "${opts.timezone}" (expected an IANA zone, e.g. America/New_York, Asia/Tokyo)`);
    }
    await client.Emulation.setTimezoneOverride({ timezoneId: opts.timezone });
    log(`[evidence] timezone: ${opts.timezone}`);
  }
}

// The conditions a run was measured under, recorded in every primitive's
// output so a finding can state the device class it was observed on. CWV
// thresholds are calibrated against mid-tier mobile on variable networks; an
// unthrottled headless desktop is the one configuration guaranteed to pass,
// so a performance finding without a conditions block is not interpretable.
export function describeConditions(opts) {
  const conditions = {};
  const profile = opts.network ? NETWORK_PROFILES[opts.network] : null;
  if (profile) conditions.network = { profile: opts.network, ...profile };
  const cpuRate = opts.cpuThrottle ?? profile?.cpuSlowdownMultiplier;
  if (cpuRate) conditions.cpuThrottleRate = cpuRate;
  if (opts.viewport) conditions.viewport = viewportEmulation(opts);
  if (opts.locale) conditions.locale = opts.locale;
  if (opts.timezone) conditions.timezone = opts.timezone;
  if (opts.emulateMedia && opts.emulateMedia.length) conditions.emulateMedia = opts.emulateMedia;
  return Object.keys(conditions).length ? conditions : null;
}

// A cap that drops evidence must say so. Every truncated sample reports what it
// dropped in the JSON (a sibling `<name>Total` + `<name>Truncated`, so a short
// list or string can never be read as the whole page) and warns on stderr here.
export function announceCap(name, shown, total, log) {
  if (total > shown) {
    log(
      `[evidence] WARNING: ${name} truncated: showing ${shown} of ${total}. ` +
        'This sample is INCOMPLETE; a miss in it is not evidence of absence. Gather the rest another way before judging.',
    );
  }
}

// Write a primitive's JSON evidence artifact. The console evidence the page
// produced during this run is joined on first, so the file and stdout agree.
export function emit(opts, result, client) {
  const conditions = describeConditions(opts);
  if (conditions) result.conditions = conditions;
  attachConsoleEvidence(client, result);
  if (opts.out) writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
  return result;
}

export function headerMap(headers) {
  const out = {};
  if (!Array.isArray(headers)) return out;
  for (const h of headers) {
    if (h && h.name) out[h.name.toLowerCase()] = String(h.value ?? '');
  }
  return out;
}

export function headerArray(headers) {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

export function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

export function round(n) {
  return Math.round(n * 100) / 100;
}

export function derivedOut(url, kind, ext) {
  let host = 'page';
  try {
    host = new URL(url).host.replace(/[:.]/g, '_') || 'page';
  } catch {
    // ignore
  }
  return `${host}-${kind}-${Date.now()}.${ext}`;
}

export function uint8FromBase64(b64) {
  // No Node Buffer: decode base64 to a Uint8Array.
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
