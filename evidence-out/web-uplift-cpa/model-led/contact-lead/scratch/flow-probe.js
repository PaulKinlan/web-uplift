(async () => {
  const snip = (t, n = 240) => (t || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const get = async (u, init) => {
    try {
      const r = await fetch(u, Object.assign({ redirect: 'manual' }, init || {}));
      const t = await r.text();
      const title = (t.match(/<title>([^<]*)<\/title>/i) || [])[1] || null;
      return { url: u, method: (init && init.method) || 'GET', status: r.status, type: r.type, contentType: r.headers.get('content-type'), location: r.headers.get('location'), title, bodySample: snip(t.replace(/<[^>]+>/g, ' ')) };
    } catch (e) { return { url: u, error: String(e) }; }
  };
  const fields = [...document.querySelectorAll('input,select,textarea,button')].map(el => ({
    tag: el.tagName.toLowerCase(), id: el.id || null, name: el.name || null, type: el.type || null,
    form: el.form ? el.form.id : null,
    label: el.labels && el.labels[0] ? el.labels[0].textContent.trim() : null,
    required: !!el.required, minlength: el.getAttribute('minlength'), maxlength: el.getAttribute('maxlength'),
    pattern: el.pattern || null, inputmode: el.inputMode || null, autocomplete: el.getAttribute('autocomplete'),
    spellcheck: el.getAttribute('spellcheck'), autocapitalize: el.getAttribute('autocapitalize'),
    placeholder: el.placeholder || null, ariaDescribedby: el.getAttribute('aria-describedby'),
    validity: el.willValidate ? { valid: el.checkValidity(), message: el.validationMessage } : null,
  }));
  // Typed-but-invalid email
  const em = document.getElementById('email'); const old = em.value; em.value = 'jo@'; const emailBad = { valid: em.checkValidity(), message: em.validationMessage }; em.value = old;
  // Whitespace-only message passes 'required'?
  const ms = document.getElementById('message'); ms.value = '   '; const wsOnly = ms.checkValidity(); ms.value = '';
  const forms = [...document.forms].map(f => ({ id: f.id, method: f.getAttribute('method'), action: f.action, novalidate: f.noValidate, checkValidityEmpty: f.checkValidity(), hasCsrfField: !!f.querySelector('input[type=hidden]') }));
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => h.tagName + ': ' + h.textContent.trim());
  const links = [...document.querySelectorAll('a')].map(a => ({ text: a.textContent.trim(), href: a.href, current: a.getAttribute('aria-current'), pointsAtThisPage: a.href === location.href, inNav: a.closest('nav') ? a.closest('nav').getAttribute('aria-label') : null }));
  const mainKids = [...document.querySelector('main').children].map(el => { const r = el.getBoundingClientRect(); return { el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
  const phone = [...document.querySelectorAll('dd')].map(d => ({ text: d.textContent.trim(), hasTelLink: !!d.querySelector('a[href^="tel:"]') }));
  const fd = new URLSearchParams({ name: 'Jo Bloggs', email: 'jo@example.com', message: 'Pothole on Mill Lane' });
  const flows = await Promise.all([
    get('/enquiry', { method: 'POST', body: fd, headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    get('/enquiry'), get('/'), get('/inbox'), get('/inbox/'),
    get('/robots.txt'), get('/sitemap.xml'), get('/favicon.ico'), get('/no-such-page-xyz'),
  ]);
  const nav = performance.getEntriesByType('navigation')[0];
  const meta = {
    doctype: document.doctype ? document.doctype.name : null, compatMode: document.compatMode, charset: document.characterSet,
    lang: document.documentElement.lang, dir: document.documentElement.dir || null,
    title: document.title, metaDescription: document.querySelector('meta[name=description]')?.content ?? null,
    canonical: document.querySelector('link[rel=canonical]')?.href ?? null, robotsMeta: document.querySelector('meta[name=robots]')?.content ?? null,
    colorSchemeMeta: document.querySelector('meta[name=color-scheme]')?.content ?? null, themeColor: document.querySelector('meta[name=theme-color]')?.content ?? null,
    manifest: document.querySelector('link[rel=manifest]')?.href ?? null, icon: document.querySelector('link[rel~=icon]')?.href ?? null,
    jsonLd: document.querySelectorAll('script[type="application/ld+json"]').length, ogTags: document.querySelectorAll('meta[property^="og:"]').length,
    hreflang: document.querySelectorAll('link[hreflang]').length,
    scripts: document.scripts.length, inlineHandlers: [...document.querySelectorAll('*')].filter(e => [...e.attributes].some(a => a.name.startsWith('on'))).length,
    elements: document.querySelectorAll('*').length, iframes: document.querySelectorAll('iframe').length, imgs: document.images.length,
    timeEls: document.querySelectorAll('time').length, liveRegions: document.querySelectorAll('[aria-live],[role=alert],[role=status]').length,
    skipLink: !!document.querySelector('a[href^="#"]'),
    nextHopProtocol: nav ? nav.nextHopProtocol : null, transferSize: nav ? nav.transferSize : null,
    isSecureContext, protocol: location.protocol, modelContext: typeof navigator.modelContext !== 'undefined', toolnameAttrs: document.querySelectorAll('[toolname]').length,
    usedJSHeapSize: performance.memory ? performance.memory.usedJSHeapSize : null,
    physicalProps: (() => { let n = 0; for (const s of document.styleSheets) for (const r of s.cssRules) { if (r.style) for (const p of r.style) if (/(left|right)$/.test(p) && !/^(border-(top|bottom)-(left|right)-radius)$/.test(p)) n++; } return n; })(),
    rootFontSize: getComputedStyle(document.documentElement).fontSize, bodyFont: getComputedStyle(document.body).fontSize,
    mutedColor: getComputedStyle(document.querySelector('.lede')).color,
  };
  return { meta, forms, fields, emailBad, whitespaceOnlyMessagePassesRequired: wsOnly, headings, links, mainKids, phone, flows };
})()
