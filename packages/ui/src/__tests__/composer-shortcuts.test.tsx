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

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';

import { parseHTML } from 'linkedom';
import { Composer, type ComposerHandle, type ComposerSendMetadata } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';


const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  KeyboardEvent: globalThis.KeyboardEvent,
  Node: globalThis.Node,
  HTMLElement: globalThis.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  Object.assign(globalThis, originalGlobals);
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

async function harness(platform = 'MacIntel', streaming = true, overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({ direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration;
  window.getSelection = () => null;
  document.getSelection = () => null;
  const setAttribute = window.Element.prototype.setAttribute;
  window.Element.prototype.setAttribute = function normalized(name: string, value: string) {
    return setAttribute.call(this, name === 'contentEditable' ? 'contenteditable' : name, value);
  };
  class KeyEvent extends window.Event {
    constructor(type: string, init: KeyboardEventInit = {}) {
      super(type, init);
      Object.assign(this, { key: 'Enter', code: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false }, init);
    }
  }
  const lineBreaks: string[] = [];
  document.execCommand = (command: string) => { lineBreaks.push(command); return true; };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform } });
  Object.assign(globalThis, { document, window, KeyboardEvent: KeyEvent, Node: window.Node, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector('#root')!);
  const ref = createRef<ComposerHandle>();
  const sends: { text: string; metadata?: ComposerSendMetadata }[] = [];
  cleanup = async () => {
    await act(() => root.unmount());
    window.Element.prototype.setAttribute = setAttribute;
  };
  await act(() => root.render(
    <LocaleProvider locale="en">
      <Composer ref={ref} streaming={streaming} onSend={(text, metadata) => { sends.push({ text, metadata }); }} onStop={() => undefined} {...overrides} />
    </LocaleProvider>,
  ));
  const editor = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
  assert.ok(editor);
  return {
    sends, lineBreaks, editor, ref,
    async draft(text = 'adjust the current task') { await act(() => ref.current!.setText(text)); },
    async press(init: KeyboardEventInit = {}) {
      const event = new KeyEvent('keydown', { bubbles: true, cancelable: true, ...init });
      await act(async () => { editor.dispatchEvent(event); await Promise.resolve(); });
      return event;
    },
    async submit() {
      await act(async () => {
        document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
    },
  };
}

for (const [platform, modifier, otherModifier] of [
  ['MacIntel', 'metaKey', 'ctrlKey'],
  ['Win32', 'ctrlKey', 'metaKey'],
  ['Linux x86_64', 'ctrlKey', 'metaKey'],
] as const) {
  for (const streaming of [false, true]) {
    test(`${platform}: primary Enter ${streaming ? 'steers once without changing later sends' : 'sends normally when idle'}`, async () => {
      const h = await harness(platform, streaming);
      await h.draft();
      await h.press({ [modifier]: true });
      assert.deepEqual(h.sends, [{ text: 'adjust the current task', metadata: streaming ? { followUpMode: 'steer' } : undefined }]);
      assert.equal(h.ref.current!.getText(), '');
      await h.draft('next task');
      await h.press();
      assert.deepEqual(h.sends[1], { text: 'next task', metadata: undefined });
      await h.draft('button send');
      await h.submit();
      assert.deepEqual(h.sends[2], { text: 'button send', metadata: undefined });
    });
    for (const newlineModifier of ['shiftKey', 'altKey'] as const) {
      test(`${platform}: ${newlineModifier}+Enter inserts a line break while ${streaming ? 'running' : 'idle'}, including with the primary modifier`, async () => {
        const h = await harness(platform, streaming);
        await h.draft();
        await h.press({ [newlineModifier]: true });
        await h.press({ [newlineModifier]: true, [modifier]: true });
        assert.deepEqual(h.sends, []);
        assert.deepEqual(h.lineBreaks, ['insertLineBreak', 'insertLineBreak']);
        assert.equal(h.ref.current!.getText(), 'adjust the current task');
      });
    }
  }
  test(`${platform}: the other platform modifier does not select steering`, async () => {
    const h = await harness(platform);
    await h.draft();
    await h.press({ [otherModifier]: true });
    assert.deepEqual(h.sends, [{ text: 'adjust the current task', metadata: undefined }]);
  });
  test(`${platform}: composing and empty drafts never send through the steering shortcut`, async () => {
    const h = await harness(platform);
    await h.press({ [modifier]: true });
    assert.deepEqual(h.sends, []);
    await h.draft();
    await h.press({ [modifier]: true, isComposing: true });
    assert.deepEqual(h.sends, []);
    assert.equal(h.ref.current!.getText(), 'adjust the current task');
  });
  test(`${platform}: an open mention menu retains Enter before steering`, async () => {
    const h = await harness(platform);
    await h.draft();
    h.editor.setAttribute('aria-expanded', 'true');
    await h.press({ [modifier]: true });
    assert.deepEqual(h.sends, []);
    assert.equal(h.ref.current!.getText(), 'adjust the current task');
  });
}

test('steering retains a refused draft', async () => {
  const h = await harness('MacIntel', true, { onSend: () => false });
  await h.draft();
  await h.press({ metaKey: true });
  assert.equal(h.ref.current!.getText(), 'adjust the current task');
});

test('a blocked composer cannot steer', async () => {
  const h = await harness('MacIntel', true, { sendBlocked: true });
  await h.draft();
  await h.press({ metaKey: true });
  assert.deepEqual(h.sends, []);
  assert.equal(h.ref.current!.getText(), 'adjust the current task');
});

test('steering supports staged context and coalesces repeated keys while admission is pending', async () => {
  let finish!: (accepted: boolean) => void;
  const calls: (ComposerSendMetadata | undefined)[] = [];
  const h = await harness('MacIntel', true, {
    pendingQuotes: [{ text: 'quoted context', sourceTurnId: 'turn-1' }],
    onSend: (_text, metadata) => { calls.push(metadata); return new Promise<boolean>((resolve) => { finish = resolve; }); },
  });
  await h.press({ metaKey: true });
  await h.press({ metaKey: true });
  assert.deepEqual(calls, [{ followUpMode: 'steer' }]);
  await act(async () => finish(true));
});

/*
 * Revealing the caret after a scripted edit. Measured in Chromium against the
 * editor's own styles: `insertLineBreak` at the draft end appends the newline
 * plus a placeholder newline and parks the caret between them (the
 * placeholder gives the new line its box and is consumed by the next
 * character); mid-text it splits the text and parks the caret at the start
 * of the rest. Unlike a native keypress the command never scrolls, so past
 * the max-rows cap the caret can land outside the viewport. linkedom carries
 * no selection or layout, so the caret, the ranges the composer inspects and
 * the line geometry are modeled over the editable's top-level child nodes:
 * 22px lines, 4px block padding, a 228px viewport (the 10-row cap plus
 * padding), and — as in Chromium — no client rect for a caret that sits
 * before a newline character.
 */
const LINE = 22;
const PAD = 4;
const VIEW = 10 * LINE + 2 * PAD;
function lineBreakHarness(editor: HTMLElement) {
  let caret = { node: editor.firstChild as Node, offset: 0 };
  // Painted leaves in document order: text nodes and <br>, however nested.
  const leaves = (root: Node = editor): Node[] =>
    Array.from(root.childNodes).flatMap((n) => (n.nodeType === 3 || n.nodeName === 'BR' ? [n] : leaves(n)));
  const text = (n: Node) => (n.nodeType === 3 ? n.textContent ?? '' : n.nodeName === 'BR' ? '\n' : '');
  const textBefore = (node: Node, offset: number) => {
    const all = leaves();
    const index = all.indexOf(node);
    if (index < 0) return '';
    return all.slice(0, index).map(text).join('') + text(node).slice(0, offset);
  };
  const value = () => leaves().map(text).join('');
  const lines = () => value().replace(/\n$/, '').split('\n').length;
  // A real scroll container clamps scrollTop to scrollHeight - clientHeight.
  let scrollTop = 0;
  Object.defineProperty(editor, 'scrollHeight', { configurable: true, get: () => 2 * PAD + LINE * lines() });
  Object.defineProperty(editor, 'clientHeight', { configurable: true, value: VIEW });
  Object.defineProperty(editor, 'clientTop', { configurable: true, value: 0 });
  Object.defineProperty(editor, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (next: number) => { scrollTop = Math.min(Math.max(0, next), editor.scrollHeight - VIEW); },
  });
  editor.getBoundingClientRect = () => ({ top: 0, bottom: VIEW, left: 0, right: 400, width: 400, height: VIEW, x: 0, y: 0, toJSON: () => ({}) });
  window.getComputedStyle = () => ({ direction: 'ltr', writingMode: 'horizontal-tb', lineHeight: `${LINE}px`, getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration;
  // A glyph rect 17px tall centred in its 22px line, in viewport coordinates.
  // A newline character paints on the line it ends, but a caret collapsed
  // before one paints nothing, as in Chromium.
  const rectsAt = (node: Node, offset: number, collapsed: boolean): DOMRect[] => {
    if (collapsed && (text(node).charAt(offset) === '\n' || node.nodeName === 'BR')) return [];
    const line = textBefore(node, offset).split('\n').length - 1;
    const top = PAD + line * LINE + 2.5 - editor.scrollTop;
    return [{ top, bottom: top + 17, height: 17, left: 0, right: 8, width: 8, x: 0, y: top, toJSON: () => ({}) } as DOMRect];
  };
  class FakeRange {
    startContainer: Node = editor;
    startOffset = 0;
    endContainer: Node = editor;
    endOffset = 0;
    setStart(node: Node, offset: number) { this.startContainer = node; this.startOffset = offset; }
    setEnd(node: Node, offset: number) { this.endContainer = node; this.endOffset = offset; }
    selectNode(node: Node) { this.startContainer = node; this.startOffset = 0; this.endContainer = node; this.endOffset = 0; }
    selectNodeContents(node: Node) { this.startContainer = node; this.startOffset = 0; this.endContainer = node; this.endOffset = node.childNodes.length; }
    collapse() { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
    cloneRange() { const r = new FakeRange(); r.setStart(this.startContainer, this.startOffset); r.setEnd(this.endContainer, this.endOffset); return r; }
    // Contents from the start point to the end of the editable, as a real
    // fragment so the composer's <br>/text folding runs unchanged.
    cloneContents() {
      const fragment = document.createDocumentFragment();
      const rest = value().slice(textBefore(this.startContainer, this.startOffset).length);
      if (rest) fragment.appendChild(document.createTextNode(rest));
      // linkedom's fragment has no textContent of its own.
      Object.defineProperty(fragment, 'textContent', {
        get: () => Array.from(fragment.childNodes).map((n) => (n.nodeType === 3 ? n.textContent ?? '' : '')).join(''),
      });
      return fragment;
    }
    getClientRects() {
      const collapsed = this.endContainer === this.startContainer && this.endOffset === this.startOffset;
      return rectsAt(this.startContainer, this.startOffset, collapsed) as unknown as DOMRectList;
    }
  }
  document.createRange = () => new FakeRange() as unknown as Range;
  const selection = {
    isCollapsed: true,
    rangeCount: 1,
    getRangeAt: () => { const r = new FakeRange(); r.setStart(caret.node, caret.offset); r.collapse(); return r; },
    removeAllRanges: () => undefined,
    addRange: () => undefined,
  };
  document.getSelection = () => selection as unknown as Selection;
  window.getSelection = () => selection as unknown as Selection;
  const insertAfterCaret = (nodes: Node[]) => {
    const parent = caret.node.parentNode ?? editor;
    const ref = caret.node.nextSibling;
    for (const node of nodes) parent.insertBefore(node, ref);
  };
  document.execCommand = (command: string, _ui?: boolean, data?: string) => {
    if (command === 'insertText') {
      const inserted = document.createTextNode(data ?? '');
      // Typing onto the placeholder consumes it, as Chromium does.
      if (caret.node.textContent === '\n' && caret.offset === 0 && caret.node === editor.lastChild) {
        editor.replaceChild(inserted, caret.node);
      } else {
        insertAfterCaret([inserted]);
      }
      caret = { node: inserted, offset: inserted.textContent?.length ?? 0 };
      return true;
    }
    if (command !== 'insertLineBreak') return true;
    const node = caret.node;
    const content = node.textContent ?? '';
    if (node.nodeType === 3 && caret.offset < content.length) {
      // Mid-text: split around the break; the caret lands before the rest.
      node.textContent = content.slice(0, caret.offset);
      const rest = document.createTextNode(content.slice(caret.offset));
      insertAfterCaret([document.createTextNode('\n'), rest]);
      caret = { node: rest, offset: 0 };
    } else if (textBefore(node, caret.offset) === value()) {
      // Draft end: the break plus Chromium's placeholder newline, caret between.
      const placeholder = document.createTextNode('\n');
      insertAfterCaret([document.createTextNode('\n'), placeholder]);
      caret = { node: placeholder, offset: 0 };
    } else {
      const lineBreak = document.createTextNode('\n');
      insertAfterCaret([lineBreak]);
      caret = { node: lineBreak.nextSibling as Node, offset: 0 };
    }
    return true;
  };
  return {
    value,
    caretToEnd: () => { caret = { node: editor.lastChild as Node, offset: editor.lastChild?.textContent?.length ?? 0 }; },
    caretTo: (node: Node, offset: number) => { caret = { node, offset }; },
    /** Scroll so that `line` (0-based) is the bottom visible row. */
    scrollToShowLine: (line: number) => { editor.scrollTop = Math.max(0, PAD + (line + 1) * LINE + PAD - VIEW); },
  };
}

const twelveLines = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n');

test('Shift+Enter at the draft end scrolls the new line into view', async () => {
  const h = await harness('MacIntel', true);
  await h.draft(twelveLines);
  const sel = lineBreakHarness(h.editor);
  sel.caretToEnd();
  assert.equal(h.editor.scrollHeight, 2 * PAD + 12 * LINE);
  await h.press({ shiftKey: true });
  assert.equal(sel.value(), `${twelveLines}\n\n`);
  // The reveal reads the height the break produced, not the one before it.
  assert.equal(h.editor.scrollHeight, 2 * PAD + 13 * LINE);
  assert.equal(h.editor.scrollTop, h.editor.scrollHeight - h.editor.clientHeight);
});

test('Shift+Enter mid-draft with the caret in view leaves the scroll position alone', async () => {
  const h = await harness('MacIntel', true);
  await h.draft(twelveLines);
  const sel = lineBreakHarness(h.editor);
  sel.caretTo(h.editor.firstChild!, 'line0\nline1\nli'.length);
  sel.scrollToShowLine(11);
  const before = h.editor.scrollTop;
  await h.press({ shiftKey: true });
  assert.equal(sel.value(), 'line0\nline1\nli\nne2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11');
  assert.equal(h.editor.scrollTop, before);
});

test('Shift+Enter in the bottom row pushes the rest of the line down and follows it', async () => {
  const h = await harness('MacIntel', true);
  await h.draft(twelveLines);
  const sel = lineBreakHarness(h.editor);
  sel.caretTo(h.editor.firstChild!, twelveLines.length - 2);
  sel.scrollToShowLine(11);
  const before = h.editor.scrollTop;
  await h.press({ shiftKey: true });
  assert.equal(sel.value(), `${twelveLines.slice(0, -2)}\n11`);
  // The caret now sits on line 13 (0-based 12), whose line box ends 18px
  // below the viewport: the reveal scrolls exactly that far, as Chromium's
  // native reveal does (padding is not kept in view).
  assert.equal(h.editor.scrollTop, PAD + 13 * LINE - VIEW);
  assert.ok(h.editor.scrollTop > before);
});

test('Shift+Enter before an existing empty line scrolls to that line, not to the end', async () => {
  const h = await harness('MacIntel', true);
  await h.draft('l0\n\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12');
  const sel = lineBreakHarness(h.editor);
  sel.caretTo(h.editor.firstChild!, 2);
  sel.scrollToShowLine(12);
  await h.press({ shiftKey: true });
  assert.equal(sel.value(), 'l0\n\n\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12');
  // A caret before a newline has no rect; the line below the previous
  // character (line 2, 0-based 1) is what gets revealed — at the top.
  assert.equal(h.editor.scrollTop, PAD + LINE);
  assert.notEqual(h.editor.scrollTop, h.editor.scrollHeight - h.editor.clientHeight);
});

test('a multi-line insert at the draft end scrolls the caret into view', async () => {
  const h = await harness('MacIntel', true);
  await h.draft(twelveLines);
  const sel = lineBreakHarness(h.editor);
  sel.caretToEnd();
  await act(async () => {
    const event = new window.Event('beforeinput', { bubbles: true, cancelable: true });
    Object.assign(event, { inputType: 'insertText', data: 'two\nthree\n' });
    h.editor.dispatchEvent(event);
    await Promise.resolve();
  });
  assert.equal(sel.value(), `${twelveLines}two\nthree\n\n`);
  assert.equal(h.editor.scrollTop, h.editor.scrollHeight - h.editor.clientHeight);
});

test('the caret at the start of a nested text node is located from the leaf before its wrapper', async () => {
  const h = await harness('MacIntel', true);
  await h.draft('l0\nl1\n\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12');
  const sel = lineBreakHarness(h.editor);
  // The DOM a break leaves when the rest of the draft sits in an inline
  // wrapper: the caret starts the wrapper's text, so it has no previous
  // sibling of its own — the leaf before it is the top-level text.
  const head = h.editor.firstChild as Text;
  const wrapper = document.createElement('span');
  wrapper.textContent = head.textContent!.slice('l0\nl1\n'.length);
  head.textContent = 'l0\nl1\n';
  h.editor.appendChild(wrapper);
  sel.caretTo(wrapper.firstChild!, 0);
  sel.scrollToShowLine(12);
  document.execCommand = () => true;
  await h.press({ shiftKey: true });
  // Line 3 (0-based 2) is revealed at the top; without the tree walk the
  // helper finds no anchor and the caret stays above the viewport.
  assert.equal(h.editor.scrollTop, PAD + 2 * LINE);
});
