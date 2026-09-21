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

interface TranscriptRangeController<Message> {
  readonly store: {
    range(): {
      readonly sessionId: string;
      readonly hasOlder: boolean;
      readonly ready: boolean;
      readonly generation?: string;
    };
    snapshot(): { readonly messages: readonly Message[] };
  };
  loadEarlier(throughSequence?: number): Promise<void>;
}

interface SearchTarget {
  readonly sessionId: string;
  readonly turnId: string;
  readonly nonce?: number;
}

interface TranscriptRestoreCommand {
  readonly target: TranscriptReadingAnchor;
  readonly fromSearch: boolean;
  completed: boolean;
  loading?: object;
  loaded?: boolean;
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
            ? { target: { turnId: target.turnId }, fromSearch: Boolean(search), completed: false }
            : undefined,
        };
      }
      const command = activation?.command;
      return command && !command.completed ? command : undefined;
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

export function prepareTranscriptForSend(options: {
  sessionId: string;
  currentSessionId: { current: string | undefined };
  cancel(sessionId: string, clearAnchor: boolean): void;
  followLatest(sessionId: string): void;
}): boolean {
  const { sessionId } = options;
  if (options.currentSessionId.current !== sessionId) return false;
  options.cancel(sessionId, true);
  options.followLatest(sessionId);
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

/**
 * Finds the target Turn in the loaded transcript. A Turn outside it is located
 * through the Host Turn index and read down to in one request; a Turn the index
 * does not know, or a Session without index access, is unavailable.
 */
export function restoreSessionTranscriptRange<Message>(options: {
  readonly lifecycle: TranscriptRestoreLifecycle;
  readonly sessionId?: string;
  readonly profileId?: string;
  readonly searchTarget?: SearchTarget | null;
  readonly readingAnchor?: TranscriptReadingAnchor;
  readonly controller?: TranscriptRangeController<Message>;
  readonly isCurrent: (sessionId: string, controller: TranscriptRangeController<Message>) => boolean;
  /** Where the Turn starts; `undefined` when the index does not know it. */
  readonly lookupTurn?: (sessionId: string, turnId: string) => Promise<number | undefined>;
  readonly setReadingAnchor: (
    sessionId: string,
    anchor: TranscriptReadingAnchor | undefined,
  ) => void;
  readonly onRestoreUnavailable?: (sessionId: string, turnId: string) => void;
  readonly onError: (error: unknown, sessionId: string) => void;
}): void {
  const { controller, sessionId } = options;
  const command = options.lifecycle.request(options);
  if (!command || command.loading || !controller || !sessionId || !options.isCurrent(sessionId, controller)) return;
  const range = currentTranscriptRange(controller, sessionId);
  // A cached range is replaced wholesale by the live answer; only that answer
  // can say whether the target Turn is reachable.
  if (!range?.ready || range.generation?.startsWith('cached:')) return;
  const { turnId } = command.target;
  if (controller.store.snapshot().messages.some((message) =>
    message !== null && typeof message === 'object' && 'turnId' in message && message.turnId === turnId,
  )) {
    command.completed = true;
    return;
  }
  const { lookupTurn } = options;
  if (range.hasOlder && !command.loaded && lookupTurn) {
    const loading = {};
    command.loading = loading;
    const current = () => options.lifecycle.isCurrent(command) && options.isCurrent(sessionId, controller);
    const settle = () => {
      if (command.loading !== loading) return false;
      command.loading = undefined;
      return current();
    };
    void lookupTurn(sessionId, turnId)
      .then((sequence) => {
        if (sequence === undefined || !current()) return;
        return controller.loadEarlier(sequence);
      })
      .then(
        () => {
          // A range that reopened meanwhile dropped the answer, so it says
          // nothing about whether the Turn can be reached.
          if (currentTranscriptRange(controller, sessionId)?.generation === range.generation) {
            command.loaded = true;
          }
          if (settle()) restoreSessionTranscriptRange(options);
        },
        (error: unknown) => {
          if (settle()) options.onError(error, sessionId);
        },
      );
    return;
  }
  command.completed = true;
  if (!command.fromSearch) {
    options.setReadingAnchor(sessionId, undefined);
    options.onRestoreUnavailable?.(sessionId, turnId);
  }
}
