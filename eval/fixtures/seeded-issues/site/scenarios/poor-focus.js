import { el, styleFor } from './util.js';

// principle: adapt-to-the-device / input-modality-aware + accessibility
// guidance query: "visible focus indicator focus-visible keyboard"
export default {
  id: 'poor-focus',
  principleId: 'adapt-to-the-device',
  principleCheckId: 'input-modality-aware',
  guidanceQuery: 'visible focus indicator focus-visible keyboard accessibility',
  title: 'Removed focus states',
  description:
    'Custom buttons with outline: none and no replacement. Issue mode leaves ' +
    'keyboard users with no visible focus indicator at all. Fixed mode uses ' +
    ':focus-visible with a clear outline so keyboard focus is obvious while ' +
    'pointer clicks stay clean.',
  guidance:
    'Tab through the buttons with the keyboard. Issue mode shows no focus ' +
    'ring; fixed mode shows a clear :focus-visible outline.',
  mount(section, mode) {
    styleFor(
      section,
      {
        issue: `
          .pf-btn { outline: none; border: 1px solid #888; background: #f2f2f2;
            padding: 0.5rem 1rem; border-radius: 6px; margin-right: 0.5rem; }
        `,
        fixed: `
          .pf-btn { border: 1px solid #888; background: #f2f2f2;
            padding: 0.5rem 1rem; border-radius: 6px; margin-right: 0.5rem; }
          .pf-btn:focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; }
        `,
      },
      mode
    );
    section.append(
      el('button', { className: 'pf-btn', textContent: 'Save' }),
      el('button', { className: 'pf-btn', textContent: 'Cancel' }),
      el('button', { className: 'pf-btn', textContent: 'Delete' })
    );
    return () => {};
  },
};
