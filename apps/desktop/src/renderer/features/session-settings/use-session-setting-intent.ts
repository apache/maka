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

import type { OrchestrationMode } from '@maka/core/orchestration';
import type { PermissionMode } from '@maka/core/permission';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import {
  isChatDefaultPermissionMode,
  type ChatDefaultPermissionMode,
} from '@maka/core/settings';
import {
  useSessionSettingIntent as useSharedSessionSettingIntent,
} from '@maka/ui';
import {
  equalSessionModelConfigurationIntent,
  modelConfigurationIntentForModel,
  modelConfigurationIntentForThinking,
  type SessionModelConfigurationIntent,
  type SessionModelTarget,
} from './session-model-configuration-intent.js';
import type { DesktopSessionSummary } from '../../../shared/desktop-session-projection.js';
import { useSessionSettingsServices } from './services-context.js';

type SessionSettingValues = {
  modelConfiguration: SessionModelConfigurationIntent;
  permissionMode: ChatDefaultPermissionMode;
  planMode: boolean;
  orchestrationMode: OrchestrationMode;
};

export function useSessionSettingIntent<Owner extends { sessionId?: string }>(input: {
  catalogRevision: number;
  isActiveSession(sessionId: string): boolean;
  sessions: readonly DesktopSessionSummary[];
  newTaskPermissionMode: ChatDefaultPermissionMode;
  refreshCatalog(): Promise<unknown>;
  saveComposerDefaults(model: SessionModelTarget): void;
  writeFailureCopy(
    setting: 'model' | 'thinking' | 'permission' | 'plan' | 'orchestration',
    error: unknown,
  ): { title: string; description: string };
  showSessionError(sessionId: string, title: string, description: string): void;
  planMode: {
    write(sessionId: string, active: boolean): Promise<boolean>;
  };
  captureOwner(): Owner;
  isOwnerActive(owner: Owner): boolean;
  setNewTaskPermissionMode(mode: ChatDefaultPermissionMode): void;
  confirmBypass(): Promise<boolean>;
}) {
  const services = useSessionSettingsServices();
  const reportWriteError = (
    sessionId: string,
    error: unknown,
    setting: 'model' | 'thinking' | 'permission' | 'plan' | 'orchestration',
  ) => {
    if (!input.isActiveSession(sessionId)) return;
    const failure = input.writeFailureCopy(setting, error);
    input.showSessionError(sessionId, failure.title, failure.description);
  };
  const catalogSessionRevision = (sessionId: string) =>
    input.sessions.find((session) => session.id === sessionId)?.revision;
  const intent = useSharedSessionSettingIntent<SessionSettingValues>({
    catalogRevision: input.catalogRevision,
    refreshCatalog: input.refreshCatalog,
    channels: {
      modelConfiguration: {
        isEqual: equalSessionModelConfigurationIntent,
        write: async (sessionId, configuration) => {
          const summary = await services.setModelConfiguration(sessionId, {
            ...configuration.modelTarget,
            thinkingLevel: configuration.thinkingLevel,
          });
          const committed =
            summary.llmConnectionId === configuration.modelTarget.llmConnectionId &&
            summary.llmConnectionSlug === configuration.modelTarget.llmConnectionSlug &&
            summary.model === configuration.modelTarget.model &&
            (summary.thinkingLevel ?? null) === configuration.thinkingLevel;
          if (committed && configuration.changedSetting === 'model') {
            input.saveComposerDefaults(configuration.modelTarget);
          }
          return { committed, sessionRevision: summary.revision };
        },
        catalogSessionRevision,
        onWriteError: (sessionId, error, attempted) =>
          reportWriteError(sessionId, error, attempted.changedSetting),
      },
      permissionMode: {
        write: async (sessionId, mode) => {
          const summary = await services.setPermissionMode(sessionId, mode);
          return {
            committed: summary.permissionMode === mode,
            sessionRevision: summary.revision,
          };
        },
        catalogSessionRevision,
        onWriteError: (sessionId, error) => reportWriteError(sessionId, error, 'permission'),
      },
      planMode: {
        // Exiting a pending proposal returns Plan state rather than a Session
        // summary, so this policy channel has no authoritative Session revision.
        write: input.planMode.write,
        onWriteError: (sessionId, error) => reportWriteError(sessionId, error, 'plan'),
      },
      orchestrationMode: {
        write: async (sessionId, mode) => {
          const summary = await services.setOrchestrationMode(sessionId, mode);
          return {
            committed: summary.orchestrationMode === mode,
            sessionRevision: summary.revision,
          };
        },
        catalogSessionRevision,
        onWriteError: (sessionId, error) =>
          reportWriteError(sessionId, error, 'orchestration'),
      },
    },
  });

  return {
    clear: intent.clear,
    overlays: intent.overlayByChannel,
    setSessionModel: (sessionId: string, modelTarget: SessionModelTarget) =>
      intent.request('modelConfiguration', sessionId, modelConfigurationIntentForModel(modelTarget)),
    setSessionThinkingLevel: (sessionId: string, thinkingLevel: ThinkingLevel | null) => {
      const pending = intent.overlayByChannel.modelConfiguration[sessionId];
      const session = input.sessions.find((candidate) => candidate.id === sessionId);
      const currentModelTarget = session?.llmConnectionId
        ? {
            llmConnectionId: session.llmConnectionId,
            llmConnectionSlug: session.llmConnectionSlug,
            model: session.model,
          }
        : undefined;
      const next = modelConfigurationIntentForThinking(currentModelTarget, pending, thinkingLevel);
      return next
        ? intent.request('modelConfiguration', sessionId, next)
        : Promise.resolve(false);
    },
    setPermissionMode: async (mode: PermissionMode) => {
      if (!isChatDefaultPermissionMode(mode)) return false;
      const owner = input.captureOwner();
      const sessionId = owner.sessionId;
      const overlay = sessionId ? intent.overlayByChannel.permissionMode[sessionId] : undefined;
      const currentMode = sessionId
        ? overlay ?? input.sessions.find((session) => session.id === sessionId)?.permissionMode
        : input.newTaskPermissionMode;
      if (currentMode === mode) {
        return sessionId && overlay !== undefined
          ? intent.request('permissionMode', sessionId, mode)
          : true;
      }
      if (mode === 'bypass' && !(await input.confirmBypass())) return false;
      if (!input.isOwnerActive(owner)) return false;
      if (sessionId) return intent.request('permissionMode', sessionId, mode);
      input.setNewTaskPermissionMode(mode);
      return true;
    },
    setPlanMode: (sessionId: string, active: boolean) =>
      intent.request('planMode', sessionId, active),
    setOrchestrationMode: (sessionId: string, mode: OrchestrationMode) =>
      intent.request('orchestrationMode', sessionId, mode),
  };
}
