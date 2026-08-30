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
import type { PermissionMode } from '@maka/core/permission';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopSessionSummary } from '../preload/bridge-contract.js';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';
import type { NewChatModel } from './shell-chat-model-selection.js';

type RefBox<T> = { current: T };
type RecordUpdater<T> = (updater: (current: Record<string, T>) => Record<string, T>) => void;

type ToastApi = {
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

/** The three optimistic overlays this file reads back synchronously to detect
 * a superseded request — sourced from `AppShellSessionUiState`. */
type OptimisticSettingsState = {
  optimisticPermissionModeBySession: Record<string, PermissionMode>;
  optimisticSessionModelBySession: Record<string, NewChatModel>;
  optimisticSessionThinkingLevelBySession: Record<string, ThinkingLevel | undefined>;
};

export interface AppShellSessionSettingsActions {
  setPermissionMode(mode: PermissionMode): Promise<boolean>;
  setSessionModel(input: NewChatModel): Promise<void>;
  setSessionThinkingLevel(level: ThinkingLevel | undefined): Promise<void>;
}

function omitSessionKey<T>(current: Record<string, T>, sessionId: string): Record<string, T> {
  if (!(sessionId in current)) return current;
  const next = { ...current };
  delete next[sessionId];
  return next;
}

/** True while `sessionId`'s overlay still holds the exact value this call
 * requested — false once a newer call has overwritten or cleared it. Uses
 * `in` (not truthiness) so a thinking-level request for `undefined` isn't
 * mistaken for an absent override. */
function isStillLatest<T>(map: Record<string, T>, sessionId: string, value: T): boolean {
  return sessionId in map && map[sessionId] === value;
}

export function createAppShellSessionSettingsActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  getOptimisticState: () => OptimisticSettingsState;
  refreshSessions: () => Promise<DesktopSessionSummary[]>;
  saveComposerDefaults: (patch: { model: NewChatModel }) => void;
  sessionsRef: RefBox<DesktopSessionSummary[]>;
  /** Persists the chat default; awaited so a failure surfaces as one. */
  setNewTaskPermissionMode: (mode: ChatDefaultPermissionMode) => void | Promise<void>;
  setOptimisticPermissionModeBySession: RecordUpdater<PermissionMode>;
  setOptimisticSessionModelBySession: RecordUpdater<NewChatModel>;
  setOptimisticSessionThinkingLevelBySession: RecordUpdater<ThinkingLevel | undefined>;
  setSessions: (
    updater: (current: DesktopSessionSummary[]) => DesktopSessionSummary[],
  ) => void;
  toastApi: ToastApi;
}): AppShellSessionSettingsActions {
  const {
    uiLocale,
    activeIdRef,
    getOptimisticState,
    refreshSessions,
    saveComposerDefaults,
    sessionsRef,
    setNewTaskPermissionMode,
    setOptimisticPermissionModeBySession,
    setOptimisticSessionModelBySession,
    setOptimisticSessionThinkingLevelBySession,
    setSessions,
    toastApi,
  } = deps;
  const copy = getShellCopy(uiLocale).sessionSettingsActions;

  async function setPermissionMode(mode: PermissionMode): Promise<boolean> {
    if (mode !== 'ask' && mode !== 'bypass') return false;
    const sessionId = activeIdRef.current;
    const currentMode = sessionId
      ? sessionsRef.current.find((session) => session.id === sessionId)?.permissionMode
      : undefined;
    if (currentMode === mode) return true;
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
      return false;
    }

    if (!sessionId) {
      // No active task — this is the chat-default permission mode, which has
      // no per-session overlay to manage.
      try {
        await setNewTaskPermissionMode(mode);
        return true;
      } catch (error) {
        toastApi.error(
          copy.permissionFailedTitle,
          localizedShellErrorMessage(error, copy.permissionFallback, uiLocale),
        );
        return false;
      }
    }

    setOptimisticPermissionModeBySession((current) => ({ ...current, [sessionId]: mode }));
    try {
      const next = await window.maka.sessions.setPermissionMode(sessionId, mode);
      const nextMode = next.permissionMode === 'bypass' ? 'bypass' : 'ask';
      if (!isStillLatest(getOptimisticState().optimisticPermissionModeBySession, sessionId, mode)) {
        return nextMode === mode;
      }
      setSessions((prev) =>
        prev.map((session) => (session.id === sessionId ? next : session)),
      );
      setOptimisticPermissionModeBySession((current) => omitSessionKey(current, sessionId));
      await refreshSessions();
      return nextMode === mode;
    } catch (error) {
      if (!isStillLatest(getOptimisticState().optimisticPermissionModeBySession, sessionId, mode)) {
        return false;
      }
      setOptimisticPermissionModeBySession((current) => omitSessionKey(current, sessionId));
      toastApi.error(
        copy.permissionFailedTitle,
        localizedShellErrorMessage(error, copy.permissionFallback, uiLocale),
        undefined,
        { sessionId },
      );
      return false;
    }
  }

  async function setSessionModel(input: NewChatModel) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    setOptimisticSessionModelBySession((current) => ({ ...current, [sessionId]: input }));
    try {
      const next = await window.maka.sessions.setModel(sessionId, input);
      if (!isStillLatest(getOptimisticState().optimisticSessionModelBySession, sessionId, input)) return;
      setSessions((prev) => prev.map((session) => (session.id === next.id ? next : session)));
      saveComposerDefaults({ model: input });
      setOptimisticSessionModelBySession((current) => omitSessionKey(current, sessionId));
      await refreshSessions();
    } catch (error) {
      if (!isStillLatest(getOptimisticState().optimisticSessionModelBySession, sessionId, input)) return;
      setOptimisticSessionModelBySession((current) => omitSessionKey(current, sessionId));
      if (activeIdRef.current === sessionId) {
        toastApi.error(
          copy.modelFailedTitle,
          localizedShellErrorMessage(error, copy.modelFallback, uiLocale),
          undefined,
          { sessionId },
        );
      }
    }
  }

  async function setSessionThinkingLevel(level: ThinkingLevel | undefined) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const current = sessionsRef.current.find((session) => session.id === sessionId);
    if (current && current.thinkingLevel === level) return;
    setOptimisticSessionThinkingLevelBySession((currentPending) => ({ ...currentPending, [sessionId]: level }));
    try {
      const next = await window.maka.sessions.setThinkingLevel(sessionId, level);
      if (!isStillLatest(getOptimisticState().optimisticSessionThinkingLevelBySession, sessionId, level)) {
        return;
      }
      setSessions((prev) => prev.map((session) => (session.id === next.id ? next : session)));
      setOptimisticSessionThinkingLevelBySession((currentPending) => omitSessionKey(currentPending, sessionId));
      await refreshSessions();
    } catch (error) {
      if (!isStillLatest(getOptimisticState().optimisticSessionThinkingLevelBySession, sessionId, level)) {
        return;
      }
      setOptimisticSessionThinkingLevelBySession((currentPending) => omitSessionKey(currentPending, sessionId));
      if (activeIdRef.current === sessionId) {
        toastApi.error(
          copy.thinkingFailedTitle,
          localizedShellErrorMessage(error, copy.thinkingFallback, uiLocale),
          undefined,
          { sessionId },
        );
      }
    }
  }

  return {
    setPermissionMode,
    setSessionModel,
    setSessionThinkingLevel,
  };
}
