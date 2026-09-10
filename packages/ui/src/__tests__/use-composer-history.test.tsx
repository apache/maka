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
import { afterEach, beforeEach, test } from 'node:test';
import { act, createRef, StrictMode, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { Composer, type ComposerHandle } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';
import { useComposerHistory } from '../use-composer-history.js';
import { clearGlobalInputHistory, saveGlobalInputHistoryEntry } from '../input-history.js';

const original = Object.fromEntries(
  ['document', 'window', 'Node', 'HTMLElement', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
const roots = new Set<ReturnType<typeof createRoot>>();
const storage = new Map<string, string>();
let reads = 0;
let unavailable = false;

beforeEach(() => {
  const { document, window } = parseHTML('<body></body>');
  document.getSelection = () => null;
  window.getComputedStyle = () => ({
    direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  storage.clear();
  reads = 0;
  unavailable = false;
  Object.assign(globalThis, {
    document, window, Node: window.Node, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string) {
        if (key === 'maka-input-history') reads++;
        if (unavailable) throw new Error('storage unavailable');
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (unavailable) throw new Error('storage unavailable');
        storage.set(key, value);
      },
      removeItem(key: string) {
        if (unavailable) throw new Error('storage unavailable');
        storage.delete(key);
      },
    },
  });
});

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount());
  roots.clear();
  for (const [key, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function newRoot() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.add(root);
  return { root, container };
}

function history(entries: unknown[]) {
  storage.set('maka-input-history', JSON.stringify(entries));
}

async function mount(strict: boolean) {
  const { root } = newRoot();
  let api!: ReturnType<typeof useComposerHistory>;
  let value = '';
  let revision = 0;
  const applied: Array<[number, string]> = [];
  function Probe({ version }: { version: number }) {
    api = useComposerHistory({
      text: { getValue: () => value, setValue: (next) => { value = next; } },
      saveCurrentDraft: (next) => { applied.push([version, next ?? '']); },
    });
    return null;
  }
  async function render() {
    const node = <Probe version={++revision} />;
    await act(() => root.render(strict ? <StrictMode>{node}</StrictMode> : node));
  }
  await render();
  return {
    render, applied,
    get: () => value,
    set: (next: string) => { value = next; },
    reset: () => api.resetNavigation(),
    remember: (next: string) => api.rememberSentEntry(next),
    arrow(key: string, modifiers: Partial<KeyboardEvent<Element>> = {}) {
      return api.handleArrowKey({
        key, preventDefault() {}, ...modifiers,
      } as KeyboardEvent<Element>);
    },
    async unmount() {
      await act(() => root.unmount());
      roots.delete(root);
    },
  };
}

for (const strict of [false, true]) {
  test(`history keeps mount fallback and live synchronization across rerenders (strict=${strict})`, async () => {
    history(['old', 42, '汉字\ud800']);
    const hook = await mount(strict);
    const mountedReads = reads;
    for (let i = 0; i < 12; i++) await hook.render();
    const rerenderReads = reads - mountedReads;

    // The initial snapshot must exist even before the first navigation.
    unavailable = true;
    hook.set('unsent\ndraft');
    assert.equal(hook.arrow('ArrowUp'), false);
    assert.equal(hook.arrow('ArrowUp', { shiftKey: true }), false);
    assert.equal(hook.arrow('ArrowUp', { ctrlKey: true }), true);
    assert.equal(hook.get(), '汉字\ud800');
    hook.arrow('ArrowDown');
    assert.equal(hook.get(), 'unsent\ndraft');

    // Successful send, and an external writer, still refresh the active ref.
    unavailable = false;
    hook.remember('  newest  ');
    hook.set('');
    hook.arrow('ArrowUp');
    assert.equal(hook.get(), 'newest');
    saveGlobalInputHistoryEntry('external');
    hook.reset();
    hook.set('');
    hook.arrow('ArrowUp');
    assert.equal(hook.get(), 'external');

    // Storage corruption keeps the last valid snapshot, including after render.
    storage.set('maka-input-history', '{');
    await hook.render();
    hook.reset();
    hook.set('');
    hook.arrow('ArrowUp');
    assert.equal(hook.get(), 'external');
    storage.set('maka-input-history', '{}');
    hook.arrow('ArrowUp');
    assert.equal(hook.get(), 'newest');

    // Notifications use the latest render's draft callback.
    history(['clear-me']);
    hook.reset();
    hook.set('draft before clear');
    hook.arrow('ArrowUp', { metaKey: true });
    await hook.render();
    clearGlobalInputHistory();
    assert.deepEqual(hook.applied.at(-1), [15, hook.get()]);
    assert.equal(hook.arrow('ArrowUp', { ctrlKey: true }), true);
    await hook.unmount();
    const beforeWrite = reads;
    saveGlobalInputHistoryEntry('after unmount');
    assert.equal(reads - beforeWrite, 1, 'unmount removes the history subscriber');

    // A new mount must not reuse the retired mount's entries.
    const replacement = await mount(strict);
    unavailable = true;
    replacement.arrow('ArrowUp');
    assert.equal(replacement.get(), 'after unmount');
    assert.equal(rerenderReads, 0, 'ordinary renders must not parse discarded history');
  });
}

test('actual Composer text updates do not reread its persisted history', async () => {
  const entries = Array.from({ length: 50 }, (_, index) => `${index}:${'x'.repeat(32768)}`);
  history(entries);
  const raw = storage.get('maka-input-history');
  const { root, container } = newRoot();
  const ref = createRef<ComposerHandle>();
  await act(() => root.render(
    <LocaleProvider locale="en"><Composer ref={ref} onSend={() => undefined} onStop={() => undefined} /></LocaleProvider>,
  ));
  assert.ok(ref.current);
  const initialReads = reads;
  for (let i = 0; i < 16; i++) {
    const draft = `updated draft ${i} 汉字`;
    await act(() => ref.current?.setText(draft));
    assert.equal(ref.current.getText(), draft);
    assert.ok(container.textContent?.includes(draft));
  }
  assert.equal(storage.get('maka-input-history'), raw);
  assert.equal(reads - initialReads, 0, 'text state updates do not allocate parsed history');
});
