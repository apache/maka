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

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useToast, useUiLocale, reconcileInteractions } from '@maka/ui';
import type { ContextCompactionOutcome } from '@maka/core/events';
import { useExternalStoreSelector } from '../../../application/contracts/session-catalog/use-external-store-selector.js';
import { selectActiveSessionId, selectSessionById, useSessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import { transcriptErrorMessage } from '../../../application/contracts/transcript-copy.js';
import { useStableActions } from '../../../application/contracts/use-stable-actions.js';
import { createAppShellSessionEventHandlers, createAppShellSessionDisplayBatch } from '../model/session-events.js';
import { useShellRunUpdates, useSessionEventHealthPolling } from '../controller/use-conversation-recovery.js';
import { useSessionUiRead } from '../controller/use-session-ui-read.js';
import { activeHostTurn } from '../../../application/contracts/session-execution.js';
import { shellSessionRowEqual } from '../model/conversation-catalog-row.js';
import { useConversationServices } from '../services.js';
import { useConversationObservation } from '../controller/use-conversation-observation.js';
import { TranscriptReadingPositionController } from '../controller/transcript-reading-position-controller.js';
import { LiveTurnReconciler } from '../controller/live-turn-reconciler.js';
import { useConversationOwner } from './conversation-context.js';
import { INITIAL_LIVE_CONTENT_SEED, beginLiveContentSeed, ownsLiveContentSeed, revealLiveContentSeed } from '../model/observation-visibility.js';
import { INITIAL_OBSERVATION_AUTHORITY, reconcileObservationAuthority } from '../model/observation-visibility.js';

export function ConversationLifecycle(props: {
  refreshSessions(): Promise<unknown>;
  onExecutionBoundaryChanged(sessionId: string): void;
  onContextCompactionOutcome(sessionId: string, turnId: string, outcome: ContextCompactionOutcome): void;
  showModelSetupToast(description: string, reason?: string, diagnosticTarget?: { sessionId: string }): void;
  onTurnCompleted(sessionId: string): void;
  searchTarget: { sessionId: string; turnId: string; nonce?: number } | null;
  clearSearchTarget(): void;
  listTurnLandmarks: React.ComponentProps<typeof TranscriptReadingPositionController>['listTurnLandmarks'];
}) {
  const { workspace, commands, readingCommands, events, interactionHydration } = useConversationOwner();
  const { ui, activeIdRef, transcriptRangeRef } = workspace;
  const view = useSyncExternalStore(workspace.publication.subscribe, workspace.publication.getSnapshot);
  const catalog = useSessionCatalogController();
  const requestedId = useExternalStoreSelector(catalog, selectActiveSessionId);
  const requested = useExternalStoreSelector(catalog, selectSessionById, requestedId, shellSessionRowEqual);
  const displayed = useExternalStoreSelector(catalog, selectSessionById, view.sessionId, shellSessionRowEqual);
  const authority = useRef(INITIAL_OBSERVATION_AUTHORITY);
  authority.current = reconcileObservationAuthority(authority.current, { sessionId: requestedId, profileId: requested?.profileId });
  const seed = useRef(INITIAL_LIVE_CONTENT_SEED);
  const uiLocale = useUiLocale();
  const toastApi = useToast();
  const services = useConversationServices();
  const hostSession = displayed?.localState !== 'pending' ? displayed : undefined;
  const ownerId = displayed?.shared ? undefined : hostSession?.id;
  const interaction = useSessionUiRead(ui.reads, 'interaction', ownerId);
  const summary = useSessionUiRead(ui.reads, 'summary', view.sessionId);
  const turn = activeHostTurn(summary.activeExecution);
  const live = turn?.turnId === summary.activeLiveTurnSnapshot.turnId ? summary.activeLiveTurnSnapshot : undefined;
  useEffect(() => {
    if (!ownerId) return;
    const pending = { sessionId: ownerId };
    interactionHydration.current = pending;
    const release = () => { if (interactionHydration.current === pending) interactionHydration.current = null; };
    void services.observation.listActiveInteractions(ownerId).then((requests) => {
      if (interactionHydration.current !== pending) return;
      ui.setInteractionBySession((current) => reconcileInteractions(current, ownerId, requests));
    }).catch(() => {}).finally(release);
    return release;
  }, [ownerId, services.observation, ui, interactionHydration]);
  useEffect(() => services.observation.subscribeActiveInteractions(({ sessionId, interactions }) => {
    commands.markInteractionChanged(sessionId);
    ui.setInteractionBySession((current) => reconcileInteractions(current, sessionId, interactions));
  }), [services.observation, ui, commands]);
  useShellRunUpdates({ services: services.observation, activeId: ownerId, setShellRunUpdatesBySession: ui.setShellRunUpdatesBySession });
  useSessionEventHealthPolling({
    services: services.observation, activeId: hostSession?.id, activeSession: hostSession,
    activeInteraction: interaction,
    activeStreamingLive: Boolean(live?.hasStreamingText && live.streamingMessageId === undefined),
    hasInFlightLiveTools: live?.hasInFlightTools ?? false,
    refreshMessages: commands.refreshMessages, refreshSessions: props.refreshSessions,
    sessionEventHealthBySessionRef: ui.sessionEventHealthBySessionRef,
    setSessionEventHealthBySession: ui.setSessionEventHealthBySession,
  });
  const [displayBatch] = useState(createAppShellSessionDisplayBatch);
  const handlers = useStableActions(createAppShellSessionEventHandlers, {
    ...props, uiLocale, toastApi, activeIdRef, displayBatch,
    onInteractionChanged: commands.markInteractionChanged,
    liveTurnBySessionRef: ui.liveTurnBySessionRef,
    refreshMessages: commands.refreshMessages,
    setLiveTurnBySession: ui.setLiveTurnBySession,
    setInteractionBySession: ui.setInteractionBySession,
    setMessageQueueBySession: ui.setMessageQueueBySession,
    removeTransientMessage: commands.removeTransientMessage,
  });
  useLayoutEffect(() => {
    events.current = handlers;
    return () => { events.current = null; };
  }, [events, handlers]);
  useConversationObservation({
    services: services.observation, uiLocale, toastApi,
    activeId: requested?.localState !== 'pending' ? requested?.id : undefined,
    observationAuthorityRevision: authority.current.generation,
    activeIdRef, transcriptRangeRef,
    handleEvent: handlers.handleEvent,
    publishTranscript: workspace.publishTranscript,
    commitTranscript: workspace.commitTranscript,
    setMessageLoadPending: workspace.setLoading,
    setExecution: ui.setExecution,
    setMessageLoadErrorBySession: ui.setMessageLoadErrorBySession,
    clearMessageLoadError: ui.clearMessageLoadError,
    setSessionEventHealthBySession: ui.setSessionEventHealthBySession,
    endObservation: handlers.discardDisplayEvents,
    beginObservationSeed(sessionId) {
      const begun = beginLiveContentSeed(seed.current, sessionId);
      seed.current = begun.state;
      handlers.holdDisplayEvents(sessionId);
      workspace.revealSeed(seed.current);
      return () => {
        if (!ownsLiveContentSeed(seed.current, begun.token)) return;
        handlers.releaseDisplayEvents(sessionId);
        seed.current = revealLiveContentSeed(seed.current, begun.token);
        workspace.revealSeed(seed.current);
        void workspace.retireCancelledTransientMessages(sessionId);
      };
    },
  });
  useEffect(() => {
    const sessionId = view.sessionId;
    const messageId = live?.streamingMessageId;
    if (!sessionId || !messageId || !view.messages.some((message) => message.type === 'assistant' && message.id === messageId)) return;
    const timer = globalThis.setTimeout(() => { void handlers.settleAssistantStreaming(sessionId, messageId); }, 1000);
    return () => globalThis.clearTimeout(timer);
  }, [view.sessionId, view.messages, live?.streamingMessageId, handlers.settleAssistantStreaming]);
  return <>
    <TranscriptReadingPositionController
      commands={readingCommands} sessionId={view.sessionId} profileId={displayed?.profileId}
      currentSessionId={activeIdRef} rangeController={transcriptRangeRef} messages={view.messages}
      searchTarget={props.searchTarget} clearSearchTarget={props.clearSearchTarget} sessionUi={ui}
      landmarkSessionId={displayed?.shared || displayed?.localState === 'pending' ? null : displayed?.id ?? null}
      listTurnLandmarks={props.listTurnLandmarks} setTurnIndex={workspace.setTurnIndex}
      onRestoreError={(error, sessionId) => ui.setMessageLoadErrorBySession((current) => ({ ...current, [sessionId]: transcriptErrorMessage(error, uiLocale, 'restore') }))}
    />
    <LiveTurnReconciler readLiveTurns={ui.reads.liveTurns} activeId={view.sessionId} messages={view.messages} reconcile={handlers.reconcilePersistedMessages} />
  </>;
}
