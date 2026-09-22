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

/**
 * The one attribute that names a Session workspace's interaction container.
 *
 * AppShell owns a `.maka-detail-with-artifacts` frame. A global lookup
 * can land in a workspace the user is not looking at. The semantic
 * attribute lets the parent-focus action resolve the workspace that
 * owns the Side Conversation it was invoked from.
 */
export const SESSION_INTERACTION_CONTAINER_ATTRIBUTE = 'data-maka-interaction-container';
export const SESSION_INTERACTION_CONTAINER_SELECTOR =
  `.maka-detail-with-artifacts, [${SESSION_INTERACTION_CONTAINER_ATTRIBUTE}]`;

/**
 * The parent conversation region inside that frame. The Workbar column is a
 * sibling of this region, never a descendant, which is what keeps the Side
 * Conversation's own composer out of reach.
 */
export const SESSION_PARENT_INTERACTION_ATTRIBUTE = 'data-maka-parent-interaction';
export const SESSION_PARENT_INTERACTION_SELECTOR =
  `:scope > .mainColumn, [${SESSION_PARENT_INTERACTION_ATTRIBUTE}]`;

// Question and form controls first, the parent composer second: both sit in the
// parent region, and only the first tier can answer a pending interaction.
const PARENT_INTERACTION_FOCUSABLE =
  '.maka-composer-interaction button, .maka-composer-interaction [href], .maka-composer-interaction input, .maka-composer-interaction textarea, .maka-composer-interaction [contenteditable="true"]';
const PARENT_COMPOSER_FOCUSABLE = '.maka-composer [contenteditable="true"]';

const HIDDEN_ANCESTOR = '[hidden], [aria-hidden="true"], [inert]';
const DISABLEABLE_CONTROL = 'button, input, select, textarea, optgroup, option';

/**
 * A disabled fieldset disables its controls, except those inside its first
 * `<legend>`. `:disabled` states the same rule, but this module also runs where
 * no selector engine implements it.
 */
function isDisabledControl(node: Element): boolean {
  if (!node.matches(DISABLEABLE_CONTROL)) return false;
  if (node.hasAttribute('disabled')) return true;
  for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.localName !== 'fieldset' || !ancestor.hasAttribute('disabled')) continue;
    const legend = [...ancestor.children].find((child) => child.localName === 'legend');
    if (legend?.contains(node)) continue;
    return true;
  }
  return false;
}

/**
 * Rendered means laid out, painted, and not behind a marker that takes it out of
 * the accessibility tree or the tab order.
 */
function isRendered(node: Element | null): node is HTMLElement {
  if (!node) return false;
  if (node.closest(HIDDEN_ANCESTOR)) return false;
  const view = node.ownerDocument?.defaultView;
  if (view?.getComputedStyle) {
    // `visibility` resolves through inheritance, so the node's own computed
    // value already accounts for its ancestors; `display: none` on an ancestor
    // never shows up in the node's own value.
    const { visibility } = view.getComputedStyle(node);
    if (visibility === 'hidden' || visibility === 'collapse') return false;
    for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
      if (view.getComputedStyle(ancestor).display === 'none') return false;
    }
  }
  return node.getClientRects().length > 0;
}

function isUsableFocusTarget(node: Element): node is HTMLElement {
  if (typeof (node as HTMLElement).focus !== 'function') return false;
  if (isDisabledControl(node)) return false;
  return isRendered(node);
}

function firstUsableFocusTarget(root: ParentNode | null, selector: string): HTMLElement | null {
  if (!root) return null;
  for (const node of root.querySelectorAll(selector)) {
    if (isUsableFocusTarget(node)) return node;
  }
  return null;
}

/**
 * Focus the parent task's pending question or form control, then its composer.
 *
 * `origin` is the element the user acted on; its own workspace wins, so a
 * hidden or adjacent workspace can never receive the focus. An origin outside a
 * marked workspace resolves to nothing rather than to some other workspace.
 */
export function focusParentConversation(origin?: Element | null): void {
  const container = origin?.closest(SESSION_INTERACTION_CONTAINER_SELECTOR) ?? null;
  if (!isRendered(container)) return;
  const parentRegion = container.querySelector(SESSION_PARENT_INTERACTION_SELECTOR);
  if (!isRendered(parentRegion)) return;
  const target =
    firstUsableFocusTarget(parentRegion, PARENT_INTERACTION_FOCUSABLE) ??
    firstUsableFocusTarget(parentRegion, PARENT_COMPOSER_FOCUSABLE);
  target?.focus();
}
