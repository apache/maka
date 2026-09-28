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
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import { openInteractiveRuntimePolicyStoresForRead } from '@maka/storage/runtime-policy-stores';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootReader,
} from '@maka/storage/root-authority';
import { writeConnections } from '../e2e-fixture/scenarios-settings.js';

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);

test('settings fixture projects a complete current-format connection profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-policy-fixture-'));
  try {
    await writeConnections(root, NOW, 'settings-connections');
    assert.deepEqual(await projectFixture(root), {
      files: {
        catalog: true,
        credentialVault: true,
        legacyConnections: false,
        legacyCredentials: false,
      },
      defaultTarget: { slug: 'zai-live', modelId: 'glm-5.1' },
      connections: [
        {
          slug: 'no-models',
          modelIds: [],
          modelSource: null,
          modelsFetchedAt: null,
          lastTest: null,
          hasApiKey: true,
        },
        {
          slug: 'zai-live',
          modelIds: [
            'glm-4.5',
            'glm-4.5-air',
            'glm-4.6',
            'glm-4.7',
            'glm-5',
            'glm-5-turbo',
            'glm-5.1',
          ],
          modelSource: 'fetched',
          modelsFetchedAt: NOW - 5 * 60_000,
          lastTest: {
            status: 'verified',
            checkedAt: new Date(NOW - 4 * 60_000).toISOString(),
          },
          hasApiKey: true,
        },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function projectFixture(root: string) {
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const reader = await tryAcquireInteractiveRootReader(capability);
  assert.ok(reader, 'fixture must release its writer before verification');
  try {
    const stores = await openInteractiveRuntimePolicyStoresForRead(reader.lease);
    const snapshot = await stores.connectionCatalog.getSnapshot();
    return {
      files: {
        catalog: await exists(root, 'connection-catalog.json'),
        credentialVault: await exists(root, 'credential-vault.json'),
        legacyConnections: await exists(root, 'llm-connections.json'),
        legacyCredentials: await exists(root, 'credentials.json'),
      },
      defaultTarget: projectDefaultTarget(snapshot),
      connections: await Promise.all(
        snapshot.connections.map(async (connection) => {
          const credential = await stores.credentialVault.getStatus({
            scope: 'connection',
            connectionId: connection.connectionId,
            kind: 'api_key',
          });
          return {
            slug: connection.slug,
            modelIds: connection.models.map(({ id }) => id),
            modelSource: connection.modelSource ?? null,
            modelsFetchedAt: connection.modelsFetchedAt ?? null,
            lastTest: connection.lastTest ?? null,
            hasApiKey: credential.kind === 'status' && credential.status.configured,
          };
        }),
      ),
    };
  } finally {
    await reader.close();
  }
}

function projectDefaultTarget(snapshot: ConnectionCatalogSnapshot) {
  if (!snapshot.defaultTarget) return null;
  const connection = snapshot.connections.find(
    ({ connectionId }) => connectionId === snapshot.defaultTarget?.connectionId,
  );
  assert.ok(connection, 'default target must reference a catalog entry');
  return { slug: connection.slug, modelId: snapshot.defaultTarget.modelId };
}

async function exists(root: string, name: string): Promise<boolean> {
  try {
    await stat(join(root, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
