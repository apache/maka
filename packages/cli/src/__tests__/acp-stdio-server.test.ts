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
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, test } from 'node:test';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import { runMakaAcpStdioServer } from '../acp/stdio-server.js';

describe('Maka ACP stdio server', () => {
  test('answers initialize without connecting a Runtime Host', async () => {
    const harness = createHarness([
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 },
      })}\n`,
    ]);

    assert.equal(await harness.run(), 0);
    assert.deepEqual(harness.stdoutMessages(), [
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: {}, close: {} } },
          authMethods: [],
          agentInfo: { name: 'maka', title: 'Maka', version: '0.2.0' },
        },
      },
    ]);
    assert.equal(harness.connectCalls(), 0);
  });

  test('returns zero after normal EOF without connecting a Runtime Host', async () => {
    const harness = createHarness([]);

    assert.equal(await harness.run(), 0);
    assert.equal(harness.connectCalls(), 0);
  });

  test('returns a JSON-RPC parse error and then zero after EOF', async () => {
    const harness = createHarness(['not json\n']);

    assert.equal(await harness.run(), 0);
    assert.deepEqual(harness.stdoutMessages(), [
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    ]);
  });

  test('propagates a stdin transport error', async () => {
    const transportError = new Error('stdin transport failed');
    const stdin = Readable.from(
      (async function* () {
        throw transportError;
      })(),
    );
    const harness = createHarness([], { stdin });

    await assert.rejects(harness.run(), (error: unknown) => error === transportError);
  });

  test('serializes Session creation and configuration through the Runtime Host catalog', async () => {
    const lifecycle: string[] = [];
    let created: SessionCatalogProjection | undefined;
    const connection = {
      request: async (operation: string, input: unknown) => {
        lifecycle.push(operation);
        if (operation === 'session.create') {
          const { sessionId } = input as { sessionId: string };
          created = sessionProjection({ id: sessionId });
          return created;
        }
        if (operation === 'connection.catalog.query') return connectionCatalogPage();
        if (operation === 'session.catalog.query') {
          assert.ok(created);
          return { kind: 'session', session: created };
        }
        if (operation === 'session.configuration.update') {
          assert.ok(created);
          return {
            kind: 'committed',
            session: sessionProjection({
              id: created.id,
              revision: created.revision + 1,
              collaborationMode: 'plan',
            }),
          };
        }
        assert.fail(`Unexpected Runtime Host operation: ${operation}`);
      },
      close: async () => {
        lifecycle.push('connection.close');
      },
    } as unknown as RuntimeHostConnection;
    const stdin = new PassThrough();
    const harness = createHarness([], { stdin, connection });
    const run = harness.run();
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 },
      })}\n`,
    );
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: '/workspace', mcpServers: [] },
      })}\n`,
    );
    await waitFor(() => created !== undefined);
    stdin.end(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/set_config_option',
        params: {
          sessionId: created!.id,
          configId: 'collaboration_mode',
          value: 'plan',
        },
      })}\n`,
    );

    assert.equal(await run, 0);
    const responses = new Map(
      harness
        .stdoutMessages()
        .map((message) => [(message as { id?: unknown }).id, message] as const),
    );
    const createdResponse = responses.get(2) as {
      result?: { sessionId?: unknown; configOptions?: unknown[] };
    };
    assert.equal(createdResponse.result?.sessionId, created?.id);
    assert.deepEqual(
      createdResponse.result?.configOptions?.map((option) => (option as { id?: unknown }).id),
      ['permission_mode', 'thinking_level', 'collaboration_mode', 'orchestration_mode'],
    );
    const configuredResponse = responses.get(3) as {
      result?: {
        configOptions?: Array<{ id?: unknown; currentValue?: unknown }>;
      };
    };
    assert.deepEqual(
      configuredResponse.result?.configOptions?.find(({ id }) => id === 'collaboration_mode'),
      {
        type: 'select',
        id: 'collaboration_mode',
        name: 'Collaboration mode',
        category: 'mode',
        currentValue: 'plan',
        options: [
          { value: 'agent', name: 'Agent' },
          { value: 'plan', name: 'Plan' },
        ],
      },
    );
    assert.deepEqual(lifecycle, [
      'session.create',
      'connection.catalog.query',
      'session.catalog.query',
      'session.configuration.update',
      'connection.catalog.query',
      'connection.close',
    ]);
    assert.equal('subscribe' in connection, false);
    assert.ok(lifecycle.every((operation) => operation !== 'session.catalog.subscribe'));
    assert.ok(
      harness.stdoutMessages().every((message) => {
        const record = message as { jsonrpc?: unknown };
        return record.jsonrpc === '2.0';
      }),
    );
  });

  test('returns a Host connection failure from the Session request and keeps serving ACP', async () => {
    const harness = createHarness(
      [
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: 1 },
        })}\n`,
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/list',
          params: {},
        })}\n`,
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'session/close',
          params: { sessionId: 'missing' },
        })}\n`,
      ],
      { connectError: new Error('Host unavailable') },
    );

    assert.equal(await harness.run(), 0);
    const responses = new Map(
      harness
        .stdoutMessages()
        .map((message) => [(message as { id?: unknown }).id, message] as const),
    );
    const connectionFailure = responses.get(2) as {
      error?: { code?: unknown; data?: unknown };
    };
    assert.equal(connectionFailure.error?.code, -32603);
    assert.deepEqual(connectionFailure.error?.data, {
      source: 'runtime_host',
      operation: 'connect',
      code: 'connection_failed',
    });
    const methodFailure = responses.get(3) as {
      error?: { code?: unknown; data?: unknown };
    };
    assert.equal(methodFailure.error?.code, -32602);
    assert.deepEqual(methodFailure.error?.data, { reason: 'unknown_session' });
    assert.equal(harness.connectCalls(), 1);
  });

  test('keeps close for an unknown Session Host-independent', async () => {
    const harness = createHarness([
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 },
      })}\n`,
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/close',
        params: { sessionId: 'missing' },
      })}\n`,
    ]);

    assert.equal(await harness.run(), 0);
    const response = harness
      .stdoutMessages()
      .find((message) => (message as { id?: unknown }).id === 2) as {
      error?: { code?: unknown; data?: unknown };
    };
    assert.equal(response.error?.code, -32602);
    assert.deepEqual(response.error?.data, { reason: 'unknown_session' });
    assert.equal(harness.connectCalls(), 0);
  });
});

function createHarness(
  chunks: string[],
  options: {
    readonly stdin?: Readable;
    readonly connection?: RuntimeHostConnection;
    readonly connectError?: Error;
  } = {},
) {
  const stdin = options.stdin ?? Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  let connects = 0;
  const connection =
    options.connection ??
    ({
      request: async () => ({ kind: 'unsupported_legacy_record' }),
      close: async () => undefined,
    } as unknown as RuntimeHostConnection);
  const stdoutChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return {
    run: () =>
      runMakaAcpStdioServer(
        { workspaceRoot: '/workspace', clientDataRoot: '/client-data', version: '0.2.0' },
        {
          stdin,
          stdout,
          connectRuntimeHostCliConnection: async () => {
            connects += 1;
            if (options.connectError) throw options.connectError;
            return {
              connection: {
                ...connection,
                reconnecting: true,
                hostEpoch: connection.hostEpoch ?? 'host-1',
                openSessionSubscription:
                  connection.openSessionSubscription?.bind(connection) ??
                  (async () => {
                    throw new Error('Unexpected Session attachment');
                  }),
                openSessionSubscriptionOnce:
                  connection.openSessionSubscription?.bind(connection) ??
                  (async () => {
                    throw new Error('Unexpected Session attachment');
                  }),
                subscribeConnectionAvailability: () => () => undefined,
              },
              close: () => connection.close(),
            } as unknown as Awaited<
              ReturnType<
                typeof import('../runtime-host-cli-context.js').connectRuntimeHostCliConnection
              >
            >;
          },
        },
      ),
    connectCalls: () => connects,
    stdoutMessages: () =>
      Buffer.concat(stdoutChunks)
        .toString('utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
  };
}

function connectionCatalogPage() {
  return {
    kind: 'page' as const,
    revision: 1,
    defaultTarget: { connectionId: 'connection-1', model: 'default' },
    connectionCount: 1,
    items: [
      {
        kind: 'connection' as const,
        connectionIndex: 0,
        connectionId: 'connection-1',
        revision: 1,
        slug: 'default',
        name: 'Default',
        providerType: 'openai' as const,
        enabled: true,
        enabledModelIdCount: 1,
        modelCount: 0,
        catalogEntryCount: 1,
      },
      {
        kind: 'enabled_model_id' as const,
        connectionIndex: 0,
        itemIndex: 0,
        modelId: 'default',
      },
      {
        kind: 'catalog_entry' as const,
        connectionIndex: 0,
        itemIndex: 0,
        entry: {
          id: 'default',
          canUseAsChatDefault: true,
          isDefault: true,
          supportsVision: false,
          thinkingLevels: ['low', 'high'] as const,
        },
      },
    ],
    nextCursor: null,
  };
}

function sessionProjection(
  overrides: Partial<SessionCatalogProjection> = {},
): SessionCatalogProjection {
  return {
    id: 'session-1',
    revision: 1,
    workspace: { target: { kind: 'host_path', path: '/workspace' }, hostCwd: '/workspace' },
    createdAt: 1,
    activityAt: 1,
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-1',
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'default',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}
