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

  it('drops enabled ids the account does not list once discovery is authoritative', async () => {
    // An OAuth login creates the Connection before a credential exists, so its
    // enabled ids are the curated fallback guess. Testing or sending to one the
    // account never had fails while naming a model the user did not choose.
    const { client, catalog, selected } = discoveringAccountClient(
      ['fallback-only', 'gpt-5-codex'],
      [{ id: 'gpt-5-codex' }, { id: 'gpt-5-codex-mini' }],
    );

    await synchronizeRuntimeHostAccountConnection(client, 'openai-codex');

    assert.deepEqual(catalog().connections[0]?.enabledModelIds, ['gpt-5-codex']);
    assert.deepEqual(selected(), { connectionId: CONNECTION_ID, modelId: 'gpt-5-codex' });
  });

  it('adopts the discovered inventory when no enabled id survives', async () => {
    const { client, catalog } = discoveringAccountClient(
      ['fallback-only', 'another-guess'],
      [{ id: 'gpt-5-codex' }, { id: 'gpt-5-codex-mini' }],
    );

    await synchronizeRuntimeHostAccountConnection(client, 'openai-codex');

    assert.deepEqual(catalog().connections[0]?.enabledModelIds, [
      'gpt-5-codex',
      'gpt-5-codex-mini',
    ]);
  });

  it('keeps a narrower selection the user made', async () => {
    const { client, catalog, updateCalls } = discoveringAccountClient(
      ['gpt-5-codex'],
      [{ id: 'gpt-5-codex' }, { id: 'gpt-5-codex-mini' }],
    );

    await synchronizeRuntimeHostAccountConnection(client, 'openai-codex');

    // Ids are dropped, never added: discovery must not re-enable what the user
    // turned off.
    assert.deepEqual(catalog().connections[0]?.enabledModelIds, ['gpt-5-codex']);
    assert.equal(updateCalls(), 0);
  });

  it('leaves the enabled ids alone when discovery did not commit', async () => {
    const { client, catalog, updateCalls } = discoveringAccountClient(
      ['fallback-only'],
      [{ id: 'gpt-5-codex' }],
      'fallback',
    );

    await synchronizeRuntimeHostAccountConnection(client, 'openai-codex');

    assert.deepEqual(catalog().connections[0]?.enabledModelIds, ['fallback-only']);
    assert.equal(updateCalls(), 0);
  });
});

/**
 * A client whose discovery commits an inventory, so the enabled ids can be
 * reconciled against something authoritative.
 */
function discoveringAccountClient(
  enabledModelIds: readonly string[],
  models: readonly { id: string }[],
  modelSource: 'fetched' | 'fallback' = 'fetched',
): {
  readonly client: RuntimeHostAccountConnectionClient;
  catalog(): ConnectionCatalogSnapshot;
  selected(): ConnectionTarget | null | undefined;
  updateCalls(): number;
} {
  let catalog: ConnectionCatalogSnapshot = {
    ...catalogWithoutDefault(),
    connections: [
      {
        ...catalogWithoutDefault().connections[0]!,
        enabledModelIds: [...enabledModelIds],
        models: [...models],
        modelSource,
      },
    ],
  };
  let selected: ConnectionTarget | null | undefined;
  let updates = 0;
  const client = {
    loadConnectionCatalog: async (): Promise<ConnectionCatalogSnapshot> => catalog,
    fetchConnectionModels: async () => ({
      kind: 'committed' as const,
      catalogRevision: catalog.revision,
      connection: {
        connectionId: CONNECTION_ID,
        revision: catalog.connections[0]?.revision ?? 1,
      },
      modelCount: models.length,
      source: modelSource,
      fetchedAt: 1,
    }),
    updateConnection: async (
      expected: { connectionId: string; revision: number },
      changes: { enabledModelIds?: string[] },
    ) => {
      updates += 1;
      const current = catalog.connections[0]!;
      assert.deepEqual(expected, {
        connectionId: current.connectionId,
        revision: current.revision,
      });
      const updated = {
        ...current,
        ...(changes.enabledModelIds ? { enabledModelIds: changes.enabledModelIds } : {}),
        revision: current.revision + 1,
      };
      catalog = { ...catalog, revision: catalog.revision + 1, connections: [updated] };
      return {
        kind: 'committed' as const,
        catalogRevision: catalog.revision,
        connection: { connectionId: updated.connectionId, revision: updated.revision },
      };
    },
    setDefaultConnectionTarget: async (
      expectedCatalogRevision: number,
      target: ConnectionTarget | null,
    ) => {
      assert.equal(expectedCatalogRevision, catalog.revision);
      selected = target;
      catalog = { ...catalog, revision: catalog.revision + 1, defaultTarget: target };
      return { kind: 'committed' as const, catalogRevision: catalog.revision };
    },
  } as unknown as RuntimeHostAccountConnectionClient;
  return {
    client,
    catalog: () => catalog,
    selected: () => selected,
    updateCalls: () => updates,
  };
}
