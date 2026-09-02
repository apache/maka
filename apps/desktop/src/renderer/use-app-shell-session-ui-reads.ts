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

import type { InteractionQueues } from '@maka/ui';
import type {
  AppShellSessionUiState,
  AppShellSessionUiStateController,
  MessageQueueUiState,
} from './app-shell-session-ui-state.js';
import {
  deriveLiveTurnSnapshot,
  liveTurnSnapshotsEqual,
  selectStreamingSessionIds,
  sessionIdSetsEqual,
  type LiveTurnSnapshot,
} from './live-turn-snapshot.js';
import { useExternalStoreSelector } from './use-external-store-selector.js';

const selectMessageLoadError = (state: AppShellSessionUiState) => state.messageLoadErrorBySession;
const selectMessageRetryPending = (state: AppShellSessionUiState) => state.messageRetryPendingBySession;
const selectStopPending = (state: AppShellSessionUiState) => state.stopPendingBySession;
const selectInteraction = (state: AppShellSessionUiState) => state.interactionBySession;
const selectMessageQueue = (state: AppShellSessionUiState) => state.messageQueueBySession;
const selectPulseSet = (state: AppShellSessionUiState) => selectStreamingSessionIds(state.liveTurnBySession);

/**
 * The active session's raw projection — the one selection that moves per token.
 * Lives here with the rest so its two subscribers (the chat surface and the
 * reconciler) share one definition instead of each keeping a copy.
 */
export const selectLiveTurn = (state: AppShellSessionUiState, sessionId: string | undefined) =>
  sessionId ? state.liveTurnBySession[sessionId] : undefined;

const selectActiveSnapshot = (state: AppShellSessionUiState, sessionId: string | undefined) =>
  deriveLiveTurnSnapshot(selectLiveTurn(state, sessionId));

/**
 * Everything AppShell reads from session UI state — the complete list, in one
 * place (#1985).
 *
 * Each low-frequency map is selected by the store's own reference, so it needs
 * no comparator; the active turn arrives as a `LiveTurnSnapshot` and the
 * sidebar's pulse set by value. A streamed token changes none of them, which is
 * what keeps the sidebar, the composer, and every non-chat surface off the
 * token path.
 *
 * `liveTurnBySession` and `shellRunUpdatesBySession` are deliberately absent in
 * raw form: they change per delta, and `ChatMessageSurface` — their only
 * renderer — subscribes to them itself. Adding either here puts the whole shell
 * back on the token path, and the render-boundary contract test drives this
 * hook directly so that it says so.
 */
export function useAppShellSessionUiReads(
  controller: AppShellSessionUiStateController,
  activeId: string | undefined,
): {
  messageLoadErrorBySession: Record<string, string>;
  messageRetryPendingBySession: Record<string, boolean>;
  stopPendingBySession: Record<string, boolean>;
  interactionBySession: InteractionQueues;
  messageQueueBySession: Record<string, MessageQueueUiState>;
  streamingSessionIds: Set<string>;
  activeLiveTurnSnapshot: LiveTurnSnapshot;
} {
  return {
    messageLoadErrorBySession: useExternalStoreSelector(controller, selectMessageLoadError),
    messageRetryPendingBySession: useExternalStoreSelector(controller, selectMessageRetryPending),
    stopPendingBySession: useExternalStoreSelector(controller, selectStopPending),
    interactionBySession: useExternalStoreSelector(controller, selectInteraction),
    messageQueueBySession: useExternalStoreSelector(controller, selectMessageQueue),
    streamingSessionIds: useExternalStoreSelector(controller, selectPulseSet, undefined, sessionIdSetsEqual),
    activeLiveTurnSnapshot: useExternalStoreSelector(
      controller,
      selectActiveSnapshot,
      activeId,
      liveTurnSnapshotsEqual,
    ),
  };
}
