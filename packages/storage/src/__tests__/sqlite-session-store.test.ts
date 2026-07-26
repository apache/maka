import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { CreateSessionInput, SessionHeader } from '@maka/core';
import {
  createLegacyFileSessionStore,
  createSessionStore,
  isSessionNotFoundError,
  SessionNotFoundError,
  SQLITE_SESSION_METADATA_DATABASE_NAME,
} from '../session-store.js';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

describe('default SQLite session metadata store', () => {
  test('SQLite and legacy File stores expose one typed missing-Session boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-store-not-found-'));
    const stores = [
      createSessionStore(join(root, 'sqlite')),
      createLegacyFileSessionStore(join(root, 'legacy')),
    ];
    try {
      for (const store of stores) {
        await assert.rejects(store.readHeaderSnapshot('deleted-session'), (error) => {
          assert.ok(error instanceof SessionNotFoundError);
          assert.equal(isSessionNotFoundError(error), true);
          assert.equal(error.code, 'session_not_found');
          assert.equal(error.sessionId, 'deleted-session');
          return true;
        });
      }
    } finally {
      await Promise.all(stores.map((store) => store.close?.()));
      await rm(root, { recursive: true, force: true });
    }
  });

  test('waits for in-flight legacy metadata import before closing SQLite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-store-close-ready-'));
    const legacy = createLegacyFileSessionStore(root);
    const created = await legacy.create(makeInput({ name: 'Imported before close' }));
    const store = createSessionStore(root);

    try {
      await store.close?.();
      const metadata = createSqliteSessionMetadataStore(
        join(root, SQLITE_SESSION_METADATA_DATABASE_NAME),
      );
      try {
        assert.equal((await metadata.read(created.id)).header.name, 'Imported before close');
      } finally {
        metadata.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses SQLite as canonical metadata while keeping transcript bodies in JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-store-'));
    const store = createSessionStore(root);
    try {
      const created = await store.create(makeInput({ name: 'Initial title' }));
      await store.appendMessage(created.id, {
        type: 'user',
        id: 'user-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'hello',
      });
      await store.rename(created.id, 'SQLite title');
      await store.updateHeader(created.id, {
        hasUnread: true,
        lastMessageAt: 10,
      });

      assert.equal((await store.readHeader(created.id)).name, 'SQLite title');
      assert.equal((await store.list())[0]?.name, 'SQLite title');
      assert.equal((await store.readMessages(created.id))[0]?.type, 'user');

      const transcriptPath = join(root, 'sessions', created.id, 'session.jsonl');
      const [marker, message] = (await readFile(transcriptPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(marker, {
        type: 'session_transcript',
        sessionId: created.id,
        schemaVersion: 1,
      });
      assert.equal('name' in (marker ?? {}), false);
      assert.equal(message?.type, 'user');
      await stat(join(root, SQLITE_SESSION_METADATA_DATABASE_NAME));
      await assert.rejects(() => stat(join(root, 'runtime.sqlite')), { code: 'ENOENT' });

      await store.close?.();
      const reopened = createSessionStore(root);
      try {
        assert.equal((await reopened.readHeader(created.id)).name, 'SQLite title');
        assert.equal((await reopened.readMessages(created.id)).length, 1);
      } finally {
        await reopened.close?.();
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('lists linked child sessions through SQLite without conflating ordinary branches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-relations-'));
    const store = createSessionStore(root);
    try {
      const parent = await store.create(makeInput({ name: 'Parent' }));
      const childInput = makeInput({
        name: 'Child',
        subagentParent: {
          kind: 'subagent',
          parentSessionId: parent.id,
          spawnedBy: {
            parentRunId: 'parent-run',
            parentTurnId: 'parent-turn',
            toolCallId: 'tool-call',
          },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: 1,
          agentId: 'local-read',
          agentName: 'Local Read',
          profile: 'local_read',
          systemPrompt: 'Read the assigned workspace task.',
          toolNames: ['Read', 'Glob', 'Grep'],
          categoryPolicy: { read: 'allow' },
          permissionCeiling: 'ask',
        },
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: 'a'.repeat(64),
          initialTurnId: 'child-turn',
          initialRunId: 'child-run',
        },
      });
      const { header: child, created } = await store.createSubagent(childInput);
      assert.equal(created, true);
      const retry = await store.createSubagent(childInput);
      assert.equal(retry.created, false);
      assert.equal(retry.header.id, child.id);
      await assert.rejects(
        () =>
          store.createSubagent({
            ...childInput,
            subagentSpawn: {
              ...childInput.subagentSpawn!,
              requestFingerprint: 'b'.repeat(64),
            },
          }),
        /reused for different work/,
      );
      await store.create(
        makeInput({
          name: 'Branch',
          parentSessionId: parent.id,
          branchOfTurnId: 'parent-turn',
        }),
      );

      const children = await store.list({ subagentParentSessionId: parent.id });
      assert.deepEqual(
        children.map((session) => session.id),
        [child.id],
      );
      assert.equal(children[0]?.subagentParent?.parentSessionId, parent.id);
      assert.deepEqual(children[0]?.subagentRuntime?.toolNames, ['Read', 'Glob', 'Grep']);
    } finally {
      store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('imports an existing JSONL catalog once and preserves later SQLite-only updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-migration-'));
    const legacy = createLegacyFileSessionStore(root);
    const created = await legacy.create(makeInput({ name: 'Legacy title', labels: ['legacy'] }));
    await legacy.updateHeader(created.id, {
      status: 'blocked',
      blockedReason: 'permission_required',
      hasUnread: true,
    });
    await legacy.appendMessage(created.id, {
      type: 'user',
      id: 'user-1',
      turnId: 'turn-1',
      ts: 10,
      text: 'legacy message',
    });

    const first = createSessionStore(root);
    try {
      assert.equal((await first.readHeader(created.id)).name, 'Legacy title');
      await first.rename(created.id, 'SQLite title');
      await first.appendMessage(created.id, {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 11,
        text: 'new message',
        modelId: 'fake-model',
      });
    } finally {
      await first.close?.();
    }

    const reopened = createSessionStore(root);
    try {
      assert.equal((await reopened.readHeader(created.id)).name, 'SQLite title');
      assert.equal((await reopened.readMessages(created.id)).length, 2);
      assert.deepEqual(
        (await reopened.list({ labelSlug: 'legacy' })).map((item) => item.id),
        [created.id],
      );
    } finally {
      await reopened.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses tombstones to prevent a deleted legacy transcript from resurrecting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-delete-'));
    const store = createSessionStore(root);
    let header!: SessionHeader;
    try {
      header = await store.create(makeInput({ name: 'Delete me' }));
      await store.remove(header.id);
    } finally {
      await store.close?.();
    }

    const sessionDir = join(root, 'sessions', header.id);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'session.jsonl'), `${JSON.stringify(header)}\n`, 'utf8');

    const reopened = createSessionStore(root);
    try {
      assert.deepEqual(await reopened.list(), []);
      await assert.rejects(() => reopened.readHeader(header.id), /not found/);
    } finally {
      await reopened.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('skips a malformed header during startup migration while importing valid sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-invalid-'));
    const legacy = createLegacyFileSessionStore(root);
    const valid = await legacy.create(makeInput({ name: 'Valid' }));
    const invalid = await legacy.create(makeInput({ name: 'Invalid' }));
    const invalidPath = join(root, 'sessions', invalid.id, 'session.jsonl');
    const lines = (await readFile(invalidPath, 'utf8')).split('\n');
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), labels: 'invalid' });
    await writeFile(invalidPath, lines.join('\n'), 'utf8');

    const store = createSessionStore(root);
    try {
      // Startup import must not fail closed: valid sessions stay available.
      assert.deepEqual(
        (await store.list()).map((item) => item.id),
        [valid.id],
      );
      assert.equal((await store.readHeader(valid.id)).name, 'Valid');
      await assert.rejects(() => store.readHeader(invalid.id), /not found/);
    } finally {
      await store.close?.();
    }

    const metadata = createSqliteSessionMetadataStore(
      join(root, SQLITE_SESSION_METADATA_DATABASE_NAME),
    );
    try {
      assert.equal((await metadata.read(valid.id)).header.name, 'Valid');
      assert.equal(await metadata.has(invalid.id), false);
      // Malformed legacy headers are skipped, not tombstoned, so a repaired
      // header can be imported on the next startup.
      assert.equal(await metadata.isTombstoned(invalid.id), false);
    } finally {
      metadata.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed when a transcript marker has no canonical SQLite metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-orphan-marker-'));
    const sessionId = 'orphan-session';
    const sessionDir = join(root, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'session.jsonl'),
      `${JSON.stringify({
        type: 'session_transcript',
        sessionId,
        schemaVersion: 1,
      })}\n`,
      'utf8',
    );

    const store = createSessionStore(root);
    try {
      await assert.rejects(() => store.list(), /has no SQLite metadata/);
    } finally {
      await store.close?.();
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
