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
const revision = `sha256:${'a'.repeat(64)}` as const;

describe('Project catalog protocol', () => {
  test('declares bounded ready operations and exact invalidations', () => {
    assert.deepEqual(
      Object.fromEntries(
        (['project.catalog.query', 'project.catalog.mutate'] as const).map((operation) => [
          operation,
          {
            mode: HOST_OPERATION_SPECS[operation].mode,
            availability: HOST_OPERATION_SPECS[operation].availability,
          },
        ]),
      ),
      {
        'project.catalog.query': { mode: 'query', availability: 'ready' },
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
      { kind: 'select', projectId: 'project-1' },
      { kind: 'touch', projectId: 'project-1', path: null },
      { kind: 'touch', projectId: 'project-1', path: projectPath },
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
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-select',
        operation: 'project.catalog.mutate',
        ok: true,
        result: { kind: 'selection', projectId: 'project-1', path: projectPath },
      }),
      {
        requestId: 'request-select',
        operation: 'project.catalog.mutate',
        ok: true,
        result: { kind: 'selection', projectId: 'project-1', path: projectPath },
      },
    );
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['project.catalog.mutate'].assertOutputForInput?.(
          { kind: 'select', projectId: 'project-1' },
          { kind: 'project', projectId: 'project-1' },
        ),
      isProtocolError,
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
    preferredPath: projectPath,
  } as const;
}

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError;
}
