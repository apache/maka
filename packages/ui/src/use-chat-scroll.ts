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
 * A command is one-shot — jump to a turn the reader picked — and it releases
 * the pin first, so explicit navigation does not fight following. Turns are
 * addressed by their index in the virtualized transcript.
 *
 * What decides whether the reader wants either thing is never re-derived here.
 * "They have left the tail" is the pin, and the pin has one owner.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { VirtualizerHandle } from 'virtua';
import { useTranscriptScrollAuthority } from './transcript-scroll-authority.js';
import type { TranscriptViewportNavigation } from './transcript-viewport-navigation.js';

/** A reveal whose row never mounts gives up on focus and highlight after this. */
const REVEAL_MOUNT_FRAMES = 60;
const SEARCH_HIGHLIGHT_MS = 2200;
/** How long a load-earlier hold keeps its Turn still while the arrivals measure. */
const HOLD_SETTLE_FRAMES = 30;
const READER_INPUT_EVENTS = ['wheel', 'touchstart', 'keydown'] as const;

export function useChatScroll(input: {
  scrollRef: RefObject<HTMLElement | null>;
  virtualizerRef: RefObject<VirtualizerHandle | null>;
  sessionId?: string;
  /** One entry per virtualized item, in order. */
  turnIds: readonly string[];
  /**
   * A turn to reveal, and where its requester wants it. `center` with the
   * app's scroll motion is the reveal a search result wants; `start` lands
   * instantly at the top edge.
   */
  target?: { turnId: string; nonce: number; preserveFocus?: boolean; align?: 'start' | 'center' };
  restoreTarget?: { turnId: string; unavailable?: boolean };
  viewportNavigation?: TranscriptViewportNavigation;
  onReadingAnchorChange?(turnId?: string): void;
  behavior: ScrollBehavior;
  /** `useTranscriptStartMargin`'s live measurement, for reads within a commit. */
  measureStartMargin(): number;
}) {
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);
  const authority = useTranscriptScrollAuthority();
  const turnIdsRef = useRef(input.turnIds);
  turnIdsRef.current = input.turnIds;
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
  if (activation.current?.restoreTurnId
    && activation.current.restoreTurnId !== input.restoreTarget?.turnId) {
    // Clearing or replacing a bookmark cancels the captured command. A new
    // bookmark within the same activation records reading, not navigation.
    activation.current = { sessionId: input.sessionId };
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
  const pendingReveal = useRef<{ frame?: number; clear?: ReturnType<typeof setTimeout> }>({});
  const cancelPendingReveal = useCallback(() => {
    if (pendingReveal.current.frame !== undefined) cancelAnimationFrame(pendingReveal.current.frame);
    if (pendingReveal.current.clear !== undefined) clearTimeout(pendingReveal.current.clear);
    pendingReveal.current = {};
  }, []);
  useEffect(() => cancelPendingReveal, [cancelPendingReveal]);

  const readTurnAt = useCallback((scrollTop: number): string | undefined => {
    const handle = input.virtualizerRef.current;
    const turnIds = turnIdsRef.current;
    if (!handle || turnIds.length === 0) return undefined;
    return turnIds[Math.min(handle.findItemIndex(scrollTop), turnIds.length - 1)];
  }, [input.virtualizerRef]);

  // A passive effect, not a layout one: the scroller is Astryx's layout root,
  // an ancestor, and React attaches a parent's ref after its children's layout
  // effects have already run.
  useEffect(
    () => authority.attach(input.scrollRef.current, readTurnAt),
    [authority, input.scrollRef, readTurnAt],
  );

  // A new conversation either resumes a semantic reading position or arrives
  // at its tail. Releasing before an async fill is essential: an empty
  // transcript clamps every pixel offset to zero, but it cannot erase a Turn
  // identity. Runs before the reveal below so a command in the same render
  // is not followed by a tail write.
  useLayoutEffect(() => {
    if (activation.current?.restoreTurnId) authority.releasePin();
    else authority.pinToTail();
  }, [input.sessionId]);

  useEffect(() => input.viewportNavigation?.subscribe((sessionId) => {
    if (activation.current?.sessionId !== sessionId) return;
    // A send supersedes both a captured bookmark and a search frame that has
    // not landed yet. Consume that frame before the authority reports the pin.
    handledTarget.current = commandTarget.current;
    activation.current = { sessionId };
    commandTarget.current = null;
    cancelPendingReveal();
    authority.pinToTail();
  }), [authority, cancelPendingReveal, input.viewportNavigation]);

  useEffect(() => {
    const report = (measure: boolean): void => {
      // A release is part of both navigation commands. Until the command has
      // actually landed, the viewport says nothing about where the reader
      // intended to be.
      if (commandTarget.current && handledTarget.current !== commandTarget.current) return;
      const snapshot = authority.getSnapshot();
      const turnId = snapshot.pinned
        ? undefined
        : measure ? authority.measureReadingTurn() : snapshot.readingTurnId;
      // Releasing the pin before the transcript fills must not erase the Turn
      // the reader is being taken to.
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
    const reportNow = (): void => report(true);
    reportReadingAnchor.current = reportNow;
    reportNow();
    const stop = authority.subscribe(() => report(false));
    return () => {
      if (reportReadingAnchor.current === reportNow) reportReadingAnchor.current = undefined;
      stop();
    };
  }, [authority, input.sessionId]);

  useEffect(() => {
    authority.measureReadingTurn();
  }, [authority, input.turnIds]);

  // Runs on every render: a target can arrive before its Turn does. It stops
  // for good once the command lands — repeating the release afterwards would
  // take the tail away from a reader who had already scrolled back to it.
  useLayoutEffect(() => {
    const explicitTarget = input.target?.turnId
      ? {
          kind: 'search' as const,
          preserveFocus: input.target.preserveFocus,
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
    const chosen = target.kind === 'search'
      ? `search:${input.sessionId ?? ''}:${target.turnId}:${target.nonce}`
      : restoreCommandKey(input.sessionId, target.turnId, target.unavailable);
    if (handledTarget.current === chosen) return;
    authority.releasePin();
    const index = input.turnIds.indexOf(target.turnId);
    if (index === -1) {
      if (target.kind !== 'restore' || !target.unavailable) return;
      handledTarget.current = chosen;
      activation.current = { sessionId: input.sessionId };
      if (!authority.measureReadingTurn()) authority.pinToTail();
      reportReadingAnchor.current?.();
      return;
    }
    const handle = input.virtualizerRef.current;
    if (!handle) return;
    handledTarget.current = chosen;
    const alignToStart = target.kind !== 'search' || target.align === 'start';
    handle.scrollToIndex(index, {
      align: alignToStart ? 'start' : 'center',
      smooth: !alignToStart && input.behavior === 'smooth',
    });
    cancelPendingReveal();
    let frames = 0;
    const land = (): void => {
      pendingReveal.current.frame = undefined;
      if (commandTarget.current !== chosen) return;
      const row = input.scrollRef.current?.querySelector<HTMLElement>(
        `[data-turn-id="${CSS.escape(target.turnId)}"]`,
      );
      if (!row) {
        if (++frames < REVEAL_MOUNT_FRAMES) pendingReveal.current.frame = requestAnimationFrame(land);
        return;
      }
      // A command can land at the browser's existing offset and therefore
      // produce no scroll event.
      reportReadingAnchor.current?.();
      if (target.kind === 'restore') return;
      if (!target.preserveFocus) {
        row.setAttribute('tabindex', '-1');
        row.focus({ preventScroll: true });
      }
      setHighlightedTurnId(target.turnId);
      pendingReveal.current.clear = setTimeout(() => {
        pendingReveal.current.clear = undefined;
        setHighlightedTurnId((current) => (current === target.turnId ? null : current));
      }, SEARCH_HIGHLIGHT_MS);
    };
    pendingReveal.current.frame = requestAnimationFrame(land);
  });

  /**
   * Keep the reader on the Turn they are on while earlier history arrives
   * above them.
   *
   * The virtualizer shifts its offset for a prepend only while it still counts
   * itself as scrolling — it stops counting 150 ms after the last scroll — so a
   * load started a moment after scrolling would carry the reader away. Landing
   * the same Turn back at the same offset does not depend on that timing.
   */
  const measureStartMargin = input.measureStartMargin;
  const hold = useRef<{ turnId: string; gap: number; firstTurnId?: string } | undefined>(undefined);
  const holdReader = useCallback((): void => {
    const root = input.scrollRef.current;
    const handle = input.virtualizerRef.current;
    const turnIds = turnIdsRef.current;
    if (!root || !handle || turnIds.length === 0) return;
    const index = Math.min(handle.findItemIndex(root.scrollTop), turnIds.length - 1);
    hold.current = {
      turnId: turnIds[index]!,
      // Where this Turn's top sits in the scrollport. The margin belongs in it
      // because the load also retires the control the reader pressed, which
      // sits above the virtualizer and takes its own height with it.
      gap: measureStartMargin() + handle.getItemOffset(index) - root.scrollTop,
      firstTurnId: turnIds[0],
    };
  }, [input.scrollRef, input.virtualizerRef, measureStartMargin]);
  useLayoutEffect(() => {
    const held = hold.current;
    // Only the prepend this hold was taken for lands it. A Turn arriving at the
    // tail meanwhile must not move a reader who is reading history.
    if (!held || input.turnIds[0] === held.firstTurnId) return;
    hold.current = undefined;
    const index = input.turnIds.indexOf(held.turnId);
    const root = input.scrollRef.current;
    const handle = input.virtualizerRef.current;
    if (index === -1 || !root || !handle) return;
    // The arriving rows mount and measure over the next frames, and the
    // virtualizer declines to compensate for the one straddling the top edge,
    // so the landing has to be repeated until their sizes stop moving.
    let frames = HOLD_SETTLE_FRAMES;
    let pending: number | undefined;
    const land = (): void => {
      const target = measureStartMargin() + handle.getItemOffset(index) - held.gap;
      if (Math.abs(root.scrollTop - target) >= 0.5) root.scrollTop = target;
      pending = --frames > 0 ? requestAnimationFrame(land) : undefined;
    };
    land();
    const release = (): void => {
      if (pending !== undefined) cancelAnimationFrame(pending);
      frames = 0;
    };
    for (const event of READER_INPUT_EVENTS) root.addEventListener(event, release, { passive: true });
    return () => {
      release();
      for (const event of READER_INPUT_EVENTS) root.removeEventListener(event, release);
    };
  }, [input.scrollRef, input.turnIds, input.virtualizerRef, measureStartMargin]);

  const revealTurnAtStart = useCallback((turnId: string): void => {
    const index = turnIdsRef.current.indexOf(turnId);
    const handle = input.virtualizerRef.current;
    if (index === -1 || !handle) return;
    authority.releasePin();
    handle.scrollToIndex(index, { align: 'start' });
  }, [authority, input.virtualizerRef]);

  return {
    highlightedTurnId,
    /** The Turn a pending or landing command is about; its row must stay mounted. */
    commandTurnId: input.target?.turnId ?? activation.current?.restoreTurnId,
    revealTurnAtStart,
    holdReader,
  };
}

/**
 * The virtualizer's offset within the scroller's content. Content above the
 * virtualizer that changes height moves the reader unless the offset is
 * written back, because native scroll anchoring is off.
 */
export function useTranscriptStartMargin(
  scrollRef: RefObject<HTMLElement | null>,
): {
  startMargin: number;
  listRef: (element: HTMLElement | null) => void;
  measureStartMargin: () => number;
} {
  const authority = useTranscriptScrollAuthority();
  const [list, setList] = useState<HTMLElement | null>(null);
  const [startMargin, setStartMargin] = useState(0);
  const measureStartMargin = useCallback((): number => {
    const root = scrollRef.current;
    if (!root || !list) return 0;
    return list.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
  }, [list, scrollRef]);
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root || !list) return;
    let previous: number | undefined;
    const measure = (): void => {
      const next = measureStartMargin();
      if (next === previous) return;
      if (previous !== undefined && !authority.getSnapshot().pinned && root.scrollTop > previous) {
        root.scrollTop += next - previous;
      }
      previous = next;
      setStartMargin(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (root.firstElementChild) observer.observe(root.firstElementChild);
    return () => observer.disconnect();
  }, [authority, list, measureStartMargin, scrollRef]);
  return { startMargin, listRef: setList, measureStartMargin };
}

function restoreCommandKey(
  sessionId: string | undefined,
  turnId: string,
  unavailable: boolean,
): string {
  return `restore:${sessionId ?? ''}:${turnId}:${unavailable ? 'unavailable' : 'pending'}`;
}
