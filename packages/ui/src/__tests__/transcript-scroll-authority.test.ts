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
 * pixels needs a real layout engine and currently has no test at all — a
 * harness that fakes layout can only report the ordering the harness itself
 * chose, so do not add that claim here.
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
  /** The boxes `scrollHeight` is made of, which is what the authority watches. */
  children: readonly unknown[];
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
    children: [{}],
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
 * The authority watches the scroller's box and its children's boxes, and keeps
 * that set current with a `MutationObserver`, so the suite owns both. `resize`
 * is every box changing at once, which is the only distinction the authority
 * draws between them: none.
 *
 * Frames are not faked — nothing here schedules one. Whether a scroll event is
 * this authority's own is answered by where the scroller is, not by when the
 * event arrives.
 */
function withObservers<T>(run: (resize: () => void) => T): T {
  const observers = new Set<() => void>();
  const globals = globalThis as { ResizeObserver?: unknown; MutationObserver?: unknown };
  const originalResize = globals.ResizeObserver;
  const originalMutation = globals.MutationObserver;
  globals.ResizeObserver = class {
    constructor(private readonly callback: () => void) {}
    // Registered on `observe` rather than on construction: the authority
    // re-points one observer at a changing set of boxes, so a stub that ignored
    // `disconnect` and `observe` would report a detached authority as live.
    observe(): void {
      observers.add(this.callback);
    }
    disconnect(): void {
      observers.delete(this.callback);
    }
  };
  // The set of children only changes when the transcript mounts or unmounts
  // one, and `resize` already stands for every box in that set changing.
  globals.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
  try {
    return run(() => {
      for (const observer of [...observers]) observer();
    });
  } finally {
    globals.ResizeObserver = originalResize;
    globals.MutationObserver = originalMutation;
  }
}

test('content that grows under a pinned transcript keeps the tail on screen', () => {
  withObservers((resize) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    assert.equal(root.scrollTop, 2_400);

    root.grow(500);
    resize();
    assert.equal(root.scrollTop, 2_900);

    // Its own write echoes back as an ordinary scroll event, and finding the
    // scroller still on the offset it wrote is how it knows.
    root.emitScroll();
    assert.equal(authority.getSnapshot().pinned, true);
  });
});

test('a scroll this authority did not write is the reader, and releases the tail', () => {
  withObservers((resize) => {
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
    resize();
    assert.equal(root.scrollTop, 1_000);
  });
});

test('returning to the tail re-pins, and following resumes', () => {
  withObservers((resize) => {
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
    resize();
    assert.equal(root.scrollTop, 3_000);
  });
});

test('a detached authority writes nothing and reports the tail', () => {
  withObservers((resize) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    const detach = authority.attach(root as unknown as HTMLElement);
    detach();
    root.scrollTop = 0;
    root.grow(1_000);
    resize();
    assert.equal(root.scrollTop, 0);
  });
});

test('a viewport that loses height takes the pinned reader back to the tail', () => {
  withObservers((resize) => {
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
  withObservers((resize) => {
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

    resize();
    assert.equal(root.scrollTop, 2_702);
  });
});

test('growth that outruns the write does not read as the reader scrolling up', () => {
  withObservers((resize) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    assert.equal(root.scrollTop, 2_400);

    // The transcript grew, and the scroll event for it arrives before this
    // authority has been told to follow it. The offset is 302px from a tail
    // that moved — identical, as a position, to a reader who scrolled up.
    root.grow(302);
    root.scrollTop = 2_402;
    root.emitScroll();
    assert.equal(authority.getSnapshot().pinned, true);

    // The affordance still knows how far the tail now is, and the next growth
    // signal takes the reader back to it.
    assert.equal(authority.getSnapshot().awayFromTail, true);
    resize();
    assert.equal(root.scrollTop, 2_702);
  });
});

test('content landing above a released reader does not re-pin them', () => {
  withObservers((resize) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);

    // The reader is at the tail and asks for what is above them: a wheel the
    // scroller cannot act on, so only the command says so.
    authority.releasePin();
    assert.equal(authority.getSnapshot().pinned, false);

    // History lands above them and native anchoring moves the offset to keep
    // them still. Distance to the tail is unchanged — which is exactly the
    // reading that used to put the pin back and scroll the new turns away.
    root.grow(4_000);
    root.scrollTop = 6_400;
    root.emitScroll();
    assert.equal(authority.getSnapshot().pinned, false);

    resize();
    assert.equal(root.scrollTop, 6_400);
  });
});

test('only the reader\'s own movement reaches a reader-scroll listener', () => {
  withObservers(() => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    let heard = 0;
    const stop = authority.subscribeToReaderScroll(() => {
      heard += 1;
    });
    authority.attach(root as unknown as HTMLElement);

    // This authority's own write, echoed back late.
    root.emitScroll();
    assert.equal(heard, 0);

    // Content arriving, with anchoring moving the offset to hold the reader.
    root.grow(500);
    root.scrollTop = 2_900;
    root.emitScroll();
    assert.equal(heard, 0);

    // The reader, at last.
    root.scrollTop = 900;
    root.emitScroll();
    assert.equal(heard, 1);

    stop();
    root.scrollTop = 400;
    root.emitScroll();
    assert.equal(heard, 1);
  });
});
