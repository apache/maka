import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import {
  formatRuntimeHostCliTaskBlockers,
  isRuntimeHostCliTaskBlocked,
  readRuntimeHostCliTaskReadiness,
} from '../runtime-host-task-readiness.js';

test('CLI preflight projects a ready first task from Host-owned authorities', async () => {
  const snapshot = await readRuntimeHostCliTaskReadiness(
    {
      connection: credentialConnection(true),
      catalog: catalog(),
      cwd: process.cwd(),
    },
    () => 42,
  );

  assert.equal(snapshot.state, 'ready');
  assert.equal(isRuntimeHostCliTaskBlocked(snapshot), false);
  assert.deepEqual(
    snapshot.dimensions.map((dimension) => dimension.id),
    ['runtime', 'model_target', 'workspace'],
  );
});

test('CLI preflight presents stable repair guidance before submission', async () => {
  const snapshot = await readRuntimeHostCliTaskReadiness(
    {
      connection: credentialConnection(false),
      catalog: catalog(),
      cwd: process.cwd(),
    },
    () => 43,
  );

  assert.equal(snapshot.state, 'repair_required');
  assert.equal(isRuntimeHostCliTaskBlocked(snapshot), true);
  assert.equal(
    formatRuntimeHostCliTaskBlockers(snapshot),
    'model_missing_api_key: repair connection "openai-main" in `maka`',
  );
});

test('CLI preflight keeps unavailable credential observations non-blocking', async () => {
  const snapshot = await readRuntimeHostCliTaskReadiness(
    {
      connection: {
        request: async () => {
          throw new Error('credential store is temporarily unavailable');
        },
      } as unknown as RuntimeHostConnection,
      catalog: catalog(),
      cwd: process.cwd(),
    },
    () => 44,
  );

  assert.equal(snapshot.state, 'unknown');
  assert.equal(snapshot.blockers[0]?.blockerCode, 'model_credentials_unknown');
  assert.equal(isRuntimeHostCliTaskBlocked(snapshot), false);
});

function credentialConnection(configured: boolean): RuntimeHostConnection {
  return {
    request: async (operation: string) => {
      assert.equal(operation, 'credential.vault.query');
      return {
        kind: 'status',
        status: {
          locator: { scope: 'connection', connectionId: 'connection-1', kind: 'api_key' },
          configured,
          credentialId: configured ? 'credential-1' : null,
          revision: configured ? 1 : null,
          updatedAt: configured ? 1 : null,
        },
      };
    },
  } as unknown as RuntimeHostConnection;
}

function catalog(): ConnectionCatalogSnapshot {
  return {
    revision: 1,
    defaultTarget: { connectionId: 'connection-1', modelId: 'gpt-5' },
    connections: [
      {
        connectionId: 'connection-1',
        revision: 1,
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai',
        enabled: true,
        enabledModelIds: ['gpt-5'],
        models: [{ id: 'gpt-5', capabilities: { chat: true } }],
      },
    ],
  };
}
