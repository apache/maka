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
        slug: 'uds-codex',
        name: 'UDS Claude',
        providerType: 'openai-codex',
        enabled: true,
        enabledModelIds: ['gpt-5.6-sol'],
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
          // Codex enrolls through device authorization, presented via
          // `openExternal`.
          startCodexAuthorization: async () => ({
            deviceAuthId: 'uds-deviceauth',
            userCode: 'UDS-CODE',
            verificationUrl: 'https://auth.openai.com/codex/device',
            expiresAt: 1_900_000_000_000,
            intervalMs: 1_000,
          }),
          pollCodexAuthorization: async () => ({
            authorizationCode: 'uds-authorization-code',
            codeVerifier: 'uds-verifier',
          }),
          exchangeCodexCode: async () => ({
            access_token: 'host-access-token',
            refresh_token: 'host-refresh-token',
            expires_at: 1_900_000_000_000,
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
    first = await connectClient(root);
    second = await connectClient(root);
    const presentations: string[] = [];
    await first.replaceClientCapabilities(
      createOAuthPresentationClientProvider({
        openExternal: async () => {
          presentations.push('desktop');
        },
      }),
    );
    await second.replaceClientCapabilities(
      createOAuthPresentationClientProvider({
        openExternal: async () => {
          presentations.push('tui');
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

test('OAuth enrollment honors the Codex opt-out flag over the real endpoint', {
  timeout: 30_000,
}, async () => {
  const cases = [['openai-codex', { MAKA_CODEX_SUBSCRIPTION_EXPERIMENTAL: '0' }]] as const;
  for (const [provider, environment] of cases) {
    await assertProviderDisabledOverUds(provider, environment);
  }
});

async function assertProviderDisabledOverUds(
  provider: 'openai-codex',
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
    client = await connectClient(root);
    let presentations = 0;
    await client.replaceClientCapabilities(
      createOAuthPresentationClientProvider({
        openExternal: async () => {
          presentations += 1;
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

async function connectClient(rootPath: string): Promise<RuntimeHostConnection> {
  const connected = await connectRuntimeHost({
    rootPath,
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
