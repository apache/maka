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
 * size, so static server markup no longer contains them. This renders on a
 * LinkeDOM client whose ResizeObserver reports every box as `boxHeight` tall
 * inside a `viewportHeight` scroller. Scroll geometry is zero unless a test
 * defines `scrollHeight` and `clientHeight` on an element.
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

export interface TranscriptDom {
  document: Document;
  window: ReturnType<typeof parseHTML>['window'];
  container: HTMLElement;
  render(element: ReactElement): Promise<void>;
  cleanup(): Promise<void>;
}

export function installTranscriptDom(options: { viewportHeight?: number; boxHeight?: number } = {}): TranscriptDom {
  const viewportHeight = options.viewportHeight ?? 100_000;
  const boxHeight = options.boxHeight ?? 100;
  const originals = new Map<PropertyKey, PropertyDescriptor | undefined>(
    GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const scrollTops = new WeakMap<HTMLElement, number>();
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetParent: { configurable: true, get(this: HTMLElement) { return this.parentElement; } },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return scrollTops.get(this) ?? 0; },
      set(this: HTMLElement, value: number) {
        scrollTops.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)));
      },
    },
    // Content moves up by every ancestor's scroll offset, so a margin measured
    // from rects and scrollTop does not grow with scrolling.
    getBoundingClientRect: {
      configurable: true,
      value(this: HTMLElement) {
        let top = 0;
        for (let parent = this.parentElement; parent; parent = parent.parentElement) top -= parent.scrollTop;
        return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top };
      },
    },
    scrollHeight: { configurable: true, get: () => 0 },
    clientHeight: { configurable: true, get: () => 0 },
    // LinkeDOM has no scroll methods, and a scroller that silently ignores them
    // would make every programmatic scroll look like it landed.
    scroll: {
      configurable: true,
      value(this: HTMLElement, options?: ScrollToOptions) {
        if (options?.top !== undefined) this.scrollTop = options.top;
      },
    },
    scrollTo: {
      configurable: true,
      value(this: HTMLElement, options?: ScrollToOptions) {
        if (options?.top !== undefined) this.scrollTop = options.top;
      },
    },
    scrollBy: {
      configurable: true,
      value(this: HTMLElement, options?: ScrollToOptions) {
        if (options?.top !== undefined) this.scrollTop += options.top;
      },
    },
  });
  // LinkeDOM's compareDocumentPosition returns browser bitmasks without naming them.
  Object.assign(window.Node, {
    DOCUMENT_POSITION_DISCONNECTED: 1,
    DOCUMENT_POSITION_PRECEDING: 2,
    DOCUMENT_POSITION_FOLLOWING: 4,
    DOCUMENT_POSITION_CONTAINS: 8,
    DOCUMENT_POSITION_CONTAINED_BY: 16,
  });
  class MeasuringResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      queueMicrotask(() => {
        const height = target.hasAttribute('data-chat-scroll-container') ? viewportHeight : boxHeight;
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
  return {
    document,
    window,
    container,
    async render(element) {
      await act(async () => { root.render(element); });
      // Viewport measurement mounts the Turns; their own measurement settles them.
      await act(async () => {});
      await act(async () => {});
    },
    async cleanup() {
      await act(async () => { root.unmount(); });
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<PropertyKey, unknown>)[key];
      }
    },
  };
}

/** Client-rendered markup of `element`, with every Turn of a transcript mounted. */
export async function renderTranscriptMarkup(element: ReactElement): Promise<string> {
  const dom = installTranscriptDom();
  try {
    await dom.render(element);
    return dom.container.innerHTML;
  } finally {
    await dom.cleanup();
  }
}
