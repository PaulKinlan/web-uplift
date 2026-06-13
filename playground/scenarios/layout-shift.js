import { el, styleFor } from './util.js';

// principle: adapt-to-the-device (stable rendering) + performance (CLS)
// guidance query: "prevent layout shift reserve space CLS aspect-ratio"
export default {
  id: 'layout-shift',
  principleId: 'adapt-to-the-device',
  principleCheckId: 'responsive-no-horizontal-scroll',
  guidanceQuery: 'prevent layout shift reserve space CLS aspect-ratio',
  title: 'Cumulative layout shift',
  description:
    'A banner is injected ~600ms after render. Issue mode reserves no space, ' +
    'so the content below jumps down when it arrives (a classic CLS hit). ' +
    'Fixed mode reserves the banner height up front (min-height / aspect-ratio) ' +
    'so nothing shifts.',
  guidance:
    'Reload and watch the text block below the banner. Issue mode shifts it ' +
    'down when the banner loads; fixed mode keeps it still.',
  mount(section, mode) {
    styleFor(
      section,
      {
        issue: `
          .ls-slot { min-height: 76px; }
          .ls-banner { background: #fbbc04; color: #111; padding: 1rem; border-radius: 8px; }
        `,
        fixed: `
          .ls-slot { min-height: 76px; }
          .ls-banner { background: #fbbc04; color: #111; padding: 1rem; border-radius: 8px; }
        `,
      },
      mode
    );
    const slot = el('div', { className: 'ls-slot' });
    section.append(
      slot,
      el('p', { textContent:
        'This paragraph jumps down in issue mode when the banner loads above it.' })
    );
    const t = setTimeout(() => {
      slot.append(el('div', { className: 'ls-banner', textContent: 'Late-loading banner' }));
    }, 600);
    return () => clearTimeout(t);
  },
};
