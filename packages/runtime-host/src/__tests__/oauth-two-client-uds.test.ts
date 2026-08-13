import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isOAuthEnrollmentProviderEnabled } from '@maka/runtime/oauth-provider-contracts';
import { parseOAuthSubscriptionTokens } from '@maka/runtime/subscription-credentials';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  connectRuntimeHost,
  createOAuthPresentationClientProvider,
  RuntimeHostOperationError,
  type RuntimeHostConnection,
} from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import { HostClientCapabilityCoordinator } from '../server/client-capability-coordinator.js';
import { RuntimeHostKernel } from '../server/host-kernel.js';
import { HostOAuthCoordinator } from '../server/oauth-coordinator.js';
import {
  createUnavailableDomainOperationHandlers,
  type DomainOperationHandlerMap,
} from '../server/operation-dispatcher.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';

test('OAuth enrollment presents only on the initiating Client over the real endpoint', {
  timeout: 30_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-oauth-two-client-'));
  const root = join(base, 'root');
  let host: RuntimeHostKernel | undefined;
  let first: RuntimeHostConnection | undefined;
  let second: RuntimeHostConnection | undefined;
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'uds-claude',
        name: 'UDS Claude',
        providerType: 'claude-subscription',
        enabled: true,
        enabledModelIds: ['claude-sonnet-4-5'],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 60_000,
      composition: defineInteractiveRuntimeHostComposition(async (context) => {
        const activation = new RuntimePolicyActivationGate();
        const clientCapabilities = new HostClientCapabilityCoordinator({
          activation,
          onModelToolsChanged: () => undefined,
        });
        const oauth = new HostOAuthCoordinator({
          runtimePolicy: stores,
          activation,
          clientCapabilities,
          isProviderEnabled: (provider) => isOAuthEnrollmentProviderEnabled(provider, {}),
          acquireResidency: () => context.acquireResidency('oauth'),
          invalidateBackends: async () => undefined,
          onFatal: () => context.requestDrain(),
          exchangeCode: async () => ({
            access_token: 'host-access-token',
            refresh_token: 'host-refresh-token',
            expires_at: 1_900_000_000_000,
            account_uuid: 'host-account',
          }),
        });
        const handlers = {
          ...createUnavailableDomainOperationHandlers(),
          ...oauth.handlers,
          ...clientCapabilities.handlers,
        } as DomainOperationHandlerMap;
        return {
          handlers,
          clientCapabilities,
          releaseConnection: (connectionId) => clientCapabilities.releaseConnection(connectionId),
          beginDrain: () => {
            oauth.beginDrain();
            clientCapabilities.beginDrain();
          },
          recover: async () => undefined,
          close: async () => {
            await oauth.close();
            await clientCapabilities.close();
          },
        };
      }),
    });
    first = await connectClient(root, 'desktop');
    second = await connectClient(root, 'tui');
    const presentations: string[] = [];
    await first.replaceClientCapabilities(
      createOAuthPresentationClientProvider({
        openExternal: async () => {
          presentations.push('desktop');
        },
        requestAuthorizationCode: async () => {
          presentations.push('desktop');
          throw new Error('Wrong Client presentation was selected');
        },
      }),
    );
    await second.replaceClientCapabilities(
      createOAuthPresentationClientProvider({
        openExternal: async () => {
          presentations.push('tui');
        },
        requestAuthorizationCode: async (url) => {
          presentations.push('tui');
          const state = new URL(url).searchParams.get('state');
          assert.ok(state);
          return `authorization-code#${state}`;
        },
      }),
    );

    const started = await second.request('oauth.login.start', {
      attemptId: 'uds-attempt',
      connectionId: connection.connectionId,
    });
    assert.equal(started.phase, 'awaiting_authorization');
    const terminal = await waitForTerminal(second, 'uds-attempt');
    assert.equal(terminal.phase, 'authenticated');
    assert.deepEqual(presentations, ['tui']);
    const resolved = await stores.operations.resolveExecutionConnection(connection.slug);
    assert.equal(resolved.kind, 'ready');
    if (resolved.kind === 'ready') {
      assert.deepEqual(
        parseOAuthSubscriptionTokens(resolved.secretMaterial.connection?.secret ?? ''),
        {
          access_token: 'host-access-token',
          refresh_token: 'host-refresh-token',
          expires_at: 1_900_000_000_000,
          account_uuid: 'host-account',
        },
      );
    }
  } finally {
    await first?.close().catch(() => undefined);
    await second?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('OAuth enrollment honors Claude and Codex opt-out flags over the real endpoint', {
  timeout: 30_000,
}, async () => {
  const cases = [
    ['claude-subscription', { MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL: '0' }],
    ['openai-codex', { MAKA_CODEX_SUBSCRIPTION_EXPERIMENTAL: '0' }],
  ] as const;
  for (const [provider, environment] of cases) {
    await assertProviderDisabledOverUds(provider, environment);
  }
});

async function assertProviderDisabledOverUds(
  provider: 'claude-subscription' | 'openai-codex',
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), `maka-oauth-disabled-${provider}-`));
  const root = join(base, 'root');
  let host: RuntimeHostKernel | undefined;
  let client: RuntimeHostConnection | undefined;
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: `uds-disabled-${provider}`,
        name: `Disabled ${provider}`,
        providerType: provider,
        enabled: true,
        enabledModelIds: ['fixture-model'],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);

    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 60_000,
      composition: defineInteractiveRuntimeHostComposition(async (context) => {
        const activation = new RuntimePolicyActivationGate();
        const clientCapabilities = new HostClientCapabilityCoordinator({
          activation,
          onModelToolsChanged: () => undefined,
        });
        const oauth = new HostOAuthCoordinator({
          runtimePolicy: stores,
          activation,
          clientCapabilities,
          isProviderEnabled: (candidate) =>
            isOAuthEnrollmentProviderEnabled(candidate, environment),
          acquireResidency: () => context.acquireResidency('oauth'),
          invalidateBackends: async () => undefined,
          onFatal: () => context.requestDrain(),
          exchangeCode: async () => {
            throw new Error('Disabled enrollment must not exchange credentials');
          },
        });
        return {
          handlers: {
            ...createUnavailableDomainOperationHandlers(),
            ...oauth.handlers,
            ...clientCapabilities.handlers,
          } as DomainOperationHandlerMap,
          clientCapabilities,
          releaseConnection: (connectionId) => clientCapabilities.releaseConnection(connectionId),
          beginDrain: () => {
            oauth.beginDrain();
            clientCapabilities.beginDrain();
          },
          recover: async () => undefined,
          close: async () => {
            await oauth.close();
            await clientCapabilities.close();
          },
        };
      }),
    });
    client = await connectClient(root, 'desktop');
    let presentations = 0;
    await client.replaceClientCapabilities(
      createOAuthPresentationClientProvider({
        openExternal: async () => {
          presentations += 1;
        },
        requestAuthorizationCode: async () => {
          presentations += 1;
          return 'unused-code';
        },
      }),
    );

    await assert.rejects(
      client.request('oauth.login.start', {
        attemptId: `uds-disabled-${provider}`,
        connectionId: connection.connectionId,
      }),
      (error: unknown) =>
        error instanceof RuntimeHostOperationError && error.code === 'operation_unavailable',
    );
    assert.equal(presentations, 0);
  } finally {
    await client?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

async function connectClient(
  rootPath: string,
  surface: 'desktop' | 'tui',
): Promise<RuntimeHostConnection> {
  const connected = await connectRuntimeHost({
    rootPath,
    surface,
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
  });
  assert.equal(connected.kind, 'connected');
  if (connected.kind !== 'connected') throw new Error('Runtime Host Client did not connect');
  return connected.connection;
}

async function waitForTerminal(client: RuntimeHostConnection, attemptId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await client.request('oauth.login.query', { attemptId });
    if (['authenticated', 'cancelled', 'failed'].includes(projection.phase)) return projection;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('OAuth login did not settle');
}
