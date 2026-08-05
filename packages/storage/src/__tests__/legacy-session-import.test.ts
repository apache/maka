import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importLegacySessionsOnce } from '../legacy-session-import.js';
import { createSessionStore } from '../session-store.js';

function fixturePath(name: string): string {
  // tsc emits only .ts sources to dist, so fixtures stay in src and are read
  // from the compiled test via a relative path back up the tree.
  return fileURLToPath(
    new URL(`../../src/__tests__/fixtures/legacy-sessions/${name}`, import.meta.url),
  );
}

async function seedLegacySession(
  workspace: string,
  sessionId: string,
  fixtureName: string,
): Promise<void> {
  const content = await readFile(fixturePath(fixtureName), 'utf8');
  const dir = join(workspace, 'sessions', sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.jsonl'), content);
}

async function withWorkspace(
  run: (context: {
    sessions: ReturnType<typeof createSessionStore>;
    workspace: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-legacy-import-'));
  const workspace = join(root, 'workspace');
  const sessions = createSessionStore(workspace);
  try {
    await run({ sessions, workspace });
  } finally {
    await sessions.close?.();
    await rm(root, { recursive: true, force: true });
  }
}

test('imports a complete legacy session with messages in order and restored timestamps', async () => {
  await withWorkspace(async ({ sessions, workspace }) => {
    await seedLegacySession(workspace, 'legacy-a1b2c3d4e5f6', 'normal-session.jsonl');

    const result = await importLegacySessionsOnce(sessions, workspace);
    assert.deepEqual(result, {
      imported: 1,
      skipped: 0,
      failed: 0,
      failures: [],
    });

    const header = await sessions.readHeaderSnapshot('legacy-a1b2c3d4e5f6');
    // The importer restores the legacy lifecycle facts that createStableSession
    // would otherwise stamp with `Date.now()`.
    assert.equal(header.createdAt, 1783929889564);
    assert.equal(header.lastUsedAt, 1783929891400);
    assert.equal(header.lastMessageAt, 1783929891400);
    assert.equal(header.connectionLocked, true);
    assert.equal(header.name, 'New Chat');
    assert.equal(header.cwd, '/Users/fixture/work/demo-project');

    const messages = await sessions.readMessages('legacy-a1b2c3d4e5f6');
    assert.deepEqual(
      messages.map((message) => message.type),
      ['user', 'turn_state', 'assistant', 'token_usage', 'turn_state', 'system_note'],
    );
    assert.equal(messages[0]?.type, 'user');
    assert.equal((messages[0] as { text?: string }).text, 'hi');
    assert.equal(messages[2]?.type, 'assistant');
    assert.equal((messages[2] as { text?: string }).text, 'Hello! How can I help you today?');

    // The session appears in the list through the public surface too, which
    // also exercises the factory wiring (list awaits the lazy import).
    const summaries = await sessions.list();
    assert.ok(summaries.some((summary) => summary.id === 'legacy-a1b2c3d4e5f6'));
  });
});

test('is idempotent: a second run skips the already-imported session without duplicating data', async () => {
  await withWorkspace(async ({ sessions, workspace }) => {
    await seedLegacySession(workspace, 'legacy-a1b2c3d4e5f6', 'normal-session.jsonl');

    const first = await importLegacySessionsOnce(sessions, workspace);
    assert.equal(first.imported, 1);

    const second = await importLegacySessionsOnce(sessions, workspace);
    assert.deepEqual(second, { imported: 0, skipped: 1, failed: 0, failures: [] });

    const messages = await sessions.readMessages('legacy-a1b2c3d4e5f6');
    assert.equal(messages.length, 6, 'no duplicate messages after a second import');
  });
});

test('a corrupt transcript is skipped as failed while other sessions still import', async () => {
  await withWorkspace(async ({ sessions, workspace }) => {
    await seedLegacySession(workspace, 'legacy-a1b2c3d4e5f6', 'normal-session.jsonl');
    await seedLegacySession(workspace, 'legacy-corrupt-0001', 'corrupt-line-session.jsonl');

    const result = await importLegacySessionsOnce(sessions, workspace);
    assert.equal(result.imported, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.sessionId, 'legacy-corrupt-0001');
    assert.match(result.failures[0]?.error ?? '', /corrupt JSONL record/);

    // The corrupt session was not partially created.
    await assert.rejects(
      sessions.readHeaderSnapshot('legacy-corrupt-0001'),
      /Session metadata not found/,
    );
    const good = await sessions.readMessages('legacy-a1b2c3d4e5f6');
    assert.equal(good.length, 6);
  });
});

test('a sparse legacy header is completed with compatibility defaults', async () => {
  await withWorkspace(async ({ sessions, workspace }) => {
    await seedLegacySession(workspace, 'legacy-sparse-0001', 'sparse-header-session.jsonl');

    const result = await importLegacySessionsOnce(sessions, workspace);
    assert.equal(result.imported, 1);

    const header = await sessions.readHeaderSnapshot('legacy-sparse-0001');
    // Missing optional fields fall back to the pre-#1994 defaults.
    assert.equal(header.permissionMode, 'ask');
    assert.equal(header.collaborationMode, 'agent');
    assert.equal(header.orchestrationMode, 'default');
    // The legacy `claude` backend is remapped, and an empty model to `default`.
    assert.equal(header.backend, 'ai-sdk');
    assert.equal(header.model, 'default');
    // A non-default name is treated as a manually set title.
    assert.equal(header.titleIsManual, true);
    assert.equal(header.name, 'Sparse Session');
  });
});

test('a legacy turn without turn_state records normalizes to completed on read', async () => {
  await withWorkspace(async ({ sessions, workspace }) => {
    await seedLegacySession(workspace, 'legacy-noturnstate-1', 'no-turn-state-session.jsonl');

    const result = await importLegacySessionsOnce(sessions, workspace);
    assert.equal(result.imported, 1);

    const turns = await sessions.listTurns('legacy-noturnstate-1');
    assert.ok(turns.length >= 1);
    // With no recorded turn_state, core infers the turn as completed from the
    // presence of an assistant message.
    assert.equal(turns[0]?.status, 'completed');
    assert.equal(turns[0]?.statusSource, 'inferred');
  });
});
