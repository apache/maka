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
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { SessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import type { SessionModelConfigurationIntent, SessionModelTarget } from '../session-model-configuration-intent.js';

export interface SessionSettingValues {
  modelConfiguration: SessionModelConfigurationIntent;
  permissionMode: ChatDefaultPermissionMode;
  planMode: boolean;
  orchestrationMode: OrchestrationMode;
}

export type SessionSettingsOverlays = {
  readonly [Key in keyof SessionSettingValues]: Readonly<Record<string, SessionSettingValues[Key]>>;
};

export interface SessionSettingsInput<Owner extends { sessionId?: string }> {
  catalog: SessionCatalogController;
  isActiveSession(sessionId: string): boolean;
  newSessionPermissionMode: ChatDefaultPermissionMode;
  refreshCatalog(): Promise<unknown>;
  saveComposerDefaults(model: SessionModelTarget): void;
  writeFailureCopy(
    setting: 'model' | 'thinking' | 'permission' | 'plan' | 'orchestration',
    error: unknown,
  ): { title: string; description: string };
  showSessionError(sessionId: string, title: string, description: string): void;
  planMode: {
    reportExecutionActive(sessionId: string): void;
    confirmDiscard(proposalTitle: string): Promise<boolean>;
  };
  captureOwner(): Owner;
  isOwnerActive(owner: Owner): boolean;
  setNewTaskPermissionMode(mode: ChatDefaultPermissionMode): void;
  confirmBypass(): Promise<boolean>;
}

export interface SessionSettingsCommands {
  clear(sessionId: string): void;
  setSessionModel(sessionId: string, model: SessionModelTarget): Promise<boolean>;
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel | null): Promise<boolean>;
  setSessionExecutor(
    sessionId: string,
    target: { executorId: string; model?: string; thinkingLevel?: ThinkingLevel },
  ): Promise<boolean>;
  setPermissionMode(mode: PermissionMode): Promise<boolean>;
  setPlanMode(sessionId: string, active: boolean): Promise<boolean>;
  setOrchestrationMode(sessionId: string, mode: OrchestrationMode): Promise<boolean>;
}

export interface SessionSettingsController extends SessionSettingsCommands {
  readonly overlays: SessionSettingsOverlays;
}
