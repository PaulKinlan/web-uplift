import { announceCap, emit, round } from '../common.mjs';
import { isThirdPartyCookie } from '../html-text.mjs';
import { navigate } from '../cdp.mjs';

export async function cookies(client, url, opts, log) {
  log('[cookies] auditing ' + url);
  await navigate(client, url, { settleMs: opts.wait || 3000, log });
  let pageHost = '';
  try { pageHost = new URL(url).hostname; } catch {}
  const { cookies: ck } = await client.Network.getCookies({ urls: [url] });
  const analyzed = (ck || []).map(c => {
    const isThirdParty = isThirdPartyCookie(pageHost, c.domain);
    const maxAgeDays = c.expires ? Math.round((c.expires - Date.now() / 1000) / 86400) : null;
    return {
      name: c.name, domain: c.domain, path: c.path,
      secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || 'None',
      isThirdParty: !!isThirdParty, expiryDays: maxAgeDays,
      issues: [
        ...(!c.secure ? ['not Secure'] : []),
        ...(!c.httpOnly && /^(session|auth|token|id)/i.test(c.name) ? ['auth-like cookie not HttpOnly'] : []),
        ...((c.sameSite || 'None') === 'None' ? ['SameSite=None'] : []),
        ...(maxAgeDays && maxAgeDays > 365 ? [`long-lived (${maxAgeDays}d)`] : []),
      ],
    };
  });
  announceCap('cookies.cookies', 50, analyzed.length, log);
  const summary = {
    primitive: 'cookies', url,
    scannedAt: new Date().toISOString(),
    totalCookies: analyzed.length,
    thirdPartyCount: analyzed.filter(c => c.isThirdParty).length,
    insecureCount: analyzed.filter(c => c.issues.length > 0).length,
    cookies: analyzed.slice(0, 50),
    cookiesTruncated: analyzed.length > 50,
    note: 'Descriptive signal. Judge against be-private-and-secure. Cookies without Secure, with SameSite=None, or auth cookies without HttpOnly are security gaps. Long-lived third-party cookies indicate tracking.',
  };
  return emit(opts, summary, client);
}

// --- trackers primitive: third-party tracker enumeration ------------------
