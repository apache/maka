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

/**
 * Shared scaffolding for the `createAppShellChatActions` suites. The dependency
 * surface is wide and the suites only ever vary a handful of entries, so a
 * second copy of it drifts silently and has to be edited twice whenever the
 * actions gain a dependency.
 */

import type { LiveTurnProjection, TransientUserMessageProjection } from '@maka/ui';

/** Installs a `window.maka` bridge double; the returned function restores it. */
export function installWindow(maka: unknown): () => void {
  const target = globalThis as unknown as { window?: unknown };
  const hadWindow = Object.prototype.hasOwnProperty.call(target, 'window');
  const previousWindow = target.window;
  Object.defineProperty(target, 'window', {
    configurable: true,
    value: { maka },
    writable: true,
  });
  return () => {
    if (hadWindow) {
      Object.defineProperty(target, 'window', {
        configurable: true,
        value: previousWindow,
        writable: true,
      });
    } else {
      delete target.window;
    }
  };
}

/**
 * The live-turn arm as a real map rather than a black-hole stub: a send that
 * never lands must leave nothing behind, and that cannot be asserted against a
 * no-op setter.
 */
export function createTurnState() {
  const liveTurnBySession: Record<string, LiveTurnProjection> = {};
  return {
    liveTurnBySession,
    setLiveTurnBySession(
      updater: (c: Record<string, LiveTurnProjection>) => Record<string, LiveTurnProjection>,
    ) {
      const next = updater({ ...liveTurnBySession });
      for (const key of Object.keys(liveTurnBySession)) delete liveTurnBySession[key];
      Object.assign(liveTurnBySession, next);
    },
  };
}

/**
 * The transient arm as a real map. Transient rows are not `StoredMessage`s —
 * they have no Turn to belong to yet — so they are held apart from the
 * canonical transcript here, exactly as the shell holds them.
 */
export function createTransientState() {
  const rows = new Map<string, TransientUserMessageProjection>();
  return {
    rows,
    deps: {
      addTransientMessage: (_sessionId: string, message: TransientUserMessageProjection) => {
        rows.set(message.id, message);
      },
      updateTransientMessage: (_sessionId: string, message: TransientUserMessageProjection) => {
        rows.set(message.id, message);
      },
      removeTransientMessage: (_sessionId: string, messageId: string) => {
        rows.delete(messageId);
      },
    },
  };
}

export function createActionsDeps() {
  const activeIdRef = { current: undefined as string | undefined };
  return {
    uiLocale: 'en' as const,
    activeIdRef,
    captureComposerImportOwner: () => ({
      sessionId: undefined,
      navSection: 'sessions' as const,
    }),
    checkTaskSubmissionReadiness: async () => true,
    isNewChatSendSurfaceActive: () => true,
    isShellSurfaceOwnerActive: () => true,
    markSessionReadLocally: () => undefined,
    messageRetryPending: { claim: () => true, release: () => undefined },
    refreshSessions: async () => [],
    activateSessionForFirstSend: async (sessionId: string) => {
      activeIdRef.current = sessionId;
    },
    setActiveId: () => undefined,
    setMessageLoadErrorBySession: () => undefined,
    setMessages: () => undefined,
    addTransientMessage: () => undefined,
    updateTransientMessage: () => undefined,
    removeTransientMessage: () => undefined,
    transcriptRangeRef: { current: undefined },
    setLiveTurnBySession: () => undefined,
    setInteractionBySession: () => undefined,
    respondToUserForm: async () => undefined,
    showModelSetupToast: () => undefined,
    toastApi: { error: () => undefined, info: () => undefined },
    newChatModel: null,
    pendingNewChatThinkingLevel: null,
    newChatPermissionChoice: undefined,
    clearNewChatPermissionChoice: () => {},
    newChatCollaborationMode: 'agent' as const,
    newChatOrchestrationMode: 'default' as const,
    newTaskTarget: { profileId: 'local', hostId: 'host-local', projectId: null },
  };
}

export const EMPTY_SKILL_INVOCATION = { loaded: [], failed: [], receipts: [] };
