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
 * Instant bottom pin for a transcript that is still arriving.
 *
 * Astryx's `useChatStreamScroll` positions the FIRST fill of its scroller
 * instantly and springs every later growth. That one-shot lives on the hook
 * instance, and `ChatSurfaceLayout` mounts once for the whole app shell, so it
 * is spent on the session that happened to be open at boot. Every switch after
 * that is "later growth". A switched-to transcript still arrives across the
 * virtual tail's first render and measured-height corrections, so a one-shot
 * scroll would let the spring chase a moving bottom.
 *
 * A session change is navigation, not content growth: the transcript is meant
 * to be at its latest turn the first time it is painted, exactly as it is on a
 * cold start. This pin owns that arrival window only. It writes `scrollTop`
 * from a ResizeObserver — after layout, before paint — so the growth the spring
 * would have animated is already consumed by the time a frame is painted, and
 * the spring settles against a zero delta instead of running. Steady-state
 * following (streaming tokens, appended turns) stays Astryx's, which is why the
 * caller releases this at the end of the arrival window rather than keeping it.
 *
 * Any sign the reader took control releases the pin for good, using the same
 * signals Astryx unlocks on: an upward wheel or a touch drag over the
 * transcript, or a scroll that moved up on its own — one where the geometry did
 * NOT change in the same event, since Chromium fires a synthetic scroll for
 * every content resize and the arrival window is nothing but resizes.
 */

export interface ArrivalPinViewport {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  addEventListener(type: string, listener: (event: Event) => void, options?: { passive?: boolean }): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface ArrivalPinSizeObserver {
  observe(element: Element): void;
  disconnect(): void;
}

export type ArrivalPinSizeObserverFactory = (callback: () => void) => ArrivalPinSizeObserver;

export interface ArrivalPinGeometry {
  readonly scrollTop: number;
  readonly lastScrollTop: number;
  readonly scrollHeight: number;
  readonly lastScrollHeight: number;
  readonly clientHeight: number;
  readonly lastClientHeight: number;
}

/**
 * Whether a scroll event is the reader moving up rather than the document
 * growing under them.
 *
 * The 1px tolerance is for Chromium's fractional `scrollTop`: pinning writes
 * `scrollHeight`, which clamps to a maximum that can carry a sub-pixel
 * fraction, and reading it back a frame later can land just under the value the
 * pin recorded.
 */
export function releasesArrivalPin(geometry: ArrivalPinGeometry): boolean {
  if (
    geometry.scrollHeight !== geometry.lastScrollHeight ||
    geometry.clientHeight !== geometry.lastClientHeight
  ) {
    return false;
  }
  return geometry.scrollTop < geometry.lastScrollTop - 1;
}

export interface ArrivalBottomPin {
  /** Stop following; the viewport is left wherever it currently sits. */
  release(): void;
  /** Release and detach every observer and listener. */
  dispose(): void;
  /** False once the reader took control or the caller released the pin. */
  isPinned(): boolean;
}

export function createArrivalBottomPin(options: {
  viewport: ArrivalPinViewport;
  /**
   * The element whose height the transcript grows with. The scroller's own box
   * never changes size while its content does, so observing the viewport would
   * report nothing.
   */
  content: Element | null;
  /** Published by the caller as a DOM marker; see use-chat-scroll. */
  onStateChange?: (state: 'pinned' | 'released') => void;
  createSizeObserver?: ArrivalPinSizeObserverFactory;
}): ArrivalBottomPin {
  const viewport = options.viewport;
  const content = options.content;
  let pinned = true;
  let lastScrollTop = viewport.scrollTop;
  let lastScrollHeight = viewport.scrollHeight;
  let lastClientHeight = viewport.clientHeight;

  const pin = (): void => {
    if (!pinned) return;
    viewport.scrollTop = viewport.scrollHeight;
    lastScrollTop = viewport.scrollTop;
    lastScrollHeight = viewport.scrollHeight;
    lastClientHeight = viewport.clientHeight;
  };

  const release = (): void => {
    if (!pinned) return;
    pinned = false;
    options.onStateChange?.('released');
  };

  const onScroll = (): void => {
    if (!pinned) return;
    if (
      releasesArrivalPin({
        scrollTop: viewport.scrollTop,
        lastScrollTop,
        scrollHeight: viewport.scrollHeight,
        lastScrollHeight,
        clientHeight: viewport.clientHeight,
        lastClientHeight,
      })
    ) {
      release();
      return;
    }
    lastScrollTop = viewport.scrollTop;
    lastScrollHeight = viewport.scrollHeight;
    lastClientHeight = viewport.clientHeight;
  };

  // Wheel and touch are read before the scroll they cause, which is what makes
  // them worth listening to on top of `onScroll`: they release the pin in the
  // same frame the reader acts, rather than one growth later — a growth landing
  // between the gesture and its scroll event would otherwise re-pin under them.
  //
  // Scoped to gestures over the transcript. The dock — composer, plan panel,
  // graph status — sits inside this scroller, so its wheels and touches bubble
  // here too, and neither is evidence that the reader left the latest turn.
  // Nothing is lost by being strict: a gesture that really moves the scroller
  // still reaches `onScroll`, which decides on what the geometry did rather
  // than on where the pointer was.
  const overTranscript = (event: Event): boolean => {
    const target = event.target;
    if (!content || typeof content.contains !== 'function' || !target) return true;
    return content.contains(target as Node);
  };
  const onWheel = (event: Event): void => {
    if ((event as WheelEvent).deltaY < 0 && overTranscript(event)) release();
  };
  const onTouchMove = (event: Event): void => {
    if (overTranscript(event)) release();
  };

  viewport.addEventListener('scroll', onScroll, { passive: true });
  viewport.addEventListener('wheel', onWheel, { passive: true });
  viewport.addEventListener('touchmove', onTouchMove, { passive: true });

  const createSizeObserver = options.createSizeObserver
    ?? (typeof ResizeObserver === 'function'
      ? (callback: () => void) => new ResizeObserver(callback)
      : undefined);
  const sizeObserver = content ? createSizeObserver?.(pin) : undefined;
  if (content) sizeObserver?.observe(content);

  options.onStateChange?.('pinned');
  pin();

  return {
    release,
    isPinned: () => pinned,
    dispose: () => {
      release();
      sizeObserver?.disconnect();
      viewport.removeEventListener('scroll', onScroll);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('touchmove', onTouchMove);
    },
  };
}
