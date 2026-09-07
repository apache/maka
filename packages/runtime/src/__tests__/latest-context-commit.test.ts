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
import { z } from 'zod';
import {
  decodeModelCallAttempt,
  PROMPT_COMPOSITION_MAX_TOOLS,
  type ModelCallAttempt,
  type PromptComposition,
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
        // More tools than the composition names, because the cap is only a
        // real cap when something is actually over it: with an empty list the
        // row that crosses the chain has no tool rows at all, and every
        // assertion about them holds for free.
        tools: overflowingToolset(),
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
    const sessionRunIds = (await runtimeEventStore.listSessionInvocations(session.id)).map(
      (invocation) => invocation.runId,
    );
    const diagnostics = await readLatestContextDiagnostics(
      {
        readEvents: async (sessionId: string, runId: string) => {
          scanned += 1;
          return runStore.readEvents(sessionId, runId);
        },
        readEventProjection: (sessionId, type) => runStore.readEventProjection(sessionId, type),
        repairEventProjection: (sessionId, type, event, options) =>
          runStore.repairEventProjection(sessionId, type, event, options),
      },
      session.id,
      sessionRunIds,
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
    assertToolsAccountedFor(diagnostics.composition);

    await manager.stopSession(session.id, { source: 'stop_button' });
    runStore.close?.();

    const reopened = createSqliteAgentRunStore(root);
    try {
      const canonicalAttempts = (
        await Promise.all(
          sessionRunIds.map(async (runId) => {
            const events = await reopened.readEvents(session.id, runId);
            return events
              .filter((event) => event.type === 'model_call_attempt_recorded')
              .map((event) => decodeModelCallAttempt(event.data));
          }),
        )
      ).flat();
      assert.equal(canonicalAttempts.length, 1);
      const composition = canonicalAttempts[0]?.promptComposition;
      assert.ok(composition);
      assert.ok(composition.segments.length > 0);
      assertToolsAccountedFor(composition);

      let coldScans = 0;
      const cold = await readLatestContextDiagnostics(
        {
          readEvents: async (sessionId: string, runId: string) => {
            coldScans += 1;
            return reopened.readEvents(sessionId, runId);
          },
          repairEventProjection: (sessionId, type, event, options) =>
            reopened.repairEventProjection(sessionId, type, event, options),
        },
        session.id,
        sessionRunIds,
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

test('a turn aborted before dispatch does not create a canonical sent attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-aborted-request-chain-'));
  try {
    const sessionStore = createSessionStore(root);
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const backends = new BackendRegistry();
    let ids = 0;
    const newId = () => `abort-chain-${++ids}`;
    let providerCalls = 0;

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
        beforeRunProviderDispatch: () => {
          void backend.stop('user_stop');
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

    const runIds = (await runtimeEventStore.listSessionInvocations(session.id)).map(
      (invocation) => invocation.runId,
    );
    const events = (
      await Promise.all(runIds.map((runId) => runStore.readEvents(session.id, runId)))
    ).flat();
    assert.equal(providerCalls, 0);
    assert.equal(events.filter((event) => event.type === 'model_call_attempt_recorded').length, 0);
    assert.deepEqual(await readLatestContextDiagnostics(runStore, session.id, runIds), {
      status: 'unavailable',
      reason: 'no_completed_request',
    });
    await manager.stopSession(session.id, { source: 'stop_button' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const TOOLS_OVER_THE_CAP = 5;

/** More tools than the composition names, each a different size. */
function overflowingToolset() {
  return Array.from({ length: PROMPT_COMPOSITION_MAX_TOOLS + TOOLS_OVER_THE_CAP }, (_, index) => ({
    name: `tool-${String(index).padStart(3, '0')}`,
    description: `probe ${'d'.repeat(index * 8)}`,
    parameters: z.object({ q: z.string() }),
    impl: async () => ({ ok: true }),
  }));
}

/**
 * The tool rows, checked the way the panel has to be able to trust them.
 *
 * The cap is what keeps one MCP server's 1000 tools out of every attempt, so
 * the row a reader gets is by design not the whole toolset. What it must still
 * be is honest about that: the named ones are the largest, the rest are
 * counted, and the two together account for every tool byte the segment claims.
 */
function assertToolsAccountedFor(composition: PromptComposition | undefined): void {
  assert.ok(composition);
  const tools = composition.tools ?? [];
  assert.equal(tools.length, PROMPT_COMPOSITION_MAX_TOOLS);
  assert.equal(composition.remainingTools?.count, TOOLS_OVER_THE_CAP);

  const namedBytes = tools.reduce((total, tool) => total + tool.bytes, 0);
  assert.equal(
    namedBytes + (composition.remainingTools?.bytes ?? 0),
    composition.segments.find((segment) => segment.kind === 'tool_definitions')?.bytes,
    'the named tools and the remainder add up to the tool bytes the segment reports',
  );

  // Largest first, so the top of the list is what a reader could remove.
  const largest = Array.from(
    { length: PROMPT_COMPOSITION_MAX_TOOLS },
    (_, index) =>
      `tool-${String(PROMPT_COMPOSITION_MAX_TOOLS + TOOLS_OVER_THE_CAP - 1 - index).padStart(3, '0')}`,
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    largest,
  );
}

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
