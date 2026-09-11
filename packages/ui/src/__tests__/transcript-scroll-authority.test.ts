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

/** State/command tests. Real layout and native input are checked in Chromium. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTranscriptScrollAuthority } from '../transcript-scroll-authority.js';

interface FakeRoot {
  ownerDocument: EventTarget;
  style: { overflowAnchor: string };
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** The boxes `scrollHeight` is made of, which is what the authority watches. */
  children: readonly unknown[];
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  input(deltaY: number, modifiers?: { ctrlKey?: boolean; metaKey?: boolean }): void;
  grabScrollbar(): void;
  end(): void;
  /** Dispatch the scroll event the browser would, one frame later. */
  emitScroll(): void;
  grow(by: number): void;
  /** Take height away from the viewport, as a resize or a taller dock does. */
  shrinkViewport(by: number): void;
}

function fakeRoot(options?: { scrollHeight?: number; clientHeight?: number }): FakeRoot {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const emit = (type: string, event?: unknown): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const root: FakeRoot = {
    ownerDocument: new EventTarget(),
    style: { overflowAnchor: '' },
    scrollTop: 0,
    scrollHeight: options?.scrollHeight ?? 3_000,
    clientHeight: options?.clientHeight ?? 600,
    children: [{}],
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emitScroll() {
      emit('scroll');
    },
    input(deltaY, modifiers) { emit('wheel', { deltaY, ...modifiers, composedPath: () => [proxy] }); },
    grabScrollbar() {
      emit('pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1, target: proxy });
    },
    end() { emit('scrollend'); },
    grow(by) {
      root.scrollHeight += by;
    },
    shrinkViewport(by) {
      root.clientHeight -= by;
    },
  };
  // The browser clamps a write past the end; without that the "we wrote it"
  // and "the reader is at the tail" cases would not agree on any number.
  const proxy = new Proxy(root, {
    set(target, property, value) {
      if (property === 'scrollTop') {
        target.scrollTop = Math.min(value as number, target.scrollHeight - target.clientHeight);
        return true;
      }
      return Reflect.set(target, property, value);
    },
  });
  return proxy;
}

/**
 * The authority watches the scroller's box and its children's boxes, and keeps
 * that set current with a `MutationObserver`, so the suite owns both. `resize`
 * is every box changing at once, which is the only distinction the authority
 * draws between them: none.
 *
 * End-of-operation frame callbacks are advanced explicitly.
 */
function withObservers<T>(run: (resize: () => void, frame: () => void) => T): T {
  const observers = new Set<() => void>();
  const frames: FrameRequestCallback[] = [];
  const globals = globalThis as { ResizeObserver?: unknown; MutationObserver?: unknown; requestAnimationFrame?: unknown };
  const originalResize = globals.ResizeObserver;
  const originalMutation = globals.MutationObserver;
  const originalFrame = globals.requestAnimationFrame;
  globals.requestAnimationFrame = (callback: FrameRequestCallback) => frames.push(callback);
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
    }, () => { for (const callback of frames.splice(0)) callback(0); });
  } finally {
    globals.ResizeObserver = originalResize;
    globals.MutationObserver = originalMutation;
    globals.requestAnimationFrame = originalFrame;
  }
}

test('Ctrl and Meta wheel zoom preserve following without requesting history', () => {
  withObservers((resize) => {
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
      const root = fakeRoot();
      const authority = createTranscriptScrollAuthority();
      const detach = authority.attach(root as unknown as HTMLElement);
      let readerReports = 0;
      authority.subscribeToReaderScroll(() => { readerReports += 1; });
      root.input(-100, modifiers);
      root.grow(200);
      resize();
      assert.equal(authority.getSnapshot().pinned, true);
      assert.equal(root.scrollTop, root.scrollHeight - root.clientHeight);
      assert.equal(readerReports, 0);
      detach();
    }
  });
});

test('content that grows under a pinned transcript keeps the tail on screen', () => {
  withObservers((resize) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    assert.equal(root.scrollTop, 2_400);

    root.grow(500);
    resize();
    assert.equal(root.scrollTop, 2_900);

    // The write's scroll event carries no reader input.
    root.emitScroll();
    assert.equal(authority.getSnapshot().pinned, true);
  });
});

test('identical shrink/grow geometry follows only when no reader input intervened', () => {
  for (const readerInput of [false, true]) {
    withObservers((resize) => {
      const root = fakeRoot();
      const authority = createTranscriptScrollAuthority();
      authority.attach(root as unknown as HTMLElement);
      let readerMoves = 0;
      authority.subscribeToReaderScroll((_direction, phase) => {
        if (phase === 'scroll') readerMoves += 1;
      });
      if (readerInput) root.input(-100);
      root.grow(-190);
      root.scrollTop = 2_210; // Browser clamps at the intermediate bottom.
      root.grow(22);
      root.emitScroll();
      assert.equal(authority.getSnapshot().pinned, !readerInput);
      assert.equal(readerMoves, readerInput ? 1 : 0);
      resize();
      assert.equal(root.scrollTop, readerInput ? 2_210 : 2_232);
    });
  }
});

test('scrollend cannot retire a continuing operation or a newer input', () => {
  withObservers((resize, frame) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    root.input(-100);
    root.scrollTop = 1_000;
    root.emitScroll();
    root.end();
    root.input(100);
    frame();
    frame();
    root.scrollTop = 1_500;
    root.emitScroll();
    root.end(); // An old animation ends while the new one is still moving.
    frame();
    root.scrollTop = 2_400;
    root.emitScroll();
    frame();
    root.end();
    frame();
    frame();
    assert.equal(authority.getSnapshot().pinned, true);
    root.grow(50);
    resize();
    assert.equal(root.scrollTop, 2_450);
  });
});

test('scrollbar defaults can land after pointerup, while an unmoved click retires', () => {
  withObservers((resize, frame) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    root.grabScrollbar();
    root.ownerDocument.dispatchEvent(new Event('pointerup'));
    root.scrollTop = 1_700;
    root.emitScroll();
    frame();
    root.end();
    frame();
    frame();
    root.grow(100);
    resize();
    assert.equal(root.scrollTop, 1_700);

    authority.pinToTail();
    root.grabScrollbar();
    root.ownerDocument.dispatchEvent(new Event('pointerup'));
    frame();
    root.grow(100);
    resize();
    assert.equal(root.scrollTop, 2_600);
  });
});

test('explicit navigation cancels input provenance before positioning its target', () => {
  withObservers(() => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    root.input(-100);
    root.scrollTop = 1_700;
    root.emitScroll();
    authority.releasePin();
    let reports = 0;
    authority.subscribeToReaderScroll(() => { reports += 1; });
    root.scrollTop = 200;
    root.emitScroll();
    assert.equal(reports, 0);
    assert.equal(authority.getSnapshot().pinned, false);
  });
});

test('user input releases the tail before content can overwrite the scroll', () => {
  withObservers((resize) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);

    root.input(-100);
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
    root.input(-100);
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

test('a reader who scrolls up while the answer grows is still the reader', () => {
  withObservers((resize) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    assert.equal(root.scrollTop, 2_400);

    // Input must suspend following before a concurrent resize can write.
    root.grow(37);
    root.input(-500);
    root.scrollTop = 1_900;
    root.emitScroll();
    assert.equal(authority.getSnapshot().pinned, false);
    assert.equal(authority.getSnapshot().awayFromTail, true);

    // And the pin stays off: what arrives next is more of the same answer, and
    // following it would take the transcript away from where they went.
    root.grow(300);
    resize();
    assert.equal(root.scrollTop, 1_900);
  });
});

test('reports both directions even when the reader returns to the last written offset', () => {
  withObservers(() => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    const directions: string[] = [];
    authority.subscribeToReaderScroll((direction, phase) => { if (phase === 'scroll') directions.push(direction); });
    root.emitScroll();
    root.input(-100);
    root.scrollTop = 900;
    root.emitScroll();
    root.input(100);
    root.scrollTop = 2_400;
    root.emitScroll();
    root.end();
    assert.deepEqual(directions, ['up', 'down']);
  });
});

test('a slow reader is a reader, however small each step is', () => {
  withObservers((resize) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    let readerMoves = 0;
    authority.subscribeToReaderScroll(() => {
      readerMoves += 1;
    });

    // A trackpad crossing the transcript unhurriedly. Judged one event at a
    // time against the rounding this has to tolerate, every one of these is
    // noise and the reader never moves at all; they only mean anything added
    // up. Nothing grows here, so there is nothing else they could be.
    for (let step = 0; step < 90; step += 1) {
      root.input(-2);
      root.scrollTop -= 2;
      root.emitScroll();
    }
    assert.equal(authority.getSnapshot().pinned, false);
    assert.ok(readerMoves > 0, 'the reader moved 180px and was never heard');

    root.grow(500);
    resize();
    assert.equal(root.scrollTop, 2_220);
  });
});

test('content leaving from above the reader is not the reader either', () => {
  withObservers(() => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    authority.releasePin();
    root.scrollTop = 1_500;
    root.emitScroll();
    assert.equal(authority.getSnapshot().pinned, false);
    let readerMoves = 0;
    authority.subscribeToReaderScroll(() => {
      readerMoves += 1;
    });

    // A tool block above them folds away. Anchoring answers a removal the same
    // way it answers an arrival — by moving the offset exactly as far — so the
    // reader is still looking at the same content and has asked for nothing.
    root.grow(-60);
    root.scrollTop = 1_440;
    root.emitScroll();
    assert.equal(readerMoves, 0);
    assert.equal(authority.getSnapshot().pinned, false);
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
    const stop = authority.subscribeToReaderScroll((_direction, phase) => {
      if (phase === 'scroll') heard += 1;
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
    root.input(-100);
    root.scrollTop = 900;
    root.emitScroll();
    assert.equal(heard, 1);

    stop();
    root.scrollTop = 400;
    root.emitScroll();
    assert.equal(heard, 1);
  });
});
