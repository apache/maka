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
  readonly sessionId: string;
  range(): { readonly sessionId: string; readonly hasNewer?: boolean };
  sequenceForTurn(turnId: string): number | null;
  newestDurableUserSequence(): number | null;
  snapshot(): { readonly messages: readonly Message[] };
}

interface TranscriptRangeController<Message> {
  readonly store: TranscriptRangeStore<Message>;
  loadAround(sequence: number): Promise<void>;
  setReadingAnchor(sequence: number | null, readingTurnId?: string): Promise<void>;
}

interface SearchTarget {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence?: number;
  readonly nonce?: number;
}

interface TranscriptRestoreCommand {
  target: TranscriptReadingAnchor;
  readonly fromSearch: boolean;
  completed: boolean;
  controller?: object;
  attempt?: object;
}

/** A bookmark survives navigation; a command to restore it does not. */
export function createTranscriptRestoreLifecycle() {
  let activation: {
    sessionId?: string;
    profileId?: string;
    searchKey?: string;
    command?: TranscriptRestoreCommand;
  } | undefined;
  return {
    request(input: {
      sessionId?: string;
      profileId?: string;
      searchTarget?: SearchTarget | null;
      readingAnchor?: TranscriptReadingAnchor;
    }): TranscriptRestoreCommand | undefined {
      const search = input.searchTarget?.sessionId === input.sessionId
        ? input.searchTarget
        : undefined;
      const searchKey = search ? `${search.turnId}:${search.nonce ?? 0}` : undefined;
      const switched = !activation
        || activation.sessionId !== input.sessionId
        || activation.profileId !== input.profileId;
      if (switched || activation?.searchKey !== searchKey) {
        // Clearing a search in the same activation must not restart the old
        // bookmark. Only entering a Session captures a bookmark to restore.
        const target = search ?? (switched ? input.readingAnchor : undefined);
        activation = {
          sessionId: input.sessionId,
          profileId: input.profileId,
          searchKey,
          command: input.sessionId && target
            ? { target: { turnId: target.turnId, sequence: target.sequence }, fromSearch: Boolean(search), completed: false }
            : undefined,
        };
      }
      const command = activation?.command;
      if (!command || command.completed) return;
      if (command.target.sequence === undefined) {
        const target = search ?? input.readingAnchor;
        if (target?.turnId === command.target.turnId && target.sequence !== undefined) {
          command.target = { ...command.target, sequence: target.sequence };
        }
      }
      return command;
    },
    isCurrent(command: TranscriptRestoreCommand): boolean {
      return activation?.command === command && !command.completed;
    },
    cancel(sessionId?: string): void {
      if (activation && (sessionId === undefined || activation.sessionId === sessionId)) {
        activation.command = undefined;
      }
    },
    deactivate(): void {
      // Effect teardown ends the activation, including StrictMode's setup
      // replay. Explicit navigation cancellation instead keeps it consumed.
      activation = undefined;
    },
  };
}

export type TranscriptRestoreLifecycle = ReturnType<typeof createTranscriptRestoreLifecycle>;

export async function prepareTranscriptForSend<Message>(options: {
  sessionId: string;
  currentSessionId: { current: string | undefined };
  controller: { current: (TranscriptRangeController<Message> & { loadLatest(): Promise<void> }) | undefined };
  cancel(sessionId: string, clearAnchor: boolean): void;
  followLatest(sessionId: string): void;
}): Promise<boolean> {
  const { sessionId } = options;
  if (options.currentSessionId.current !== sessionId) return false;
  options.cancel(sessionId, true);
  const controller = options.controller.current;
  options.followLatest(sessionId);
  if (!controller || controller.store.sessionId !== sessionId) return true;
  // Invalidate pending history immediately, but keep local Message admission
  // independent of an unopened, slow or offline transcript. The explicit pin
  // happens once; a late page must not reclaim the viewport from the reader.
  void (async () => {
    try {
      await controller.loadLatest();
    } catch {
      // Catch-up failure must not prevent the Message from being saved locally.
    }
  })();
  return true;
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

export interface TranscriptHistoryRequest {
  readonly target: 'earlier' | 'later' | 'latest';
  readonly anchorTurnId?: string;
}

export interface TranscriptHistoryPending {
  readonly sessionId: string;
  readonly target: TranscriptHistoryRequest['target'];
}

export interface TranscriptHistoryGate {
  pending: boolean;
  active?: TranscriptHistoryRequest;
  queued?: TranscriptHistoryRequest;
}

function updateTranscriptHistoryPending(
  current: TranscriptHistoryPending | undefined,
  sessionId: string,
  request: TranscriptHistoryRequest | undefined,
): TranscriptHistoryPending | undefined {
  if (request) return { sessionId, target: request.target };
  return current?.sessionId === sessionId ? undefined : current;
}

/** One gate per controller: the shell rebuilds the controller per Session, so
 *  keying by it keeps Sessions from queuing behind each other's loads. */
export type TranscriptHistoryGates = WeakMap<object, TranscriptHistoryGate>;

export async function loadTranscriptHistory(options: {
  readonly gates: TranscriptHistoryGates;
  readonly sessionId: string;
  readonly request: TranscriptHistoryRequest;
  readonly controller: {
    loadBefore(maxBytes: number, anchorTurnId?: string): Promise<void>;
    loadAfter(maxBytes: number, anchorTurnId?: string): Promise<void>;
    loadLatest(): Promise<void>;
  };
  readonly maxBytes: number;
  readonly isCurrent: () => boolean;
  readonly setPending: (
    update: (
      current: TranscriptHistoryPending | undefined,
    ) => TranscriptHistoryPending | undefined,
  ) => void;
  readonly onError: (error: unknown) => void;
}): Promise<void> {
  const { gates, controller, request } = options;
  let gate = gates.get(controller) ?? { pending: false };
  gates.set(controller, gate);
  if (gate.pending) {
    // The scroller asks on every reader movement; dropping the request behind
    // an in-flight load strands the reader until they move again.
    if (request.target === 'latest' || gate.queued?.target !== 'latest') gate.queued = request;
    return;
  }
  gate.pending = true;
  gate.active = request;
  options.setPending((current) =>
    updateTranscriptHistoryPending(current, options.sessionId, request));
  try {
    if (request.target === 'latest') await controller.loadLatest();
    else await controller[request.target === 'earlier' ? 'loadBefore' : 'loadAfter'](
      options.maxBytes, request.anchorTurnId,
    );
  } catch (error) {
    if (options.isCurrent()) options.onError(error);
  } finally {
    gate.pending = false;
    gate.active = undefined;
    // A send, search or explicit return to latest may replace this gate while
    // its page is in flight. Its cleanup cannot clear the replacement's state
    // or replay an older queued direction after the new navigation.
    if (gates.get(controller) === gate && options.isCurrent()) {
      options.setPending((current) =>
        updateTranscriptHistoryPending(current, options.sessionId, undefined));
      const queued = gate.queued;
      gate.queued = undefined;
      if (queued) void loadTranscriptHistory({ ...options, request: queued });
    }
  }
}

export function restoreSessionTranscriptRange<Message>(options: {
  readonly lifecycle: TranscriptRestoreLifecycle;
  readonly sessionId?: string;
  readonly profileId?: string;
  readonly searchTarget?: SearchTarget | null;
  readonly readingAnchor?: TranscriptReadingAnchor;
  readonly controller?: TranscriptRangeController<Message>;
  readonly isCurrent: (sessionId: string, controller: TranscriptRangeController<Message>) => boolean;
  readonly isLiveTurn?: (sessionId: string, turnId: string) => boolean;
  readonly setReadingAnchor: (
    sessionId: string,
    anchor: TranscriptReadingAnchor | undefined,
  ) => void;
  readonly onRestoreUnavailable?: (sessionId: string, turnId: string) => void;
  readonly onError: (error: unknown, sessionId: string) => void;
}): void {
  const { controller, sessionId } = options;
  const command = options.lifecycle.request(options);
  if (!command || !controller || !sessionId || !options.isCurrent(sessionId, controller)) return;
  if (command.controller === controller && command.attempt) return;
  if (!command.fromSearch && command.target.sequence === undefined) {
    const { turnId } = command.target;
    try {
      const sequence = controller.store.range().sessionId === sessionId
        ? controller.store.sequenceForTurn(turnId)
        : null;
      if (sequence !== null) {
        command.target = { turnId, sequence };
        options.setReadingAnchor(sessionId, command.target);
      }
    } catch {
      // A stale range cannot enrich the anchor, but also cannot invalidate it.
    }
  }
  const target = command.target;
  if (command.fromSearch && target.sequence === undefined) return;
  const restoringReadingAnchor = !command.fromSearch;
  const attempt = {};
  command.controller = controller;
  command.attempt = attempt;
  const current = (): boolean => options.lifecycle.isCurrent(command)
    && command.attempt === attempt && options.isCurrent(sessionId, controller);
  if (!current()) {
    command.attempt = undefined;
    return;
  }
  let admitted: Promise<void>;
  try {
    const residentSequence = currentTranscriptRange(controller, sessionId)
      ? controller.store.sequenceForTurn(target.turnId)
      : null;
    const sequence = residentSequence ?? target.sequence;
    // Admit intent before awaiting the open handle. Resident and live-only
    // targets retain their range while invalidating older navigation requests.
    admitted = residentSequence !== null || sequence === undefined
      ? controller.setReadingAnchor(sequence ?? null, target.turnId)
      : controller.loadAround(sequence);
  } catch (error) {
    admitted = Promise.reject(error);
  }
  void admitted
    .then(() => {
      if (!current() || controller.store.range().sessionId !== sessionId) return false;
      const residentSequence = controller.store.sequenceForTurn(target.turnId);
      if (residentSequence !== null) {
        if (restoringReadingAnchor && target.sequence === undefined) {
          options.setReadingAnchor(sessionId, { turnId: target.turnId, sequence: residentSequence });
        }
        return false;
      }
      if (options.isLiveTurn?.(sessionId, target.turnId) || controller.store.snapshot().messages.some((message) =>
        message !== null && typeof message === 'object' &&
        'turnId' in message && message.turnId === target.turnId,
      )) {
        // Active Turns are overlay-only in the RuntimeEvent projection. Their
        // bookmark is already visible even though no durable sequence exists.
        return false;
      }
      return restoringReadingAnchor;
    })
    .then((unavailable) => {
      if (!current()) return;
      command.completed = true;
      if (unavailable) {
        options.setReadingAnchor(sessionId, undefined);
        options.onRestoreUnavailable?.(sessionId, target.turnId);
      }
    })
    .catch((error) => {
      if (current()) options.onError(error, sessionId);
    })
    .finally(() => {
      if (command.attempt === attempt) command.attempt = undefined;
    });
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
