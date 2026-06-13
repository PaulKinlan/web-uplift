import { el, styleFor } from './util.js';

// principle: adapt-to-the-device / responsive-no-horizontal-scroll
// guidance query: "responsive layout adapt to viewport mobile"
export default {
  id: 'fixed-layout',
  principleId: 'adapt-to-the-device',
  principleCheckId: 'responsive-no-horizontal-scroll',
  guidanceQuery: 'responsive layout adapt to viewport mobile',
  title: 'Fixed, non-adaptive layout',
  description:
    'A hero and content column with a hard-coded 1200px width. Issue mode ' +
    'forces a desktop layout on every viewport, so on a phone the user gets ' +
    'horizontal scrolling and clipped content. Fixed mode uses max-width plus ' +
    'a fluid width so the layout adapts down to small screens.',
  guidance:
    'Resize to a 360px-wide viewport. Issue mode shows a horizontal scrollbar ' +
    'and the .hero overflows; fixed mode fits.',
  mount(section, mode) {
    styleFor(
      section,
      {
        issue: `
          .fl-hero { width: 1200px; padding: 2rem; background: #1a73e8; color: #fff; border-radius: 8px; }
          .fl-body { width: 1200px; margin-top: 1rem; }
        `,
        fixed: `
          .fl-hero { width: 100%; max-width: 1200px; box-sizing: border-box; padding: 2rem; background: #1a73e8; color: #fff; border-radius: 8px; }
          .fl-body { width: 100%; max-width: 1200px; margin-top: 1rem; }
        `,
      },
      mode
    );
    section.append(
      el('div', { className: 'fl-hero' }, el('h3', { textContent: 'Big hero headline' })),
      el('div', { className: 'fl-body', textContent:
        'This column is a fixed 1200px wide in issue mode, so it overflows narrow screens.' })
    );
    return () => {};
  },
};
