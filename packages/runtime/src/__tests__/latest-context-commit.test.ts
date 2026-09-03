/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
import {
  decodeModelCallAttempt,
  PREPARED_REQUEST_OBSERVATION_MAX_SEGMENTS,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { createSessionStore } from '@maka/storage/session-store';
import { BackendRegistry, SessionManager } from '../session-manager.js';
import { readLatestContextDiagnostics } from '../context-diagnostics.js';
import { createTestAiSdkBackend } from './execution-boundary-test-helpers.js';

test('a real send seals its observation into SQLite and reconstructs it after restart', async () => {
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

    backends.register('ai-sdk', (ctx) =>
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
    runStore.close?.();

    const reopened = createSqliteAgentRunStore(root);
    try {
      const runs = await reopened.listSessionRuns(session.id);
      const canonicalAttempts = (
        await Promise.all(
          runs.map(async (run) => {
            const events = await reopened.readEvents(session.id, run.runId);
            return events
              .filter((event) => event.type === 'model_call_attempt_recorded')
              .map((event) => decodeModelCallAttempt(event.data));
          }),
        )
      ).flat();
      assert.equal(canonicalAttempts.length, 1);
      const observation = canonicalAttempts[0]?.requestObservation;
      assert.ok(observation);
      assert.ok(observation.segments.length <= PREPARED_REQUEST_OBSERVATION_MAX_SEGMENTS);
      assert.ok(observation.segments.length > 0);
      assert.ok(observation.segments.every((segment) => segment.comparison === 'exact'));

      let coldScans = 0;
      const cold = await readLatestContextDiagnostics(
        {
          listSessionRuns: (sessionId) => reopened.listSessionRuns(sessionId),
          readEvents: async (sessionId, runId) => {
            coldScans += 1;
            return reopened.readEvents(sessionId, runId);
          },
          repairEventProjection: (sessionId, type, event, options) =>
            reopened.repairEventProjection(sessionId, type, event, options),
        },
        session.id,
      );

      assert.ok(coldScans > 0, 'omitting the projection reader forces a restart-safe ledger fold');
      assert.equal(cold.status, 'available');
      if (cold.status !== 'available') return;
      assert.deepEqual(cold.composition, diagnostics.composition);
    } finally {
      reopened.close?.();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an artifact captured before abort does not create a canonical sent attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-aborted-request-chain-'));
  try {
    const sessionStore = createSessionStore(root);
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const backends = new BackendRegistry();
    let ids = 0;
    const newId = () => `abort-chain-${++ids}`;
    let providerCalls = 0;
    let artifactWrites = 0;

    backends.register('ai-sdk', (ctx) => {
      let backend!: ReturnType<typeof createTestAiSdkBackend>;
      backend = createTestAiSdkBackend({
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
        modelFactory: () =>
          new MockLanguageModelV4({
            doStream: async () => {
              providerCalls += 1;
              return { stream: simulateReadableStream({ chunks: [] }) };
            },
          }),
        tools: [],
        persistPreparedRequestArtifact: async () => {
          artifactWrites += 1;
          void backend.stop('user_stop');
          return { artifactId: 'abandoned-artifact' };
        },
        ...(ctx.recordModelCallAttempt
          ? { recordModelCallAttempt: ctx.recordModelCallAttempt }
          : {}),
        newId,
        now: () => 1_000 + ids,
      });
      return backend;
    });

    const manager = new SessionManager({
      store: sessionStore,
      runStore,
      runtimeEventStore,
      backends,
      newId,
      now: () => 1_000 + ids,
    });
    const session = await manager.createSession({
      cwd: root,
      llmConnectionSlug: 'mock-main',
      permissionMode: 'bypass',
    });
    for await (const _event of manager.sendMessage(session.id, {
      turnId: 'turn-aborted-before-dispatch',
      text: 'abort after preparing the request',
    })) {
      // Drain the aborted turn through the real AgentRun store.
    }

    const runs = await runStore.listSessionRuns(session.id);
    const events = (
      await Promise.all(runs.map((run) => runStore.readEvents(session.id, run.runId)))
    ).flat();
    assert.equal(artifactWrites, 1);
    assert.equal(providerCalls, 0);
    assert.equal(events.filter((event) => event.type === 'model_call_attempt_recorded').length, 0);
    assert.deepEqual(await readLatestContextDiagnostics(runStore, session.id), {
      status: 'unavailable',
      reason: 'no_completed_request',
    });
    await manager.stopSession(session.id, { source: 'stop_button' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
