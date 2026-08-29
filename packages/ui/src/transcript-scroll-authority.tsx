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
 * Being the only writer is what makes the state exact rather than guessed. A
 * write flags itself, so an unflagged scroll event is the reader by
 * construction. Astryx had to infer that from scroll direction, height deltas
 * and wheel events, and every one of those signals has more than one cause.
 */

import {
  createContext,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ChatLayoutScrollButton } from '@astryxdesign/core/Chat';
import { restoreChatScrollAnchor, type ChatScrollAnchor } from './chat-scroll-anchor.js';

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
   * Keep `anchor` at the viewport offset it had, through whatever arrives
   * next. `overflow-anchor: auto` already does this continuously and for free,
   * with one exception — the browser declines to anchor while the scroller sits
   * at zero, which is precisely where loading earlier history puts the reader.
   *
   * The hold lasts until the reader scrolls, which is the moment it stops being
   * true that they want to stay put. It runs on the same growth signal the pin
   * does, so the correction lands in the frame the content arrived rather than
   * after the virtual window has already been recomputed around the old
   * position.
   */
  holdAnchor(anchor: ChatScrollAnchor | undefined): void;
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
  let writing = false;
  let writingFrame = 0;
  let anchor: ChatScrollAnchor | undefined;
  let snapshot: TranscriptScrollSnapshot = { pinned, awayFromTail };
  const listeners = new Set<() => void>();

  const publish = (): void => {
    if (snapshot.pinned === pinned && snapshot.awayFromTail === awayFromTail) return;
    snapshot = { pinned, awayFromTail };
    for (const listener of listeners) listener();
  };

  const distanceToTail = (): number =>
    root ? root.scrollHeight - root.scrollTop - root.clientHeight : 0;

  const markWriting = (): void => {
    writing = true;
    if (writingFrame !== 0) window.cancelAnimationFrame(writingFrame);
    // A scroll event is dispatched asynchronously, so clearing this on the
    // current turn would let our own write read as a gesture; clearing it any
    // later than the next frame would swallow the reader's next one.
    writingFrame = window.requestAnimationFrame(() => {
      writingFrame = 0;
      writing = false;
    });
  };

  const writeToTail = (): void => {
    if (!root) return;
    markWriting();
    root.scrollTop = root.scrollHeight;
    awayFromTail = false;
    publish();
  };

  return {
    attach(next) {
      root = next;
      const target = root;
      if (!target) return () => undefined;
      const onScroll = (): void => {
        // Everything this authority writes flags itself, so an unflagged event
        // is the reader — exactly, not by inference. Nested scrollers (a tool
        // output box, a terminal) never reach here at all: `scroll` does not
        // bubble, and there is no `wheel` listener to catch instead.
        if (writing) return;
        // The reader moved, so they are no longer asking to stay put.
        anchor = undefined;
        const distance = distanceToTail();
        pinned = distance <= PIN_THRESHOLD_PX;
        awayFromTail = distance > BUTTON_THRESHOLD_PX;
        publish();
      };
      target.addEventListener('scroll', onScroll, { passive: true });
      if (pinned) writeToTail();
      return () => {
        target.removeEventListener('scroll', onScroll);
        anchor = undefined;
        if (writingFrame !== 0) {
          window.cancelAnimationFrame(writingFrame);
          writingFrame = 0;
          writing = false;
        }
        if (root === target) root = null;
      };
    },
    notifyContentResize() {
      if (!root) return;
      if (pinned) {
        writeToTail();
        return;
      }
      if (anchor) {
        markWriting();
        restoreChatScrollAnchor(root, anchor);
      }
      awayFromTail = distanceToTail() > BUTTON_THRESHOLD_PX;
      publish();
    },
    pinToTail() {
      pinned = true;
      anchor = undefined;
      writeToTail();
      publish();
    },
    holdAnchor(next) {
      anchor = next;
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

export function useTranscriptScrollAuthority(): TranscriptScrollAuthority | null {
  return useContext(TranscriptScrollContext);
}

const DETACHED_SNAPSHOT: TranscriptScrollSnapshot = { pinned: true, awayFromTail: false };

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
    authority?.subscribe ?? noopSubscribe,
    authority?.getSnapshot ?? detachedSnapshot,
    detachedSnapshot,
  );
  return (
    <ChatLayoutScrollButton
      isVisible={snapshot.awayFromTail}
      onClick={() => authority?.pinToTail()}
    />
  );
}

function noopSubscribe(): () => void {
  return () => undefined;
}

function detachedSnapshot(): TranscriptScrollSnapshot {
  return DETACHED_SNAPSHOT;
}
