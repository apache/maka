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
  ConnectionCatalogEntry,
  ConnectionCatalogSnapshot,
  CredentialStatus,
} from '@maka/core/runtime-policy';
import {
  registerRuntimeHostGitHubCopilotIpc,
  type RuntimeHostGitHubCopilotIpcDeps,
} from '../runtime-host-github-copilot-ipc-main.js';

const CONNECTION_ID = '00000000-0000-4000-8000-000000000001';
const CREDENTIAL_ID = '00000000-0000-4000-8000-000000000002';

test('imports a local GitHub credential through the shared Host account path', async () => {
  const handlers = new Map<
    string,
    Parameters<RuntimeHostGitHubCopilotIpcDeps['ipcMain']['handle']>[1]
  >();
  const importedSecret = 'serialized-account-credential';
  const discoveredModelId = 'account-discovered-model';
  let storedSecret: string | undefined;
  let credential: CredentialStatus | null = null;
  let changed = 0;
  let catalog: ConnectionCatalogSnapshot = {
    revision: 1,
    defaultTarget: null,
    connections: [],
  };
  const client: RuntimeHostGitHubCopilotIpcDeps['client'] = {
    loadConnectionCatalog: async () => catalog,
    createConnection: async (expectedCatalogRevision, draft) => {
      assert.equal(expectedCatalogRevision, catalog.revision);
      assert.deepEqual(draft.enabledModelIds, [discoveredModelId]);
      const connection: ConnectionCatalogEntry = {
        ...draft,
        connectionId: CONNECTION_ID,
        revision: 1,
        models: [],
      };
      catalog = {
        revision: catalog.revision + 1,
        defaultTarget: null,
        connections: [connection],
      };
      return {
        kind: 'committed',
        catalogRevision: catalog.revision,
        connection: { connectionId: CONNECTION_ID, revision: 1 },
      };
    },
    updateConnection: async (expected, changes) => {
      const current = catalog.connections[0];
      assert.ok(current);
      assert.deepEqual(expected, {
        connectionId: current.connectionId,
        revision: current.revision,
      });
      const { relayModelProfiles, requestBodyOverlay, ...restChanges } = changes;
      const updated: ConnectionCatalogEntry = {
        ...current,
        ...restChanges,
        ...(relayModelProfiles === null ? {} : { relayModelProfiles }),
        ...(requestBodyOverlay === null ? {} : { requestBodyOverlay }),
        revision: current.revision + 1,
      };
      catalog = {
        ...catalog,
        revision: catalog.revision + 1,
        connections: [updated],
      };
      return {
        kind: 'committed',
        catalogRevision: catalog.revision,
        connection: { connectionId: updated.connectionId, revision: updated.revision },
      };
    },
    queryCredential: async () => credential,
    setCredential: async ({ locator, secret }) => {
      storedSecret = secret;
      credential = {
        locator,
        configured: true,
        credentialId: CREDENTIAL_ID,
        revision: 1,
        updatedAt: 1,
      };
      return { kind: 'committed', vaultRevision: 1, status: credential };
    },
    deleteCredential: async ({ expected }) => {
      storedSecret = undefined;
      credential = {
        locator: expected.locator,
        configured: false,
        credentialId: null,
        revision: null,
        updatedAt: null,
      };
      return { kind: 'committed', vaultRevision: 2, status: credential };
    },
    fetchConnectionModels: async (connectionId) => {
      const current = catalog.connections[0];
      assert.ok(current);
      assert.equal(connectionId, current.connectionId);
      const updated: ConnectionCatalogEntry = {
        ...current,
        revision: current.revision + 1,
        models: [{ id: discoveredModelId }],
        modelSource: 'fetched',
        modelsFetchedAt: 1,
      };
      catalog = {
        ...catalog,
        revision: catalog.revision + 1,
        connections: [updated],
      };
      return {
        kind: 'committed',
        catalogRevision: catalog.revision,
        connection: { connectionId: updated.connectionId, revision: updated.revision },
        modelCount: 1,
        source: 'fetched',
        fetchedAt: 1,
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
      result: { ok: true, models: [{ id: discoveredModelId }] },
      secret: importedSecret,
    }),
  });

  const connected = await invoke(handlers, 'github-copilot:connect-existing-login');
  assert.deepEqual(connected, { ok: true });
  assert.equal(JSON.stringify(connected).includes(importedSecret), false);
  assert.equal(storedSecret, importedSecret);
  assert.deepEqual(catalog.defaultTarget, {
    connectionId: CONNECTION_ID,
    modelId: discoveredModelId,
  });
  assert.deepEqual(await invoke(handlers, 'github-copilot:get-account-state'), {
    provider: 'github-copilot',
    runtimeState: 'authenticated',
  });

  assert.deepEqual(await invoke(handlers, 'github-copilot:refresh-tokens'), { ok: true });
  assert.deepEqual(await invoke(handlers, 'github-copilot:logout'), { ok: true });
  assert.equal(storedSecret, undefined);
  assert.equal(catalog.connections[0]?.enabled, false);
  assert.equal(changed, 3);
});

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
