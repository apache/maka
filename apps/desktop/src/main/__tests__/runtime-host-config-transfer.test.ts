import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type {
  ConnectionCatalogEntry,
  ConnectionCatalogSnapshot,
} from '@maka/core/runtime-policy';
import {
  projectHostConnections,
} from '../runtime-host-connections-ipc-main.js';
import {
  saveConnection,
  v2ExportedConnections,
} from '../runtime-host-config-ipc-main.js';
import type { DesktopRuntimeHostClient } from '../runtime-host-client.js';

const MODEL = { id: 'gpt-5', capabilities: { chat: true } };

function connection(overrides: Partial<ConnectionCatalogEntry> = {}): ConnectionCatalogEntry {
  return {
    connectionId: '123e4567-e89b-42d3-a456-426614174000',
    revision: 2,
    slug: 'openai-main',
    name: 'OpenAI',
    providerType: 'openai',
    enabled: true,
    enabledModelIds: ['gpt-5'],
    models: [MODEL],
    ...overrides,
  } as ConnectionCatalogEntry;
}

test('v2 export keeps routing strategy and declaration profile order', () => {
  const entry = connection({
    baseUrl: undefined,
    credentialRouting: {
      mode: 'balanced',
      strategy: 'priority_failover',
      profiles: [
        {
          profileId: 'secondary',
          revision: 3,
          label: 'backup',
          enabled: true,
          weight: 20,
        },
        {
          profileId: '123e4567-e89b-42d3-a456-426614174000',
          revision: 1,
          label: 'primary',
          enabled: true,
          weight: 1,
        },
      ],
    },
  });
  const [exported] = v2ExportedConnections([entry]);
  assert.equal(exported?.routingMode, 'balanced');
  assert.equal(exported?.routingStrategy, 'priority_failover');
  assert.deepEqual(
    exported?.credentialProfiles?.map((profile) => profile.profileRef),
    ['secondary-0', 'primary'],
  );
});

test('saveConnection emits an explicit baseUrl clear for snapshot default endpoint', async () => {
  const existing = connection({ baseUrl: 'https://proxy.example/v1' });
  let catalog: ConnectionCatalogSnapshot = {
    revision: 2,
    defaultTarget: null,
    connections: [existing],
  };
  let updateChanges: unknown;
  const client = {
    loadConnectionCatalog: async () => catalog,
    updateConnection: async (_expected: unknown, changes: unknown) => {
      updateChanges = changes;
      const next = projectHostConnections(catalog).map((item) => {
        if (item.slug !== existing.slug) return item;
        return { ...item, ...(changes as { name: string; enabled: boolean; enabledModelIds: string[] }) };
      });
      catalog = {
        revision: catalog.revision + 1,
        defaultTarget: null,
        connections: next.map((item, index) => connection({
          slug: item.slug,
          name: item.name,
          providerType: item.providerType,
          ...(item.baseUrl === undefined ? {} : { baseUrl: item.baseUrl }),
          enabled: item.enabled,
          enabledModelIds: item.enabledModelIds,
          models: item.models ?? [MODEL],
        })),
      };
      return {
        kind: 'committed' as const,
        catalogRevision: catalog.revision,
        connection: { connectionId: existing.connectionId, revision: existing.revision + 1 },
      };
    },
    createConnection: async () => {
      throw new Error('unexpected create');
    },
    removeConnection: async () => {
      throw new Error('unexpected remove');
    },
  } as unknown as DesktopRuntimeHostClient;

  const incoming: LlmConnection = {
    slug: 'openai-main',
    name: 'OpenAI',
    providerType: 'openai',
    enabled: true,
    defaultModel: 'gpt-5',
    enabledModelIds: ['gpt-5'],
    models: [MODEL],
    createdAt: 0,
    updatedAt: 0,
  };
  await saveConnection(client, incoming);
  assert.deepEqual(updateChanges, {
    name: 'OpenAI',
    baseUrl: null,
    enabled: true,
    enabledModelIds: ['gpt-5'],
    relayModelProfiles: null,
    requestBodyOverlay: null,
  });
});