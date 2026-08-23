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
import { LOAD_TOOLS_NAME, ToolAvailabilityRuntime } from '@maka/runtime/tool-availability';
import { type MakaTool } from '@maka/runtime/tool-runtime';
import { mcpProxyToolName } from '@maka/runtime/mcp-tools';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  connectRuntimeHost,
  type ClientCapabilityProvider,
  type RuntimeHostConnection,
} from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import {
  ClientCapabilityInvocationError,
  HostClientCapabilityCoordinator,
  type ClientCapabilitySnapshot,
} from '../server/client-capability-coordinator.js';
import { RuntimeHostKernel } from '../server/host-kernel.js';
import {
  createUnavailableDomainOperationHandlers,
  type DomainOperationHandlerMap,
} from '../server/operation-dispatcher.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';

test('unknown Client Capability loads, invokes, and rebinds after UDS reconnect', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-client-capability-'));
  const root = join(base, 'root');
  let host: RuntimeHostKernel | undefined;
  let client: RuntimeHostConnection | undefined;
  let snapshot: ClientCapabilitySnapshot | undefined;
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;

    let coordinator: HostClientCapabilityCoordinator | undefined;
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 60_000,
      composition: defineInteractiveRuntimeHostComposition(async () => {
        coordinator = new HostClientCapabilityCoordinator({
          activation: new RuntimePolicyActivationGate(),
          onModelToolsChanged: () => undefined,
        });
        const unavailable = createUnavailableDomainOperationHandlers();
        const handlers = {
          ...unavailable,
          ...coordinator.handlers,
        } as DomainOperationHandlerMap;
        return {
          handlers,
          clientCapabilities: coordinator,
          releaseConnection: (connectionId) => coordinator?.releaseConnection(connectionId),
          beginDrain: () => coordinator?.beginDrain(),
          recover: async () => undefined,
          close: async () => coordinator?.close(),
        };
      }),
    });

    const connected = await connectRuntimeHost({
      rootPath: root,
      clientInstanceId: 'desktop-installation-a',
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
    });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') return;
    client = connected.connection;

    const unsafeRequest = client.request.bind(client) as unknown as (
      operation: string,
      input: unknown,
      timeoutMs?: number,
    ) => Promise<unknown>;
    await assert.rejects(
      unsafeRequest('client.capability.replace', {
        registrationId: 'bypassed-registration',
        offers: [
          {
            offerId: 'bypassed',
            version: '0',
            affinity: 'call',
            hostPathAccess: 'cwd',
            label: 'Bypassed',
            tools: [
              {
                serverId: 'bypassed',
                name: 'inspect',
                inputSchema: { type: 'object' },
              },
            ],
          },
        ],
      }),
      /dedicated capability channel/,
    );
    await client.status();

    const largeValue = 'x'.repeat(100_000);
    let providerCloseCalls = 0;
    const provider: ClientCapabilityProvider = {
      offers: () => [
        {
          offerId: 'fixture_unknown',
          version: '0',
          affinity: 'session',
          hostPathAccess: 'cwd',
          label: 'Unknown fixture',
          description: 'A capability the Host source does not enumerate.',
          tools: [
            {
              serverId: 'fixture_unknown',
              name: 'make_unknown_payload',
              description: 'Returns a provider-defined payload unknown to the Host.',
              inputSchema: {
                type: 'object',
                properties: { prefix: { type: 'string' } },
                required: ['prefix'],
                additionalProperties: false,
              },
            },
            {
              serverId: 'fixture_unknown',
              name: 'reject_unknown',
              description: 'Rejects before the provider admission cut.',
              inputSchema: {
                type: 'object',
                additionalProperties: false,
              },
            },
          ],
        },
      ],
      call: async (frame, { accept }) => {
        if (frame.toolName === 'reject_unknown') {
          throw new Error('Provider rejected before acceptance');
        }
        await accept();
        return {
          content: [
            {
              type: 'text',
              text: `${String(frame.arguments.prefix)}:${largeValue}`,
            },
          ],
        };
      },
      close: () => {
        providerCloseCalls += 1;
      },
    };
    await client.replaceClientCapabilities(provider);

    assert.ok(coordinator);
    assert.deepEqual(await coordinator.bindSession('session-uds', client.connectionId), {
      ok: true,
    });
    snapshot = coordinator.snapshotForSession('session-uds');
    assert.ok(snapshot);
    const group = snapshot.groups[0];
    assert.ok(group);
    assert.equal(group.label, 'Unknown fixture');
    const tool = snapshot.tools.find(
      (candidate) => candidate.name === mcpProxyToolName('fixture_unknown', 'make_unknown_payload'),
    );
    assert.ok(tool);
    const rejectedTool = snapshot.tools.find(
      (candidate) => candidate.name === mcpProxyToolName('fixture_unknown', 'reject_unknown'),
    );
    assert.ok(rejectedTool);
    const toolContext = {
      sessionId: 'session-uds',
      turnId: 'turn-uds',
      cwd: root,
      toolCallId: 'tool-call-uds',
      abortSignal: new AbortController().signal,
      emitOutput: () => undefined,
    };
    const availability = new ToolAvailabilityRuntime(
      snapshot.tools,
      { economy: true, groups: snapshot.groups },
      invalidTool(),
    ).prepare([]);
    assert.deepEqual(availability.activeTools, [LOAD_TOOLS_NAME]);
    const loadTools = availability.providerTools.find(
      (candidate) => candidate.name === LOAD_TOOLS_NAME,
    );
    assert.ok(loadTools);
    const loaded = await loadTools.impl({ group: group.id }, toolContext);
    const capabilityToolNames = [tool.name, rejectedTool.name].sort((left, right) =>
      left.localeCompare(right),
    );
    assert.deepEqual(loaded, { loaded: capabilityToolNames });
    assert.deepEqual(
      availability.projectActiveTools?.({
        completedSteps: [
          {
            toolCalls: [{ toolName: LOAD_TOOLS_NAME, input: { group: group.id } }],
          },
        ],
      }).activeTools,
      [LOAD_TOOLS_NAME, ...capabilityToolNames],
    );

    const result = await tool.impl({ prefix: 'from-uds' }, toolContext);
    assert.deepEqual(result, {
      content: [{ type: 'text', text: `from-uds:${largeValue}` }],
    });
    await assert.rejects(
      async () => rejectedTool.impl({}, toolContext),
      (error: unknown) =>
        error instanceof ClientCapabilityInvocationError && error.code === 'provider_rejected',
    );

    const disconnectedClient = client;
    client = undefined;
    await disconnectedClient.close();
    assert.equal(providerCloseCalls, 1);
    await waitForCapabilityOmission(coordinator, 'session-uds');
    await assert.rejects(
      async () => tool.impl({ prefix: 'after-disconnect' }, toolContext),
      (error: unknown) =>
        error instanceof ClientCapabilityInvocationError && error.code === 'capability_lost',
    );

    const reconnected = await connectRuntimeHost({
      rootPath: root,
      clientInstanceId: 'desktop-installation-a',
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
    });
    assert.equal(reconnected.kind, 'connected');
    if (reconnected.kind !== 'connected') return;
    client = reconnected.connection;
    await client.replaceClientCapabilities({
      offers: provider.offers,
      call: async (frame, { accept }) => {
        await accept();
        return {
          content: [{ type: 'text', text: `reconnected:${String(frame.arguments.prefix)}` }],
        };
      },
    });
    assert.deepEqual(await coordinator.bindSession('session-uds', client.connectionId), {
      ok: true,
    });
    snapshot.release();
    snapshot = coordinator.snapshotForSession('session-uds');
    const reconnectedTool = snapshot?.tools.find(
      (candidate) => candidate.name === mcpProxyToolName('fixture_unknown', 'make_unknown_payload'),
    );
    assert.ok(reconnectedTool);
    assert.deepEqual(await reconnectedTool.impl({ prefix: 'from-uds' }, toolContext), {
      content: [{ type: 'text', text: 'reconnected:from-uds' }],
    });
  } finally {
    snapshot?.release();
    await client?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

function invalidTool(): MakaTool {
  return {
    name: 'invalid',
    description: 'Invalid tool fallback.',
    parameters: {},
    impl: async () => ({ error: 'invalid' }),
  };
}

async function waitForCapabilityOmission(
  coordinator: HostClientCapabilityCoordinator,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const snapshot = coordinator.snapshotForSession(sessionId);
    if (!snapshot) return;
    snapshot.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Client Capability provider remained available after disconnect');
}
