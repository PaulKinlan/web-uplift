import { el, styleFor } from './util.js';

// principle: adapt-to-the-user / respects-reduced-motion
// guidance query: "respect reduced motion preference accessible animation"
export default {
  id: 'motion',
  principleId: 'adapt-to-the-user',
  principleCheckId: 'respects-reduced-motion',
  guidanceQuery: 'respect reduced motion preference accessible animation',
  title: 'Ignores reduced-motion preference',
  description:
    'A large, continuously sliding marquee card. Issue mode animates ' +
    'regardless of the user preference. Fixed mode wraps the animation in a ' +
    '@media (prefers-reduced-motion: no-preference) query so it only animates ' +
    'when the user has not asked for less motion.',
  guidance:
    'Emulate prefers-reduced-motion: reduce. Issue mode keeps sliding; fixed ' +
    'mode holds still.',
  mount(section, mode) {
    styleFor(
      section,
      {
        issue: `
          @keyframes mv-slide { from { transform: translateX(0); } to { transform: translateX(40px); } }
          .mv-card { background: #34a853; color: #fff; padding: 1.5rem; border-radius: 8px; }
          @media (prefers-reduced-motion: no-preference) {
            .mv-card { animation: mv-slide 0.8s ease-in-out infinite alternate; }
          }
        `,
        fixed: `
          @keyframes mv-slide { from { transform: translateX(0); } to { transform: translateX(40px); } }
          .mv-card { background: #34a853; color: #fff; padding: 1.5rem; border-radius: 8px; }
          @media (prefers-reduced-motion: no-preference) {
            .mv-card { animation: mv-slide 0.8s ease-in-out infinite alternate; }
          }
        `,
      },
      mode
    );
    section.append(
      el('div', { className: 'mv-card', textContent:
        'In issue mode this slides forever, even under reduced-motion.' })
    );
    return () => {};
  },
};
