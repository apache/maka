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
        slug: 'claude-subscription',
        name: 'Claude OAuth',
        providerType: 'claude-subscription',
        enabled: true,
        enabledModelIds: ['claude-opus-5', 'claude-haiku-4-5'],
        models: [{ id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' }],
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

    await synchronizeRuntimeHostAccountConnection(client, 'claude-subscription');

    assert.deepEqual(selected(), { connectionId: CONNECTION_ID, modelId: 'claude-opus-5' });
  });

  it('selects a default model when model discovery throws', async () => {
    const throwing: FetchModels = async () => {
      throw new Error('network down');
    };
    const { client, selected } = accountClient(throwing);

    await synchronizeRuntimeHostAccountConnection(client, 'claude-subscription');

    assert.deepEqual(selected(), { connectionId: CONNECTION_ID, modelId: 'claude-opus-5' });
  });

  it('leaves an existing default alone', async () => {
    const rejected: FetchModels = async () => ({
      kind: 'rejected',
      reason: 'provider_action_unavailable',
    });
    const { client, selectCalls } = accountClient(rejected, {
      ...catalogWithoutDefault(),
      defaultTarget: { connectionId: CONNECTION_ID, modelId: 'claude-haiku-4-5' },
    });

    await synchronizeRuntimeHostAccountConnection(client, 'claude-subscription');

    assert.equal(selectCalls(), 0);
  });
});
