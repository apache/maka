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
}

function harness() {
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => computedStyle();
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
    } = {
      container: null,
      offset: 0,
      collapsed: false,
      selectNodeContents(node) {
        range.container = node;
        range.offset = node.childNodes.length;
      },
      collapse(toStart) {
        range.offset = toStart ? 0 : range.offset;
        range.collapsed = true;
      },
    };
    return range as unknown as Range;
  };
  let active: Element | null = null;
  const selected: AimedRange[] = [];
  const selection = {
    get anchorNode(): Node | null {
      return selected.at(-1)?.container ?? null;
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
      const container = aimed.container as Element & { closest?: Element['closest'] };
      active = container?.closest?.('[contenteditable="true"]') ?? active;
    },
  };
  document.getSelection = () => selection as unknown as Selection;
  window.getSelection = () => selection as unknown as Selection;
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => active });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
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
  assert.ok(caret, 'the composer placed no caret');
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
