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

import {
  importGitHubCopilotLocalCredential,
  type ImportedGitHubCopilotCredential,
} from './oauth/github-copilot-local-credential.js';
import type { ReconnectableReadIpcMain } from './ipc-reconnect-policy.js';
import {
  findRuntimeHostAccountConnection,
  findRuntimeHostAccountConnectionById,
} from './runtime-host-account-connection.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

const PROVIDER = 'github-copilot';

type GitHubCopilotClient = Pick<
  DesktopRuntimeHostClient,
  'loadConnectionCatalog' | 'saveConnectionOnboarding' | 'setDefaultConnectionTarget'
>;

export interface RuntimeHostGitHubCopilotIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: GitHubCopilotClient;
  readonly emitConnectionListChanged: () => void;
  readonly importExistingLogin?: () => Promise<ImportedGitHubCopilotCredential>;
}

/**
 * Desktop discovers credential material already present on this machine. The
 * selected Host owns everything after that seam: provider discovery over its
 * transport, the connection/credential generation basis, and the atomic commit.
 */
export function registerRuntimeHostGitHubCopilotIpc(deps: RuntimeHostGitHubCopilotIpcDeps): void {
  const importExistingLogin = deps.importExistingLogin ?? importGitHubCopilotLocalCredential;

  deps.ipcMain.handle('github-copilot:connect-existing-login', async () => {
    const imported = await importExistingLogin();
    if (!imported.result.ok) return imported.result;
    if (!imported.secret) return storageFailure('GitHub Copilot login produced no credential');

    try {
      const before = await deps.client.loadConnectionCatalog();
      const existing = findRuntimeHostAccountConnection(before, PROVIDER);
      const adopted = await deps.client.saveConnectionOnboarding({
        target: existing
          ? { kind: 'existing', connectionId: existing.connectionId }
          : { kind: 'create', providerType: PROVIDER },
        apiKey: imported.secret,
        baseUrl: null,
        // The Host enables the non-empty model set this same operation verifies.
        enabledModelIds: [],
      });
      if (adopted.kind === 'rejected') {
        if (adopted.reason === 'superseded') {
          return storageFailure('GitHub Copilot 账号在导入期间发生变化，请重试。');
        }
        return adopted.reason === 'model_unavailable'
          ? actionFailure('当前 GitHub 账号没有可用的 Copilot 订阅权限。')
          : actionFailure('当前 GitHub 凭据无法导入，请检查凭据后重试。');
      }
      if (adopted.kind === 'failed') {
        return adopted.errorClass === 'auth'
          ? actionFailure('当前 GitHub 账号没有可用的 Copilot 订阅权限。')
          : actionFailure('暂时无法验证 GitHub Copilot 订阅状态，请稍后重试。');
      }

      await selectAccountDefaultIfMissing(deps.client, adopted.connection.connectionId);
      deps.emitConnectionListChanged();
      return { ok: true as const };
    } catch {
      return storageFailure('GitHub Copilot login could not be committed to Runtime Host');
    }
  });
}

async function selectAccountDefaultIfMissing(
  client: GitHubCopilotClient,
  connectionId: string,
): Promise<void> {
  const catalog = await client.loadConnectionCatalog();
  if (catalog.defaultTarget !== null) return;
  const connection = findRuntimeHostAccountConnectionById(catalog, connectionId);
  const modelId = connection?.enabledModelIds[0];
  if (!connection || !modelId) return;
  const selected = await client.setDefaultConnectionTarget(catalog.revision, {
    connectionId,
    modelId,
  });
  if (selected.kind !== 'committed') {
    throw new Error(`Unable to select account default: ${selected.kind}`);
  }
}

function actionFailure(message: string) {
  return { ok: false as const, reason: 'token_exchange_failed' as const, message };
}

function storageFailure(message: string) {
  return { ok: false as const, reason: 'storage_failed' as const, message };
}
