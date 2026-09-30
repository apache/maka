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

import { INITIAL_LIVE_CONTENT_SEED, visibleLiveContentGeneration, type LiveContentSeedState } from './observation-visibility.js';
import { currentTranscriptRange } from '../controller/transcript-reading-position.js';
import { selectLatestRequestUsage } from '../../../application/contracts/session-inspector/latest-request-usage.js';
import type { StoredMessage } from '@maka/core/session';
import type { TransientUserMessageProjection } from '@maka/ui';
import type { SessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import type { SnapshotReader } from '../../../application/contracts/snapshot-reader.js';
import { createBootstrapSelectionLease } from '../../../application/contracts/bootstrap-selection-lease.js';
import { hasNewTaskReloadIntent } from '../../../application/contracts/new-task-reload-intent.js';
import { createSessionWorkspaceActions } from './session-workspace-actions.js';
import { createAppShellSessionUiStateController } from './session-ui-state.js';
import type { ConversationObservationServices, ConversationTranscriptController } from '../transcript-ports.js';

export interface ConversationPublication {
  readonly sessionId: string | undefined;
  readonly messages: StoredMessage[];
  readonly transientMessages: TransientUserMessageProjection[];
  readonly range: ReturnType<ConversationTranscriptController['store']['range']> | undefined;
  readonly loading: boolean;
  readonly seedGeneration: number;
  readonly turnIndex?: import('../controller/transcript-reading-position-controller.js').TranscriptTurnIndex;
}

/** One publication authority. Fixed projections notify only their actual readers. */
export function createConversationWorkspace(catalog: SessionCatalogController, services: ConversationObservationServices) {
  const ui = createAppShellSessionUiStateController();
  const activeIdRef = { current: undefined as string | undefined };
  const messagesRef = { current: [] as StoredMessage[] };
  const transcriptRangeRef = { current: undefined as ConversationTranscriptController | undefined };
  const transientMessagesBySessionRef = { current: new Map<string, Map<string, TransientUserMessageProjection>>() };
  const selectionRevisionRef = { current: 0 };
  let seed = INITIAL_LIVE_CONTENT_SEED;
  let state: ConversationPublication = {
    sessionId: undefined, messages: [], transientMessages: [], range: undefined, loading: false, seedGeneration: 0,
  };
  const projections = new Set<() => (() => void) | undefined>();
  let transactionDepth = 0;
  const publish = () => {
    if (transactionDepth) return;
    // Every cache is refreshed before any listener can read another projection.
    const notifications = [...projections].flatMap((refresh) => refresh() ?? []);
    notifications.forEach((notify) => notify());
  };
  const update = (patch: Partial<ConversationPublication>) => { state = { ...state, ...patch }; publish(); };
  const transaction = <Args extends unknown[], Result>(action: (...args: Args) => Result) => (...args: Args): Result => {
    transactionDepth += 1;
    try { return action(...args); } finally { transactionDepth -= 1; publish(); }
  };
  function reader<T>(select: (value: ConversationPublication) => T, equal: (a: T, b: T) => boolean = Object.is): SnapshotReader<T> {
    let snapshot = select(state);
    const listeners = new Set<() => void>();
    const refresh = () => {
      const next = select(state);
      if (equal(snapshot, next)) return;
      snapshot = next;
      return () => [...listeners].forEach((notify) => notify());
    };
    return {
      getSnapshot() { refresh(); return snapshot; },
      subscribe(listener) {
        const registration = () => listener();
        listeners.add(registration);
        projections.add(refresh);
        return () => { listeners.delete(registration); if (!listeners.size) projections.delete(refresh); };
      },
    };
  }
  const raw = createSessionWorkspaceActions({
    activeIdRef, messagesRef, transcriptRangeRef, transientMessagesBySessionRef, selectionRevisionRef,
    readRequestedSessionId: () => catalog.getState().activeSessionId,
    isReadableSession: (id) => catalog.getState().sessions.some((row) => row.id === id && row.localState !== 'pending'),
    setActiveIdState: catalog.setActiveSessionId,
    setMessagesState: (messages) => update({ sessionId: activeIdRef.current, messages, seedGeneration: visibleLiveContentGeneration(seed, activeIdRef.current),
      range: messages.length ? currentTranscriptRange(transcriptRangeRef.current, activeIdRef.current) : undefined }),
    setTransientMessagesState: (transientMessages) => {
      if (transientMessages.length === state.transientMessages.length &&
        transientMessages.every((message, index) => message === state.transientMessages[index])) return;
      update({ transientMessages });
    },
    setMessageLoadPending: (loading) => update({ loading }),
    clearSessionUiState: ui.clearSessionUiState,
    queryCancelledMessages: services.queryCancelledMessages,
  });
  const commands = {
    setActiveId: transaction(raw.setActiveId),
    startNewSession: transaction(raw.startNewSession),
    clearOwnedSessionState: transaction(raw.clearOwnedSessionState),
    captureSelection: raw.captureSelection,
    isSessionSelected: raw.isSessionSelected,
    retiredSessionIds: raw.retiredSessionIds,
    readSelectionRevision: raw.readSelectionRevision,
    addTransientMessage: transaction(raw.addTransientMessage),
    updateTransientMessage: transaction(raw.updateTransientMessage),
    removeTransientMessage: transaction(raw.removeTransientMessage),
    // Commands read on invocation; publication never flows through Shell render.
    readMessages: (): readonly StoredMessage[] => state.messages,
  };
  const bootstrapSelectionLease = createBootstrapSelectionLease({
    readActiveId: () => activeIdRef.current,
    readSelectionRevision: raw.readSelectionRevision,
    select: commands.setActiveId,
  });
  if (hasNewTaskReloadIntent()) bootstrapSelectionLease.release();
  return {
    ui, activeIdRef, transcriptRangeRef, bootstrapSelectionLease, commands,
    publishedSession: Object.freeze({ get current() { return activeIdRef.current; } }),
    messages: reader((value) => value.messages),
    usage: (model: string | undefined, connectionId: string | undefined) => reader((value) =>
      selectLatestRequestUsage(value.messages, model, { llmConnectionId: connectionId })),
    publication: reader((value) => value),
    target: reader((value) => value.sessionId),
    chrome: reader((value) => ({
      empty: value.messages.length === 0 && value.transientMessages.length === 0,
      hasHistory: value.messages.some((message) => message.type === 'user' || message.type === 'assistant'),
    }), (a, b) => a.empty === b.empty && a.hasHistory === b.hasHistory),
    composer: reader((value) => ({ sessionId: value.sessionId, transientMessages: value.transientMessages }),
      (a, b) => a.sessionId === b.sessionId && a.transientMessages === b.transientMessages),
    commitTranscript: transaction(raw.commitTranscript),
    retireCancelledTransientMessages: raw.retireCancelledTransientMessages,
    setLoading: (loading: boolean) => update({ loading }),
    setTurnIndex: (turnIndex: ConversationPublication['turnIndex']) => update({ turnIndex }),
    revealSeed: (next: LiveContentSeedState) => { seed = next; update({ seedGeneration: visibleLiveContentGeneration(seed, activeIdRef.current) }); },
    publishTranscript(sessionId: string, controller: ConversationTranscriptController, isCurrent: () => boolean, onReady: () => void) {
      if (!isCurrent()) return;
      const snapshot = controller.store.snapshot();
      if (!snapshot.ready) return;
      transaction(() => {
        if (raw.commitTranscript(sessionId, [...snapshot.messages], controller)) onReady();
      })();
    },
    isMessagePublished: (message: StoredMessage) => messagesRef.current.includes(message),
  };
}
export type ConversationWorkspace = ReturnType<typeof createConversationWorkspace>;
