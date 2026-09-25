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
import test from 'node:test';
import { act, createRef } from 'react';
import { installTranscriptDom } from './transcript-test-dom.js';

// ResizeObserver may deliver more than one batch before the browser reports the
// scroll offset written by the previous batch. Exercise the installed vendor
// entry points so dropping the dependency patch restores the regression.
for (const entry of ['esm', 'cjs'] as const) {
  for (const secondHeight of [60, 50]) {
    test(`virtua ${entry} retains consecutive resize corrections (second height ${secondHeight})`, async () => {
      const dom = installTranscriptDom();
      const observers = new Set<ManualResizeObserver>();
      class ManualResizeObserver {
        readonly targets = new Set<Element>();
        constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
        observe(target: Element): void { this.targets.add(target); }
        unobserve(target: Element): void { this.targets.delete(target); }
        disconnect(): void { this.targets.clear(); observers.delete(this); }
      }
      Object.assign(globalThis, { ResizeObserver: ManualResizeObserver });
      Object.assign(dom.window, { ResizeObserver: ManualResizeObserver });
      const resize = async (target: Element, height: number) => {
        const observer = [...observers].find((candidate) => candidate.targets.has(target));
        assert.ok(observer, 'the virtualizer must observe this box');
        await act(async () => observer.callback(
          [{ target, contentRect: { height, width: 800 } } as ResizeObserverEntry],
          observer as unknown as ResizeObserver,
        ));
      };
      try {
        const { Virtualizer } = entry === 'esm'
          ? await import('virtua')
          : createRequire(import.meta.url)('virtua') as typeof import('virtua');
        const scrollRef = createRef<HTMLDivElement>();
        await dom.render(
          <div ref={scrollRef} data-chat-scroll-container>
            <Virtualizer scrollRef={scrollRef} itemSize={100} keepMounted={[0, 1, 2]}>
              {Array.from({ length: 20 }, (_, index) => <div key={index} data-row={index}>Row {index}</div>)}
            </Virtualizer>
          </div>,
        );
        const scroller = scrollRef.current!;
        Object.defineProperties(scroller, {
          scrollHeight: { configurable: true, get: () => 2000 },
          clientHeight: { configurable: true, get: () => 200 },
        });
        await resize(scroller, 200);
        const row = (index: number) => dom.container.querySelector(`[data-row="${index}"]`)!.parentElement!;
        await resize(row(0), 100);
        await resize(row(1), 100);
        scroller.scrollTop = 400;
        await act(async () => { scroller.dispatchEvent(new dom.window.Event('scroll')); });

        // Deliberately withhold the native scroll event between measurements.
        await resize(row(0), 150);
        assert.equal(scroller.scrollTop, 450);
        // A first measurement equal to the estimate needs no correction and
        // must not discard the correction that is still awaiting its event.
        await resize(row(2), 100);
        assert.equal(scroller.scrollTop, 450);
        await resize(row(1), secondHeight);
        assert.equal(scroller.scrollTop, 400 + 50 + secondHeight - 100);

        // Once the browser acknowledges the offset, the next correction must
        // start from that offset instead of replaying earlier compensation.
        await act(async () => { scroller.dispatchEvent(new dom.window.Event('scroll')); });
        await resize(row(0), 160);
        assert.equal(scroller.scrollTop, 400 + 60 + secondHeight - 100);
      } finally {
        await dom.cleanup();
      }
    });
  }
}
