import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeExternalSessionCatalogQueryResult,
  decodeExternalSessionSourceQueryResult,
  EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS,
  EXTERNAL_SESSION_PAGE_MAX_ITEMS,
  HOST_OPERATION_SPECS,
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

  test('round-trips required external Session import state', () => {
    const result = {
      sessions: [
        {
          id: 'source-1',
          name: 'Imported source',
          hostCwd: '/workspace',
          importState: {
            importedCount: 10,
            importedSessionIds: Array.from(
              { length: EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS },
              (_, index) => `imported-${EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS - index}`,
            ),
            isImporting: true,
          },
        },
      ],
      nextCursor: null,
    };

    assert.deepEqual(decodeExternalSessionCatalogQueryResult(result), result);
  });

  test('rejects missing, open, malformed, and inconsistent external Session import state', () => {
    const summary = {
      id: 'source-1',
      name: 'Imported source',
      hostCwd: '/workspace',
    };
    const decodeState = (importState?: unknown) =>
      decodeExternalSessionCatalogQueryResult({
        sessions: [{ ...summary, ...(importState === undefined ? {} : { importState }) }],
        nextCursor: null,
      });

    assert.throws(() => decodeState(), isProtocolError);
    assert.throws(
      () =>
        decodeState({
          importedCount: 1,
          importedSessionIds: ['imported-1'],
          isImporting: false,
          extra: true,
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeState({
          importedCount: -1,
          importedSessionIds: [],
          isImporting: false,
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeState({
          importedCount: EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS + 1,
          importedSessionIds: Array.from(
            { length: EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS + 1 },
            (_, index) => `imported-${index}`,
          ),
          isImporting: false,
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeState({
          importedCount: 1,
          importedSessionIds: ['invalid id'],
          isImporting: false,
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeState({
          importedCount: 0,
          importedSessionIds: [],
          isImporting: 'yes',
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeState({
          importedCount: 1,
          importedSessionIds: ['imported-2', 'imported-1'],
          isImporting: false,
        }),
      isProtocolError,
    );
  });

  test('rejects sparse imported Session id arrays', () => {
    const importedSessionIds = Array<string>(1);

    assert.throws(
      () =>
        decodeExternalSessionCatalogQueryResult({
          sessions: [
            {
              id: 'source-1',
              name: 'Imported source',
              hostCwd: '/workspace',
              importState: {
                importedCount: 1,
                importedSessionIds,
                isImporting: false,
              },
            },
          ],
          nextCursor: null,
        }),
      isProtocolError,
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
            importState: {
              importedCount: 0,
              importedSessionIds: [],
              isImporting: false,
            },
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
