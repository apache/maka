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

import { useSyncExternalStore } from 'react';
import { selectActiveSessionId, selectSessionById, useSessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import { useExternalStoreSelector } from '../../../application/contracts/session-catalog/use-external-store-selector.js';
import { shellSessionRowEqual } from '../model/conversation-catalog-row.js';
import { useConversationOwner } from '../ui/conversation-context.js';
import { useConversationQueueCommands } from '../ui/conversation-provider.js';

/** Shell gets target identity and finite chrome facts, never a transcript projection. */
export function useConversationTarget() {
  const { workspace, commands } = useConversationOwner();
  const catalog = useSessionCatalogController();
  const activeId = useSyncExternalStore(workspace.target.subscribe, workspace.target.getSnapshot);
  const chrome = useSyncExternalStore(workspace.chrome.subscribe, workspace.chrome.getSnapshot);
  const requestedSessionId = useExternalStoreSelector(catalog, selectActiveSessionId);
  const activeCatalogSession = useExternalStoreSelector(catalog, selectSessionById, activeId, shellSessionRowEqual);
  const activeHostSession = activeCatalogSession?.localState !== 'pending' ? activeCatalogSession : undefined;
  const sharedSessionActive = activeCatalogSession?.shared === true;
  return {
    setActiveId: commands.setActiveId,
    startNewSession: commands.startNewSession,
    clearOwnedSessionState: commands.clearOwnedSessionState,
    captureSelection: commands.captureSelection,
    isSessionSelected: commands.isSessionSelected,
    retiredSessionIds: commands.retiredSessionIds,
    readSelectionRevision: commands.readSelectionRevision,
    addTransientMessage: commands.addTransientMessage,
    updateTransientMessage: commands.updateTransientMessage,
    removeTransientMessage: commands.removeTransientMessage,
    readMessages: commands.readMessages,
    refreshMessages: commands.refreshMessages,
    prepareSend: commands.prepareSend,
    clearMessageLoadError: commands.clearMessageLoadError,
    markInteractionChanged: commands.markInteractionChanged,
    settleInteraction: commands.settleInteraction,
    recordSessionChange: commands.recordSessionChange,
    compactSession: commands.compactSession,
    activeId,
    activeIdRef: workspace.publishedSession,
    bootstrapSelectionLease: workspace.bootstrapSelectionLease,
    activeCatalogSession, activeHostSession, sharedSessionActive,
    ownerActiveId: sharedSessionActive ? undefined : activeHostSession?.id,
    switchingSession: activeId !== requestedSessionId,
    transcriptEmpty: chrome.empty,
    transcriptHasHistory: chrome.hasHistory,
    queueSurface: useConversationQueueCommands(),
    sessionUiReads: workspace.ui.reads,
    stopPendingClaims: workspace.ui.stopPending,
  };
}
