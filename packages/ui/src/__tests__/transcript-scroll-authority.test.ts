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
 * The state machine only. Whether the reader ends up looking at the right
 * pixels is `apps/desktop/e2e/transcript-scroll.spec.ts`, in a real Chromium
 * with a real scroller — a harness that fakes layout can only report the
 * ordering the harness itself chose.
 *
 * What is worth asserting here is the one property the whole design rests on:
 * a scroll event that this authority did not cause is the reader, exactly, with
 * no signal in between to be wrong about.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTranscriptScrollAuthority } from '../transcript-scroll-authority.js';

interface FakeRoot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  /** Dispatch the scroll event the browser would, one frame later. */
  emitScroll(): void;
  grow(by: number): void;
  /** Take height away from the viewport, as a resize or a taller dock does. */
  shrinkViewport(by: number): void;
}

function fakeRoot(options?: { scrollHeight?: number; clientHeight?: number }): FakeRoot {
  const listeners = new Set<() => void>();
  const root: FakeRoot = {
    scrollTop: 0,
    scrollHeight: options?.scrollHeight ?? 3_000,
    clientHeight: options?.clientHeight ?? 600,
    addEventListener(type, listener) {
      if (type === 'scroll') listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    emitScroll() {
      for (const listener of [...listeners]) listener();
    },
    grow(by) {
      root.scrollHeight += by;
    },
    shrinkViewport(by) {
      root.clientHeight -= by;
    },
  };
  // The browser clamps a write past the end; without that the "we wrote it"
  // and "the reader is at the tail" cases would not agree on any number.
  return new Proxy(root, {
    set(target, property, value) {
      if (property === 'scrollTop') {
        target.scrollTop = Math.min(value as number, target.scrollHeight - target.clientHeight);
        return true;
      }
      return Reflect.set(target, property, value);
    },
  });
}

/**
 * The authority observes the scroller's own box as well as the content, so the
 * suite owns a `ResizeObserver`. Frames are not faked: nothing here schedules
 * one — whether a scroll event is this authority's own is answered by where the
 * scroller is, not by when the event arrives.
 */
function withResizeObserver<T>(run: (resize: () => void) => T): T {
  const observers = new Set<() => void>();
  const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private readonly callback: () => void) {
      observers.add(callback);
    }
    observe(): void {}
    disconnect(): void {
      observers.delete(this.callback);
    }
  };
  try {
    return run(() => {
      for (const observer of [...observers]) observer();
    });
  } finally {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
  }
}

test('content that grows under a pinned transcript keeps the tail on screen', () => {
  withResizeObserver(() => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    assert.equal(root.scrollTop, 2_400);

    root.grow(500);
    authority.notifyContentResize();
    assert.equal(root.scrollTop, 2_900);

    // The write's own scroll event lands before the frame that clears the flag,
    // which is the whole reason the flag exists.
    root.emitScroll();
    assert.equal(authority.getSnapshot().pinned, true);
  });
});

test('a scroll this authority did not write is the reader, and releases the tail', () => {
  withResizeObserver(() => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);

    root.scrollTop = 1_000;
    root.emitScroll();
    assert.equal(authority.getSnapshot().pinned, false);
    assert.equal(authority.getSnapshot().awayFromTail, true);

    // Nothing arriving afterwards may move the reader: with the pin released
    // this authority writes nothing at all, and native anchoring holds the
    // position the reader chose.
    root.grow(4_000);
    authority.notifyContentResize();
    assert.equal(root.scrollTop, 1_000);
  });
});

test('returning to the tail re-pins, and following resumes', () => {
  withResizeObserver(() => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    root.scrollTop = 0;
    root.emitScroll();
    assert.equal(authority.getSnapshot().pinned, false);

    authority.pinToTail();
    assert.equal(root.scrollTop, 2_400);
    assert.equal(authority.getSnapshot().awayFromTail, false);

    root.grow(600);
    authority.notifyContentResize();
    assert.equal(root.scrollTop, 3_000);
  });
});

test('a detached authority writes nothing and reports the tail', () => {
  withResizeObserver(() => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    const detach = authority.attach(root as unknown as HTMLElement);
    detach();
    root.scrollTop = 0;
    root.grow(1_000);
    authority.notifyContentResize();
    assert.equal(root.scrollTop, 0);
  });
});

test('a viewport that loses height takes the pinned reader back to the tail', () => {
  withResizeObserver((resize) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);

    // The transcript did not change at all — the box looking at it did, which
    // is a window resize, a composer gaining a line, or a dock growing taller.
    root.shrinkViewport(300);
    resize();
    assert.equal(root.scrollTop, 2_700);
    assert.equal(authority.getSnapshot().pinned, true);
  });
});

test('a scroll event that arrives late is still this authority\'s own write', () => {
  withResizeObserver(() => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    assert.equal(root.scrollTop, 2_400);

    // The write's event has not been dispatched yet, and the transcript keeps
    // growing underneath it. By the time it lands the scroller is 302px from a
    // tail that has moved — which is exactly what a reader who scrolled up
    // looks like, and is why timing cannot be the discriminator.
    root.grow(302);
    root.emitScroll();
    assert.equal(authority.getSnapshot().pinned, true);

    authority.notifyContentResize();
    assert.equal(root.scrollTop, 2_702);
  });
});
