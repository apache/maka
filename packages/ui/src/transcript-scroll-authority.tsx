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
 * Owns automatic transcript following. Astryx auto-follow is disabled by the
 * host; explicit navigation releases this authority before moving the viewport.
 *
 *   pinned  → content that grows writes `scrollTop = scrollHeight`
 *   !pinned → only an explicit range publication restores its reading anchor
 *
 * While pinned, disable native anchoring so content cannot move the viewport
 * behind this authority's own write. Once released, restore native anchoring
 * to keep the reader on the same content without application writes.
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
import { flushSync } from 'react-dom';

/** Astryx's own thresholds, so the affordance keeps the feel readers learnt. */
const PIN_THRESHOLD_PX = 10;
const BUTTON_THRESHOLD_PX = 100;

export interface TranscriptScrollSnapshot {
  /** Following the tail: growth writes `scrollTop`. */
  readonly pinned: boolean;
  /** Far enough up that the return-to-tail affordance earns its place. */
  readonly awayFromTail: boolean;
  /**
   * The Turn the reader is on: the first whose box crosses the scrollport's
   * top edge. One reading line for every consumer — the bookmark that survives
   * a session switch and the rail's current tick have to name the same Turn.
   */
  readonly readingTurnId: string | undefined;
}

export interface TranscriptScrollAuthority {
  /** Whether native input still holds the published geometry. */
  isInputActive(): boolean;
  /** Synchronously publish and preserve geometry if native input permits it. */
  commitIfIdle(commit: () => void): boolean;
  subscribeToIdle(listener: () => void): () => void;
  /** Take the scroller. Returns the detach for the effect that called it. */
  attach(root: HTMLElement | null): () => void;
  /** One-shot: put the tail back under the reader and follow it again. */
  pinToTail(): void;
  /**
   * The reader chose a position, so stop following. A command that moves the
   * viewport itself calls this first; afterwards automatic following is off.
   */
  releasePin(): void;
  /**
   * Input can request history at an edge before any movement. Scroll reports
   * the resulting reading position; settled rechecks the final edge after a
   * gesture. No phase is emitted for layout alone;
   * consumers do not interpret raw wheel or scroll events themselves.
   * Returning true from input accepts history-reading intent, even at an
   * unmoving edge. The window owner knows whether adjacent history exists.
   */
  subscribeToReaderScroll(listener: (phase: 'input' | 'scroll' | 'settled', direction?: 'up' | 'down') => boolean | void): () => void;
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
  const idleListeners = new Set<() => void>();
  let pointer: number | undefined;
  let touchHeld = false;
  const isInputActive = (): boolean => gesture !== undefined || pointer !== undefined || touchHeld;
  const commitRange = (commit: () => void): void => {
    const target = root;
    if (!target) { commit(); return; }
    if (pinned) { flushSync(commit); writeToTail(); return; }
    const top = target.getBoundingClientRect().top;
    const anchor = [...target.querySelectorAll<HTMLElement>('[data-turn-id]')]
      .find((turn) => turn.getBoundingClientRect().bottom > top);
    if (!anchor) { flushSync(commit); return; }
    const before = anchor.getBoundingClientRect().top;
    // A gap notice is a poor native anchor: it survives a range replacement
    // while the paragraph beneath it moves. Restore a content Turn once, with
    // native compensation disabled for the same synchronous publication.
    target.style.overflowAnchor = 'none';
    try {
      flushSync(commit);
      const next = target.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(anchor.dataset.turnId!)}"]`);
      if (next) target.scrollTop += next.getBoundingClientRect().top - before;
    } finally {
      target.style.overflowAnchor = pinned ? 'none' : 'auto';
    }
  };
  const notifyIdle = (): void => {
    if (isInputActive()) return;
    for (const listener of [...idleListeners]) listener();
  };
  let readingTurnId: string | undefined;
  let snapshot: TranscriptScrollSnapshot = { pinned, awayFromTail, readingTurnId };
  const listeners = new Set<() => void>();
  const readerListeners = new Set<(phase: 'input' | 'scroll' | 'settled', direction?: 'up' | 'down') => boolean | void>();
  const distanceToTail = (): number =>
    root ? root.scrollHeight - root.scrollTop - root.clientHeight : 0;
  const readTurn = (): string | undefined => {
    if (!root) return undefined;
    const top = root.getBoundingClientRect().top;
    for (const turn of root.querySelectorAll<HTMLElement>('[data-turn-id]')) {
      if (turn.getBoundingClientRect().bottom > top) {
        return turn.getAttribute('data-turn-id') ?? undefined;
      }
    }
    return undefined;
  };
  const publish = (): void => {
    if (root) root.style.overflowAnchor = pinned ? 'none' : 'auto';
    if (snapshot.pinned === pinned && snapshot.awayFromTail === awayFromTail
      && snapshot.readingTurnId === readingTurnId) return;
    snapshot = { pinned, awayFromTail, readingTurnId };
    for (const listener of listeners) listener();
  };
  const writeToTail = (): void => {
    if (!root) return;
    root.scrollTop = root.scrollHeight;
    awayFromTail = false;
    publish();
  };
  const reportReader = (phase: 'input' | 'scroll' | 'settled', direction?: 'up' | 'down'): boolean => {
    let readingHistory = false;
    for (const listener of [...readerListeners]) {
      if (listener(phase, direction) === true) readingHistory = true;
    }
    return readingHistory;
  };

  return {
    isInputActive,
    commitIfIdle(commit) {
      if (isInputActive()) return false;
      commitRange(commit);
      return true;
    },
    subscribeToIdle(listener) {
      idleListeners.add(listener);
      return () => { idleListeners.delete(listener); };
    },
    attach(next) {
      root = next;
      const target = root;
      if (!target) return () => undefined;
      const previousOverflowAnchor = target.style.overflowAnchor;
      publish();
      const begin = (event: Event, direction: 'up' | 'down'): void => {
        if (event.defaultPrevented || !reachesTranscript(event, target, direction)) return;
        const remaining = direction === 'up' ? target.scrollTop : distanceToTail();
        gesture = { top: gesture?.top ?? target.scrollTop, direction };
        if (remaining <= 0) {
          // An edge gesture can ask for an adjacent history page even though
          // it produces no scroll (and therefore no scrollend).
          if (reportReader('input', direction)) {
            pinned = false;
            publish();
          }
          onScrollEnd();
          return;
        }
        pinned = false;
        publish();
        reportReader('input', direction);
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
        pointer = event.pointerId;
        gesture = { top: target.scrollTop };
      };
      const onPointerMove = (event: PointerEvent): void => {
        if (pointer === event.pointerId) gesture ??= { top: target.scrollTop };
      };
      const onPointerUp = (): void => {
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
          notifyIdle();
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
            if ((delta < 0 ? 'up' : 'down') !== direction) {
              publish();
              return;
            }
            gesture.direction = direction;
            pinned = false;
            publish();
            reportReader('scroll');
            return;
          }
        }
        publish();
      };
      const onScrollEnd = (): void => {
        // An explicit navigation may already have retired the gesture while
        // a pointer or touch was held. Release still has to wake publication.
        notifyIdle();
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
          notifyIdle();
          publish();
          if (pinned) writeToTail();
          // An anchor navigation can supersede the last in-flight page while
          // the gesture is held. Recheck its edge once after publication;
          // waiting for another movement would strand a reader at scrollTop 0.
          if (ended.direction) reportReader('settled');
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
        else awayFromTail = distanceToTail() > BUTTON_THRESHOLD_PX;
        // Turns mounting, unmounting and growing all reach this before they
        // reach any scroll event, so this is where the reading position moves
        // when the reader does not.
        readingTurnId = readTurn();
        publish();
      });
      const observeBox = (): void => {
        box.disconnect();
        box.observe(target);
        for (const child of target.children) box.observe(child);
      };
      const childList = new MutationObserver(() => {
        observeBox();
        readingTurnId = readTurn();
        publish();
      });
      childList.observe(target, { childList: true });
      observeBox();
      if (pinned) writeToTail();
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
        if (root === target) root = null;
      };
    },
    pinToTail() {
      gesture = undefined;
      pointer = undefined;
      touchHeld = false;
      pinned = true;
      queueMicrotask(notifyIdle);
      writeToTail();
      publish();
    },
    releasePin() {
      gesture = undefined;
      pinned = false;
      // Commands can originate in a React effect. Publish before their next
      // positioning frame, outside React's lifecycle, if a range is pending.
      queueMicrotask(notifyIdle);
      awayFromTail = distanceToTail() > BUTTON_THRESHOLD_PX;
      publish();
    },
    subscribeToReaderScroll(listener) {
      readerListeners.add(listener);
      return () => { readerListeners.delete(listener); };
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
export function TranscriptScrollButton({
  onActivate,
}: {
  onActivate?: () => Promise<void> | void;
}) {
  const authority = useTranscriptScrollAuthority();
  const snapshot = useSyncExternalStore(
    authority.subscribe,
    authority.getSnapshot,
    authority.getSnapshot,
  );
  return (
    <ChatLayoutScrollButton
      isVisible={snapshot.awayFromTail || onActivate !== undefined}
      onClick={() => {
        authority.pinToTail();
        const activation = onActivate?.();
        if (activation) void activation.catch(() => undefined);
      }}
    />
  );
}
