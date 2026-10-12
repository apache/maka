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

import assert from 'node:assert/strict';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionCatalogController } from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import {
  buildAppShellCommandList,
  type AppShellCommandListOptions,
} from '../../renderer/app-shell-command-actions.js';
import { createFakeOverlaysServices } from '../../renderer/features/overlays/testing.js';

/**
 * Palette options for a shell showing `session-1`, whose toasts are recorded
 * as `success:<title>` / `error:<title>:<description>:<target>`.
 */
export function appShellCommandOptions(
  toasts: string[],
  overrides: Partial<AppShellCommandListOptions> = {},
): AppShellCommandListOptions {
  return {
    uiLocale: 'en',
    activeId: 'session-1',
    activePermissionMode: undefined,
    canSetPermissionMode: false,
    clientPathsAccessible: false,
    connections: [],
    defaultConnection: null,
    renderPublishedConversation: () => '',
    newTaskProfileId: 'new-task-profile',
    settingsOpen: false,
    settingsProfileId: undefined,
    sessionCatalog: {
      getState: () => ({ sessions: [{ id: 'session-1', name: 'Long task' }] }),
    } as unknown as SessionCatalogController,
    themePref: 'auto',
    hiddenSessionIds: new Set(),
    captureComposerImportOwner: () => ({ sessionId: 'session-1', navSection: 'sessions' }),
    copyManualDiagnosticReport: async () => undefined,
    paletteActions: createFakeOverlaysServices().palette,
    createSession() {},
    openSideConversation() {},
    openHelp() {},
    openScheduledTaskCreate() {},
    openProjectFolder: async () => {},
    openSessionInChat() {},
    openSettings() {},
    openSettingsSection() {},
    openWorkspaceFolder: async () => {},
    refreshConnections: async () => {},
    copyTodayDailyReview: async () => {},
    pasteTodayDailyReview: async () => {},
    saveTodayDailyReview: async () => {},
    setNavSelection() {},
    setPermissionMode: async () => true,
    setThemePref() {},
    toastApi: {
      success: (title) => toasts.push(`success:${title}`),
      info() {},
      error: (title, description, _details, target) =>
        toasts.push(`error:${title}:${description}:${JSON.stringify(target)}`),
    },
    ...overrides,
  };
}

/** An enabled connection the palette offers both per-connection rows for. */
export function paletteConnection(slug: string, name: string): LlmConnection {
  return {
    slug,
    name,
    providerType: 'anthropic',
    enabled: true,
    defaultModel: 'model-1',
  } as unknown as LlmConnection;
}

export async function runPaletteCommand(options: AppShellCommandListOptions, id: string): Promise<void> {
  const command = buildAppShellCommandList({ current: options }).find((candidate) => candidate.id === id);
  assert.ok(command, `missing ${id}`);
  await command.run();
}
