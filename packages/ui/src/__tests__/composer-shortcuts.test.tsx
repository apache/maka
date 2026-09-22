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
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { Composer, type ComposerHandle, type ComposerSendMetadata } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';
import { getConversationCopy } from '../conversation-copy.js';
import { PlatformShortcutText } from '../platform-shortcut-text.js';

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

for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
  for (const [platform, modifier] of [['MacIntel', 'Cmd'], ['Win32', 'Ctrl']] as const) {
    test(`${locale}: queue help renders ${modifier}+Enter on ${platform}`, () => {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform } });
      const markup = renderToStaticMarkup(<PlatformShortcutText {...getConversationCopy(locale).composer.queueShortcuts} />);
      assert.ok(markup.startsWith(`${modifier}+Enter`));
      assert.ok(markup.includes('Shift+Enter'));
    });
  }
}
