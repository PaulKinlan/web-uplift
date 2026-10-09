(() => {
  const box = el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  const lh = parseFloat(getComputedStyle(document.body).lineHeight) || 24;
  const aside = document.querySelector('aside');
  const dd = [...aside.querySelectorAll('dd')].map(d => ({ text: d.textContent.trim(), ...box(d), lines: Math.round(box(d).h / lh) }));
  const dt = [...aside.querySelectorAll('dt')].map(d => ({ text: d.textContent.trim(), ...box(d) }));
  const btn = document.querySelector('button');
  return {
    viewport: innerWidth + 'x' + innerHeight,
    aside: box(aside), dlColumns: getComputedStyle(aside.querySelector('dl')).gridTemplateColumns,
    dt, dd,
    buttonBorder: getComputedStyle(btn).borderStyle + ' ' + getComputedStyle(btn).borderWidth,
    containerQueries: [...document.styleSheets].some(s => [...s.cssRules].some(r => r.constructor.name === 'CSSContainerRule')),
  };
})()
