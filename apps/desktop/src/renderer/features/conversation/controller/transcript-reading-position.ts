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

import type { TranscriptReadingAnchor } from '../model/session-ui-state.js';

interface TranscriptRangeStore<Message> {
  range(): { readonly sessionId: string };
  sequenceForTurn(turnId: string): number | null;
  newestDurableUserSequence(): number | null;
  snapshot(): { readonly messages: readonly Message[] };
}

interface TranscriptRangeController<Message> {
  readonly store: TranscriptRangeStore<Message>;
  ready(): Promise<void>;
  loadAround(sequence: number): Promise<void>;
}

interface TranscriptHistoryController {
  readonly store: {
    range(): { readonly hasNewer: boolean; readonly newestSequence: number | null };
  };
  loadBefore(maxBytes?: number, anchorTurnId?: string): Promise<void>;
  loadAround(sequence: number): Promise<void>;
  loadLatest(): Promise<void>;
}

interface SearchTarget {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence?: number;
}

export function currentTranscriptRange<Range extends { readonly sessionId: string }>(
  controller: { readonly store: { range(): Range } } | undefined,
  sessionId: string | undefined,
): Range | undefined {
  try {
    const range = controller?.store.range();
    return range?.sessionId === sessionId ? range : undefined;
  } catch {
    return undefined;
  }
}

export function newestDurablePromptSequence<Message>(
  controller: TranscriptRangeController<Message> | undefined,
  sessionId: string | undefined,
): number | null {
  try {
    return controller && controller.store.range().sessionId === sessionId
      ? controller.store.newestDurableUserSequence()
      : null;
  } catch {
    return null;
  }
}

export async function loadTranscriptRange(
  controller: TranscriptHistoryController,
  target: 'earlier' | 'newer' | 'latest',
  maxBytes: number,
  anchorTurnId?: string,
): Promise<void> {
  if (target === 'earlier') return controller.loadBefore(maxBytes, anchorTurnId);
  if (target === 'latest') return controller.loadLatest();
  const range = controller.store.range();
  if (range.hasNewer && range.newestSequence !== null) {
    await controller.loadAround(range.newestSequence + 1);
  }
}

export function transcriptRestoreTarget(
  anchor: TranscriptReadingAnchor | undefined,
  unavailableTurnId: string | undefined,
): { readonly turnId: string; readonly unavailable: boolean } | undefined {
  if (anchor) {
    return {
      turnId: anchor.turnId,
      unavailable: unavailableTurnId === anchor.turnId,
    };
  }
  return unavailableTurnId
    ? { turnId: unavailableTurnId, unavailable: true }
    : undefined;
}

export function refreshTranscriptTurnLandmarks<T>(options: {
  readonly sessionId?: string;
  readonly newestDurablePromptSequence: number | null;
  readonly current?: { readonly sessionId: string; readonly throughSequence: number | null };
  readonly list: (sessionId: string) => Promise<{ readonly throughSequence: number | null; readonly landmarks: readonly T[] }>;
  readonly isCurrent: (sessionId: string) => boolean;
  readonly setIndex: (index: { sessionId: string; throughSequence: number | null; turns: readonly T[] } | undefined) => void;
}): (() => void) | undefined {
  const { sessionId } = options;
  if (!sessionId) {
    options.setIndex(undefined);
    return;
  }
  if (
    options.current?.sessionId === sessionId &&
    (options.newestDurablePromptSequence === null ||
      (options.current.throughSequence !== null &&
        options.newestDurablePromptSequence <= options.current.throughSequence))
  ) return;
  let disposed = false;
  void options.list(sessionId).then(
    (snapshot) => {
      if (disposed || !options.isCurrent(sessionId)) return;
      options.setIndex({
        sessionId,
        throughSequence: snapshot.throughSequence,
        turns: snapshot.landmarks,
      });
    },
    () => undefined,
  );
  return () => {
    disposed = true;
  };
}

export function restoreSessionTranscriptRange<Message>(options: {
  readonly sessionId?: string;
  readonly searchTarget?: SearchTarget | null;
  readonly readingAnchor?: TranscriptReadingAnchor;
  readonly controller?: TranscriptRangeController<Message>;
  readonly isCurrent: (sessionId: string, controller: TranscriptRangeController<Message>) => boolean;
  readonly setMessages: (messages: Message[]) => void;
  readonly setReadingAnchor: (
    sessionId: string,
    anchor: TranscriptReadingAnchor | undefined,
  ) => void;
  readonly onRestoreUnavailable?: (sessionId: string, turnId: string) => void;
  readonly onError: (error: unknown, sessionId: string) => void;
}): (() => void) | undefined {
  const { controller, sessionId } = options;
  if (!controller || !sessionId) return;
  let readingAnchor = options.readingAnchor;
  if (readingAnchor && readingAnchor.sequence === undefined) {
    const { turnId } = readingAnchor;
    try {
      const sequence = controller.store.range().sessionId === sessionId
        ? controller.store.sequenceForTurn(turnId)
        : null;
      if (sequence !== null) {
        readingAnchor = { turnId, sequence };
        options.setReadingAnchor(sessionId, readingAnchor);
      }
    } catch {
      // A stale range cannot enrich the anchor, but also cannot invalidate it.
    }
  }
  const searchTarget = options.searchTarget?.sessionId === sessionId
    ? options.searchTarget
    : undefined;
  const target = searchTarget ?? readingAnchor;
  if (!target || (searchTarget && target.sequence === undefined)) return;
  const restoringReadingAnchor = searchTarget === undefined && readingAnchor !== undefined;
  let disposed = false;
  const current = (): boolean => !disposed && options.isCurrent(sessionId, controller);
  void controller.ready()
    .then(async () => {
      if (!current() || controller.store.range().sessionId !== sessionId) {
        return { loaded: false, unavailable: false };
      }
      const residentSequence = controller.store.sequenceForTurn(target.turnId);
      if (residentSequence !== null) {
        if (restoringReadingAnchor && readingAnchor?.sequence === undefined) {
          options.setReadingAnchor(sessionId, { turnId: target.turnId, sequence: residentSequence });
        }
        return { loaded: false, unavailable: false };
      }
      if (target.sequence === undefined) {
        return { loaded: false, unavailable: restoringReadingAnchor };
      }
      await controller.loadAround(target.sequence);
      if (!current() || controller.store.range().sessionId !== sessionId) {
        return { loaded: false, unavailable: false };
      }
      return {
        loaded: true,
        unavailable: restoringReadingAnchor
          && controller.store.sequenceForTurn(target.turnId) === null,
      };
    })
    .then(({ loaded, unavailable }) => {
      if (!current()) return;
      if (loaded) options.setMessages([...controller.store.snapshot().messages]);
      if (unavailable) {
        options.setReadingAnchor(sessionId, undefined);
        options.onRestoreUnavailable?.(sessionId, target.turnId);
      }
    })
    .catch((error) => {
      if (current()) options.onError(error, sessionId);
    });
  return () => {
    disposed = true;
  };
}

export function captureTranscriptReadingAnchor<Message>(options: {
  readonly sessionId?: string;
  readonly currentSessionId?: string;
  readonly turnId?: string;
  readonly controller?: TranscriptRangeController<Message>;
  readonly setAnchor: (sessionId: string, anchor: TranscriptReadingAnchor | undefined) => void;
}): void {
  const { sessionId, turnId } = options;
  if (!sessionId || options.currentSessionId !== sessionId) return;
  if (!turnId) {
    options.setAnchor(sessionId, undefined);
    return;
  }
  try {
    if (options.controller?.store.range().sessionId !== sessionId) return;
    const sequence = options.controller.store.sequenceForTurn(turnId) ?? undefined;
    options.setAnchor(sessionId, sequence === undefined ? { turnId } : { turnId, sequence });
  } catch {
    // A stale range says nothing new about the reader's current intent.
  }
}
