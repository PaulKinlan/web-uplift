({
  navigatorLanguage: navigator.language,
  resolvedLocale: Intl.DateTimeFormat().resolvedOptions().locale,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  htmlLang: document.documentElement.lang,
  dir: document.documentElement.dir || null,
  computedDirection: getComputedStyle(document.body).direction,
  textSample: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
  timeElements: document.querySelectorAll('time').length,
  scripts: document.scripts.length
})
