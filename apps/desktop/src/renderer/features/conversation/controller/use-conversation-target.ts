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

import { useMemo, useSyncExternalStore } from 'react';
import { selectActiveSessionId, selectSessionById, useSessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import { useExternalStoreSelector } from '../../../application/contracts/session-catalog/use-external-store-selector.js';
import { shellSessionRowEqual } from '../model/conversation-catalog-row.js';
import { useConversationOwner } from '../ui/conversation-context.js';
import { useConversationQueueCommands } from '../ui/conversation-provider.js';

/**
 * The shell's slice of the queue surface: the plate's entry actions and named
 * Composer edits. The editor handle and draft restoration stay in the feature.
 */
function shellQueueSurface(queue: ReturnType<typeof useConversationQueueCommands>) {
  return {
    editing: queue.editing,
    promoteQueuedEntry: queue.promoteQueuedEntry,
    updateQueuedEntry: queue.updateQueuedEntry,
    deleteQueuedEntry: queue.deleteQueuedEntry,
    reorderQueuedEntries: queue.reorderQueuedEntries,
  };
}

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
  const queue = useConversationQueueCommands();
  const queueSurface = useMemo(() => shellQueueSurface(queue), [queue]);
  return {
    setActiveId: commands.setActiveId,
    startNewSession: commands.startNewSession,
    clearOwnedSessionState: commands.clearOwnedSessionState,
    isSessionSelected: commands.isSessionSelected,
    retiredSessionIds: commands.retiredSessionIds,
    renderPublishedConversation: commands.renderPublishedConversation,
    refreshMessages: commands.refreshMessages,
    recordSessionChange: commands.recordSessionChange,
    activeId,
    activeIdRef: workspace.publishedSession,
    bootstrapSelectionLease: workspace.bootstrapSelectionLease,
    activeCatalogSession, activeHostSession, sharedSessionActive,
    ownerActiveId: sharedSessionActive ? undefined : activeHostSession?.id,
    switchingSession: activeId !== requestedSessionId,
    transcriptEmpty: chrome.empty,
    transcriptHasHistory: chrome.hasHistory,
    queueSurface,
    sessionUiReads: workspace.ui.reads,
  };
}
