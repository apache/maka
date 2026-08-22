/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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

/**
 * Keep the elements a query matches, and every ancestor that leads to one.
 *
 * The ancestors are the point: a match on its own is a line with no context,
 * and the indentation that says where it sits is the reason this rendering is a
 * tree at all. Everything else goes.
 *
 * Ids are untouched. That is the whole reason this is safe — it narrows what is
 * *written*, never what can be addressed, so a model can filter, act on what it
 * found, and never learn that the rest of the tree was there all along.
 *
 * Measured need: Finder observes at 1,226 elements and about 14,700 tokens, VS
 * Code at 986 and 14,100. Neither is structural noise that could be collapsed
 * away — Finder's bulk is 481 cells and 363 static texts, which are the file
 * list, and that is real content. The only way past a tree that large is to
 * stop asking for all of it.
 */
export function matching(
  elements: readonly CuObservedElement[],
  query: string,
): CuObservedElement[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...elements];
  const byId = new Map(elements.map((element) => [element.elementId, element]));
  const keep = new Set<string>();
  for (const element of elements) {
    const haystack = [element.label, element.value, element.role, element.subrole]
      .filter((part): part is string => typeof part === 'string')
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) continue;
    keep.add(element.elementId);
    let parent = element.parentElementId;
    for (let hops = 0; parent !== undefined && hops < MAX_DEPTH; hops += 1) {
      if (keep.has(parent)) break;
      keep.add(parent);
      parent = byId.get(parent)?.parentElementId;
    }
  }
  return elements.filter((element) => keep.has(element.elementId));
}

/**
 * Knobs the shipped rendering does not turn.
 *
 * They exist for offline evaluation of what a rendering change would cost and
 * save against recorded trajectories before anyone tries it on a real machine.
 * The evaluator has to run the real renderer — the two
 * previous attempts at this elsewhere both reached a *reversed* conclusion
 * because the evaluator carried its own copy of the policy and the copy was
 * subtly wrong. So the policy stays here, in one place, and the offline harness
 * calls it with a different argument rather than reimplementing it.
 *
 * Every default is the shipped behaviour, and a test asserts that rendering
 * with no options is byte-for-byte what `renderObservationForModel` produces.
 */
export interface ObservationRenderOptions {
  /**
   * Collapse structural containers that hold more than one child.
   *
   * On. See `collapseStructuralWrappers` for what was measured; `false`
   * restores the strict form, which holds only a single-child wrapper to be a
   * layer and is what the offline evaluator baselines against.
   */
  readonly multiChildWrappers?: boolean;
}

export function renderObservationForModel(observation: CuObservation): string {
  return renderObservationText(observation);
}

export function renderObservationText(
  observation: CuObservation,
  options: ObservationRenderOptions = {},
): string {
  // The menu bar is separated out and captioned rather than left to appear as a
  // second unexplained root. A model reading `AXMenuBar` under the window tree
  // has no way to know that those names open, that opening one costs an
  // observation, or why half their contents are unavailable — and most of what
  // an application can do is only reachable through them.
  const { window, menu } = splitMenu(observation.elements);
  const query = observation.query ?? '';
  const shown = query ? matching(window, query) : window;
  const lines: string[] = [header(observation, window.length, query, shown.length)];
  if (
    observation.renderDifference === true &&
    observation.difference &&
    observation.difference.presentation !== 'full'
  ) {
    const difference = observation.difference;
    if (difference.presentation === 'no-change') {
      lines.push(
        `no_change=true(the window has no effective accessibility changes since ${difference.baseObservationId})`,
      );
      return lines.join('\n');
    }
    if (difference.removedStableIdRanges.length > 0) {
      lines.push(
        `removed_element_ids=${difference.removedStableIdRanges
          .map(({ start, end }) => (start === end ? String(start) : `${start}-${end}`))
          .join(',')}`,
      );
    }
    const byId = new Map(observation.elements.map((element) => [element.elementId, element]));
    for (const change of difference.changes) {
      if (change.kind === 'remove' || change.elementId === undefined) continue;
      const element = byId.get(change.elementId);
      if (!element) continue;
      const depth = Math.max(0, change.path.length - 1);
      lines.push(`${'\t'.repeat(depth)}change=${change.kind} ${elementLine(element)}`);
    }
    return lines.join('\n');
  }
  for (const [element, depth] of walk(collapseStructuralWrappers(shown, options))) {
    lines.push(`${'\t'.repeat(depth)}${elementLine(element)}`);
  }
  if (menu.length > 0) {
    lines.push(menuCaption(observation, menu));
    for (const [element, depth] of walk(dropSeparators(collapseMenuContainers(menu)))) {
      lines.push(`${'\t'.repeat(depth)}${elementLine(element)}`);
    }
  } else if (observation.menu?.unavailable === true) {
    // A menu was asked for and this observation has no menu bar in it. Said
    // here because the alternative is silence: the model asked to see a menu,
    // read a document with no menus in it, and had nothing to distinguish "this
    // executor does not report the menu bar" from "this application has no such
    // menu". Both of those it would answer by asking again.
    lines.push(
      'menu_bar=unavailable(this executor did not return the menu bar, so the menu argument had no ' +
        "effect and no menu command is reachable from here; use the window's own controls)",
    );
  }
  return lines.join('\n');
}

/**
 * The menu bar's subtree, by reachability from `AXMenuBar` rather than by role
 * name. `AXMenuButton` is an ordinary window control — TextEdit's 文稿操作 is
 * one — and splitting on the `AXMenu` prefix would move it out of the window it
 * belongs to.
 */
export function splitMenu(elements: readonly CuObservedElement[]): {
  window: CuObservedElement[];
  menu: CuObservedElement[];
} {
  const bar = elements.find((element) => element.role === 'AXMenuBar');
  if (!bar) return { window: [...elements], menu: [] };
  const inMenu = new Set<string>([bar.elementId]);
  // One pass in reported order is enough: the executor emits a parent before
  // its children (§5.2 walk order), so a child's parent is already classified.
  for (const element of elements) {
    const parent = element.parentElementId;
    if (parent !== undefined && inMenu.has(parent)) inMenu.add(element.elementId);
  }
  return {
    window: elements.filter((element) => !inMenu.has(element.elementId)),
    menu: elements.filter((element) => inMenu.has(element.elementId)),
  };
}

/**
 * `AXMenu` carries no name, no state and nothing to act on: it is the container
 * AppKit puts between a menu title and its commands. Dropping it and reparenting
 * its children onto the title is what makes an opened menu read the way a menu
 * looks — 文件 with its commands under it, rather than 文件 > an unnamed box >
 * its commands. On TextEdit's full menu bar it is 29 of 288 elements.
 *
 * The commands keep their own ids, so nothing addressable is lost.
 */
/**
 * Remove a node and hand its children to its parent.
 *
 * Not the same thing as dropping an element. A collapsed node's children keep
 * their own ids and stay addressable; what goes is one line and one level of
 * indentation. That is why it is safe where pruning is not — the research that
 * rejected "drop what has no label" counted 1,023 unnamed but operable elements
 * across ten applications, and none of them would be lost here.
 */
function collapse(
  elements: readonly CuObservedElement[],
  shouldCollapse: (element: CuObservedElement) => boolean,
): CuObservedElement[] {
  const collapsed = new Map<string, string | undefined>();
  for (const element of elements) {
    if (shouldCollapse(element)) collapsed.set(element.elementId, element.parentElementId);
  }
  if (collapsed.size === 0) return [...elements];
  const lift = (id: string | undefined): string | undefined => {
    let current = id;
    // Collapsed nodes nest — a menu inside a menu, a group inside a group — so
    // this walks to the first survivor rather than up one level.
    for (
      let hops = 0;
      current !== undefined && collapsed.has(current) && hops < MAX_DEPTH;
      hops += 1
    ) {
      current = collapsed.get(current);
    }
    return current;
  };
  // A node whose ancestry never reaches a survivor is not collapsed at all.
  //
  // Two mutually-parented `AXGroup`s each hold exactly one child — each other —
  // and so each meets every test above. Collapsing both removes both from the
  // output: their children survive as roots, but the pair itself is gone. A
  // renderer tidying a tree must not be able to lose an element from a
  // malformed one, so anything whose ancestry does not settle keeps its line.
  //
  // Judged against the original set and applied afterwards. Deleting as it goes
  // makes the answer depend on iteration order: remove the first of a cycle and
  // the second one's walk now lands on a survivor, so one of the pair collapses
  // and the other does not.
  const settles = (id: string): boolean => {
    let current = collapsed.get(id);
    for (let hops = 0; hops < MAX_DEPTH; hops += 1) {
      if (current === undefined || !collapsed.has(current)) return true;
      if (current === id) return false;
      current = collapsed.get(current);
    }
    return false;
  };
  for (const id of [...collapsed.keys()].filter((id) => !settles(id))) collapsed.delete(id);
  if (collapsed.size === 0) return [...elements];
  return elements
    .filter((element) => !collapsed.has(element.elementId))
    .map((element) => {
      const parent = lift(element.parentElementId);
      return parent === element.parentElementId ? element : { ...element, parentElementId: parent };
    });
}

/** `AXMenu` sits between a menu title and its commands and says nothing. */
export function collapseMenuContainers(
  elements: readonly CuObservedElement[],
): CuObservedElement[] {
  return collapse(elements, (element) => element.role === 'AXMenu');
}

/**
 * Roles that exist to hold other elements and nothing else.
 *
 * Deliberately a list rather than a test for "has no name": an `AXButton` with
 * no label is still a button, and Finder's `AXRow` and `AXCell` carry selection
 * even when they carry no text. Those are the elements a model acts on. These
 * are not — no application ships a bare `AXGroup` as something to click.
 */
const STRUCTURAL_ROLES = new Set([
  'AXGroup',
  'AXSplitGroup',
  'AXLayoutArea',
  'AXLayoutItem',
  'AXUnknown',
]);

/**
 * A wrapper around exactly one thing, carrying nothing of its own.
 *
 * Measured across four applications: VS Code 172 of 985 elements, Calculator 4
 * of 42, TextEdit 1 of 20, Finder 1 of 1,198 — Finder's containers mostly hold
 * several children, and holding several is a statement that they belong
 * together. One child is not a grouping, it is a layer.
 *
 * Every clause is load-bearing except one. A container with a `label` names its
 * section; a `value` or an action makes it a control; `focused` is where the
 * keys go. Those stay.
 *
 * The clause that went was "exactly one child". The argument for it — that
 * holding several children is a statement that they belong together — sounded
 * right and did not survive being measured: replaying both forms over 76
 * recorded observations shows the relaxed one keeps every
 * operated element and every named ancestor that identifies one, at 87% of the
 * tokens. It cannot do otherwise, because lifting a child into its parent is
 * not a deletion; what it erases is a line, and that line said nothing.
 *
 * The saving is not evenly spread and should not be quoted as one number. VS
 * Code gives back 1,277 tokens per observation, Calculator 17, Finder 16,
 * TextEdit and Preview nothing at all: web views build deep chains of unnamed
 * boxes, AppKit does not. So this is worth having for the windows that are
 * hardest to observe, and is invisible everywhere else.
 *
 * `multiChildWrappers: false` restores the strict form, which is what the
 * evaluator uses as its baseline.
 *
 * What is still not lifted is a childless node: it has nothing to lift into its
 * parent, so collapsing one is a deletion rather than a collapse, and deletion
 * is the thing this whole file refuses to do.
 */
export function collapseStructuralWrappers(
  elements: readonly CuObservedElement[],
  options: ObservationRenderOptions = {},
): CuObservedElement[] {
  const childCount = new Map<string, number>();
  for (const element of elements) {
    const parent = element.parentElementId;
    if (parent !== undefined) childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
  }
  const enoughChildren =
    options.multiChildWrappers === false
      ? (count: number) => count === 1
      : (count: number) => count >= 1;
  return collapse(
    elements,
    (element) =>
      STRUCTURAL_ROLES.has(element.role) &&
      !element.label &&
      element.value === undefined &&
      !(element.actions && element.actions.length > 0) &&
      element.focused !== true &&
      element.selected !== true &&
      enoughChildren(childCount.get(element.elementId) ?? 0),
  );
}

/**
 * A menu separator is a line, and a line is not a command.
 *
 * AppKit models one as an `NSMenuItem` and Accessibility reports it as an
 * `AXMenuItem` with no title, disabled, no actions and no submenu — the four
 * together are not something a real command can be. TextEdit's 文件 menu is 8 of
 * 42, its 格式 menu 11 of 72; across four menus measured, every unnamed item was
 * one of these except a submenu title, which the submenu test keeps.
 *
 * This is a narrower rule than "drop what has no label", which was measured
 * against window trees and rejected: 1,023 unnamed elements across ten
 * applications were operable, and Maka has no pixel fallback to reach one it
 * hid. Nothing here is operable by construction.
 *
 * Ids are untouched — the separator keeps the id it was minted with, it is
 * simply not written down — so nothing downstream has to know this happened.
 */
export function dropSeparators(elements: readonly CuObservedElement[]): CuObservedElement[] {
  const hasChildren = new Set<string>();
  for (const element of elements) {
    if (element.parentElementId !== undefined) hasChildren.add(element.parentElementId);
  }
  return elements.filter(
    (element) =>
      !(
        element.role === 'AXMenuItem' &&
        !element.label &&
        element.value === undefined &&
        element.enabled === false &&
        !(element.actions && element.actions.length > 0) &&
        !hasChildren.has(element.elementId)
      ),
  );
}

/**
 * The one sentence the menu bar cannot be shipped without.
 *
 * Two facts, both measured, both invisible from the listing itself: these names
 * open and opening one is an `observe` away, and a command that is unavailable
 * is unavailable because its application is not in front. TextEdit in the
 * background has 52 of 250 items enabled; in front, 168 — and the 116 that
 * change are 存储, 导出为PDF…, 页面设置…, the commands a task is usually about.
 * `AXPress` on one of them returns success and does nothing, so a model that is
 * not told this reads the refusal as its own mistake and tries again.
 */
function menuCaption(observation: CuObservation, menu: readonly CuObservedElement[]): string {
  const titles = menu.filter((element) => element.role === 'AXMenuBarItem').length;
  const opened = observation.menu?.opened;
  const parts = [`menu_bar=${titles}`];
  parts.push(
    opened
      ? `opened=${quote(opened)}`
      : 'not_opened(only the titles are listed; observe again with menu="<title>" to list one menu\'s commands)',
  );
  if (menu.some((element) => element.enabled === false)) {
    parts.push(
      'note(a disabled command needs its application in front, which Computer Use does not do; it cannot be pressed from here)',
    );
  }
  if (observation.menu?.truncated === true) {
    parts.push(
      'truncated=true(this menu was cut short; a command you expect may exist but not be listed)',
    );
  }
  return parts.join(' ');
}

function header(
  observation: CuObservation,
  elementCount: number,
  query: string,
  shownCount: number,
): string {
  const parts = [
    `observation_id=${observation.observationId}`,
    `app=${observation.appId}`,
    `pid=${observation.pid}`,
    `window_id=${observation.windowId}`,
  ];
  if (observation.windowTitle) parts.push(`window=${quote(observation.windowTitle)}`);
  parts.push(`elements=${elementCount}`);
  // Said in the header, beside the count it contradicts. A filtered tree that
  // does not announce itself is a tree the model reads as the whole window, and
  // "the control is not there" is the conclusion it draws.
  if (query) {
    parts.push(
      `query=${quote(query)}(showing ${shownCount} of ${elementCount}: matches and the elements containing them. Observe without a query for the rest)`,
    );
  }
  // Said in the header rather than at the end, because a model that stops
  // reading a long list early must still learn that the list was cut. The
  // wording is the instruction, not the fact: "there may be more" is what
  // changes what it does next.
  if (observation.truncated === true) {
    parts.push(
      'truncated=true(the tree was cut short; an element you expect may exist but not be listed)',
    );
  }
  return parts.join(' ');
}

/**
 * A subrole earns its place when it is telling the model something the rest of
 * the line does not.
 *
 * Measured on System Settings: 151 of 331 elements carry one, and printing them
 * all was 13.6% of the whole observation — mostly `AXStandardWindow` beside
 * `AXWindow` and `AXSectionList` beside `AXList`, which restate the role in
 * more characters. Two cases are not like that:
 *
 *  - an element with no label, where the subrole is the only name it has. The
 *    three window buttons are exactly this: unlabelled `AXButton`s that are
 *    close, minimise and zoom.
 *  - a secure text field, which is how "never fill a credential" is enforceable
 *    at all rather than advisory.
 *
 * The `AX` prefix goes: it is on every role in the tree, so it says nothing
 * where it repeats.
 */
/**
 * Roles whose subrole restates what they are.
 *
 * A window is a window and a group is a group; `AXStandardWindow` and
 * `AXHostingView` add characters, not identity. A button, a row or a field is
 * one of many, and its subrole is often the only thing telling it from its
 * neighbours.
 */
const CONTAINER_ROLES = new Set([
  'Window',
  'Group',
  'SplitGroup',
  'ScrollArea',
  'Layout',
  'LayoutArea',
  'Unknown',
]);

function roleOf(element: CuObservedElement): string {
  const role = element.role.replace(/^AX/, '');
  const subrole = element.subrole?.replace(/^AX/, '');
  if (!subrole || subrole === role) return element.role;
  // A secure field always, because that is the one the model must not fill.
  if (/secure/i.test(subrole)) return `${element.role}/${subrole}`;
  // Otherwise only where it is the element's only identity AND it actually
  // distinguishes it. `AXButton/AXCloseButton` tells three identical unlabelled
  // buttons apart; `AXWindow/AXStandardWindow` and `AXGroup/AXHostingView` are
  // a longer way of writing the role, on elements that are unnamed because they
  // are containers rather than because their name is missing.
  const named = (element.label ?? '').trim() !== '';
  if (named || CONTAINER_ROLES.has(role)) return element.role;
  return `${element.role}/${subrole}`;
}

export function elementLine(element: CuObservedElement): string {
  // `role/subrole` rather than a separate field: it is the same answer to
  // "what is this", it is absent on most elements, and a password field that
  // reads `AXTextField/AXSecureTextField` is the one case where the model must
  // not treat a control as an ordinary one.
  const parts = [element.elementId, roleOf(element)];
  if (element.label) parts.push(quote(element.label));
  if (element.value !== undefined) parts.push(`=${quote(truncate(element.value))}`);
  // `~` rather than `=`, one glyph apart from a value and meaning the opposite:
  // this field is empty and this is what it is prompting for. Written only when
  // there is no value, because a control showing both has content and the
  // prompt is no longer what a model needs to know about it.
  if (element.value === undefined && element.placeholder !== undefined) {
    parts.push(`~${quote(truncate(element.placeholder))}`);
  }
  // Only the informative half of each state is written. Every element the
  // driver reports is enabled and unselected unless it says otherwise, so
  // spelling that out for all of them costs tokens to say nothing.
  const states: string[] = [];
  if (element.enabled === false) states.push('disabled');
  if (element.selected === true) states.push('selected');
  // Where the keys go if a key is sent without naming a control.
  if (element.focused === true) states.push('focused');
  if (states.length > 0) parts.push(`[${states.join(',')}]`);
  // The names `secondary_action` will accept for this element, and nothing
  // else: a plain press is what `click_element` already does, and the backend
  // has dropped it before this point.
  if (element.actions && element.actions.length > 0) {
    parts.push(`+${element.actions.join(',')}`);
  }
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
export function walk(elements: readonly CuObservedElement[]): Array<[CuObservedElement, number]> {
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
