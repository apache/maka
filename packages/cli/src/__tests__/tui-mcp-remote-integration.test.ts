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
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  connectRemoteRuntimeHost,
  connectRuntimeHost,
  consumeAccessCredentialDelivery,
  createClientRuntimeHostCredentialStore,
  createClientRuntimeHostProfileCatalog,
  createRuntimeHostCapabilityProviderCredentialStore,
  type RemoteRuntimeHostProfile,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';
import { startExecutionRuntimeHostService } from '@maka/runtime-host/server';
import { mcpProxyToolName } from '@maka/runtime/mcp-tools';
import { createMcpConfigStore } from '@maka/storage/mcp-config-store';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
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
  const model = await startModelProvider();
  await seedModelConnection(hostRoot, model.baseUrl);
  let host = await startHost(hostRoot, port);
  let local: RuntimeHostConnection | undefined;
  let terminal: RuntimeHostConnection | undefined;
  let otherTerminal: RuntimeHostConnection | undefined;
  let otherProvider: RuntimeHostConnection | undefined;
  let controller: TuiMcpController | undefined;
  let competingController: TuiMcpController | undefined;
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
    const profile = remoteProfile(host.websocketEndpoints[0]!, capability.rootId);
    const profiles = createClientRuntimeHostProfileCatalog(clientRoot);
    await profiles.create(profile, firstOwner.credential);
    const resolvedProfile = await profiles.resolve(profile.id);
    assert.ok(resolvedProfile.profileIncarnationId);
    const profileTarget = {
      profile,
      profileIncarnationId: resolvedProfile.profileIncarnationId,
    };
    const credentials = createRuntimeHostCapabilityProviderCredentialStore(
      createClientRuntimeHostCredentialStore(clientRoot),
    );
    await credentials.set(profileTarget, 'terminal-a', firstProvider.credential);
    const publication = createRemoteTuiMcpPublicationTarget(
      {
        clientDataRoot: clientRoot,
        profile,
        profileIncarnationId: profileTarget.profileIncarnationId,
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

    const competingWorkspace = join(base, 'competing-workspace');
    await createMcpConfigStore(competingWorkspace).upsert('other-fixture', {
      command: process.execPath,
      args: [fixturePath],
      enabled: false,
      protocol: 'legacy',
    });
    const competingPublication = createRemoteTuiMcpPublicationTarget({
      clientDataRoot: clientRoot,
      profile,
      profileIncarnationId: profileTarget.profileIncarnationId,
      ownerClientInstanceId: 'terminal-a',
    });
    competingController = createTuiMcpController({
      workspaceRoot: competingWorkspace,
      connection: competingPublication,
    });
    await waitFor(() => competingController?.snapshot().publication === 'provider_conflict');
    assert.equal(competingController.snapshot().canManagePublicationCredential, false);
    assert.equal(controller.snapshot().publication, 'published');
    assert.equal(host.connectionCount, 5);
    await competingController.close();
    competingController = undefined;

    const sessionId = 'remote-tui-mcp-session';
    const turnId = 'remote-tui-mcp-turn';
    await terminal.request('session.create', {
      sessionId,
      workspace: { kind: 'host_path', path: hostRoot },
      modelTarget: { kind: 'default' },
      permissionMode: 'bypass',
    });
    const started = await terminal.request('turn.start', {
      sessionId,
      turnId,
      content: { text: 'Call the fixture MCP echo tool.' },
    });
    assert.equal(started.kind, 'started');
    let completedTurn: Awaited<ReturnType<RuntimeHostConnection['request']>> | undefined;
    await waitFor(async () => {
      const turn = await terminal?.request('turn.query', { sessionId, turnId });
      if (
        turn?.status !== 'completed' &&
        turn?.status !== 'failed' &&
        turn?.status !== 'cancelled'
      ) {
        return false;
      }
      completedTurn = turn;
      return true;
    });
    assert.equal(
      completedTurn?.status,
      'completed',
      JSON.stringify({ completedTurn, modelRequests: model.requestSummary() }),
    );
    assert.equal(model.fixtureCalls(), 1);
    assert.equal(model.observedToolResult(), 'remote-session-sentinel');

    const wrongProfile = remoteProfile(host.websocketEndpoints[0]!, 'f'.repeat(64), 'wrong-office');
    await profiles.create(wrongProfile, firstOwner.credential);
    const resolvedWrongProfile = await profiles.resolve(wrongProfile.id);
    assert.ok(resolvedWrongProfile.profileIncarnationId);
    const wrongProfileTarget = {
      profile: wrongProfile,
      profileIncarnationId: resolvedWrongProfile.profileIncarnationId,
    };
    await credentials.set(wrongProfileTarget, 'terminal-a', firstProvider.credential);
    const wrongTarget = createRemoteTuiMcpPublicationTarget(
      {
        clientDataRoot: clientRoot,
        profile: wrongProfile,
        profileIncarnationId: wrongProfileTarget.profileIncarnationId,
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
    assert.equal(await credentials.get(profileTarget, 'terminal-a'), firstProvider.credential);

    await createClientRuntimeHostProfileCatalog(clientRoot).remove(profile.id);
    await waitFor(() => controller?.snapshot().publication === 'target_mismatch');

    await controller.close();
    controller = undefined;
    await waitFor(async () =>
      (await fixtureEvents(eventLog)).some((event) => event.event === 'exit'),
    );
    const events = await fixtureEvents(eventLog);
    assert.equal(events.filter((event) => event.event === 'start').length, 1);
    assert.equal(events.filter((event) => event.event === 'exit').length, 1);
  } finally {
    await competingController?.close().catch(() => undefined);
    await controller?.close().catch(() => undefined);
    await otherProvider?.close().catch(() => undefined);
    await otherTerminal?.close().catch(() => undefined);
    await terminal?.close().catch(() => undefined);
    await local?.close().catch(() => undefined);
    await host.close().catch(() => undefined);
    await model.close().catch(() => undefined);
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
): Promise<{
  readonly credentialId: string;
  readonly credential: string;
  readonly connection: RuntimeHostConnection;
}> {
  const candidate = await local.request('access.credential.prepare', {
    principalKind: 'remote_owner',
    principalId: clientInstanceId,
    operationGrants: [
      'access.credential.finalize',
      'session.catalog.query',
      'session.create',
      'turn.start',
      'turn.query',
    ],
    canPublishClientCapabilities: false,
    canUseHostPaths: true,
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
    credential,
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

function remoteProfile(url: string, rootId: string, id = 'office'): RemoteRuntimeHostProfile {
  return {
    id,
    name: 'Office',
    kind: 'remote',
    transport: { kind: 'plaintext', url, acknowledgement: 'plaintext-bearer-v1' },
    rootId,
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

async function seedModelConnection(rootPath: string, baseUrl: string): Promise<void> {
  const capability = await resolveStorageRoot({ path: rootPath, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire model fixture root');
  try {
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'remote-mcp-fixture-model',
        name: 'Remote MCP fixture model',
        providerType: 'moonshot',
        baseUrl,
        enabled: true,
        enabledModelIds: ['hosted-real-model'],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') throw new Error('Model fixture connection did not commit');
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) throw new Error('Model fixture connection was not persisted');
    assert.equal(
      (
        await policy.credentialVault.set({
          locator: {
            scope: 'connection',
            connectionId: connection.connectionId,
            kind: 'api_key',
          },
          expected: null,
          secret: 'fixture-model-key',
        })
      ).kind,
      'committed',
    );
    const prepared = await policy.operations.beginModelFetch(connection.connectionId);
    assert.equal(prepared.kind, 'ready');
    if (prepared.kind !== 'ready') throw new Error('Model fixture discovery was not ready');
    const discovered = await policy.operations.completeModelFetch(prepared.ticket, {
      models: [
        {
          id: 'hosted-real-model',
          capabilities: { chat: true, functionCalling: true },
          contextWindow: 8_192,
          maxOutputTokens: 128,
        },
      ],
      source: 'fetched',
      fetchedAt: Date.now(),
    });
    assert.equal(discovered.kind, 'committed');
    if (discovered.kind !== 'committed') throw new Error('Model fixture discovery did not commit');
    assert.equal(
      (
        await policy.connectionCatalog.setDefaultTarget({
          expectedCatalogRevision: discovered.snapshot.revision,
          target: {
            connectionId: connection.connectionId,
            modelId: 'hosted-real-model',
          },
        })
      ).kind,
      'committed',
    );
  } finally {
    await owner.close();
  }
}

async function startModelProvider(): Promise<{
  readonly baseUrl: string;
  fixtureCalls(): number;
  observedToolResult(): string | undefined;
  requestSummary(): readonly unknown[];
  close(): Promise<void>;
}> {
  const proxyToolName = mcpProxyToolName('fixture', 'echo');
  let streamRequests = 0;
  let fixtureCalls = 0;
  let observedToolResult: string | undefined;
  const requestSummary: unknown[] = [];
  const server = createServer((request, response) => {
    void readRequestBody(request)
      .then((body) => {
        const input = JSON.parse(body) as Record<string, unknown>;
        requestSummary.push({ stream: input.stream, tools: modelToolNames(input) });
        if (input.stream !== true) {
          respondModelSummary(response);
          return;
        }
        streamRequests += 1;
        if (streamRequests === 1) {
          assert.ok(modelToolNames(input).includes('tool_search'));
          respondModelToolCall(response, streamRequests, 'tool_search', {
            query: proxyToolName,
          });
          return;
        }
        if (streamRequests === 2) {
          assert.ok(modelToolNames(input).includes(proxyToolName));
          fixtureCalls += 1;
          respondModelToolCall(response, streamRequests, proxyToolName, {
            value: 'remote-session-sentinel',
          });
          return;
        }
        const serialized = JSON.stringify(input);
        if (serialized.includes('remote-session-sentinel')) {
          observedToolResult = 'remote-session-sentinel';
        }
        respondModelText(response, 'Remote MCP fixture completed.');
      })
      .catch((error) => response.destroy(error as Error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    fixtureCalls: () => fixtureCalls,
    observedToolResult: () => observedToolResult,
    requestSummary: () => requestSummary,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function modelToolNames(body: Record<string, unknown>): string[] {
  return (Array.isArray(body.tools) ? body.tools : []).flatMap((tool) => {
    if (!tool || typeof tool !== 'object') return [];
    const fn = (tool as { function?: unknown }).function;
    if (!fn || typeof fn !== 'object') return [];
    const name = (fn as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  });
}

function respondModelToolCall(
  response: ServerResponse,
  step: number,
  toolName: string,
  args: Record<string, unknown>,
): void {
  respondModelEvents(response, [
    {
      id: `chatcmpl-remote-mcp-${step}`,
      object: 'chat.completion.chunk',
      created: step,
      model: 'hosted-real-model',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `remote-mcp-tool-call-${step}`,
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: `chatcmpl-remote-mcp-${step}`,
      object: 'chat.completion.chunk',
      created: step,
      model: 'hosted-real-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  ]);
}

function respondModelText(response: ServerResponse, text: string): void {
  respondModelEvents(response, [
    {
      id: 'chatcmpl-remote-mcp-complete',
      object: 'chat.completion.chunk',
      created: 3,
      model: 'hosted-real-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-remote-mcp-complete',
      object: 'chat.completion.chunk',
      created: 3,
      model: 'hosted-real-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
    },
  ]);
}

function respondModelEvents(response: ServerResponse, events: readonly unknown[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function respondModelSummary(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      id: 'chatcmpl-remote-mcp-summary',
      object: 'chat.completion',
      created: 1,
      model: 'hosted-real-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Remote MCP Session' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }),
  );
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
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
