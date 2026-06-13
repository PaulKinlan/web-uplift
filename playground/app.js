import { scenarios } from './scenarios/index.js';
import { el } from './scenarios/util.js';

const nav = document.querySelector('#nav');
const view = document.querySelector('#view');
const modeToggle = document.querySelector('#mode-toggle');

// Default mode is "issue" (the seeded modern-UX problems). ?mode=fixed runs
// the corrected implementations - the audit must find nothing in fixed mode.
const mode = new URLSearchParams(location.search).get('mode') === 'fixed' ? 'fixed' : 'issue';
document.body.dataset.mode = mode;
modeToggle.textContent = mode === 'issue' ? 'mode: issue' : 'mode: fixed';
modeToggle.href = (mode === 'issue' ? '?mode=fixed' : location.pathname) + location.hash;

for (const s of scenarios) {
  nav.append(el('a', { href: `#${s.id}`, textContent: s.title }));
}

let unmount = null;

function render() {
  const id = location.hash.slice(1);
  const scenario = scenarios.find((s) => s.id === id) ?? scenarios[0];

  unmount?.();
  unmount = null;
  view.replaceChildren();

  for (const a of nav.children) {
    a.classList.toggle('active', a.getAttribute('href') === `#${scenario.id}`);
  }

  view.append(
    el('h2', { textContent: scenario.title }),
    el('p', { className: 'description', textContent: scenario.description }),
    el('p', { className: 'guidance', textContent: `Demo: ${scenario.guidance}` })
  );
  const section = el('section');
  view.append(section);
  unmount = scenario.mount(section, mode) ?? null;
}

addEventListener('hashchange', render);
render();
