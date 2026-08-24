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
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { useTurnVirtualizer } from '../use-turn-virtualizer.js';

const originalGlobals = {
  document: globalThis.document,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  MutationObserver: globalThis.MutationObserver,
  Node: globalThis.Node,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  ResizeObserver: globalThis.ResizeObserver,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;

let mountedRoot: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

test('remeasures a short transcript when tall turns require virtualization', async () => {
  const { document, window } = parseHTML('<main id="root"></main>');
  const root = document.querySelector<HTMLElement>('#root');
  assert.ok(root);
  let scrollHeight = 0;
  Object.defineProperties(root, {
    clientHeight: { value: 800 },
    clientWidth: { value: 800 },
    scrollHeight: { get: () => scrollHeight },
    scrollTop: { value: 0, writable: true },
  });
  Object.defineProperty(document, 'getSelection', { value: () => null });

  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  class TestResizeObserver {
    static latest: TestResizeObserver | undefined;
    constructor(private readonly callback: ResizeObserverCallback) {
      TestResizeObserver.latest = this;
    }
    disconnect() {}
    observe() {}
    unobserve() {}
    emit(entries: ResizeObserverEntry[]) {
      this.callback(entries, this as unknown as ResizeObserver);
    }
  }
  class TestMutationObserver {
    disconnect() {}
    observe() {}
    takeRecords(): MutationRecord[] { return []; }
  }
  Object.assign(globalThis, {
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    MutationObserver: TestMutationObserver,
    Node: window.Node,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: TestResizeObserver,
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const turnIds = Array.from({ length: 8 }, (_, index) => `turn-${index}`);
  function Harness() {
    const scrollRef = useRef<HTMLElement | null>(root);
    const range = useTurnVirtualizer({ sessionId: 'tall-session', turnIds, scrollRef });
    return (
      <div data-range={`${range.start}:${range.end}`}>
        {turnIds.slice(range.start, range.end).map((turnId) => (
          <div key={turnId} data-virtual-turn-id={turnId} />
        ))}
      </div>
    );
  }

  mountedRoot = createRoot(root);
  await act(() => mountedRoot?.render(<Harness />));
  assert.equal(root.querySelector('[data-range]')?.getAttribute('data-range'), '0:8');

  const observer = TestResizeObserver.latest;
  assert.ok(observer);
  scrollHeight = 4_800;
  const entries = Array.from(root.querySelectorAll<HTMLElement>('[data-virtual-turn-id]')).map(
    (target) => ({ target, borderBoxSize: [{ blockSize: 600 }] }) as unknown as ResizeObserverEntry,
  );
  await act(() => observer.emit(entries));
  await act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });

  assert.notEqual(root.querySelector('[data-range]')?.getAttribute('data-range'), '0:8');
});
