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
 * Frames are explicit: the flag that says "this scroll was ours" is cleared on
 * the next frame, and every case below turns on whether the event arrives
 * before or after that.
 */
function withFrames<T>(run: (flush: () => void) => T): T {
  const pending: FrameRequestCallback[] = [];
  const originalWindow = (globalThis as { window?: unknown }).window;
  const handles = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  (globalThis as { window?: unknown }).window = {
    requestAnimationFrame(callback: FrameRequestCallback) {
      const handle = nextHandle++;
      handles.set(handle, callback);
      pending.push(callback);
      return handle;
    },
    cancelAnimationFrame(handle: number) {
      const callback = handles.get(handle);
      handles.delete(handle);
      const index = callback ? pending.indexOf(callback) : -1;
      if (index >= 0) pending.splice(index, 1);
    },
  };
  try {
    return run(() => {
      const frame = pending.splice(0, pending.length);
      for (const callback of frame) callback(0);
    });
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
}

test('content that grows under a pinned transcript keeps the tail on screen', () => {
  withFrames((flush) => {
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
    flush();
    assert.equal(authority.getSnapshot().pinned, true);
  });
});

test('a scroll this authority did not write is the reader, and releases the tail', () => {
  withFrames((flush) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    flush();

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
  withFrames((flush) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    flush();
    root.scrollTop = 0;
    root.emitScroll();
    assert.equal(authority.getSnapshot().pinned, false);

    authority.pinToTail();
    assert.equal(root.scrollTop, 2_400);
    assert.equal(authority.getSnapshot().awayFromTail, false);
    flush();

    root.grow(600);
    authority.notifyContentResize();
    assert.equal(root.scrollTop, 3_000);
  });
});

test('a detached authority writes nothing and reports the tail', () => {
  withFrames(() => {
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
