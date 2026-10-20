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

import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '../../packages/storage/dist/root-authority.js';
import { openInteractiveRuntimePolicyStoresForWrite } from '../../packages/storage/dist/runtime-policy-stores.js';

export async function prepareProviderProfile({
  workspace,
  sourceWorkspace,
  provider,
  environment = process.env,
}) {
  if (provider === undefined) {
    await copyCurrentProfile(sourceWorkspace, workspace);
    return;
  }
  if (provider !== 'openai') throw new Error(`unsupported MAKA_CU_PROVIDER ${provider}`);

  await copyRequired(sourceWorkspace, workspace, 'settings.json');
  await writeOpenAiProfile(workspace, {
    modelId: environment.MAKA_CU_OPENAI_MODEL ?? 'gpt-5.4',
    baseUrl: environment.MAKA_CU_OPENAI_BASE_URL ?? 'http://127.0.0.1:8538/v1',
    apiKey: environment.MAKA_CU_OPENAI_API_KEY ?? 'local-bridge',
  });
}

async function copyCurrentProfile(source, destination) {
  await copyRequired(source, destination, 'connection-catalog.json');
  await Promise.all([
    copyRequired(source, destination, 'settings.json'),
    copyOptional(source, destination, 'credential-vault.json'),
    copyOptional(source, destination, 'credentials.json'),
  ]);
}

async function copyRequired(source, destination, name) {
  await cp(join(source, name), join(destination, name), { errorOnExist: true });
}

async function copyOptional(source, destination, name) {
  try {
    await copyRequired(source, destination, name);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function writeOpenAiProfile(workspace, input) {
  await withPolicyWriter(workspace, async (stores) => {
    const created = committed(
      await stores.connectionCatalog.create({
        expectedCatalogRevision: 0,
        connection: {
          slug: 'cu-real-openai',
          name: 'Computer Use real-model OpenAI',
          providerType: 'openai',
          baseUrl: input.baseUrl,
          enabled: true,
          enabledModelIds: [input.modelId],
        },
      }),
      'create OpenAI connection',
    );
    const connection = created.snapshot.connections.find(({ slug }) => slug === 'cu-real-openai');
    if (!connection) throw new Error('OpenAI connection was absent after catalog commit');

    committed(
      await stores.credentialVault.set({
        locator: {
          scope: 'connection',
          connectionId: connection.connectionId,
          kind: 'api_key',
        },
        expected: null,
        secret: input.apiKey,
      }),
      'store OpenAI credential',
    );
    committed(
      await stores.connectionCatalog.setDefaultTarget({
        expectedCatalogRevision: created.snapshot.revision,
        target: { connectionId: connection.connectionId, modelId: input.modelId },
      }),
      'select OpenAI default target',
    );
  });
}

async function withPolicyWriter(workspace, operation) {
  const capability = await resolveStorageRoot({ path: workspace, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) throw new Error('Computer Use profile could not acquire its storage root');
  try {
    await operation(await openInteractiveRuntimePolicyStoresForWrite(owner.lease));
  } finally {
    await owner.close();
  }
}

function committed(result, operation) {
  if (result.kind !== 'committed') throw new Error(`Could not ${operation}: ${result.kind}`);
  return result;
}
