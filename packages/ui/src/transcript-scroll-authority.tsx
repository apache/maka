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
 * The one thing that answers "where should the transcript be looking".
 *
 * Three writers used to move `scrollTop` — Astryx's lock/spring, Maka's
 * compensation and `scrollIntoView`, and the browser's own anchoring — and none
 * of them held the answer, so they avoided each other through flags and effect
 * ordering. This file is the answer, and it is one boolean:
 *
 *   pinned  → content that grows writes `scrollTop = scrollHeight`
 *   !pinned → nothing here writes `scrollTop`, ever
 *
 * "Keep the reader where they were reading" is the definition of
 * `overflow-anchor: auto`, which is already the initial value and costs nothing,
 * and "the reader is dragging" is also just don't touch it — so both of those
 * are the same instruction to this code: stay out of the way.
 *
 * Being the only writer is what makes the state exact rather than guessed. It
 * remembers the offset it wrote, so a scroll event that finds the scroller
 * still on that offset is its own echo and any other offset is the reader — by
 * construction, and with no dependence on when the event arrives. Astryx had to
 * infer that from scroll direction, height deltas and wheel events, and every
 * one of those signals has more than one cause.
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
  /**
   * The transcript's box changed. The only moment `pinned` writes `scrollTop`,
   * and the only growth signal — there is no second observer.
   */
  notifyContentResize(): void;
  /** One-shot: put the tail back under the reader and follow it again. */
  pinToTail(): void;
  /**
   * The reader chose a position, so stop following. A command that moves the
   * viewport itself calls this first; afterwards nothing here writes, which is
   * why a command cannot race the policy.
   */
  releasePin(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): TranscriptScrollSnapshot;
}

export function createTranscriptScrollAuthority(): TranscriptScrollAuthority {
  let root: HTMLElement | null = null;
  let pinned = true;
  let awayFromTail = false;
  /**
   * The offset this authority last wrote, as the browser clamped it.
   *
   * A scroll event arrives asynchronously, and on a loaded machine that can be
   * more than a frame after the write that caused it. Timing cannot tell the
   * two apart — the position can: our own write is still sitting in `scrollTop`
   * when its event lands, and a reader's gesture has already moved it somewhere
   * else.
   */
  let lastWrittenTop: number | undefined;
  let snapshot: TranscriptScrollSnapshot = { pinned, awayFromTail };
  const listeners = new Set<() => void>();

  const publish = (): void => {
    if (snapshot.pinned === pinned && snapshot.awayFromTail === awayFromTail) return;
    snapshot = { pinned, awayFromTail };
    for (const listener of listeners) listener();
  };

  const distanceToTail = (): number =>
    root ? root.scrollHeight - root.scrollTop - root.clientHeight : 0;

  const writeToTail = (): void => {
    if (!root) return;
    root.scrollTop = root.scrollHeight;
    // Read it back: the browser clamps the write to the end of the scroller,
    // and the clamped value is what the event will carry.
    lastWrittenTop = root.scrollTop;
    awayFromTail = false;
    publish();
  };

  return {
    attach(next) {
      root = next;
      const target = root;
      if (!target) return () => undefined;
      const onScroll = (): void => {
        // An event that finds the scroller still on the offset this authority
        // put it on is the echo of that write, however late it arrives; any
        // other offset is the reader, exactly, and not by inference. Nested
        // scrollers (a tool output box, a terminal) never reach here at all:
        // `scroll` does not bubble, and there is no `wheel` listener to catch
        // instead.
        if (lastWrittenTop !== undefined && Math.abs(target.scrollTop - lastWrittenTop) < 1) {
          return;
        }
        const distance = distanceToTail();
        pinned = distance <= PIN_THRESHOLD_PX;
        awayFromTail = distance > BUTTON_THRESHOLD_PX;
        publish();
      };
      target.addEventListener('scroll', onScroll, { passive: true });
      // The tail moves when the viewport shrinks, not only when the content
      // grows: a window resize, a composer that gains a line, a dock that
      // changes height. None of those touch the transcript, so the content
      // signal never fires for them, and a pinned reader would be left however
      // many pixels the viewport lost away from the bottom.
      const viewport = new ResizeObserver(() => {
        if (pinned) writeToTail();
      });
      viewport.observe(target);
      if (pinned) writeToTail();
      return () => {
        viewport.disconnect();
        target.removeEventListener('scroll', onScroll);
        lastWrittenTop = undefined;
        if (root === target) root = null;
      };
    },
    notifyContentResize() {
      if (!root) return;
      if (pinned) {
        writeToTail();
        return;
      }
      awayFromTail = distanceToTail() > BUTTON_THRESHOLD_PX;
      publish();
    },
    pinToTail() {
      pinned = true;
      writeToTail();
      publish();
    },
    releasePin() {
      pinned = false;
      awayFromTail = distanceToTail() > BUTTON_THRESHOLD_PX;
      publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
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
      onClick={() => authority.pinToTail()}
    />
  );
}
