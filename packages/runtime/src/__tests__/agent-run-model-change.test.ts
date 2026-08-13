import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { AgentBackend } from '@maka/core/backend-types';
import { decodeModelChangeNoteData } from '@maka/core/session';
import {
  createSessionStore,
  createSqliteAgentRunStore,
  createWorkspaceRuntimeStore,
} from '@maka/storage';
import { AgentRun } from '../agent-run.js';

test('records only the model transition that carries the admitted turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-change-'));
  try {
    const store = createSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/project',
      backend: 'fake',
      llmConnectionSlug: 'provider-a',
      model: 'model-a',
      permissionMode: 'ask',
    });
    const runStore = createSqliteAgentRunStore(root);
    await runStore.createRun(previousRun(session.id));

    // The user may have selected model-b in between. Configuration history is
    // intentionally not an execution fact; the admitted turn uses model-c.
    const selected = await store.updateHeader(session.id, {
      llmConnectionSlug: 'provider-c',
      model: 'model-c',
    });
    const run = new AgentRun({
      sessionId: session.id,
      header: selected,
      userInput: { turnId: 'turn-c', text: 'use the selected model' },
      runId: 'run-c',
      store,
      runStore,
      runtimeEventStore: createWorkspaceRuntimeStore(root),
      newId: incrementingId(),
      now: incrementingTime(20),
      hooks: hooks(store, backend(session.id)),
    });

    await run.begin();
    // A provider failure does not erase which model carried the admitted turn.
    await runStore.updateRun(session.id, run.runId, {
      status: 'failed',
      failureClass: 'provider_error',
    });

    const messages = await store.readMessages(session.id);
    assert.equal(messages.length, 2);
    const [note, user] = messages;
    assert.equal(note?.type, 'system_note');
    assert.equal(note?.type === 'system_note' ? note.kind : undefined, 'model_change');
    assert.deepEqual(
      note?.type === 'system_note' ? decodeModelChangeNoteData(note.data) : undefined,
      {
        from: { connectionSlug: 'provider-a', model: 'model-a' },
        to: { connectionSlug: 'provider-c', model: 'model-c' },
      },
    );
    assert.equal(user?.type, 'user');
    assert.equal(user?.turnId, 'turn-c');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not record an unused selection that returns to the last-used model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-change-return-'));
  try {
    const store = createSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/project',
      backend: 'fake',
      llmConnectionSlug: 'provider-a',
      model: 'model-a',
      permissionMode: 'ask',
    });
    const runStore = createSqliteAgentRunStore(root);
    await runStore.createRun(previousRun(session.id));

    // A -> B -> A happened only in configuration. The next admitted turn is
    // still A, so the transcript has no model transition.
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-a-2', text: 'still on a' },
      runId: 'run-a-2',
      store,
      runStore,
      runtimeEventStore: createWorkspaceRuntimeStore(root),
      newId: incrementingId(),
      now: incrementingTime(30),
      hooks: hooks(store, backend(session.id)),
    });

    await run.begin();

    const messages = await store.readMessages(session.id);
    assert.deepEqual(
      messages.map((message) => message.type),
      ['user'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function previousRun(sessionId: string): AgentRunHeader {
  return {
    runId: 'run-a',
    sessionId,
    turnId: 'turn-a',
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'provider-a',
    modelId: 'model-a',
    cwd: '/tmp/project',
    permissionMode: 'ask',
    createdAt: 10,
    updatedAt: 11,
    completedAt: 11,
  };
}

function backend(sessionId: string): AgentBackend {
  return {
    kind: 'fake',
    sessionId,
    async *send() {},
    async stop() {},
    async respondToSandboxBoundary() {},
    async dispose() {},
  };
}

function hooks(store: ReturnType<typeof createSessionStore>, runBackend: AgentBackend) {
  return {
    reserveRun: async (
      sessionId: string,
      header: Awaited<ReturnType<typeof store.readHeader>>,
    ) => ({
      sessionId,
      backend: runBackend,
      cachedHeader: header,
      activeRuns: new Map(),
      turnToRunId: new Map(),
    }),
    unregisterRun: () => {},
    updateHeader: (sessionId: string, patch: Parameters<typeof store.updateHeader>[1]) =>
      store.updateHeader(sessionId, patch),
    updateStatus: async () => {},
    appendTurnState: async () => {},
  };
}

function incrementingId(): () => string {
  let id = 0;
  return () => `id-${++id}`;
}

function incrementingTime(start: number): () => number {
  let time = start;
  return () => ++time;
}
