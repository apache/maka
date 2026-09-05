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
 * Who owns the composer's caret, and who owns focus.
 *
 * A restored draft owes the caret the end of its content, or the next keystroke
 * prepends to it. But the only way to place a caret is a selection, and a
 * selection inside a `contenteditable` focuses that element — whoever held focus
 * before — and moves the point sequential focus navigation resumes from. So the
 * restore claimed focus nobody directed at it: on a cold start, past the skip
 * link with no `focus()` call to explain it, so Tab from the document start
 * began in the composer; and on a session swap, out from under the sidebar row
 * the user had just activated. Both are pinned here.
 *
 * The caret is therefore owed rather than placed whenever the editor is not
 * focused, and lands on its next real focus — the first moment the offset is the
 * only thing being decided. A pointer press places the caret itself and drops
 * the claim.
 *
 * linkedom carries no selection, no focus and no `Range` motion, so the harness
 * models what the composer uses: `createRange` records where a caret was aimed,
 * `getSelection` records the live selection and reproduces the focus a selection
 * takes, and `focus()` sets `document.activeElement` and dispatches the `focusin`
 * a browser would. It also lowercases `contentEditable` on the way into the DOM, because linkedom stores
 * attribute names verbatim where HTML folds them — without that the composer's
 * own `[contenteditable="true"]` lookup misses its editor here and nowhere else.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';

const originalGlobals = {
  document: globalThis.document,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;
const mountedRoots: ReturnType<typeof createRoot>[] = [];
const restoreDom: (() => void)[] = [];

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
  for (const restore of restoreDom.splice(0)) restore();
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

function computedStyle(): CSSStyleDeclaration {
  return {
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  } as unknown as CSSStyleDeclaration;
}

/** Where a caret was aimed: `selectNodeContents` then `collapse` and no more. */
interface AimedRange {
  container: Node | null;
  offset: number;
  collapsed: boolean;
  startContainer: Node | null;
  startOffset: number;
  endContainer: Node | null;
  endOffset: number;
  commonAncestorContainer: Node | null;
}

function harness() {
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => computedStyle();
  const animationFrames: FrameRequestCallback[] = [];
  const setAttribute = window.Element.prototype.setAttribute;
  window.Element.prototype.setAttribute = function normalized(name: string, value: string) {
    return setAttribute.call(this, name === 'contentEditable' ? 'contenteditable' : name, value);
  };
  restoreDom.push(() => {
    window.Element.prototype.setAttribute = setAttribute;
  });
  document.createRange = () => {
    const range: AimedRange & {
      selectNodeContents(node: Node): void;
      collapse(toStart: boolean): void;
      setStart(node: Node, offset: number): void;
      setEnd(node: Node, offset: number): void;
      cloneRange(): Range;
    } = {
      container: null,
      offset: 0,
      collapsed: false,
      startContainer: null,
      startOffset: 0,
      endContainer: null,
      endOffset: 0,
      commonAncestorContainer: null,
      selectNodeContents(node) {
        range.container = node;
        range.offset = node.childNodes.length;
        range.startContainer = node;
        range.startOffset = 0;
        range.endContainer = node;
        range.endOffset = node.childNodes.length;
        range.commonAncestorContainer = node;
      },
      collapse(toStart) {
        range.offset = toStart ? 0 : range.offset;
        if (range.startContainer !== null) {
          const node = toStart ? range.startContainer : range.endContainer;
          const offset = toStart ? range.startOffset : range.endOffset;
          range.startContainer = node;
          range.startOffset = offset;
          range.endContainer = node;
          range.endOffset = offset;
          range.container = node;
          range.commonAncestorContainer = node;
        }
        range.collapsed = true;
      },
      setStart(node, offset) {
        range.startContainer = node;
        range.startOffset = offset;
        range.container = node;
        range.offset = offset;
        range.commonAncestorContainer = node;
      },
      setEnd(node, offset) {
        range.endContainer = node;
        range.endOffset = offset;
        range.commonAncestorContainer = node;
        range.collapsed =
          range.startContainer === range.endContainer && range.startOffset === range.endOffset;
      },
      cloneRange() {
        const clone = document.createRange() as unknown as typeof range;
        clone.container = range.container;
        clone.offset = range.offset;
        clone.collapsed = range.collapsed;
        clone.startContainer = range.startContainer;
        clone.startOffset = range.startOffset;
        clone.endContainer = range.endContainer;
        clone.endOffset = range.endOffset;
        clone.commonAncestorContainer = range.commonAncestorContainer;
        return clone as unknown as Range;
      },
    };
    return range as unknown as Range;
  };
  let active: Element | null = null;
  const selected: AimedRange[] = [];
  const selection = {
    get rangeCount(): number {
      return selected.length;
    },
    get isCollapsed(): boolean {
      return selected.at(-1)?.collapsed ?? true;
    },
    get anchorNode(): Node | null {
      return selected.at(-1)?.startContainer ?? null;
    },
    getRangeAt(index: number): Range {
      return selected[index] as unknown as Range;
    },
    removeAllRanges() {
      selected.length = 0;
    },
    addRange(range: Range) {
      const aimed = range as unknown as AimedRange;
      selected.push(aimed);
      // The whole point: a selection inside a `contenteditable` focuses it,
      // whoever held focus before. Without this the harness would let a caret
      // placed on a blurred editor look free.
      const container = aimed.container as Node & { closest?: Element['closest']; parentElement?: Element | null };
      const element = container?.closest
        ? container
        : container?.parentElement;
      active = element?.closest?.('[contenteditable="true"]') ?? active;
    },
  };
  document.getSelection = () => selection as unknown as Selection;
  window.getSelection = () => selection as unknown as Selection;
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => active });
  const focus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function focusElement() {
    active = this;
    this.dispatchEvent(new window.Event('focusin', { bubbles: true }));
  };
  restoreDom.push(() => {
    window.HTMLElement.prototype.focus = focus;
  });
  Object.assign(globalThis, {
    document,
    window,
    Node: window.Node,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  };
  window.cancelAnimationFrame = () => undefined;
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container as unknown as Element);
  mountedRoots.push(root);
  return {
    /** The live selection: what `removeAllRanges` cleared and `addRange` added. */
    selected: selected as readonly AimedRange[],
    editable() {
      const editable = document.querySelector('[contenteditable="true"]');
      assert.ok(editable, 'the composer rendered no editable node');
      return editable as unknown as HTMLElement;
    },
    /** A focusable outside the composer — the sidebar row that swaps the draft. */
    outside() {
      const existing = document.querySelector('#outside');
      if (existing) return existing as unknown as HTMLElement;
      const button = document.createElement('button');
      button.id = 'outside';
      document.documentElement.appendChild(button);
      return button as unknown as HTMLElement;
    },
    focused: () => active,
    /** Focus an element the way a browser does: activate it, then announce it. */
    async focus(element: HTMLElement) {
      active = element as unknown as Element;
      await act(() => {
        element.dispatchEvent(new window.Event('focusin', { bubbles: true }));
      });
    },
    async pointerDown(element: HTMLElement) {
      await act(() => {
        element.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      });
    },
    async click(element: HTMLElement) {
      await act(() => {
        element.dispatchEvent(new window.Event('click', { bubbles: true }));
      });
    },
    async flushAnimationFrames() {
      const callbacks = animationFrames.splice(0);
      await act(() => {
        for (const callback of callbacks) callback(0);
      });
    },
    async setCaret(offset: number) {
      const editable = this.editable();
      const text = editable.firstChild as Node | null;
      assert.ok(text, 'the composer has no text node');
      const range = document.createRange();
      range.setStart(text as Node, offset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    },
    async render(props: Parameters<typeof Composer>[0]) {
      await act(() => {
        root.render(
          <LocaleProvider locale="en">
            <Composer {...props} />
          </LocaleProvider>,
        );
      });
    },
  };
}

const base = {
  onSend: () => undefined,
  onStop: () => undefined,
};

/** A host that hands the named session back an unsent draft, as a cold start does. */
function withDraft(key: string, draft: string) {
  return {
    ...base,
    draftPersistence: {
      read: (draftKey: string | undefined) => (draftKey === key ? draft : ''),
      write: () => undefined,
    },
  };
}

/** The end of the content, which is where every restored draft owes its caret. */
function assertCaretAtEnd(selected: readonly AimedRange[], editable: HTMLElement): void {
  const caret = selected.at(-1);
  if (!caret) throw new Error('the composer placed no caret');
  assert.equal(caret.collapsed, true, 'the caret must be a collapsed selection');
  assert.equal(caret.container, editable);
  assert.equal(caret.offset, editable.childNodes.length);
}

test('a draft restored while nothing holds focus places no selection', async () => {
  const dom = harness();
  await dom.render({ ...withDraft('session-a', 'restored draft'), draftKey: 'session-a' });
  assert.equal(dom.editable().textContent, 'restored draft');
  assert.equal(
    dom.selected.length,
    0,
    'the restored caret took a selection inside the contenteditable, which focuses it and moves ' +
      'the point Tab resumes from off the top of the document',
  );
  assert.equal(dom.focused(), null, 'the restored caret focused the composer');
});

test('the owed caret lands at the end of the draft on the next focus', async () => {
  const dom = harness();
  await dom.render({ ...withDraft('session-a', 'restored draft'), draftKey: 'session-a' });
  await dom.focus(dom.editable());
  assertCaretAtEnd(dom.selected, dom.editable());
});

test('a pointer press into the composer drops the owed caret', async () => {
  const dom = harness();
  await dom.render({ ...withDraft('session-a', 'restored draft'), draftKey: 'session-a' });
  await dom.pointerDown(dom.editable());
  await dom.focus(dom.editable());
  assert.equal(
    dom.selected.length,
    0,
    'a click places the caret where it lands; the owed caret must not overrule it',
  );
});

test('a session swap leaves focus on the row that caused it', async () => {
  const dom = harness();
  const props = withDraft('session-b', 'other draft');
  await dom.render({ ...props, draftKey: 'session-a' });
  await dom.focus(dom.outside());
  await dom.render({ ...props, draftKey: 'session-b' });
  assert.equal(dom.editable().textContent, 'other draft');
  assert.equal(
    dom.focused(),
    dom.outside(),
    'the restored caret took focus out from under the row the user activated',
  );
});

test('changing thinking level keeps the draft caret', async () => {
  const dom = harness();
  const props = {
    ...withDraft('session-a', 'draft in the middle'),
    draftKey: 'session-a',
    activeSession: {
      id: 'session-a',
      llmConnectionId: 'connection-a',
      llmConnectionSlug: 'connection-a',
      model: 'model-a',
    } as never,
    activeThinkingLevels: ['low'] as never,
    activeThinkingLevel: undefined,
    onThinkingLevelChange: () => undefined,
  };
  await dom.render(props);
  await dom.focus(dom.editable());
  await dom.setCaret(6);

  const selector = document.querySelector('.maka-thinking-level-selector');
  assert.ok(selector, 'the thinking-level selector did not render');
  await dom.pointerDown(selector as HTMLElement);
  await dom.click(selector as HTMLElement);

  const options = [...document.querySelectorAll('[role="menuitemradio"]')];
  const low = options.find((option) => option.textContent?.includes('Low'));
  assert.ok(low, 'the thinking-level menu did not render the low option');
  // A browser can collapse a contenteditable selection when focus moves into
  // the menu. The production code must restore the range captured before that
  // interaction rather than accepting the collapsed start position.
  await dom.setCaret(0);
  await dom.click(low as HTMLElement);
  await dom.render({ ...props, activeThinkingLevel: 'low' as never });
  await dom.flushAnimationFrames();
  document.querySelector('[role="menu"]')?.remove();

  const caret = dom.selected.at(-1);
  if (!caret) throw new Error('the thinking-level change removed the draft selection');
  assert.equal(caret.startContainer, dom.editable().firstChild);
  assert.equal(caret.startOffset, 6);
});
