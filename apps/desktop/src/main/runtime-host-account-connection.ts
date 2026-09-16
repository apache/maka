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

import { PROVIDER_REGISTRY, type ProviderType } from '@maka/core/llm-connections';
import type {
  ConnectionCatalogEntry,
  ConnectionCatalogSnapshot,
  CredentialLocator,
} from '@maka/core/runtime-policy';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

export type RuntimeHostAccountConnectionClient = Pick<
  DesktopRuntimeHostClient,
  | 'deleteCredential'
  | 'fetchConnectionModels'
  | 'loadConnectionCatalog'
  | 'queryCredential'
  | 'setDefaultConnectionTarget'
  | 'updateConnection'
>;

export async function synchronizeRuntimeHostAccountConnection(
  client: RuntimeHostAccountConnectionClient,
  providerType: ProviderType,
): Promise<void> {
  const connection = findRuntimeHostAccountConnection(
    await client.loadConnectionCatalog(),
    providerType,
  );
  if (!connection) throw new Error('Account Connection is missing');
  return synchronizeRuntimeHostAccountConnectionById(client, connection.connectionId);
}

export async function synchronizeRuntimeHostAccountConnectionById(
  client: RuntimeHostAccountConnectionClient,
  connectionId: string,
): Promise<void> {
  const connection = findRuntimeHostAccountConnectionById(
    await client.loadConnectionCatalog(),
    connectionId,
  );
  if (!connection) throw new Error('Account Connection is missing');
  // Discovery is best effort. Selecting a default must not depend on it: a
  // connection whose inventory came from the shipped baseline still has usable
  // models, and leaving `defaultTarget` empty makes every later operation that
  // needs a default — new Session, send, external Session import — fail with a
  // reason the user cannot see from the error it produces.
  await client.fetchConnectionModels(connection.connectionId).catch(() => undefined);
  const catalog = await client.loadConnectionCatalog();
  if (catalog.defaultTarget !== null) return;
  const updated = findRuntimeHostAccountConnectionById(catalog, connectionId);
  const modelId = updated?.enabledModelIds[0];
  if (!updated || !modelId) return;
  const selected = await client.setDefaultConnectionTarget(catalog.revision, {
    connectionId: updated.connectionId,
    modelId,
  });
  if (selected.kind !== 'committed') {
    throw new Error(`Unable to select account default: ${selected.kind}`);
  }
}

export async function disableRuntimeHostAccountConnectionById(
  client: RuntimeHostAccountConnectionClient,
  connectionId: string,
): Promise<void> {
  const connection = findRuntimeHostAccountConnectionById(
    await client.loadConnectionCatalog(),
    connectionId,
  );
  if (!connection) return;
  const credential = await client.queryCredential(runtimeHostAccountCredential(connection));
  if (credential?.configured) {
    const removed = await client.deleteCredential({
      expected: {
        credentialId: credential.credentialId,
        locator: credential.locator,
        revision: credential.revision,
      },
    });
    if (removed.kind !== 'committed') {
      throw new Error(`Unable to remove account credential: ${removed.kind}`);
    }
  }
  const latest = findRuntimeHostAccountConnectionById(
    await client.loadConnectionCatalog(),
    connectionId,
  );
  if (!latest?.enabled) return;
  const disabled = await client.updateConnection(
    { connectionId: latest.connectionId, revision: latest.revision },
    accountConnectionChanges(latest, false, latest.enabledModelIds),
  );
  if (disabled.kind !== 'committed') {
    throw new Error(`Unable to disable account Connection: ${disabled.kind}`);
  }
}

export function findRuntimeHostAccountConnection(
  catalog: ConnectionCatalogSnapshot,
  providerType: ProviderType,
): ConnectionCatalogEntry | undefined {
  return catalog.connections.find((connection) => connection.providerType === providerType);
}

export function findRuntimeHostAccountConnectionById(
  catalog: ConnectionCatalogSnapshot,
  connectionId: string,
): ConnectionCatalogEntry | undefined {
  return catalog.connections.find((connection) => connection.connectionId === connectionId);
}

export function runtimeHostAccountCredential(
  connection: ConnectionCatalogEntry,
): CredentialLocator {
  if (PROVIDER_REGISTRY[connection.providerType].authKind !== 'oauth_token') {
    throw new Error('Account Connection does not use an OAuth credential');
  }
  return {
    scope: 'connection',
    connectionId: connection.connectionId,
    kind: 'oauth_token',
  };
}

function accountConnectionChanges(
  connection: ConnectionCatalogEntry,
  enabled: boolean,
  enabledModelIds: readonly string[],
) {
  return {
    name: connection.name,
    ...(connection.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
    enabled,
    enabledModelIds: [...enabledModelIds],
    // Account (OAuth) connections never declare relay capabilities, and the
    // omission is the point: with tri-state update semantics an absent key
    // leaves the stored table untouched, so this path can never clobber
    // declarations another writer made.
  };
}
