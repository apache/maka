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

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { seedInvocation } from '@maka/runtime/test-only/invocation-fixture';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { backfillRuntimeEventsFromStoredMessages } from '../../../../../packages/runtime/dist/runtime-event-backfill.js';
import { createSessionTranscriptReader } from '../../../../../packages/runtime-host/dist/server/session-transcript-reader.js';
import { isRuntimeSystemNoteKind, type StoredMessage } from '@maka/core/session';

export const TRANSCRIPT_NAVIGATION_SESSION_ID = 'transcript-navigation-fixture';
export const TRANSCRIPT_NAVIGATION_FIRST_TURN_ID = 'transcript-navigation-turn-a';
export const TRANSCRIPT_NAVIGATION_SECOND_TURN_ID = 'transcript-navigation-turn-b';

/**
 * Source-row checkpoints from the production-shaped two-Turn failure.
 *
 * These identify the original content boundaries. The ledger fixture reads
 * its sparse durable sequences and watermarks from the production reader;
 * running checkpoints now belong to the active overlay.
 */
export const TRANSCRIPT_NAVIGATION_CHECKPOINTS = {
  firstTurnThrough: 194,
  secondTurnStartedThrough: 196,
  secondTurnFirstToolsThrough: 204,
  completeThrough: 232,
} as const;

export interface TranscriptNavigationRecord {
  readonly identity: number;
  readonly message: StoredMessage;
}

export interface TranscriptNavigationTurnFixture {
  readonly turnId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly encodedBytes: number;
}

export interface TranscriptNavigationTestFixture {
  readonly sessionId: string;
  readonly records: readonly TranscriptNavigationRecord[];
  readonly checkpoints: typeof TRANSCRIPT_NAVIGATION_CHECKPOINTS;
  readonly turns: {
    readonly first: TranscriptNavigationTurnFixture;
    readonly second: TranscriptNavigationTurnFixture;
  };
}

interface ToolSeries {
  ordinal: number;
}

interface ToolBatchOptions {
  readonly resultKind: 'json' | 'terminal';
  readonly paddingBytes?: (ordinal: number) => number;
}

const FIXTURE_EPOCH = Date.UTC(2026, 0, 2, 3, 4, 5);
const FIRST_TURN_STANDARD_RESULT_PADDING_BYTES = 4 * 1024;
const FIRST_TURN_LARGE_RESULT_PADDING_BYTES = new Map<number, number>([
  [12, 425 * 1024],
  [17, 935 * 1024],
]);
const SECOND_TURN_ASSISTANT_PADDING_BYTES = 12 * 1024;

/**
 * A privacy-safe transcript with the same useful boundaries as the diagnosed
 * failure: Turn A owns sequences 0..194 and is larger than the Desktop range;
 * Turn B starts at 195, first advances at 196 and 204, then settles at 232.
 *
 * Every record is a real StoredMessage. Tool call/result ids are paired and
 * every record in a Turn carries that Turn's stable id. Large payloads are
 * deterministic filler rather than copied command output or user text.
 */
export function createTranscriptNavigationTestFixture(): TranscriptNavigationTestFixture {
  const records: TranscriptNavigationRecord[] = [];
  const append = (message: StoredMessage): number => {
    const identity = records.length;
    records.push({ identity, message });
    return identity;
  };

  append(userMessage(TRANSCRIPT_NAVIGATION_FIRST_TURN_ID, 'first'));
  append(turnStateMessage(TRANSCRIPT_NAVIGATION_FIRST_TURN_ID, 'running'));
  let firstStepId = appendAssistant(
    append,
    TRANSCRIPT_NAVIGATION_FIRST_TURN_ID,
    'first-step-1',
  );
  const firstTools: ToolSeries = { ordinal: 0 };

  // 30 two-tool steps plus 13 one-tool steps produce the diagnosed Turn's
  // 73 call/result pairs and leave its final assistant at sequence 191.
  for (let step = 0; step < 43; step += 1) {
    appendToolBatch(
      append,
      TRANSCRIPT_NAVIGATION_FIRST_TURN_ID,
      firstStepId,
      step < 30 ? 2 : 1,
      firstTools,
      {
        resultKind: 'json',
        paddingBytes: (ordinal) =>
          FIRST_TURN_LARGE_RESULT_PADDING_BYTES.get(ordinal)
          ?? FIRST_TURN_STANDARD_RESULT_PADDING_BYTES,
      },
    );
    firstStepId = appendAssistant(
      append,
      TRANSCRIPT_NAVIGATION_FIRST_TURN_ID,
      `first-step-${step + 2}`,
    );
  }

  append(tokenUsageMessage(TRANSCRIPT_NAVIGATION_FIRST_TURN_ID, 'first'));
  append(turnStateMessage(TRANSCRIPT_NAVIGATION_FIRST_TURN_ID, 'completed'));
  append(sessionResumeMessage(TRANSCRIPT_NAVIGATION_FIRST_TURN_ID, 'first'));

  append(userMessage(TRANSCRIPT_NAVIGATION_SECOND_TURN_ID, 'second'));
  append(turnStateMessage(TRANSCRIPT_NAVIGATION_SECOND_TURN_ID, 'running'));
  const secondTools: ToolSeries = { ordinal: 0 };
  const secondToolOptions: ToolBatchOptions = {
    resultKind: 'terminal',
    paddingBytes: () => 256,
  };

  const secondStep1 = appendAssistant(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    'second-step-1',
    SECOND_TURN_ASSISTANT_PADDING_BYTES,
  );
  appendToolBatch(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    secondStep1,
    2,
    secondTools,
    secondToolOptions,
  );

  const secondStep2 = appendAssistant(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    'second-step-2',
    SECOND_TURN_ASSISTANT_PADDING_BYTES,
  );
  appendToolBatch(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    secondStep2,
    2,
    secondTools,
    secondToolOptions,
  );

  const secondStep3 = appendAssistant(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    'second-step-3',
    SECOND_TURN_ASSISTANT_PADDING_BYTES,
  );
  appendToolBatch(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    secondStep3,
    2,
    secondTools,
    secondToolOptions,
  );
  appendToolBatch(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    secondStep3,
    2,
    secondTools,
    secondToolOptions,
  );

  const secondStep4 = appendAssistant(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    'second-step-4',
    SECOND_TURN_ASSISTANT_PADDING_BYTES,
  );
  appendToolBatch(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    secondStep4,
    2,
    secondTools,
    secondToolOptions,
  );

  const secondStep5 = appendAssistant(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    'second-step-5',
    SECOND_TURN_ASSISTANT_PADDING_BYTES,
  );
  appendToolBatch(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    secondStep5,
    2,
    secondTools,
    secondToolOptions,
  );

  const secondStep6 = appendAssistant(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    'second-step-6',
    SECOND_TURN_ASSISTANT_PADDING_BYTES,
  );
  appendToolBatch(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    secondStep6,
    1,
    secondTools,
    secondToolOptions,
  );
  appendAssistant(
    append,
    TRANSCRIPT_NAVIGATION_SECOND_TURN_ID,
    'second-step-7',
    SECOND_TURN_ASSISTANT_PADDING_BYTES,
  );
  append(tokenUsageMessage(TRANSCRIPT_NAVIGATION_SECOND_TURN_ID, 'second'));
  append(turnStateMessage(TRANSCRIPT_NAVIGATION_SECOND_TURN_ID, 'completed'));
  append(sessionResumeMessage(TRANSCRIPT_NAVIGATION_SECOND_TURN_ID, 'second'));

  assertFixtureBoundary(records, 194, 'system_note', TRANSCRIPT_NAVIGATION_FIRST_TURN_ID);
  assertFixtureBoundary(records, 195, 'user', TRANSCRIPT_NAVIGATION_SECOND_TURN_ID);
  assertFixtureBoundary(records, 196, 'turn_state', TRANSCRIPT_NAVIGATION_SECOND_TURN_ID);
  assertFixtureBoundary(records, 204, 'tool_call', TRANSCRIPT_NAVIGATION_SECOND_TURN_ID);
  assertFixtureBoundary(records, 232, 'system_note', TRANSCRIPT_NAVIGATION_SECOND_TURN_ID);

  return {
    sessionId: TRANSCRIPT_NAVIGATION_SESSION_ID,
    records,
    checkpoints: TRANSCRIPT_NAVIGATION_CHECKPOINTS,
    turns: {
      first: turnFixture(records, TRANSCRIPT_NAVIGATION_FIRST_TURN_ID, 0, 194),
      second: turnFixture(records, TRANSCRIPT_NAVIGATION_SECOND_TURN_ID, 195, 232),
    },
  };
}

function appendAssistant(
  append: (message: StoredMessage) => number,
  turnId: string,
  label: string,
  thinkingPaddingBytes = 0,
): string {
  const id = `assistant-${label}`;
  append({
    type: 'assistant',
    id,
    turnId,
    ts: timestampForNextId(id),
    text: `Synthetic assistant checkpoint ${label}.`,
    ...(thinkingPaddingBytes > 0
      ? { thinking: { text: `Synthetic reasoning ${label}.\n${'r'.repeat(thinkingPaddingBytes)}` } }
      : {}),
    modelId: 'fixture-model',
  });
  return id;
}

function appendToolBatch(
  append: (message: StoredMessage) => number,
  turnId: string,
  stepId: string,
  count: number,
  series: ToolSeries,
  options: ToolBatchOptions,
): void {
  const calls = Array.from({ length: count }, () => {
    const ordinal = series.ordinal;
    series.ordinal += 1;
    const id = `tool-${turnId}-${ordinal}`;
    append({
      type: 'tool_call',
      id,
      turnId,
      ts: timestampForNextId(id),
      toolName: 'fixture_lookup',
      displayName: 'Synthetic fixture lookup',
      args: { ordinal, query: `fixture-query-${ordinal}` },
      stepId,
      origin: 'provider',
      modelVisibility: 'visible',
    });
    return { id, ordinal };
  });

  for (const call of calls) {
    const padding = 'x'.repeat(options.paddingBytes?.(call.ordinal) ?? 0);
    append({
      type: 'tool_result',
      id: `result-${turnId}-${call.ordinal}`,
      turnId,
      ts: timestampForNextId(`result-${turnId}-${call.ordinal}`),
      toolUseId: call.id,
      isError: false,
      content: options.resultKind === 'json'
        ? {
            kind: 'json',
            value: {
              ordinal: call.ordinal,
              summary: 'Deterministic synthetic fixture result.',
              payload: padding,
            },
          }
        : {
            kind: 'terminal',
            cwd: '/workspace/fixture',
            cmd: `fixture-command-${call.ordinal}`,
            status: 'completed',
            exitCode: 0,
            output: {
              mode: 'pipes',
              stdout: `Synthetic terminal result ${call.ordinal}.\n${padding}`,
              stderr: '',
              stdoutTruncated: false,
              stderrTruncated: false,
              redacted: false,
            },
          },
      durationMs: call.ordinal + 1,
      origin: 'provider',
      modelVisibility: 'visible',
    });
  }
}

function userMessage(
  turnId: string,
  label: string,
): Extract<StoredMessage, { type: 'user' }> {
  const id = `user-${label}`;
  return {
    type: 'user',
    id,
    turnId,
    ts: timestampForNextId(id),
    text: `Synthetic ${label} prompt.`,
    inlineReferences: [],
  };
}

function turnStateMessage(
  turnId: string,
  status: 'running' | 'completed',
): Extract<StoredMessage, { type: 'turn_state' }> {
  const id = `state-${turnId}-${status}`;
  return {
    type: 'turn_state',
    id,
    turnId,
    ts: timestampForNextId(id),
    status,
  };
}

function tokenUsageMessage(
  turnId: string,
  label: string,
): Extract<StoredMessage, { type: 'token_usage' }> {
  const id = `usage-${label}`;
  return {
    type: 'token_usage',
    id,
    turnId,
    ts: timestampForNextId(id),
    input: 1_000,
    output: 200,
    cacheRead: 100,
  };
}

function sessionResumeMessage(
  turnId: string,
  label: string,
): Extract<StoredMessage, { type: 'system_note' }> {
  const id = `session-resume-${label}`;
  return {
    type: 'system_note',
    id,
    turnId,
    ts: timestampForNextId(id),
    kind: 'session_resume',
  };
}

function timestampForNextId(id: string): number {
  let checksum = 0;
  for (let index = 0; index < id.length; index += 1) checksum += id.charCodeAt(index);
  return FIXTURE_EPOCH + checksum;
}

function turnFixture(
  records: readonly TranscriptNavigationRecord[],
  turnId: string,
  firstSequence: number,
  lastSequence: number,
): TranscriptNavigationTurnFixture {
  return {
    turnId,
    firstSequence,
    lastSequence,
    encodedBytes: records
      .slice(firstSequence, lastSequence + 1)
      .reduce(
        (total, { message }) => total + Buffer.byteLength(JSON.stringify(message), 'utf8'),
        0,
      ),
  };
}

function assertFixtureBoundary(
  records: readonly TranscriptNavigationRecord[],
  sequence: number,
  type: StoredMessage['type'],
  turnId: string,
): void {
  const record = records[sequence];
  if (
    record?.identity !== sequence
    || record.message.type !== type
    || record.message.turnId !== turnId
  ) {
    throw new Error(`Transcript navigation fixture boundary ${sequence} is invalid`);
  }
}

/**
 * The real SQLite ledger and Host reader used by the navigation regressions.
 * Legacy-shaped input keeps the payload fixture legible, but every page is
 * projected by the production RuntimeEvent reader. Running Turns live only in
 * the active overlay; their rows acquire sparse durable sequences on ending.
 */
export async function openTranscriptNavigationLedger(messages: readonly StoredMessage[]) {
  const base = await mkdtemp(join(tmpdir(), 'maka-transcript-navigation-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
  try {
    stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const runtimeEventStore = stores.runtimeEventStore;
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      llmConnectionSlug: 'fixture', model: 'fixture-model', permissionMode: 'ask',
    });
    const sessionId = session.id;
    const byTurn = new Map<string, Array<{ index: number; message: StoredMessage }>>();
    messages.forEach((message, index) => {
      assert.ok(message.turnId);
      const records = byTurn.get(message.turnId) ?? [];
      records.push({ index, message: { ...message, ts: FIXTURE_EPOCH + index } });
      byTurn.set(message.turnId, records);
    });
    const pending: Array<{ index: number; event: RuntimeEvent }> = [];
    for (const [turnId, records] of byTurn) {
      const runId = `run-${turnId}`;
      let eventIndex = 0;
      const converted = backfillRuntimeEventsFromStoredMessages({
        run: { sessionId, runId, invocationId: runId, turnId },
        // Session-resume notes belong to Session metadata in main; only an
        // invocation-owned note can enter its RuntimeEvent transcript.
        messages: records.map(({ message }) => message).filter((message) =>
          message.type !== 'system_note' || isRuntimeSystemNoteKind(message.kind)),
        outcome: { status: 'completed', ts: FIXTURE_EPOCH + records.at(-1)!.index },
        modelHistory: 'full', now: () => FIXTURE_EPOCH,
        newId: () => `${runId}-event-${eventIndex++}`,
      });
      assert.deepEqual(converted.diagnostics, [], 'the fixture must retain every source payload');
      for (const event of converted.events) {
        const index = event.actions?.endInvocation ? records.at(-1)!.index
          : records.find(({ message }) => message.id === event.refs?.storedMessageId)?.index;
        assert.notEqual(index, undefined);
        pending.push({ index: index!, event });
      }
    }
    pending.sort((left, right) => left.index - right.index);
    const opened = new Set<string>();
    let appendedThrough = -1;
    const reader = createSessionTranscriptReader({
      stores, canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
    });
    return {
      sessionId, reader,
      async appendThrough(index: number) {
        assert.ok(index >= appendedThrough, 'fixture writes advance monotonically');
        for (const pendingEvent of pending) {
          if (pendingEvent.index <= appendedThrough || pendingEvent.index > index) continue;
          const { event } = pendingEvent;
          if (!opened.has(event.turnId)) {
            await seedInvocation(runtimeEventStore, {
              sessionId, turnId: event.turnId, runId: event.runId, openedAt: event.ts - 0.5,
            });
            opened.add(event.turnId);
          }
          await runtimeEventStore.appendRuntimeEvent(sessionId, event.runId, event);
        }
        appendedThrough = index;
        return reader.readDurableHighWater(sessionId);
      },
      async appendPartialAssistant(turnId: string, messageId: string, text: string) {
        const runId = `run-${turnId}`;
        assert.ok(opened.has(turnId));
        await runtimeEventStore.appendRuntimeEvent(sessionId, runId, {
          id: `partial-${messageId}`, sessionId, runId, invocationId: runId, turnId,
          ts: FIXTURE_EPOCH + appendedThrough + 0.5,
          partial: true, role: 'model', author: 'agent',
          content: { kind: 'text', text }, refs: { providerEventId: messageId },
        });
      },
      async durableRecords() {
        const result = await reader.readDurableRecords(sessionId, {
          direction: 'newer', maxMessages: 1_000, maxStoredBytes: 16 * 1024 * 1024,
        });
        assert.equal(result.nextPosition, null, 'the assertion sweep must include every durable row');
        return result.records;
      },
      async close() {
        await stores!.sessionStore.close?.();
        await owner.close();
        await rm(base, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stores?.sessionStore.close?.();
    await owner.close();
    await rm(base, { recursive: true, force: true });
    throw error;
  }
}
