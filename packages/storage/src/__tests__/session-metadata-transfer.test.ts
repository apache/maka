import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { CreateSessionInput } from '@maka/core';
import { importLegacySessionMetadataTree } from '../session-metadata-transfer.js';
import {
  createLegacyFileSessionStore as createLegacyStore,
  createSessionStore,
  SQLITE_SESSION_METADATA_DATABASE_NAME,
} from '../session-store.js';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

describe('legacy session metadata transfer', () => {
  test('imports every legacy line-1 header without reading transcript payloads as metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transfer-'));
    const legacy = createLegacyStore(root);
    const sqlite = createSqliteSessionMetadataStore(join(root, 'state.sqlite'));
    try {
      const first = await legacy.create(makeInput({ name: 'First', labels: ['alpha'] }));
      const second = await legacy.create(makeInput({ name: 'Second', labels: ['beta'] }));
      await legacy.appendMessage(first.id, {
        type: 'user',
        id: 'user-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'This transcript row is not session metadata.',
      });
      await legacy.updateHeader(second.id, {
        status: 'blocked',
        blockedReason: 'permission_required',
        hasUnread: true,
      });

      const report = await importLegacySessionMetadataTree({
        workspaceRoot: root,
        destination: sqlite,
      });
      assert.deepEqual(report, {
        filesScanned: 2,
        headersRead: 2,
        headersImported: 2,
        headersExisting: 0,
        sourcesAlreadyImported: 0,
        sourcesTombstoned: 0,
      });
      assert.deepEqual((await sqlite.list()).map((record) => record.header.name).sort(), [
        'First',
        'Second',
      ]);
      assert.deepEqual(
        (await sqlite.read(first.id)).header,
        await legacy.readHeaderSnapshot(first.id),
      );
      assert.deepEqual(
        (await sqlite.read(second.id)).header,
        await legacy.readHeaderSnapshot(second.id),
      );

      await legacy.appendMessage(second.id, {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 11,
        text: 'Appending transcript bytes must not invalidate the imported header.',
        modelId: 'fake-model',
      });
      await sqlite.update(first.id, { name: 'SQLite is canonical now' });
      const repeated = await importLegacySessionMetadataTree({
        workspaceRoot: root,
        destination: sqlite,
      });
      assert.deepEqual(repeated, {
        filesScanned: 2,
        headersRead: 2,
        headersImported: 0,
        headersExisting: 0,
        sourcesAlreadyImported: 2,
        sourcesTombstoned: 0,
      });
      assert.equal((await sqlite.read(first.id)).header.name, 'SQLite is canonical now');
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('decodes legacy compatibility defaults through the FileSessionStore codec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transfer-legacy-'));
    const sqlite = createSqliteSessionMetadataStore(join(root, 'state.sqlite'));
    const sessionId = 'legacy-session';
    const path = join(root, 'sessions', sessionId, 'session.jsonl');
    try {
      const legacy = {
        id: sessionId,
        workspaceRoot: root,
        cwd: '/workspace',
        createdAt: 1,
        lastUsedAt: 2,
        name: 'New Session',
        isFlagged: false,
        labels: [],
        isArchived: false,
        pendingCwdReminder: {
          from: '/workspace/old',
          to: '/workspace',
        },
        hasUnread: false,
        backend: 'pi',
        llmConnectionSlug: 'legacy',
        connectionLocked: false,
        schemaVersion: 1,
      };
      await mkdir(join(root, 'sessions', sessionId), { recursive: true });
      await writeFile(path, `${JSON.stringify(legacy)}\n`, 'utf8');

      await importLegacySessionMetadataTree({ workspaceRoot: root, destination: sqlite });
      const header = (await sqlite.read(sessionId)).header;
      assert.equal(header.backend, 'pi-agent');
      assert.equal(header.model, 'default');
      assert.equal(header.permissionMode, 'ask');
      assert.equal(header.collaborationMode, 'agent');
      assert.equal(header.orchestrationMode, 'default');
      assert.equal(header.status, 'active');
      assert.equal(header.titleIsManual, false);
      assert.equal(header.name, 'New Chat');
      assert.equal(Object.hasOwn(header, 'pendingCwdReminder'), false);
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('skips a malformed header without tombstoning it while importing valid sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transfer-invalid-'));
    const legacy = createLegacyStore(root);
    const sqlite = createSqliteSessionMetadataStore(join(root, 'state.sqlite'));
    try {
      const valid = await legacy.create(makeInput({ name: 'Valid' }));
      const invalid = await legacy.create(makeInput({ name: 'Invalid' }));
      const invalidPath = join(root, 'sessions', invalid.id, 'session.jsonl');
      const lines = (await readFile(invalidPath, 'utf8')).split('\n');
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), labels: 'not-an-array' });
      await writeFile(invalidPath, lines.join('\n'), 'utf8');

      const report = await importLegacySessionMetadataTree({
        workspaceRoot: root,
        destination: sqlite,
      });
      assert.equal(report.filesScanned, 2);
      assert.equal(report.headersImported, 1);
      // The valid session was imported.
      assert.equal((await sqlite.read(valid.id)).header.name, 'Valid');
      // The malformed session was skipped, not imported and not tombstoned.
      assert.equal(await sqlite.has(invalid.id), false);
      assert.equal(await sqlite.isTombstoned(invalid.id), false);
      // Re-importing should skip the malformed session again (not tombstoned).
      const repeated = await importLegacySessionMetadataTree({
        workspaceRoot: root,
        destination: sqlite,
      });
      assert.equal(repeated.filesScanned, 2);
      assert.equal(repeated.headersImported, 0);
      // Repairing the header should allow it to be imported on the next run.
      const repairedLines = (await readFile(invalidPath, 'utf8')).split('\n');
      const repairedHeader = JSON.parse(repairedLines[0]!);
      repairedHeader.labels = ['repaired'];
      repairedLines[0] = JSON.stringify(repairedHeader);
      await writeFile(invalidPath, repairedLines.join('\n'), 'utf8');
      const repaired = await importLegacySessionMetadataTree({
        workspaceRoot: root,
        destination: sqlite,
      });
      assert.equal(repaired.headersImported, 1);
      assert.equal((await sqlite.read(invalid.id)).header.name, 'Invalid');
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps canonical metadata readable when its optional transcript is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transfer-missing-transcript-'));
    const legacy = createLegacyStore(root);
    const sqlite = createSqliteSessionMetadataStore(join(root, 'state.sqlite'));
    try {
      const created = await legacy.create(makeInput({ name: 'Canonical metadata' }));
      await importLegacySessionMetadataTree({ workspaceRoot: root, destination: sqlite });
      await rm(join(root, 'sessions', created.id, 'session.jsonl'));

      const report = await importLegacySessionMetadataTree({
        workspaceRoot: root,
        destination: sqlite,
      });

      assert.deepEqual(report, {
        filesScanned: 1,
        headersRead: 0,
        headersImported: 0,
        headersExisting: 0,
        sourcesAlreadyImported: 0,
        sourcesTombstoned: 0,
      });
      assert.equal((await sqlite.read(created.id)).header.name, 'Canonical metadata');
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('malformed legacy headers at the public SessionStore boundary', () => {
  async function setupWorkspaceWithCorruptSession(
    corruptContent: (originalHeaderLine: string) => string,
  ): Promise<{
    root: string;
    validId: string;
    corruptId: string;
    corruptPath: string;
    originalHeaderLine: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-boundary-'));
    const legacy = createLegacyStore(root);
    const valid = await legacy.create(makeInput({ name: 'Valid' }));
    const corrupt = await legacy.create(makeInput({ name: 'Corrupt' }));
    await legacy.close?.();
    const corruptPath = join(root, 'sessions', corrupt.id, 'session.jsonl');
    const originalHeaderLine = (await readFile(corruptPath, 'utf8')).split('\n')[0]!;
    await writeFile(corruptPath, corruptContent(originalHeaderLine), 'utf8');
    return {
      root,
      validId: valid.id,
      corruptId: corrupt.id,
      corruptPath,
      originalHeaderLine,
    };
  }

  function openMetadata(root: string) {
    return createSqliteSessionMetadataStore(join(root, SQLITE_SESSION_METADATA_DATABASE_NAME));
  }

  async function assertRepairableMalformedHeader(
    corruptContent: (originalHeaderLine: string) => string,
  ): Promise<void> {
    const { root, validId, corruptId, corruptPath, originalHeaderLine } =
      await setupWorkspaceWithCorruptSession(corruptContent);
    try {
      const store = createSessionStore(root);
      try {
        assert.deepEqual(
          (await store.list()).map((session) => session.id),
          [validId],
        );
        await assert.rejects(store.readHeader(corruptId), /Session metadata not found/);
      } finally {
        await store.close?.();
      }

      const meta = openMetadata(root);
      try {
        assert.equal(await meta.has(corruptId), false);
        assert.equal(await meta.isTombstoned(corruptId), false);
      } finally {
        meta.close();
      }

      await writeFile(corruptPath, `${originalHeaderLine}\n`, 'utf8');
      const reopened = createSessionStore(root);
      try {
        const repaired = await reopened.list();
        assert.equal(repaired.length, 2);
        assert.equal(
          repaired.some((session) => session.id === corruptId && session.name === 'Corrupt'),
          true,
        );
      } finally {
        await reopened.close?.();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const repairableMalformedHeaders = [
    {
      name: 'empty session.jsonl',
      content: () => '',
    },
    {
      name: 'truncated JSON without a newline',
      content: () => '{ "id": "truncated"',
    },
    {
      name: 'complete valid header over 1 MiB',
      content: (originalHeaderLine: string) => {
        const header = JSON.parse(originalHeaderLine) as Record<string, unknown>;
        header.name = 'x'.repeat(1024 * 1024);
        return `${JSON.stringify(header)}\n`;
      },
    },
    {
      name: 'turn_state first record',
      content: () =>
        `${JSON.stringify({
          type: 'turn_state',
          id: 'state-1',
          turnId: 'turn-1',
          ts: 1,
          status: 'running',
          partialOutputRetained: false,
        })}\n`,
    },
  ];

  for (const { name, content } of repairableMalformedHeaders) {
    test(`${name}: skips only the corrupt session and imports it after repair`, () =>
      assertRepairableMalformedHeader(content));
  }

  async function assertInvalidCurrentTranscriptMarker(marker: {
    sessionId: string;
    schemaVersion: number;
  }): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-boundary-invalid-marker-'));
    const legacy = createLegacyStore(root);
    try {
      const valid = await legacy.create(makeInput({ name: 'Valid' }));
      await legacy.close?.();
      const markerSessionId = 'invalid-marker-session';
      const markerDir = join(root, 'sessions', markerSessionId);
      await mkdir(markerDir, { recursive: true });
      await writeFile(
        join(markerDir, 'session.jsonl'),
        `${JSON.stringify({
          type: 'session_transcript',
          ...marker,
        })}\n`,
        'utf8',
      );

      const store = createSessionStore(root);
      try {
        await assert.rejects(store.list(), /invalid transcript marker/);
      } finally {
        await store.close?.();
      }

      const meta = openMetadata(root);
      try {
        assert.equal(await meta.has(valid.id), false);
        assert.equal(await meta.has(markerSessionId), false);
        assert.equal(await meta.isTombstoned(markerSessionId), false);
      } finally {
        meta.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  for (const { name, marker } of [
    {
      name: 'wrong session id',
      marker: { sessionId: 'wrong-session-id', schemaVersion: 1 },
    },
    {
      name: 'unsupported schema version',
      marker: { sessionId: 'invalid-marker-session', schemaVersion: 2 },
    },
  ]) {
    test(`current transcript marker with ${name} rejects without partial import`, () =>
      assertInvalidCurrentTranscriptMarker(marker));
  }

  test('EISDIR filesystem failure: store.list() rejects with EISDIR, no metadata or tombstone written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-boundary-eisdir-'));
    const legacy = createLegacyStore(root);
    try {
      const valid = await legacy.create(makeInput({ name: 'Valid' }));
      const unreadable = await legacy.create(makeInput({ name: 'Unreadable' }));
      await legacy.close?.();
      const unreadablePath = join(root, 'sessions', unreadable.id, 'session.jsonl');
      // Replace the session file with a directory to provoke EISDIR.
      await rm(unreadablePath);
      await mkdir(unreadablePath);

      const store = createSessionStore(root);
      try {
        await assert.rejects(
          store.list(),
          (error: NodeJS.ErrnoException) => error.code === 'EISDIR',
        );
      } finally {
        await store.close?.();
      }

      const meta = openMetadata(root);
      try {
        assert.equal(await meta.has(valid.id), false);
        assert.equal(await meta.has(unreadable.id), false);
        assert.equal(await meta.isTombstoned(unreadable.id), false);
      } finally {
        meta.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function makeInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'Session',
    labels: [],
    ...overrides,
  };
}
