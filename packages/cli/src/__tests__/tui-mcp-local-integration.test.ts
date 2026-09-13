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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { mcpProxyToolName } from '@maka/runtime/mcp-tools';
import {
  connectRuntimeHost,
  createRuntimeHostReconnectingConnection,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';
import {
  createUnavailableDomainOperationHandlers,
  defineInteractiveRuntimeHostComposition,
  RuntimeHostKernel,
} from '@maka/runtime-host/server';
import {
  HostClientCapabilityCoordinator,
  RuntimePolicyActivationGate,
  clientCapabilityCoordinatorTestAdmission,
  type ClientCapabilitySnapshot,
} from '@maka/runtime-host/test-only/client-capability-host';
import { createMcpConfigStore } from '@maka/storage/mcp-config-store';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createTuiMcpController, type TuiMcpController } from '../tui-mcp-control.js';
import { waitFor as pollFor } from '@maka/core/test-only/async-primitives';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('local TUI discovers, publishes, invokes, republishes, and closes one MCP child', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-tui-mcp-'));
  const hostRoot = join(base, 'host');
  const clientRoot = join(base, 'client');
  const eventLog = join(base, 'stdio-events.jsonl');
  let host: RuntimeHostKernel | undefined;
  let connection: Awaited<ReturnType<typeof createRuntimeHostReconnectingConnection>> | undefined;
  let controller: TuiMcpController | undefined;
  let capabilitySnapshot: ClientCapabilitySnapshot | undefined;
  try {
    const capability = await resolveStorageRoot({ path: hostRoot, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;

    let coordinator: HostClientCapabilityCoordinator | undefined;
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 60_000,
      composition: defineInteractiveRuntimeHostComposition(async () => {
        coordinator = new HostClientCapabilityCoordinator({
          ...clientCapabilityCoordinatorTestAdmission(),
          activation: new RuntimePolicyActivationGate(),
          onModelToolsChanged: () => undefined,
        });
        return {
          handlers: {
            ...createUnavailableDomainOperationHandlers(),
            ...coordinator.handlers,
          },
          clientCapabilities: coordinator,
          releaseConnection: (connectionId) => coordinator?.releaseConnection(connectionId),
          beginDrain: () => coordinator?.beginDrain(),
          recover: async () => undefined,
          close: async () => coordinator?.close(),
        };
      }),
    });

    const fixturePath = fileURLToPath(
      new URL(import.meta.resolve('@maka/mcp/test-only/stdio-server')),
    );
    await createMcpConfigStore(clientRoot).upsert('fixture', {
      command: process.execPath,
      args: [fixturePath],
      env: { MAKA_MCP_STDIO_EVENT_LOG: eventLog },
      protocol: 'legacy',
    });

    const initial = await connectDirect(hostRoot);
    let latestDirect = initial;
    connection = await createRuntimeHostReconnectingConnection({
      initialConnection: initial,
      connect: async () => {
        latestDirect = await connectDirect(hostRoot);
        return latestDirect;
      },
      backoff: { minMs: 0, maxMs: 0 },
    });
    controller = createTuiMcpController({ workspaceRoot: clientRoot, connection });

    await waitFor(() => controller?.snapshot().publication === 'published');
    assert.ok(coordinator);
    assert.deepEqual(await coordinator.bindSession('session-mcp', connection.connectionId), {
      ok: true,
    });
    capabilitySnapshot = coordinator.snapshotForSession('session-mcp');
    const firstTool = capabilitySnapshot?.tools.find(
      (candidate) => candidate.name === mcpProxyToolName('fixture', 'echo'),
    );
    assert.ok(firstTool);
    assert.deepEqual(
      await firstTool.impl({ value: 'before reconnect' }, toolContext(hostRoot, 'call-1')),
      {
        content: [{ type: 'text', text: 'before reconnect' }],
        structuredContent: { echoed: 'before reconnect' },
      },
    );

    const firstConnectionId = connection.connectionId;
    await initial.close();
    await waitFor(() => connection?.connectionId !== firstConnectionId);
    await waitFor(() => controller?.snapshot().publication === 'published');
    assert.notEqual(latestDirect.connectionId, firstConnectionId);
    capabilitySnapshot?.release();
    capabilitySnapshot = undefined;
    assert.deepEqual(await coordinator.bindSession('session-mcp', connection.connectionId), {
      ok: true,
    });
    capabilitySnapshot = coordinator.snapshotForSession('session-mcp');
    const replacementTool = capabilitySnapshot?.tools.find(
      (candidate) => candidate.name === mcpProxyToolName('fixture', 'echo'),
    );
    assert.ok(replacementTool);
    assert.deepEqual(
      await replacementTool.impl({ value: 'after reconnect' }, toolContext(hostRoot, 'call-2')),
      {
        content: [{ type: 'text', text: 'after reconnect' }],
        structuredContent: { echoed: 'after reconnect' },
      },
    );

    capabilitySnapshot?.release();
    capabilitySnapshot = undefined;
    await controller.close();
    controller = undefined;
    await waitFor(async () =>
      (await fixtureEvents(eventLog)).some((event) => event.event === 'exit'),
    );
    const events = await fixtureEvents(eventLog);
    assert.equal(events.filter((event) => event.event === 'start').length, 1);
    assert.equal(events.filter((event) => event.event === 'exit').length, 1);
    await waitFor(() => capabilityIsMissing(coordinator, 'session-mcp'));
  } finally {
    capabilitySnapshot?.release();
    await controller?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

async function connectDirect(rootPath: string): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({
    rootPath,
    clientInstanceId: 'tui-mcp-integration',
    protocol: PROTOCOL,
  });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Unable to connect to Runtime Host');
  return result.connection;
}

function toolContext(cwd: string, toolCallId: string) {
  return {
    sessionId: 'session-mcp',
    turnId: 'turn-mcp',
    cwd,
    toolCallId,
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
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

function capabilityIsMissing(
  coordinator: HostClientCapabilityCoordinator | undefined,
  sessionId: string,
): boolean {
  const snapshot = coordinator?.snapshotForSession(sessionId);
  if (!snapshot) return true;
  snapshot.release();
  return false;
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  await pollFor(condition, { attempts: 500, pollMs: 10 });
}
