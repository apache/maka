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
  /**
   * A turn to reveal, and where its requester wants it. `center` with the
   * app's scroll motion is the reveal a search result wants; `start` is for a
   * requester that is already aiming this turn itself and only needs the
   * reveal to agree with it, instantly and at the same edge.
   */
  target?: { turnId: string; nonce: number; align?: 'start' | 'center' };
  restoreTarget?: { turnId: string; unavailable?: boolean };
  onReadingAnchorChange?(turnId?: string): void;
  behavior: ScrollBehavior;
  hasOlderHistory?: boolean;
  onLoadEarlierHistory?(anchorTurnId?: string): Promise<void> | void;
}) {
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);
  const authority = useTranscriptScrollAuthority();
  const loadEarlierRef = useRef(input.onLoadEarlierHistory);
  loadEarlierRef.current = input.onLoadEarlierHistory;
  const canLoadEarlier = input.onLoadEarlierHistory !== undefined;
  const handledTarget = useRef<string | null>(null);
  const anchorChangeRef = useRef(input.onReadingAnchorChange);
  anchorChangeRef.current = input.onReadingAnchorChange;
  const reportReadingAnchor = useRef<(() => void) | undefined>(undefined);
  const reportedAnchor = useRef<{ sessionId?: string; turnId?: string } | undefined>(undefined);
  const activation = useRef<{ sessionId?: string; restoreTurnId?: string } | undefined>(undefined);
  if (activation.current?.sessionId !== input.sessionId) {
    handledTarget.current = null;
    activation.current = {
      sessionId: input.sessionId,
      restoreTurnId: input.restoreTarget?.turnId,
    };
  }
  const restoreUnavailable =
    input.restoreTarget?.turnId === activation.current?.restoreTurnId
    && input.restoreTarget?.unavailable === true;
  const commandTarget = useRef<string | null>(null);
  commandTarget.current = input.target?.turnId
    ? `search:${input.sessionId ?? ''}:${input.target.turnId}:${input.target.nonce}`
    : activation.current?.restoreTurnId
      ? restoreCommandKey(
          input.sessionId,
          activation.current.restoreTurnId,
          restoreUnavailable,
        )
      : null;

  // A passive effect, not a layout one: the scroller is Astryx's layout root,
  // an ancestor, and React attaches a parent's ref after its children's layout
  // effects have already run. The growth signal is a ResizeObserver delivery,
  // which lands after passive effects, so this is still installed in time.
  useEffect(() => authority.attach(input.scrollRef.current), [authority, input.scrollRef]);

  // A new conversation either resumes a semantic reading position or arrives
  // at its tail. Releasing before an async fill is essential: an empty
  // transcript clamps every pixel offset to zero, but it cannot erase a Turn
  // identity.
  useEffect(() => {
    if (activation.current?.restoreTurnId) authority.releasePin();
    else authority.pinToTail();
  }, [input.sessionId]);

  useEffect(() => {
    const report = (): void => {
      const snapshot = authority.getSnapshot();
      // A release is part of both navigation commands. Until the command has
      // actually landed, neither an intermediate bounded range nor an empty
      // one says anything new about where the reader intended to be.
      if (commandTarget.current && handledTarget.current !== commandTarget.current) return;
      const turnId = snapshot.pinned
        ? undefined
        : firstVisibleTurnId(input.scrollRef.current);
      // An empty bounded range has no new reading position. In particular,
      // releasing the pin before a remembered range loads must not erase the
      // Turn that caused that range to be requested.
      if (!snapshot.pinned && !turnId) return;
      const previous = reportedAnchor.current;
      if (
        previous !== undefined &&
        previous.sessionId === input.sessionId &&
        previous.turnId === turnId
      ) return;
      reportedAnchor.current = { sessionId: input.sessionId, turnId };
      anchorChangeRef.current?.(turnId);
    };
    reportReadingAnchor.current = report;
    report();
    const stopWatchingPolicy = authority.subscribe(report);
    const stopWatchingReader = authority.subscribeToReaderScroll(report);
    return () => {
      if (reportReadingAnchor.current === report) reportReadingAnchor.current = undefined;
      stopWatchingPolicy();
      stopWatchingReader();
    };
  }, [authority, input.scrollRef, input.sessionId]);

  useEffect(() => {
    const root = input.scrollRef.current;
    if (!root || !input.hasOlderHistory || !canLoadEarlier) return;
    // Asking twice is the loader's problem, not this one's: it refuses a
    // request while one is in flight, and asking for history the reader
    // already has is idempotent anyway.
    const requestEarlier = (): void => {
      const anchorTurnId = firstVisibleTurnId(root);
      // The browser anchors the reader against everything that lands above
      // them, with one exception: it declines while the scroller sits at zero,
      // which is exactly where a wheel asks for history. One pixel is the whole
      // fix — measured in Chromium, an insert of 501px above the reader moves
      // `scrollTop` by 501 at an offset of 1 and by 0 at an offset of 0.
      if (root.scrollTop < 1) root.scrollTop = 1;
      void Promise.resolve(loadEarlierRef.current?.(anchorTurnId)).catch(() => undefined);
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
      for (const target of event.composedPath()) {
        if (target === root) break;
        if (!(target instanceof HTMLElement)) continue;
        const overflowY = getComputedStyle(target).overflowY;
        if (!['auto', 'scroll', 'overlay'].includes(overflowY)) continue;
        if (target.scrollHeight > target.clientHeight && target.scrollTop > 0) return;
      }
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
    const explicitTarget = input.target?.turnId
      ? {
          kind: 'search' as const,
          turnId: input.target.turnId,
          nonce: input.target.nonce,
          align: input.target.align ?? ('center' as const),
        }
      : undefined;
    const restoreTurnId = activation.current?.restoreTurnId;
    const target = explicitTarget ?? (restoreTurnId
      ? {
          kind: 'restore' as const,
          turnId: restoreTurnId,
          unavailable: restoreUnavailable,
        }
      : undefined);
    if (!target) return;
    if (explicitTarget) activation.current = { sessionId: input.sessionId };
    // This effect re-runs on every transcript update so a target that arrives
    // before its turn still lands. It stops for good once the turn is on
    // screen — repeating the release afterwards would take the tail away from
    // a reader who had already scrolled back to it.
    const chosen = target.kind === 'search'
      ? `search:${input.sessionId ?? ''}:${target.turnId}:${target.nonce}`
      : restoreCommandKey(input.sessionId, target.turnId, target.unavailable);
    if (handledTarget.current === chosen) return;
    authority.releasePin();
    const frame = window.requestAnimationFrame(() => {
      const root = input.scrollRef.current;
      if (!root) return;
      const element = root.querySelector(`[data-turn-id="${CSS.escape(target.turnId)}"]`);
      if (!element || !('scrollIntoView' in element)) {
        if (target.kind !== 'restore' || !target.unavailable) return;
        handledTarget.current = chosen;
        activation.current = { sessionId: input.sessionId };
        if (!firstVisibleTurnId(root)) authority.pinToTail();
        reportReadingAnchor.current?.();
        return;
      }
      handledTarget.current = chosen;
      const targetElement = element as HTMLElement;
      const alignToStart = target.kind !== 'search' || target.align === 'start';
      targetElement.scrollIntoView({
        // A reveal that agrees with a requester already aiming this turn has to
        // be instant too: an animated one is a second writer moving the
        // scroller for a second after the requester has landed it.
        behavior: alignToStart ? 'auto' : input.behavior,
        block: alignToStart ? 'start' : 'center',
      });
      // A command can land at the browser's existing offset and therefore
      // produce no scroll event. Reuse the authority-backed reporter so that
      // switching away still retains the position the command established.
      reportReadingAnchor.current?.();
      if (target.kind === 'restore') return;
      targetElement.setAttribute('tabindex', '-1');
      targetElement.focus({ preventScroll: true });
      setHighlightedTurnId(target.turnId);
    });
    const clear = target.kind === 'search'
      ? window.setTimeout(() => {
          setHighlightedTurnId((current) => (current === target.turnId ? null : current));
        }, 2200)
      : undefined;
    return () => {
      window.cancelAnimationFrame(frame);
      if (clear !== undefined) window.clearTimeout(clear);
    };
  }, [
    input.target?.turnId,
    input.target?.nonce,
    input.restoreTarget?.turnId,
    input.restoreTarget?.unavailable,
    input.behavior,
    input.sessionId,
    input.messages,
    input.scrollRef,
  ]);

  return {
    highlightedTurnId,
  };
}

function firstVisibleTurnId(root: HTMLElement | null): string | undefined {
  if (!root) return undefined;
  const rootTop = root.getBoundingClientRect().top;
  return [...root.querySelectorAll<HTMLElement>('[data-turn-id]')]
    .find((turn) => turn.getBoundingClientRect().bottom > rootTop)
    ?.dataset.turnId;
}

function restoreCommandKey(
  sessionId: string | undefined,
  turnId: string,
  unavailable: boolean,
): string {
  return `restore:${sessionId ?? ''}:${turnId}:${unavailable ? 'unavailable' : 'pending'}`;
}
