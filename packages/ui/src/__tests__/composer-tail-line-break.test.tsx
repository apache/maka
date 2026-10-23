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
 * #5811: a line break at the very end of the draft (Shift+Enter at the tail,
 * a multi-line insert ending in one) must reveal the tail line — Chromium
 * gives it no line box under `white-space: pre-wrap`, so at the max-rows cap
 * nothing scrolls to it. Contract: the editor scrolls to the tail iff the
 * caret ends the draft. The geometry half (a box for the trailing line)
 * lives in the renderer CSS; there is no unit layout to pin it here.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer, type ComposerHandle } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';
import { installDom } from './mermaid-test-dom.js';

let dom: ReturnType<typeof installDom> | undefined;

afterEach(() => { dom?.restore(); dom = undefined; });

async function harness() {
  dom = installDom();
  const document = globalThis.document;
  const window = globalThis.window;
  // The caret under test: everything reading the Selection routes through
  // this pair (linkedom's Range cannot express one); it must stay INSIDE the
  // editor, whose controlled rewrite's focus restore reads it.
  const caret = { container: null as Node | null, offset: 0 };
  const lineBreaks: string[] = [];
  const caretRange = () => ({ startContainer: caret.container, startOffset: caret.offset, endContainer: caret.container, endOffset: caret.offset, cloneRange: caretRange });
  const selection = { isCollapsed: true, rangeCount: 1, getRangeAt: caretRange, removeAllRanges() {}, addRange() {} };
  window.getSelection = document.getSelection = () => selection as unknown as Selection;
  document.execCommand = (command: string) => { lineBreaks.push(command); return true; };
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
  const root = createRoot(document.querySelector('#root')!);
  const ref = createRef<ComposerHandle>();
  await act(() => root.render(
    <LocaleProvider locale="en">
      <Composer ref={ref} streaming={false} onSend={() => undefined} onStop={() => undefined} />
    </LocaleProvider>,
  ));
  const editor = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
  assert.ok(editor);
  editor.scrollTop = 0;
  caret.container = editor;
  return {
    lineBreaks, editor,
    /** Draft text, then park the collapsed caret at `offset` inside it. */
    async draft(text: string, offset = text.length) {
      caret.container = editor;
      caret.offset = 0;
      await act(() => ref.current!.setText(text));
      caret.container = editor.firstChild!;
      caret.offset = offset;
    },
    /** The restored-draft shape: caret parked past a serialized trailing
     *  break, on the editable boundary. */
    async draftEndingInBreak(text: string) {
      await this.draft(text);
      await act(async () => { editor.appendChild(document.createElement('br')); });
      caret.container = editor;
      caret.offset = editor.childNodes.length;
    },
    /** The shape Chromium leaves after a real Shift+Enter at the tail under
     *  `break-spaces`: the inserted break is a literal `\n` text node and the
     *  caret parks at its offset 0. */
    async draftEndingInNewlineText(text: string) {
      await this.draft(text);
      await act(async () => { editor.appendChild(document.createTextNode('\n')); });
      caret.container = editor.lastChild!;
      caret.offset = 0;
    },
    capAt(scrollHeight: number) {
      Object.defineProperty(editor, 'scrollHeight', { configurable: true, value: scrollHeight });
    },
    async press(init: KeyboardEventInit = {}) {
      await act(() => editor.dispatchEvent(new KeyEvent('keydown', { bubbles: true, cancelable: true, ...init })));
    },
    /** A programmatic multi-line insert (dictation/paste path). */
    async typeAcrossLines(data: string) {
      const event = new window.Event('beforeinput', { bubbles: true, cancelable: true });
      Object.assign(event, { inputType: 'insertText', data });
      await act(async () => { editor.dispatchEvent(event); await Promise.resolve(); });
    },
  };
}

for (const newlineModifier of ['shiftKey', 'altKey'] as const) {
  test(`${newlineModifier}+Enter at the end of the draft reveals the tail line`, async () => {
    const h = await harness();
    await h.draft('abc');
    h.capAt(220);
    await h.press({ [newlineModifier]: true });
    assert.deepEqual(h.lineBreaks, ['insertLineBreak']);
    assert.equal(h.editor.scrollTop, 220);
  });
}

test('a mid-draft line break never scrolls', async () => {
  const h = await harness();
  await h.draft('abc', 1);
  h.capAt(220);
  await h.press({ shiftKey: true });
  assert.deepEqual(h.lineBreaks, ['insertLineBreak']);
  assert.equal(h.editor.scrollTop, 0);
});

test('a caret parked past a trailing break still counts as the tail', async () => {
  const h = await harness();
  await h.draftEndingInBreak('abc');
  h.capAt(220);
  await h.press({ shiftKey: true });
  assert.equal(h.editor.scrollTop, 220);
});

test('a caret parked before trailing newline text still counts as the tail', async () => {
  const h = await harness();
  await h.draftEndingInNewlineText('abc');
  h.capAt(220);
  await h.press({ shiftKey: true });
  assert.equal(h.editor.scrollTop, 220);
});

test('a caret before a newline that carries text stays mid-draft', async () => {
  const h = await harness();
  await h.draft('\nbc', 0);
  h.capAt(220);
  await h.press({ shiftKey: true });
  assert.deepEqual(h.lineBreaks, ['insertLineBreak']);
  assert.equal(h.editor.scrollTop, 0);
});

test('a multi-line insert ending in a break reveals the tail line', async () => {
  const h = await harness();
  await h.draft('abc');
  h.capAt(220);
  await h.typeAcrossLines('x\n');
  assert.ok(h.lineBreaks.includes('insertLineBreak'));
  assert.equal(h.editor.scrollTop, 220);
});
