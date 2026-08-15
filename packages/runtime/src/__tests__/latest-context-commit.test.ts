/**
 * The commit crossing the production chain (#2323).
 *
 * The previous shape passed `latestContext` as a second argument, and every
 * layer between the tracker and storage declared a one-argument callback —
 * JavaScript dropped the extra argument, TypeScript accepted the narrower
 * signature, and the derived row never reached the store in production while
 * every storage-level test kept passing by injecting it directly.
 *
 * So the test that matters here is the one that injects nothing: a real send,
 * through the real seams, read back the way the panel reads it.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { ModelCallAttempt } from '@maka/core/model-call-attempt';
import type { ModelCallCommit } from '@maka/core/agent-run';
import {
  createSessionStore,
  createSqliteAgentRunStore,
  createWorkspaceRuntimeStore,
} from '@maka/storage';
import { BackendRegistry, SessionManager } from '../session-manager.js';
import { readLatestContextDiagnostics } from '../context-diagnostics.js';
import { createTestAiSdkBackend } from './execution-boundary-test-helpers.js';

test('a real send seals its row all the way into SQLite, with nothing injected', async () => {
  // Tracker → backend → the kernel seam a backend is actually built with →
  // AgentRun → the storage transaction. Every layer in that list once had a
  // signature that compiled while dropping the row, and no test crossed all of
  // them: they each started from a `latestContext` handed straight to storage.
  const root = await mkdtemp(join(tmpdir(), 'maka-latest-context-chain-'));
  try {
    const sessionStore = createSessionStore(root);
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const backends = new BackendRegistry();
    let ids = 0;
    const newId = () => `chain-${++ids}`;
    let clock = 1_000;
    const now = () => (clock += 1);

    backends.register('fake', (ctx) =>
      createTestAiSdkBackend({
        sessionId: ctx.sessionId,
        header: ctx.header,
        appendMessage: async () => {},
        connection: {
          slug: 'mock-main',
          providerType: 'anthropic',
          defaultModel: 'mock-model-id',
          models: [{ id: 'mock-model-id', contextWindow: 200_000 }],
        },
        apiKey: 'sk-test',
        modelId: 'mock-model-id',
        modelFactory: () => answeringModel(),
        tools: [],
        // The seams the kernel hands a real backend, forwarded exactly as the
        // production composition forwards them — this is the hop that broke.
        ...(ctx.recordModelCallAttempt
          ? { recordModelCallAttempt: ctx.recordModelCallAttempt }
          : {}),
        newId,
        now,
      }),
    );

    const manager = new SessionManager({
      store: sessionStore,
      runStore,
      runtimeEventStore,
      backends,
      newId,
      now,
    });
    const session = await manager.createSession({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'mock-main',
      permissionMode: 'bypass',
    });
    for await (const _event of manager.sendMessage(session.id, {
      turnId: 'turn-1',
      text: 'what is my context made of?',
    })) {
      // Drain the turn so its run reaches the durable ledger.
    }

    let scanned = 0;
    const diagnostics = await readLatestContextDiagnostics(
      {
        listSessionRuns: (sessionId) => runStore.listSessionRuns(sessionId),
        readEvents: async (sessionId, runId) => {
          scanned += 1;
          return runStore.readEvents(sessionId, runId);
        },
        readEventProjection: (sessionId, type) => runStore.readEventProjection(sessionId, type),
        repairEventProjection: (sessionId, type, event, options) =>
          runStore.repairEventProjection(sessionId, type, event, options),
      },
      session.id,
    );

    assert.equal(diagnostics.status, 'available');
    if (diagnostics.status !== 'available') return;
    assert.equal(diagnostics.modelId, 'mock-model-id');
    assert.equal(diagnostics.inputTokens, 120, 'the metered numbers are the ones sealed');
    assert.equal(diagnostics.contextWindow, 200_000);
    assert.ok(
      diagnostics.composition?.segments.some((segment) => segment.kind === 'messages'),
      'and the request describes what it was made of',
    );
    assert.equal(scanned, 0, 'the row was committed by the send, not rebuilt by the read');

    await manager.stopSession(session.id, { source: 'stop_button' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a layer that forwards only the attempt no longer type-checks', () => {
  // The regression this replaces was invisible precisely because it compiled.
  // Keeping the shape in a value here means a future narrowing is a build
  // failure rather than a silently missing feature.
  const forward = (commit: ModelCallCommit<ModelCallAttempt>) => commit;
  const commit = {
    attempt: { attemptId: 'a-1' } as ModelCallAttempt,
    latestContext: { attemptId: 'a-1', orderedAt: 10, snapshot: { attemptId: 'a-1' } },
  } satisfies ModelCallCommit<ModelCallAttempt>;

  const forwarded = forward(commit);

  assert.equal(forwarded.latestContext?.attemptId, 'a-1', 'the derived row survives the hop');
  assert.equal(forwarded.attempt.attemptId, 'a-1');
});

function answeringModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'system instructions, tools and messages.' },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 9, text: 9, reasoning: 0 },
            },
          },
        ] as LanguageModelV4StreamPart[],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
}
