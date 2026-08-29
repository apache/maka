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
import {
  RuntimeHostProfileConnectionError,
  type RemoteRuntimeHostProfile,
  type RuntimeHostCapabilityProviderCredentialStore,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { createRemoteTuiMcpPublicationTarget } from '../tui-mcp-remote-publication.js';
import { waitFor } from './tui-terminal-mock.js';

const PROFILE: RemoteRuntimeHostProfile = {
  id: 'office',
  name: 'Office',
  kind: 'remote',
  transport: { kind: 'tls', url: 'wss://runtime.example.com/runtime-host' },
  rootId: 'a'.repeat(64),
};

test('remote TUI publication activates, rotates, and removes one profile-bound credential', async () => {
  const credentials = credentialHarness();
  const connected: Array<{ credential?: string; clientInstanceId: string }> = [];
  const connections: ConnectionHarness[] = [];
  const identityPaths: string[] = [];
  const target = createRemoteTuiMcpPublicationTarget(
    {
      clientDataRoot: '/client-data',
      profile: PROFILE,
      ownerClientInstanceId: 'terminal-client',
    },
    {
      credentials: credentials.store,
      loadClientInstanceId: async (path) => {
        identityPaths.push(path);
        return 'provider-client';
      },
      connectProfile: async (input) => {
        connected.push({
          credential: input.credential,
          clientInstanceId: input.clientInstanceId,
        });
        const connection = connectionHarness(`connection-${connections.length + 1}`);
        connections.push(connection);
        return connection.connection;
      },
    },
  );
  let latest = await availability(target);
  assert.deepEqual(latest(), { kind: 'unavailable', reason: 'credential_required' });

  await target.setCredential?.('provider-secret-a');
  await waitFor(() => latest().kind === 'connected', 'provider companion to connect');
  assert.deepEqual(connected, [
    { credential: 'provider-secret-a', clientInstanceId: 'provider-client' },
  ]);
  assert.equal(credentials.values.get('office\0terminal-client'), 'provider-secret-a');
  assert.match(identityPaths[0] ?? '', /capability-provider-identities/u);

  await target.setCredential?.('provider-secret-b');
  await waitFor(
    () => latest().kind === 'connected' && connections.length === 2,
    'rotated provider companion to connect',
  );
  assert.equal(connections[0]?.unregisters, 0);
  assert.equal(connections[0]?.closes, 1);
  assert.equal(credentials.values.get('office\0terminal-client'), 'provider-secret-b');
  assert.equal(identityPaths[0], identityPaths[1]);

  await target.removeCredential?.();
  assert.deepEqual(latest(), { kind: 'unavailable', reason: 'credential_required' });
  assert.equal(connections[1]?.unregisters, 0);
  assert.equal(connections[1]?.closes, 1);
  assert.equal(credentials.values.has('office\0terminal-client'), false);
  await target.closePublication?.();
});

test('remote TUI publication surfaces rejected credentials without a retry authority', async () => {
  const credentials = credentialHarness('revoked-secret');
  let attempts = 0;
  const target = createRemoteTuiMcpPublicationTarget(
    {
      clientDataRoot: '/client-data',
      profile: PROFILE,
      ownerClientInstanceId: 'terminal-client',
    },
    {
      credentials: credentials.store,
      loadClientInstanceId: async () => 'provider-client',
      connectProfile: async () => {
        attempts += 1;
        throw new RuntimeHostProfileConnectionError(
          'credential_rejected',
          'Runtime Host rejected its access credential',
        );
      },
    },
  );
  const latest = await availability(target);
  await waitFor(() => {
    const current = latest();
    return current.kind === 'unavailable' && current.reason === 'credential_rejected';
  }, 'rejected provider credential state');
  assert.equal(attempts, 1);
  await target.closePublication?.();
});

test('remote TUI publication aborts an in-flight connection before closing', async () => {
  const credentials = credentialHarness('provider-secret');
  let observedSignal: AbortSignal | undefined;
  const target = createRemoteTuiMcpPublicationTarget(
    {
      clientDataRoot: '/client-data',
      profile: PROFILE,
      ownerClientInstanceId: 'terminal-client',
    },
    {
      credentials: credentials.store,
      loadClientInstanceId: async () => 'provider-client',
      connectProfile: async (input) => {
        observedSignal = input.signal;
        return new Promise<RuntimeHostConnection>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(input.signal?.reason), {
            once: true,
          });
        });
      },
    },
  );
  await waitFor(() => observedSignal !== undefined, 'provider connection attempt to start');

  await target.closePublication?.();

  assert.equal(observedSignal?.aborted, true);
});

async function availability(target: ReturnType<typeof createRemoteTuiMcpPublicationTarget>) {
  let current: Parameters<Parameters<typeof target.subscribeConnectionAvailability>[0]>[0] = {
    kind: 'unavailable',
  };
  target.subscribeConnectionAvailability((next) => {
    current = next;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return () => current;
}

function credentialHarness(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set('office\0terminal-client', initial);
  const key = (profile: RemoteRuntimeHostProfile, ownerClientInstanceId: string) =>
    `${profile.id}\0${ownerClientInstanceId}`;
  const store: RuntimeHostCapabilityProviderCredentialStore = {
    get: async (profile, ownerClientInstanceId) =>
      values.get(key(profile, ownerClientInstanceId)) ?? null,
    set: async (profile, ownerClientInstanceId, credential) => {
      values.set(key(profile, ownerClientInstanceId), credential);
    },
    delete: async (profile, ownerClientInstanceId) => {
      values.delete(key(profile, ownerClientInstanceId));
    },
  };
  return { store, values };
}

interface ConnectionHarness {
  connection: RuntimeHostConnection;
  unregisters: number;
  closes: number;
}

function connectionHarness(connectionId: string): ConnectionHarness {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const harness: ConnectionHarness = {
    connection: undefined as unknown as RuntimeHostConnection,
    unregisters: 0,
    closes: 0,
  };
  harness.connection = {
    rootId: PROFILE.rootId,
    hostEpoch: 'host-epoch',
    connectionId,
    selectedProtocol: 0,
    compositionId: 'maka.interactive',
    compositionRevision: 'composition-revision',
    closed,
    replaceClientCapabilities: async () => ({ registrationIds: [] }),
    unregisterClientCapabilities: async () => {
      harness.unregisters += 1;
      return { registrationIds: [] };
    },
    subscribeConfigurationChanges: () => () => undefined,
    subscribeProjectCatalogChanges: () => () => undefined,
    subscribeSessionCatalogChanges: () => () => undefined,
    subscribeScheduledTaskChanges: () => () => undefined,
    close: async () => {
      harness.closes += 1;
      resolveClosed();
    },
  } as unknown as RuntimeHostConnection;
  return harness;
}
