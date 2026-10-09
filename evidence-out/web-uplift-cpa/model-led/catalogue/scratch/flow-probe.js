(async () => {
  const snip = (t, n = 240) => (t || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const get = async (u, init) => {
    try {
      const r = await fetch(u, Object.assign({ redirect: 'manual' }, init || {}));
      const t = await r.text();
      const title = (t.match(/<title>([^<]*)<\/title>/i) || [])[1] || null;
      return { url: u, method: (init && init.method) || 'GET', status: r.status, type: r.type, contentType: r.headers.get('content-type'), title, bodySample: snip(t.replace(/<[^>]+>/g, ' ')) };
    } catch (e) { return { url: u, error: String(e) }; }
  };
  const fields = [...document.querySelectorAll('input,select,textarea,button')].map(el => ({
    tag: el.tagName.toLowerCase(), id: el.id || null, name: el.name || null, type: el.type || null,
    form: el.form ? el.form.id : null,
    label: el.labels && el.labels[0] ? el.labels[0].textContent.trim() : null,
    required: !!el.required, min: el.min || null, max: el.max || null, step: el.step || null,
    pattern: el.pattern || null, inputmode: el.inputMode || null, autocomplete: el.getAttribute('autocomplete'),
    spellcheck: el.getAttribute('spellcheck'), autocapitalize: el.getAttribute('autocapitalize'), autocorrect: el.getAttribute('autocorrect'),
    placeholder: el.placeholder || null, ariaDescribedby: el.getAttribute('aria-describedby'), value: el.value || null,
    validity: el.willValidate ? { valid: el.checkValidity(), message: el.validationMessage } : null,
  }));
  const forms = [...document.forms].map(f => ({ id: f.id, method: f.getAttribute('method'), action: f.action, role: f.getAttribute('role'), ariaLabel: f.getAttribute('aria-label'), checkValidityEmpty: f.checkValidity() }));
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => h.tagName + ': ' + h.textContent.trim());
  const links = [...document.querySelectorAll('a')].map(a => ({ text: a.textContent.trim(), href: a.href, current: a.getAttribute('aria-current'), inNav: a.closest('nav') ? a.closest('nav').getAttribute('aria-label') : null }));
  const articles = [...document.querySelectorAll('article')].map(a => ({ heading: a.querySelector('h1,h2,h3,h4')?.textContent.trim(), hasLink: !!a.querySelector('a'), hasButton: !!a.querySelector('button'), hasPrice: /[£$€]\s?\d|\d+[.,]\d{2}/.test(a.textContent), hasPartNumber: /\b[A-Z]{1,4}-?\d{2,}\b/.test(a.textContent), text: snip(a.textContent, 160) }));
  // Layout: where does each main child land in the grid?
  const mainKids = [...document.querySelector('main').children].map(el => { const r = el.getBoundingClientRect(); return { el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : ''), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
  // Flows
  const fd = new URLSearchParams({ item: 'Bearing 12mm', quantity: '1' });
  const flows = await Promise.all([
    get('/'), get('/cart'), get('/search?q=bearing'), get('/search?page=2'), get('/search'),
    get('/cart', { method: 'POST', body: fd, headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    get('/robots.txt'), get('/sitemap.xml'), get('/catalogue/bearing-12mm'), get('/no-such-page-xyz'),
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
    isSecureContext, publicKeyCredential: typeof PublicKeyCredential !== 'undefined', modelContext: typeof navigator.modelContext !== 'undefined',
    usedJSHeapSize: performance.memory ? performance.memory.usedJSHeapSize : null,
    physicalProps: (() => { let n = 0; for (const s of document.styleSheets) for (const r of s.cssRules) { if (r.style) for (const p of r.style) if (/(left|right)$/.test(p) && !/^(border-(top|bottom)-(left|right)-radius)$/.test(p)) n++; } return n; })(),
    rootFontSize: getComputedStyle(document.documentElement).fontSize, bodyFont: getComputedStyle(document.body).fontSize,
  };
  return { meta, forms, fields, headings, links, articles, mainKids, flows };
})()
