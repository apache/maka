import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeExternalSessionCatalogQueryResult,
  decodeExternalSessionSourceQueryResult,
  EXTERNAL_SESSION_PAGE_MAX_ITEMS,
  HOST_OPERATION_SPECS,
  RuntimeHostProtocolError,
} from '../protocol/index.js';

describe('external Session protocol', () => {
  test('identifies external Session queries that expose Host paths', () => {
    assert.equal(
      HOST_OPERATION_SPECS['external-session.catalog.query'].usesHostPaths?.({
        adapterId: 'codex',
        workspace: { kind: 'project', projectId: 'project-1' },
      }),
      false,
    );
    assert.equal(
      HOST_OPERATION_SPECS['external-session.catalog.query'].usesHostPaths?.({
        adapterId: 'codex',
        workspace: { kind: 'host_path', path: '/workspace' },
      }),
      true,
    );
  });

  test('round-trips exact source, catalog, and import inputs', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-source',
        operation: 'external-session.source.query',
        input: {},
      }),
      {
        requestId: 'request-source',
        operation: 'external-session.source.query',
        input: {},
      },
    );
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-list',
        operation: 'external-session.catalog.query',
        input: {
          adapterId: 'codex',
          includeArchived: true,
          workspace: { kind: 'project', projectId: 'project-1' },
          cursor: '16',
        },
      }),
      {
        requestId: 'request-list',
        operation: 'external-session.catalog.query',
        input: {
          adapterId: 'codex',
          includeArchived: true,
          workspace: { kind: 'project', projectId: 'project-1' },
          cursor: '16',
        },
      },
    );
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-import',
        operation: 'external-session.import',
        input: { adapterId: 'codex', sourceSessionId: 'source-session-1' },
      }),
      {
        requestId: 'request-import',
        operation: 'external-session.import',
        input: { adapterId: 'codex', sourceSessionId: 'source-session-1' },
      },
    );
  });

  test('rejects open-ended, malformed, and oversized frames', () => {
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-extra',
          operation: 'external-session.source.query',
          input: { source: 'codex' },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-cursor',
          operation: 'external-session.catalog.query',
          input: { adapterId: 'codex', cursor: '-1' },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-id',
          operation: 'external-session.import',
          input: { adapterId: 'codex', sourceSessionId: 'bad\nsource' },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeExternalSessionCatalogQueryResult({
          sessions: Array.from({ length: EXTERNAL_SESSION_PAGE_MAX_ITEMS + 1 }, (_, index) => ({
            id: `source-${index}`,
            name: `Session ${index}`,
            hostCwd: '/workspace',
          })),
          nextCursor: null,
        }),
      isProtocolError,
    );
    assert.throws(
      () => decodeExternalSessionSourceQueryResult({ adapterIds: ['codex'], extra: true }),
      isProtocolError,
    );
  });
});

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
