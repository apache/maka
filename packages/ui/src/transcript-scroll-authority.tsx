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
 * While pinned, disable native anchoring so content cannot move the viewport
 * behind this authority's own write. Once released, restore native anchoring
 * to keep the reader on the same content without application writes.
 *
 * The last written offset identifies our asynchronous scroll echoes. When
 * released, geometry also accounts for native anchoring and browser clamping
 * before an unexplained movement is reported as reader input.
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
/**
 * How far an offset may miss what the content accounts for and still be the
 * content.
 *
 * The band below holds an exact `scrollTop` against a range built from two
 * rounded integers, and native anchoring rounds the anchor's own positions
 * separately again, so a step that is entirely the content still lands a pixel
 * or two outside its own band. A story in `packages/ui/stories` measures that
 * against a real layout engine and goes red if a browser starts missing by
 * more.
 *
 * It is spent only where that arithmetic happened. An event that finds the
 * content unchanged has nothing rounded in it: the band is a point, the offset
 * either moved or did not, and a reader inching down a settled transcript is
 * heard exactly. Spending it on those events instead is what would make a slow
 * reader unhearable, and no accumulator can buy that back — the error is
 * bounded per event but one-directional across a stream, so a running total
 * turns a pixel of arithmetic into a drift that crosses any threshold.
 */
const GEOMETRY_ROUNDING_PX = 2;

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
   * Called when the reader moved the scroller, and only then. Growth, native
   * anchoring and this authority's own writes all move `scrollTop` without
   * saying anything about what the reader wants, and none of them reach here.
   *
   * It exists so nothing else keeps a second reading of the raw `scroll` event:
   * whoever needs "the reader is near the start" asks the position, and this
   * says when asking means anything.
   */
  subscribeToReaderScroll(listener: () => void): () => void;
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
  /**
   * The scroll geometry the last event saw.
   *
   * Both numbers move `scrollTop` without the reader touching anything: content
   * lands and native anchoring compensates, or the viewport changes size and
   * the browser clamps the offset to the new end. Comparing them is how a
   * gesture is told from everything else that writes.
   */
  let lastScrollHeight = 0;
  let lastClientHeight = 0;
  /** The offset the last event saw, to measure the next one's move against. */
  let lastScrollTop = 0;
  let snapshot: TranscriptScrollSnapshot = { pinned, awayFromTail };
  const listeners = new Set<() => void>();
  const readerListeners = new Set<() => void>();

  const publish = (): void => {
    // Net height cannot explain anchoring when content shrinks above the
    // viewport while growing below it. Give each mode just one scroll writer.
    if (root) root.style.overflowAnchor = pinned ? 'none' : 'auto';
    if (snapshot.pinned === pinned && snapshot.awayFromTail === awayFromTail) return;
    snapshot = { pinned, awayFromTail };
    for (const listener of listeners) listener();
  };

  const distanceToTail = (): number =>
    root ? root.scrollHeight - root.scrollTop - root.clientHeight : 0;

  const writeToTail = (): void => {
    if (!root) return;
    root.scrollTop = root.scrollHeight;
    // Read them back: the browser clamps the write to the end of the scroller,
    // and the clamped offset is what the event will carry.
    lastWrittenTop = root.scrollTop;
    lastScrollHeight = root.scrollHeight;
    lastClientHeight = root.clientHeight;
    lastScrollTop = root.scrollTop;
    awayFromTail = false;
    publish();
  };

  return {
    attach(next) {
      root = next;
      const target = root;
      if (!target) return () => undefined;
      const previousOverflowAnchor = target.style.overflowAnchor;
      publish();
      const onScroll = (): void => {
        // An event that finds the scroller still on the offset this authority
        // put it on is the echo of that write, however late it arrives; any
        // other offset is the reader, exactly, and not by inference. Nested
        // scrollers (a tool output box, a terminal) never reach here at all:
        // `scroll` does not bubble, and there is no `wheel` listener to catch
        // instead.
        if (lastWrittenTop !== undefined && Math.abs(target.scrollTop - lastWrittenTop) < 1) {
          lastScrollHeight = target.scrollHeight;
          lastClientHeight = target.clientHeight;
          lastScrollTop = target.scrollTop;
          return;
        }
        // Content moves the offset too, and only ever by how much the end of
        // the transcript moved. Native anchoring answers content landing above
        // the reader by pushing the offset down by exactly what was inserted,
        // content leaving from above by pulling it up by exactly what went,
        // and a transcript that ends before the offset by clamping it to the
        // new end — every one of them somewhere between nothing and that whole
        // amount. Inside that band their offset changed and their intent did
        // not, so the pin must not be re-derived from where they now are, and
        // nobody may be told the reader asked for anything. The affordance
        // still follows the new distance, because that is a fact about the
        // viewport rather than about them.
        //
        // Outside it, the move is the reader's, and this may not be decided
        // from the geometry merely having changed. During growth it always
        // has, so a reader who scrolled while an answer streamed arrived
        // carrying a changed `scrollHeight` and was discarded along with it —
        // the pin stayed, and the next growth wrote the view back to the tail.
        // Scrolling away from a streaming answer is the one moment a reader
        // most needs to be believed.
        const maxScroll = target.scrollHeight - target.clientHeight;
        const contentDelta = maxScroll - (lastScrollHeight - lastClientHeight);
        const explainedLow = Math.min(0, contentDelta);
        const explainedHigh = Math.max(0, contentDelta);
        const topDelta = target.scrollTop - lastScrollTop;
        const unexplained = topDelta - Math.min(explainedHigh, Math.max(explainedLow, topDelta));
        const slack = contentDelta === 0 ? 0 : GEOMETRY_ROUNDING_PX;
        const readerMoved = Math.abs(unexplained) > slack;
        lastScrollHeight = target.scrollHeight;
        lastClientHeight = target.clientHeight;
        lastScrollTop = target.scrollTop;
        const distance = distanceToTail();
        awayFromTail = distance > BUTTON_THRESHOLD_PX;
        if (!readerMoved) {
          publish();
          return;
        }
        pinned = distance <= PIN_THRESHOLD_PX;
        publish();
        for (const listener of [...readerListeners]) listener();
      };
      lastScrollHeight = target.scrollHeight;
      lastClientHeight = target.clientHeight;
      lastScrollTop = target.scrollTop;
      target.addEventListener('scroll', onScroll, { passive: true });
      // Everything that moves the tail without the reader asking, watched in
      // one place: the scroller's own box, because the tail also moves when the
      // viewport shrinks (a window resize, a composer that gains a line), and
      // its children's boxes, because that is what `scrollHeight` is made of.
      //
      // Children rather than the scroller: a ResizeObserver on a scroll
      // container reports the viewport, never the overflow. And children rather
      // than the transcript's own idea of what grew — a turn, a streaming
      // message — because the transcript renders content outside turns too, and
      // an observer that knows which nodes matter is an observer that can be
      // wrong about it.
      const box = new ResizeObserver(() => {
        if (pinned) {
          writeToTail();
          return;
        }
        awayFromTail = distanceToTail() > BUTTON_THRESHOLD_PX;
        publish();
      });
      const observeBox = (): void => {
        box.disconnect();
        box.observe(target);
        for (const child of target.children) box.observe(child);
      };
      // Only the direct children: anything deeper grows one of them on its way
      // to growing `scrollHeight`, or is out of flow and does not grow it.
      const childList = new MutationObserver(observeBox);
      childList.observe(target, { childList: true });
      observeBox();
      if (pinned) writeToTail();
      return () => {
        childList.disconnect();
        box.disconnect();
        target.removeEventListener('scroll', onScroll);
        target.style.overflowAnchor = previousOverflowAnchor;
        lastWrittenTop = undefined;
        if (root === target) root = null;
      };
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
    subscribeToReaderScroll(listener) {
      readerListeners.add(listener);
      return () => {
        readerListeners.delete(listener);
      };
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
