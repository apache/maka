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

import type { SnapshotReader } from '../../../application/contracts/snapshot-reader.js';
import type { AppShellSessionUiState } from './session-ui-state.js';
import {
  deriveLiveTurnSnapshot,
  liveTurnSnapshotsEqual,
  selectStreamingSessionIds,
  sessionIdSetsEqual,
} from './live-turn-snapshot.js';

/**
 * Fixed projections over the one UI state authority. No caller supplies a
 * selector or subscribes to the whole state. Unsubscribed readers retain no
 * registry entry, including readers created by an abandoned React render.
 */
export function createSessionUiReads(getState: () => AppShellSessionUiState) {
  const subscriptions = new Set<{ refresh(): boolean; notify(): void }>();

  function read<T>(
    select: (state: AppShellSessionUiState) => T,
    equal: (a: T, b: T) => boolean = Object.is,
  ): SnapshotReader<T> {
    let source = getState();
    let snapshot = select(source);
    let published = snapshot;
    const listeners = new Set<() => void>();
    const getSnapshot = () => {
      const next = getState();
      if (source !== next) {
        const selected = select(next);
        source = next;
        if (!equal(snapshot, selected)) snapshot = selected;
      }
      return snapshot;
    };
    const subscription = {
      refresh() {
        const next = getSnapshot();
        if (Object.is(published, next)) return false;
        published = next;
        return true;
      },
      notify() {
        for (const listener of [...listeners]) {
          if (listeners.has(listener)) listener();
        }
      },
    };
    return {
      getSnapshot,
      subscribe(listener) {
        // Separate registrations may use the same callback.
        const registered = () => listener();
        if (listeners.size === 0) {
          published = getSnapshot();
          subscriptions.add(subscription);
        }
        listeners.add(registered);
        return () => {
          listeners.delete(registered);
          if (listeners.size === 0) subscriptions.delete(subscription);
        };
      },
    };
  }

  const reads = {
    load: (sessionId: string | undefined) => read(
      (state) => ({
        messageLoadError: sessionId ? state.messageLoadErrorBySession[sessionId] : undefined,
        unavailableTranscriptRestore: sessionId ? state.transcriptRestoreUnavailableBySession[sessionId] : undefined,
      }),
      (a, b) => a.messageLoadError === b.messageLoadError
        && a.unavailableTranscriptRestore === b.unavailableTranscriptRestore,
    ),
    retry: (sessionId: string | undefined) => read(
      (state) => !!sessionId && state.messageRetryPendingBySession[sessionId] === true,
    ),
    stop: (sessionId: string | undefined) => read(
      (state) => !!sessionId && state.stopPendingBySession[sessionId] === true,
    ),
    interaction: (sessionId: string | undefined) => read(
      (state) => sessionId ? state.interactionBySession[sessionId]?.[0] : undefined,
    ),
    queue: (sessionId: string | undefined) => read(
      (state) => sessionId ? state.messageQueueBySession[sessionId] : undefined,
    ),
    summary: (sessionId: string | undefined) => read(
      (state) => {
        const activeExecution = sessionId ? state.executionBySession[sessionId] : undefined;
        const turns = sessionId ? state.liveTurnBySession[sessionId] : undefined;
        const turn = turns?.find((item) => item.turnId === activeExecution?.rootTurn?.turnId) ?? turns?.at(-1);
        return { activeExecution, activeLiveTurnSnapshot: deriveLiveTurnSnapshot(turn) };
      },
      (a, b) => a.activeExecution === b.activeExecution
        && liveTurnSnapshotsEqual(a.activeLiveTurnSnapshot, b.activeLiveTurnSnapshot),
    ),
    liveTurns: (sessionId: string | undefined) => read(
      (state) => sessionId ? state.liveTurnBySession[sessionId] : undefined,
    ),
    shellRuns: (sessionId: string | undefined) => read(
      (state) => sessionId ? state.shellRunUpdatesBySession[sessionId] : undefined,
    ),
    streaming: read<ReadonlySet<string>>(
      (state) => selectStreamingSessionIds(state.liveTurnBySession, state.executionBySession),
      sessionIdSetsEqual,
    ),
  };

  return {
    reads,
    publish() {
      // Refresh every active projection before any callback can read another
      // projection. getSnapshot always reads the current authority, including
      // when a listener synchronously causes a further update.
      const changed = [...subscriptions].filter((subscription) => subscription.refresh());
      for (const subscription of changed) {
        if (subscriptions.has(subscription)) subscription.notify();
      }
    },
  };
}

export type SessionUiReads = ReturnType<typeof createSessionUiReads>['reads'];
export type SessionUiReadKind = Exclude<keyof SessionUiReads, 'streaming'>;
