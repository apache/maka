import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ConnectionCatalogEntry,
  ConnectionCatalogSnapshot,
} from '@maka/core/runtime-policy';
import type { LlmConnection } from '@maka/core/llm-connections';
import { saveConnection } from '../runtime-host-config-ipc-main.js';

function existingConnection(overrides: Partial<ConnectionCatalogEntry> = {}): ConnectionCatalogEntry {
  return {
    connectionId: 'connection-1',
    revision: 4,
    slug: 'my-relay',
    name: 'Relay',
    providerType: 'openai-compatible',
    baseUrl: 'https://relay.example/v1',
    enabled: true,
    enabledModelIds: ['model-1'],
    models: [{ id: 'model-1' }],
    ...overrides,
  };
}

function snapshot(connections: ConnectionCatalogEntry[]): ConnectionCatalogSnapshot {
  return { revision: 7, defaultTarget: null, connections };
}

function fakeClient(existing: ConnectionCatalogEntry) {
  const updatePatches: Record<string, unknown>[] = [];
  let connections = [existing];
  const client = {
    async loadConnectionCatalog() {
      return snapshot(connections);
    },
    async updateConnection(
      _expected: { connectionId: string; revision: number },
      patch: Record<string, unknown>,
    ) {
      updatePatches.push(patch);
      connections = [
        {
          ...existing,
          revision: existing.revision + 1,
          ...(patch.relayModelProfiles === null || patch.relayModelProfiles === undefined
            ? {}
            : {
                relayModelProfiles: patch.relayModelProfiles as ConnectionCatalogEntry['relayModelProfiles'],
              }),
        },
      ];
      return { kind: 'committed' as const };
    },
  };
  return { client, updatePatches };
}

test('import overwrite with a profile-free snapshot CLEARS existing relay profiles', async () => {
  // Importing is snapshot replacement: the Host update contract treats an
  // ABSENT relayModelProfiles as "untouched", which would resurrect the old
  // declarations after a "no profiles here" backup.
  const { client, updatePatches } = fakeClient(
    existingConnection({ relayModelProfiles: { 'model-1': { vision: true } } }),
  );
  const incoming: LlmConnection = {
    slug: 'my-relay',
    name: 'Relay',
    providerType: 'openai-compatible',
    baseUrl: 'https://relay.example/v1',
    defaultModel: 'model-1',
    enabled: true,
    enabledModelIds: ['model-1'],
    createdAt: 0,
    updatedAt: 0,
  };

  await saveConnection(client as never, incoming);

  assert.equal(updatePatches.length, 1);
  assert.equal(updatePatches[0]?.relayModelProfiles, null);
});

test('import overwrite with profiles REPLACES the existing table', async () => {
  const { client, updatePatches } = fakeClient(
    existingConnection({ relayModelProfiles: { 'model-1': { vision: true } } }),
  );
  const incoming: LlmConnection = {
    slug: 'my-relay',
    name: 'Relay',
    providerType: 'openai-compatible',
    baseUrl: 'https://relay.example/v1',
    defaultModel: 'model-1',
    enabled: true,
    enabledModelIds: ['model-1'],
    createdAt: 0,
    updatedAt: 0,
    relayModelProfiles: { 'model-1': { contextWindow: 64_000 } },
  };

  await saveConnection(client as never, incoming);

  assert.equal(updatePatches.length, 1);
  assert.deepEqual(updatePatches[0]?.relayModelProfiles, {
    'model-1': { contextWindow: 64_000 },
  });
});
