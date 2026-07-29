// How an observation is written for the model.
//
// The previous rendering was `JSON.stringify` over the element array, which
// repeats every key name once per element: `"element_id":`, `"role":`,
// `"label":`, `"frame":{"x":…,"y":…,"width":…,"height":…}`. At the driver's
// 500-element ceiling that key overhead is the majority of the payload, and
// none of it tells the model anything.
//
// The shape here follows what Codex's Computer Use actually sends — one
// indented line per element, structure carried by indentation rather than by a
// `parent_element_id` field the model has to join on itself. A captured sample
// of its real `get_app_state` result (archived in the MIT-licensed
// iFurySt/open-codex-computer-use repository) reads:
//
//     App=com.apple.ActivityMonitor (pid 988)
//     Window: "Activity Monitor", App: Activity Monitor.
//     0 standard window Activity Monitor – All Processes, Secondary Actions: Raise
//     38 search text field (settable, string) Helper
//     The focused UI element is 0 standard window.
//
// Two deliberate departures from it:
//
//  - the header carries `observation_id`. Codex scopes an observation to the
//    assistant turn by convention stated in prose; Maka binds actions to a
//    specific observation and refuses a spent one, so the id the model must
//    quote back is protocol, not prose, and it goes first.
//  - element geometry stays. Codex omits it entirely and leans on the
//    screenshot, which it can do because it has no coordinate action surface
//    at all. Maka's is disabled by default rather than absent, and the frames
//    also carry reading order and layout that a model reasons about even when
//    it can only act semantically. `@x,y wxh` costs 11 characters where the
//    JSON form cost about 50.
//
// Nothing is dropped. Elision — collapsing structural containers that carry no
// label, value or state — is the obvious next saving and is deliberately NOT
// done here: an element missing from the text is an element the model cannot
// target, and "it was only a group" is a guess about someone else's UI.

import type { CuObservation, CuObservedElement } from './computer-use-types.js';

/**
 * Longest element value written out in full.
 *
 * A text area holding a document would otherwise be reproduced in its entirety
 * once per observation. Truncation is reported inline rather than silently, so
 * the model can tell "the field says this" from "the field starts with this".
 */
const MAX_VALUE_CHARS = 256;

/** Depth cap, so a malformed parent chain cannot indent without bound. */
const MAX_DEPTH = 24;

export function renderObservationForModel(observation: CuObservation): string {
  const lines: string[] = [header(observation)];
  for (const [element, depth] of walk(observation.elements)) {
    lines.push(`${'\t'.repeat(depth)}${elementLine(element)}`);
  }
  return lines.join('\n');
}

function header(observation: CuObservation): string {
  const parts = [
    `observation_id=${observation.observationId}`,
    `app=${observation.appId}`,
    `pid=${observation.pid}`,
    `window_id=${observation.windowId}`,
  ];
  if (observation.windowTitle) parts.push(`window=${quote(observation.windowTitle)}`);
  parts.push(`elements=${observation.elements.length}`);
  return parts.join(' ');
}

function elementLine(element: CuObservedElement): string {
  const parts = [element.elementId, element.role];
  if (element.label) parts.push(quote(element.label));
  if (element.value !== undefined) parts.push(`=${quote(truncate(element.value))}`);
  // Only the informative half of each state is written. Every element the
  // driver reports is enabled and unselected unless it says otherwise, so
  // spelling that out for all of them costs tokens to say nothing.
  const states: string[] = [];
  if (element.enabled === false) states.push('disabled');
  if (element.selected === true) states.push('selected');
  if (states.length > 0) parts.push(`[${states.join(',')}]`);
  if (element.frame) {
    const { x, y, width, height } = element.frame;
    parts.push(`@${round(x)},${round(y)} ${round(width)}x${round(height)}`);
  }
  return parts.join(' ');
}

/**
 * Depth-first over the parent links, in the order the driver reported them.
 *
 * An element whose parent is not in this observation is a root: the driver
 * prunes, so a reported child can outlive its reported parent, and hiding such
 * an element to keep the tree tidy would hide a real target.
 */
function walk(elements: readonly CuObservedElement[]): Array<[CuObservedElement, number]> {
  const byId = new Map<string, CuObservedElement>();
  for (const element of elements) byId.set(element.elementId, element);

  const childrenOf = new Map<string, CuObservedElement[]>();
  const roots: CuObservedElement[] = [];
  for (const element of elements) {
    const parentId = element.parentElementId;
    if (parentId === undefined || parentId === element.elementId || !byId.has(parentId)) {
      roots.push(element);
      continue;
    }
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(element);
    else childrenOf.set(parentId, [element]);
  }

  const ordered: Array<[CuObservedElement, number]> = [];
  const visited = new Set<string>();
  const stack: Array<[CuObservedElement, number]> = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    const root = roots[index];
    if (root) stack.push([root, 0]);
  }
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    const [element, depth] = entry;
    // A parent cycle would otherwise loop forever. The driver should not
    // produce one, and a renderer is the wrong place to find out that it did.
    if (visited.has(element.elementId)) continue;
    visited.add(element.elementId);
    ordered.push([element, Math.min(depth, MAX_DEPTH)]);
    const children = childrenOf.get(element.elementId) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) stack.push([child, depth + 1]);
    }
  }

  // Anything a cycle kept out of the walk still belongs in the output; it is
  // reachable by element_id whether or not its parent chain made sense.
  for (const element of elements) {
    if (!visited.has(element.elementId)) ordered.push([element, 0]);
  }
  return ordered;
}

function truncate(value: string): string {
  if (value.length <= MAX_VALUE_CHARS) return value;
  const dropped = value.length - MAX_VALUE_CHARS;
  return `${value.slice(0, MAX_VALUE_CHARS)}…(+${dropped} chars)`;
}

/**
 * Quote and escape, so a label containing a quote or a newline cannot make one
 * element's line look like two.
 */
function quote(value: string): string {
  return JSON.stringify(value);
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}
