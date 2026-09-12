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

import type { AppShellSessionUiState } from './session-ui-state.js';
import { deriveLiveTurnSnapshot, liveTurnSnapshotsEqual, selectStreamingSessionIds, sessionIdSetsEqual } from './live-turn-snapshot.js';

const selectMessageLoadState = (state: AppShellSessionUiState) => ({
  messageLoadErrorBySession: state.messageLoadErrorBySession,
  transcriptRestoreUnavailableBySession: state.transcriptRestoreUnavailableBySession,
});
const messageLoadStateEqual = (
  left: ReturnType<typeof selectMessageLoadState>,
  right: ReturnType<typeof selectMessageLoadState>,
) => left.messageLoadErrorBySession === right.messageLoadErrorBySession
  && left.transcriptRestoreUnavailableBySession === right.transcriptRestoreUnavailableBySession;
const selectMessageRetryPending = (state: AppShellSessionUiState) => state.messageRetryPendingBySession;
const selectStopPending = (state: AppShellSessionUiState) => state.stopPendingBySession;
const selectInteraction = (state: AppShellSessionUiState) => state.interactionBySession;
const selectMessageQueue = (state: AppShellSessionUiState) => state.messageQueueBySession;
const selectExecution = (state: AppShellSessionUiState, id: string | undefined) => id ? state.executionBySession[id] : undefined;
const selectPulseSet = (state: AppShellSessionUiState) => selectStreamingSessionIds(state.liveTurnBySession, state.executionBySession);

/**
 * Select the execution root's content for the low-frequency Shell summary.
 * Content handoff subscribes to selectLiveTurns so older buffered turns remain visible to it.
 */
const selectLiveTurn = (state: AppShellSessionUiState, sessionId: string | undefined) =>
  sessionId ? state.liveTurnBySession[sessionId]?.find((turn) => turn.turnId === state.executionBySession[sessionId]?.rootTurn?.turnId)
    ?? state.liveTurnBySession[sessionId]?.at(-1) : undefined;

export const selectLiveTurns = (state: AppShellSessionUiState, sessionId: string | undefined) =>
  sessionId ? state.liveTurnBySession[sessionId] : undefined;

const selectActiveSnapshot = (state: AppShellSessionUiState, sessionId: string | undefined) =>
  deriveLiveTurnSnapshot(selectLiveTurn(state, sessionId));

export const sessionUiSelectors = {
  messageLoad: selectMessageLoadState, messageLoadEqual: messageLoadStateEqual,
  retry: selectMessageRetryPending, stop: selectStopPending, interaction: selectInteraction,
  queue: selectMessageQueue, pulse: selectPulseSet, pulseEqual: sessionIdSetsEqual,
  active: (state: AppShellSessionUiState, id: string | undefined) => ({
    activeExecution: selectExecution(state, id), activeLiveTurnSnapshot: selectActiveSnapshot(state, id),
  }),
  activeEqual: (a: { activeExecution: unknown; activeLiveTurnSnapshot: import('./live-turn-snapshot.js').LiveTurnSnapshot }, b: typeof a) =>
    a.activeExecution === b.activeExecution && liveTurnSnapshotsEqual(a.activeLiveTurnSnapshot, b.activeLiveTurnSnapshot),
};
