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
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootReader,
} from '../../packages/storage/dist/root-authority.js';
import { openInteractiveRuntimePolicyStoresForRead } from '../../packages/storage/dist/runtime-policy-stores.js';
import { prepareProviderProfile } from './provider-profile.mjs';

test('OpenAI override creates only current Runtime Policy profile files', async () => {
  await withProfileDirectories(async ({ source, workspace }) => {
    await writeFile(join(source, 'settings.json'), '{"theme":"auto"}\n');
    await prepareProviderProfile({
      sourceWorkspace: source,
      workspace,
      provider: 'openai',
      environment: {
        MAKA_CU_OPENAI_MODEL: 'gpt-test',
        MAKA_CU_OPENAI_BASE_URL: 'https://relay.example/v1',
        MAKA_CU_OPENAI_API_KEY: 'test-key',
      },
    });

    assert.equal(await readFile(join(workspace, 'settings.json'), 'utf8'), '{"theme":"auto"}\n');
    await assert.rejects(() => stat(join(workspace, 'llm-connections.json')), isMissing);

    const capability = await resolveStorageRoot({ path: workspace, kind: 'interactive' });
    const reader = await tryAcquireInteractiveRootReader(capability);
    assert.ok(reader);
    try {
      const stores = await openInteractiveRuntimePolicyStoresForRead(reader.lease);
      const snapshot = await stores.connectionCatalog.getSnapshot();
      assert.equal(snapshot.connections.length, 1);
      const [connection] = snapshot.connections;
      assert.equal(connection?.slug, 'cu-real-openai');
      assert.equal(connection?.baseUrl, 'https://relay.example/v1');
      assert.deepEqual(connection?.enabledModelIds, ['gpt-test']);
      assert.deepEqual(snapshot.defaultTarget, {
        connectionId: connection?.connectionId,
        modelId: 'gpt-test',
      });
      const credential = await stores.credentialVault.getStatus({
        scope: 'connection',
        connectionId: connection?.connectionId ?? '',
        kind: 'api_key',
      });
      assert.equal(credential.kind, 'status');
      if (credential.kind === 'status') assert.equal(credential.status.configured, true);
    } finally {
      await reader.close();
    }
  });
});

test('default profile copies the catalog and available credential files', async () => {
  await withProfileDirectories(async ({ source, workspace }) => {
    const files = new Map([
      ['connection-catalog.json', 'catalog'],
      ['credential-vault.json', 'vault'],
      ['settings.json', 'settings'],
    ]);
    await Promise.all([...files].map(([name, content]) => writeFile(join(source, name), content)));

    await prepareProviderProfile({ sourceWorkspace: source, workspace, provider: undefined });

    for (const [name, content] of files) {
      assert.equal(await readFile(join(workspace, name), 'utf8'), content);
    }
    await assert.rejects(() => stat(join(workspace, 'credentials.json')), isMissing);
  });
});

async function withProfileDirectories(operation) {
  const root = await mkdtemp(join(tmpdir(), 'maka-provider-profile-'));
  const source = join(root, 'source');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(source), mkdir(workspace)]);
  try {
    await operation({ source, workspace });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}
