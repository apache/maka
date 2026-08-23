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

import type { StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopSessionSummary } from '../preload/bridge-contract.js';
import type { TurnFooterActionMeta } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import {
  isSessionWorkspaceUnavailableError,
  showSessionWorkspaceUnavailableToast,
} from './session-workspace-errors.js';
import { acquireSessionCopyAttempt } from './session-copy-attempt.js';

type RefBox<T> = { current: T };
type MessageListUpdater = (next: StoredMessage[] | ((current: StoredMessage[]) => StoredMessage[])) => void;

type ToastApi = {
  info(title: string, description?: string): void;
  success(title: string, description?: string): void;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string },
  ): void;
};

export interface AppShellTurnActions {
  handleTurnFooterAction(turnId: string, actionId: TurnFooterActionMeta['id']): Promise<void>;
}

export function createAppShellTurnActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  addPendingTurnAction: (key: string) => boolean;
  clearPendingTurnAction: (key: string) => void;
  openSessionInChat: (sessionId: string, turnId?: string) => void;
  pendingKeyOf: (sessionId: string, turnId: string, actionId: TurnFooterActionMeta['id']) => string;
  refreshMessages: (sessionId: string) => Promise<boolean>;
  refreshSessions: () => Promise<DesktopSessionSummary[]>;
  setMessages: MessageListUpdater;
  toastApi: ToastApi;
  upsertSessionSummary: (session: DesktopSessionSummary) => void;
}): AppShellTurnActions {
  const {
    uiLocale,
    activeIdRef,
    addPendingTurnAction,
    clearPendingTurnAction,
    openSessionInChat,
    pendingKeyOf,
    refreshMessages,
    refreshSessions,
    setMessages,
    toastApi,
    upsertSessionSummary,
  } = deps;
  const copy = getDesktopConversationCopy(uiLocale).actions;

  async function handleTurnFooterAction(turnId: string, actionId: TurnFooterActionMeta['id']): Promise<void> {
    if (actionId === 'copy') return; // handled in-component
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const key = pendingKeyOf(sessionId, turnId, actionId);
    // Ref-backed guard blocks same-frame double clicks before React has
    // committed the disabled state. State alone is too late here because
    // retry/regenerate IPC returns after starting the stream asynchronously.
    if (!addPendingTurnAction(key)) return;
    try {
      if (actionId === 'regenerate') {
        await window.maka.sessions.regenerateTurn(sessionId, {
          sourceTurnId: turnId,
        });
        if (activeIdRef.current === sessionId) {
          toastApi.info(copy.regenerateStartedTitle, copy.regenerateStartedDescription);
        }
      } else if (actionId === 'branch') {
        const copyAttempt = acquireSessionCopyAttempt(
          {
            scope: `turn-footer:${turnId}`,
            kind: 'branch',
            sourceSessionId: sessionId,
          },
          turnId,
        );
        const newSession = await window.maka.sessions.branchFromTurn(sessionId, {
          sourceTurnId: copyAttempt.sourceTurnId,
          copyId: copyAttempt.copyId,
        });
        copyAttempt.complete();
        upsertSessionSummary(newSession);
        if (activeIdRef.current === sessionId) {
          openSessionInChat(newSession.id);
          setMessages([]);
          await refreshMessages(newSession.id);
          toastApi.success(copy.branchCreatedTitle, copy.branchCreatedDescription(newSession.name));
        }
        await refreshSessions();
      }
    } catch (error) {
      if (activeIdRef.current !== sessionId) return;
      if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale, { sessionId });
      } else {
        toastApi.error(
          copy.operationFailedTitle,
          localizedShellErrorMessage(error, copy.operationFailedFallback, uiLocale),
          undefined,
          { sessionId },
        );
      }
    } finally {
      clearPendingTurnAction(key);
    }
  }

  return { handleTurnFooterAction };
}
