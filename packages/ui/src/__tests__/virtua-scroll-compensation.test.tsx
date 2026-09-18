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
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { act, createRef } from 'react';
import type { VirtualizerHandle } from 'virtua';
import { installTranscriptDom } from './transcript-test-dom.js';

const require = createRequire(import.meta.url);

// These tests control ResizeObserver/scroll-event ordering around the real React
// virtualizer. Browser geometry is covered by perf/geometry-ablation.mjs.
async function mountVirtualizer(entry: 'esm' | 'cjs') {
  const dom = installTranscriptDom();
  const observers = new Set<ControlledResizeObserver>();
  class ControlledResizeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { observers.delete(this); }
  }
  Object.assign(dom.window, { ResizeObserver: ControlledResizeObserver });
  const { Virtualizer } = entry === 'esm'
    ? await import('virtua')
    : require('virtua') as typeof import('virtua');
  const handle = createRef<VirtualizerHandle>();
  let offset = 0;
  const maxOffset = () => Math.max(0, Number.parseFloat(
    (dom.container.firstElementChild as HTMLElement | null)?.style.height ?? '0',
  ) - 600);
  Object.defineProperties(dom.container, {
    clientHeight: { get: () => 600 },
    scrollHeight: { get: () => maxOffset() + 600 },
    scrollTop: {
      // Chromium clamps when content shrinks, before delivering a scroll event.
      get: () => (offset = Math.max(0, Math.min(offset, maxOffset()))),
      set: (value: number) => { offset = Math.max(0, Math.min(value, maxOffset())); },
    },
  });
  await dom.render(
    <Virtualizer ref={handle} itemSize={1_000} keepMounted={Array.from({ length: 10 }, (_, index) => index)}>
      {Array.from({ length: 10 }, (_, index) => <div key={index} data-row={index} />)}
    </Virtualizer>,
  );
  const measure = async (target: Element, height: number) => {
    await act(() => {
      for (const observer of observers) {
        if (!observer.targets.has(target)) continue;
        observer.callback(
          [{ target, contentRect: { height, width: 800 } } as ResizeObserverEntry],
          observer as unknown as ResizeObserver,
        );
      }
    });
  };
  await measure(dom.container, 600);
  const scroll = async (top: number) => {
    dom.container.scrollTop = top;
    await act(() => { dom.container.dispatchEvent(new dom.window.Event('scroll')); });
  };
  const resizeRow = (index: number, height: number) => {
    const row = dom.container.querySelector(`[data-row="${index}"]`)?.parentElement;
    assert.ok(row, `row ${index} is mounted`);
    return measure(row, height);
  };
  return {
    cleanup: dom.cleanup,
    scroll,
    resizeRow,
    top: () => dom.container.scrollTop,
    anchor: (index: number) => handle.current!.getItemOffset(index) - dom.container.scrollTop,
  };
}

for (const entry of ['esm', 'cjs'] as const) {
  test(`${entry}: consecutive height corrections preserve the reader before the scroll event`, async (context) => {
    const errors = context.mock.method(console, 'error', () => {});
    const view = await mountVirtualizer(entry);
    try {
      await view.scroll(6_000);
      await view.scroll(5_000);
      const anchor = view.anchor(5);
      await view.resizeRow(0, 600);
      assert.equal(view.top(), 4_600);
      // A second ResizeObserver delivery can commit before the first write's
      // native scroll event. It must retain that already-applied -400px jump.
      await view.resizeRow(1, 1_900);
      assert.equal(view.anchor(5), anchor);
      assert.equal(view.top(), 5_500);

      // After a native scroll, the next compensation starts at the reader's
      // new position, not a cached target from the previous corrections.
      await view.scroll(4_300);
      const nextAnchor = view.anchor(5);
      await view.resizeRow(2, 1_200);
      assert.equal(view.anchor(5), nextAnchor);
      assert.equal(view.top(), 4_500);
      assert.deepEqual(errors.mock.calls.map(call => call.arguments), [],
        'a correction larger than the viewport must not flushSync inside a React layout effect');
    } finally {
      await view.cleanup();
    }
  });

  test(`${entry}: compensation accounts for browser clamping when content shrinks at the bottom`, async () => {
    const view = await mountVirtualizer(entry);
    try {
      await view.scroll(9_400);
      const anchor = view.anchor(9);
      await view.resizeRow(8, 600);
      assert.equal(view.top(), 9_000);
      assert.equal(view.anchor(9), anchor);
      await view.resizeRow(7, 700);
      assert.equal(view.top(), 8_700);
      assert.equal(view.anchor(9), anchor);
    } finally {
      await view.cleanup();
    }
  });
}
