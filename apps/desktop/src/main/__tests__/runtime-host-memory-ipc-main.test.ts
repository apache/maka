import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import { registerRuntimeHostMemoryIpc } from '../runtime-host-memory-ipc-main.js';

test('restarts the complete Memory projection when its component revisions differ', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const revisionA = revision('a');
  const revisionB = revision('b');
  const documentA = revision('c');
  const documentB = revision('d');
  const queries = [
    state(revisionA, documentA),
    documentPage(documentB, 'new content'),
    entriesPage(revisionB, 'active'),
    entriesPage(revisionB, 'archived'),
    state(revisionB, documentB),
    documentPage(documentB, 'new content'),
    entriesPage(revisionB, 'active'),
    entriesPage(revisionB, 'archived'),
  ];
  let stateReads = 0;
  registerRuntimeHostMemoryIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {
      queryRuntimePolicy: async () => ({
        revision: 1,
        policy: createDefaultRuntimePolicy(),
      }),
      queryMemory: async (input: { kind: string }) => {
        if (input.kind === 'state') stateReads += 1;
        const result = queries.shift();
        if (!result) throw new Error(`Unexpected Memory query: ${input.kind}`);
        return result;
      },
    } as never,
    workspaceRoot: '/tmp/maka-memory',
    openPath: async () => '',
  });

  const projected = (await handlers.get('memory:getState')?.({})) as {
    content: string;
  };

  assert.equal(projected.content, 'new content');
  assert.equal(stateReads, 2);
  assert.equal(queries.length, 0);
});

test('projects a fresh workspace as an empty usable Memory state', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const queries: string[] = [];
  registerRuntimeHostMemoryIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {
      queryRuntimePolicy: async () => ({
        revision: 1,
        policy: createDefaultRuntimePolicy(),
      }),
      queryMemory: async (input: { kind: string }) => {
        queries.push(input.kind);
        return {
          kind: 'state',
          revision: revision('a'),
          memoryRevision: null,
          pendingRevision: null,
          agentReadEnabled: true,
          status: 'missing',
          entryCount: 0,
          activeEntryCount: 0,
          archivedEntryCount: 0,
          proposalCount: 0,
          backups: [],
        };
      },
    } as never,
    workspaceRoot: '/tmp/maka-memory',
    openPath: async () => '',
  });

  const projected = (await handlers.get('memory:getState')?.({})) as {
    status: string;
    content: string;
    entries: unknown[];
  };

  assert.equal(projected.status, 'ok');
  assert.equal(projected.content, '');
  assert.deepEqual(projected.entries, []);
  assert.deepEqual(queries, ['state']);
});

test('does not project or open remote Runtime Host file paths', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerRuntimeHostMemoryIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {
      queryRuntimePolicy: async () => ({
        revision: 1,
        policy: createDefaultRuntimePolicy(),
      }),
      queryMemory: async () => ({
        kind: 'state',
        revision: revision('a'),
        memoryRevision: null,
        pendingRevision: null,
        agentReadEnabled: true,
        status: 'missing',
        entryCount: 0,
        activeEntryCount: 0,
        archivedEntryCount: 0,
        proposalCount: 0,
        backups: [
          {
            kind: 'save',
            revision: revision('b'),
            updatedAt: 1,
            sizeBytes: 10,
            entryCount: 0,
            activeEntryCount: 0,
            archivedEntryCount: 0,
            safeMode: false,
          },
        ],
      }),
    } as never,
    workspaceRoot: '/client/maka-data',
    allowLocalPaths: false,
    openPath: async () => {
      throw new Error('must not open a Client path');
    },
  });

  const projected = (await handlers.get('memory:getState')?.({})) as {
    path: string;
    backups: Array<{ path: string }>;
  };
  const opened = (await handlers.get('memory:openFile')?.({})) as {
    ok: boolean;
    message: string;
  };

  assert.equal(projected.path, '');
  assert.deepEqual(projected.backups.map(({ path }) => path), ['']);
  assert.deepEqual(opened, {
    ok: false,
    message: 'Memory files are owned by the remote Runtime Host',
  });
});

function revision(value: string): `sha256:${string}` {
  return `sha256:${value.repeat(64)}`;
}

function state(
  bundleRevision: `sha256:${string}`,
  memoryRevision: `sha256:${string}`,
) {
  return {
    kind: 'state' as const,
    revision: bundleRevision,
    memoryRevision,
    pendingRevision: null,
    agentReadEnabled: true,
    status: 'ok' as const,
    entryCount: 0,
    activeEntryCount: 0,
    archivedEntryCount: 0,
    proposalCount: 0,
    backups: [],
  };
}

function documentPage(
  documentRevision: `sha256:${string}`,
  content: string,
) {
  return {
    kind: 'document_page' as const,
    document: 'memory' as const,
    revision: documentRevision,
    totalBytes: Buffer.byteLength(content),
    offset: 0,
    chunkBase64: Buffer.from(content).toString('base64'),
    nextCursor: null,
  };
}

function entriesPage(
  bundleRevision: `sha256:${string}`,
  view: 'active' | 'archived',
) {
  return {
    kind: 'entries_page' as const,
    view,
    revision: bundleRevision,
    items: [],
    nextCursor: null,
  };
}
