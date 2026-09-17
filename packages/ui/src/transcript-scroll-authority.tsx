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
 * Owns every intentional write to the transcript's `scrollTop`. Astryx
 * auto-follow is disabled by the host.
 *
 *   pinned      → content that grows writes `scrollTop = scrollHeight`
 *   positioning → one Turn is being put at one place in the scrollport: a
 *                 navigation to it, or keeping the reader's Turn where it was
 *                 while the list of Turns changes under it
 *   otherwise   → this authority writes nothing
 *
 * At most one of these holds. Every command and every reader input ends a
 * positioning.
 *
 * Native anchoring stays off: the transcript virtualizer keeps the reader on
 * the same content itself, and a second corrector would fight it.
 *
 * Input establishes reading intent; scroll and resize only report geometry.
 * Layout can shrink, clamp the offset, then grow before scroll is delivered.
 * Geometry alone therefore cannot establish that the reader chose to move.
 */

import {
  createContext,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ChatLayoutScrollButton } from '@astryxdesign/core/Chat';

/** Astryx's own thresholds, so the affordance keeps the feel readers learnt. */
const PIN_THRESHOLD_PX = 10;
const BUTTON_THRESHOLD_PX = 100;
/** How long a positioning keeps writing while the rows around its Turn measure. */
const SETTLE_FRAMES = 30;

/** How the virtualized list addresses Turns. */
export interface TranscriptLayout {
  /** The Turn under a scroll offset. */
  turnAt(scrollTop: number): string | undefined;
  /** Where a Turn's top sits in the scroller's content; `undefined` when it is not in the list. */
  offsetOf(turnId: string): number | undefined;
  /** An animated or centered reveal, which the virtualizer runs itself. */
  reveal(turnId: string, options: { align: 'start' | 'center'; smooth: boolean }): void;
}

/** How a list of Turns changed: where Turns were added, if anywhere but in place. */
export type TranscriptTurnListChange = 'same' | 'append' | 'prepend' | 'reset';

export interface TranscriptNavigation {
  readonly turnId: string;
  readonly align: 'start' | 'center';
  readonly smooth?: boolean;
  /**
   * What brings the Turn into the list. Once it settles and the list has
   * rendered, a Turn still absent is not coming, and the navigation ends.
   */
  readonly arrival?: PromiseLike<unknown>;
  /** The positioning finished without being superseded. */
  onSettled?(): void;
}

export interface TranscriptScrollSnapshot {
  /** Following the tail: growth writes `scrollTop`. */
  readonly pinned: boolean;
  /**
   * A Turn is being put somewhere, or waits to arrive so it can be. The reading
   * position says nothing about where the reader wants to be until it ends.
   */
  readonly positioning: boolean;
  /** Far enough up that the return-to-tail affordance earns its place. */
  readonly awayFromTail: boolean;
  /**
   * The Turn the reader is on: the one under the scrollport's top edge. One
   * reading line for every consumer — the bookmark that survives a session
   * switch and the rail's current tick have to name the same Turn.
   */
  readonly readingTurnId: string | undefined;
}

export interface TranscriptScrollAuthority {
  /** Take the scroller. Returns the detach for the effect that called it. */
  attach(root: HTMLElement | null, layout?: TranscriptLayout): () => void;
  /** One-shot: put the tail back under the reader and follow it again. */
  pinToTail(): void;
  /** The reader chose a position, so stop following and stop positioning. */
  releasePin(): void;
  /**
   * Take the reader to a Turn. One that is not in the list yet is taken to
   * when it arrives, unless another command or the reader moves first, or its
   * `arrival` settles without it.
   */
  navigate(target: TranscriptNavigation): void;
  /**
   * The list of Turns just changed. Anything but growth at the tail keeps the
   * reader on the Turn they were reading, at the same place in the scrollport.
   */
  turnsChanged(change: TranscriptTurnListChange): void;
  /**
   * The reading position, measured now and published like any other move. For
   * a caller that has just moved the viewport or the content itself and cannot
   * wait for the scroll or resize that will report it.
   */
  measureReadingTurn(): string | undefined;
  subscribe(listener: () => void): () => void;
  getSnapshot(): TranscriptScrollSnapshot;
}

/** Whether the browser can route vertical input through the nested scroll chain. */
function reachesTranscript(event: Event, root: HTMLElement, direction: 'up' | 'down'): boolean {
  for (const node of event.composedPath()) {
    if (node === root) return true;
    if (!(node instanceof HTMLElement)) continue;
    const style = getComputedStyle(node);
    if (!['auto', 'scroll', 'overlay'].includes(style.overflowY)) continue;
    const remaining = direction === 'up'
      ? node.scrollTop : node.scrollHeight - node.clientHeight - node.scrollTop;
    if (remaining > 0 || ['contain', 'none'].includes(style.overscrollBehaviorY)) return false;
  }
  return false;
}

export function createTranscriptScrollAuthority(): TranscriptScrollAuthority {
  let root: HTMLElement | null = null;
  let pinned = true;
  let awayFromTail = false;
  // Geometry belongs to a known input operation, never the other way around.
  // scrollend also covers smooth keyboard scrolling and touchpad inertia.
  let gesture: { top: number; direction?: 'up' | 'down' } | undefined;
  let pointer: number | undefined;
  let touchHeld = false;
  let layout: TranscriptLayout | undefined;
  let readingTurnId: string | undefined;
  /** Where the reading Turn's top sits relative to the scrollport's top. */
  let readingGap = 0;
  let positioning: {
    readonly turnId: string;
    /** Writes the Turn this far below the scrollport's top; a reveal otherwise. */
    readonly gap?: number;
    readonly navigation?: TranscriptNavigation;
    revealed: boolean;
    framesLeft: number;
    frame?: number;
  } | undefined;
  let snapshot: TranscriptScrollSnapshot = { pinned, positioning: false, awayFromTail, readingTurnId };
  const listeners = new Set<() => void>();
  const distanceToTail = (): number =>
    root ? root.scrollHeight - root.scrollTop - root.clientHeight : 0;
  const readTurn = (): string | undefined => {
    if (!root || !layout) return undefined;
    const turnId = layout.turnAt(root.scrollTop);
    const offset = turnId === undefined ? undefined : layout.offsetOf(turnId);
    if (offset !== undefined) readingGap = offset - root.scrollTop;
    return turnId;
  };
  const publish = (): void => {
    const next = positioning !== undefined;
    if (snapshot.pinned === pinned && snapshot.positioning === next
      && snapshot.awayFromTail === awayFromTail && snapshot.readingTurnId === readingTurnId) return;
    snapshot = { pinned, positioning: next, awayFromTail, readingTurnId };
    for (const listener of listeners) listener();
  };
  const endPositioning = (): void => {
    if (!positioning) return;
    if (positioning.frame !== undefined) cancelAnimationFrame(positioning.frame);
    positioning = undefined;
  };
  const writeToTail = (): void => {
    if (!root) return;
    root.scrollTop = root.scrollHeight;
    awayFromTail = false;
    publish();
  };
  /** Puts the Turn in place once; `false` while it is not in the list. */
  const place = (): boolean => {
    const current = positioning;
    if (!current || !root || !layout) return false;
    const offset = layout.offsetOf(current.turnId);
    if (offset === undefined) return false;
    if (current.gap !== undefined) {
      const top = offset - current.gap;
      if (Math.abs(root.scrollTop - top) >= 0.5) root.scrollTop = top;
    } else if (!current.revealed) {
      layout.reveal(current.turnId, {
        align: current.navigation?.align ?? 'start',
        smooth: current.navigation?.smooth ?? false,
      });
    }
    current.revealed = true;
    return true;
  };
  // Rows around the Turn mount and measure over the frames after it is placed,
  // and each measurement moves its offset, so placing repeats until they settle.
  const settle = (): void => {
    const current = positioning;
    if (!place() || !current || current.frame !== undefined) return;
    const step = (): void => {
      current.frame = undefined;
      if (positioning !== current) return;
      place();
      if (--current.framesLeft > 0) {
        current.frame = requestAnimationFrame(step);
        return;
      }
      positioning = undefined;
      readingTurnId = readTurn();
      publish();
      current.navigation?.onSettled?.();
    };
    current.frame = requestAnimationFrame(step);
  };
  return {
    attach(next, nextLayout) {
      root = next;
      const target = root;
      if (!target) return () => undefined;
      layout = nextLayout;
      const previousOverflowAnchor = target.style.overflowAnchor;
      target.style.overflowAnchor = 'none';
      const begin = (event: Event, direction: 'up' | 'down'): void => {
        if (event.defaultPrevented || !reachesTranscript(event, target, direction)) return;
        endPositioning();
        const remaining = direction === 'up' ? target.scrollTop : distanceToTail();
        gesture = { top: gesture?.top ?? target.scrollTop, direction };
        // An edge gesture produces no scroll and therefore no scrollend. A
        // passive wheel can arrive after the threaded scroll it caused, already
        // at the top edge; that input did move the reader.
        if (remaining <= 0) {
          if (direction === 'up' && distanceToTail() > PIN_THRESHOLD_PX) pinned = false;
          onScrollEnd();
          return;
        }
        pinned = false;
        publish();
      };
      const onWheel = (event: WheelEvent): void => {
        if (event.ctrlKey || event.metaKey || event.deltaY === 0) return;
        begin(event, event.deltaY < 0 ? 'up' : 'down');
      };
      const onKeyDown = (event: KeyboardEvent): void => {
        const element = event.target;
        if (!(element instanceof HTMLElement) || element.isContentEditable
          || element.closest('input, textarea, select') || event.altKey || event.metaKey) return;
        if (event.key === ' ' && element.closest('button, summary, [role="button"]')) return;
        if (event.ctrlKey && !['Home', 'End'].includes(event.key)) return;
        const direction = ['ArrowUp', 'PageUp', 'Home'].includes(event.key)
          || (event.key === ' ' && event.shiftKey) ? 'up'
          : ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key) ? 'down' : undefined;
        if (direction) begin(event, direction);
      };
      const onPointerDown = (event: PointerEvent): void => {
        if (event.defaultPrevented || event.button !== 0 || event.pointerType === 'touch'
          || event.target !== target) return;
        endPositioning();
        publish();
        pointer = event.pointerId;
        gesture = { top: target.scrollTop };
      };
      const onPointerMove = (event: PointerEvent): void => {
        if (pointer === event.pointerId) gesture ??= { top: target.scrollTop };
      };
      const onPointerUp = (): void => {
        if (pointer === undefined) return;
        pointer = undefined;
        onScrollEnd();
        const pending = gesture;
        if (!pending || pending.direction !== undefined) return;
        // Native track clicks can start their smooth scroll after pointerup.
        // Scroll steps precede rAF; retire a click that still has not moved
        // there, rather than leaving a non-scrolling click armed indefinitely.
        requestAnimationFrame(() => {
          if (gesture !== pending || pending.direction !== undefined) return;
          gesture = undefined;
          if (pinned) writeToTail();
        });
      };
      let touchY: number | undefined;
      const onTouchStart = (event: TouchEvent): void => {
        touchHeld = true;
        touchY = event.touches.length === 1 ? event.touches[0]!.clientY : undefined;
      };
      const onTouchMove = (event: TouchEvent): void => {
        const nextY = event.touches.length === 1 ? event.touches[0]!.clientY : undefined;
        if (touchY !== undefined && nextY !== undefined && touchY !== nextY) {
          begin(event, nextY < touchY ? 'down' : 'up');
        }
        touchY = nextY;
      };
      const onTouchEnd = (event: TouchEvent): void => {
        touchY = undefined;
        if (event.touches.length > 0) return;
        touchHeld = false;
        onScrollEnd();
      };
      const onScroll = (): void => {
        awayFromTail = distanceToTail() > BUTTON_THRESHOLD_PX;
        readingTurnId = readTurn();
        if (gesture) {
          const delta = target.scrollTop - gesture.top;
          gesture.top = target.scrollTop;
          if (delta !== 0) {
            const direction = pointer !== undefined
              ? (delta < 0 ? 'up' : 'down')
              : gesture.direction ?? (delta < 0 ? 'up' : 'down');
            // A reversed input may arrive while the previous smooth scroll
            // still moves in the opposite direction. Its end is not the end
            // of the new input's default action.
            if ((delta < 0 ? 'up' : 'down') === direction) {
              gesture.direction = direction;
              pinned = false;
            }
          }
        }
        publish();
      };
      const onScrollEnd = (): void => {
        const ended = gesture;
        if (!ended) return;
        const top = ended.top;
        // Chromium can end a scrollbar animation while a subsequent keyboard
        // animation is still moving the same scroller. Let the next rendering
        // step report any continuation before retiring its input provenance.
        // This schedules no scroll and uses no time-based ignore window.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (gesture !== ended || ended.top !== top || pointer !== undefined || touchHeld) return;
          // Input that can scroll and observed reader movement already release
          // the pin. Settling an unmoved edge gesture must not release it too.
          pinned = pinned || (ended.direction === 'down' && distanceToTail() <= PIN_THRESHOLD_PX);
          gesture = undefined;
          publish();
          if (pinned) writeToTail();
        }));
      };
      target.addEventListener('wheel', onWheel, { passive: true });
      // React's delegated widget handlers run above the scroller. Observe
      // keyboard input after they can prevent its native scrolling default.
      target.ownerDocument.addEventListener('keydown', onKeyDown);
      target.addEventListener('pointerdown', onPointerDown);
      target.addEventListener('pointermove', onPointerMove, { passive: true });
      target.addEventListener('touchstart', onTouchStart, { passive: true });
      target.addEventListener('touchmove', onTouchMove, { passive: true });
      target.addEventListener('touchend', onTouchEnd);
      target.addEventListener('touchcancel', onTouchEnd);
      target.ownerDocument.addEventListener('pointerup', onPointerUp);
      target.ownerDocument.addEventListener('pointercancel', onPointerUp);
      target.addEventListener('scroll', onScroll, { passive: true });
      target.addEventListener('scrollend', onScrollEnd);

      // Observe the viewport and its direct content boxes, including content
      // outside Turns. Resize changes position only; it never changes intent.
      const box = new ResizeObserver(() => {
        if (pinned && !gesture) writeToTail();
        else if (positioning) place();
        awayFromTail = distanceToTail() > BUTTON_THRESHOLD_PX;
        readingTurnId = readTurn();
        publish();
      });
      const observeBox = (): void => {
        box.disconnect();
        box.observe(target);
        for (const child of target.children) box.observe(child);
      };
      const childList = new MutationObserver(observeBox);
      childList.observe(target, { childList: true });
      observeBox();
      if (pinned) writeToTail();
      else settle();
      readingTurnId = readTurn();
      publish();
      return () => {
        childList.disconnect();
        box.disconnect();
        target.removeEventListener('wheel', onWheel);
        target.ownerDocument.removeEventListener('keydown', onKeyDown);
        target.removeEventListener('pointerdown', onPointerDown);
        target.removeEventListener('pointermove', onPointerMove);
        target.removeEventListener('touchstart', onTouchStart);
        target.removeEventListener('touchmove', onTouchMove);
        target.removeEventListener('touchend', onTouchEnd);
        target.removeEventListener('touchcancel', onTouchEnd);
        target.ownerDocument.removeEventListener('pointerup', onPointerUp);
        target.ownerDocument.removeEventListener('pointercancel', onPointerUp);
        target.removeEventListener('scroll', onScroll);
        target.removeEventListener('scrollend', onScrollEnd);
        target.style.overflowAnchor = previousOverflowAnchor;
        gesture = undefined;
        pointer = undefined;
        touchHeld = false;
        if (root === target) {
          endPositioning();
          root = null;
          layout = undefined;
        }
      };
    },
    pinToTail() {
      endPositioning();
      gesture = undefined;
      pointer = undefined;
      touchHeld = false;
      pinned = true;
      writeToTail();
      publish();
    },
    releasePin() {
      endPositioning();
      gesture = undefined;
      pinned = false;
      awayFromTail = distanceToTail() > BUTTON_THRESHOLD_PX;
      publish();
    },
    navigate(navigation) {
      endPositioning();
      gesture = undefined;
      pinned = false;
      positioning = {
        turnId: navigation.turnId,
        gap: navigation.align === 'start' && !navigation.smooth ? 0 : undefined,
        navigation,
        revealed: false,
        framesLeft: SETTLE_FRAMES,
      };
      publish();
      settle();
      const settled = () => requestAnimationFrame(() => {
        if (positioning?.navigation !== navigation) return;
        if (layout?.offsetOf(navigation.turnId) !== undefined) {
          settle();
          return;
        }
        endPositioning();
        readingTurnId = readTurn();
        publish();
      });
      navigation.arrival?.then(settled, settled);
    },
    turnsChanged(change) {
      if (change === 'same' || change === 'append') {
        settle();
        return;
      }
      if (positioning) positioning.framesLeft = SETTLE_FRAMES;
      else if (!pinned && readingTurnId !== undefined) {
        positioning = { turnId: readingTurnId, gap: readingGap, revealed: false, framesLeft: SETTLE_FRAMES };
        // The reader's Turn left the list, so there is nowhere to keep them.
        if (layout?.offsetOf(readingTurnId) === undefined) positioning = undefined;
      }
      publish();
      settle();
    },
    measureReadingTurn() {
      readingTurnId = readTurn();
      publish();
      return readingTurnId;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot() {
      return snapshot;
    },
  };
}

const TranscriptScrollContext = createContext<TranscriptScrollAuthority | null>(null);

/**
 * Deliberately holds no React state: the pin crosses its thresholds on
 * scroll, and a provider that re-rendered on each crossing would re-render the
 * whole transcript under it. The button subscribes instead.
 */
export function TranscriptScrollAuthorityProvider({ children }: { children: ReactNode }) {
  const authority = useRef<TranscriptScrollAuthority | undefined>(undefined);
  authority.current ??= createTranscriptScrollAuthority();
  return (
    <TranscriptScrollContext value={authority.current}>{children}</TranscriptScrollContext>
  );
}

/**
 * Every `ChatSurfaceLayout` provides one, so a missing authority is a tree that
 * was assembled wrong rather than a state to degrade into — the same contract
 * `ChatView` already states about its layout.
 */
export function useTranscriptScrollAuthority(): TranscriptScrollAuthority {
  const authority = useContext(TranscriptScrollContext);
  if (!authority) {
    throw new Error('useTranscriptScrollAuthority must be used inside ChatSurfaceLayout');
  }
  return authority;
}

/**
 * The dock's scroll-to-bottom affordance, driven by Maka's pin rather than
 * Astryx's — with auto-scroll off, `isScrolledUp` never updates again, so the
 * stock button would be permanently invisible.
 *
 * The label stays unset on purpose: `ChatSurfaceLayout` overrides Astryx's
 * `scrollToBottom` string through the locale provider that wraps this.
 */
export function TranscriptScrollButton() {
  const authority = useTranscriptScrollAuthority();
  const snapshot = useSyncExternalStore(
    authority.subscribe,
    authority.getSnapshot,
    authority.getSnapshot,
  );
  return (
    <ChatLayoutScrollButton
      isVisible={snapshot.awayFromTail}
      onClick={authority.pinToTail}
    />
  );
}
