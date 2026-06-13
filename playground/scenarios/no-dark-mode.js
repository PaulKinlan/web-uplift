import { el, styleFor } from './util.js';

// principle: adapt-to-the-user / respects-color-scheme
// guidance query: "dark mode prefers-color-scheme" (guidance id: dark-mode)
export default {
  id: 'no-dark-mode',
  principleId: 'adapt-to-the-user',
  principleCheckId: 'respects-color-scheme',
  guidanceQuery: 'dark mode prefers-color-scheme',
  guidanceId: 'dark-mode',
  title: 'No dark mode support',
  description:
    'A card hard-codes a white background and near-black text and never ' +
    'declares color-scheme. Issue mode stays glaring white under ' +
    'prefers-color-scheme: dark. Fixed mode declares color-scheme: light dark ' +
    'and uses light-dark() so surfaces follow the user preference.',
  guidance:
    'Emulate prefers-color-scheme: dark. Issue mode stays white; fixed mode ' +
    'switches to a dark surface.',
  mount(section, mode) {
    styleFor(
      section,
      {
        issue: `
          .ndm-card { background: #ffffff; color: #111111; border: 1px solid #ddd;
            padding: 1rem; border-radius: 8px; }
        `,
        fixed: `
          .ndm-card { color-scheme: light dark;
            background: light-dark(#ffffff, #1e1e1e);
            color: light-dark(#111111, #eeeeee);
            border: 1px solid light-dark(#dddddd, #444444);
            padding: 1rem; border-radius: 8px; }
        `,
      },
      mode
    );
    section.append(
      el('div', { className: 'ndm-card' },
        el('h3', { textContent: 'Account settings' }),
        el('p', { textContent:
          'In issue mode this card ignores your system dark preference and stays white.' })
      )
    );
    return () => {};
  },
};
