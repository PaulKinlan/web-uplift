import { el, styleFor } from './util.js';

// light-dark() is Baseline *Newly available* (2024-05-13, Chrome 123), and the
// guidance feed states the fallback is MANDATORY for browsers that support
// color-scheme but not light-dark(). Without one the whole declaration is
// dropped and the card loses its background and text colour, so the colours are
// declared as custom properties, set from prefers-color-scheme for the fallback
// path, and light-dark() is opted into only where it is supported.
const FALLBACK = `
  :root {
    --ndm-bg-light: #ffffff; --ndm-bg-dark: #1e1e1e;
    --ndm-fg-light: #111111; --ndm-fg-dark: #eeeeee;
    --ndm-bd-light: #dddddd; --ndm-bd-dark: #444444;
    --ndm-bg: var(--ndm-bg-light); --ndm-fg: var(--ndm-fg-light);
    --ndm-bd: var(--ndm-bd-light);
  }
  @media (prefers-color-scheme: dark) {
    :root { --ndm-bg: var(--ndm-bg-dark); --ndm-fg: var(--ndm-fg-dark);
            --ndm-bd: var(--ndm-bd-dark); }
  }
`;

const CARD = `
  .ndm-card { color-scheme: light dark; background: var(--ndm-bg);
    color: var(--ndm-fg); border: 1px solid var(--ndm-bd);
    padding: 1rem; border-radius: 8px; }
  @supports (color: light-dark(white, black)) {
    .ndm-card {
      background: light-dark(var(--ndm-bg-light), var(--ndm-bg-dark));
      color: light-dark(var(--ndm-fg-light), var(--ndm-fg-dark));
      border-color: light-dark(var(--ndm-bd-light), var(--ndm-bd-dark));
    }
  }
`;

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
        issue: `${FALLBACK}${CARD}`,
        fixed: `${FALLBACK}${CARD}`,
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
