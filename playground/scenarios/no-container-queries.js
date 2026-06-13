import { el, styleFor } from './util.js';

// principle: adapt-to-the-device / component-level-responsiveness
// guidance query: "container queries component responsive"
export default {
  id: 'no-container-queries',
  principleId: 'adapt-to-the-device',
  principleCheckId: 'component-level-responsiveness',
  guidanceQuery: 'container queries component responsive',
  title: 'Component ignores its container size',
  description:
    'A media card is reused in both a wide column and a narrow sidebar. Issue ' +
    'mode keeps a fixed horizontal layout that breaks when the card is placed ' +
    'in the narrow slot. Fixed mode uses a container query so the same ' +
    'component switches to a stacked layout based on its own width, not the ' +
    'viewport.',
  guidance:
    'Compare the same card in the wide vs narrow slot. Issue mode keeps it ' +
    'side-by-side (cramped in the narrow slot); fixed mode stacks it via ' +
    '@container.',
  mount(section, mode) {
    styleFor(
      section,
      {
        issue: `
          .cq-wide, .cq-narrow { border: 1px solid #ccc; border-radius: 8px; padding: 0.75rem; margin-bottom: 1rem; container-type: inline-size; }
          .cq-narrow { width: 240px; }
          .cq-card { display: flex; gap: 0.75rem; align-items: center; }
          .cq-thumb { width: 80px; height: 80px; background: #1a73e8; border-radius: 6px; flex: none; }
        
          @container (max-width: 320px) {
            .cq-card { flex-direction: column; align-items: stretch; }
            .cq-thumb { width: 100%; }
          }
        `,
        fixed: `
          .cq-wide, .cq-narrow { border: 1px solid #ccc; border-radius: 8px; padding: 0.75rem; margin-bottom: 1rem; container-type: inline-size; }
          .cq-narrow { width: 240px; }
          .cq-card { display: flex; gap: 0.75rem; align-items: center; }
          .cq-thumb { width: 80px; height: 80px; background: #1a73e8; border-radius: 6px; flex: none; }
          @container (max-width: 320px) {
            .cq-card { flex-direction: column; align-items: stretch; }
            .cq-thumb { width: 100%; }
          }
        `,
      },
      mode
    );
    const card = () => el('div', { className: 'cq-card' },
      el('div', { className: 'cq-thumb' }),
      el('div', {},
        el('strong', { textContent: 'Reusable media card' }),
        el('p', { textContent: 'Same component, two different container widths.' })
      )
    );
    section.append(
      el('div', { className: 'cq-wide' }, card()),
      el('div', { className: 'cq-narrow' }, card())
    );
    return () => {};
  },
};
