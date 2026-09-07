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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  HOST_OPERATION_SPECS,
  type SessionCatalogProjection,
} from '../protocol/index.js';

describe('Session retirement protocol', () => {
  test('rejects open shapes, invalid states, and mismatched result identities', () => {
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-archive',
          operation: 'session.lifecycle.set',
          input: { sessionId: 'session-1', state: 'deleted' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-remove',
          operation: 'session.remove',
          input: { sessionId: 'session-1', expectedRevision: 0 },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['session.lifecycle.set'].assertOutputForInput?.(
          { sessionId: 'session-1', state: 'archived' },
          projection({ id: 'session-2', isArchived: true }),
        ),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['session.remove'].assertOutputForInput?.(
          { sessionId: 'session-1', expectedRevision: 2 },
          { kind: 'removed', sessionId: 'session-2' },
        ),
      isInvalidFrame,
    );
  });

  test('preserves removal conflicts and archived lifecycle state on the wire', () => {
    const archived = projection({
      isArchived: true,
      status: 'blocked',
      blockedReason: 'tool_failed',
    });
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-archive',
        operation: 'session.lifecycle.set',
        ok: true,
        result: archived,
      }),
      {
        requestId: 'request-archive',
        operation: 'session.lifecycle.set',
        ok: true,
        result: archived,
      },
    );
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-remove',
        operation: 'session.remove',
        ok: true,
        result: {
          kind: 'revision_conflict',
          expectedRevision: 2,
          actualRevision: 3,
        },
      }),
      {
        requestId: 'request-remove',
        operation: 'session.remove',
        ok: true,
        result: {
          kind: 'revision_conflict',
          expectedRevision: 2,
          actualRevision: 3,
        },
      },
    );
  });

  test('carries the archived-subtask count on a removed result and rejects a malformed one', () => {
    const withCount = {
      requestId: 'request-remove',
      operation: 'session.remove' as const,
      ok: true as const,
      result: { kind: 'removed' as const, sessionId: 'session-1', archivedSubtaskCount: 3 },
    };
    assert.deepEqual(decodeHostFrame(withCount), withCount);
    // Absent when nothing was archived — the common delete keeps its old shape.
    const withoutCount = {
      requestId: 'request-remove',
      operation: 'session.remove' as const,
      ok: true as const,
      result: { kind: 'removed' as const, sessionId: 'session-1' },
    };
    assert.deepEqual(decodeHostFrame(withoutCount), withoutCount);
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-remove',
          operation: 'session.remove',
          ok: true,
          result: { kind: 'removed', sessionId: 'session-1', archivedSubtaskCount: -1 },
        }),
      isInvalidFrame,
    );
  });

  test('round-trips the removal preview query and rejects a malformed count', () => {
    const request = {
      requestId: 'request-preview',
      operation: 'session.remove.preview' as const,
      input: { sessionId: 'session-1' },
    };
    assert.deepEqual(decodeClientFrame(request), request);
    const response = {
      requestId: 'request-preview',
      operation: 'session.remove.preview' as const,
      ok: true as const,
      result: { archivableSubtaskCount: 4 },
    };
    assert.deepEqual(decodeHostFrame(response), response);
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-preview',
          operation: 'session.remove.preview',
          ok: true,
          result: { archivableSubtaskCount: -1 },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-preview',
          operation: 'session.remove.preview',
          input: { sessionId: 'session-1', expectedRevision: 2 },
        }),
      isInvalidFrame,
    );
  });
});

function projection(overrides: Partial<SessionCatalogProjection> = {}): SessionCatalogProjection {
  return {
    id: 'session-1',
    revision: 1,
    workspace: {
      target: { kind: 'host_path', path: '/workspace' },
      hostCwd: '/workspace',
    },
    createdAt: 1,
    activityAt: 1,
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionId: null,
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake-model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
