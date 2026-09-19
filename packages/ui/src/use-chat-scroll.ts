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
 * The transcript's scroll commands, and the seam that hands the scroller and
 * the virtualized list to the authority that owns every write to it
 * (`transcript-scroll-authority.tsx`).
 *
 * A command is one-shot — jump to a turn the reader picked — and the authority
 * carries it out. Turns are addressed by their index in the virtualized
 * transcript.
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
import {
  useTranscriptScrollAuthority,
  type TranscriptLayout,
  type TranscriptTurnListChange,
} from './transcript-scroll-authority.js';
import type { TranscriptViewportNavigation } from './transcript-viewport-navigation.js';

const SEARCH_HIGHLIGHT_MS = 2200;

export function classifyTurnListChange(
  previous: readonly string[],
  next: readonly string[],
): TranscriptTurnListChange {
  if (previous.length <= next.length && previous.every((turnId, index) => next[index] === turnId)) {
    return previous.length === next.length ? 'same' : 'append';
  }
  const added = next.length - previous.length;
  return added > 0 && previous.every((turnId, index) => next[added + index] === turnId)
    ? 'prepend'
    : 'reset';
}

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

  /**
   * `virtua` caches measured heights by position. Growth at the tail leaves
   * every position where it was, growth at the front is what `shift` moves the
   * cache for, and any other change — a filter, a replaced transcript — leaves
   * no position meaning what it did, so the virtualizer starts a new cache.
   */
  const list = useRef<{
    turnIds: readonly string[];
    sessionId?: string;
    change: TranscriptTurnListChange;
    generation: number;
  }>({ turnIds: input.turnIds, sessionId: input.sessionId, change: 'same', generation: 0 });
  if (list.current.turnIds !== input.turnIds || list.current.sessionId !== input.sessionId) {
    const previous = list.current;
    const change = previous.sessionId === input.sessionId
      ? classifyTurnListChange(previous.turnIds, input.turnIds)
      : 'reset';
    list.current = {
      turnIds: input.turnIds,
      sessionId: input.sessionId,
      change,
      generation: change === 'reset' ? previous.generation + 1 : previous.generation,
    };
  }

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
  const highlightClear = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(highlightClear.current), []);

  const measureStartMarginRef = useRef(input.measureStartMargin);
  measureStartMarginRef.current = input.measureStartMargin;
  const [layout] = useState((): TranscriptLayout => ({
    turnAt(scrollTop) {
      const handle = input.virtualizerRef.current;
      const turnIds = turnIdsRef.current;
      if (!handle || turnIds.length === 0) return undefined;
      return turnIds[Math.min(handle.findItemIndex(scrollTop), turnIds.length - 1)];
    },
    offsetOf(turnId) {
      const handle = input.virtualizerRef.current;
      const index = turnIdsRef.current.indexOf(turnId);
      if (!handle || index === -1) return undefined;
      return measureStartMarginRef.current() + handle.getItemOffset(index);
    },
    reveal(turnId, options) {
      const index = turnIdsRef.current.indexOf(turnId);
      if (index !== -1) input.virtualizerRef.current?.scrollToIndex(index, options);
    },
  }));

  // A passive effect, not a layout one: the scroller is Astryx's layout root,
  // an ancestor, and React attaches a parent's ref after its children's layout
  // effects have already run.
  useEffect(
    () => authority.attach(input.scrollRef.current, layout),
    [authority, input.scrollRef, layout],
  );

  // A new conversation either resumes a semantic reading position or arrives
  // at its tail. Releasing before an async fill is essential: an empty
  // transcript clamps every pixel offset to zero, but it cannot erase a Turn
  // identity. Runs before the command below so it is not followed by a tail
  // write.
  useLayoutEffect(() => {
    if (activation.current?.restoreTurnId) authority.releasePin();
    else authority.pinToTail();
  }, [input.sessionId]);

  useLayoutEffect(() => {
    authority.turnsChanged(list.current.change);
  }, [authority, input.turnIds]);

  useEffect(() => input.viewportNavigation?.subscribe((sessionId) => {
    if (activation.current?.sessionId !== sessionId) return;
    // A send supersedes both a captured bookmark and a search that has not
    // landed yet.
    handledTarget.current = commandTarget.current;
    activation.current = { sessionId };
    commandTarget.current = null;
    authority.pinToTail();
  }), [authority, input.viewportNavigation]);

  useEffect(() => {
    const report = (measure: boolean): void => {
      // Until a command has landed, the viewport says nothing about where the
      // reader intended to be.
      if (commandTarget.current && handledTarget.current !== commandTarget.current) return;
      if (authority.getSnapshot().positioning) return;
      const turnId = authority.getSnapshot().pinned
        ? undefined
        : measure ? authority.measureReadingTurn() : authority.getSnapshot().readingTurnId;
      // Releasing the pin before the transcript fills must not erase the Turn
      // the reader is being taken to.
      if (!authority.getSnapshot().pinned && !turnId) return;
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

  // Runs on every render: a target can arrive with any render, and is handed
  // to the authority once. A Turn not in the list yet is taken to when it
  // arrives.
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
    handledTarget.current = chosen;
    if (target.kind === 'restore' && target.unavailable && !input.turnIds.includes(target.turnId)) {
      activation.current = { sessionId: input.sessionId };
      authority.releasePin();
      if (!authority.measureReadingTurn()) authority.pinToTail();
      reportReadingAnchor.current?.();
      return;
    }
    if (target.kind === 'restore') {
      authority.navigate({ turnId: target.turnId, align: 'start' });
      return;
    }
    const center = target.align === 'center';
    authority.navigate({
      turnId: target.turnId,
      align: target.align,
      smooth: center && input.behavior === 'smooth',
      onSettled: () => {
        const row = input.scrollRef.current?.querySelector<HTMLElement>(
          `[data-turn-id="${CSS.escape(target.turnId)}"]`,
        );
        if (row && !target.preserveFocus) {
          row.setAttribute('tabindex', '-1');
          row.focus({ preventScroll: true });
        }
        setHighlightedTurnId(target.turnId);
        clearTimeout(highlightClear.current);
        highlightClear.current = setTimeout(() => {
          setHighlightedTurnId((current) => (current === target.turnId ? null : current));
        }, SEARCH_HIGHLIGHT_MS);
      },
    });
  });

  const revealTurnAtStart = useCallback((turnId: string, arrival: PromiseLike<unknown>): void => {
    authority.navigate({ turnId, align: 'start', arrival });
  }, [authority]);

  return {
    highlightedTurnId,
    /** The Turn a pending or landing command is about; its row must stay mounted. */
    commandTurnId: input.target?.turnId ?? activation.current?.restoreTurnId,
    revealTurnAtStart,
    /** Moves the virtualizer's measurement cache with the list; see `list` above. */
    measurement: {
      shift: list.current.change === 'prepend',
      generation: list.current.generation,
    },
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
      const { pinned, positioning } = authority.getSnapshot();
      // A positioning places its Turn from the live margin itself.
      if (previous !== undefined && !pinned && !positioning && root.scrollTop > previous) {
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
