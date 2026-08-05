import assert from 'node:assert/strict';
import test from 'node:test';
import type { IpcMainInvokeEvent } from 'electron';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import type { ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import {
  registerRuntimeHostOAuthIpc,
  type RuntimeHostOAuthIpcDeps,
} from '../runtime-host-oauth-ipc-main.js';
import { RuntimeHostOAuthPresentation } from '../runtime-host-oauth-presentation.js';

test('presents both Host OAuth methods without exposing the authorization URL', async () => {
  const opened: string[] = [];
  const presentation = new RuntimeHostOAuthPresentation(async (url) => {
    opened.push(url);
  });
  const external = presentation.expect('external-attempt');
  await presentation.openExternal(
    'https://auth.example/device',
    'DEVICE-CODE',
    new AbortController().signal,
  );
  assert.deepEqual(await external.presented, {
    method: 'open_external',
    stateHint: 'DEVICE-CODE',
  });

  const pasted = presentation.expect('code-attempt');
  const code = presentation.requestAuthorizationCode(
    'https://auth.example/authorize',
    'STATE-HINT',
    new AbortController().signal,
  );
  assert.deepEqual(await pasted.presented, {
    method: 'request_authorization_code',
    stateHint: 'STATE-HINT',
  });
  assert.equal(presentation.submitAuthorizationCode('code-attempt', 'code#state'), true);
  assert.equal(await code, 'code#state');
  assert.deepEqual(opened, [
    'https://auth.example/device',
    'https://auth.example/authorize',
  ]);
});

test('adapts every Host OAuth provider through one Desktop flow', async () => {
  const provider = 'claude-subscription' as const;
  const handlers = new Map<
    string,
    Parameters<RuntimeHostOAuthIpcDeps['ipcMain']['handle']>[1]
  >();
  const opened: string[] = [];
  const presentation = new RuntimeHostOAuthPresentation(async (url) => {
    opened.push(url);
  });
  const modelId = PROVIDER_DEFAULTS[provider].fallbackModels[0];
  assert.ok(modelId);
  let phase: 'awaiting_authorization' | 'authenticated' | 'cancelled' =
    'awaiting_authorization';
  let attemptId = '';
  let changed = 0;
  let catalog: ConnectionCatalogSnapshot = {
    revision: 1,
    defaultTarget: null,
    connections: [
      {
        connectionId: '00000000-0000-4000-8000-000000000001',
        revision: 1,
        slug: 'claude-subscription',
        name: 'Claude Code',
        providerType: provider,
        enabled: true,
        enabledModelIds: [...PROVIDER_DEFAULTS[provider].fallbackModels],
        models: [],
      },
    ],
  };
  const client = {
    loadConnectionCatalog: async () => catalog,
    createConnection: async () => {
      throw new Error('Existing OAuth Connection must be reused');
    },
    updateConnection: async () => {
      throw new Error('Enabled OAuth Connection must not be rewritten');
    },
    startOAuthLogin: async (nextAttemptId, connectionId) => {
      attemptId = nextAttemptId;
      void presentation
        .requestAuthorizationCode(
          'https://claude.example/authorize',
          'STATE-HINT',
          new AbortController().signal,
        )
        .then((authorizationCode) => {
          assert.equal(authorizationCode, 'authorization-code#state');
          phase = 'authenticated';
        });
      return oauthProjection(nextAttemptId, connectionId, 'awaiting_authorization');
    },
    queryOAuthLogin: async (nextAttemptId) =>
      oauthProjection(
        nextAttemptId,
        catalog.connections[0]?.connectionId ?? '',
        phase,
      ),
    cancelOAuthLogin: async (nextAttemptId) => {
      phase = 'cancelled';
      return oauthProjection(
        nextAttemptId,
        catalog.connections[0]?.connectionId ?? '',
        phase,
      );
    },
    fetchConnectionModels: async () => {
      const current = catalog.connections[0];
      assert.ok(current);
      const updated = {
        ...current,
        revision: current.revision + 1,
        models: [{ id: modelId }],
        modelSource: 'fetched' as const,
        modelsFetchedAt: 1,
      };
      catalog = {
        revision: catalog.revision + 1,
        defaultTarget: null,
        connections: [updated],
      };
      return {
        kind: 'committed' as const,
        catalogRevision: catalog.revision,
        connection: { connectionId: updated.connectionId, revision: updated.revision },
        modelCount: 1,
        source: 'fetched' as const,
        fetchedAt: 1,
      };
    },
    fetchOAuthAccountUsage: async () => ({
      kind: 'available' as const,
      provider,
      quota: {
        fiveHour: { utilization: 20, resetsAt: '2026-08-05T12:00:00.000Z' },
        fetchedAt: 1,
      },
    }),
    setDefaultConnectionTarget: async (expectedCatalogRevision, target) => {
      assert.equal(expectedCatalogRevision, catalog.revision);
      catalog = { ...catalog, revision: catalog.revision + 1, defaultTarget: target };
      return { kind: 'committed' as const, catalogRevision: catalog.revision };
    },
    queryCredential: async (locator) =>
      phase === 'authenticated'
        ? {
            locator,
            configured: true as const,
            credentialId: '00000000-0000-4000-8000-000000000002',
            revision: 1,
            updatedAt: 1,
          }
        : null,
    deleteCredential: async ({ expected }) => ({
      kind: 'committed' as const,
      vaultRevision: 1,
      status: {
        locator: expected.locator,
        configured: false as const,
        credentialId: null,
        revision: null,
        updatedAt: null,
      },
    }),
  } satisfies RuntimeHostOAuthIpcDeps['client'];

  registerRuntimeHostOAuthIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    client,
    presentation,
    emitConnectionListChanged: () => {
      changed += 1;
    },
    isProviderEnabled: () => true,
  });

  for (const prefix of ['claude-subscription', 'openai-codex', 'xai-oauth']) {
    assert.equal(handlers.has(`${prefix}:get-auth-url`), true);
    assert.equal(handlers.has(`${prefix}:complete-authorization`), true);
    assert.equal(handlers.has(`${prefix}:get-account-state`), true);
    assert.equal(handlers.has(`${prefix}:logout`), true);
  }
  assert.equal(
    await invoke(handlers, 'antigravity-subscription:is-experimental-enabled'),
    false,
  );
  assert.deepEqual(
    await invoke(handlers, 'antigravity-subscription:get-account-state'),
    {
      provider: 'antigravity-subscription',
      status: 'preview',
      runtimeState: 'not_logged_in',
    },
  );
  const authorization = await invoke(handlers, 'claude-subscription:get-auth-url');
  assert.deepEqual(authorization, { authRequestId: attemptId, stateHint: 'STATE-HINT' });
  assert.deepEqual(opened, ['https://claude.example/authorize']);
  assert.deepEqual(
    await invoke(
      handlers,
      'claude-subscription:complete-authorization',
      attemptId,
      'authorization-code#state',
    ),
    { ok: true },
  );
  assert.equal(changed, 1);
  assert.deepEqual(catalog.defaultTarget, {
    connectionId: catalog.connections[0]?.connectionId,
    modelId,
  });
  assert.deepEqual(await invoke(handlers, 'claude-subscription:refresh-quota'), {
    ok: true,
  });
  assert.deepEqual(await invoke(handlers, 'claude-subscription:get-account-state'), {
    provider,
    runtimeState: 'authenticated',
    quota: {
      fiveHour: { utilization: 20, resetsAt: '2026-08-05T12:00:00.000Z' },
      fetchedAt: 1,
    },
  });
});

test('keeps a committed OAuth login successful when model discovery fails', async () => {
  const provider = 'openai-codex' as const;
  const connection = {
    connectionId: '00000000-0000-4000-8000-000000000002',
    revision: 1,
    slug: 'codex-subscription',
    name: 'OpenAI Codex',
    providerType: provider,
    enabled: true,
    enabledModelIds: [...PROVIDER_DEFAULTS[provider].fallbackModels],
    models: [],
  };
  const catalog: ConnectionCatalogSnapshot = {
    revision: 1,
    defaultTarget: null,
    connections: [connection],
  };
  const handlers = new Map<
    string,
    Parameters<RuntimeHostOAuthIpcDeps['ipcMain']['handle']>[1]
  >();
  const presentation = new RuntimeHostOAuthPresentation(async () => undefined);
  let attemptId = '';
  let changed = 0;
  const client = {
    loadConnectionCatalog: async () => catalog,
    createConnection: async () => {
      throw new Error('Existing OAuth Connection must be reused');
    },
    updateConnection: async () => {
      throw new Error('Enabled OAuth Connection must not be rewritten');
    },
    startOAuthLogin: async (nextAttemptId: string) => {
      attemptId = nextAttemptId;
      await presentation.openExternal(
        'https://auth.example/device',
        'DEVICE-CODE',
        new AbortController().signal,
      );
      return {
        attemptId: nextAttemptId,
        connectionId: connection.connectionId,
        provider,
        phase: 'awaiting_authorization' as const,
      };
    },
    queryOAuthLogin: async (nextAttemptId: string) => ({
      attemptId: nextAttemptId,
      connectionId: connection.connectionId,
      provider,
      phase: 'authenticated' as const,
    }),
    cancelOAuthLogin: async (nextAttemptId: string) => ({
      attemptId: nextAttemptId,
      connectionId: connection.connectionId,
      provider,
      phase: 'cancelled' as const,
    }),
    fetchConnectionModels: async () => {
      throw new Error('provider temporarily unavailable');
    },
    fetchOAuthAccountUsage: async () => ({
      kind: 'unavailable' as const,
      reason: 'provider_unavailable' as const,
    }),
    setDefaultConnectionTarget: async () => {
      throw new Error('Default selection must not run after failed discovery');
    },
    queryCredential: async () => null,
    deleteCredential: async () => {
      throw new Error('Credential deletion must not run');
    },
  } satisfies RuntimeHostOAuthIpcDeps['client'];

  registerRuntimeHostOAuthIpc({
    ipcMain: { handle: (channel, handler) => void handlers.set(channel, handler) },
    client,
    presentation,
    emitConnectionListChanged: () => {
      changed += 1;
    },
    isProviderEnabled: () => true,
  });

  assert.deepEqual(await invoke(handlers, 'openai-codex:get-auth-url'), {
    authRequestId: attemptId,
    stateHint: 'DEVICE-CODE',
  });
  assert.deepEqual(
    await invoke(handlers, 'openai-codex:complete-authorization', attemptId, undefined),
    { ok: true },
  );
  assert.equal(changed, 1);
});

function oauthProjection(
  attemptId: string,
  connectionId: string,
  phase: 'awaiting_authorization' | 'authenticated' | 'cancelled',
) {
  return {
    attemptId,
    connectionId,
    provider: 'claude-subscription' as const,
    phase,
  };
}

async function invoke(
  handlers: ReadonlyMap<
    string,
    Parameters<RuntimeHostOAuthIpcDeps['ipcMain']['handle']>[1]
  >,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler({} as IpcMainInvokeEvent, ...args);
}
