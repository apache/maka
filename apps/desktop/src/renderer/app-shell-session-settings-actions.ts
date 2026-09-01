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

import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { ProjectedLlmConnection } from '@maka/core/llm-connections';
import type { PermissionMode } from '@maka/core/permission';
import {
  latestAssistantModelId,
  type StoredMessage,
} from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopSessionSummary } from '../preload/bridge-contract.js';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';
import type { SessionPendingClaim } from './app-shell-session-ui-state.js';

type RefBox<T> = { current: T };

type ToastApi = {
  success(title: string, description?: string): void;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string },
  ): void;
  confirm(input: {
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
  }): Promise<boolean>;
};

export interface AppShellSessionSettingsActions {
  setPermissionMode(mode: PermissionMode): Promise<boolean>;
  setSessionModel(input: {
    llmConnectionId: string;
    llmConnectionSlug: string;
    model: string;
  }): Promise<void>;
  setSessionThinkingLevel(level: ThinkingLevel | undefined): Promise<void>;
}

export function createAppShellSessionSettingsActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  connections: readonly ProjectedLlmConnection[];
  messages: readonly StoredMessage[];
  permissionModePending: SessionPendingClaim;
  sessionModelPending: SessionPendingClaim;
  refreshSessions: () => Promise<DesktopSessionSummary[]>;
  saveComposerDefaults: (patch: {
    model: { llmConnectionId: string; llmConnectionSlug: string; model: string };
  }) => void;
  sessionsRef: RefBox<DesktopSessionSummary[]>;
  /** Persists the chat default; awaited so a failure surfaces as one. */
  setNewTaskPermissionMode: (mode: ChatDefaultPermissionMode) => void | Promise<void>;
  toastApi: ToastApi;
}): AppShellSessionSettingsActions {
  const {
    uiLocale,
    activeIdRef,
    connections,
    messages,
    permissionModePending,
    sessionModelPending,
    refreshSessions,
    saveComposerDefaults,
    sessionsRef,
    setNewTaskPermissionMode,
    toastApi,
  } = deps;
  const copy = getShellCopy(uiLocale).sessionSettingsActions;

  // The Host's entries, not the stored rows: a provider with no model-list
  // endpoint stores bare ids, and the pickers beside this show resolved names.
  function modelLabel(connectionSlug: string, model: string): string {
    const connection = connections.find((entry) => entry.slug === connectionSlug);
    return connection?.catalogEntries.find((entry) => entry.id === model)?.displayName?.trim() || model;
  }

  function modelEndpointLabel(connectionSlug: string, model: string, includeConnection: boolean): string {
    const label = modelLabel(connectionSlug, model);
    if (!includeConnection) return label;
    const connection = connections.find((entry) => entry.slug === connectionSlug);
    return `${label} (${connection?.name ?? connectionSlug})`;
  }

  async function setPermissionMode(mode: PermissionMode): Promise<boolean> {
    if (mode !== 'ask' && mode !== 'bypass') return false;
    const sessionId = activeIdRef.current;
    const currentMode = sessionId
      ? sessionsRef.current.find((session) => session.id === sessionId)?.permissionMode
      : undefined;
    if (currentMode === mode) return true;
    // No session means the chat default, which has no row to mark pending. It
    // still needs a key of its own so two rapid switches cannot both run.
    const pendingKey = sessionId ?? '__global_permission_mode__';
    // Claimed before the confirm rather than after it: the dialog is part of
    // the change, so a second click while it is open must not open a second
    // one. The cost is that the control reads as pending while the user
    // decides, which is what is actually true.
    if (!permissionModePending.claim(pendingKey)) return false;
    if (
      mode === 'bypass' &&
      !(await toastApi.confirm({
        title: copy.bypassConfirmTitle,
        description: copy.bypassConfirmDescription,
        confirmLabel: copy.bypassConfirmLabel,
        cancelLabel: copy.bypassCancelLabel,
        destructive: true,
      }))
    ) {
      permissionModePending.release(pendingKey);
      return false;
    }

    try {
      let nextMode = mode;
      if (sessionId) {
        const next = await window.maka.sessions.setPermissionMode(sessionId, mode);
        nextMode = next.permissionMode === 'bypass' ? 'bypass' : 'ask';
      } else {
        await setNewTaskPermissionMode(mode);
      }
      toastApi.success(
        copy.permissionSwitched(copy.permissionLabels[nextMode]),
        copy.permissionDescriptions[nextMode],
      );
      if (sessionId) await refreshSessions();
      return nextMode === mode;
    } catch (error) {
      toastApi.error(
        copy.permissionFailedTitle,
        localizedShellErrorMessage(error, copy.permissionFallback, uiLocale),
        undefined,
        sessionId ? { sessionId } : undefined,
      );
      return false;
    } finally {
      permissionModePending.release(pendingKey);
    }
  }

  async function setSessionModel(input: {
    llmConnectionId: string;
    llmConnectionSlug: string;
    model: string;
  }) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const previous = sessionsRef.current.find((session) => session.id === sessionId);
    const lastUsedModel = latestAssistantModelId(messages);
    if (!sessionModelPending.claim(sessionId)) return;
    try {
      const next = await window.maka.sessions.setModel(sessionId, input);
      if (activeIdRef.current === sessionId) {
        const connectionChanged = previous?.llmConnectionSlug !== next.llmConnectionSlug;
        const to = modelEndpointLabel(next.llmConnectionSlug, next.model, connectionChanged);
        const previousModel = lastUsedModel ?? previous?.model;
        toastApi.success(
          copy.modelSwitchedTitle,
          previous && previousModel
            ? copy.modelSwitchedDescription(
                modelEndpointLabel(
                  previous.llmConnectionSlug,
                  previousModel,
                  connectionChanged,
                ),
                to,
              )
            : to,
        );
      }
      saveComposerDefaults({ model: input });
      await refreshSessions();
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        const detail = localizedShellErrorMessage(error, copy.modelFallback, uiLocale);
        toastApi.error(
          copy.modelFailedTitle,
          `${detail} ${copy.modelRecoveryHint}`,
          undefined,
          { sessionId },
        );
      }
    } finally {
      sessionModelPending.release(sessionId);
    }
  }

  async function setSessionThinkingLevel(level: ThinkingLevel | undefined) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const current = sessionsRef.current.find((session) => session.id === sessionId);
    if (current && current.thinkingLevel === level) return;
    if (!sessionModelPending.claim(sessionId)) return;
    try {
      await window.maka.sessions.setThinkingLevel(sessionId, level);
      if (activeIdRef.current === sessionId) {
        toastApi.success(copy.thinkingUpdatedTitle, level ? copy.thinkingLabels[level] : copy.thinkingDefault);
      }
      await refreshSessions();
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        toastApi.error(
          copy.thinkingFailedTitle,
          localizedShellErrorMessage(error, copy.thinkingFallback, uiLocale),
          undefined,
          { sessionId },
        );
      }
    } finally {
      sessionModelPending.release(sessionId);
    }
  }

  return {
    setPermissionMode,
    setSessionModel,
    setSessionThinkingLevel,
  };
}
