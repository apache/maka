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
import { RequestError, type NewSessionRequest } from '@agentclientprotocol/sdk';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import { SESSION_CATALOG_CWD_MAX_BYTES } from '@maka/runtime-host/protocol';
import { AcpSessionRegistry, type AcpSessionRegistryConnection } from '../acp/session-registry.js';

const SESSION_REVISION = `sha256:${'a'.repeat(64)}` as const;
const NEW_SESSION_REVISION = `sha256:${'b'.repeat(64)}` as const;

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
            : {},
      }),
    );

    assert.deepEqual(await create, { sessionId: 'session-concurrent' });
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
            createdSessionIds.push((input as { sessionId: string }).sessionId);
            return {};
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
                  catalogSession('other', join(root, 'other'), 'Other', 1_000),
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
                catalogSession('matching', canonicalWorkspace, 'Matching session', 2_000),
                catalogSession(
                  'undated',
                  canonicalWorkspace,
                  'Out-of-range activity',
                  Number.MAX_SAFE_INTEGER,
                ),
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
  } = {},
): AcpSessionRegistryConnection {
  return {
    request: overrides.request ?? (async () => ({})),
    close: overrides.close ?? (async () => undefined),
  } as AcpSessionRegistryConnection;
}

function catalogSession(id: string, cwd: string, name: string, activityAt: number) {
  return {
    id,
    revision: 1,
    workspace: { target: { kind: 'host_path', path: cwd }, hostCwd: cwd },
    createdAt: 1,
    activityAt,
    name,
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'default',
    permissionMode: 'default',
    collaborationMode: 'default',
    orchestrationMode: 'default',
  };
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
