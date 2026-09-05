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
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import type { SessionCatalogProjection, SessionUpdateResult } from '@maka/runtime-host/protocol';
import {
  RuntimeHostSessionUpdateError,
  getRuntimeHostSession,
  updateRuntimeHostSession,
} from '../runtime-host-session-update.js';

test('reads the latest Session and returns the committed update', async () => {
  const requests: unknown[] = [];
  const connection = fakeConnection(async (_operation, input) => {
    requests.push(input);
    return { kind: 'session', session: sessionProjection({ revision: 7 }) };
  });

  const committed = await updateRuntimeHostSession(
    connection,
    'session-1',
    async (current) => {
      assert.equal(current.revision, 7);
      return {
        kind: 'committed',
        session: sessionProjection({ revision: 8, permissionMode: 'bypass' }),
      };
    },
    { operation: 'session.configuration.update' },
  );

  assert.equal(committed.revision, 8);
  assert.equal(committed.permissionMode, 'bypass');
  assert.deepEqual(requests, [{ kind: 'get', sessionId: 'session-1' }]);
});

test('rereads after a revision conflict and stops after three attempts', async () => {
  let reads = 0;
  let updates = 0;
  const connection = fakeConnection(async () => {
    reads += 1;
    return { kind: 'session', session: sessionProjection({ revision: reads }) };
  });

  await assert.rejects(
    updateRuntimeHostSession(
      connection,
      'session-1',
      async () => {
        updates += 1;
        return {
          kind: 'revision_conflict',
          expectedRevision: updates,
          actualRevision: updates + 1,
        };
      },
      { operation: 'session.configuration.update' },
    ),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeHostSessionUpdateError);
      assert.equal(error.operation, 'session.configuration.update');
      assert.equal(error.reason, 'revision_conflict');
      assert.equal(error.attempts, 3);
      return true;
    },
  );
  assert.equal(reads, 3);
  assert.equal(updates, 3);
});

test('reports missing and unsupported Session projections without caller-specific errors', async () => {
  const missing = fakeConnection(async () => ({ kind: 'session', session: null }));
  await assert.rejects(
    updateRuntimeHostSession(
      missing,
      'session-1',
      async (): Promise<SessionUpdateResult> => {
        assert.fail('missing Session must not reach the update');
      },
      { operation: 'session.configuration.update' },
    ),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeHostSessionUpdateError);
      assert.equal(error.operation, 'session.catalog.query');
      assert.equal(error.reason, 'not_found');
      return true;
    },
  );

  for (const [name, result, reason] of [
    [
      'legacy',
      {
        kind: 'session',
        session: {
          kind: 'unsupported_legacy_record',
          id: 'session-1',
          revision: 1,
          reason: 'not_wire_representable',
        },
      },
      'unsupported_session_projection',
    ],
    ['invalid', { kind: 'page', sessions: [], nextCursor: null }, 'invalid_projection'],
  ] as const) {
    const connection = fakeConnection(async () => result);
    await assert.rejects(getRuntimeHostSession(connection, 'session-1'), (error: unknown) => {
      assert.ok(error instanceof RuntimeHostSessionUpdateError, name);
      assert.equal(error.operation, 'session.catalog.query');
      assert.equal(error.reason, reason);
      return true;
    });
  }
});

test('checks caller lifecycle before every read and update', async () => {
  let allowed = true;
  let checks = 0;
  let reads = 0;
  const connection = fakeConnection(async () => {
    reads += 1;
    return { kind: 'session', session: sessionProjection() };
  });

  await assert.rejects(
    updateRuntimeHostSession(
      connection,
      'session-1',
      async (): Promise<SessionUpdateResult> => {
        assert.fail('update must not start after the lifecycle closes');
      },
      {
        operation: 'session.configuration.update',
        assertRequestAllowed: () => {
          checks += 1;
          if (!allowed) throw new Error('closed');
          allowed = false;
        },
      },
    ),
    /closed/,
  );
  assert.equal(checks, 2);
  assert.equal(reads, 1);
});

function fakeConnection(
  request: (operation: string, input: unknown) => Promise<unknown>,
): Pick<RuntimeHostConnection, 'request'> {
  return { request } as Pick<RuntimeHostConnection, 'request'>;
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
