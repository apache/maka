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
import type { LlmConnection } from '@maka/core/llm-connections';
import type { PermissionMode } from '@maka/core/permission';
import {
  deriveModelSwitchTranscript,
  type StoredMessage,
} from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopSessionSummary } from '../preload/bridge-contract.js';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type RefBox<T> = { current: T };
type BooleanRecordUpdater = (updater: (current: Record<string, boolean>) => Record<string, boolean>) => void;

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
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setSessionModel(input: { llmConnectionSlug: string; model: string }): Promise<void>;
  setSessionThinkingLevel(level: ThinkingLevel | undefined): Promise<void>;
}

export function createAppShellSessionSettingsActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  connections: readonly LlmConnection[];
  messages: readonly StoredMessage[];
  pendingPermissionModeChangesRef: RefBox<Set<string>>;
  pendingSessionModelChangesRef: RefBox<Set<string>>;
  refreshSessions: () => Promise<DesktopSessionSummary[]>;
  saveComposerDefaults: (patch: {
    model: { llmConnectionSlug: string; model: string };
  }) => void;
  sessionsRef: RefBox<DesktopSessionSummary[]>;
  setNewTaskPermissionMode: (mode: ChatDefaultPermissionMode) => void;
  setPendingPermissionModeBySession: BooleanRecordUpdater;
  setPendingSessionModelBySession: BooleanRecordUpdater;
  setSessions: (
    updater: (current: DesktopSessionSummary[]) => DesktopSessionSummary[],
  ) => void;
  toastApi: ToastApi;
}): AppShellSessionSettingsActions {
  const {
    uiLocale,
    activeIdRef,
    connections,
    messages,
    pendingPermissionModeChangesRef,
    pendingSessionModelChangesRef,
    refreshSessions,
    saveComposerDefaults,
    sessionsRef,
    setNewTaskPermissionMode,
    setPendingPermissionModeBySession,
    setPendingSessionModelBySession,
    setSessions,
    toastApi,
  } = deps;
  const copy = getShellCopy(uiLocale).sessionSettingsActions;

  function omitSessionKey<T>(current: Record<string, T>, sessionId: string): Record<string, T> {
    if (!(sessionId in current)) return current;
    const next = { ...current };
    delete next[sessionId];
    return next;
  }

  function modelLabel(connectionSlug: string, model: string): string {
    const connection = connections.find((entry) => entry.slug === connectionSlug);
    const displayName = connection?.models?.find((entry) => entry.id === model)?.displayName?.trim();
    return displayName || model;
  }

  function modelEndpointLabel(connectionSlug: string, model: string, includeConnection: boolean): string {
    const label = modelLabel(connectionSlug, model);
    if (!includeConnection) return label;
    const connection = connections.find((entry) => entry.slug === connectionSlug);
    return `${label} (${connection?.name ?? connectionSlug})`;
  }

  async function setPermissionMode(mode: PermissionMode) {
    if (mode !== 'ask' && mode !== 'bypass') return;
    const sessionId = activeIdRef.current;
    const pendingKey = sessionId ?? '__global_permission_mode__';
    if (pendingPermissionModeChangesRef.current.has(pendingKey)) return;
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
      return;
    }

    pendingPermissionModeChangesRef.current.add(pendingKey);
    if (sessionId)
      setPendingPermissionModeBySession((current) => ({
        ...current,
        [sessionId]: true,
      }));
    try {
      let nextMode = mode;
      if (sessionId) {
        const next = await window.maka.sessions.setPermissionMode(sessionId, mode);
        nextMode = next.permissionMode === 'bypass' ? 'bypass' : 'ask';
        setSessions((prev) =>
          prev.map((session) => (session.id === sessionId ? next : session)),
        );
      } else {
        setNewTaskPermissionMode(mode);
      }
      toastApi.success(
        copy.permissionSwitched(copy.permissionLabels[nextMode]),
        copy.permissionDescriptions[nextMode],
      );
      if (sessionId) await refreshSessions();
    } catch (error) {
      toastApi.error(
        copy.permissionFailedTitle,
        localizedShellErrorMessage(error, copy.permissionFallback, uiLocale),
        undefined,
        sessionId ? { sessionId } : undefined,
      );
    } finally {
      pendingPermissionModeChangesRef.current.delete(pendingKey);
      if (sessionId) setPendingPermissionModeBySession((current) => omitSessionKey(current, sessionId));
    }
  }

  async function setSessionModel(input: { llmConnectionSlug: string; model: string }) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const previous = sessionsRef.current.find((session) => session.id === sessionId);
    const transcript = deriveModelSwitchTranscript(messages);
    if (pendingSessionModelChangesRef.current.has(sessionId)) return;
    pendingSessionModelChangesRef.current.add(sessionId);
    setPendingSessionModelBySession((current) => ({
      ...current,
      [sessionId]: true,
    }));
    try {
      const next = await window.maka.sessions.setModel(sessionId, input);
      setSessions((prev) => prev.map((session) => (session.id === next.id ? next : session)));
      if (activeIdRef.current === sessionId) {
        const connectionChanged = previous?.llmConnectionSlug !== next.llmConnectionSlug;
        const to = modelEndpointLabel(next.llmConnectionSlug, next.model, connectionChanged);
        const previousModel = transcript.lastUsedModel ?? previous?.model;
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
        toastApi.error(
          copy.modelFailedTitle,
          localizedShellErrorMessage(error, copy.modelFallback, uiLocale),
          undefined,
          { sessionId },
        );
      }
    } finally {
      pendingSessionModelChangesRef.current.delete(sessionId);
      setPendingSessionModelBySession((current) => omitSessionKey(current, sessionId));
    }
  }

  async function setSessionThinkingLevel(level: ThinkingLevel | undefined) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const current = sessionsRef.current.find((session) => session.id === sessionId);
    if (current && current.thinkingLevel === level) return;
    if (pendingSessionModelChangesRef.current.has(sessionId)) return;
    pendingSessionModelChangesRef.current.add(sessionId);
    setPendingSessionModelBySession((currentPending) => ({
      ...currentPending,
      [sessionId]: true,
    }));
    try {
      const next = await window.maka.sessions.setThinkingLevel(sessionId, level);
      setSessions((prev) => prev.map((session) => (session.id === next.id ? next : session)));
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
      pendingSessionModelChangesRef.current.delete(sessionId);
      setPendingSessionModelBySession((currentPending) => omitSessionKey(currentPending, sessionId));
    }
  }

  return {
    setPermissionMode,
    setSessionModel,
    setSessionThinkingLevel,
  };
}
