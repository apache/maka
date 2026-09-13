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
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  RequestError,
  type NewSessionRequest,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk';
import { THINKING_LEVELS, type ThinkingLevel } from '@maka/core/model-thinking';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from '@maka/runtime-host/client';
import {
  SESSION_CATALOG_CWD_MAX_BYTES,
  type SessionCatalogProjection,
} from '@maka/runtime-host/protocol';
import { AcpSessionRegistry, type AcpSessionRegistryConnection } from '../acp/session-registry.js';

const SESSION_REVISION = `sha256:${'a'.repeat(64)}` as const;
const NEW_SESSION_REVISION = `sha256:${'b'.repeat(64)}` as const;

const DEFAULT_CONFIG_OPTIONS: Array<Extract<SessionConfigOption, { type: 'select' }>> = [
  {
    type: 'select',
    id: 'permission_mode',
    name: 'Permission mode',
    category: '_maka/permission_mode',
    currentValue: 'ask',
    options: [
      { value: 'ask', name: 'Ask' },
      { value: 'bypass', name: 'Bypass' },
    ],
  },
  {
    type: 'select',
    id: 'thinking_level',
    name: 'Thinking level',
    category: 'thought_level',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'off', name: 'Off' },
      { value: 'minimal', name: 'Minimal' },
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'Extra high' },
      { value: 'max', name: 'Max' },
    ],
  },
  {
    type: 'select',
    id: 'collaboration_mode',
    name: 'Collaboration mode',
    category: 'mode',
    currentValue: 'agent',
    options: [
      { value: 'agent', name: 'Agent' },
      { value: 'plan', name: 'Plan' },
    ],
  },
  {
    type: 'select',
    id: 'orchestration_mode',
    name: 'Orchestration mode',
    category: '_maka/orchestration_mode',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'swarm', name: 'Swarm' },
      { value: 'graph', name: 'Graph' },
    ],
  },
];

describe('ACP Session registry', () => {
  test('does not connect when disposed before a Session method is used', async () => {
    let connectCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        return fakeConnection();
      },
    });

    await registry.dispose();
    await registry.dispose();

    assert.equal(connectCalls, 0);
  });

  test('reports the requested Session operation after disposal', async () => {
    const registry = new AcpSessionRegistry({
      connect: async () => fakeConnection(),
    });
    await registry.dispose();

    for (const [operation, request] of [
      ['session.create', () => registry.create({ cwd: '/workspace', mcpServers: [] })],
      ['session.catalog.query', () => registry.list({})],
      [
        'session.configuration.update',
        () =>
          registry.setConfigOption({
            sessionId: 'session-closed',
            configId: 'permission_mode',
            value: 'bypass',
          }),
      ],
    ] as const) {
      await assert.rejects(request(), (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.code, -32603);
        assert.deepEqual(error.data, {
          source: 'runtime_host',
          operation,
          code: 'registry_closed',
        });
        return true;
      });
    }
  });

  test('does not start a queued connection after disposal begins', async () => {
    let connectCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        return fakeConnection();
      },
    });

    const list = registry.list({});
    const dispose = registry.dispose();

    await assert.rejects(
      list,
      (error: unknown) =>
        error instanceof RequestError &&
        error.code === -32603 &&
        (error.data as { code?: string }).code === 'registry_closed',
    );
    await dispose;
    assert.equal(connectCalls, 0);
  });

  test('aborts an in-flight connection before disposal waits for it', async () => {
    let connectSignal: AbortSignal | undefined;
    const registry = new AcpSessionRegistry({
      connect: async (signal) => {
        connectSignal = signal;
        return new Promise<ReturnType<typeof fakeConnection>>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    const list = registry.list({});
    await waitFor(() => connectSignal !== undefined);
    const dispose = registry.dispose();

    await assert.rejects(
      list,
      (error: unknown) =>
        error instanceof RequestError &&
        error.code === -32603 &&
        (error.data as { code?: string }).code === 'registry_closed',
    );
    await dispose;
    assert.equal(connectSignal?.aborted, true);
  });

  test('shares one in-flight connection across concurrent Session methods', async () => {
    const connecting = deferred<ReturnType<typeof fakeConnection>>();
    let connectCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        return connecting.promise;
      },
      newSessionId: () => 'session-concurrent',
    });
    const create = registry.create({ cwd: '/workspace', mcpServers: [] });
    const list = registry.list({});
    await waitFor(() => connectCalls === 1);

    connecting.resolve(
      fakeConnection({
        request: async (operation) =>
          operation === 'session.catalog.query'
            ? {
                kind: 'page',
                revision: SESSION_REVISION,
                sessions: [],
                nextCursor: null,
              }
            : catalogSession('session-concurrent'),
      }),
    );

    assert.deepEqual(await create, {
      sessionId: 'session-concurrent',
      configOptions: DEFAULT_CONFIG_OPTIONS,
    });
    assert.deepEqual(await list, { sessions: [] });
    assert.equal(connectCalls, 1);
    await registry.dispose();
  });

  test('reports a stable connection error and retries on a later Session request', async () => {
    let connectCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        if (connectCalls === 1) throw new Error('Host unavailable');
        return fakeConnection({
          request: async () => ({
            kind: 'page',
            revision: SESSION_REVISION,
            sessions: [],
            nextCursor: null,
          }),
        });
      },
    });

    await assert.rejects(registry.list({}), (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32603);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'connect',
        code: 'connection_failed',
      });
      return true;
    });
    assert.deepEqual(await registry.list({}), { sessions: [] });
    assert.equal(connectCalls, 2);
    await registry.dispose();
  });

  test('closes a connection that resolves after disposal starts', async () => {
    const connecting = deferred<ReturnType<typeof fakeConnection>>();
    let connectCalls = 0;
    let closeCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        return connecting.promise;
      },
    });
    const list = registry.list({});
    await waitFor(() => connectCalls === 1);
    const dispose = registry.dispose();

    connecting.resolve(
      fakeConnection({
        close: async () => {
          closeCalls += 1;
        },
      }),
    );

    await assert.rejects(list, (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32603);
      assert.equal((error.data as { code?: string }).code, 'registry_closed');
      return true;
    });
    await dispose;
    assert.equal(closeCalls, 1);
  });

  test('creates more than the Host subscription limit without opening a subscription', async () => {
    const sessionCount = 17;
    const createdSessionIds: string[] = [];
    let subscriptionOpens = 0;
    let nextId = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        const connection = fakeConnection({
          request: async (operation, input) => {
            assert.equal(operation, 'session.create');
            const sessionId = (input as { sessionId: string }).sessionId;
            createdSessionIds.push(sessionId);
            return catalogSession(sessionId);
          },
        });
        return {
          ...connection,
          openSessionSubscriptionOnce: async () => {
            subscriptionOpens += 1;
            throw new Error('PR 2 must not open a subscription');
          },
        } as AcpSessionRegistryConnection;
      },
      newSessionId: () => `session-unattached-${++nextId}`,
    });

    const creates = await Promise.all(
      Array.from({ length: sessionCount }, () =>
        registry.create({ cwd: '/workspace', mcpServers: [] }),
      ),
    );

    assert.equal(creates.length, sessionCount);
    assert.equal(createdSessionIds.length, sessionCount);
    assert.equal(subscriptionOpens, 0);
    await registry.dispose();
  });

  test('returns projected configuration and owns only a representable successful create', async () => {
    const requests: Array<{ operation: string; input: unknown }> = [];
    let subscriptionOpens = 0;
    const created = catalogSession('session-configured', '/workspace', {
      thinkingLevel: 'high',
      permissionMode: 'explore',
      collaborationMode: 'plan',
      orchestrationMode: 'swarm',
    });
    const registry = new AcpSessionRegistry({
      connect: async () => {
        const connection = fakeConnection({
          thinkingLevels: ['low', 'high'],
          request: async (operation, input) => {
            requests.push({ operation, input });
            return created;
          },
        });
        return {
          ...connection,
          openSessionSubscriptionOnce: async () => {
            subscriptionOpens += 1;
            throw new Error('PR 2 must not open a subscription');
          },
        } as AcpSessionRegistryConnection;
      },
      newSessionId: () => 'session-configured',
    });

    const response = await registry.create({ cwd: '/workspace', mcpServers: [] });

    assert.deepEqual(response, {
      sessionId: 'session-configured',
      configOptions: configOptions(
        {
          permission_mode: 'explore',
          thinking_level: 'high',
          collaboration_mode: 'plan',
          orchestration_mode: 'swarm',
        },
        ['low', 'high'],
      ),
    });
    assert.deepEqual(requests, [
      {
        operation: 'session.create',
        input: {
          sessionId: 'session-configured',
          workspace: { kind: 'host_path', path: '/workspace' },
          modelTarget: { kind: 'default' },
        },
      },
    ]);
    assert.equal(subscriptionOpens, 0);
    await registry.dispose();
  });

  test('omits thinking configuration when the selected model declares no levels', async () => {
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          thinkingLevels: [],
          request: async (operation) => {
            assert.equal(operation, 'session.create');
            return catalogSession('session-no-thinking');
          },
        }),
      newSessionId: () => 'session-no-thinking',
    });

    const response = await registry.create({ cwd: '/workspace', mcpServers: [] });

    assert.deepEqual(
      response.configOptions?.map(({ id }) => id),
      ['permission_mode', 'collaboration_mode', 'orchestration_mode'],
    );
    await registry.dispose();
  });

  test('does not grant ownership by listing a Session', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return {
              kind: 'page',
              revision: SESSION_REVISION,
              sessions: [catalogSession('listed-session')],
              nextCursor: null,
            };
          },
        }),
    });
    await registry.list({});

    await assertInvalidParams(
      registry.setConfigOption({
        sessionId: 'listed-session',
        configId: 'permission_mode',
        value: 'bypass',
      }),
      { reason: 'unknown_session' },
    );
    assert.equal(requests, 1);
    await registry.dispose();
  });

  test('does not grant ownership after failed or legacy creates', async () => {
    for (const [name, createOutcome] of [
      [
        'failed',
        new RuntimeHostOperationError('session.create', 'operation_conflict', 'create failed'),
      ],
      [
        'legacy',
        {
          kind: 'unsupported_legacy_record',
          id: 'session-legacy',
          revision: 1,
          reason: 'not_wire_representable',
        },
      ],
    ] as const) {
      let requests = 0;
      const sessionId = `session-${name}`;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async () => {
              requests += 1;
              if (createOutcome instanceof Error) throw createOutcome;
              return createOutcome;
            },
          }),
        newSessionId: () => sessionId,
      });

      await assert.rejects(registry.create({ cwd: '/workspace', mcpServers: [] }));
      await assertInvalidParams(
        registry.setConfigOption({
          sessionId,
          configId: 'permission_mode',
          value: 'bypass',
        }),
        { reason: 'unknown_session' },
      );
      assert.equal(requests, 1);
      await registry.dispose();
    }
  });

  test('rejects non-owned and invalid configuration requests before Host I/O', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return catalogSession('session-owned');
          },
        }),
      newSessionId: () => 'session-owned',
    });

    await assertInvalidParams(
      registry.setConfigOption({
        sessionId: 'session-unowned',
        configId: 'permission_mode',
        value: 'bypass',
      }),
      { reason: 'unknown_session' },
    );
    assert.equal(requests, 0);

    await registry.create({ cwd: '/workspace', mcpServers: [] });
    assert.equal(requests, 1);
    for (const [request, data] of [
      [
        { sessionId: 'session-owned', configId: 'unknown', value: 'bypass' },
        { field: 'configId', reason: 'unsupported' },
      ],
      [
        {
          sessionId: 'session-owned',
          configId: 'permission_mode',
          value: true,
          type: 'boolean',
        },
        { field: 'value', reason: 'invalid_type' },
      ],
      [
        { sessionId: 'session-owned', configId: 'permission_mode', value: 'maybe' },
        { field: 'value', reason: 'unsupported' },
      ],
    ] as const) {
      await assertInvalidParams(
        registry.setConfigOption(request as SetSessionConfigOptionRequest),
        data,
      );
      assert.equal(requests, 1);
    }
    await registry.dispose();
  });

  test('updates one configuration field with the latest revision and returns committed options', async () => {
    const current = catalogSession('session-cas', '/workspace', {
      revision: 7,
      thinkingLevel: 'minimal',
    });
    const committed = catalogSession('session-cas', '/workspace', {
      revision: 8,
      permissionMode: 'bypass',
      thinkingLevel: 'high',
    });
    const requests: Array<{ operation: string; input: unknown }> = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            requests.push({ operation, input });
            if (operation === 'session.create') return catalogSession('session-cas');
            if (operation === 'session.catalog.query') {
              return { kind: 'session', session: current };
            }
            return { kind: 'committed', session: committed };
          },
        }),
      newSessionId: () => 'session-cas',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });

    const response = await registry.setConfigOption({
      sessionId: 'session-cas',
      configId: 'permission_mode',
      value: 'bypass',
    });

    assert.deepEqual(requests.slice(1), [
      {
        operation: 'session.catalog.query',
        input: { kind: 'get', sessionId: 'session-cas' },
      },
      {
        operation: 'session.configuration.update',
        input: {
          sessionId: 'session-cas',
          expectedRevision: 7,
          patch: { permissionMode: 'bypass' },
        },
      },
    ]);
    assert.deepEqual(response, {
      configOptions: configOptions({ permission_mode: 'bypass', thinking_level: 'high' }),
    });
    await registry.dispose();
  });

  test('rereads the Session after one revision conflict before retrying', async () => {
    const requests: Array<{ operation: string; input: unknown }> = [];
    let reads = 0;
    let updates = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            requests.push({ operation, input });
            if (operation === 'session.create') return catalogSession('session-retry');
            if (operation === 'session.catalog.query') {
              reads += 1;
              return {
                kind: 'session',
                session: catalogSession('session-retry', '/workspace', {
                  revision: reads,
                  collaborationMode: reads === 1 ? 'agent' : 'plan',
                }),
              };
            }
            updates += 1;
            return updates === 1
              ? { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 }
              : {
                  kind: 'committed',
                  session: catalogSession('session-retry', '/workspace', {
                    revision: 3,
                    permissionMode: 'bypass',
                    collaborationMode: 'plan',
                  }),
                };
          },
        }),
      newSessionId: () => 'session-retry',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });

    await registry.setConfigOption({
      sessionId: 'session-retry',
      configId: 'permission_mode',
      value: 'bypass',
    });

    assert.deepEqual(
      requests.slice(1).map(({ operation }) => operation),
      [
        'session.catalog.query',
        'session.configuration.update',
        'session.catalog.query',
        'session.configuration.update',
      ],
    );
    assert.deepEqual(requests[4]?.input, {
      sessionId: 'session-retry',
      expectedRevision: 2,
      patch: { permissionMode: 'bypass' },
    });
    await registry.dispose();
  });

  test('concurrent different-field changes converge through one-field CAS patches', async () => {
    const firstReads = deferred<{ kind: 'session'; session: SessionCatalogProjection }>();
    const requests: Array<{ operation: string; input: unknown }> = [];
    let reads = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            requests.push({ operation, input });
            if (operation === 'session.create') return catalogSession('session-converge');
            if (operation === 'session.catalog.query') {
              reads += 1;
              if (reads <= 2) {
                if (reads === 2) {
                  firstReads.resolve({
                    kind: 'session',
                    session: catalogSession('session-converge'),
                  });
                }
                return firstReads.promise;
              }
              return {
                kind: 'session',
                session: catalogSession('session-converge', '/workspace', {
                  revision: 2,
                  permissionMode: 'bypass',
                }),
              };
            }
            const patch = (input as { patch: Record<string, unknown> }).patch;
            if ('permissionMode' in patch) {
              return {
                kind: 'committed',
                session: catalogSession('session-converge', '/workspace', {
                  revision: 2,
                  permissionMode: 'bypass',
                }),
              };
            }
            if ((input as { expectedRevision: number }).expectedRevision === 1) {
              return { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 };
            }
            return {
              kind: 'committed',
              session: catalogSession('session-converge', '/workspace', {
                revision: 3,
                permissionMode: 'bypass',
                collaborationMode: 'plan',
              }),
            };
          },
        }),
      newSessionId: () => 'session-converge',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });

    const [permission, collaboration] = await Promise.all([
      registry.setConfigOption({
        sessionId: 'session-converge',
        configId: 'permission_mode',
        value: 'bypass',
      }),
      registry.setConfigOption({
        sessionId: 'session-converge',
        configId: 'collaboration_mode',
        value: 'plan',
      }),
    ]);

    const updates = requests.filter(
      ({ operation }) => operation === 'session.configuration.update',
    );
    assert.deepEqual(
      updates.map(({ input }) => (input as { patch: unknown }).patch),
      [{ permissionMode: 'bypass' }, { collaborationMode: 'plan' }, { collaborationMode: 'plan' }],
    );
    assert.deepEqual(permission, {
      configOptions: configOptions({ permission_mode: 'bypass' }),
    });
    assert.deepEqual(collaboration, {
      configOptions: configOptions({
        permission_mode: 'bypass',
        collaboration_mode: 'plan',
      }),
    });
    await registry.dispose();
  });

  test('stops after three revision conflicts without a fourth Host operation', async () => {
    const requests: Array<{ operation: string; input: unknown }> = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            requests.push({ operation, input });
            if (operation === 'session.create') return catalogSession('session-conflicts');
            if (operation === 'session.catalog.query') {
              return { kind: 'session', session: catalogSession('session-conflicts') };
            }
            return { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 };
          },
        }),
      newSessionId: () => 'session-conflicts',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });

    await assert.rejects(
      registry.setConfigOption({
        sessionId: 'session-conflicts',
        configId: 'thinking_level',
        value: 'off',
      }),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.code, -32603);
        assert.deepEqual(error.data, {
          source: 'runtime_host',
          operation: 'session.configuration.update',
          code: 'revision_conflict',
          attempts: 3,
        });
        return true;
      },
    );
    assert.deepEqual(
      requests.slice(1).map(({ operation }) => operation),
      [
        'session.catalog.query',
        'session.configuration.update',
        'session.catalog.query',
        'session.configuration.update',
        'session.catalog.query',
        'session.configuration.update',
      ],
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 7);
    await registry.dispose();
  });

  test('rejects invalid, missing, and legacy catalog lookup results with stable errors', async () => {
    for (const [name, result, acpCode, data] of [
      [
        'invalid',
        {
          kind: 'page',
          revision: SESSION_REVISION,
          sessions: [],
          nextCursor: null,
        },
        -32603,
        {
          source: 'runtime_host',
          operation: 'session.catalog.query',
          code: 'catalog_read_failure',
          reason: 'invalid_projection',
        },
      ],
      [
        'missing',
        { kind: 'session', session: null },
        -32602,
        {
          source: 'runtime_host',
          operation: 'session.catalog.query',
          code: 'not_found',
        },
      ],
      [
        'legacy',
        {
          kind: 'session',
          session: {
            kind: 'unsupported_legacy_record',
            id: 'session-legacy',
            revision: 1,
            reason: 'not_wire_representable',
          },
        },
        -32603,
        {
          source: 'runtime_host',
          operation: 'session.catalog.query',
          code: 'unsupported_session_projection',
        },
      ],
    ] as const) {
      const sessionId = `session-${name}`;
      let requests = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              requests += 1;
              return operation === 'session.create' ? catalogSession(sessionId) : result;
            },
          }),
        newSessionId: () => sessionId,
      });
      await registry.create({ cwd: '/workspace', mcpServers: [] });

      await assert.rejects(
        registry.setConfigOption({
          sessionId,
          configId: 'permission_mode',
          value: 'bypass',
        }),
        (error: unknown) => {
          assert.ok(error instanceof RequestError);
          assert.equal(error.code, acpCode);
          assert.deepEqual(error.data, data);
          return true;
        },
      );
      assert.equal(requests, 2);
      await registry.dispose();
    }
  });

  test('maps configuration Host failures without retrying them', async () => {
    for (const [hostError, acpCode, data] of [
      [
        new RuntimeHostOperationError(
          'session.configuration.update',
          'invalid_request',
          'invalid update',
        ),
        -32602,
        {
          source: 'runtime_host',
          operation: 'session.configuration.update',
          code: 'invalid_request',
        },
      ],
      [
        new RuntimeHostOperationError(
          'session.configuration.update',
          'not_found',
          'missing Session',
        ),
        -32602,
        {
          source: 'runtime_host',
          operation: 'session.configuration.update',
          code: 'not_found',
        },
      ],
      ...(['session_busy', 'operation_conflict', 'commit_outcome_unknown'] as const).map(
        (code) =>
          [
            new RuntimeHostOperationError('session.configuration.update', code, 'update failed'),
            -32603,
            {
              source: 'runtime_host',
              operation: 'session.configuration.update',
              code,
            },
          ] as const,
      ),
      [
        new RuntimeHostRequestInterruptedError(
          'session.configuration.update',
          'command',
          'dispatched',
          'connection_lost',
        ),
        -32603,
        {
          source: 'runtime_host',
          operation: 'session.configuration.update',
          code: 'request_interrupted',
          reason: 'connection_lost',
          dispatch: 'dispatched',
        },
      ],
    ] as const) {
      let requests = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              requests += 1;
              if (operation === 'session.create') return catalogSession('session-errors');
              if (operation === 'session.catalog.query') {
                return { kind: 'session', session: catalogSession('session-errors') };
              }
              throw hostError;
            },
          }),
        newSessionId: () => 'session-errors',
      });
      await registry.create({ cwd: '/workspace', mcpServers: [] });

      await assert.rejects(
        registry.setConfigOption({
          sessionId: 'session-errors',
          configId: 'permission_mode',
          value: 'bypass',
        }),
        (error: unknown) => {
          assert.ok(error instanceof RequestError);
          assert.equal(error.code, acpCode);
          assert.deepEqual(error.data, data);
          return true;
        },
      );
      assert.equal(requests, 3);
      await registry.dispose();
    }
  });

  test('does not start an update after disposal begins during its catalog read', async () => {
    const catalogRead = deferred<{ kind: 'session'; session: SessionCatalogProjection }>();
    let catalogReads = 0;
    let updates = 0;
    let closeCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession('session-closing');
            if (operation === 'session.catalog.query') {
              catalogReads += 1;
              return catalogRead.promise;
            }
            updates += 1;
            return {
              kind: 'committed',
              session: catalogSession('session-closing', '/workspace', { revision: 2 }),
            };
          },
          close: async () => {
            closeCalls += 1;
          },
        }),
      newSessionId: () => 'session-closing',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    const update = registry.setConfigOption({
      sessionId: 'session-closing',
      configId: 'permission_mode',
      value: 'bypass',
    });
    await waitFor(() => catalogReads === 1);

    const dispose = registry.dispose();
    catalogRead.resolve({
      kind: 'session',
      session: catalogSession('session-closing'),
    });

    await assert.rejects(update, (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32603);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'session.configuration.update',
        code: 'registry_closed',
      });
      return true;
    });
    await dispose;
    assert.equal(updates, 0);
    assert.equal(closeCalls, 1);
  });

  test('does not reread after a held update conflicts during disposal', async () => {
    const heldUpdate = deferred<{
      kind: 'revision_conflict';
      expectedRevision: number;
      actualRevision: number;
    }>();
    let catalogReads = 0;
    let updates = 0;
    let closeCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession('session-conflict-closing');
            if (operation === 'session.catalog.query') {
              catalogReads += 1;
              if (catalogReads === 1) {
                return {
                  kind: 'session',
                  session: catalogSession('session-conflict-closing'),
                };
              }
              throw new RuntimeHostRequestInterruptedError(
                'session.catalog.query',
                'query',
                'dispatched',
                'connection_lost',
              );
            }
            updates += 1;
            return heldUpdate.promise;
          },
          close: async () => {
            closeCalls += 1;
          },
        }),
      newSessionId: () => 'session-conflict-closing',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    const update = registry.setConfigOption({
      sessionId: 'session-conflict-closing',
      configId: 'permission_mode',
      value: 'bypass',
    });
    await waitFor(() => updates === 1);

    const dispose = registry.dispose();
    heldUpdate.resolve({ kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 });

    await assert.rejects(update, (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32603);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'session.configuration.update',
        code: 'registry_closed',
      });
      return true;
    });
    await dispose;
    assert.equal(catalogReads, 1);
    assert.equal(updates, 1);
    assert.equal(closeCalls, 1);
  });

  test('rejects unsupported creation inputs before touching Runtime Host', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return {};
          },
        }),
    });

    const cases: Array<readonly [string, NewSessionRequest]> = [
      [
        'mcpServers',
        {
          cwd: '/workspace',
          mcpServers: [{ name: 'server', command: 'server', args: [], env: [] }],
        },
      ],
      [
        'additionalDirectories',
        {
          cwd: '/workspace',
          mcpServers: [],
          additionalDirectories: ['/other'],
        },
      ],
      ['cwd', { cwd: 'relative', mcpServers: [] }],
      [
        'cwd',
        {
          cwd: `/${'x'.repeat(SESSION_CATALOG_CWD_MAX_BYTES)}`,
          mcpServers: [],
        },
      ],
    ];
    for (const [field, input] of cases) {
      await assert.rejects(
        registry.create(input),
        (error: unknown) =>
          error instanceof RequestError &&
          error.code === -32602 &&
          (error.data as { field?: string }).field === field,
      );
    }
    assert.equal(requests, 0);
    await registry.dispose();
  });

  test('keeps failed and outcome-unknown creates distinct', async () => {
    for (const [hostCode, acpCode] of [
      ['invalid_request', -32602],
      ['commit_outcome_unknown', -32603],
    ] as const) {
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async () => {
              throw new RuntimeHostOperationError('session.create', hostCode, 'create failed');
            },
          }),
        newSessionId: () => `session-${hostCode}`,
      });

      await assert.rejects(
        registry.create({ cwd: '/workspace', mcpServers: [] }),
        (error: unknown) => {
          assert.ok(error instanceof RequestError);
          assert.equal(error.code, acpCode);
          assert.deepEqual(error.data, {
            source: 'runtime_host',
            operation: 'session.create',
            code: hostCode,
            sessionId: `session-${hostCode}`,
          });
          return true;
        },
      );
      await registry.dispose();
    }
  });

  test('maps one filtered Host catalog page per ACP page and carries cwd across pages', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-acp-list-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    await mkdir(workspace);
    await symlink(workspace, alias);
    const canonicalWorkspace = await realpath(workspace);
    const inputs: unknown[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            assert.equal(operation, 'session.catalog.query');
            inputs.push(input);
            if ((input as { kind: string }).kind === 'list_start') {
              return {
                kind: 'page',
                revision: SESSION_REVISION,
                sessions: [
                  catalogSession('other', join(root, 'other'), {
                    name: 'Other',
                    activityAt: 1_000,
                  }),
                  {
                    kind: 'unsupported_legacy_record',
                    id: 'legacy',
                    revision: 1,
                    reason: 'not_wire_representable',
                  },
                ],
                nextCursor: 'page-2',
              };
            }
            return {
              kind: 'page',
              revision: SESSION_REVISION,
              sessions: [
                catalogSession('matching', canonicalWorkspace, {
                  name: 'Matching session',
                  activityAt: 2_000,
                }),
                catalogSession('undated', canonicalWorkspace, {
                  name: 'Out-of-range activity',
                  activityAt: Number.MAX_SAFE_INTEGER,
                }),
              ],
              nextCursor: null,
            };
          },
        }),
    });

    const first = await registry.list({ cwd: alias });
    assert.deepEqual(first.sessions, []);
    assert.equal(typeof first.nextCursor, 'string');
    const second = await registry.list({ cursor: first.nextCursor });
    assert.deepEqual(second, {
      sessions: [
        {
          sessionId: 'matching',
          cwd: canonicalWorkspace,
          title: 'Matching session',
          updatedAt: '1970-01-01T00:00:02.000Z',
        },
        {
          sessionId: 'undated',
          cwd: canonicalWorkspace,
          title: 'Out-of-range activity',
        },
      ],
    });
    assert.deepEqual(inputs, [
      { kind: 'list_start' },
      { kind: 'list_continue', revision: SESSION_REVISION, cursor: 'page-2' },
    ]);
    await registry.dispose();
  });

  test('rejects a cursor reused with a different normalized cwd before Host I/O', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return {
              kind: 'page',
              revision: SESSION_REVISION,
              sessions: [],
              nextCursor: 'page-2',
            };
          },
        }),
    });
    const first = await registry.list({ cwd: '/workspace/one/../one' });

    await assert.rejects(
      registry.list({ cwd: '/workspace/two', cursor: first.nextCursor }),
      (error: unknown) =>
        error instanceof RequestError &&
        error.code === -32602 &&
        (error.data as { reason?: string }).reason === 'cursor_cwd_mismatch',
    );
    assert.equal(requests, 1);
    await registry.dispose();
  });

  test('rejects malformed and oversized ACP cursors as invalid params', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return {};
          },
        }),
    });
    const invalidRevisionCursor = Buffer.from(
      JSON.stringify({
        revision: 'sha256:bad',
        cursor: 'page-2',
        cwd: null,
      }),
      'utf8',
    ).toString('base64url');
    const versionedCursor = Buffer.from(
      JSON.stringify({
        v: 1,
        revision: SESSION_REVISION,
        cursor: 'page-2',
        cwd: null,
      }),
      'utf8',
    ).toString('base64url');
    for (const cursor of [
      'not-a-cursor',
      'x'.repeat(8 * 1024 + 1),
      invalidRevisionCursor,
      versionedCursor,
    ]) {
      await assert.rejects(
        registry.list({ cursor }),
        (error: unknown) =>
          error instanceof RequestError &&
          error.code === -32602 &&
          (error.data as { reason?: string }).reason === 'invalid_cursor',
      );
    }
    assert.equal(requests, 0);
    await registry.dispose();
  });

  test('translates stale and repeated Host cursors into stable ACP errors', async () => {
    for (const [nextResult, expectedCode, expectedReason] of [
      [
        {
          kind: 'revision_changed',
          expectedRevision: SESSION_REVISION,
          actualRevision: NEW_SESSION_REVISION,
        },
        -32602,
        'stale_cursor',
      ],
      [
        {
          kind: 'page',
          revision: SESSION_REVISION,
          sessions: [],
          nextCursor: 'page-2',
        },
        -32603,
        'repeated_cursor',
      ],
    ] as const) {
      let first = true;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async () => {
              if (!first) return nextResult;
              first = false;
              return {
                kind: 'page',
                revision: SESSION_REVISION,
                sessions: [],
                nextCursor: 'page-2',
              };
            },
          }),
      });
      const page = await registry.list({});
      await assert.rejects(registry.list({ cursor: page.nextCursor }), (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.code, expectedCode);
        assert.equal((error.data as { reason?: string; code?: string }).reason, expectedReason);
        return true;
      });
      await registry.dispose();
    }
  });

  test('maps Runtime Host invalid_request from session/list to invalid params', async () => {
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            throw new RuntimeHostOperationError(
              'session.catalog.query',
              'invalid_request',
              'invalid query',
            );
          },
        }),
    });

    await assert.rejects(registry.list({}), (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32602);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'session.catalog.query',
        code: 'invalid_request',
      });
      return true;
    });
    await registry.dispose();
  });
});

function fakeConnection(
  overrides: {
    request?: (operation: string, input: unknown) => Promise<unknown>;
    close?: () => Promise<void>;
    thinkingLevels?: readonly ThinkingLevel[];
  } = {},
): AcpSessionRegistryConnection {
  return {
    request: async (operation, input) =>
      operation === 'connection.catalog.query'
        ? connectionCatalogPage(overrides.thinkingLevels ?? THINKING_LEVELS)
        : (overrides.request?.(operation, input) ?? {}),
    close: overrides.close ?? (async () => undefined),
  } as AcpSessionRegistryConnection;
}

function connectionCatalogPage(thinkingLevels: readonly ThinkingLevel[]) {
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
          thinkingLevels,
        },
      },
    ],
    nextCursor: null,
  };
}

function catalogSession(
  id: string,
  cwd = '/workspace',
  overrides: Partial<SessionCatalogProjection> = {},
): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    workspace: { target: { kind: 'host_path', path: cwd }, hostCwd: cwd },
    createdAt: 1,
    activityAt: 1,
    name: id,
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

function configOptions(
  values: Partial<
    Record<
      'permission_mode' | 'thinking_level' | 'collaboration_mode' | 'orchestration_mode',
      string
    >
  >,
  thinkingLevels: readonly ThinkingLevel[] = THINKING_LEVELS,
): SessionConfigOption[] {
  const options: SessionConfigOption[] = structuredClone(DEFAULT_CONFIG_OPTIONS);
  const thinking = options.find(({ id }) => id === 'thinking_level');
  if (thinking?.type === 'select') {
    thinking.options = thinking.options.flatMap((option) =>
      'value' in option &&
      (option.value === 'default' || thinkingLevels.includes(option.value as ThinkingLevel))
        ? [option]
        : [],
    );
  }
  for (const option of options) {
    if (option.type !== 'select') continue;
    option.currentValue = values[option.id as keyof typeof values] ?? option.currentValue;
  }
  return options;
}

async function assertInvalidParams(
  promise: Promise<unknown>,
  data: Record<string, unknown>,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.code, -32602);
    assert.deepEqual(error.data, data);
    return true;
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
