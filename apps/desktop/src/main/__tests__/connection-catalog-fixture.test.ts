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
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { writeConnections } from '../e2e-fixture/scenarios-settings.js';

test('connection fixture seeds the Runtime Policy catalog, not llm-connections.json', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-connection-catalog-fixture-'));
  const now = Date.UTC(2026, 7, 16, 12, 0, 0);
  try {
    await writeConnections(workspaceRoot, now, 'settings-models');

    for (const unexpectedFile of ['llm-connections.json', 'credentials.json']) {
      await assert.rejects(
        () => access(join(workspaceRoot, unexpectedFile)),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
    }
    await access(join(workspaceRoot, 'credential-vault.json'));

    const capability = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
      const snapshot = await stores.connectionCatalog.getSnapshot();
      assert.deepEqual(
        snapshot.connections.map((connection) => connection.slug),
        ['no-models', 'zai-live'],
      );
      const zai = snapshot.connections.find((connection) => connection.slug === 'zai-live');
      const noModels = snapshot.connections.find((connection) => connection.slug === 'no-models');
      assert.ok(zai);
      assert.ok(noModels);
      assert.deepEqual(snapshot.defaultTarget, {
        connectionId: zai.connectionId,
        modelId: 'glm-5.1',
      });
      assert.deepEqual(
        zai.models.map((item) => item.id),
        [
          'glm-4.5',
          'glm-4.5-air',
          'glm-4.6',
          'glm-4.7',
          'glm-5',
          'glm-5-turbo',
          'glm-5.1',
        ],
      );
      assert.equal(zai.modelSource, 'fetched');
      assert.equal(zai.modelsFetchedAt, now - 5 * 60_000);
      assert.deepEqual(zai.lastTest, {
        status: 'verified',
        checkedAt: new Date(now - 4 * 60_000).toISOString(),
      });
      assert.deepEqual(noModels.models, []);
      assert.equal(noModels.modelSource, undefined);
      assert.equal(noModels.lastTest, undefined);
      for (const connection of [zai, noModels]) {
        const credential = await stores.credentialVault.getStatus({
          scope: 'connection',
          connectionId: connection.connectionId,
          kind: 'api_key',
        });
        assert.equal(credential.kind, 'status');
        if (credential.kind === 'status') assert.equal(credential.status.configured, true);
      }
    } finally {
      await owner.close();
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
