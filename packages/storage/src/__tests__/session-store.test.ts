import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import type {
  CreateSessionInput,
  SessionHeader,
  StoredMessage,
  SubagentSessionParent,
  SubagentSessionRuntime,
  SubagentSessionSpawn,
} from '@maka/core';
import {
  createLegacyFileSessionStore as createSessionStore,
  createSessionStore as createSqliteSessionStore,
} from '../session-store.js';

describe('FileSessionStore CRUD', () => {
  test('list on a missing workspace is observational and does not create session storage', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-session-list-'));
    try {
      const sessionsRoot = join(workspaceRoot, 'sessions');
      assert.deepEqual(await createSessionStore(workspaceRoot).list(), []);
      await assert.rejects(() => readFile(sessionsRoot), { code: 'ENOENT' });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('archive sets isArchived and archivedAt; unarchive clears them', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Archived me' }));

      await store.archive(header.id);
      const archived = await store.readHeader(header.id);
      assert.equal(archived.isArchived, true);
      assert.equal(archived.status, 'archived');
      assert.equal(typeof archived.archivedAt, 'number');

      await store.unarchive(header.id);
      const restored = await store.readHeader(header.id);
      assert.equal(restored.isArchived, false);
      assert.equal(restored.status, 'active');
      assert.equal(restored.archivedAt, undefined);
    });
  });

  test('new sessions default to active status and include it in summaries', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Status' }));

      assert.equal(header.status, 'active');
      assert.equal(header.collaborationMode, 'agent');
      assert.equal(header.orchestrationMode, 'default');
      assert.equal(typeof header.statusUpdatedAt, 'number');
      const [summary] = await store.list();
      assert.equal(summary?.status, 'active');
      assert.equal(summary?.statusUpdatedAt, header.statusUpdatedAt);
      assert.equal(summary?.model, 'fake-model');
      assert.equal(summary?.cwd, '/tmp/cwd');
      assert.equal(summary?.collaborationMode, 'agent');
      assert.equal(summary?.orchestrationMode, 'default');
    });
  });

  test('persists a requested orchestration mode in headers and summaries', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ orchestrationMode: 'swarm' }));
      assert.equal(header.orchestrationMode, 'swarm');
      assert.equal((await store.list())[0]?.orchestrationMode, 'swarm');
    });
  });

  test('readHeaderSnapshot is observational and does not lock the connection', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Inspect me' }));
      await store.appendMessage(header.id, {
        type: 'user',
        id: 'user-1',
        turnId: 'turn-1',
        ts: 1,
        text: 'hello',
      });

      assert.equal((await store.readHeaderSnapshot(header.id)).connectionLocked, false);
      assert.equal((await store.readHeaderSnapshot(header.id)).connectionLocked, false);
      assert.equal((await store.readHeader(header.id)).connectionLocked, true);
    });
  });

  test('list summary carries thinkingLevel when set and omits it when cleared', async () => {
    await withStore(async (store) => {
      // No level on create: the summary omits the field (UI shows 默认).
      const header = await store.create(makeInput({ name: 'Thinking' }));
      assert.equal((await store.list())[0]?.thinkingLevel, undefined);

      // Setting a level persists it and the list summary surfaces it — this is
      // the projection the renderer's refreshSessions reads, so the model chip
      // reflects the chosen level instead of silently dropping it.
      await store.updateHeader(header.id, { thinkingLevel: 'high' });
      assert.equal((await store.list())[0]?.thinkingLevel, 'high');

      // Clearing it back to undefined removes the field from the summary.
      await store.updateHeader(header.id, { thinkingLevel: undefined });
      assert.equal((await store.list())[0]?.thinkingLevel, undefined);
    });
  });

  test('reads legacy pending cwd reminders but drops them during normalization', async () => {
    await withStore(async (store, workspaceRoot) => {
      const header = await store.create(makeInput({ name: 'Moved session' }));
      const path = join(workspaceRoot, 'sessions', header.id, 'session.jsonl');
      const legacyHeader = {
        ...JSON.parse(await readFile(path, 'utf8')),
        pendingCwdReminder: {
          from: '/tmp/old-worktree',
          to: '/tmp/new-worktree',
        },
      };
      await writeFile(path, `${JSON.stringify(legacyHeader)}\n`, 'utf8');

      const normalized = await store.readHeader(header.id);
      assert.equal(Object.hasOwn(normalized, 'pendingCwdReminder'), false);
      assert.equal(Object.hasOwn((await store.list())[0]!, 'pendingCwdReminder'), false);

      await store.updateHeader(header.id, { name: 'Normalized after move' });
      const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      assert.equal(Object.hasOwn(persisted, 'pendingCwdReminder'), false);
    });
  });

  test('create with a thinking level surfaces it in the list summary', async () => {
    await withStore(async (store) => {
      const header = await store.create(
        makeInput({ name: 'Thinking from start', thinkingLevel: 'medium' }),
      );
      assert.equal(header.thinkingLevel, 'medium');
      assert.equal((await store.list())[0]?.thinkingLevel, 'medium');
    });
  });

  test('persists session branch lineage in header and summaries', async () => {
    await withStore(async (store) => {
      const header = await store.create(
        makeInput({
          name: 'Branch',
          parentSessionId: 'parent-session',
          branchOfTurnId: 'turn-parent',
        }),
      );

      assert.equal(header.parentSessionId, 'parent-session');
      assert.equal(header.branchOfTurnId, 'turn-parent');
      const [summary] = await store.list();
      assert.equal(summary?.parentSessionId, 'parent-session');
      assert.equal(summary?.branchOfTurnId, 'turn-parent');
    });
  });

  test('persists typed subagent lineage but rejects relation scans without SQLite', async () => {
    await withStore(async (store) => {
      const parent = await store.create(makeInput({ name: 'Parent' }));
      const child = await store.create(
        makeInput({
          name: 'Child',
          subagentParent: makeSubagentParent(parent.id),
        }),
      );
      await store.create(
        makeInput({
          name: 'Other child',
          subagentParent: makeSubagentParent('other-parent'),
        }),
      );

      assert.deepEqual((await store.readHeader(child.id)).subagentParent, {
        ...makeSubagentParent(parent.id),
      });
      assert.equal((await store.readHeader(child.id)).subagentRuntime, undefined);
      await assert.rejects(
        () => store.list({ subagentParentSessionId: parent.id }),
        /require SQLite session metadata/,
      );
      await assert.rejects(
        () =>
          store.createSubagent(
            makeInput({
              subagentParent: makeSubagentParent(parent.id),
              subagentRuntime: makeSubagentRuntime(),
              subagentSpawn: makeSubagentSpawn(),
            }),
          ),
        /requires the SQLite metadata control plane/,
      );
    });
  });

  test('keeps subagent lineage distinct from branch and revision lineage', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        () =>
          store.create(
            makeInput({
              parentSessionId: 'branch-parent',
              branchOfTurnId: 'branch-turn',
              subagentParent: makeSubagentParent(),
            }),
          ),
        /Invalid subagent session lineage/,
      );
      await assert.rejects(
        () =>
          store.create(
            makeInput({
              revisionRootSessionId: 'root-session',
              revisionParentSessionId: 'previous-version',
              revisionOfTurnId: 'turn-edited',
              revisionIndex: 2,
              revisionState: 'preparing',
              subagentParent: makeSubagentParent(),
            }),
          ),
        /Invalid subagent session lineage/,
      );
    });
  });

  test('rejects malformed or mutated subagent lineage', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        () =>
          store.create(
            makeInput({
              subagentParent: {
                ...makeSubagentParent(),
                spawnedBy: {
                  parentRunId: 'parent-run',
                  parentTurnId: 'parent-turn',
                },
              } as SubagentSessionParent,
            }),
          ),
        /Invalid subagent session lineage/,
      );

      const child = await store.create(
        makeInput({ subagentParent: makeSubagentParent('parent-session') }),
      );
      await assert.rejects(
        () => store.updateHeader(child.id, { subagentParent: undefined }),
        /parent relation is immutable/,
      );
      await assert.rejects(
        () => store.updateHeader(child.id, { subagentRuntime: undefined }),
        /runtime snapshot is immutable/,
      );
      await assert.rejects(
        () => store.updateHeader(child.id, { subagentSpawn: undefined }),
        /spawn identity is immutable/,
      );
      await assert.rejects(
        () =>
          store.create(
            makeInput({
              permissionMode: 'execute',
              subagentParent: makeSubagentParent(),
              subagentRuntime: makeSubagentRuntime(),
            }),
          ),
        /Invalid subagent session lineage/,
      );
      await assert.rejects(
        () =>
          store.create(
            makeInput({
              subagentRuntime: makeSubagentRuntime(),
            }),
          ),
        /Invalid subagent session lineage/,
      );
    });
  });

  test('persists edit-and-resend revision lineage separately from branch lineage', async () => {
    await withStore(async (store) => {
      const header = await store.create(
        makeInput({
          name: 'Conversation version',
          revisionRootSessionId: 'root-session',
          revisionParentSessionId: 'previous-version',
          revisionOfTurnId: 'turn-edited',
          revisionIndex: 2,
          revisionState: 'preparing',
        }),
      );

      assert.equal(header.parentSessionId, undefined);
      assert.equal(header.revisionRootSessionId, 'root-session');
      assert.equal(header.revisionParentSessionId, 'previous-version');
      assert.equal(header.revisionOfTurnId, 'turn-edited');
      assert.equal(header.revisionIndex, 2);
      assert.equal(header.revisionState, 'preparing');
      const [summary] = await store.list();
      assert.equal(summary?.revisionRootSessionId, 'root-session');
      assert.equal(summary?.revisionParentSessionId, 'previous-version');
      assert.equal(summary?.revisionOfTurnId, 'turn-edited');
      assert.equal(summary?.revisionIndex, 2);
      assert.equal(summary?.revisionState, 'preparing');
    });
  });

  test('rejects partial or unsafe edit-and-resend revision lineage', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        () => store.create(makeInput({ revisionRootSessionId: 'root-only' })),
        /Invalid session revision lineage/,
      );
      await assert.rejects(
        () =>
          store.create(
            makeInput({
              revisionRootSessionId: '../escape',
              revisionParentSessionId: 'parent',
              revisionOfTurnId: 'turn',
              revisionIndex: 2,
              revisionState: 'preparing',
            }),
          ),
        /Invalid session revision lineage/,
      );
    });
  });

  test('setFlagged toggles the flag without touching other fields', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Pin me' }));

      await store.setFlagged(header.id, true);
      const pinned = await store.readHeader(header.id);
      assert.equal(pinned.isFlagged, true);
      assert.equal(pinned.name, 'Pin me');

      await store.setFlagged(header.id, false);
      const unpinned = await store.readHeader(header.id);
      assert.equal(unpinned.isFlagged, false);
    });
  });

  test('markSessionReadThrough clears unread only through the current last message', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Unread' }));
      await store.updateHeader(header.id, { hasUnread: true, lastMessageAt: 250 });

      const unchanged = await store.markSessionReadThrough(header.id, 200);
      assert.equal(unchanged.lastMessageAt, 250);
      assert.equal(unchanged.hasUnread, true);
      assert.equal((await store.readHeader(header.id)).hasUnread, true);

      const cleared = await store.markSessionReadThrough(header.id, 250);
      assert.equal(cleared.lastMessageAt, 250);
      assert.equal(cleared.hasUnread, false);
      assert.equal((await store.readHeader(header.id)).hasUnread, false);
    });
  });

  test('markSessionReadThrough uses visible message timestamps when header lastMessageAt is stale', async () => {
    for (const headerLastMessageAt of [100, undefined]) {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'Stale unread' }));
        await store.appendMessage(header.id, assistantMessageAt(250));
        await store.updateHeader(header.id, {
          hasUnread: true,
          lastMessageAt: headerLastMessageAt,
        });

        const unchanged = await store.markSessionReadThrough(header.id, 200);
        assert.equal(unchanged.hasUnread, true);
        assert.equal((await store.list())[0]?.lastMessageAt, 250);
        assert.equal((await store.readHeader(header.id)).hasUnread, true);

        const cleared = await store.markSessionReadThrough(header.id, 250);
        assert.equal(cleared.hasUnread, false);
        assert.equal((await store.readHeader(header.id)).hasUnread, false);
      });
    }
  });

  test('rename trims whitespace, rejects empty strings, and caps absurd lengths', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Old' }));

      await store.rename(header.id, '  Brand new name  ');
      const renamed = await store.readHeader(header.id);
      assert.equal(renamed.name, 'Brand new name');
      assert.equal(renamed.titleIsManual, true);

      await assert.rejects(store.rename(header.id, '   '), /name cannot be empty/);

      const overly = 'a'.repeat(200);
      await store.rename(header.id, overly);
      const bounded = await store.readHeader(header.id);
      assert.equal(bounded.name.length, 80);
    });
  });

  test('generated titles only replace untouched default titles', async () => {
    await withStore(async (store) => {
      const generatedFirst = await store.create(makeInput({ name: 'New Chat' }));
      assert.equal(generatedFirst.titleIsManual, false);
      assert.equal(
        (await store.setGeneratedTitleIfAbsent(generatedFirst.id, '  Generated title  '))?.name,
        'Generated title',
      );
      await store.rename(generatedFirst.id, 'Manual title');
      assert.equal(await store.setGeneratedTitleIfAbsent(generatedFirst.id, 'Too late'), null);
      assert.equal((await store.readHeader(generatedFirst.id)).name, 'Manual title');

      const manualFirst = await store.create(makeInput({ name: 'New Chat' }));
      await store.rename(manualFirst.id, 'Manual wins');
      assert.equal(await store.setGeneratedTitleIfAbsent(manualFirst.id, 'Generated loses'), null);
      assert.equal((await store.readHeader(manualFirst.id)).name, 'Manual wins');

      const unchanged = await store.create(makeInput({ name: 'New Chat' }));
      assert.equal(await store.setGeneratedTitleIfAbsent(unchanged.id, ' New Chat '), null);
    });
  });

  test('retries a Windows atomic header replacement while a reader briefly holds the session file open', {
    skip: process.platform !== 'win32',
  }, async () => {
    await withStore(async (store, workspaceRoot) => {
      const header = await store.create(makeInput({ name: 'Reader overlap' }));
      const sessionPath = join(workspaceRoot, 'sessions', header.id, 'session.jsonl');
      const reader = await open(sessionPath, 'r');
      const releaseReader = setTimeout(() => void reader.close(), 40);

      try {
        const updated = await store.updateHeader(header.id, { name: 'Write survived' });
        assert.equal(updated.name, 'Write survived');
        assert.equal((await store.readHeader(header.id)).name, 'Write survived');
      } finally {
        clearTimeout(releaseReader);
        await reader.close().catch(() => {});
      }
    });
  });

  test('remove deletes the session directory entirely', async () => {
    await withStore(async (store, workspaceRoot) => {
      const header = await store.create(makeInput({ name: 'Goodbye' }));
      const sessionDir = join(workspaceRoot, 'sessions', header.id);

      // sanity: file exists before remove
      const before = await readFile(join(sessionDir, 'session.jsonl'), 'utf8');
      assert.match(before, /Goodbye/);

      await store.remove(header.id);

      await assert.rejects(readFile(join(sessionDir, 'session.jsonl'), 'utf8'));
      const remaining = await store.list();
      assert.equal(
        remaining.find((s) => s.id === header.id),
        undefined,
      );
    });
  });

  test('rejects traversal-style session ids before touching the filesystem', async () => {
    await withStore(async (store, workspaceRoot) => {
      const victim = join(workspaceRoot, 'outside-victim');
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, 'keep.txt'), 'keep', 'utf8');

      await assert.rejects(store.readMessages('../outside-victim'), /Invalid session id/);
      await assert.rejects(store.remove('../outside-victim'), /Invalid session id/);

      assert.equal(await readFile(join(victim, 'keep.txt'), 'utf8'), 'keep');
    });
  });

  test('rejects malformed session headers instead of returning partial records', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'malformed-header';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        JSON.stringify({
          ...makeRawHeader({ id: sessionId, workspaceRoot, name: 'Broken labels' }),
          labels: 'not-an-array',
        }) + '\n',
        'utf8',
      );

      await assert.rejects(
        () => store.readHeader(sessionId),
        /Invalid session header for session malformed-header: malformed fields/,
      );
      assert.deepEqual(await store.list(), []);
    });
  });

  test('rejects malformed session headers on write paths without overwriting bytes', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'malformed-write';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      const sessionPath = join(sessionDir, 'session.jsonl');
      const invalid =
        JSON.stringify({
          ...makeRawHeader({ id: sessionId, workspaceRoot, name: 'Broken timestamp' }),
          lastUsedAt: 'soon',
        }) + '\n';
      await mkdir(sessionDir, { recursive: true });
      await writeFile(sessionPath, invalid, 'utf8');

      await assert.rejects(
        () => store.setFlagged(sessionId, true),
        /Invalid session header for session malformed-write: malformed fields/,
      );
      assert.equal(await readFile(sessionPath, 'utf8'), invalid);
    });
  });

  test('rejects session headers whose id does not match the directory', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'header-id-mismatch';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        JSON.stringify(makeRawHeader({ id: 'other-session', workspaceRoot })) + '\n',
        'utf8',
      );

      await assert.rejects(
        () => store.readMessages(sessionId),
        /Invalid session header for session header-id-mismatch: malformed fields/,
      );
      assert.deepEqual(await store.list(), []);
    });
  });

  test('migrates legacy headers without permissionMode to ask', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'legacy-session';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        JSON.stringify({
          id: sessionId,
          workspaceRoot,
          cwd: '/tmp/cwd',
          createdAt: 1,
          lastUsedAt: 1,
          name: 'Legacy',
          isFlagged: false,
          labels: [],
          isArchived: false,
          hasUnread: false,
          backend: 'claude',
          llmConnectionSlug: 'legacy',
          connectionLocked: false,
          model: 'legacy-model',
          schemaVersion: 1,
        }) + '\n',
        'utf8',
      );

      const header = await store.readHeader(sessionId);
      assert.equal(header.backend, 'ai-sdk');
      assert.equal(header.permissionMode, 'ask');
      assert.equal(header.status, 'active');
      assert.equal(header.titleIsManual, true);
      assert.equal(header.orchestrationMode, 'default');
      assert.equal(header.subagentParent, undefined);
      const [summary] = await store.list();
      assert.equal(summary?.permissionMode, 'ask');
      assert.equal(summary?.status, 'active');
      assert.equal(summary?.orchestrationMode, 'default');
      assert.equal(summary?.subagentParent, undefined);
    });
  });

  test('migrates legacy default titles as generated-title candidates', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'legacy-new-chat';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      const legacy = makeRawHeader({ id: sessionId, workspaceRoot, name: 'New Chat' });
      delete (legacy as Partial<SessionHeader>).titleIsManual;
      await writeFile(join(sessionDir, 'session.jsonl'), JSON.stringify(legacy) + '\n', 'utf8');

      assert.equal((await store.readHeader(sessionId)).titleIsManual, false);
    });
  });

  test('migrates New Session as the canonical generated-title candidate', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'legacy-new-session';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      const legacy = makeRawHeader({ id: sessionId, workspaceRoot, name: 'New Session' });
      delete (legacy as Partial<SessionHeader>).titleIsManual;
      await writeFile(join(sessionDir, 'session.jsonl'), JSON.stringify(legacy) + '\n', 'utf8');

      const header = await store.readHeader(sessionId);
      assert.equal(header.name, 'New Chat');
      assert.equal(header.titleIsManual, false);
    });
  });

  test('migrates legacy headers without model to default and exposes model in summaries', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'legacy-no-model';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        JSON.stringify({
          id: sessionId,
          workspaceRoot,
          cwd: '/tmp/cwd',
          createdAt: 1,
          lastUsedAt: 1,
          name: 'Legacy no model',
          isFlagged: false,
          labels: [],
          isArchived: false,
          hasUnread: false,
          backend: 'ai-sdk',
          llmConnectionSlug: 'anthropic',
          connectionLocked: false,
          permissionMode: 'ask',
          schemaVersion: 1,
        }) + '\n',
        'utf8',
      );

      const header = await store.readHeader(sessionId);
      assert.equal(header.model, 'default');
      const [summary] = await store.list();
      assert.equal(summary?.model, 'default');
    });
  });

  test('migrates archived legacy headers to archived status', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'legacy-archived';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        JSON.stringify({
          id: sessionId,
          workspaceRoot,
          cwd: '/tmp/cwd',
          createdAt: 1,
          lastUsedAt: 2,
          name: 'Legacy archived',
          isFlagged: false,
          labels: [],
          isArchived: true,
          archivedAt: 3,
          hasUnread: false,
          backend: 'fake',
          llmConnectionSlug: 'fake',
          connectionLocked: false,
          model: 'fake-model',
          permissionMode: 'ask',
          schemaVersion: 1,
        }) + '\n',
        'utf8',
      );

      const header = await store.readHeader(sessionId);
      assert.equal(header.status, 'archived');
      assert.equal(header.statusUpdatedAt, 3);
    });
  });

  test('normalizes exact legacy shell tool results while reading session JSONL', async () => {
    await withStore(async (store, workspaceRoot) => {
      const header = await store.create(makeInput({ name: 'Legacy shell results' }));
      const path = join(workspaceRoot, 'sessions', header.id, 'session.jsonl');
      const existing = await readFile(path, 'utf8');
      const legacyResults = [
        {
          type: 'tool_result',
          id: 'terminal-result',
          turnId: 'turn-1',
          ts: 2,
          toolUseId: 'terminal-call',
          isError: false,
          content: {
            kind: 'terminal',
            cwd: '/workspace',
            cmd: 'printf ok',
            status: 'completed',
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        },
        {
          type: 'tool_result',
          id: 'shell-result',
          turnId: 'turn-2',
          ts: 4,
          toolUseId: 'shell-call',
          isError: false,
          content: {
            kind: 'shell_run',
            ref: 'maka://runtime/background-tasks/shell-1',
            status: 'cancelled',
            cwd: '/workspace',
            cmd: 'sleep 30',
            startedAt: 1,
            updatedAt: 4,
            completedAt: 4,
            exitCode: 130,
            stdout: 'ready',
            stderr: '',
            latestOutputStream: 'stdout',
            stdoutTruncated: false,
            stderrTruncated: false,
            observedAt: 4,
            cancelled: true,
          },
        },
      ];
      const mixedResult = {
        type: 'tool_result',
        id: 'mixed-terminal-result',
        turnId: 'turn-3',
        ts: 6,
        toolUseId: 'mixed-terminal-call',
        isError: false,
        content: {
          kind: 'terminal',
          cwd: '/workspace',
          cmd: 'printf bad',
          status: 'completed',
          exitCode: 0,
          stdout: 'bad',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          output: {
            mode: 'pipes',
            stdout: 'bad',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            redacted: false,
          },
        },
      };
      await writeFile(
        path,
        existing +
          [...legacyResults, mixedResult].map((message) => JSON.stringify(message)).join('\n') +
          '\n',
        'utf8',
      );

      const messages = await store.readMessages(header.id);
      const terminal = messages.find((message) => message.id === 'terminal-result');
      const shellRun = messages.find((message) => message.id === 'shell-result');
      assert.deepEqual(terminal?.type === 'tool_result' ? terminal.content : undefined, {
        kind: 'terminal',
        cwd: '/workspace',
        cmd: 'printf ok',
        status: 'completed',
        exitCode: 0,
        output: {
          mode: 'pipes',
          stdout: 'ok',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      });
      assert.deepEqual(shellRun?.type === 'tool_result' ? shellRun.content : undefined, {
        kind: 'shell_run',
        ref: 'maka://runtime/background-tasks/shell-1',
        mode: 'pipes',
        status: 'cancelled',
        cwd: '/workspace',
        cmd: 'sleep 30',
        startedAt: 1,
        updatedAt: 4,
        completedAt: 4,
        exitCode: 130,
        revision: 1,
        output: {
          mode: 'pipes',
          stdout: 'ready',
          stderr: '',
          latestStream: 'stdout',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
        operation: { kind: 'stop', applied: true },
      });
      assert.equal(
        messages.some((message) => message.id === 'mixed-terminal-result'),
        false,
      );
      assert.equal(
        messages.some(
          (message) => message.type === 'system_note' && message.id.startsWith('jsonl-corrupt-'),
        ),
        true,
      );
      await assert.rejects(
        () => store.readMessagesForRecovery(header.id),
        /Session .* has a corrupt JSONL record at line 2/,
      );
    });
  });

  test('reads exact legacy subagent results during normal and strict recovery without rewriting', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-legacy-subagent-result-'));
    const store = createSqliteSessionStore(workspaceRoot);
    try {
      const header = await store.create(makeInput({ name: 'Legacy subagent result' }));
      const path = join(workspaceRoot, 'sessions', header.id, 'session.jsonl');
      const legacyRecord = await readFile(
        new URL(
          '../../src/__tests__/fixtures/legacy-subagent-waiting-permission.jsonl',
          import.meta.url,
        ),
      );
      const originalBytes = Buffer.concat([await readFile(path), legacyRecord]);
      await writeFile(path, originalBytes);

      const normalMessages = await store.readMessages(header.id);
      assert.equal(subagentStatus(normalMessages), 'waiting_for_user');
      assert.deepEqual(await readFile(path), originalBytes);

      const recoveryMessages = await store.readMessagesForRecovery(header.id);
      assert.equal(subagentStatus(recoveryMessages), 'waiting_for_user');
      assert.deepEqual(await readFile(path), originalBytes);

      assert.deepEqual(
        (await store.listForRecovery()).map((session) => session.id),
        [header.id],
      );
      assert.deepEqual(await readFile(path), originalBytes);
    } finally {
      await store.close?.();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('recovers readable messages around a corrupt JSONL message line', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'corrupt-middle-line';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        [
          JSON.stringify(makeRawHeader({ id: sessionId, workspaceRoot, name: 'Corrupt middle' })),
          JSON.stringify({ type: 'user', id: 'u1', turnId: 't1', ts: 2, text: 'hello' }),
          '{"type":"assistant","id":"broken"',
          JSON.stringify({
            type: 'assistant',
            id: 'a1',
            turnId: 't1',
            ts: 4,
            text: 'recovered answer',
            modelId: 'fake',
          }),
          '',
        ].join('\n'),
        'utf8',
      );

      const messages = await store.readMessages(sessionId);
      assert.equal(messages.length, 3);
      assert.equal(messages[0]?.type, 'user');
      const note = messages[1];
      assert.equal(note?.type, 'system_note');
      if (note?.type !== 'system_note') throw new Error('corruption note missing');
      assert.equal(note.kind, 'error');
      assert.equal((note.data as { code?: unknown }).code, 'jsonl_parse_error');
      assert.equal((note.data as { lineNumber?: unknown }).lineNumber, 3);
      assert.equal(typeof (note.data as { message?: unknown }).message, 'string');
      assert.ok(((note.data as { message?: string }).message ?? '').length > 0);
      assert.equal(messages[2]?.type, 'assistant');

      const [summary] = await store.list();
      assert.equal(summary?.id, sessionId);
      assert.equal(summary?.lastMessagePreview, 'recovered answer');
    });
  });

  test('silently drops a truncated tail JSONL message line', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'truncated-tail-line';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        [
          JSON.stringify(makeRawHeader({ id: sessionId, workspaceRoot, name: 'Truncated tail' })),
          JSON.stringify({ type: 'user', id: 'u1', turnId: 't1', ts: 2, text: 'survives' }),
          '{"type":"assistant","id":"partial"',
        ].join('\n'),
        'utf8',
      );

      const messages = await store.readMessages(sessionId);
      assert.deepEqual(
        messages.map((message) => message.type),
        ['user'],
      );

      const [summary] = await store.list();
      assert.equal(summary?.id, sessionId);
      assert.equal(summary?.lastMessagePreview, 'survives');
    });
  });

  test('reports an invalid unterminated tail instead of treating it as a crash prefix', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'invalid-unterminated-tail';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      const path = join(sessionDir, 'session.jsonl');
      const bytes = [
        JSON.stringify(
          makeRawHeader({
            id: sessionId,
            workspaceRoot,
            name: 'Invalid tail',
            connectionLocked: true,
          }),
        ),
        JSON.stringify({
          type: 'user',
          id: 'u1',
          turnId: 't1',
          ts: 2,
          text: 'survives',
        }),
        '{"type":]',
      ].join('\n');
      await writeFile(path, bytes, 'utf8');

      const messages = await store.readMessages(sessionId);
      assert.deepEqual(
        messages.map((message) => message.type),
        ['user', 'system_note'],
      );
      await assert.rejects(
        () => store.readMessagesForRecovery(sessionId),
        /Session invalid-unterminated-tail has a corrupt JSONL record at line 3/,
      );
      assert.equal(await readFile(path, 'utf8'), bytes);
    });
  });

  test('reports a corrupt tail JSONL message line when it was newline-terminated', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'corrupt-terminated-tail-line';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        [
          JSON.stringify(
            makeRawHeader({ id: sessionId, workspaceRoot, name: 'Corrupt terminated tail' }),
          ),
          JSON.stringify({ type: 'user', id: 'u1', turnId: 't1', ts: 2, text: 'survives' }),
          '{"type":"assistant","id":"durably-broken"',
          '',
        ].join('\n'),
        'utf8',
      );

      const messages = await store.readMessages(sessionId);
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.type, 'user');
      const note = messages[1];
      assert.equal(note?.type, 'system_note');
      if (note?.type !== 'system_note') throw new Error('corruption note missing');
      assert.equal(note.kind, 'error');
      assert.equal((note.data as { code?: unknown }).code, 'jsonl_parse_error');
      assert.equal((note.data as { lineNumber?: unknown }).lineNumber, 3);
    });
  });

  test('rejects a complete schema-invalid message during strict recovery', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'schema-invalid-message';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        [
          JSON.stringify(
            makeRawHeader({
              id: sessionId,
              workspaceRoot,
              name: 'Invalid message',
            }),
          ),
          JSON.stringify({}),
        ].join('\n'),
        'utf8',
      );

      await assert.rejects(
        () => store.readMessagesForRecovery(sessionId),
        /Session schema-invalid-message has a corrupt JSONL record at line 2/,
      );
    });
  });

  test('recovers a canonical token usage message with nested diagnostics', async () => {
    await withStore(async (store) => {
      const session = await store.create(makeInput({ name: 'Token usage recovery' }));
      await store.appendMessage(session.id, {
        type: 'token_usage',
        id: 'usage-1',
        turnId: 'turn-1',
        ts: 10,
        input: 100,
        output: 20,
        cacheHitInput: 80,
        prefixChangeReason: 'stable',
        promptSegments: [{ kind: 'prior_history', chars: 400, estimatedTokens: 100 }],
        contextBudget: {
          enabled: true,
          policyName: 'bounded-history',
          estimatedTokensBefore: 120,
          estimatedTokensAfter: 100,
          keptTurns: 4,
          droppedTurns: 1,
          keptEvents: 8,
          droppedEvents: 2,
          semanticCompactMode: 'validate_only',
          compactionDecisions: [
            {
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'unchanged',
              coveredTurns: 4,
            },
          ],
        },
      });

      const messages = await store.readMessagesForRecovery(session.id);
      assert.equal(messages[0]?.type, 'token_usage');
      assert.equal(
        messages[0]?.type === 'token_usage' && messages[0].contextBudget?.policyName,
        'bounded-history',
      );
    });
  });

  test('rejects malformed nested message payloads during strict recovery', async () => {
    await withStore(async (store, workspaceRoot) => {
      const malformed = [
        {
          type: 'token_usage',
          id: 'usage-1',
          turnId: 'turn-1',
          ts: 1,
          input: 1,
          output: 1,
          contextBudget: {
            enabled: true,
            policyName: 42,
            estimatedTokensBefore: 1,
            estimatedTokensAfter: 1,
            keptTurns: 1,
            droppedTurns: 0,
            keptEvents: 1,
            droppedEvents: 0,
          },
        },
        exploreToolResult({ candidateFiles: [null], matches: [] }),
        exploreToolResult({ candidateFiles: [], matches: [42] }),
      ];

      for (const [index, message] of malformed.entries()) {
        const sessionId = `malformed-nested-${index}`;
        const sessionDir = join(workspaceRoot, 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'session.jsonl'),
          [
            JSON.stringify(
              makeRawHeader({
                id: sessionId,
                workspaceRoot,
                name: 'Malformed nested',
              }),
            ),
            JSON.stringify(message),
          ].join('\n'),
          'utf8',
        );
        await assert.rejects(
          () => store.readMessagesForRecovery(sessionId),
          new RegExp(`Session malformed-nested-${index} has a corrupt JSONL record at line 2`),
        );
      }
    });
  });

  test('derives lastMessagePreview from visible user and assistant messages', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Preview' }));

      await store.appendMessages(header.id, [
        {
          type: 'system_note',
          id: 'sys-1',
          ts: 1,
          kind: 'mode_change',
          data: { from: 'ask', to: 'execute' },
        },
        {
          type: 'tool_call',
          id: 'tool-1',
          turnId: 't1',
          ts: 2,
          toolName: 'Read',
          args: { file: 'secret.ts' },
        },
        {
          type: 'assistant',
          id: 'a1',
          turnId: 't1',
          ts: 3,
          text: 'Here is the latest answer.\nIt spans lines.',
          modelId: 'fake',
        },
      ]);

      const [summary] = await store.list();
      assert.equal(summary?.lastMessagePreview, 'Here is the latest answer. It spans lines.');
    });
  });

  test('lastMessagePreview skips internal-only tails, preserves emoji, and falls back for attachments', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Emoji' }));
      const longText = `hello ${'🙂'.repeat(120)} tail`;

      await store.appendMessages(header.id, [
        {
          type: 'user',
          id: 'u1',
          turnId: 't1',
          ts: 1,
          text: longText,
        },
        { type: 'system_note', id: 'sys-1', turnId: 't1', ts: 2, kind: 'session_resume' },
      ]);

      const [summary] = await store.list();
      assert.equal(summary?.lastMessagePreview?.endsWith('…'), true);
      assert.equal(summary?.lastMessagePreview?.includes('�'), false);
      assert.equal(summary?.lastMessagePreview?.startsWith('hello 🙂'), true);
    });

    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Attachment' }));

      await store.appendMessage(header.id, {
        type: 'user',
        id: 'u1',
        turnId: 't1',
        ts: 1,
        text: '   ',
        attachments: [
          {
            kind: 'image',
            name: 'shot.png',
            mimeType: 'image/png',
            bytes: 10,
            ref: { kind: 'session_file', sessionId: header.id, relativePath: 'shot.png' },
          },
        ],
      });

      const [summary] = await store.list();
      assert.equal(summary?.lastMessagePreview, '附件');
    });
  });

  test('summary lastMessageAt derives from visible messages when header timestamp is missing or stale', async () => {
    await withStore(async (store, workspaceRoot) => {
      const missingId = 'missing-last-message-at';
      await mkdir(join(workspaceRoot, 'sessions', missingId), { recursive: true });
      await writeFile(
        join(workspaceRoot, 'sessions', missingId, 'session.jsonl'),
        [
          JSON.stringify(
            makeRawHeader({ id: missingId, workspaceRoot, name: 'Missing timestamp' }),
          ),
          JSON.stringify({
            type: 'user',
            id: 'u1',
            turnId: 't1',
            ts: 20,
            text: 'new visible user text',
          }),
          JSON.stringify({ type: 'system_note', id: 'sys-1', ts: 30, kind: 'session_resume' }),
          '',
        ].join('\n'),
        'utf8',
      );

      const staleId = 'stale-last-message-at';
      await mkdir(join(workspaceRoot, 'sessions', staleId), { recursive: true });
      await writeFile(
        join(workspaceRoot, 'sessions', staleId, 'session.jsonl'),
        [
          JSON.stringify(
            makeRawHeader({
              id: staleId,
              workspaceRoot,
              name: 'Stale timestamp',
              lastMessageAt: 5,
            }),
          ),
          JSON.stringify({
            type: 'assistant',
            id: 'a1',
            turnId: 't1',
            ts: 40,
            text: 'new visible assistant text',
            modelId: 'fake',
          }),
          '',
        ].join('\n'),
        'utf8',
      );

      const summaries = await store.list();
      const missing = summaries.find((summary) => summary.id === missingId);
      const stale = summaries.find((summary) => summary.id === staleId);

      assert.equal(missing?.lastMessageAt, 20);
      assert.equal(missing?.lastMessagePreview, 'new visible user text');
      assert.equal(stale?.lastMessageAt, 40);
      assert.equal(stale?.lastMessagePreview, 'new visible assistant text');
      assert.deepEqual(
        summaries.slice(0, 2).map((summary) => summary.id),
        [staleId, missingId],
      );
    });
  });

  test('list derives previews for sessions outside the first three without full detail reads', async () => {
    await withStore(async (store, workspaceRoot) => {
      for (let index = 0; index < 5; index += 1) {
        const sessionId = `preview-tail-${index}`;
        await mkdir(join(workspaceRoot, 'sessions', sessionId), { recursive: true });
        await writeFile(
          join(workspaceRoot, 'sessions', sessionId, 'session.jsonl'),
          [
            JSON.stringify(
              makeRawHeader({
                id: sessionId,
                workspaceRoot,
                name: `Preview tail ${index}`,
                lastMessageAt: 100 - index,
              }),
            ),
            JSON.stringify({
              type: 'assistant',
              id: `a-${index}`,
              turnId: `t-${index}`,
              ts: 100 - index,
              text: `tail preview ${index}`,
              modelId: 'fake',
            }),
            '',
          ].join('\n'),
          'utf8',
        );
      }

      const summaries = await store.list();

      assert.equal(summaries.length, 5);
      assert.deepEqual(
        summaries.map((summary) => summary.lastMessagePreview),
        ['tail preview 0', 'tail preview 1', 'tail preview 2', 'tail preview 3', 'tail preview 4'],
      );
    });
  });

  test('list accepts unusually large but valid session headers', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'large-valid-header';
      await mkdir(join(workspaceRoot, 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(workspaceRoot, 'sessions', sessionId, 'session.jsonl'),
        [
          JSON.stringify(
            makeRawHeader({
              id: sessionId,
              workspaceRoot,
              name: 'Large header',
              labels: Array.from({ length: 700 }, (_, index) => `label-${index}`),
              lastMessageAt: 10,
            }),
          ),
          JSON.stringify({
            type: 'assistant',
            id: 'a1',
            turnId: 't1',
            ts: 10,
            text: 'large header survives',
            modelId: 'fake',
          }),
          '',
        ].join('\n'),
        'utf8',
      );

      const [summary] = await store.list();

      assert.equal(summary?.id, sessionId);
      assert.equal(summary?.lastMessagePreview, 'large header survives');
    });
  });

  test('summary lastMessageAt does not move backwards when copying older visible messages', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'newer-header-with-old-copy';
      await mkdir(join(workspaceRoot, 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(workspaceRoot, 'sessions', sessionId, 'session.jsonl'),
        [
          JSON.stringify(
            makeRawHeader({
              id: sessionId,
              workspaceRoot,
              name: 'Newer header',
              lastMessageAt: 100,
            }),
          ),
          JSON.stringify({
            type: 'assistant',
            id: 'a1',
            turnId: 't1',
            ts: 40,
            text: 'old copied text',
            modelId: 'fake',
          }),
          '',
        ].join('\n'),
        'utf8',
      );

      const [summary] = await store.list();

      assert.equal(summary?.id, sessionId);
      assert.equal(summary?.lastMessageAt, 100);
      assert.equal(summary?.lastMessagePreview, 'old copied text');
    });
  });

  test('listTurns derives latest persisted turn states and lineage', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Turns' }));

      await store.appendMessages(header.id, [
        { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: 'hello' },
        {
          type: 'turn_state',
          id: 'state-1',
          turnId: 't1',
          ts: 2,
          status: 'running',
          partialOutputRetained: false,
        },
        { type: 'assistant', id: 'a1', turnId: 't1', ts: 3, text: 'partial', modelId: 'fake' },
        {
          type: 'turn_state',
          id: 'state-2',
          turnId: 't1',
          ts: 4,
          status: 'aborted',
          retriedFromTurnId: 't0',
          abortedAt: 4,
          partialOutputRetained: false,
        },
      ]);

      assert.deepEqual(await store.listTurns(header.id), [
        {
          turnId: 't1',
          status: 'aborted',
          retriedFromTurnId: 't0',
          abortedAt: 4,
          partialOutputRetained: true,
        },
      ]);
    });
  });

  test('listTurns projects legacy message-only turns as completed', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Legacy turn' }));
      await store.appendMessages(header.id, [
        { type: 'user', id: 'u1', turnId: 'legacy', ts: 1, text: 'hello' },
        { type: 'assistant', id: 'a1', turnId: 'legacy', ts: 2, text: 'world', modelId: 'fake' },
      ]);

      const turns = await store.listTurns(header.id);
      assert.equal(turns[0]?.turnId, 'legacy');
      assert.equal(turns[0]?.status, 'completed');
      assert.equal(turns[0]?.partialOutputRetained, true);
    });
  });

  // PR-UI-IPC-2 (@kenji msg 0474c3fe + @xuan msg 88d96a87):
  // session-name normalize contract is enforced at the store
  // boundary by `normalizeUserSessionName`. These integration
  // tests verify that the create + rename + (derived) branch
  // paths all converge on the same chokepoint — locking @xuan's
  // merge-gate criterion "all write entry points use same helper".
  describe('normalizeUserSessionName store-boundary integration (PR-UI-IPC-2)', () => {
    test('create with control chars in name → store persists sanitized name', async () => {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'multi\nline\tname' }));
        const persisted = await store.readHeader(header.id);
        assert.equal(persisted.name, 'multi line name');
      });
    });

    test('create with bidi RLO spoof → spoof char replaced before persistence', async () => {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'safe‮evil' }));
        const persisted = await store.readHeader(header.id);
        assert.ok(!persisted.name.includes('‮'), 'RLO must be stripped at store boundary');
        assert.equal(persisted.name, 'safe evil');
      });
    });

    test('create with zero-width injection ("ad\\u200Bmin") → ZWSP removed', async () => {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'ad​min' }));
        const persisted = await store.readHeader(header.id);
        assert.equal(persisted.name, 'admin');
      });
    });

    test('create with undefined name → uses canonical "New Chat" default', async () => {
      await withStore(async (store) => {
        const input = makeInput();
        delete (input as Partial<CreateSessionInput>).name;
        const header = await store.create(input);
        const persisted = await store.readHeader(header.id);
        assert.equal(persisted.name, 'New Chat');
      });
    });

    test('create with explicit empty string name → REJECT (no silent default fallback)', async () => {
      // Per @xuan caller-semantics lock: empty-after-sanitize on
      // an EXPLICIT input must reject, not silently use the
      // default. Default is reserved for the truly omitted
      // (undefined) case.
      await withStore(async (store) => {
        await assert.rejects(store.create(makeInput({ name: '' })), /cannot be empty/);
        await assert.rejects(store.create(makeInput({ name: '   ' })), /cannot be empty/);
        await assert.rejects(store.create(makeInput({ name: '\n\n' })), /cannot be empty/);
      });
    });

    test('rename with control chars → sanitized at store boundary (replaces v1 inline trim/cap)', async () => {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'Old' }));
        await store.rename(header.id, 'new\x00name\x1b[31mwith\x7fcontrols');
        const persisted = await store.readHeader(header.id);
        assert.ok(!persisted.name.includes('\x00'));
        assert.ok(!persisted.name.includes('\x1b'));
        assert.ok(!persisted.name.includes('\x7f'));
        // Each control replaced with single space, then collapsed:
        assert.equal(persisted.name, 'new name [31mwith controls');
      });
    });

    test('rename with non-string runtime type rejects (TS signature is not enough at IPC boundary)', async () => {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'Valid' }));
        // Intentionally cast around the TS signature to simulate an
        // IPC payload that didn't honor the type contract.
        await assert.rejects(
          store.rename(header.id, null as unknown as string),
          /must be a string/,
        );
        await assert.rejects(store.rename(header.id, 42 as unknown as string), /must be a string/);
      });
    });

    test('rename with 100-char input → capped to 80 code points', async () => {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'Old' }));
        await store.rename(header.id, 'a'.repeat(100));
        const persisted = await store.readHeader(header.id);
        assert.equal(Array.from(persisted.name).length, 80);
      });
    });

    test('create with emoji at the cap boundary → surrogate pair never cut in half', async () => {
      // 79 ASCII + 1 emoji = 80 code points, 81 UTF-16 code units.
      // Naive `.slice(0, 80)` would cut the emoji's high-surrogate
      // and leave an invalid lone low-surrogate. The helper uses
      // code-point iteration to prevent this.
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: `${'a'.repeat(79)}🦊` }));
        const persisted = await store.readHeader(header.id);
        assert.ok(persisted.name.endsWith('🦊'), 'emoji must be intact at cap boundary');
      });
    });

    test('branch derived name with control-char parent → sanitized', async () => {
      // Simulates the runtime branch path: derived name is
      // `${parent} · 分支`. If parent.name has somehow accumulated
      // dirty bytes (legacy session, manual file edit), the
      // derived name passed to `store.create` still goes through
      // the same normalize gate.
      await withStore(async (store) => {
        const dirtyParent = 'parent\nwith\ttabs';
        // Simulate runtime's `name: input.name ?? '${header.name} · 分支'`
        const derived = `${dirtyParent} · 分支`;
        const branchHeader = await store.create(makeInput({ name: derived }));
        const persisted = await store.readHeader(branchHeader.id);
        assert.ok(!persisted.name.includes('\n'), 'newline in derived must be sanitized');
        assert.ok(!persisted.name.includes('\t'), 'tab in derived must be sanitized');
        assert.equal(persisted.name, 'parent with tabs · 分支');
      });
    });
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

function makeSubagentParent(parentSessionId = 'parent-session'): SubagentSessionParent {
  return {
    kind: 'subagent',
    parentSessionId,
    spawnedBy: {
      parentRunId: 'parent-run',
      parentTurnId: 'parent-turn',
      toolCallId: 'tool-call',
    },
    lifecycle: 'foreground',
  };
}

function makeSubagentRuntime(): SubagentSessionRuntime {
  return {
    schemaVersion: 1,
    definitionVersion: 1,
    agentId: 'local-read',
    agentName: 'Local Read',
    profile: 'local_read',
    systemPrompt: 'Read the assigned workspace task.',
    toolNames: ['Read', 'Glob', 'Grep'],
    categoryPolicy: { read: 'allow' },
    permissionCeiling: 'ask',
  };
}

function makeSubagentSpawn(): SubagentSessionSpawn {
  return {
    schemaVersion: 1,
    requestFingerprint: 'a'.repeat(64),
    initialTurnId: 'child-turn',
    initialRunId: 'child-run',
  };
}

function makeRawHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 'raw-session',
    workspaceRoot: '/tmp/workspace',
    cwd: '/tmp/cwd',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Raw session',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake-model',
    permissionMode: 'ask',
    schemaVersion: 1,
    ...overrides,
  };
}

function exploreToolResult(overrides: { candidateFiles: unknown[]; matches: unknown[] }): unknown {
  return {
    type: 'tool_result',
    id: 'tool-result-1',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'tool-1',
    isError: false,
    content: {
      kind: 'explore_agent',
      ok: true,
      mode: 'read_only',
      objective: 'inspect',
      roots: ['/tmp'],
      queries: ['needle'],
      filesInspected: 1,
      filesSkipped: 0,
      bytesRead: 10,
      progress: [],
      candidateFiles: overrides.candidateFiles,
      matches: overrides.matches,
      notes: [],
    },
  };
}

function assistantMessageAt(ts: number): StoredMessage {
  return {
    type: 'assistant',
    id: `assistant-${ts}`,
    turnId: `turn-${ts}`,
    ts,
    text: 'ok',
    modelId: 'fake-model',
  };
}

function subagentStatus(messages: StoredMessage[]): string | undefined {
  const result = messages.find((message) => message.id === 'legacy-subagent-result');
  return result?.type === 'tool_result' && result.content.kind === 'subagent'
    ? result.content.status
    : undefined;
}

async function withStore(
  fn: (store: ReturnType<typeof createSessionStore>, workspaceRoot: string) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-session-store-'));
  const store = createSessionStore(workspaceRoot);
  try {
    await fn(store, workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

// Silence unused-import warnings (kept for type clarity).
type _Header = SessionHeader;
