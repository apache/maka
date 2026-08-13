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
  test('decodes exact invalidations', () => {
    const frame = { kind: 'project.catalog.changed' as const, revision: 1 };
    assert.deepEqual(decodeHostFrame(frame), frame);
    assert.throws(() => decodeHostFrame({ ...frame, extra: true }), isProtocolError);
  });

  test('identifies Project catalog operations that expose Host paths', () => {
    const location = {
      requestId: 'request-location',
      operation: 'project.catalog.query' as const,
      ok: true as const,
      result: {
        kind: 'page' as const,
        view: 'locations' as const,
        revision,
        projectCount: 1,
        items: [
          projectHeaderItem(),
          {
            kind: 'location' as const,
            projectIndex: 0,
            itemIndex: 0,
            location: { path: projectPath, isWorktree: false },
          },
        ],
        nextCursor: null,
      },
    };
    const foreignLocation = {
      ...location,
      result: {
        ...location.result,
        items: [
          projectHeaderItem(),
          {
            kind: 'location' as const,
            projectIndex: 0,
            itemIndex: 0,
            location: { path: foreignHostPath, isWorktree: true },
          },
        ],
      },
    };
    assert.deepEqual(decodeHostFrame(foreignLocation), foreignLocation);
    assert.equal(
      HOST_OPERATION_SPECS['project.catalog.query'].usesHostPaths?.({
        kind: 'list_start',
        view: 'summary',
      }),
      false,
    );
    assert.equal(
      HOST_OPERATION_SPECS['project.catalog.query'].usesHostPaths?.({
        kind: 'list_start',
        view: 'locations',
      }),
      true,
    );
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
          input: { kind: 'list_start', view: 'summary', includeArchived: true },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeProjectCatalogQueryResult({
          kind: 'page',
          view: 'summary',
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
          view: 'summary',
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
    preferredLocationIndex: 0,
    archivedAt: null,
    available: true,
  } as const;
}

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError;
}
