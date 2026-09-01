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
import test from 'node:test';
import type { IpcMainInvokeEvent } from 'electron';
import { PROVIDER_REGISTRY } from '@maka/core/llm-connections';
import type {
  RuntimeHostConnectionCatalogEntry as ConnectionCatalogEntry,
  RuntimeHostConnectionCatalogSnapshot as ConnectionCatalogSnapshot,
} from '@maka/runtime-host/client';
import {
  RUNTIME_HOST_OAUTH_IPC_CHANNELS,
  registerRuntimeHostOAuthIpc,
  type RuntimeHostOAuthIpcDeps,
} from '../runtime-host-oauth-ipc-main.js';
import { RuntimeHostOAuthPresentation } from '../runtime-host-oauth-presentation.js';

type OAuthClient = RuntimeHostOAuthIpcDeps['client'];
type OAuthIpcHandler = Parameters<RuntimeHostOAuthIpcDeps['ipcMain']['handle']>[1];

test('presents the Host OAuth handoff without exposing the authorization URL', async () => {
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
  assert.deepEqual(await external.presented, { stateHint: 'DEVICE-CODE' });

  assert.deepEqual(opened, ['https://auth.example/device']);
});

test('adapts every Host OAuth provider through one Desktop flow', async () => {
  const provider = 'openai-codex' as const;
  const opened: string[] = [];
  const presentation = new RuntimeHostOAuthPresentation(async (url) => {
    opened.push(url);
  });
  const modelId = PROVIDER_REGISTRY[provider].fallbackModels[0];
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
        slug: 'openai-codex',
        name: 'OpenAI Codex',
        providerType: provider,
        enabled: true,
        enabledModelIds: [...PROVIDER_REGISTRY[provider].fallbackModels],
        catalogEntries: [],
        models: [],
      },
    ],
  };
  const clientOverrides = {
    loadConnectionCatalog: async () => catalog,
    startOAuthLogin: async (nextAttemptId, target) => {
      attemptId = nextAttemptId;
      assert.deepEqual(target, {
        kind: 'existing',
        connectionId: catalog.connections[0]?.connectionId,
      });
      // Codex device login presents through `open_external`: the browser
      // carries the authorization and the Host writes the credential back.
      void presentation
        .openExternal(
          'https://codex.example/authorize',
          'STATE-HINT',
          new AbortController().signal,
        )
        .then(() => {
          phase = 'authenticated';
        });
      return oauthProjection(
        nextAttemptId,
        target.kind === 'existing' ? target.connectionId : '',
        'awaiting_authorization',
      );
    },
    queryOAuthLogin: async (nextAttemptId) =>
      oauthProjection(
        nextAttemptId,
        catalog.connections[0]?.connectionId ?? '',
        phase,
      ),
    fetchConnectionModels: async () => {
      const current = catalog.connections[0];
      assert.ok(current);
      const updated = {
        ...current,
        revision: current.revision + 1,
        models: [{ id: modelId }],
        modelSource: 'fetched' as const,
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
  } satisfies Partial<OAuthClient>;
  const { handlers, assertNoUnexpectedClientCalls } = registerOAuthTestHandlers({
    clientOverrides,
    presentation,
    emitConnectionListChanged: () => {
      changed += 1;
    },
    isProviderEnabled: () => true,
  });

  assert.deepEqual([...handlers.keys()].sort(), [...RUNTIME_HOST_OAUTH_IPC_CHANNELS].sort());

  for (const prefix of ['openai-codex', 'xai-oauth']) {
    assert.equal(handlers.has(`${prefix}:get-auth-url`), true);
    assert.equal(handlers.has(`${prefix}:complete-authorization`), true);
    assert.equal(handlers.has(`${prefix}:get-account-state`), true);
    assert.equal(handlers.has(`${prefix}:logout`), true);
  }
  const authorization = await invoke(
    handlers,
    'openai-codex:get-auth-url',
    { kind: 'existing', connectionId: catalog.connections[0]?.connectionId },
  );
  const expectedConnection = {
    connectionId: catalog.connections[0]?.connectionId,
    slug: 'openai-codex',
    providerType: provider,
  };
  assert.deepEqual(authorization, {
    authRequestId: attemptId,
    stateHint: 'STATE-HINT',
    connection: expectedConnection,
  });
  assert.deepEqual(opened, ['https://codex.example/authorize']);
  assert.deepEqual(
    await invoke(
      handlers,
      'openai-codex:complete-authorization',
      attemptId,
      'authorization-code#state',
    ),
    { ok: true, connection: expectedConnection },
  );
  assert.equal(changed, 1);
  assert.deepEqual(catalog.defaultTarget, {
    connectionId: catalog.connections[0]?.connectionId,
    modelId,
  });
  // No quota: reporting it required the retired provider's own client identity,
  // so the account state carries the runtime state alone.
  assert.deepEqual(await invoke(
    handlers,
    'openai-codex:get-account-state',
    catalog.connections[0]?.connectionId,
  ), {
    provider,
    runtimeState: 'authenticated',
  });
  assertNoUnexpectedClientCalls();
});

test('provider-scoped OAuth IPC rejects a Connection ID owned by another provider', async () => {
  const xaiConnection = {
    connectionId: '00000000-0000-4000-8000-000000000009',
    revision: 1,
    slug: 'xai-oauth',
    name: 'xAI Grok',
    providerType: 'xai-oauth' as const,
    enabled: true,
    enabledModelIds: [...PROVIDER_REGISTRY['xai-oauth'].fallbackModels],
    catalogEntries: [],
    models: [],
  };
  let starts = 0;
  let mutations = 0;
  const clientOverrides = {
    loadConnectionCatalog: async () => ({
      revision: 1,
      defaultTarget: null,
      connections: [xaiConnection],
    }),
    queryCredential: async () => {
      throw new Error('Cross-provider IPC must not inspect another credential');
    },
    startOAuthLogin: async () => {
      starts += 1;
      throw new Error('Cross-provider IPC must not start Host OAuth');
    },
  } satisfies Partial<OAuthClient>;
  const { handlers, assertNoUnexpectedClientCalls } = registerOAuthTestHandlers({
    clientOverrides,
    presentation: new RuntimeHostOAuthPresentation(async () => undefined),
    emitConnectionListChanged: () => {
      mutations += 1;
    },
    isProviderEnabled: () => true,
  });

  assert.deepEqual(
    await invoke(handlers, 'openai-codex:get-auth-url', {
      kind: 'existing',
      connectionId: xaiConnection.connectionId,
    }),
    {
      ok: false,
      reason: 'unknown',
      message: 'OAuth account does not match this provider',
    },
  );
  assert.deepEqual(
    await invoke(handlers, 'openai-codex:get-account-state', xaiConnection.connectionId),
    {
      ok: false,
      reason: 'unknown',
      message: 'OAuth account does not match this provider',
    },
  );
  assert.deepEqual(
    await invoke(handlers, 'openai-codex:refresh-tokens', xaiConnection.connectionId),
    {
      ok: false,
      reason: 'refresh_failed',
      message: 'OAuth account does not match this provider',
    },
  );
  assert.deepEqual(await invoke(handlers, 'openai-codex:logout', xaiConnection.connectionId), {
    ok: false,
    reason: 'unknown',
    message: 'OAuth account does not match this provider',
  });
  assert.equal(starts, 0);
  assert.equal(mutations, 0);
  assertNoUnexpectedClientCalls();
});

test('malformed OAuth Connection IDs fail closed before catalog or credential access', async () => {
  let emissions = 0;
  const { handlers, assertNoUnexpectedClientCalls } = registerOAuthTestHandlers({
    clientOverrides: {},
    presentation: new RuntimeHostOAuthPresentation(async () => undefined),
    emitConnectionListChanged: () => {
      emissions += 1;
    },
    isProviderEnabled: () => true,
  });

  for (const malformed of [
    null,
    7,
    {},
    { kind: 'create', connectionId: '00000000-0000-4000-8000-000000000001' },
    { kind: 'existing', connectionId: '00000000-0000-4000-8000-000000000001', extra: true },
  ]) {
    assert.deepEqual(await invoke(handlers, 'openai-codex:get-auth-url', malformed), {
      ok: false,
      reason: 'unknown',
      message: 'Invalid OAuth Connection identity',
    });
    assert.deepEqual(await invoke(handlers, 'openai-codex:get-account-state', malformed), {
      ok: false,
      reason: 'unknown',
      message: 'Invalid OAuth Connection identity',
    });
    assert.deepEqual(await invoke(handlers, 'openai-codex:refresh-tokens', malformed), {
      ok: false,
      reason: 'refresh_failed',
      message: 'Invalid OAuth Connection identity',
    });
    assert.deepEqual(await invoke(handlers, 'openai-codex:logout', malformed), {
      ok: false,
      reason: 'unknown',
      message: 'Invalid OAuth Connection identity',
    });
  }
  assert.equal(emissions, 0);
  assertNoUnexpectedClientCalls();
});

test('a second OAuth start cannot replace or cancel a pending active attempt', async () => {
  const provider = 'openai-codex' as const;
  const connectionId = '00000000-0000-4000-8000-000000000011';
  const configuredConnections = [
    {
      connectionId: '00000000-0000-4000-8000-000000000012',
      revision: 1,
      slug: 'codex-subscription-2',
      name: 'OpenAI Codex 2',
      providerType: provider,
      enabled: true,
      enabledModelIds: [...PROVIDER_REGISTRY[provider].fallbackModels],
      catalogEntries: [],
      models: [],
    },
    {
      connectionId: '00000000-0000-4000-8000-000000000013',
      revision: 1,
      slug: 'codex-subscription-3',
      name: 'OpenAI Codex 3',
      providerType: provider,
      enabled: true,
      enabledModelIds: [...PROVIDER_REGISTRY[provider].fallbackModels],
      catalogEntries: [],
      models: [],
    },
  ];
  const foreignConnection = {
    connectionId: '00000000-0000-4000-8000-000000000014',
    revision: 1,
    slug: 'xai-oauth',
    name: 'xAI Grok',
    providerType: 'xai-oauth' as const,
    enabled: true,
    enabledModelIds: [...PROVIDER_REGISTRY['xai-oauth'].fallbackModels],
    catalogEntries: [],
    models: [],
  };
  const presentation = new RuntimeHostOAuthPresentation(async () => undefined);
  let starts = 0;
  let cancels = 0;
  let firstAttemptId = '';
  let phase: 'awaiting_authorization' | 'authenticated' = 'awaiting_authorization';
  let markFirstPresentationPoll!: () => void;
  const firstPresentationPoll = new Promise<void>((resolve) => {
    markFirstPresentationPoll = resolve;
  });
  const clientOverrides = {
    loadConnectionCatalog: async () => ({
      revision: 1,
      defaultTarget: null,
      connections: [...configuredConnections, foreignConnection],
    }),
    updateConnection: async (expected) => ({
      kind: 'committed' as const,
      catalogRevision: 2,
      connection: { connectionId: expected.connectionId, revision: expected.revision + 1 },
    }),
    deleteCredential: async ({ expected }) => ({
      kind: 'committed' as const,
      vaultRevision: 2,
      status: {
        locator: expected.locator,
        configured: false as const,
        credentialId: null,
        revision: null,
        updatedAt: null,
      },
    }),
    fetchConnectionModels: async () => {
      throw new Error('model discovery unavailable');
    },
    queryCredential: async (locator) => ({
      locator,
      configured: true as const,
      credentialId: '00000000-0000-4000-8000-000000000015',
      revision: 1,
      updatedAt: 1,
    }),
    startOAuthLogin: async (attemptId: string) => {
      starts += 1;
      if (starts === 2) throw new Error('Another OAuth login is already in progress');
      firstAttemptId = attemptId;
      return oauthProjection(attemptId, connectionId, 'awaiting_authorization');
    },
    queryOAuthLogin: async (attemptId: string) => {
      markFirstPresentationPoll();
      return oauthProjection(attemptId, connectionId, phase);
    },
    cancelOAuthLogin: async (attemptId: string) => {
      cancels += 1;
      return oauthProjection(attemptId, connectionId, 'cancelled');
    },
  } satisfies Partial<OAuthClient>;
  const { handlers, assertNoUnexpectedClientCalls } = registerOAuthTestHandlers({
    clientOverrides,
    presentation,
    emitConnectionListChanged: () => undefined,
    isProviderEnabled: () => true,
  });

  const firstAuthorization = invoke(handlers, 'openai-codex:get-auth-url', { kind: 'create' });
  await firstPresentationPoll;
  assert.deepEqual(await invoke(handlers, 'openai-codex:get-auth-url', { kind: 'create' }), {
    ok: false,
    reason: 'unknown',
    message: 'Another OAuth login is already in progress',
  });
  assert.equal(starts, 1);
  assert.equal(cancels, 0);
  await presentation.openExternal(
    'https://auth.example/device',
    'FIRST',
    new AbortController().signal,
  );
  phase = 'authenticated';
  assert.deepEqual(await firstAuthorization, {
    authRequestId: firstAttemptId,
    stateHint: 'FIRST',
    connection: {
      connectionId,
      slug: 'openai-codex',
      providerType: provider,
    },
  });
  assert.deepEqual(
    await invoke(handlers, 'openai-codex:logout', foreignConnection.connectionId),
    {
      ok: false,
      reason: 'unknown',
      message: 'OAuth account does not match this provider',
    },
  );
  assert.deepEqual(await invoke(handlers, 'openai-codex:logout'), {
    ok: false,
    reason: 'unknown',
    message: 'Invalid OAuth Connection identity',
  });
  assert.equal(cancels, 0);
  assert.deepEqual(
    await invoke(handlers, 'openai-codex:logout', configuredConnections[0]?.connectionId),
    { ok: true },
  );
  assert.equal(cancels, 0);
  assert.deepEqual(
    await invoke(handlers, 'openai-codex:complete-authorization', firstAttemptId),
    {
      ok: true,
      connection: {
        connectionId,
        slug: 'openai-codex',
        providerType: provider,
      },
    },
  );
  assert.equal(cancels, 0);
  assertNoUnexpectedClientCalls();
});

test('completion rejects a terminal projection that changes Connection identity', async () => {
  const presentation = new RuntimeHostOAuthPresentation(async () => undefined);
  const startedId = '00000000-0000-4000-8000-000000000021';
  const changedId = '00000000-0000-4000-8000-000000000022';
  let attemptId = '';
  let synchronized = 0;
  let emitted = 0;
  const clientOverrides = {
    loadConnectionCatalog: async () => ({ revision: 1, defaultTarget: null, connections: [] }),
    fetchConnectionModels: async () => {
      synchronized += 1;
      throw new Error('must not synchronize a changed identity');
    },
    startOAuthLogin: async (nextAttemptId: string) => {
      attemptId = nextAttemptId;
      await presentation.openExternal(
        'https://auth.example/device',
        'IDENTITY',
        new AbortController().signal,
      );
      return oauthProjection(nextAttemptId, startedId, 'awaiting_authorization');
    },
    queryOAuthLogin: async (nextAttemptId: string) =>
      oauthProjection(nextAttemptId, changedId, 'authenticated'),
  } satisfies Partial<OAuthClient>;
  const { handlers, assertNoUnexpectedClientCalls } = registerOAuthTestHandlers({
    clientOverrides,
    presentation,
    emitConnectionListChanged: () => {
      emitted += 1;
    },
    isProviderEnabled: () => true,
  });

  await invoke(handlers, 'openai-codex:get-auth-url', { kind: 'create' });
  assert.deepEqual(await invoke(handlers, 'openai-codex:complete-authorization', attemptId), {
    ok: false,
    reason: 'unknown',
    message: 'OAuth authorization changed Connection identity',
  });
  assert.equal(synchronized, 0);
  assert.equal(emitted, 0);
  assertNoUnexpectedClientCalls();
});

test('keeps a committed OAuth login successful when model discovery fails without replacing the existing default', async () => {
  const provider = 'openai-codex' as const;
  const modelId = PROVIDER_REGISTRY[provider].fallbackModels[0];
  assert.ok(modelId);
  const existing = {
    connectionId: '00000000-0000-4000-8000-000000000002',
    revision: 1,
    slug: 'codex-subscription',
    name: 'OpenAI Codex',
    providerType: provider,
    enabled: true,
    enabledModelIds: [...PROVIDER_REGISTRY[provider].fallbackModels],
    catalogEntries: [],
    models: [],
  };
  const created = {
    ...existing,
    connectionId: '00000000-0000-4000-8000-000000000003',
    slug: 'codex-subscription-2',
  };
  let catalog: ConnectionCatalogSnapshot = {
    revision: 1,
    defaultTarget: { connectionId: existing.connectionId, modelId },
    connections: [existing],
  };
  const presentation = new RuntimeHostOAuthPresentation(async () => undefined);
  let attemptId = '';
  let changed = 0;
  const fetchedConnectionIds: string[] = [];
  const clientOverrides = {
    loadConnectionCatalog: async () => catalog,
    startOAuthLogin: async (nextAttemptId: string, target) => {
      attemptId = nextAttemptId;
      assert.deepEqual(target, { kind: 'create', providerType: provider });
      await presentation.openExternal(
        'https://auth.example/device',
        'DEVICE-CODE',
        new AbortController().signal,
      );
      return {
        attemptId: nextAttemptId,
        connection: {
          connectionId: created.connectionId,
          slug: created.slug,
          providerType: provider,
        },
        phase: 'awaiting_authorization' as const,
      };
    },
    queryOAuthLogin: async (nextAttemptId: string) => {
      catalog = { ...catalog, revision: 2, connections: [existing, created] };
      return {
        attemptId: nextAttemptId,
        connection: {
          connectionId: created.connectionId,
          slug: created.slug,
          providerType: provider,
        },
        phase: 'authenticated' as const,
      };
    },
    fetchConnectionModels: async (connectionId: string) => {
      fetchedConnectionIds.push(connectionId);
      throw new Error('provider temporarily unavailable');
    },
    queryCredential: async (locator) =>
      locator.scope === 'connection' && locator.connectionId === created.connectionId
        ? {
            locator,
            configured: true as const,
            credentialId: '00000000-0000-4000-8000-000000000004',
            revision: 1,
            updatedAt: 1,
          }
        : null,
  } satisfies Partial<OAuthClient>;
  const { handlers, assertNoUnexpectedClientCalls } = registerOAuthTestHandlers({
    clientOverrides,
    presentation,
    emitConnectionListChanged: () => {
      changed += 1;
    },
    isProviderEnabled: () => true,
  });

  assert.deepEqual(await invoke(handlers, 'openai-codex:get-auth-url', { kind: 'create' }), {
    authRequestId: attemptId,
    stateHint: 'DEVICE-CODE',
    connection: {
      connectionId: created.connectionId,
      slug: created.slug,
      providerType: provider,
    },
  });
  assert.deepEqual(
    await invoke(handlers, 'openai-codex:complete-authorization', attemptId, undefined),
    {
      ok: true,
      connection: {
        connectionId: created.connectionId,
        slug: created.slug,
        providerType: provider,
      },
    },
  );
  assert.equal(changed, 1);
  assert.deepEqual(fetchedConnectionIds, [created.connectionId]);
  assert.deepEqual(catalog.defaultTarget, { connectionId: existing.connectionId, modelId });
  assert.deepEqual(await invoke(
    handlers,
    'openai-codex:get-account-state',
    created.connectionId,
  ), {
    provider,
    runtimeState: 'authenticated',
  });
  assertNoUnexpectedClientCalls();
});

function createFailClosedOAuthClient(overrides: Partial<OAuthClient>): {
  readonly client: OAuthClient;
  assertNoUnexpectedClientCalls(): void;
} {
  const unexpectedCalls: Array<{ readonly method: keyof OAuthClient; readonly args: unknown[] }> = [];
  const unexpected =
    (method: keyof OAuthClient) =>
    (...args: unknown[]): never => {
      unexpectedCalls.push({ method, args });
      throw new Error(`Unexpected OAuth client call: ${String(method)}`);
    };
  const client = {
    loadConnectionCatalog: unexpected('loadConnectionCatalog'),
    createConnection: unexpected('createConnection'),
    updateConnection: unexpected('updateConnection'),
    deleteCredential: unexpected('deleteCredential'),
    fetchConnectionModels: unexpected('fetchConnectionModels'),
    setDefaultConnectionTarget: unexpected('setDefaultConnectionTarget'),
    queryCredential: unexpected('queryCredential'),
    startOAuthLogin: unexpected('startOAuthLogin'),
    queryOAuthLogin: unexpected('queryOAuthLogin'),
    cancelOAuthLogin: unexpected('cancelOAuthLogin'),
    ...overrides,
  } satisfies OAuthClient;
  return {
    client,
    assertNoUnexpectedClientCalls: () => assert.deepEqual(unexpectedCalls, []),
  };
}

function registerOAuthTestHandlers(input: {
  readonly clientOverrides: Partial<OAuthClient>;
  readonly presentation: RuntimeHostOAuthPresentation;
  readonly emitConnectionListChanged: () => void;
  readonly isProviderEnabled: NonNullable<RuntimeHostOAuthIpcDeps['isProviderEnabled']>;
}): {
  readonly handlers: ReadonlyMap<string, OAuthIpcHandler>;
  assertNoUnexpectedClientCalls(): void;
} {
  const handlers = new Map<string, OAuthIpcHandler>();
  const { client, assertNoUnexpectedClientCalls } = createFailClosedOAuthClient(
    input.clientOverrides,
  );
  registerRuntimeHostOAuthIpc({
    ipcMain: { handle: (channel, handler) => void handlers.set(channel, handler) },
    client,
    presentation: input.presentation,
    emitConnectionListChanged: input.emitConnectionListChanged,
    isProviderEnabled: input.isProviderEnabled,
  });
  return { handlers, assertNoUnexpectedClientCalls };
}

function oauthProjection(
  attemptId: string,
  connectionId: string,
  phase: 'awaiting_authorization' | 'authenticated' | 'cancelled',
) {
  return {
    attemptId,
    connection: {
      connectionId,
      slug: 'openai-codex',
      providerType: 'openai-codex' as const,
    },
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
