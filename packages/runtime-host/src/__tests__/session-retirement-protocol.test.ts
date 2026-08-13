import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  HOST_OPERATION_SPECS,
  RuntimeHostProtocolError,
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
          projection({ id: 'session-2', isArchived: true, status: 'archived' }),
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
    const archived = projection({ isArchived: true, status: 'archived' });
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
    ...overrides,
  };
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
