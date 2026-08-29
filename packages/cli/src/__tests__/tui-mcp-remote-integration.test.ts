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
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  connectRemoteRuntimeHost,
  connectRuntimeHost,
  consumeAccessCredentialDelivery,
  type RemoteRuntimeHostProfile,
  type RuntimeHostCapabilityProviderCredentialStore,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';
import { startExecutionRuntimeHostService } from '@maka/runtime-host/server';
import { createMcpConfigStore } from '@maka/storage/mcp-config-store';
import { resolveStorageRoot } from '@maka/storage/root-authority';
import { createRemoteTuiMcpPublicationTarget } from '../tui-mcp-remote-publication.js';
import { createTuiMcpController, type TuiMcpController } from '../tui-mcp-control.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('remote TUI publication keeps its owner association across reconnect and revocation', {
  timeout: 120_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-tui-remote-mcp-'));
  const hostRoot = join(base, 'host');
  const clientRoot = join(base, 'client');
  const eventLog = join(base, 'stdio-events.jsonl');
  const port = await reservePort();
  let host = await startHost(hostRoot, port);
  let local: RuntimeHostConnection | undefined;
  let terminal: RuntimeHostConnection | undefined;
  let otherTerminal: RuntimeHostConnection | undefined;
  let otherProvider: RuntimeHostConnection | undefined;
  let controller: TuiMcpController | undefined;
  try {
    const capability = await resolveStorageRoot({ path: hostRoot, kind: 'interactive' });
    local = await connectLocal(hostRoot, 'local-owner');
    const firstOwner = await provisionOwner(
      local,
      hostRoot,
      host.websocketEndpoints[0]!,
      capability.rootId,
      'terminal-a',
    );
    terminal = firstOwner.connection;
    const firstProvider = await provisionProvider(
      local,
      hostRoot,
      firstOwner.credentialId,
      'terminal-a-mcp',
    );
    const secondOwner = await provisionOwner(
      local,
      hostRoot,
      host.websocketEndpoints[0]!,
      capability.rootId,
      'terminal-b',
    );
    otherTerminal = secondOwner.connection;
    const secondProvider = await provisionProvider(
      local,
      hostRoot,
      secondOwner.credentialId,
      'terminal-b-mcp',
    );
    assert.deepEqual(firstProvider.capabilityOwner, {
      principalId: 'terminal-a',
      clientInstanceId: 'terminal-a',
    });
    assert.deepEqual(secondProvider.capabilityOwner, {
      principalId: 'terminal-b',
      clientInstanceId: 'terminal-b',
    });
    otherProvider = await connectRemote(
      host.websocketEndpoints[0]!,
      capability.rootId,
      secondProvider.credential,
      'provider-b',
    );
    await otherProvider.replaceClientCapabilities(dummyProvider('provider-b'));

    const fixturePath = fileURLToPath(
      new URL(import.meta.resolve('@maka/mcp/test-only/stdio-server')),
    );
    await createMcpConfigStore(clientRoot).upsert('fixture', {
      command: process.execPath,
      args: [fixturePath],
      env: { MAKA_MCP_STDIO_EVENT_LOG: eventLog },
      protocol: 'legacy',
    });
    const credentials = credentialStore(firstProvider.credential);
    const profile = remoteProfile(host.websocketEndpoints[0]!, capability.rootId);
    const publication = createRemoteTuiMcpPublicationTarget(
      {
        clientDataRoot: clientRoot,
        profile,
        ownerClientInstanceId: 'terminal-a',
      },
      {
        credentials,
        loadClientInstanceId: async () => 'provider-a',
      },
    );
    controller = createTuiMcpController({ workspaceRoot: clientRoot, connection: publication });
    await waitFor(() => controller?.snapshot().publication === 'published');
    assert.equal(host.connectionCount, 5);

    const wrongTarget = createRemoteTuiMcpPublicationTarget(
      {
        clientDataRoot: clientRoot,
        profile: remoteProfile(host.websocketEndpoints[0]!, 'f'.repeat(64)),
        ownerClientInstanceId: 'terminal-a',
      },
      {
        credentials,
        loadClientInstanceId: async () => 'provider-wrong-root',
      },
    );
    let wrongTargetState = 'host_unavailable';
    const disposeWrongTarget = wrongTarget.subscribeConnectionAvailability((availability) => {
      wrongTargetState =
        availability.kind === 'unavailable'
          ? (availability.reason ?? 'host_unavailable')
          : 'connected';
    });
    try {
      await waitFor(() => wrongTargetState === 'target_mismatch');
      assert.equal(wrongTargetState, 'target_mismatch');
    } finally {
      disposeWrongTarget();
      await wrongTarget.closePublication?.();
    }

    await Promise.all([
      otherProvider.close(),
      otherTerminal.close(),
      terminal.close(),
      local.close(),
    ]);
    otherProvider = undefined;
    otherTerminal = undefined;
    terminal = undefined;
    local = undefined;
    await host.close();
    await waitFor(() => controller?.snapshot().publication === 'host_unavailable');
    host = await startHost(hostRoot, port);
    await waitFor(() => controller?.snapshot().publication === 'published');

    local = await connectLocal(hostRoot, 'local-owner-after-restart');
    await local.request('access.credential.revoke', {
      credentialId: firstProvider.credentialId,
    });
    await waitFor(() => controller?.snapshot().publication === 'credential_rejected');
    assert.equal(credentials.current(), firstProvider.credential);

    await controller.close();
    controller = undefined;
    await waitFor(async () =>
      (await fixtureEvents(eventLog)).some((event) => event.event === 'exit'),
    );
    const events = await fixtureEvents(eventLog);
    assert.equal(events.filter((event) => event.event === 'start').length, 1);
    assert.equal(events.filter((event) => event.event === 'exit').length, 1);
  } finally {
    await controller?.close().catch(() => undefined);
    await otherProvider?.close().catch(() => undefined);
    await otherTerminal?.close().catch(() => undefined);
    await terminal?.close().catch(() => undefined);
    await local?.close().catch(() => undefined);
    await host.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

async function startHost(rootPath: string, port: number) {
  return startExecutionRuntimeHostService({
    rootPath,
    websocket: { host: '127.0.0.1', port, allowInsecureRemote: true },
  });
}

async function provisionOwner(
  local: RuntimeHostConnection,
  rootPath: string,
  url: string,
  rootId: string,
  clientInstanceId: string,
): Promise<{ readonly credentialId: string; readonly connection: RuntimeHostConnection }> {
  const candidate = await local.request('access.credential.prepare', {
    principalKind: 'remote_owner',
    principalId: clientInstanceId,
    operationGrants: ['access.credential.finalize', 'session.catalog.query'],
    canPublishClientCapabilities: false,
    canUseHostPaths: false,
    bindClientInstance: true,
  });
  const credential = await consumeAccessCredentialDelivery(
    rootPath,
    candidate.deliveryId,
    candidate.credentialId,
  );
  const pairing = await connectRemote(url, rootId, credential, clientInstanceId);
  assert.deepEqual(await pairing.request('access.credential.finalize', {}), {
    reconnectRequired: true,
  });
  await pairing.close();
  return {
    credentialId: candidate.credentialId,
    connection: await connectRemote(url, rootId, credential, clientInstanceId),
  };
}

async function provisionProvider(
  local: RuntimeHostConnection,
  rootPath: string,
  ownerCredentialId: string,
  principalId: string,
): Promise<{
  readonly credentialId: string;
  readonly credential: string;
  readonly capabilityOwner?: { readonly principalId: string; readonly clientInstanceId: string };
}> {
  const issued = await local.request('access.credential.issue', {
    principalKind: 'capability_provider',
    principalId,
    operationGrants: ['host.status', 'client.capability.replace', 'client.capability.unregister'],
    canPublishClientCapabilities: true,
    canUseHostPaths: false,
    capabilityOwnerCredentialId: ownerCredentialId,
  });
  return {
    credentialId: issued.credentialId,
    capabilityOwner: issued.capabilityOwner,
    credential: await consumeAccessCredentialDelivery(
      rootPath,
      issued.deliveryId,
      issued.credentialId,
    ),
  };
}

async function connectLocal(rootPath: string, clientInstanceId: string) {
  const result = await connectRuntimeHost({ rootPath, clientInstanceId, protocol: PROTOCOL });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Unable to connect to local Runtime Host');
  return result.connection;
}

async function connectRemote(
  url: string,
  expectedRootId: string,
  credential: string,
  clientInstanceId: string,
): Promise<RuntimeHostConnection> {
  const result = await connectRemoteRuntimeHost({
    url,
    allowInsecureRemote: true,
    credential,
    expectedRootId,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    clientInstanceId,
    protocol: PROTOCOL,
  });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Unable to connect to remote Runtime Host');
  return result.connection;
}

function remoteProfile(url: string, rootId: string): RemoteRuntimeHostProfile {
  return {
    id: 'office',
    name: 'Office',
    kind: 'remote',
    transport: { kind: 'plaintext', url, acknowledgement: 'plaintext-bearer-v1' },
    rootId,
  };
}

function credentialStore(initial: string): RuntimeHostCapabilityProviderCredentialStore & {
  current(): string | null;
} {
  let credential: string | null = initial;
  return {
    get: async () => credential,
    set: async (_profile, _ownerClientInstanceId, next) => {
      credential = next;
    },
    delete: async () => {
      credential = null;
    },
    current: () => credential,
  };
}

function dummyProvider(id: string) {
  return {
    offers: () => [
      {
        offerId: id,
        version: '1',
        affinity: 'session' as const,
        hostPathAccess: 'none' as const,
        label: id,
        tools: [
          {
            serverId: id,
            name: 'echo',
            inputSchema: { type: 'object' },
          },
        ],
      },
    ],
    call: async () => ({ content: [{ type: 'text' as const, text: id }] }),
  };
}

async function fixtureEvents(path: string): Promise<Array<{ readonly event: string }>> {
  try {
    return (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_500 && !(await condition()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(await condition());
}
