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
 * The authority watches the scroller's box and its children's boxes. `resize`
 * is every box changing at once, which is the only distinction the authority
 * draws between them: none.
 *
 * End-of-operation frame callbacks are advanced explicitly.
 */
function withObservers<T>(run: (resize: () => void, frame: () => void) => T): T {
  const observers = new Set<() => void>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const globals = globalThis as {
    ResizeObserver?: unknown;
    MutationObserver?: unknown;
    requestAnimationFrame?: unknown;
    cancelAnimationFrame?: unknown;
  };
  const originalResize = globals.ResizeObserver;
  const originalMutation = globals.MutationObserver;
  const originalFrame = globals.requestAnimationFrame;
  const originalCancelFrame = globals.cancelAnimationFrame;
  globals.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globals.cancelAnimationFrame = (id: number) => { frames.delete(id); };
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
  globals.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
  try {
    return run(() => {
      for (const observer of [...observers]) observer();
    }, () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  } finally {
    globals.ResizeObserver = originalResize;
    globals.MutationObserver = originalMutation;
    globals.requestAnimationFrame = originalFrame;
    globals.cancelAnimationFrame = originalCancelFrame;
  }
}

test('native scroll anchoring stays off while attached and is restored on detach', () => {
  withObservers(() => {
    const root = fakeRoot();
    root.style.overflowAnchor = 'auto';
    const authority = createTranscriptScrollAuthority();
    const detach = authority.attach(root as unknown as HTMLElement);
    assert.equal(root.style.overflowAnchor, 'none');
    root.input(-100);
    root.scrollTop = 1_000;
    root.emitScroll();
    assert.equal(authority.getSnapshot().pinned, false);
    assert.equal(root.style.overflowAnchor, 'none', 'releasing the pin does not hand anchoring back');
    detach();
    assert.equal(root.style.overflowAnchor, 'auto');
  });
});

test('Ctrl and Meta wheel zoom preserve following', () => {
  withObservers((resize) => {
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
      const root = fakeRoot();
      const authority = createTranscriptScrollAuthority();
      const detach = authority.attach(root as unknown as HTMLElement);
      root.input(-100, modifiers);
      root.grow(200);
      resize();
      assert.equal(authority.getSnapshot().pinned, true);
      assert.equal(root.scrollTop, root.scrollHeight - root.clientHeight);
      detach();
    }
  });
});

test('an upward gesture at an unmoving edge keeps following', () => {
  withObservers((resize, frame) => {
    const root = fakeRoot({ scrollHeight: 600, clientHeight: 600 });
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    root.input(-100);
    frame();
    frame();
    assert.equal(authority.getSnapshot().pinned, true);
    root.grow(400);
    resize();
    assert.equal(root.scrollTop, 400);
  });
});

test('a passive wheel delivered after its threaded scroll reached the top releases the tail', () => {
  withObservers((resize, frame) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    assert.equal(root.scrollTop, 2_400);
    root.scrollTop = 0;
    root.emitScroll();
    root.end();
    root.input(-4_000);
    frame();
    frame();
    assert.equal(authority.getSnapshot().pinned, false);
    root.grow(200);
    resize();
    assert.equal(root.scrollTop, 0);
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
      if (readerInput) root.input(-100);
      root.grow(-190);
      root.scrollTop = 2_210; // Browser clamps at the intermediate bottom.
      root.grow(22);
      root.emitScroll();
      assert.equal(authority.getSnapshot().pinned, !readerInput);
      resize();
      assert.equal(root.scrollTop, readerInput ? 2_210 : 2_232);
    });
  }
});

test('history prepended above a pinned reader moves the offset without releasing the pin', () => {
  withObservers((resize) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    // The virtualizer shifts the offset by the prepended height itself.
    root.grow(4_000);
    root.scrollTop += 4_000;
    root.emitScroll();
    resize();
    assert.equal(authority.getSnapshot().pinned, true);
    assert.equal(root.scrollTop, root.scrollHeight - root.clientHeight);
  });
});

test('content landing above a released reader does not re-pin them', () => {
  withObservers((resize) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    authority.releasePin();
    assert.equal(authority.getSnapshot().pinned, false);

    // Distance to the tail is unchanged — which is exactly the reading that
    // used to put the pin back and scroll the new turns away.
    root.grow(4_000);
    root.scrollTop = 6_400;
    root.emitScroll();
    assert.equal(authority.getSnapshot().pinned, false);

    resize();
    assert.equal(root.scrollTop, 6_400);
  });
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

test('a detached authority writes nothing', () => {
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

    root.grow(300);
    resize();
    assert.equal(root.scrollTop, 1_900);
  });
});

test('a slow reader is a reader, however small each step is', () => {
  withObservers((resize) => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    for (let step = 0; step < 90; step += 1) {
      root.input(-2);
      root.scrollTop -= 2;
      root.emitScroll();
    }
    assert.equal(authority.getSnapshot().pinned, false);

    root.grow(500);
    resize();
    assert.equal(root.scrollTop, 2_220);
  });
});

test('the reading position is the Turn the attached reader names under the offset', () => {
  withObservers((resize) => {
    const root = fakeRoot();
    let turnIds = ['turn-1', 'turn-2', 'turn-3'];
    let offset = 0;
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement, {
      turnAt: (scrollTop) => turnIds[Math.min(Math.floor((scrollTop - offset) / 1_000), turnIds.length - 1)],
      offsetOf: () => undefined,
      reveal: () => {},
    });
    let publications = 0;
    authority.subscribe(() => { publications += 1; });

    assert.equal(root.scrollTop, 2_400);
    assert.equal(authority.getSnapshot().readingTurnId, 'turn-3');

    root.input(-100);
    root.scrollTop = 1_200;
    root.emitScroll();
    assert.equal(authority.getSnapshot().readingTurnId, 'turn-2');
    assert.ok(publications > 0, 'a new reading position is published');

    const published = publications;
    root.scrollTop = 1_400;
    root.emitScroll();
    assert.equal(publications, published, 'the same Turn under the top edge says nothing new');

    // A Turn prepended above the reader, with the offset shifted to match.
    turnIds = ['turn-0', ...turnIds];
    root.grow(1_000);
    root.scrollTop = 2_400;
    root.emitScroll();
    assert.equal(authority.getSnapshot().readingTurnId, 'turn-2');
    offset = 500;
    resize();
    assert.equal(authority.getSnapshot().readingTurnId, 'turn-1');
  });
});

/** Turns 1,000px tall from the top of the content, which `fakeRoot` sizes to match. */
function turnList(root: FakeRoot, initial: string[]) {
  const list = {
    turnIds: initial,
    reveals: [] as Array<{ turnId: string; align: string; smooth: boolean }>,
    set(next: string[]) {
      root.scrollHeight = next.length * 1_000;
      list.turnIds = next;
    },
    layout: {
      turnAt: (scrollTop: number) =>
        list.turnIds[Math.min(Math.floor(scrollTop / 1_000), list.turnIds.length - 1)],
      offsetOf: (turnId: string) => {
        const index = list.turnIds.indexOf(turnId);
        return index === -1 ? undefined : index * 1_000;
      },
      reveal: (turnId: string, options: { align: string; smooth: boolean }) => {
        list.reveals.push({ turnId, ...options });
      },
    },
  };
  root.scrollHeight = initial.length * 1_000;
  return list;
}

function frames(frame: () => void, count = 30): void {
  for (let step = 0; step < count; step += 1) frame();
}

test('a change to the list other than growth at its tail keeps the reader on their Turn', () => {
  withObservers((_resize, frame) => {
    const root = fakeRoot();
    const list = turnList(root, ['b', 'c', 'd']);
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement, list.layout);
    root.input(-100);
    root.scrollTop = 1_250;
    root.emitScroll();
    assert.equal(authority.getSnapshot().readingTurnId, 'c');

    list.set(['a', 'b', 'c', 'd']);
    authority.turnsChanged('prepend');
    assert.equal(root.scrollTop, 2_250, 'the reader stays 250px into their Turn');
    assert.equal(authority.getSnapshot().positioning, true);
    root.scrollTop = 2_000;
    frame();
    assert.equal(root.scrollTop, 2_250, 'a settling row that moves the offset is written back');

    list.set(['a', 'c', 'd']);
    authority.turnsChanged('reset');
    assert.equal(root.scrollTop, 1_250);

    list.set(['a', 'c', 'd', 'e']);
    authority.turnsChanged('append');
    frames(frame);
    assert.equal(root.scrollTop, 1_250);
    assert.equal(authority.getSnapshot().positioning, false);
  });
});

test('reader input ends the positioning, and neither a pinned reader nor a removed Turn is positioned', () => {
  withObservers((_resize, frame) => {
    const root = fakeRoot();
    const list = turnList(root, ['b', 'c', 'd']);
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement, list.layout);
    assert.equal(authority.getSnapshot().pinned, true);
    list.set(['a', 'b', 'c', 'd']);
    authority.turnsChanged('prepend');
    assert.equal(authority.getSnapshot().positioning, false, 'the pin already decides where a pinned reader is');

    root.input(-100);
    root.scrollTop = 1_100;
    root.emitScroll();
    list.set(['z', 'a', 'b', 'c', 'd']);
    authority.turnsChanged('prepend');
    assert.equal(root.scrollTop, 2_100);
    root.input(-100);
    assert.equal(authority.getSnapshot().positioning, false);
    root.scrollTop = 500;
    frames(frame);
    assert.equal(root.scrollTop, 500, 'the reader took the offset back');

    root.emitScroll();
    list.set(['a', 'b']);
    authority.turnsChanged('reset');
    assert.equal(authority.getSnapshot().positioning, false, 'the reader\'s Turn is gone from the list');
  });
});

test('a navigation waits for its Turn, and a later command supersedes it before it settles', () => {
  withObservers((_resize, frame) => {
    const root = fakeRoot();
    const list = turnList(root, ['c', 'd']);
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement, list.layout);
    let settled: string[] = [];
    authority.navigate({ turnId: 'a', align: 'start', onSettled: () => { settled = [...settled, 'a']; } });
    assert.equal(authority.getSnapshot().pinned, false);
    assert.equal(authority.getSnapshot().positioning, true, 'a Turn not yet loaded is still a destination');

    list.set(['a', 'b', 'c', 'd']);
    authority.turnsChanged('prepend');
    assert.equal(root.scrollTop, 0);
    frames(frame);
    assert.deepEqual(settled, ['a']);
    assert.equal(authority.getSnapshot().positioning, false);

    authority.navigate({ turnId: 'c', align: 'center', smooth: true, onSettled: () => { settled = [...settled, 'c']; } });
    assert.deepEqual(list.reveals, [{ turnId: 'c', align: 'center', smooth: true }]);
    frame();
    authority.pinToTail();
    frames(frame);
    assert.deepEqual(settled, ['a'], 'returning to the tail cancels the reveal it interrupted');
    assert.equal(root.scrollTop, root.scrollHeight - root.clientHeight);
    assert.equal(list.reveals.length, 1);
  });
});

test('a navigation whose arrival settles without its Turn ends', () => {
  withObservers((_resize, frame) => {
    const root = fakeRoot();
    const list = turnList(root, ['c', 'd']);
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement, list.layout);
    let arrive!: () => void;
    const arrival: PromiseLike<void> = { then: (resolve) => { arrive = () => resolve?.(); return arrival as never; } };
    authority.navigate({ turnId: 'a', align: 'start', arrival });
    arrive();
    assert.equal(authority.getSnapshot().positioning, true, 'the list renders what arrived before this is decided');
    frame();
    assert.equal(authority.getSnapshot().positioning, false);

    list.set(['a', 'b', 'c', 'd']);
    authority.turnsChanged('prepend');
    frames(frame);
    assert.notEqual(root.scrollTop, 0, 'a Turn that arrives later does not pull the reader to it');
  });
});

test('a transcript without a Turn reader has no reading position', () => {
  withObservers(() => {
    const root = fakeRoot();
    const authority = createTranscriptScrollAuthority();
    authority.attach(root as unknown as HTMLElement);
    assert.equal(authority.getSnapshot().readingTurnId, undefined);
  });
});
