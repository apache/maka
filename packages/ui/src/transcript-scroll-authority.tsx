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
 *   !pinned → nothing here writes `scrollTop`, ever
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

/** Astryx's own thresholds, so the affordance keeps the feel readers learnt. */
const PIN_THRESHOLD_PX = 10;
const BUTTON_THRESHOLD_PX = 100;

export interface TranscriptScrollSnapshot {
  /** Following the tail: growth writes `scrollTop`. */
  readonly pinned: boolean;
  /** Far enough up that the return-to-tail affordance earns its place. */
  readonly awayFromTail: boolean;
}

export interface TranscriptScrollAuthority {
  /** Take the scroller. Returns the detach for the effect that called it. */
  attach(root: HTMLElement | null): () => void;
  /** One-shot: put the tail back under the reader and follow it again. */
  pinToTail(): void;
  /**
   * The reader chose a position, so stop following. A command that moves the
   * viewport itself calls this first; afterwards nothing here writes, which is
   * why a command cannot race the policy.
   */
  releasePin(): void;
  /**
   * Input can request history at an edge before any movement. Scroll reports
   * the resulting reading position. Neither phase is emitted for layout alone;
   * consumers do not interpret raw wheel or scroll events themselves.
   */
  subscribeToReaderScroll(listener: (direction: 'up' | 'down', phase: 'input' | 'scroll') => void): () => void;
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
  let snapshot: TranscriptScrollSnapshot = { pinned, awayFromTail };
  const listeners = new Set<() => void>();
  const readerListeners = new Set<(direction: 'up' | 'down', phase: 'input' | 'scroll') => void>();
  const distanceToTail = (): number =>
    root ? root.scrollHeight - root.scrollTop - root.clientHeight : 0;
  const publish = (): void => {
    if (root) root.style.overflowAnchor = pinned ? 'none' : 'auto';
    if (snapshot.pinned === pinned && snapshot.awayFromTail === awayFromTail) return;
    snapshot = { pinned, awayFromTail };
    for (const listener of listeners) listener();
  };
  const writeToTail = (): void => {
    if (!root) return;
    root.scrollTop = root.scrollHeight;
    awayFromTail = false;
    publish();
  };
  const reportReader = (direction: 'up' | 'down', phase: 'input' | 'scroll'): void => {
    for (const listener of [...readerListeners]) listener(direction, phase);
  };

  return {
    attach(next) {
      root = next;
      const target = root;
      if (!target) return () => undefined;
      const previousOverflowAnchor = target.style.overflowAnchor;
      publish();
      const begin = (event: Event, direction: 'up' | 'down'): void => {
        if (event.defaultPrevented || !reachesTranscript(event, target, direction)) return;
        const remaining = direction === 'up' ? target.scrollTop : distanceToTail();
        if (remaining <= 0) {
          // An edge gesture can ask for an adjacent history page even though
          // it produces no scroll (and therefore no scrollend).
          reportReader(direction, 'input');
          return;
        }
        gesture = { top: gesture?.top ?? target.scrollTop, direction };
        pinned = false;
        publish();
        reportReader(direction, 'input');
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
      let pointer: number | undefined;
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
        touchY = event.touches.length === 1 ? event.touches[0]!.clientY : undefined;
      };
      const onTouchMove = (event: TouchEvent): void => {
        const nextY = event.touches.length === 1 ? event.touches[0]!.clientY : undefined;
        if (touchY !== undefined && nextY !== undefined && touchY !== nextY) {
          begin(event, nextY < touchY ? 'down' : 'up');
        }
        touchY = nextY;
      };
      const onTouchEnd = (): void => { touchY = undefined; };
      const onScroll = (): void => {
        awayFromTail = distanceToTail() > BUTTON_THRESHOLD_PX;
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
            reportReader(direction, 'scroll');
            return;
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
          if (gesture !== ended || ended.top !== top) return;
          pinned = ended.direction === 'down' && distanceToTail() <= PIN_THRESHOLD_PX;
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
        else {
          awayFromTail = distanceToTail() > BUTTON_THRESHOLD_PX;
          publish();
        }
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
        if (root === target) root = null;
      };
    },
    pinToTail() {
      gesture = undefined;
      pinned = true;
      writeToTail();
      publish();
    },
    releasePin() {
      gesture = undefined;
      pinned = false;
      awayFromTail = distanceToTail() > BUTTON_THRESHOLD_PX;
      publish();
    },
    subscribeToReaderScroll(listener) {
      readerListeners.add(listener);
      return () => { readerListeners.delete(listener); };
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
