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

import type { ModelInfo } from '@maka/core/llm-connections';
import type { SubscriptionActionResult } from '@maka/core/oauth-subscription';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';
import { GitHubCopilotSubscriptionService } from './oauth/github-copilot-subscription-service.js';
import {
  disableRuntimeHostAccountConnection,
  ensureRuntimeHostAccountConnection,
  findRuntimeHostAccountConnection,
  runtimeHostAccountCredential,
  setRuntimeHostAccountCredential,
  synchronizeRuntimeHostAccountConnection,
  type RuntimeHostAccountConnectionClient,
} from './runtime-host-account-connection.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

const PROVIDER = 'github-copilot';
const CONNECTION_SLUG = 'github-copilot';

type GitHubCopilotClient = RuntimeHostAccountConnectionClient &
  Pick<DesktopRuntimeHostClient, 'setCredential'>;

interface ImportedGitHubCopilotCredential {
  readonly result:
    | { readonly ok: true; readonly models: ModelInfo[] }
    | Exclude<SubscriptionActionResult, { ok: true }>;
  readonly secret?: string;
}

export interface RuntimeHostGitHubCopilotIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: GitHubCopilotClient;
  readonly emitConnectionListChanged: () => void;
  readonly importExistingLogin?: () => Promise<ImportedGitHubCopilotCredential>;
}

/** Keeps local `gh` discovery in Desktop while committing its credential only to the Host vault. */
export function registerRuntimeHostGitHubCopilotIpc(
  deps: RuntimeHostGitHubCopilotIpcDeps,
): void {
  const importExistingLogin = deps.importExistingLogin ?? importGitHubCopilotCredential;

  deps.ipcMain.handle('github-copilot:connect-existing-login', async () => {
    const imported = await importExistingLogin();
    if (!imported.result.ok) return imported.result;
    if (!imported.secret) return storageFailure('GitHub Copilot login produced no credential');
    try {
      const connection = await ensureRuntimeHostAccountConnection(
        deps.client,
        { providerType: PROVIDER, slug: CONNECTION_SLUG },
        imported.result.models.map(({ id }) => id),
      );
      await setRuntimeHostAccountCredential(deps.client, connection, imported.secret);
      await synchronizeRuntimeHostAccountConnection(deps.client, PROVIDER).catch(
        () => undefined,
      );
      deps.emitConnectionListChanged();
      return { ok: true as const };
    } catch {
      return storageFailure('GitHub Copilot login could not be committed to Runtime Host');
    }
  });

  handleReconnectableRead(deps.ipcMain, 'github-copilot:get-account-state', async () => {
    const connection = findRuntimeHostAccountConnection(
      await deps.client.loadConnectionCatalog(),
      PROVIDER,
    );
    const credential = connection
      ? await deps.client.queryCredential(runtimeHostAccountCredential(connection))
      : null;
    return {
      provider: PROVIDER,
      runtimeState: credential?.configured ? 'authenticated' : 'not_logged_in',
    } as const;
  });

  deps.ipcMain.handle('github-copilot:refresh-tokens', async () => {
    const connection = findRuntimeHostAccountConnection(
      await deps.client.loadConnectionCatalog(),
      PROVIDER,
    );
    if (!connection) return refreshFailure('GitHub Copilot is not connected');
    const credential = await deps.client.queryCredential(
      runtimeHostAccountCredential(connection),
    );
    if (!credential?.configured) return refreshFailure('GitHub Copilot is not connected');
    const refreshed = await deps.client.fetchConnectionModels(connection.connectionId);
    if (refreshed.kind !== 'committed') {
      return refreshFailure(`GitHub Copilot refresh failed: ${refreshed.kind}`);
    }
    deps.emitConnectionListChanged();
    return { ok: true as const };
  });

  deps.ipcMain.handle('github-copilot:logout', async () => {
    try {
      await disableRuntimeHostAccountConnection(deps.client, PROVIDER);
    } catch {
      return storageFailure('GitHub Copilot account could not be removed from Runtime Host');
    }
    deps.emitConnectionListChanged();
    return { ok: true as const };
  });
}

async function importGitHubCopilotCredential(): Promise<ImportedGitHubCopilotCredential> {
  let secret: string | undefined;
  const service = new GitHubCopilotSubscriptionService({
    credentialStore: {
      getSecret: async () => secret ?? null,
      setSecret: async (_slug, _kind, value) => {
        secret = value;
      },
      deleteSecret: async () => {
        secret = undefined;
      },
    },
  });
  const result = await service.connectExistingLogin();
  return { result, ...(result.ok && secret ? { secret } : {}) };
}

function storageFailure(message: string) {
  return { ok: false as const, reason: 'storage_failed' as const, message };
}

function refreshFailure(message: string) {
  return { ok: false as const, reason: 'refresh_failed' as const, message };
}
