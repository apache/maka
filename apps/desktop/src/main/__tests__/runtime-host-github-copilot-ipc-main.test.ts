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
import test from 'node:test';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  RuntimeHostConnectionCatalogEntry as ConnectionCatalogEntry,
  RuntimeHostConnectionCatalogSnapshot as ConnectionCatalogSnapshot,
} from '@maka/runtime-host/client';
import {
  registerRuntimeHostGitHubCopilotIpc,
  type RuntimeHostGitHubCopilotIpcDeps,
} from '../runtime-host-github-copilot-ipc-main.js';

const CONNECTION_ID = '00000000-0000-4000-8000-000000000001';

// Public seam: the Desktop IPC discovers local material, while one Host command
// owns provider discovery, generation checks, and the credential/catalog commit.
test('delegates local credential adoption to one Host onboarding command', async () => {
  const handlers = new Map<
    string,
    Parameters<RuntimeHostGitHubCopilotIpcDeps['ipcMain']['handle']>[1]
  >();
  const importedSecret = '{"access_token":"gho_local","token_type":"Bearer"}';
  const discoveredModelId = 'account-discovered-model';
  let changed = 0;
  let adoptionCalls = 0;
  let catalog: ConnectionCatalogSnapshot = {
    revision: 1,
    defaultTarget: null,
    connections: [connectionFixture()],
  };

  const client: RuntimeHostGitHubCopilotIpcDeps['client'] = {
    loadConnectionCatalog: async () => catalog,
    saveConnectionOnboarding: async (input) => {
      adoptionCalls += 1;
      assert.deepEqual(input, {
        target: { kind: 'existing', connectionId: CONNECTION_ID },
        apiKey: importedSecret,
        baseUrl: null,
        // Empty means the Host adopts the non-empty model set it verifies.
        enabledModelIds: [],
      });
      const current = catalog.connections[0];
      assert.ok(current);
      const updated: ConnectionCatalogEntry = {
        ...current,
        revision: current.revision + 1,
        enabledModelIds: [discoveredModelId],
        models: [{ id: discoveredModelId }],
        modelSource: 'fetched',
      };
      catalog = {
        ...catalog,
        revision: catalog.revision + 1,
        connections: [updated],
      };
      return {
        kind: 'saved',
        connection: {
          connectionId: updated.connectionId,
          revision: updated.revision,
          slug: updated.slug,
          providerType: updated.providerType,
        },
      };
    },
    setDefaultConnectionTarget: async (expectedCatalogRevision, target) => {
      assert.equal(expectedCatalogRevision, catalog.revision);
      catalog = {
        ...catalog,
        revision: catalog.revision + 1,
        defaultTarget: target,
      };
      return { kind: 'committed', catalogRevision: catalog.revision };
    },
  };

  registerRuntimeHostGitHubCopilotIpc({
    ipcMain: { handle: (channel, handler) => void handlers.set(channel, handler) },
    client,
    emitConnectionListChanged: () => {
      changed += 1;
    },
    importExistingLogin: async () => ({
      result: { ok: true },
      secret: importedSecret,
    }),
  });

  const connected = await invoke(handlers, 'github-copilot:connect-existing-login');
  assert.deepEqual(connected, { ok: true });
  assert.equal(JSON.stringify(connected).includes(importedSecret), false);
  assert.equal(adoptionCalls, 1);
  assert.deepEqual(catalog.defaultTarget, {
    connectionId: CONNECTION_ID,
    modelId: discoveredModelId,
  });
  assert.equal(changed, 1);
  assert.deepEqual([...handlers.keys()], ['github-copilot:connect-existing-login']);
});

function connectionFixture(): ConnectionCatalogEntry {
  return {
    connectionId: CONNECTION_ID,
    revision: 1,
    slug: 'github-copilot',
    name: 'GitHub Copilot',
    providerType: 'github-copilot',
    enabled: true,
    enabledModelIds: ['copilot-fallback'],
    catalogEntries: [],
    models: [],
  };
}

async function invoke(
  handlers: ReadonlyMap<
    string,
    Parameters<RuntimeHostGitHubCopilotIpcDeps['ipcMain']['handle']>[1]
  >,
  channel: string,
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler({} as IpcMainInvokeEvent);
}
