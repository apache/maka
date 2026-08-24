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
import { describe, it } from 'node:test';
import type { ConnectionCatalogSnapshot, ConnectionTarget } from '@maka/core/runtime-policy';
import {
  synchronizeRuntimeHostAccountConnection,
  type RuntimeHostAccountConnectionClient,
} from '../runtime-host-account-connection.js';

type FetchModels = RuntimeHostAccountConnectionClient['fetchConnectionModels'];

const CONNECTION_ID = '00000000-0000-4000-8000-0000000000a1';

function catalogWithoutDefault(): ConnectionCatalogSnapshot {
  return {
    revision: 4,
    defaultTarget: null,
    connections: [
      {
        connectionId: CONNECTION_ID,
        revision: 2,
        slug: 'codex-subscription',
        name: 'Codex OAuth',
        providerType: 'openai-codex',
        enabled: true,
        enabledModelIds: ['gpt-5-codex', 'gpt-5-codex-mini'],
        models: [{ id: 'gpt-5-codex' }, { id: 'gpt-5-codex-mini' }],
        modelSource: 'fallback',
        modelsFetchedAt: 0,
      },
    ],
  };
}

function accountClient(
  fetchConnectionModels: FetchModels,
  initial: ConnectionCatalogSnapshot = catalogWithoutDefault(),
): {
  readonly client: RuntimeHostAccountConnectionClient;
  selected(): ConnectionTarget | null | undefined;
  selectCalls(): number;
} {
  let catalog = initial;
  let selected: ConnectionTarget | null | undefined;
  let calls = 0;
  const client = {
    loadConnectionCatalog: async (): Promise<ConnectionCatalogSnapshot> => catalog,
    fetchConnectionModels,
    setDefaultConnectionTarget: async (
      expectedCatalogRevision: number,
      target: ConnectionTarget | null,
    ) => {
      calls += 1;
      assert.equal(expectedCatalogRevision, catalog.revision);
      selected = target;
      catalog = { ...catalog, revision: catalog.revision + 1, defaultTarget: target };
      return { kind: 'committed' as const, catalogRevision: catalog.revision };
    },
  } as unknown as RuntimeHostAccountConnectionClient;
  return { client, selected: () => selected, selectCalls: () => calls };
}

describe('synchronizeRuntimeHostAccountConnection', () => {
  it('selects a default model when model discovery is rejected', async () => {
    // A subscription connection serves the curated fallback inventory because
    // its provider exposes no usable model endpoint. Discovery never commits,
    // but the connection still has models, so the account must end up usable.
    const rejected: FetchModels = async () => ({
      kind: 'rejected',
      reason: 'provider_action_unavailable',
    });
    const { client, selected } = accountClient(rejected);

    await synchronizeRuntimeHostAccountConnection(client, 'openai-codex');

    assert.deepEqual(selected(), { connectionId: CONNECTION_ID, modelId: 'gpt-5-codex' });
  });

  it('selects a default model when model discovery throws', async () => {
    const throwing: FetchModels = async () => {
      throw new Error('network down');
    };
    const { client, selected } = accountClient(throwing);

    await synchronizeRuntimeHostAccountConnection(client, 'openai-codex');

    assert.deepEqual(selected(), { connectionId: CONNECTION_ID, modelId: 'gpt-5-codex' });
  });

  it('leaves an existing default alone', async () => {
    const rejected: FetchModels = async () => ({
      kind: 'rejected',
      reason: 'provider_action_unavailable',
    });
    const { client, selectCalls } = accountClient(rejected, {
      ...catalogWithoutDefault(),
      defaultTarget: { connectionId: CONNECTION_ID, modelId: 'gpt-5-codex-mini' },
    });

    await synchronizeRuntimeHostAccountConnection(client, 'openai-codex');

    assert.equal(selectCalls(), 0);
  });
});
