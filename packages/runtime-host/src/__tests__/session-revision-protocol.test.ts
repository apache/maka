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

describe('Session revision protocol', () => {
  test('rejects aliasing, unknown fields, and mismatched response identities', () => {
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-1',
          operation: 'session.branch.create',
          input: {
            sourceSessionId: 'same-session',
            targetSessionId: 'same-session',
            sourceTurnId: 'turn-1',
            expectedSourceRevision: 1,
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-1',
          operation: 'session.revision.create',
          input: {
            sourceSessionId: 'source-session',
            targetSessionId: 'target-session',
            sourceTurnId: 'turn-1',
            expectedSourceRevision: 1,
            ignored: true,
          },
        }),
      isInvalidFrame,
    );
    const input = {
      sourceSessionId: 'source-session',
      targetSessionId: 'target-session',
      sourceTurnId: 'turn-1',
      expectedSourceRevision: 1,
    };
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['session.branch.create'].assertOutputForInput?.(input, {
          kind: 'committed',
          session: sessionProjection('wrong-target'),
        }),
      isInvalidFrame,
    );
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-abandon',
        operation: 'session.revision.abandon',
        ok: true,
        result: { kind: 'retained', sessionId: 'revision-target' },
      }),
      {
        requestId: 'request-abandon',
        operation: 'session.revision.abandon',
        ok: true,
        result: { kind: 'retained', sessionId: 'revision-target' },
      },
    );
  });

  test('preserves optimistic source revision conflicts on the wire', () => {
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-1',
        operation: 'session.revision.create',
        ok: true,
        result: {
          kind: 'source_revision_conflict',
          expectedRevision: 4,
          actualRevision: 5,
        },
      }),
      {
        requestId: 'request-1',
        operation: 'session.revision.create',
        ok: true,
        result: {
          kind: 'source_revision_conflict',
          expectedRevision: 4,
          actualRevision: 5,
        },
      },
    );
  });

  test('keeps single-target Revision abandonment identity exact', () => {
    const frame = decodeClientFrame({
      requestId: 'request-abandon',
      operation: 'session.revision.abandon',
      input: { targetSessionId: 'revision-target' },
    });
    assert.deepEqual(frame, {
      requestId: 'request-abandon',
      operation: 'session.revision.abandon',
      input: { targetSessionId: 'revision-target' },
    });
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['session.revision.abandon'].assertOutputForInput?.(
          { targetSessionId: 'revision-target' },
          { kind: 'abandoned', sessionId: 'other-target' },
        ),
      isInvalidFrame,
    );
  });
});

function sessionProjection(id: string): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    workspace: {
      target: { kind: 'host_path', path: '/workspace' },
      hostCwd: '/workspace',
    },
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake-model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
