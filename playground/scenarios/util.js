// Small DOM helper, mirrored from memory-tracer's playground.
export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// Inject a <style> with scenario-scoped CSS into the section, in one of two
// modes. Every scenario ships an "issue" stylesheet (the deliberately seeded
// modern-UX problem) and a "fixed" stylesheet (the Modern Web Guidance fix).
// The audit must flag the issue stylesheet and find nothing in fixed mode.
export function styleFor(section, { issue, fixed }, mode) {
  section.append(el('style', { textContent: mode === 'fixed' ? fixed : issue }));
}
