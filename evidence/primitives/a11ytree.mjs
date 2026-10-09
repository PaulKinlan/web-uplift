import { join } from 'node:path';
import { applyConditions, emit, round } from '../common.mjs';
import { evaluate, navigate, sleep } from '../cdp.mjs';

// --- a11ytree primitive: computed accessibility tree + focus order ---------
//
// DOM attributes and the computed tree disagree in exactly the cases the checks
// care about: an aria-label overridden by aria-labelledby, a name that comes from
// title, a landmark hidden by aria-hidden on an ancestor, a heading dropped from
// the tree. Accessibility.getFullAXTree reports what assistive technology is
// actually handed, so this primitive projects that tree (roles, computed names,
// ignored subtrees and flag properties) and then walks the real tab order with
// CDP key events, recording each stop's computed focus indicator.
const A11Y_MAX_NODES = 400;
const A11Y_MAX_STOPS = 60;
const A11Y_PROPERTY_NAMES = [
  'focusable', 'focused', 'level', 'checked', 'expanded', 'selected', 'required', 'disabled', 'invalid', 'readonly',
  'multiselectable', 'orientation', 'live', 'atomic', 'relevant', 'busy', 'modal', 'roledescription', 'keyshortcuts',
  'pressed', 'current', 'hasPopup', 'setSize', 'posInSet', 'valuemin', 'valuemax', 'valuetext', 'hierarchicalLevel',
];

// One node of the computed tree, flattened enough to cap and read, keeping only
// the properties the accessibility checks turn on.
function projectAxNode(node, depth) {
  const properties = {};
  for (const p of node.properties || []) {
    const value = p?.value?.value;
    if (value === undefined || value === null) continue;
    if (A11Y_PROPERTY_NAMES.includes(p.name)) properties[p.name] = value;
  }
  const name = typeof node.name?.value === 'string' ? node.name.value.slice(0, 120) : null;
  const description = typeof node.description?.value === 'string' ? node.description.value.slice(0, 120) : null;
  const ignoredReasons = (node.ignoredReasons || []).map((r) => r.name).filter(Boolean).slice(0, 4);
  return {
    nodeId: String(node.nodeId),
    role: node.role?.value ?? null,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(node.ignored ? { ignored: true } : {}),
    ...(ignoredReasons.length ? { ignoredReasons } : {}),
    ...(Object.keys(properties).length ? { properties } : {}),
    childCount: (node.childIds || []).length,
    depth,
  };
}

// The in-page probe for one focus stop: what holds focus, where it is, and
// whether it is actually showing a focus indicator.
function activeElementProbe() {
  return `(() => {
    const el = document.activeElement;
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const vw = (window.visualViewport && window.visualViewport.width) || window.innerWidth;
    const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('alt') || el.getAttribute('title') || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 80);
    const boxShadow = cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow.slice(0, 60) : null;
    const outlineVisible = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
    const hiddenAncestor = el.closest && el.closest('[aria-hidden="true"]');
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      class: typeof el.className === 'string' ? el.className.slice(0, 40) : null,
      type: el.tagName === 'INPUT' ? (el.type || 'text') : null,
      role: el.getAttribute('role') || null,
      tabindex: el.getAttribute('tabindex'),
      name,
      isBody: el === document.body,
      // aria-hidden removes an element from the accessibility tree but NOT from
      // the keyboard tab order, so this is a real (and common) mismatch.
      insideAriaHidden: !!hiddenAncestor,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      onScreen: r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw,
      outline: { width: cs.outlineWidth, style: cs.outlineStyle, color: cs.outlineColor, offset: cs.outlineOffset },
      boxShadow,
      // Mechanical reading of "a focus indicator is painted"; the model judges
      // whether it is actually perceivable (contrast, offset, and so on).
      hasVisibleIndicator: outlineVisible || !!boxShadow,
      key: [el.tagName, el.id, el.className, name].join('|'),
    };
  })()`;
}

export async function a11ytree(client, url, opts, log) {
  // The caps are the model's to widen: a content-heavy page can exceed both (a
  // live blog measured 831 AX nodes and more than 60 focusables), and the
  // effective values are echoed in the output so a truncated sample always says
  // it is truncated. Bad or missing values fall back to the documented defaults.
  const maxNodes = Number.isFinite(opts.maxNodes) && opts.maxNodes > 0 ? Math.floor(opts.maxNodes) : A11Y_MAX_NODES;
  const maxStops = Number.isFinite(opts.maxStops) && opts.maxStops > 0 ? Math.floor(opts.maxStops) : A11Y_MAX_STOPS;
  log(`[evidence] a11ytree: caps ${maxNodes} node(s), ${maxStops} focus stop(s)`);

  await navigate(client, url, {
    settleMs: opts.wait ?? 1200,
    log,
    beforeTargetNavigate: () => applyConditions(client, opts, log),
  });
  await sleep(150);

  // 1. The computed tree, BEFORE the focus walk moves anything.
  await client.Accessibility.enable();
  const { nodes: axNodes } = await client.Accessibility.getFullAXTree();
  const byId = new Map((axNodes || []).map((n) => [n.nodeId, n]));
  const childIds = new Set((axNodes || []).flatMap((n) => n.childIds || []));
  const rootNode = (axNodes || []).find((n) => !childIds.has(n.nodeId)) || (axNodes || [])[0] || null;

  let included = 0;
  let ignoredCount = 0;
  let maxDepth = 0;
  let truncated = false;
  const roleCounts = {};
  const build = (node, depth) => {
    if (!node || included >= maxNodes) {
      truncated = true;
      return null;
    }
    included++;
    maxDepth = Math.max(maxDepth, depth);
    if (node.ignored) ignoredCount++;
    else if (node.role?.value) roleCounts[node.role.value] = (roleCounts[node.role.value] || 0) + 1;
    const projected = projectAxNode(node, depth);
    const children = [];
    for (const id of node.childIds || []) {
      const child = build(byId.get(id), depth + 1);
      if (child) children.push(child);
      else truncated = true;
    }
    if (children.length) projected.children = children;
    return projected;
  };
  const treeRoot = build(rootNode, 0);
  const totalNodes = (axNodes || []).length;
  log(`[evidence] a11ytree: ${totalNodes} AX node(s), ${included} projected, ${ignoredCount} ignored`);

  // 2. The real tab order: dispatch Tab and read what holds focus, until the
  // cycle wraps or the cap is reached.
  const stops = [];
  let cycleDetected = false;
  let focusTruncated = false;
  try {
    for (let i = 0; i < maxStops; i++) {
      await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      const stop = await evaluate(client, activeElementProbe());
      if (!stop) break;
      if (stops.length && stop.key === stops[0].key) {
        cycleDetected = true;
        break;
      }
      stops.push(stop);
    }
    if (!cycleDetected && stops.length >= maxStops) focusTruncated = true;
  } catch (err) {
    log(`[evidence] a11ytree: focus walk failed: ${err.message.split('\n')[0]}`);
  }
  log(
    `[evidence] a11ytree: ${stops.length} focus stop(s)${cycleDetected ? ', cycle wrapped' : ''}` +
      `${stops.some((s) => !s.hasVisibleIndicator) ? `, ${stops.filter((s) => !s.hasVisibleIndicator).length} without a visible indicator` : ''}`,
  );

  const result = {
    primitive: 'a11ytree',
    url,
    scannedAt: new Date().toISOString(),
    tree: {
      root: treeRoot,
      totalNodes,
      nodesProjected: included,
      truncated,
      maxDepth,
      ignoredCount,
      roleCounts,
      maxNodes,
    },
    focusOrder: {
      stops,
      stopCount: stops.length,
      cycleDetected,
      truncated: focusTruncated,
      maxStops,
      stopsWithoutVisibleIndicator: stops.filter((s) => !s.hasVisibleIndicator).length,
      stopsInsideAriaHidden: stops.filter((s) => s.insideAriaHidden).length,
    },
    note:
      'What assistive technology is actually handed, not what the DOM says: `tree` is Accessibility.getFullAXTree projected to role, computed name, ignored (with reasons), the flag properties the checks turn on, and depth, so an aria-label overridden by aria-labelledby or a subtree hidden by an ancestor aria-hidden shows up here and not in a DOM-attribute probe. `focusOrder` is the REAL tab order: Tab is dispatched with CDP key events and each stop records the focused element, its rect and whether it is on screen, its computed outline/box-shadow with a mechanical `hasVisibleIndicator` reading, and whether it sits inside an aria-hidden subtree (which removes it from the accessibility tree but NOT from the tab order - a real mismatch, counted in stopsInsideAriaHidden). Judge perceivability yourself. The walk stops when the cycle wraps or at maxStops. Nodes and stops are capped and say so (nodesProjected/totalNodes, truncated, maxStops). Descriptive signal, not a verdict: judge against be-inclusive names-roles-labels and structure-and-focus.',
  };
  return emit(opts, result, client);
}

