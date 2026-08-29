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
 * The transcript's scroll commands, and the seam that hands the scroller to the
 * authority that owns it (`transcript-scroll-authority.ts`).
 *
 * A command is one-shot — jump to a turn the reader picked, ask for the history
 * above them — and it releases the pin first, because the authority writes
 * nothing while the pin is released and so a command can never be fighting a
 * policy. That was the shape every previous round of this code had.
 *
 * What decides whether the reader wants either thing is never re-derived here.
 * "They have left the tail" is the pin, and the pin has one owner. Nothing here
 * compensates for content that lands above them either; `overflow-anchor: auto`
 * does that continuously, and for free.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { StoredMessage } from '@maka/core/session';
import { useTranscriptScrollAuthority } from './transcript-scroll-authority.js';

export function useChatScroll(input: {
  scrollRef: RefObject<HTMLElement | null>;
  sessionId?: string;
  messages: readonly StoredMessage[];
  target?: { turnId: string; nonce: number };
  behavior: ScrollBehavior;
  hasOlderHistory?: boolean;
  onLoadEarlierHistory?(): Promise<void> | void;
}) {
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);
  const authority = useTranscriptScrollAuthority();
  const loadEarlierRef = useRef(input.onLoadEarlierHistory);
  loadEarlierRef.current = input.onLoadEarlierHistory;
  const canLoadEarlier = input.onLoadEarlierHistory !== undefined;
  const handledTarget = useRef<string | null>(null);

  // A passive effect, not a layout one: the scroller is Astryx's layout root,
  // an ancestor, and React attaches a parent's ref after its children's layout
  // effects have already run. The growth signal is a ResizeObserver delivery,
  // which lands after passive effects, so this is still installed in time.
  useEffect(() => authority.attach(input.scrollRef.current), [authority, input.scrollRef]);

  // A new conversation arrives at its tail. Nothing special positions it: the
  // pin is set here and the first fill is growth like any other, so it takes
  // the one path instead of a first-fill path of its own.
  useEffect(() => {
    authority.pinToTail();
  }, [input.sessionId]);

  useEffect(() => {
    const root = input.scrollRef.current;
    if (!root || !input.hasOlderHistory || !canLoadEarlier) return;
    // Asking twice is the loader's problem, not this one's: it refuses a
    // request while one is in flight, and asking for history the reader
    // already has is idempotent anyway.
    const requestEarlier = (): void => {
      // The browser anchors the reader against everything that lands above
      // them, with one exception: it declines while the scroller sits at zero,
      // which is exactly where a wheel asks for history. One pixel is the whole
      // fix — measured in Chromium, an insert of 501px above the reader moves
      // `scrollTop` by 501 at an offset of 1 and by 0 at an offset of 0.
      if (root.scrollTop < 1) root.scrollTop = 1;
      void Promise.resolve(loadEarlierRef.current?.()).catch(() => undefined);
    };
    /** Close enough to the start that the reader is about to reach it. */
    const nearStart = (): boolean =>
      root.scrollTop <= Math.max(640, root.clientHeight * 2);
    // Nearness alone does not mean the reader wants history — on a transcript
    // shorter than about three viewports the tail is inside this band too, so
    // following it would ask on every write, and content landing above would
    // ask again on every anchoring correction until there was no history left.
    // Which movements were the reader's is not re-derived here; the authority
    // watches the scroller and says so.
    const stopWatchingReader = authority.subscribeToReaderScroll(() => {
      if (nearStart()) requestEarlier();
    });
    // A wheel is the reader asking to go up, which at `scrollTop === 0` is the
    // only way they can: the scroller cannot move, so no scroll event follows
    // and the authority never sees the gesture. Releasing here is what tells it
    // — a reader who asked for what is above them is no longer following what
    // is below.
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY >= 0 || !nearStart()) return;
      authority.releasePin();
      requestEarlier();
    };
    root.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      stopWatchingReader();
      root.removeEventListener('wheel', onWheel);
    };
  }, [authority, input.hasOlderHistory, canLoadEarlier, input.scrollRef, input.sessionId]);

  useEffect(() => {
    const target = input.target;
    if (!target?.turnId) return;
    // This effect re-runs on every transcript update so a target that arrives
    // before its turn still lands. It stops for good once the turn is on
    // screen — repeating the release afterwards would take the tail away from
    // a reader who had already scrolled back to it.
    const chosen = `${input.sessionId ?? ''}:${target.turnId}:${target.nonce}`;
    if (handledTarget.current === chosen) return;
    authority.releasePin();
    const frame = window.requestAnimationFrame(() => {
      const root = input.scrollRef.current;
      if (!root) return;
      const element = root.querySelector(`[data-turn-id="${CSS.escape(target.turnId)}"]`);
      if (!element || !('scrollIntoView' in element)) return;
      handledTarget.current = chosen;
      const targetElement = element as HTMLElement;
      targetElement.setAttribute('tabindex', '-1');
      targetElement.scrollIntoView({
        behavior: input.behavior,
        block: 'center',
      });
      targetElement.focus({ preventScroll: true });
      setHighlightedTurnId(target.turnId);
    });
    const clear = window.setTimeout(() => {
      setHighlightedTurnId((current) => (current === target.turnId ? null : current));
    }, 2200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(clear);
    };
  }, [input.target?.turnId, input.target?.nonce, input.behavior, input.sessionId, input.messages, input.scrollRef]);

  return {
    highlightedTurnId,
  };
}
