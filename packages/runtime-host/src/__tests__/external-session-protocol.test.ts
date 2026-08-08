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
  test('declares three bounded ready-only operations', () => {
    assert.deepEqual(
      Object.fromEntries(
        (
          [
            'external-session.source.query',
            'external-session.catalog.query',
            'external-session.import',
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
        'external-session.source.query': { mode: 'query', availability: 'ready' },
        'external-session.catalog.query': { mode: 'query', availability: 'ready' },
        'external-session.import': { mode: 'command', availability: 'ready' },
      },
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
          cwd: '/workspace',
          cursor: '16',
        },
      }),
      {
        requestId: 'request-list',
        operation: 'external-session.catalog.query',
        input: {
          adapterId: 'codex',
          includeArchived: true,
          cwd: '/workspace',
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
            cwd: '/workspace',
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
