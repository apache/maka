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
import type { InteractionRequest } from '@maka/core/interaction';
import type { StoredMessage } from '@maka/core/session';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type InteractionPendingSnapshot,
  type SessionCatalogProjection,
  type SessionContinuitySnapshot,
  type SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import {
  RuntimeHostRequestInterruptedError,
  type RuntimeHostConnection,
  type RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import { runMakaAcpStdioServer } from '../acp/stdio-server.js';

describe('Maka ACP stdio server', () => {
  for (const scenario of [
    'recovery',
    'question',
    'form',
    'permission',
    'sandbox_boundary',
    'client_capability',
  ] as const) {
    test(`prompt through stdio handles ${scenario}`, { timeout: 5_000 }, async () => {
      const stdin = new PassThrough();
      let created: SessionCatalogProjection | undefined;
      let root: NonNullable<SessionContinuitySnapshot['rootTurn']> | undefined;
      let first: FakeSubscription | undefined;
      let opens = 0;
      let pending: InteractionPendingSnapshot | undefined;
      const stops: unknown[] = [];
      const snapshot = (projectionRevision = 1): SessionContinuitySnapshot =>
        continuitySnapshot({
          sessionId: created!.id,
          projectionRevision,
          rootTurn: root ?? null,
          status: 'running',
        });
      const connection = {
        request: async (operation: string, input: { sessionId: string; turnId: string }) => {
          if (operation === 'session.create')
            return (created = sessionProjection({ id: input.sessionId }));
          if (operation === 'connection.catalog.query') return connectionCatalogPage();
          if (operation === 'session.catalog.query') return { kind: 'session', session: created };
          if (operation === 'interaction.query') return pending;
          if (operation === 'turn.start') {
            root = {
              sessionId: input.sessionId,
              turnId: input.turnId,
              runId: 'run-1',
              status: 'running',
            };
            return { kind: 'started', turn: root };
          }
          if (operation === 'turn.stop') {
            stops.push(input);
            return {};
          }
          assert.fail(`Unexpected operation: ${operation}`);
        },
        openSessionSubscription: async () => {
          opens += 1;
          if (opens === 1) return (first = new FakeSubscription(snapshot(), Promise.resolve([])));
          const replacement = new FakeSubscription(
            snapshot(3),
            Promise.resolve([]),
            'subscription-2',
          );
          replacement.push({
            kind: 'subscription.session_projection',
            hostEpoch: 'host-1',
            subscriptionId: 'subscription-2',
            sequence: 1,
            snapshot: {
              ...snapshot(4),
              rootTurn: {
                sessionId: root!.sessionId,
                turnId: root!.turnId,
                runId: root!.runId,
                status: 'completed',
                terminalEventId: 'terminal-1',
              },
            },
          });
          return replacement;
        },
        close: async () => undefined,
      } as unknown as RuntimeHostConnection;
      const harness = createHarness([], { stdin, connection });
      const run = harness.run();
      const response = (id: number) =>
        (
          harness.stdoutMessages() as Array<{
            id: number;
            result?: { sessionId?: string; stopReason?: string };
            error?: { data?: { code?: string; kind?: string } };
          }>
        ).find((message) => message.id === id);
      const send = (id: number, method: string, params: unknown) =>
        stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      try {
        send(1, 'session/new', { cwd: '/workspace', mcpServers: [] });
        await waitFor(() => Boolean(response(1)));
        assert.ok(response(1)?.result?.sessionId);
        send(2, 'session/prompt', {
          sessionId: created!.id,
          prompt: [{ type: 'text', text: 'Hello' }],
        });
        await waitFor(() => Boolean(root));
        first!.push({
          kind: 'subscription.session_projection',
          hostEpoch: 'host-1',
          subscriptionId: 'subscription-1',
          sequence: 1,
          snapshot: snapshot(2),
        });
        if (scenario === 'recovery') {
          first!.push({
            kind: 'subscription.closed',
            hostEpoch: 'host-1',
            subscriptionId: 'subscription-1',
            sequence: 2,
            reason: 'slow_consumer',
          });
          await waitFor(() => Boolean(response(2)));
          assert.deepEqual(response(2)?.result, { stopReason: 'end_turn' });
          assert.equal(opens, 2);
          assert.deepEqual(stops, []);
        } else {
          pending = {
            schemaVersion: 1,
            interactionId: 'question-1',
            ...root!,
            revision: 1,
            status: 'pending',
            outcome: null,
            request: unsupportedRequests[scenario],
          };
          first!.push({
            kind: 'subscription.session_projection',
            hostEpoch: 'host-1',
            subscriptionId: 'subscription-1',
            sequence: 2,
            snapshot: {
              ...snapshot(3),
              interactions: {
                pending: [pending],
              },
            },
          });
          if (scenario === 'sandbox_boundary' || scenario === 'client_capability') {
            const request = () =>
              (harness.stdoutMessages() as Array<{ id: string; method?: string }>).find(
                (message) => message.method === 'session/request_permission',
              );
            await waitFor(() => Boolean(request()));
            stdin.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: request()!.id, error: { code: -32601, message: 'Unsupported client method' } })}\n`,
            );
          }
          await waitFor(() => Boolean(response(2)));
          assert.equal(response(2)?.error?.data?.code, 'unsupported_interaction');
          assert.equal(response(2)?.error?.data?.kind, scenario);
          assert.deepEqual(stops, [
            { sessionId: root!.sessionId, turnId: root!.turnId, runId: root!.runId },
          ]);
        }
      } finally {
        stdin.end();
        await run;
      }
    });
  }

  test('retains ACP cancellation until the real channel recovers an outcome-unknown start', {
    timeout: 5_000,
  }, async () => {
    const stdin = new PassThrough();
    let sessionId: string | undefined;
    let session: SessionCatalogProjection | undefined;
    let admitted:
      | {
          sessionId: string;
          turnId: string;
          runId: string;
          status: 'running';
        }
      | undefined;
    let rejectStart!: (error: Error) => void;
    const start = new Promise<never>((_resolve, reject) => {
      rejectStart = reject;
    });
    let first: FakeSubscription | undefined;
    let opens = 0;
    let turnQueries = 0;
    const stops: unknown[] = [];
    const snapshot = (
      projectionRevision: number,
      rootTurn: SessionContinuitySnapshot['rootTurn'],
    ): SessionContinuitySnapshot =>
      continuitySnapshot({ sessionId: sessionId!, projectionRevision, rootTurn });
    const connection = {
      request: async (operation: string, input: { sessionId: string; turnId: string }) => {
        if (operation === 'session.create') {
          sessionId = input.sessionId;
          return (session = sessionProjection({ id: sessionId }));
        }
        if (operation === 'connection.catalog.query') return connectionCatalogPage();
        if (operation === 'session.catalog.query') return { kind: 'session', session };
        if (operation === 'turn.start') {
          admitted = {
            sessionId: input.sessionId,
            turnId: input.turnId,
            runId: 'run-unknown-start',
            status: 'running',
          };
          return start;
        }
        if (operation === 'turn.query') {
          turnQueries += 1;
          return new Promise<never>(() => undefined);
        }
        if (operation === 'turn.stop') {
          stops.push(input);
          return {};
        }
        assert.fail(`Unexpected operation: ${operation}`);
      },
      openSessionSubscription: async () => {
        opens += 1;
        if (opens === 1) {
          first = new FakeSubscription(snapshot(1, null), Promise.resolve([]));
          return first;
        }
        assert.ok(admitted);
        return new FakeSubscription(
          snapshot(2, admitted),
          Promise.resolve([]),
          'subscription-recovered',
        );
      },
      close: async () => undefined,
    } as unknown as RuntimeHostConnection;
    const harness = createHarness([], { stdin, connection });
    const run = harness.run();
    const response = () =>
      (
        harness.stdoutMessages() as Array<{
          id?: number;
          result?: { stopReason?: string };
        }>
      ).find(({ id }) => id === 2);
    const send = (value: unknown) => stdin.write(`${JSON.stringify(value)}\n`);

    try {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: { cwd: '/workspace', mcpServers: [] },
      });
      await waitFor(() =>
        harness.stdoutMessages().some((message) => (message as { id?: number }).id === 1),
      );
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: sessionId!, prompt: [{ type: 'text', text: 'Hello' }] },
      });
      await waitFor(() => Boolean(admitted && first));
      send({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: sessionId! },
      });
      rejectStart(
        new RuntimeHostRequestInterruptedError(
          'turn.start',
          'command',
          'dispatched',
          'connection_lost',
        ),
      );
      await waitFor(() => turnQueries === 1);
      first!.push({
        kind: 'subscription.closed',
        hostEpoch: 'host-1',
        subscriptionId: 'subscription-1',
        sequence: 1,
        reason: 'slow_consumer',
      });

      await waitFor(() => stops.length === 1 && Boolean(response()));
      assert.deepEqual(stops, [
        {
          sessionId: admitted!.sessionId,
          turnId: admitted!.turnId,
          runId: admitted!.runId,
        },
      ]);
      assert.deepEqual(response()?.result, { stopReason: 'cancelled' });
    } finally {
      stdin.end();
      await run;
    }
  });

  test('publishes a local configuration commit before a newer external revision', {
    timeout: 5_000,
  }, async () => {
    const stdin = new PassThrough();
    let sessionId: string | undefined;
    let initial: SessionCatalogProjection | undefined;
    let committed: SessionCatalogProjection | undefined;
    let external: SessionCatalogProjection | undefined;
    let turn:
      | {
          sessionId: string;
          turnId: string;
          runId: string;
          status: 'running';
        }
      | undefined;
    const snapshot = (
      projectionRevision: number,
      metadataRevision: number,
      rootTurn: SessionContinuitySnapshot['rootTurn'],
    ): SessionContinuitySnapshot =>
      continuitySnapshot({ sessionId: sessionId!, projectionRevision, metadataRevision, rootTurn });
    let releaseLocalProjection!: (catalog: ReturnType<typeof connectionCatalogPage>) => void;
    const localProjection = new Promise<ReturnType<typeof connectionCatalogPage>>((resolve) => {
      releaseLocalProjection = resolve;
    });
    let catalogReads = 0;
    let sessionReads = 0;
    let subscription: FakeSubscription | undefined;
    const connection = {
      request: async (operation: string, input: unknown) => {
        if (operation === 'session.create') {
          sessionId = (input as { sessionId: string }).sessionId;
          initial = sessionProjection({ id: sessionId });
          committed = sessionProjection({
            id: sessionId,
            revision: 2,
            permissionMode: 'bypass',
          });
          external = sessionProjection({
            id: sessionId,
            revision: 3,
            permissionMode: 'ask',
          });
          return initial;
        }
        if (operation === 'connection.catalog.query') {
          catalogReads += 1;
          return catalogReads === 2 ? localProjection : connectionCatalogPage();
        }
        if (operation === 'session.catalog.query') {
          sessionReads += 1;
          return { kind: 'session', session: sessionReads === 1 ? initial! : external! };
        }
        if (operation === 'session.configuration.update') {
          assert.deepEqual(input, {
            sessionId: sessionId!,
            expectedRevision: 1,
            patch: { permissionMode: 'bypass' },
          });
          return { kind: 'committed', session: committed! };
        }
        if (operation === 'turn.start') {
          const request = input as { sessionId: string; turnId: string };
          turn = {
            sessionId: request.sessionId,
            turnId: request.turnId,
            runId: 'run-configuration-order',
            status: 'running',
          };
          return { kind: 'started', turn };
        }
        assert.fail(`Unexpected operation: ${operation}`);
      },
      openSessionSubscription: async () => {
        subscription = new FakeSubscription(snapshot(1, 1, null), Promise.resolve([]));
        return subscription;
      },
      close: async () => undefined,
    } as unknown as RuntimeHostConnection;
    const harness = createHarness([], { stdin, connection });
    const run = harness.run();
    const send = (id: number, method: string, params: unknown) =>
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const response = (id: number) =>
      (
        harness.stdoutMessages() as Array<{
          id?: number;
          result?: { configOptions?: Array<{ id?: string; currentValue?: string }> };
        }>
      ).find((message) => message.id === id);
    const configurationUpdates = () =>
      (
        harness.stdoutMessages() as Array<{
          method?: string;
          params?: {
            update?: {
              sessionUpdate?: string;
              configOptions?: Array<{ id?: string; currentValue?: string }>;
            };
          };
        }>
      ).filter(
        (message) =>
          message.method === 'session/update' &&
          message.params?.update?.sessionUpdate === 'config_option_update',
      );
    let sequence = 0;
    let terminalPushed = false;
    const pushSnapshot = (next: SessionContinuitySnapshot) => {
      subscription!.push({
        kind: 'subscription.session_projection',
        hostEpoch: 'host-1',
        subscriptionId: 'subscription-1',
        sequence: ++sequence,
        snapshot: next,
      });
    };

    try {
      send(1, 'session/new', { cwd: '/workspace', mcpServers: [] });
      await waitFor(() => Boolean(response(1)));
      send(2, 'session/prompt', {
        sessionId: sessionId!,
        prompt: [{ type: 'text', text: 'Attach this Session' }],
      });
      await waitFor(() => Boolean(turn && subscription));

      send(3, 'session/set_config_option', {
        sessionId: sessionId!,
        configId: 'permission_mode',
        value: 'bypass',
      });
      await waitFor(() => catalogReads === 2);

      pushSnapshot(snapshot(2, 3, turn!));
      await waitFor(() => subscription!.nextCalls >= 2);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(configurationUpdates(), []);

      releaseLocalProjection(connectionCatalogPage());
      await waitFor(() => configurationUpdates().length === 2 && Boolean(response(3)));

      assert.deepEqual(
        configurationUpdates().map(
          ({ params }) =>
            params?.update?.configOptions?.find(({ id }) => id === 'permission_mode')?.currentValue,
        ),
        ['bypass', 'ask'],
      );
      assert.equal(
        response(3)?.result?.configOptions?.find(({ id }) => id === 'permission_mode')
          ?.currentValue,
        'bypass',
      );
      assert.equal(sessionReads, 2);

      terminalPushed = true;
      pushSnapshot(
        snapshot(3, 3, {
          ...turn!,
          status: 'completed',
          terminalEventId: 'terminal-configuration-order',
        }),
      );
      await waitFor(() => Boolean(response(2)));
    } finally {
      releaseLocalProjection(connectionCatalogPage());
      if (subscription && turn && !terminalPushed) {
        pushSnapshot(
          snapshot(3, 3, {
            ...turn,
            status: 'completed',
            terminalEventId: 'terminal-configuration-order',
          }),
        );
      }
      stdin.end();
      await run;
    }
  });

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

function continuitySnapshot(input: {
  readonly sessionId: string;
  readonly projectionRevision: number;
  readonly metadataRevision?: number;
  readonly rootTurn: SessionContinuitySnapshot['rootTurn'];
  readonly status?: 'active' | 'running';
}): SessionContinuitySnapshot {
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: input.sessionId,
      metadataRevision: input.metadataRevision ?? 1,
      status: input.status ?? (input.rootTurn ? 'running' : 'active'),
      createdAt: 1,
      isArchived: false,
    },
    projectionRevision: input.projectionRevision,
    rootTurn: input.rootTurn,
    goal: null,
    queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] },
    interactions: { pending: [] },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

class FakeSubscription implements RuntimeHostSessionSubscription, AsyncIterator<SubscriptionFrame> {
  subscribePtyData(): () => void {
    return () => undefined;
  }
  readonly #sessionDomainListeners = new Set<
    (frame: Extract<SubscriptionFrame, { kind: 'subscription.session_domain_changed' }>) => void
  >();
  subscribeSessionDomainChanges(
    listener: (
      frame: Extract<SubscriptionFrame, { kind: 'subscription.session_domain_changed' }>,
    ) => void,
  ): () => void {
    this.#sessionDomainListeners.add(listener);
    return () => this.#sessionDomainListeners.delete(listener);
  }
  readonly hostEpoch = 'host-1';
  readonly activeAssistantStreams = [];
  readonly transcriptBootstrap = null;
  readonly subscriptionId: string;
  readonly #frames: SubscriptionFrame[] = [];
  readonly #waiters: Array<{
    resolve(result: IteratorResult<SubscriptionFrame>): void;
    reject(error: Error): void;
  }> = [];
  nextCalls = 0;
  #closed = false;
  #failure: Error | undefined;

  constructor(
    readonly snapshot: SessionContinuitySnapshot,
    private readonly transcript: Promise<StoredMessage[]>,
    subscriptionId = 'subscription-1',
  ) {
    this.subscriptionId = subscriptionId;
  }

  [Symbol.asyncIterator](): AsyncIterator<SubscriptionFrame> {
    return this;
  }

  next(): Promise<IteratorResult<SubscriptionFrame>> {
    this.nextCalls += 1;
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve({ done: false, value: frame });
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  push(frame: SubscriptionFrame): void {
    if (frame.kind === 'subscription.session_domain_changed') {
      for (const listener of this.#sessionDomainListeners) listener(frame);
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: frame });
    else this.#frames.push(frame);
  }

  fail(error: Error): void {
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  async loadTranscript<T>(decodeMessage: (value: unknown) => T): Promise<T[]> {
    return (await this.transcript).map(decodeMessage);
  }

  async loadTranscriptOverlay<T>(_decodeMessage: (value: unknown) => T): Promise<T[]> {
    return [];
  }

  async decodeTranscriptPage(): Promise<never> {
    throw new Error('Fake subscription does not expose transcript pages');
  }

  async loadTranscriptPage(): Promise<never> {
    throw new Error('Fake subscription does not expose transcript pages');
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }
}

const unsupportedRequests = {
  question: {
    kind: 'question',
    toolUseId: 'tool-1',
    questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
  },
  form: {
    kind: 'form',
    toolUseId: 'tool-1',
    message: 'Configure',
    requester: { name: 'test', source: 'MCP' },
    fields: [{ kind: 'string', name: 'name', label: 'Name', required: true }],
  },
  permission: {
    kind: 'permission',
    toolUseId: 'tool-1',
    prompt: {
      kind: 'tool_permission',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      review: { kind: 'command', command: 'echo test', cwd: '/workspace' },
      rememberForTurnAllowed: true,
    },
  },
  sandbox_boundary: {
    kind: 'sandbox_boundary',
    expansion: { network: { enabled: true } },
    justification: 'Network access',
  },
  client_capability: {
    kind: 'client_capability',
    toolUseId: 'tool-1',
    target: {
      providerId: 'provider',
      contractId: 'contract',
      serverId: 'server',
      toolName: 'tool',
      capability: 'desktop_mcp',
      scope: { kind: 'mcp_tool', serverId: 'server', toolName: 'tool' },
    },
  },
} satisfies Record<string, InteractionRequest>;
