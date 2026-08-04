import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  decodeSessionCatalogItem,
  decodeSessionCatalogQueryResult,
  HOST_OPERATION_SPECS,
  RuntimeHostProtocolError,
  SESSION_CATALOG_PAGE_MAX_ITEMS,
  type SessionCatalogProjection,
} from '../protocol/index.js';

describe('Session catalog protocol', () => {
  test('declares closed ready-only query and mutation operations', () => {
    assert.deepEqual(
      Object.fromEntries(
        (
          [
            'session.catalog.query',
            'session.create',
            'session.metadata.update',
            'session.configuration.update',
            'session.cwd.relocate',
            'session.read_marker.set',
            'session.execution_boundary.query',
          ] as const
        ).map((operation) => [
          operation,
          {
            mode: HOST_OPERATION_SPECS[operation].mode,
            availability: HOST_OPERATION_SPECS[operation].availability,
          },
        ]),
      ),
      {
        'session.catalog.query': { mode: 'query', availability: 'ready' },
        'session.create': { mode: 'command', availability: 'ready' },
        'session.metadata.update': { mode: 'command', availability: 'ready' },
        'session.configuration.update': { mode: 'command', availability: 'ready' },
        'session.cwd.relocate': { mode: 'command', availability: 'ready' },
        'session.read_marker.set': { mode: 'command', availability: 'ready' },
        'session.execution_boundary.query': { mode: 'query', availability: 'ready' },
      },
    );
  });

  test('decodes only bounded execution boundary summaries', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-1',
        operation: 'session.execution_boundary.query',
        input: { sessionId: 'session-1' },
      }),
      {
        requestId: 'request-1',
        operation: 'session.execution_boundary.query',
        input: { sessionId: 'session-1' },
      },
    );
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-1',
        operation: 'session.execution_boundary.query',
        ok: true,
        result: { kind: 'managed', access: 'read_only', revision: 3 },
      }),
      {
        requestId: 'request-1',
        operation: 'session.execution_boundary.query',
        ok: true,
        result: { kind: 'managed', access: 'read_only', revision: 3 },
      },
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-1',
          operation: 'session.execution_boundary.query',
          ok: true,
          result: { kind: 'managed', access: 'read_only', revision: 3, profile: {} },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-1',
          operation: 'session.execution_boundary.query',
          input: { sessionId: 'session-1', includeProfile: true },
        }),
      isProtocolError,
    );
  });

  test('decodes exact stable creation and full replacement configuration inputs', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-1',
        operation: 'session.create',
        input: {
          sessionId: 'session-1',
          cwd: '/workspace',
          projectId: null,
          name: 'Session',
          labels: ['catalog'],
          modelTarget: {
            kind: 'explicit',
            connectionSlug: 'openai-main',
            model: 'gpt-5',
          },
          thinkingLevel: 'high',
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        },
      }),
      {
        requestId: 'request-1',
        operation: 'session.create',
        input: {
          sessionId: 'session-1',
          cwd: '/workspace',
          projectId: null,
          name: 'Session',
          labels: ['catalog'],
          modelTarget: {
            kind: 'explicit',
            connectionSlug: 'openai-main',
            model: 'gpt-5',
          },
          thinkingLevel: 'high',
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        },
      },
    );

    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-3',
        operation: 'session.cwd.relocate',
        input: {
          sessionId: 'session-1',
          expectedRevision: 2,
          cwd: '/workspace/next',
        },
      }),
      {
        requestId: 'request-3',
        operation: 'session.cwd.relocate',
        input: {
          sessionId: 'session-1',
          expectedRevision: 2,
          cwd: '/workspace/next',
        },
      },
    );

    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-2',
        operation: 'session.configuration.update',
        input: {
          sessionId: 'session-1',
          expectedRevision: 2,
          configuration: {
            modelTarget: { kind: 'default' },
            thinkingLevel: null,
            permissionMode: 'bypass',
            collaborationMode: 'plan',
            orchestrationMode: 'graph',
          },
        },
      }),
      {
        requestId: 'request-2',
        operation: 'session.configuration.update',
        input: {
          sessionId: 'session-1',
          expectedRevision: 2,
          configuration: {
            modelTarget: { kind: 'default' },
            thinkingLevel: null,
            permissionMode: 'bypass',
            collaborationMode: 'plan',
            orchestrationMode: 'graph',
          },
        },
      },
    );
  });

  test('rejects partial, empty, or open-ended mutation shapes', () => {
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-1',
          operation: 'session.metadata.update',
          input: {
            sessionId: 'session-1',
            expectedRevision: 1,
            patch: {},
          },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-2',
          operation: 'session.configuration.update',
          input: {
            sessionId: 'session-1',
            expectedRevision: 1,
            configuration: {
              modelTarget: { kind: 'default' },
              thinkingLevel: null,
              permissionMode: 'ask',
              collaborationMode: 'agent',
            },
          },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-3',
          operation: 'session.read_marker.set',
          input: {
            sessionId: 'session-1',
            readThroughMessageId: 'message-1',
            timestamp: 1,
          },
        }),
      isProtocolError,
    );
  });

  test('accepts the complete 80-code-point Session name range', () => {
    const name = '🦊'.repeat(80);
    const decoded = decodeClientFrame({
      requestId: 'request-name',
      operation: 'session.create',
      input: {
        sessionId: 'session-name',
        cwd: '/workspace',
        name,
        modelTarget: { kind: 'default' },
      },
    });
    if ('kind' in decoded) assert.fail('Expected Session create frame');
    assert.equal(decoded.operation, 'session.create');
    if (decoded.operation !== 'session.create') assert.fail('Expected Session create frame');
    assert.equal(decoded.input.name, name);
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-name-overflow',
          operation: 'session.create',
          input: {
            sessionId: 'session-name-overflow',
            cwd: '/workspace',
            name: '🦊'.repeat(81),
            modelTarget: { kind: 'default' },
          },
        }),
      isProtocolError,
    );
  });

  test('accepts only declared Session start modes', () => {
    const decoded = decodeClientFrame({
      requestId: 'request-mode',
      operation: 'session.create',
      input: {
        sessionId: 'session-mode',
        cwd: '/workspace',
        mode: 'deep_research',
        modelTarget: { kind: 'default' },
      },
    });
    if ('kind' in decoded || decoded.operation !== 'session.create') {
      assert.fail('Expected Session create frame');
    }
    assert.equal(decoded.input.mode, 'deep_research');
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-invalid-mode',
          operation: 'session.create',
          input: {
            sessionId: 'session-invalid-mode',
            cwd: '/workspace',
            mode: 'unknown',
            modelTarget: { kind: 'default' },
          },
        }),
      isProtocolError,
    );
  });

  test('correlates committed and conflicting update outputs with the request Session', () => {
    const session = projection();
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-1',
        operation: 'session.metadata.update',
        ok: true,
        result: { kind: 'committed', session },
      }),
      {
        requestId: 'request-1',
        operation: 'session.metadata.update',
        ok: true,
        result: { kind: 'committed', session },
      },
    );
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-2',
        operation: 'session.configuration.update',
        ok: true,
        result: {
          kind: 'revision_conflict',
          expectedRevision: 1,
          actualRevision: 2,
        },
      }),
      {
        requestId: 'request-2',
        operation: 'session.configuration.update',
        ok: true,
        result: {
          kind: 'revision_conflict',
          expectedRevision: 1,
          actualRevision: 2,
        },
      },
    );
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['session.metadata.update'].assertOutputForInput?.(
          {
            sessionId: 'session-1',
            expectedRevision: 1,
            patch: { name: 'Renamed' },
          },
          {
            kind: 'committed',
            session: projection({ id: 'different-session' }),
          },
        ),
      isProtocolError,
    );
  });

  test('bounds pages and preserves revision-pinned continuation results', () => {
    const sessions = Array.from({ length: SESSION_CATALOG_PAGE_MAX_ITEMS }, (_, index) =>
      projection({ id: `session-${index}` }),
    );
    const page = {
      kind: 'page' as const,
      revision: `sha256:${'a'.repeat(64)}` as const,
      sessions,
      nextCursor: '32',
    };
    assert.deepEqual(decodeSessionCatalogQueryResult(page), page);
    assert.throws(
      () =>
        decodeSessionCatalogQueryResult({
          ...page,
          sessions: [...sessions, projection({ id: 'overflow' })],
        }),
      isProtocolError,
    );
    const changed = {
      kind: 'revision_changed' as const,
      expectedRevision: `sha256:${'a'.repeat(64)}` as const,
      actualRevision: `sha256:${'b'.repeat(64)}` as const,
    };
    assert.deepEqual(decodeSessionCatalogQueryResult(changed), changed);
  });

  test('decodes only the closed unsupported legacy record shape', () => {
    const unsupported = {
      kind: 'unsupported_legacy_record' as const,
      id: 'session-1',
      revision: 2,
      reason: 'not_wire_representable' as const,
    };
    assert.deepEqual(decodeSessionCatalogItem(unsupported), unsupported);
    assert.throws(
      () => decodeSessionCatalogItem({ ...unsupported, projectId: 'hidden' }),
      isProtocolError,
    );
  });
});

function projection(overrides: Partial<SessionCatalogProjection> = {}): SessionCatalogProjection {
  return {
    id: 'session-1',
    revision: 1,
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 2,
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError;
}
