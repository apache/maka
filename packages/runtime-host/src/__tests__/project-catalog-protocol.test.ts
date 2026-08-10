import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  decodeProjectCatalogQueryResult,
  HOST_OPERATION_SPECS,
  PROJECT_CATALOG_PAGE_MAX_ITEMS,
  RuntimeHostProtocolError,
} from '../protocol/index.js';

const projectPath = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
const foreignHostPath = process.platform === 'win32' ? '/workspace' : 'C:\\workspace';
const revision = `sha256:${'a'.repeat(64)}` as const;

describe('Project catalog protocol', () => {
  test('declares bounded ready operations and exact invalidations', () => {
    assert.deepEqual(
      Object.fromEntries(
        (
          [
            'project.catalog.query',
            'project.catalog.location.query',
            'project.catalog.mutate',
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
        'project.catalog.query': { mode: 'query', availability: 'ready' },
        'project.catalog.location.query': { mode: 'query', availability: 'ready' },
        'project.catalog.mutate': { mode: 'command', availability: 'ready' },
      },
    );
    const frame = { kind: 'project.catalog.changed' as const, revision: 1 };
    assert.deepEqual(decodeHostFrame(frame), frame);
    assert.throws(() => decodeHostFrame({ ...frame, extra: true }), isProtocolError);
  });

  test('round-trips every closed mutation shape and correlates its result', () => {
    for (const input of [
      { kind: 'register', path: projectPath },
      { kind: 'relink', projectId: 'project-1', path: projectPath },
      { kind: 'rename', projectId: 'project-1', name: 'Project' },
      { kind: 'archive', projectId: 'project-1' },
      { kind: 'restore', projectId: 'project-1' },
    ] as const) {
      const request = {
        requestId: `request-${input.kind}`,
        operation: 'project.catalog.mutate' as const,
        input,
      };
      assert.deepEqual(decodeClientFrame(request), request);
    }
    const mutation = {
      requestId: 'request-register',
      operation: 'project.catalog.mutate' as const,
      ok: true as const,
      result: {
        kind: 'project' as const,
        project: {
          id: 'project-1',
          aliases: [],
          name: 'Project',
          locationCount: 1,
          archivedAt: null,
          available: true,
        },
      },
    };
    assert.deepEqual(decodeHostFrame(mutation), mutation);
    const location = {
      requestId: 'request-location',
      operation: 'project.catalog.location.query' as const,
      ok: true as const,
      result: {
        projectId: 'project-1',
        locations: [{ path: projectPath, isWorktree: false }],
        preferredPath: projectPath,
      },
    };
    assert.deepEqual(decodeHostFrame(location), location);
    const foreignLocation = {
      ...location,
      result: {
        ...location.result,
        locations: [{ path: foreignHostPath, isWorktree: true }],
        preferredPath: foreignHostPath,
      },
    };
    assert.deepEqual(decodeHostFrame(foreignLocation), foreignLocation);
    assert.equal(
      HOST_OPERATION_SPECS['project.catalog.mutate'].usesHostPaths?.({
        kind: 'rename',
        projectId: 'project-1',
        name: 'Renamed',
      }),
      false,
    );
    assert.equal(
      HOST_OPERATION_SPECS['project.catalog.mutate'].usesHostPaths?.({
        kind: 'register',
        path: projectPath,
      }),
      true,
    );
  });

  test('rejects relative paths, open records, oversized pages, and stale shapes', () => {
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-1',
          operation: 'project.catalog.mutate',
          input: { kind: 'register', path: 'relative/project' },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-2',
          operation: 'project.catalog.query',
          input: { kind: 'list_start', includeArchived: true },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeProjectCatalogQueryResult({
          kind: 'page',
          revision,
          projectCount: 1,
          items: Array.from({ length: PROJECT_CATALOG_PAGE_MAX_ITEMS + 1 }, projectHeaderItem),
          nextCursor: null,
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeProjectCatalogQueryResult({
          kind: 'revision_changed',
          expected: revision,
          actual: revision,
          items: [],
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-stale-mutation',
          operation: 'project.catalog.mutate',
          ok: true,
          result: { kind: 'project', projectId: 'project-1' },
        }),
      isProtocolError,
    );
  });
});

function projectHeaderItem() {
  return {
    kind: 'project',
    projectIndex: 0,
    id: 'project-1',
    name: 'Project',
    aliasCount: 0,
    locationCount: 1,
    archivedAt: null,
    available: true,
  } as const;
}

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError;
}
