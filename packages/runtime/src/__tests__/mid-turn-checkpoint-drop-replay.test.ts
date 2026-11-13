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

/*
 * Regression coverage for the mid-turn checkpoint drop path
 * (`effective_history_changed` in ai-sdk-turn.ts) and its overflow recovery.
 *
 * Scenario (transient archive-storage failure):
 *  - call 1: Read one.md -> HUGE result H (> READ_PAGE_MAX_BYTES, archive
 *    candidate). Prune tries to archive H, the stub FAILS (attempt 1).
 *  - call 2: Read two.md -> small. Prune retries H, stub FAILS (attempt 2).
 *  - call 3: Read three.md -> small. Prune retries H, stub FAILS (attempt 3).
 *    The capacity hook then folds: the checkpoint pins its effective digest
 *    over the view WITH H in full. Folded request accepted.
 *  - call 4: Prune retries H, stub SUCCEEDS -> the transition commits after
 *    the fold, the covered effective view drifts -> `effective_history_changed`
 *    -> checkpoint block dropped, covered span replayed from the current
 *    effective view.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as flushMacrotask } from 'node:timers/promises';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';
import type { SessionEvent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { z } from 'zod';
import {
  createTestAiSdkBackend,
  testToolResultArchive,
} from './execution-boundary-test-helpers.js';
import {
  createSessionEventMapMemory,
  mapSessionEventToRuntimeEvent,
} from '../session-event-runtime-mapper.js';
import type { RuntimeEventMapContext } from '../session-event-runtime-mapper.js';
import type { HistoryCompactCheckpoint } from '../history-compact-checkpoint.js';
import type { HistoryCompactSummaryInput } from '../ai-sdk-compaction-contract.js';

const H_BODY = 'HUGE_RESULT_'.repeat(670); // ~8k chars > READ_PAGE_MAX_BYTES (7_500)
const ANCHOR_TEXT = 'compact this very long turn but keep my exact words';
const PRIOR_CHARS = 120;

interface DropFixture {
  backend: ReturnType<typeof createTestAiSdkBackend>;
  model: MockLanguageModelV4;
  recorded: HistoryCompactCheckpoint[];
  archiveAttempts: number;
  summarizerCalls: number;
  systemNotes: string[];
  priorEvents: RuntimeEvent[];
  anchor: RuntimeEvent;
  ledger: RuntimeEvent[];
  events: SessionEvent[];
  persist: (event: SessionEvent) => void;
}

interface DropFixtureOptions {
  /** Transient archive-storage failures before the write succeeds. */
  archiveAttemptsBeforeSuccess?: number;
  /** Provider call number that rejects with a context-overflow error. */
  overflowAtCall?: number;
}

function runtimeTextEvent(
  id: string,
  turnId: string,
  role: 'user' | 'model',
  text: string,
): RuntimeEvent {
  return {
    id,
    sessionId: 'session-1',
    runId: 'run-1',
    turnId,
    invocationId: 'run-1',
    ts: 1_800_000_000_000,
    partial: false,
    role,
    author: role === 'user' ? 'user' : 'agent',
    content: { kind: 'text', text },
  };
}

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionId: 'test-connection-id',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: true,
    model: 'mock-model-id',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'mock-model-id',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function idGenerator(): () => string {
  let index = 0;
  return () => `id-${++index}`;
}

function monotonicClock(): () => number {
  let value = 1_000;
  return () => ++value;
}

function buildDropFixture(options: DropFixtureOptions = {}): DropFixture {
  // Attempt schedule: call-1 prune has no candidates yet (H is not in the
  // ledger before the first request), so the attempts land at the call-2,
  // call-3 and call-4 prunes. Two failures keep the fold's pinned digest over
  // H in full; the call-4 success is the post-fold covered transition.
  const archiveAttemptsBeforeSuccess = options.archiveAttemptsBeforeSuccess ?? 2;
  const recorded: HistoryCompactCheckpoint[] = [];
  const events: SessionEvent[] = [];
  const systemNotes: string[] = [];
  let archiveAttempts = 0;
  const summarizerState = { calls: 0 };

  const usage = (input: number, output: number) => ({
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  });
  const usageOverride = (call: number): ReturnType<typeof usage> | undefined => {
    const overrides: Record<number, { input: number; output: number }> = {
      // Keep the post-fold baseline (60+10=70, reserve 20) inside the 190
      // window so the last step does not fold again and re-mask the drop.
      3: { input: 60, output: 10 },
    };
    const override = overrides[call];
    return override ? usage(override.input, override.output) : undefined;
  };
  const toolCallChunks = (
    id: string,
    name: string,
    args: object,
    call: number,
  ): LanguageModelV4StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: id,
      toolName: name,
      input: JSON.stringify(args),
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: usageOverride(call) ?? (id === 'tool-1' ? usage(100, 20) : usage(150, 30)),
    },
  ];
  const doneChunks = (call: number): LanguageModelV4StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: 'done' },
    { type: 'text-end', id: 'text-1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: usageOverride(call) ?? usage(120, 10),
    },
  ];

  const model = new MockLanguageModelV4({
    doStream: async (streamOptions: { abortSignal?: AbortSignal }) => {
      if (streamOptions.abortSignal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      // MockLanguageModelV4 records the call before doStream runs, so during
      // execution `length` is the 1-based number of THIS request.
      const call = model.doStreamCalls.length;
      if (options.overflowAtCall === call) {
        throw Object.assign(new Error('prompt is too long: 213462 tokens > 200000 maximum'), {
          name: 'AI_APICallError',
          statusCode: 400,
        });
      }
      const chunks =
        call <= 3
          ? toolCallChunks(
              `tool-${call}`,
              'Read',
              { path: ['one.md', 'two.md', 'three.md'][call - 1] },
              call,
            )
          : doneChunks(call);
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      };
    },
  });

  const priorEvents: RuntimeEvent[] = [
    runtimeTextEvent(
      'prior-user',
      'turn-0',
      'user',
      `PRIOR_FACT question ${'p'.repeat(PRIOR_CHARS)}`,
    ),
    runtimeTextEvent(
      'prior-model',
      'turn-0',
      'model',
      `PRIOR_FACT answer ${'q'.repeat(PRIOR_CHARS)}`,
    ),
  ];
  const anchor: RuntimeEvent = runtimeTextEvent('anchor-1', 'turn-1', 'user', ANCHOR_TEXT);

  const ledger: RuntimeEvent[] = [anchor];
  const ledgerCtx: RuntimeEventMapContext = {
    sessionId: 'session-1',
    invocationId: 'run-1',
    runId: 'run-1',
    turnId: 'turn-1',
    now: monotonicClock(),
  };
  const ledgerMemory = createSessionEventMapMemory();
  const persist = (event: SessionEvent): void => {
    const mapped = mapSessionEventToRuntimeEvent(event, ledgerCtx, ledgerMemory);
    if (mapped.partial === true) return;
    if (mapped.content?.kind === 'error') return;
    ledger.push(mapped);
  };

  const backend = createTestAiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    appendMessage: async () => {},
    recordSystemNote: async (kind) => {
      systemNotes.push(kind);
    },
    connection: {
      ...connection(),
      models: [{ id: 'mock-model-id', contextWindow: 190 }],
      modelOverrides: { 'mock-model-id': { compactionThreshold: 190 } },
    },
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => model,
    tools: [
      {
        name: 'Read',
        description: 'Read description',
        parameters: z.object({ path: z.string() }),
        impl: async (args: { path: string }) => {
          if (args.path === 'one.md') return { body: H_BODY };
          if (args.path === 'two.md') return { body: 'ok-two-small-body' };
          return { body: 'ok-three-small-body' };
        },
      },
    ],
    systemPrompt: () => ({
      contexts: [{ name: 'test.request-context', text: 'ACTIVE_REQUEST_CONTEXT' }],
      sourceRevisions: [],
    }),
    contextBudget: {
      name: 'mid-turn-drop-replay',
      historyCompact: {
        enabled: true,
        midTurn: { enabled: true },
      },
      toolResultPrune: {
        enabled: true,
      },
    },
    toolResultArchive: testToolResultArchive({
      archiveToolResult: async () => {
        archiveAttempts += 1;
        if (archiveAttempts <= archiveAttemptsBeforeSuccess) {
          // Transient storage failure: swallowed by
          // tool-result-archive-transition.ts.
          throw new Error('transient archive storage failure');
        }
        return { artifactId: 'artifact-archived-1' };
      },
    }),
    summarizeHistoryCompact: async (_input: HistoryCompactSummaryInput) => {
      summarizerState.calls += 1;
      return `## Goal\nMID_TURN_SUMMARY_SENTINEL\n\n## Progress\n- done\n\n## Next Steps\n1. continue\n\n## Critical Context\n- (none)`;
    },
    recordHistoryCompactCheckpoint: (checkpoint) => {
      recorded.push(checkpoint);
    },
    loadTurnRuntimeEvents: async (turnId) => {
      await flushMacrotask();
      return ledger.filter((event) => event.turnId === turnId);
    },
    allowMidTurnHistoryCompaction: true,
    newId: idGenerator(),
    now: monotonicClock(),
  });

  return {
    backend,
    model,
    recorded,
    get archiveAttempts() {
      return archiveAttempts;
    },
    get summarizerCalls() {
      return summarizerState.calls;
    },
    systemNotes,
    priorEvents,
    anchor,
    ledger,
    events,
    persist,
  };
}

async function runFixtureTurn(fixture: DropFixture): Promise<void> {
  for await (const event of fixture.backend.send({
    runId: 'run-1',
    turnId: 'turn-1',
    headAnchorRuntimeEvent: fixture.anchor,
    text: ANCHOR_TEXT,
    context: [],
    runtimeContext: [...fixture.priorEvents],
  })) {
    fixture.persist(event);
    fixture.events.push(event);
  }
}

interface CallComposition {
  messages: number;
  priorFactCount: number;
  sentinel: boolean;
  checkpointMarker: boolean;
  hugeBody: boolean;
  archivedPlaceholder: boolean;
}

function compositionOf(fixture: DropFixture, call: number): CallComposition {
  const prompt = fixture.model.doStreamCalls[call - 1]?.prompt ?? [];
  const json = JSON.stringify(
    prompt.map((message) => ({ role: message.role, content: message.content })),
  );
  return {
    messages: prompt.length,
    priorFactCount: (json.match(/PRIOR_FACT/g) ?? []).length,
    sentinel: json.includes('MID_TURN_SUMMARY_SENTINEL'),
    checkpointMarker: json.includes('maka_history_compact_checkpoint'),
    hugeBody: json.includes('HUGE_RESULT_'),
    archivedPlaceholder: json.includes('artifact-archived-1'),
  };
}

describe('mid-turn checkpoint drop replay', () => {
  test('drop rebuild replays the covered span folded with the prior turns once', async () => {
    const fixture = buildDropFixture({});
    await runFixtureTurn(fixture);

    // Journey: 3 tool steps + final text step; exactly one fold (call 3).
    assert.equal(fixture.model.doStreamCalls.length, 4);
    assert.equal(fixture.recorded.length, 1, 'exactly one proactive fold');
    assert.equal(
      fixture.archiveAttempts,
      3,
      'H archive attempts: call-2/3 prunes fail, call-4 succeeds',
    );
    assert.equal(fixture.summarizerCalls, 1, 'only the fold summarizes');

    const raw = compositionOf(fixture, 2);
    const fold = compositionOf(fixture, 3);
    const drop = compositionOf(fixture, 4);
    // Fold applied on call 3: summary block present, raw bodies gone.
    assert.equal(fold.sentinel, true, 'call 3 carries the fold summary block');
    assert.equal(fold.hugeBody, false, 'call 3 does not carry H raw');
    assert.equal(fold.priorFactCount, 0, 'call 3 covers the prior turns');
    // Drop on call 4: stale block removed, covered span replayed from the
    // effective view. The archive placeholder carries a read page (an excerpt
    // of H), so the body marker appears — but not the full 670 repetitions.
    assert.equal(drop.sentinel, false, 'call 4 dropped the stale block');
    assert.equal(drop.checkpointMarker, false, 'call 4 has no checkpoint block');
    assert.equal(drop.archivedPlaceholder, true, 'H replays as the archive placeholder');
    const hugeMarkerCount = (
      JSON.stringify(fixture.model.doStreamCalls[3]?.prompt).match(/HUGE_RESULT_/g) ?? []
    ).length;
    assert.ok(
      hugeMarkerCount < 670,
      `H replays as a page excerpt, not the raw body (${hugeMarkerCount}/670 markers)`,
    );
    assert.equal(raw.priorFactCount, 2, 'raw requests carry the prior turns once');
    // currentTurnMessages is materialized from the prior content events plus
    // the current turn (ai-sdk-turn.ts), so on the drop path it already covers
    // the whole request; prepending priorReplay.messages would duplicate the
    // prior turns in the model-visible history.
    assert.equal(drop.priorFactCount, 2, 'the drop rebuild must not duplicate the prior turns');
  });

  test('overflow after a drop recovers by re-folding, not terminal', async () => {
    const fixture = buildDropFixture({ overflowAtCall: 4 });
    await runFixtureTurn(fixture);

    const complete = fixture.events.find((event) => event.type === 'complete');
    const stopReason = complete?.type === 'complete' ? complete.stopReason : undefined;
    const errorEvents = fixture.events.filter((event) => event.type === 'error');

    // The drop-path comment promises "overflow recovery re-folds". The fold
    // step-shaping mark is cleared as soon as its request is accepted, so the
    // gate in recoverFromOverflowError is open by the time a drop can happen
    // and the Turn must recover rather than terminate.
    assert.equal(stopReason, 'end_turn');
    assert.equal(errorEvents.length, 0, 'no terminal error event');
    assert.equal(
      fixture.model.doStreamCalls.length,
      5,
      'one re-folded retry after the rejected drop request',
    );
    const resend = compositionOf(fixture, 5);
    assert.equal(resend.sentinel, true, 'the recovery re-fold carries a fresh summary block');
    assert.equal(resend.hugeBody, false, 'the recovery re-fold keeps H folded');
    assert.equal(resend.priorFactCount, 0, 'the recovery re-fold covers the prior turns');
    assert.equal(fixture.summarizerCalls, 2, 'the recovery fold summarizes again');
    assert.equal(
      fixture.systemNotes.includes('context_overflow_after_compaction'),
      false,
      'recovery succeeded, so no misleading after-compaction note',
    );
  });
});
