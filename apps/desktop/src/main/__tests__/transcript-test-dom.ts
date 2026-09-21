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
 * The virtualized transcript mounts Turns only after its scroller reports a
 * size, so static server markup contains none. This client-renders on LinkeDOM
 * with a ResizeObserver that gives the scroller a tall viewport, so every Turn
 * mounts. Globals and the shared LinkeDOM prototype are restored afterwards.
 */

import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

const GLOBAL_KEYS = [
  'CSS',
  'Element',
  'HTMLElement',
  'IS_REACT_ACT_ENVIRONMENT',
  'IntersectionObserver',
  'MutationObserver',
  'Node',
  'ResizeObserver',
  'cancelAnimationFrame',
  'document',
  'getComputedStyle',
  'matchMedia',
  'requestAnimationFrame',
  'window',
] as const;

const GEOMETRY_KEYS = ['offsetParent', 'scrollTop', 'scrollHeight', 'clientHeight'] as const;

/** Client-rendered markup of `element`, with every Turn of a transcript mounted. */
export async function renderTranscriptMarkup(element: ReactElement): Promise<string> {
  const originals = new Map<PropertyKey, PropertyDescriptor | undefined>(
    GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const prototype = window.HTMLElement.prototype;
  const prototypeOriginals = new Map<PropertyKey, PropertyDescriptor | undefined>(
    GEOMETRY_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(prototype, key)]),
  );
  const scrollTops = new WeakMap<HTMLElement, number>();
  Object.defineProperties(prototype, {
    offsetParent: { configurable: true, get(this: HTMLElement) { return this.parentElement; } },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return scrollTops.get(this) ?? 0; },
      set(this: HTMLElement, value: number) { scrollTops.set(this, Math.max(0, value)); },
    },
    scrollHeight: { configurable: true, get: () => 0 },
    clientHeight: { configurable: true, get: () => 0 },
  });
  class MeasuringResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      queueMicrotask(() => {
        const height = target.hasAttribute('data-chat-scroll-container') ? 100_000 : 100;
        this.callback(
          [{ target, contentRect: { height, width: 800 } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      });
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  class InertObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  }
  Object.assign(window, { ResizeObserver: MeasuringResizeObserver });
  Object.assign(globalThis, {
    CSS: { escape: String, supports: () => false },
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    IntersectionObserver: InertObserver,
    MutationObserver: InertObserver,
    Node: window.Node,
    ResizeObserver: MeasuringResizeObserver,
    cancelAnimationFrame: () => undefined,
    document,
    getComputedStyle: () => ({ overflowY: 'visible' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 0,
    window,
  });
  const container = document.querySelector<HTMLElement>('#root')!;
  const root = createRoot(container);
  try {
    await act(async () => { root.render(element); });
    // Viewport measurement mounts the Turns; their own measurement settles them.
    await act(async () => {});
    await act(async () => {});
    return container.innerHTML;
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of prototypeOriginals) {
      if (descriptor) Object.defineProperty(prototype, key, descriptor);
      else delete (prototype as unknown as Record<PropertyKey, unknown>)[key];
    }
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<PropertyKey, unknown>)[key];
    }
  }
}
