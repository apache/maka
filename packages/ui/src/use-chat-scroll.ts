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
 * above them — and it releases the pin first, so explicit navigation does not
 * fight following. The authority also owns range publication and its one-shot
 * reading-anchor restoration.
 *
 * What decides whether the reader wants either thing is never re-derived here.
 * "They have left the tail" is the pin, and the pin has one owner. Nothing here
 * compensates for content that lands above them; that belongs to the authority.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { StoredMessage } from '@maka/core/session';
import { useTranscriptScrollAuthority } from './transcript-scroll-authority.js';
import type { TranscriptViewportNavigation } from './transcript-viewport-navigation.js';

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
  onTargetHandled?(nonce: number): void;
  viewportNavigation?: TranscriptViewportNavigation;
  onReadingAnchorChange?(turnId?: string): void;
  behavior: ScrollBehavior;
  hasOlderHistory?: boolean;
  hasNewerHistory?: boolean;
  onPrefetchHistory?(edge: 'older' | 'newer'): Promise<boolean>;
  /** The turns the reader can still reach within the retained band; the rest may go. */
  onRetainWindow?(window: { firstTurnId: string; lastTurnId: string }): void;
}) {
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);
  const authority = useTranscriptScrollAuthority();
  const prefetchRef = useRef(input.onPrefetchHistory);
  prefetchRef.current = input.onPrefetchHistory;
  const canPrefetch = input.onPrefetchHistory !== undefined;
  const retainRef = useRef(input.onRetainWindow);
  retainRef.current = input.onRetainWindow;
  const handledTarget = useRef<string | null>(null);
  const anchorChangeRef = useRef(input.onReadingAnchorChange);
  anchorChangeRef.current = input.onReadingAnchorChange;
  const targetHandledRef = useRef(input.onTargetHandled);
  targetHandledRef.current = input.onTargetHandled;
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
  const commandTargetTurnId = useRef<string | undefined>(undefined);
  commandTargetTurnId.current = input.target?.turnId ?? activation.current?.restoreTurnId;
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

  useEffect(() => input.sessionId
    ? input.viewportNavigation?.attachCommitScheduler(input.sessionId, authority)
    : undefined, [authority, input.sessionId, input.viewportNavigation]);

  // A new conversation either resumes a semantic reading position or arrives
  // at its tail. Releasing before an async fill is essential: an empty
  // transcript clamps every pixel offset to zero, but it cannot erase a Turn
  // identity.
  useEffect(() => {
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
    authority.pinToTail();
  }), [authority, input.viewportNavigation]);

  useEffect(() => {
    const report = (): void => {
      const snapshot = authority.getSnapshot();
      // A release is part of both navigation commands. Until the command has
      // actually landed, neither an intermediate bounded range nor an empty
      // one says anything new about where the reader intended to be.
      if (commandTarget.current && handledTarget.current !== commandTarget.current) return;
      const turnId = snapshot.pinned ? undefined : authority.measureReadingTurn();
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
    let previousPin = authority.getSnapshot().pinned;
    const stopWatchingPolicy = authority.subscribe(() => {
      const pinned = authority.getSnapshot().pinned;
      // Geometry can change the return-to-tail affordance without changing
      // reading intent. Reporting its visible Turn would turn an arriving
      // range into a new history command and cancel the range's own sender.
      if (pinned === previousPin) return;
      previousPin = pinned;
      report();
    });
    const stopWatchingReader = authority.subscribeToReaderScroll((phase) => {
      if (phase === 'scroll') report();
    });
    return () => {
      if (reportReadingAnchor.current === report) reportReadingAnchor.current = undefined;
      stopWatchingPolicy();
      stopWatchingReader();
    };
  }, [authority, input.scrollRef, input.sessionId]);

  const bandCheck = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    const root = input.scrollRef.current;
    if (!root) return;
    const inFlight = { up: false, down: false };
    const canLoad = (direction: 'up' | 'down'): boolean => direction === 'up'
      ? input.hasOlderHistory === true && canPrefetch
      : input.hasNewerHistory === true && canPrefetch;
    const requestHistory = (direction: 'up' | 'down'): void => {
      if (inFlight[direction]) return;
      inFlight[direction] = true;
      void Promise.resolve(prefetchRef.current?.(direction === 'up' ? 'older' : 'newer'))
        .then(
          // Chaining pages needs a re-check here, because the render that the
          // landed rows caused ran while this direction still counted as in
          // flight. A prefetch that issued no read has nothing to chain from.
          (issued) => { inFlight[direction] = false; if (issued && !authority.isInputActive()) check(); },
          () => { inFlight[direction] = false; },
        );
    };
    const check = (): void => {
      if (!root.isConnected || bandCheck.current !== check) return;
      const screen = Math.max(320, root.clientHeight);
      const above = root.scrollTop;
      const below = root.scrollHeight - root.clientHeight - root.scrollTop;
      if (canLoad('up') && above < screen * 2) requestHistory('up');
      if (canLoad('down') && below < screen * 2) requestHistory('down');
      // Source pages may have arrived without entering the DOM yet. Its old
      // IDs cannot trim that source; settled rechecks after publication.
      if (authority.isInputActive()) return;
      if (above <= screen * 6 && below <= screen * 6) return;
      const rect = root.getBoundingClientRect();
      const turns = [...root.querySelectorAll<HTMLElement>('[data-turn-id]')];
      // A mounted Turn that a pending command is about to reveal must survive
      // this pass: a page installs it several screens from the reader, so the
      // band would trim it before the frame that scrolls to it ever runs, and
      // the command would never land. A target that is not mounted cannot be
      // trimmed anyway, and waiting for it would let the window grow unbounded.
      const pending = commandTarget.current !== null
        && handledTarget.current !== commandTarget.current
        ? commandTargetTurnId.current
        : undefined;
      if (pending && turns.some((turn) => turn.dataset.turnId === pending)) return;
      const kept = turns.filter((turn) => {
        const box = turn.getBoundingClientRect();
        return box.bottom >= rect.top - screen * 4 && box.top <= rect.bottom + screen * 4;
      });
      const first = kept[0]?.dataset.turnId;
      const last = kept.at(-1)?.dataset.turnId;
      if (!first || !last || kept.length === turns.length) return;
      retainRef.current?.({ firstTurnId: first, lastTurnId: last });
    };
    bandCheck.current = check;
    // Both phases matter: a gesture at an edge moves nothing and so reports
    // only `input`, and that is exactly where the next page is wanted.
    const stopWatchingReader = authority.subscribeToReaderScroll((phase, direction) => {
      check();
      // An existing fill also satisfies this request. Preserve the gesture
      // while giving the authority the intent that pixels alone cannot tell.
      return phase === 'input' && direction === 'up' && canLoad('up');
    });
    // A resize redefines the band itself — the screen it counts in is the
    // root's own height — while the reader and the messages stand still. The
    // authority publishes only when its snapshot changes, so a resize that
    // leaves the pin and the reading Turn alone reaches nothing but this.
    const size = new ResizeObserver(() => check());
    size.observe(root);
    const frame = window.requestAnimationFrame(check);
    return () => {
      window.cancelAnimationFrame(frame);
      if (bandCheck.current === check) bandCheck.current = undefined;
      stopWatchingReader();
      size.disconnect();
    };
  }, [authority, input.hasOlderHistory, input.hasNewerHistory, canPrefetch,
    input.scrollRef, input.sessionId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => bandCheck.current?.());
    return () => window.cancelAnimationFrame(frame);
  }, [input.messages]);

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
    // This effect re-runs on every render so a target that arrives before its
    // turn still lands. What mounts that turn is the resident range, which the
    // Renderer moves without touching the message list, so no dependency here
    // can stand for "the turn may be on screen now". It stops for good once the
    // turn is revealed — repeating the release afterwards would take the tail
    // away from a reader who had already scrolled back to it.
    const chosen = target.kind === 'search'
      ? `search:${input.sessionId ?? ''}:${target.turnId}:${target.nonce}`
      : restoreCommandKey(input.sessionId, target.turnId, target.unavailable);
    if (handledTarget.current === chosen) return;
    authority.releasePin();
    const frame = window.requestAnimationFrame(() => {
      if (commandTarget.current !== chosen) return;
      // A reader who asked for the tail while this frame was queued outranks it:
      // the bookmark describes where they were, the pin where they said to be.
      if (authority.getSnapshot().pinned) {
        handledTarget.current = chosen;
        return;
      }
      const root = input.scrollRef.current;
      if (!root) return;
      const element = root.querySelector(`[data-turn-id="${CSS.escape(target.turnId)}"]`);
      if (!element || !('scrollIntoView' in element)) {
        if (target.kind !== 'restore' || !target.unavailable) return;
        handledTarget.current = chosen;
        activation.current = { sessionId: input.sessionId };
        if (!authority.measureReadingTurn()) authority.pinToTail();
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
      targetHandledRef.current?.(target.nonce);
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
  });

  return {
    highlightedTurnId,
  };
}

function restoreCommandKey(
  sessionId: string | undefined,
  turnId: string,
  unavailable: boolean,
): string {
  return `restore:${sessionId ?? ''}:${turnId}:${unavailable ? 'unavailable' : 'pending'}`;
}
