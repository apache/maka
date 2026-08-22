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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { RunSealedError } from '@maka/core/runtime-event-store';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import {
  buildImmutableRuntimePrefix,
  createRuntimeBoundaryCursor,
  runtimePrefixSegment,
  type ContinuationClaimV1,
  type ImmutableRuntimePrefixV1,
} from '@maka/core/runtime-boundary';
import {
  ToolLedgerCorruptionError,
  ToolLedgerRejectionError,
} from '@maka/core/tool-ledger-scanner';
import {
  SQLITE_RUNTIME_SCHEMA_VERSION,
  createSqliteRuntimeStore,
  type SqliteRuntimeStoreFailpoint,
} from '../sqlite-runtime-store.js';

describe('SqliteRuntimeStore', () => {
  it('applies versioned migrations and reopens the same database without rewriting schema', async () => {
    await withStore(async (store, dbPath) => {
      assert.equal(store.schemaVersion(), SQLITE_RUNTIME_SCHEMA_VERSION);
      assert.equal(store.journalMode(), 'wal');
      assert.equal(store.foreignKeysEnabled(), true);
      store.close();

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        assert.equal(reopened.schemaVersion(), SQLITE_RUNTIME_SCHEMA_VERSION);
        assert.deepEqual(await reopened.readRuntimeEvents('session-1', 'run-1'), []);
      } finally {
        reopened.close();
      }
    });
  });

  it('refuses every post-terminal append as the typed sealed-run boundary', async () => {
    await withStore(async (store) => {
      const opening = functionCallEvent({
        id: 'sealed-run-opening',
        content: { kind: 'text', text: 'hello' },
      });
      await store.appendRuntimeEvent(opening.sessionId, opening.runId, opening);
      const terminal: RuntimeEvent = {
        id: 'sealed-run-terminal',
        invocationId: 'invocation-1',
        runId: opening.runId,
        sessionId: opening.sessionId,
        turnId: 'turn-1',
        ts: 2,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'aborted',
        actions: { endInvocation: true, stateDelta: { abortSource: 'user_stop' } },
      };
      await store.appendRuntimeEvent(terminal.sessionId, terminal.runId, terminal);

      // A plain straggler and a tool-bearing one refuse identically: the
      // seal is checked before tool-ledger semantics (#2311), so a late
      // function_call cannot surface as a producer bug or as corruption.
      await assert.rejects(
        store.appendRuntimeEvent(opening.sessionId, opening.runId, {
          ...opening,
          id: 'late-plain-straggler',
          ts: 3,
        }),
        (error: unknown) => error instanceof RunSealedError,
      );
      await assert.rejects(
        store.appendRuntimeEvent(
          opening.sessionId,
          opening.runId,
          functionCallEvent({
            id: 'late-tool-straggler',
            ts: 4,
          }),
        ),
        (error: unknown) => error instanceof RunSealedError,
      );
      // Exact-id retry of an already-stored event keeps its dedup answer.
      await store.appendRuntimeEvent(terminal.sessionId, terminal.runId, terminal);
    });
  });

  it('assigns stable Session ordinals in commit order across Runs', async () => {
    await withStore(async (store, dbPath) => {
      const first = functionCallEvent({ id: 'ordinal-1', ts: 20 });
      const second = functionCallEvent({
        id: 'ordinal-2',
        invocationId: 'invocation-2',
        runId: 'run-2',
        turnId: 'turn-2',
        ts: 10,
      });
      await store.appendRuntimeEvent(first.sessionId, first.runId, first);
      await store.appendRuntimeEvent(second.sessionId, second.runId, second);
      await store.appendRuntimeEvent(first.sessionId, first.runId, first);

      assert.deepEqual(
        (await store.readSessionRuntimeEventEntries('session-1')).map(({ ordinal, event }) => ({
          ordinal,
          eventId: event.id,
        })),
        [
          { ordinal: 1, eventId: 'ordinal-1' },
          { ordinal: 2, eventId: 'ordinal-2' },
        ],
      );

      store.close();
      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        assert.deepEqual(
          (await reopened.readSessionRuntimeEventEntries('session-1')).map(
            ({ ordinal, event }) => ({ ordinal, eventId: event.id }),
          ),
          [
            { ordinal: 1, eventId: 'ordinal-1' },
            { ordinal: 2, eventId: 'ordinal-2' },
          ],
        );
      } finally {
        reopened.close();
      }
    });
  });
  it('makes a raw canonical-equivalent terminal durability retry idempotent', async () => {
    await withStore(async (store) => {
      const terminal: RuntimeEvent = {
        id: 'terminal-event-1',
        sessionId: 'session-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 5,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
        content: {
          kind: 'text',
          text: 'done',
          displayText: 'done',
          attachments: [],
          quotes: [],
        },
        actions: { endInvocation: true },
      };

      await store.appendRuntimeEvent('session-1', 'run-1', terminal);
      await store.ensureTerminalRuntimeEventDurable('session-1', 'run-1', terminal);

      const events = await store.readImmutableRuntimeEvents('session-1', 'run-1');
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]?.content, { kind: 'text', text: 'done' });
    });
  });

  it('imports a conversation-copy tool ledger with its derived projections', async () => {
    await withStore(async (store) => {
      const events = [functionCallEvent(), toolDispatchEvent(), functionResponseEvent({ ts: 11 })];

      await store.importConversationCopyRuntimeEvents('session-1', [{ runId: 'run-1', events }]);
      await store.importConversationCopyRuntimeEvents('session-1', [{ runId: 'run-1', events }]);

      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-1'), events);
      assert.equal(
        (await store.readToolOperation('operation-1'))?.currentState,
        'outcome_committed',
      );
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared', 'outcome_committed'],
      );
    });
  });

  // These two pin the ERROR CLASS, not the message. AgentRun exempts exactly
  // one class from the store-unavailable latch (`ToolLedgerRejectionError`), so
  // the class is a behavioural contract between storage and runtime — and both
  // messages are byte-identical to the plain `Error` strings they replaced, so
  // a regression to `throw new Error(...)` would leave every message-matching
  // assertion in this suite green while the exemption silently stopped working.
  it('rejects an inadmissible candidate with ToolLedgerRejectionError, naming the code', async () => {
    await withStore(async (store) => {
      // Untagged, so it takes the generic lane — a tagged response is a
      // reserved boundary fact and never reaches the transition check. This is
      // the exact shape #2234 produced: a result with no call to answer.
      const orphan = functionResponseEvent({
        id: 'orphan-response-event',
        ts: 11,
        refs: { toolCallId: 'provider-call-1' },
      });
      await assert.rejects(
        store.appendRuntimeEvent(orphan.sessionId, orphan.runId, orphan),
        (error: unknown) =>
          error instanceof ToolLedgerRejectionError &&
          error.code === 'orphan_response' &&
          error.eventId === 'orphan-response-event',
      );
    });
  });

  it('reports pre-existing damage as ToolLedgerCorruptionError, even from another session', async () => {
    await withStore(async (store, dbPath) => {
      store.close();

      // Seed damage the store would never have written itself, in a session
      // this run never touches: the health scan has no WHERE clause, so one
      // damaged operation anywhere in the workspace is what a later append meets.
      const raw = new DatabaseSync(dbPath);
      const stranded = functionResponseEvent({
        id: 'stranded-response',
        sessionId: 'some-other-session',
        invocationId: 'some-other-invocation',
        runId: 'some-other-run',
        ts: 5,
      });
      raw
        .prepare(`
          INSERT INTO runtime_events
            (event_id, session_id, invocation_id, run_id, turn_id, event_seq, event_kind,
             payload_json, committed_at)
          VALUES (?, ?, ?, ?, ?, 1, 'function_response', ?, 5)
        `)
        .run(
          stranded.id,
          stranded.sessionId,
          stranded.invocationId,
          stranded.runId,
          stranded.turnId,
          JSON.stringify(stranded),
        );
      raw.close();

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        const healthy = functionCallEvent();
        await assert.rejects(
          reopened.appendRuntimeEvent(healthy.sessionId, healthy.runId, healthy),
          (error: unknown) =>
            error instanceof ToolLedgerCorruptionError &&
            !(error instanceof ToolLedgerRejectionError) &&
            error.code === 'orphan_response',
        );
      } finally {
        reopened.close();
      }
    });
  });

  it('commits function_call, dispatch fact, and operation projection atomically in T1', async () => {
    await withStore(async (store) => {
      const call = functionCallEvent();
      const dispatch = toolDispatchEvent();

      const input = {
        operationId: 'operation-1',
        journalEventId: 'operation-1_prepared',
        runtimeEvent: call,
        dispatchRuntimeEvent: dispatch,
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: READ_ARGS_HASH,
        recoveryMode: 'replay_safe',
        committedAt: 10,
      } as const;
      const result = await store.commitToolPrepared(input);

      assert.equal(result.created, true);
      assert.equal(result.runtimeEventSeq, 2);
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [call, dispatch]);
      assert.deepEqual(await store.readToolOperation('operation-1'), {
        operationId: 'operation-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: READ_ARGS_HASH,
        recoveryMode: 'replay_safe',
        currentState: 'prepared',
        callEventId: 'call-event-1',
        dispatchEventId: 'dispatch-event-1',
        version: 1,
      });
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared'],
      );
      assert.equal((await store.readToolJournal('operation-1'))[0]?.runtimeEventId, dispatch.id);
      assert.deepEqual(
        (await store.listUnsettledToolOperations()).map((operation) => operation.operationId),
        ['operation-1'],
      );
    });
  });

  it('commits nested T1 events with parent operation linkage', async () => {
    await withStore(async (store) => {
      const parentRefs = {
        parentToolCallId: 'exec-call-1',
        parentOperationId: 'exec-operation-1',
      } as const;
      const call = functionCallEvent({
        refs: {
          operationId: 'operation-1',
          toolCallId: 'provider-call-1',
          ...parentRefs,
        },
      });
      const dispatch = toolDispatchEvent({
        refs: {
          operationId: 'operation-1',
          toolCallId: 'provider-call-1',
          ...parentRefs,
        },
      });

      const result = await store.commitToolPrepared({
        operationId: 'operation-1',
        journalEventId: 'operation-1_prepared',
        runtimeEvent: call,
        dispatchRuntimeEvent: dispatch,
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: READ_ARGS_HASH,
        recoveryMode: 'replay_safe',
        committedAt: 10,
      });

      assert.equal(result.created, true);
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [call, dispatch]);
    });
  });

  it('claims an exact function_call that was committed while permission was pending', async () => {
    await withStore(async (store) => {
      const call = functionCallEvent();
      await store.appendRuntimeEvent('session-1', 'run-1', call);

      const result = await commitPrepared(store);

      assert.equal(result.created, true);
      assert.equal(result.runtimeEventSeq, 2);
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [
        call,
        toolDispatchEvent(),
      ]);
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
    });
  });

  it('rolls back every T1 row when failure occurs after the RuntimeEvent insert', async () => {
    await withStore(async (store, _dbPath, setFailpoint) => {
      setFailpoint('after_runtime_event_insert');

      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'operation-t1-failure',
          journalEventId: 'operation-t1-failure_prepared',
          runtimeEvent: functionCallEvent({ id: 'call-t1-failure' }),
          dispatchRuntimeEvent: toolDispatchEvent({
            id: 'dispatch-t1-failure',
            refs: { operationId: 'operation-t1-failure', toolCallId: 'provider-call-1' },
            actions: {
              toolDispatch: {
                protocol: 't1_after_preflight_v1',
                operationId: 'operation-t1-failure',
                providerToolCallId: 'provider-call-1',
                toolName: 'Read',
                canonicalArgsHash: READ_ARGS_HASH,
                recoveryMode: 'replay_safe',
              },
            },
          }),
          providerToolCallId: 'provider-call-1',
          toolName: 'Read',
          canonicalArgsHash: READ_ARGS_HASH,
          recoveryMode: 'replay_safe',
          committedAt: 11,
        }),
        /sqlite runtime failpoint: after_runtime_event_insert/,
      );

      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), []);
      assert.equal(await store.readToolOperation('operation-t1-failure'), undefined);
      assert.deepEqual(await store.readToolJournal('operation-t1-failure'), []);
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 0);
    });
  });

  it('commits function_response, outcome journal fact, and projection atomically in T2', async () => {
    await withStore(async (store) => {
      await commitPrepared(store);
      const outcome = functionResponseEvent();

      const result = await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'operation-1_outcome',
        runtimeEvent: outcome,
        committedAt: 20,
      });

      assert.equal(result.created, true);
      assert.equal(result.runtimeEventSeq, 3);
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [
        functionCallEvent(),
        toolDispatchEvent(),
        outcome,
      ]);
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 3);
      assert.deepEqual(await store.readToolOperation('operation-1'), {
        operationId: 'operation-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: READ_ARGS_HASH,
        recoveryMode: 'replay_safe',
        currentState: 'outcome_committed',
        callEventId: 'call-event-1',
        dispatchEventId: 'dispatch-event-1',
        resultEventId: 'response-event-1',
        version: 2,
      });
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared', 'outcome_committed'],
      );
      assert.deepEqual(await store.listUnsettledToolOperations(), []);
    });
  });

  it('rolls back T2 without hiding the previously committed prepared boundary', async () => {
    await withStore(async (store, _dbPath, setFailpoint) => {
      await commitPrepared(store);
      setFailpoint('after_runtime_event_insert');

      await assert.rejects(
        store.commitToolOutcome({
          operationId: 'operation-1',
          journalEventId: 'operation-1_outcome',
          runtimeEvent: functionResponseEvent({ id: 'response-t2-failure' }),
          committedAt: 21,
        }),
        /sqlite runtime failpoint: after_runtime_event_insert/,
      );

      assert.deepEqual(
        (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['call-event-1', 'dispatch-event-1'],
      );
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared'],
      );
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 2);
    });
  });

  it('deduplicates exact T1/T2 retries and rejects operation identity drift', async () => {
    await withStore(async (store) => {
      const firstPrepared = await commitPrepared(store);
      const duplicatePrepared = await commitPrepared(store);
      assert.equal(firstPrepared.created, true);
      assert.equal(duplicatePrepared.created, false);

      const firstOutcome = await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'operation-1_outcome',
        runtimeEvent: functionResponseEvent(),
        committedAt: 20,
      });
      const duplicateOutcome = await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'operation-1_outcome',
        runtimeEvent: functionResponseEvent(),
        committedAt: 20,
      });
      assert.equal(firstOutcome.created, true);
      assert.equal(duplicateOutcome.created, false);
      assert.equal((await store.readToolJournal('operation-1')).length, 2);
      assert.equal((await store.readRuntimeEvents('session-1', 'run-1')).length, 3);

      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'operation-1',
          journalEventId: 'operation-1_prepared',
          runtimeEvent: functionCallEvent({
            content: {
              kind: 'function_call',
              id: 'provider-call-1',
              name: 'Read',
              args: { path: '/workspace/repo/OTHER.md' },
            },
          }),
          dispatchRuntimeEvent: toolDispatchEvent({
            actions: {
              toolDispatch: {
                protocol: 't1_after_preflight_v1',
                operationId: 'operation-1',
                providerToolCallId: 'provider-call-1',
                toolName: 'Read',
                canonicalArgsHash: DIFFERENT_READ_ARGS_HASH,
                recoveryMode: 'replay_safe',
              },
            },
          }),
          providerToolCallId: 'provider-call-1',
          toolName: 'Read',
          canonicalArgsHash: DIFFERENT_READ_ARGS_HASH,
          recoveryMode: 'replay_safe',
          committedAt: 30,
        }),
        /duplicate_event_id/,
      );
    });
  });

  it('validates a tool transition after unrelated invocation history', async () => {
    await withStore(async (store) => {
      const unrelated = functionCallEvent({
        id: 'unrelated-event',
        sessionId: 'session-2',
        invocationId: 'invocation-2',
        runId: 'run-2',
        turnId: 'turn-2',
        content: { kind: 'text', text: 'unrelated history' },
      });
      await store.appendRuntimeEvent(unrelated.sessionId, unrelated.runId, unrelated);

      const result = await commitPrepared(store);

      assert.equal(result.created, true);
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
    });
  });

  it('rebuilds disposable tool projections from RuntimeEvent facts', async () => {
    await withStore(async (store) => {
      await commitPrepared(store);
      await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'operation-1_outcome',
        runtimeEvent: functionResponseEvent(),
        committedAt: 20,
      });

      const result = await store.rebuildToolProjectionsFromRuntimeEvents();

      assert.deepEqual(result, { operations: 1, journalEvents: 2 });
      assert.equal(
        (await store.readToolOperation('operation-1'))?.dispatchEventId,
        'dispatch-event-1',
      );
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => ({
          state: event.state,
          runtimeEventId: event.runtimeEventId,
        })),
        [
          { state: 'prepared', runtimeEventId: 'dispatch-event-1' },
          { state: 'outcome_committed', runtimeEventId: 'response-event-1' },
        ],
      );
    });
  });

  it('coalesces stream chunks outside the immutable high-water ledger', async () => {
    await withStore(async (store) => {
      for (const [index, text] of ['hel', 'lo', '!'].entries()) {
        await store.appendRuntimeEvent(
          'session-1',
          'run-1',
          functionCallEvent({
            id: `partial-${index}`,
            ts: index + 1,
            partial: true,
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text },
            refs: { providerEventId: 'message-1' },
          }),
        );
      }

      const visible = await store.readRuntimeEvents('session-1', 'run-1');
      const scanned: RuntimeEvent[] = [];
      const scan = await store.scanRuntimeEvents(
        'session-1',
        'run-1',
        {
          maxBatchBytes: 1024,
          maxRecordBytes: 1024,
          maxImmutableRecords: 10,
          maxImmutableBytes: 1024,
          maxPartialRecords: 10,
          maxPartialBytes: 1024,
        },
        (events) => scanned.push(...events),
      );
      assert.equal(scan.status, 'complete');
      assert.equal(visible.length, 1);
      assert.deepEqual(scanned, visible);
      assert.deepEqual(visible[0]?.content, { kind: 'text', text: 'hello!' });
      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-1'), []);
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 0);
    });
  });

  it('rejects an oversized scan record before visiting its decoded body', async () => {
    await withStore(async (store) => {
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'large-event',
          content: { kind: 'text', text: 'x'.repeat(4096) },
        }),
      );
      let visits = 0;
      const result = await store.scanRuntimeEvents(
        'session-1',
        'run-1',
        {
          maxBatchBytes: 128,
          maxRecordBytes: 128,
          maxImmutableRecords: 10,
          maxImmutableBytes: 1024,
          maxPartialRecords: 10,
          maxPartialBytes: 1024,
        },
        () => {
          visits += 1;
        },
      );
      assert.equal(result.status, 'limit_exceeded');
      assert.equal(visits, 0);
    });
  });

  it('rejects an immutable ledger that exceeds its cumulative scan budget before decoding it', async () => {
    await withStore(async (store) => {
      for (const index of [1, 2]) {
        const event: RuntimeEvent = {
          id: `event-${index}`,
          invocationId: 'invocation-1',
          runId: 'run-1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          ts: index,
          partial: false,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: `message-${index}` },
        };
        await store.appendRuntimeEvent('session-1', 'run-1', event);
      }
      let visits = 0;
      const result = await store.scanRuntimeEvents(
        'session-1',
        'run-1',
        {
          maxBatchBytes: 16 * 1024,
          maxRecordBytes: 16 * 1024,
          maxImmutableRecords: 1,
          maxImmutableBytes: 16 * 1024,
          maxPartialRecords: 10,
          maxPartialBytes: 16 * 1024,
        },
        () => {
          visits += 1;
        },
      );

      assert.equal(result.status, 'limit_exceeded');
      assert.equal(visits, 0);
    });
  });

  it('streams fragmented legacy partial segments without retaining their row set', async () => {
    await withStore(async (store, dbPath) => {
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'partial-segment-seed',
          partial: true,
          content: { kind: 'text', text: '' },
          refs: { providerEventId: 'message-1' },
        }),
      );
      const inspect = new DatabaseSync(dbPath);
      try {
        const { stream_key: streamKey } = inspect
          .prepare('SELECT stream_key FROM runtime_partial_snapshots')
          .get() as { stream_key: string };
        const insert = inspect.prepare(`
          INSERT INTO runtime_partial_segments(stream_key, segment_seq, text_content, updated_at)
          VALUES (?, ?, 'x', ?)
        `);
        inspect.exec('BEGIN IMMEDIATE');
        for (let sequence = 1; sequence <= 9_000; sequence += 1) {
          insert.run(streamKey, sequence, sequence);
        }
        inspect.exec('COMMIT');
      } finally {
        inspect.close();
      }
      const scanned: RuntimeEvent[] = [];
      const result = await store.scanRuntimeEvents(
        'session-1',
        'run-1',
        {
          maxBatchBytes: 1024,
          maxRecordBytes: 16 * 1024,
          maxImmutableRecords: 10,
          maxImmutableBytes: 16 * 1024,
          maxPartialRecords: 10,
          maxPartialBytes: 16 * 1024,
        },
        (events) => scanned.push(...events),
      );
      assert.equal(result.status, 'complete');
      assert.equal(scanned.length, 1);
      assert.equal(scanned[0]?.content?.kind, 'text');
      assert.equal(
        scanned[0]?.content?.kind === 'text' ? scanned[0].content.text : undefined,
        'x'.repeat(9_000),
      );
    });
  });

  it('atomically claims a source with exactly one terminal RuntimeEvent at its tail', async () => {
    await withStore(async (store) => {
      const claim = continuationClaim();
      await persistImmutablePrefix(store, continuationSourcePrefix());

      const acquired = await store.claimContinuation({ claim });
      const existing = await store.claimContinuation({ claim: { ...claim } });

      assert.equal(acquired.kind, 'acquired');
      assert.equal(existing.kind, 'existing');
      assert.deepEqual(existing.claim, claim);
      assert.deepEqual(await store.readContinuationClaimByBoundary(claim.boundaryDigest), claim);
    });
  });

  it('rejects a continuation claim whose immediate source boundary is not durable', async () => {
    await withStore(async (store) => {
      const claim = continuationClaim();

      await assert.rejects(store.claimContinuation({ claim }), /source boundary is missing/i);
      assert.equal(await store.readContinuationClaimByBoundary(claim.boundaryDigest), undefined);
    });
  });

  it('rejects a non-terminal continuation source without sealing the active Run', async () => {
    await withStore(async (store) => {
      const source = activeContinuationSourcePrefix();
      const claim = continuationClaimForBoundary(
        createRuntimeBoundaryCursor([runtimePrefixSegment(source)]),
      );
      await persistImmutablePrefix(store, source);

      await assert.rejects(
        store.claimContinuation({ claim }),
        /source boundary must end with exactly one terminal RuntimeEvent/i,
      );
      assert.equal(await store.readContinuationClaimByBoundary(claim.boundaryDigest), undefined);

      const terminal: RuntimeEvent = functionCallEvent({
        id: 'source-terminal-after-rejected-claim',
        ts: 2,
        content: undefined,
        role: 'system',
        author: 'system',
        status: 'failed',
        actions: { endInvocation: true },
      });
      await store.ensureTerminalRuntimeEventDurable(terminal.sessionId, terminal.runId, terminal);
      assert.deepEqual(
        (await store.readImmutableRuntimeEvents(terminal.sessionId, terminal.runId)).map(
          (event) => event.id,
        ),
        [source.events[0]!.id, terminal.id],
      );
    });
  });

  it('rejects a continuation source whose terminal RuntimeEvent has a corrupt suffix', async () => {
    await withStore(async (store, dbPath) => {
      const source = continuationSourcePrefix();
      const suffix = functionCallEvent({
        id: 'corrupt-source-suffix',
        ts: 3,
        content: { kind: 'text', text: 'must not follow the terminal fact' },
      });
      await persistImmutablePrefix(store, source);

      const raw = new DatabaseSync(dbPath);
      try {
        raw
          .prepare(`
            INSERT INTO runtime_events (
              event_id, session_id, invocation_id, run_id, turn_id, event_seq,
              event_kind, payload_json, committed_at
            ) VALUES (?, ?, ?, ?, ?, 3, 'text', ?, ?)
          `)
          .run(
            suffix.id,
            suffix.sessionId,
            suffix.invocationId,
            suffix.runId,
            suffix.turnId,
            JSON.stringify(suffix),
            suffix.ts,
          );
      } finally {
        raw.close();
      }

      const corruptedPrefix = buildImmutableRuntimePrefix(source.identity, [
        ...source.events.map((event, index) => ({ eventSeq: index + 1, event })),
        { eventSeq: 3, event: suffix },
      ]);
      const claim = continuationClaimForBoundary(
        createRuntimeBoundaryCursor([runtimePrefixSegment(corruptedPrefix)]),
      );

      await assert.rejects(
        store.claimContinuation({ claim }),
        /source boundary must end with exactly one terminal RuntimeEvent/i,
      );
      assert.equal(await store.readContinuationClaimByBoundary(claim.boundaryDigest), undefined);
    });
  });

  it('rejects a stale claim after the source advances beyond its planned boundary', async () => {
    await withStore(async (store) => {
      const source = activeContinuationSourcePrefix();
      const claim = continuationClaimForBoundary(
        createRuntimeBoundaryCursor([runtimePrefixSegment(source)]),
      );
      await persistImmutablePrefix(store, source);
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'source-event-2',
          ts: 2,
          role: 'system',
          author: 'system',
          content: undefined,
          status: 'failed',
          actions: { endInvocation: true },
        }),
      );

      await assert.rejects(store.claimContinuation({ claim }), /source boundary changed/i);
      assert.equal(await store.readContinuationClaimByBoundary(claim.boundaryDigest), undefined);
    });
  });

  it('seals the claimed source against later immutable RuntimeEvents', async () => {
    await withStore(async (store) => {
      const claim = continuationClaim();
      await persistImmutablePrefix(store, continuationSourcePrefix());
      assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');

      await assert.rejects(
        store.appendRuntimeEvent(
          'session-1',
          'run-1',
          functionCallEvent({
            id: 'source-event-2',
            ts: 2,
            role: 'system',
            author: 'system',
            content: undefined,
            status: 'failed',
            actions: { endInvocation: true },
          }),
        ),
        /sealed by continuation claim/i,
      );
    });
  });

  it('rolls back a continuation claim when the process fails after its insert', async () => {
    await withStore(async (store, _dbPath, setFailpoint) => {
      const claim = continuationClaim();
      await persistImmutablePrefix(store, continuationSourcePrefix());
      setFailpoint('after_continuation_claim_insert');

      await assert.rejects(store.claimContinuation({ claim }), /after_continuation_claim_insert/);
      assert.equal(await store.readContinuationClaimByBoundary(claim.boundaryDigest), undefined);

      setFailpoint(undefined);
      assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');
    });
  });

  it('rejects a second boundary that tries to reuse an acquired target identity', async () => {
    await withStore(async (store) => {
      const claim = continuationClaim();
      const source = continuationSourcePrefix();
      const otherSource = buildImmutableRuntimePrefix(
        {
          sessionId: 'session-1',
          invocationId: 'invocation-source-2',
          runId: 'run-source-2',
          turnId: 'turn-source-2',
        },
        [
          {
            eventSeq: 1,
            event: functionCallEvent({
              id: 'source-2-event',
              invocationId: 'invocation-source-2',
              runId: 'run-source-2',
              turnId: 'turn-source-2',
              content: { kind: 'text', text: 'source request' },
              role: 'user',
              author: 'user',
            }),
          },
          {
            eventSeq: 2,
            event: functionCallEvent({
              id: 'source-2-terminal',
              invocationId: 'invocation-source-2',
              runId: 'run-source-2',
              turnId: 'turn-source-2',
              ts: 2,
              content: undefined,
              role: 'system',
              author: 'system',
              status: 'failed',
              actions: { endInvocation: true },
            }),
          },
        ],
      );
      const otherBoundary = createRuntimeBoundaryCursor([runtimePrefixSegment(otherSource)]);
      await persistImmutablePrefix(store, source);
      await persistImmutablePrefix(store, otherSource);
      assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');

      const conflict = await store.claimContinuation({
        claim: continuationClaimForBoundary(otherBoundary, {
          claimId: 'claim-2',
          claimedAt: 11,
          target: claim.target,
        }),
      });

      assert.equal(conflict.kind, 'conflict');
      assert.deepEqual(conflict.claim, claim);
    });
  });

  it('fails closed when continuation claim columns disagree with canonical payload', async () => {
    await withStore(async (store, dbPath) => {
      const claim = continuationClaim();
      await persistImmutablePrefix(store, continuationSourcePrefix());
      assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');

      const tamper = new DatabaseSync(dbPath);
      try {
        tamper
          .prepare('UPDATE runtime_continuation_claims SET source_run_id = ? WHERE claim_id = ?')
          .run('forged-source-run', claim.claimId);
      } finally {
        tamper.close();
      }

      await assert.rejects(
        store.readContinuationClaimByBoundary(claim.boundaryDigest),
        /row\/payload identity mismatch/,
      );
      await assert.rejects(
        store.appendRuntimeEvent(
          'session-1',
          'run-1',
          functionCallEvent({
            id: 'source-write-after-claim-corruption',
            ts: 2,
            content: { kind: 'text', text: 'must remain sealed' },
          }),
        ),
        /row\/payload identity mismatch/,
      );
    });
  });

  it('requires a continuation claim target to have an empty RuntimeEvent ledger', async () => {
    await withStore(async (store) => {
      const claim = continuationClaim();
      await persistImmutablePrefix(store, continuationSourcePrefix());
      await store.appendRuntimeEvent(
        claim.target.sessionId,
        claim.target.runId,
        functionCallEvent({
          id: 'unexpected-target-event',
          ...claim.target,
          ts: 9,
          content: { kind: 'text', text: 'not a continuation start' },
        }),
      );

      await assert.rejects(
        store.claimContinuation({ claim }),
        /target RuntimeEvent ledger is not empty/i,
      );
      assert.equal(await store.readContinuationClaimByBoundary(claim.boundaryDigest), undefined);
    });
  });

  it('reserves a claimed target first event for its dedicated continuation-start writer', async () => {
    await withStore(async (store) => {
      const claim = continuationClaim();
      const start = continuationStartEvent(claim);
      await persistImmutablePrefix(store, continuationSourcePrefix());
      assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');

      await assert.rejects(
        store.appendRuntimeEvent(
          claim.target.sessionId,
          claim.target.runId,
          functionCallEvent({
            id: 'racing-target-event',
            ...claim.target,
            ts: 11,
            content: { kind: 'text', text: 'must not steal event sequence one' },
          }),
        ),
        /reserved for continuation-start/i,
      );
      assert.deepEqual(await store.commitContinuationStart({ claim, event: start }), {
        created: true,
        runtimeEventSeq: 1,
      });

      const afterStart: RuntimeEvent = {
        id: 'continued-model-event',
        ...claim.target,
        ts: 13,
        partial: false,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'provider dispatch is now admitted' },
      };
      await store.appendRuntimeEvent(claim.target.sessionId, claim.target.runId, afterStart);
      assert.deepEqual(
        (await store.readImmutableRuntimeEvents(claim.target.sessionId, claim.target.runId)).map(
          (event) => event.id,
        ),
        [start.id, afterStart.id],
      );
    });
  });

  it('commits continuation-start exactly once through its dedicated authority writer', async () => {
    await withStore(async (store) => {
      const claim = continuationClaim();
      const event = continuationStartEvent(claim);
      await persistImmutablePrefix(store, continuationSourcePrefix());
      assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');
      assert.deepEqual(await store.readContinuationClaimStateByBoundary(claim.boundaryDigest), {
        claim,
      });
      assert.deepEqual(await store.listContinuationClaimsForRecovery(claim.target.sessionId), [
        { claim },
      ]);

      await assert.rejects(
        store.appendRuntimeEvent(claim.target.sessionId, claim.target.runId, event),
        /continuation authority writer/i,
      );
      assert.deepEqual(await store.commitContinuationStart({ claim, event }), {
        created: true,
        runtimeEventSeq: 1,
      });
      assert.deepEqual(await store.commitContinuationStart({ claim, event }), {
        created: false,
        runtimeEventSeq: 1,
      });
      assert.deepEqual(
        await store.readImmutableRuntimeEvents(claim.target.sessionId, claim.target.runId),
        [event],
      );
      assert.deepEqual(await store.readContinuationClaimStateByBoundary(claim.boundaryDigest), {
        claim,
        startEventId: event.id,
        startKind: 'runtime_admission',
      });
      assert.deepEqual(await store.listContinuationClaimsForRecovery(claim.target.sessionId), [
        { claim, startEventId: event.id, startKind: 'runtime_admission' },
      ]);
    });
  });

  it('stores continuation start provenance through separate admission and repair commands', async () => {
    await withStore(async (store) => {
      const claim = continuationClaim();
      const repairEvent = continuationStartEvent(claim, {
        id: 'repair-start-event',
        provenance: 'claim_repair',
      });
      await persistImmutablePrefix(store, continuationSourcePrefix());
      assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');

      await assert.rejects(
        store.commitContinuationStart({ claim, event: repairEvent }),
        /invalid continuation-start authority event/i,
      );
      assert.deepEqual(await store.commitContinuationRepairStart({ claim, event: repairEvent }), {
        created: true,
        runtimeEventSeq: 1,
      });
      assert.deepEqual(await store.readContinuationClaimStateByBoundary(claim.boundaryDigest), {
        claim,
        startEventId: repairEvent.id,
        startKind: 'claim_repair',
      });
    });
  });

  it('binds the durable tool boundary marker to a live continuation start only', async () => {
    await withStore(async (store) => {
      const liveClaim = continuationClaim();
      const liveEvent = continuationStartEvent(liveClaim, {
        toolBoundaryProtocol: 't1_after_preflight_v1',
      });
      await persistImmutablePrefix(store, continuationSourcePrefix());
      assert.equal((await store.claimContinuation({ claim: liveClaim })).kind, 'acquired');
      assert.deepEqual(
        await store.commitContinuationStart({ claim: liveClaim, event: liveEvent }),
        {
          created: true,
          runtimeEventSeq: 1,
        },
      );

      const repairSource = buildImmutableRuntimePrefix(
        {
          sessionId: 'session-1',
          invocationId: 'invocation-repair-source',
          runId: 'run-repair-source',
          turnId: 'turn-repair-source',
        },
        [
          {
            eventSeq: 1,
            event: functionCallEvent({
              id: 'repair-source-event',
              sessionId: 'session-1',
              invocationId: 'invocation-repair-source',
              runId: 'run-repair-source',
              turnId: 'turn-repair-source',
              content: { kind: 'text', text: 'repair source request' },
              role: 'user',
              author: 'user',
            }),
          },
          {
            eventSeq: 2,
            event: functionCallEvent({
              id: 'repair-source-terminal',
              sessionId: 'session-1',
              invocationId: 'invocation-repair-source',
              runId: 'run-repair-source',
              turnId: 'turn-repair-source',
              ts: 2,
              content: undefined,
              role: 'system',
              author: 'system',
              status: 'failed',
              actions: { endInvocation: true },
            }),
          },
        ],
      );
      const repairClaim = continuationClaimForBoundary(
        createRuntimeBoundaryCursor([runtimePrefixSegment(repairSource)]),
        {
          claimId: 'continuation-claim-repair-protocol',
          target: {
            sessionId: 'session-1',
            invocationId: 'invocation-repair-protocol',
            runId: 'run-repair-protocol',
            turnId: 'turn-repair-protocol',
          },
        },
      );
      const repairEvent = continuationStartEvent(repairClaim, {
        id: 'repair-start-with-protocol',
        provenance: 'claim_repair',
        toolBoundaryProtocol: 't1_after_preflight_v1',
      });
      await persistImmutablePrefix(store, repairSource);
      assert.equal((await store.claimContinuation({ claim: repairClaim })).kind, 'acquired');
      await assert.rejects(
        store.commitContinuationRepairStart({ claim: repairClaim, event: repairEvent }),
        /invalid continuation-start authority event/i,
      );
    });
  });

  it('seals a continuation invocation after its terminal fact while allowing exact retry', async () => {
    await withStore(async (store) => {
      const claim = continuationClaim();
      const start = continuationStartEvent(claim);
      const terminal: RuntimeEvent = {
        id: 'continuation-terminal-1',
        ...claim.target,
        ts: 13,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'failed',
        actions: {
          endInvocation: true,
          stateDelta: { failureClass: 'continuation_test_terminal' },
        },
      };
      await persistImmutablePrefix(store, continuationSourcePrefix());
      assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');
      await store.commitContinuationStart({ claim, event: start });
      await store.ensureTerminalRuntimeEventDurable(
        claim.target.sessionId,
        claim.target.runId,
        terminal,
      );
      await store.ensureTerminalRuntimeEventDurable(
        claim.target.sessionId,
        claim.target.runId,
        terminal,
      );

      await assert.rejects(
        store.appendRuntimeEvent(claim.target.sessionId, claim.target.runId, {
          id: 'post-terminal-model-event',
          ...claim.target,
          ts: 14,
          partial: false,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'must not be appended' },
        }),
        /sealed by its terminal fact/i,
      );
      await assert.rejects(
        store.appendRuntimeEvent(claim.target.sessionId, claim.target.runId, {
          id: 'post-terminal-fresh-invocation',
          sessionId: claim.target.sessionId,
          invocationId: 'fresh-invocation-after-terminal',
          runId: claim.target.runId,
          turnId: claim.target.turnId,
          ts: 15,
          partial: false,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'must not bypass the run terminal seal' },
        }),
        /run identity conflict|sealed by its terminal fact/i,
      );
      assert.deepEqual(
        (await store.readImmutableRuntimeEvents(claim.target.sessionId, claim.target.runId)).map(
          (event) => event.id,
        ),
        [start.id, terminal.id],
      );
    });
  });

  it('does not bless an exact terminal retry when a corrupt suffix follows it', async () => {
    await withStore(async (store, dbPath) => {
      const terminal: RuntimeEvent = {
        id: 'terminal-before-corrupt-suffix',
        sessionId: 'session-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 2,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'failed',
        actions: { endInvocation: true },
      };
      await store.appendRuntimeEvent('session-1', 'run-1', terminal);
      store.close();

      const suffix: RuntimeEvent = {
        id: 'corrupt-post-terminal-suffix',
        sessionId: 'session-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 3,
        partial: false,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'must make the ledger invalid' },
      };
      const raw = new DatabaseSync(dbPath);
      try {
        raw
          .prepare(`
            INSERT INTO runtime_events (
              event_id, session_id, invocation_id, run_id, turn_id, event_seq,
              event_kind, payload_json, committed_at
            ) VALUES (?, ?, ?, ?, ?, 2, 'text', ?, ?)
          `)
          .run(
            suffix.id,
            suffix.sessionId,
            suffix.invocationId,
            suffix.runId,
            suffix.turnId,
            JSON.stringify(suffix),
            suffix.ts,
          );
      } finally {
        raw.close();
      }

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        await assert.rejects(
          reopened.ensureTerminalRuntimeEventDurable('session-1', 'run-1', terminal),
          /terminal RuntimeEvent must be the immutable ledger tail/i,
        );
        await assert.rejects(
          reopened.appendRuntimeEvent(
            'session-1',
            'run-1',
            functionCallEvent({
              id: 'append-after-corrupt-terminal-suffix',
              ts: 4,
              content: { kind: 'text', text: 'must remain sealed' },
            }),
          ),
          /sealed by its terminal fact/i,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects a continuation-start whose provider replay identity differs from its claim', async () => {
    await withStore(async (store) => {
      const claim = continuationClaim();
      const event = continuationStartEvent(claim);
      await persistImmutablePrefix(store, continuationSourcePrefix());
      assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');

      await assert.rejects(
        store.commitContinuationStart({
          claim,
          event: {
            ...event,
            actions: {
              continuationStart: {
                ...event.actions!.continuationStart!,
                providerReplayDigest: `sha256:${'c'.repeat(64)}`,
              },
            },
          },
        }),
        /invalid continuation-start authority event/i,
      );
      await assert.rejects(
        store.commitContinuationStart({
          claim,
          event: { ...event, ts: claim.claimedAt - 1 },
        }),
        /invalid continuation-start authority event/i,
      );
      assert.deepEqual(await store.readContinuationClaimStateByBoundary(claim.boundaryDigest), {
        claim,
      });
    });
  });

  it('rolls back continuation-start when failure occurs after the event insert', async () => {
    await withStore(async (store, _dbPath, setFailpoint) => {
      const claim = continuationClaim();
      const event = continuationStartEvent(claim);
      await persistImmutablePrefix(store, continuationSourcePrefix());
      assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');
      setFailpoint('after_continuation_start_insert');

      await assert.rejects(
        store.commitContinuationStart({ claim, event }),
        /after_continuation_start_insert/,
      );
      assert.deepEqual(
        await store.readImmutableRuntimeEvents(claim.target.sessionId, claim.target.runId),
        [],
      );
      assert.deepEqual(await store.readContinuationClaimByBoundary(claim.boundaryDigest), claim);

      setFailpoint(undefined);
      assert.deepEqual(await store.commitContinuationStart({ claim, event }), {
        created: true,
        runtimeEventSeq: 1,
      });
    });
  });

  it('pins a physical immutable prefix independently of mutable partial snapshots', async () => {
    await withStore(async (store) => {
      const first = functionCallEvent({
        id: 'user-event-1',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'hello' },
      });
      await store.appendRuntimeEvent('session-1', 'run-1', first);
      const beforePartial = await store.readImmutableRuntimePrefix({
        sessionId: 'session-1',
        runId: 'run-1',
      });

      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'partial-1',
          ts: 2,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'working' },
          refs: { providerEventId: 'message-1' },
        }),
      );
      const afterPartial = await store.readImmutableRuntimePrefix({
        sessionId: 'session-1',
        runId: 'run-1',
      });

      assert.equal((await store.readRuntimeEvents('session-1', 'run-1')).length, 2);
      assert.deepEqual(afterPartial.position, {
        lastEventSeq: 1,
        eventCount: 1,
        lastEventId: 'user-event-1',
      });
      assert.equal(afterPartial.prefixDigest, beforePartial.prefixDigest);

      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'model-event-2',
          ts: 3,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'done' },
        }),
      );
      const pinned = await store.readImmutableRuntimePrefix({
        sessionId: 'session-1',
        runId: 'run-1',
        upToEventSeq: 1,
      });
      const latest = await store.readImmutableRuntimePrefix({
        sessionId: 'session-1',
        runId: 'run-1',
      });

      assert.equal(pinned.prefixDigest, beforePartial.prefixDigest);
      assert.equal(latest.position.lastEventSeq, 2);
      assert.notEqual(latest.prefixDigest, beforePartial.prefixDigest);
    });
  });

  it('stores a partial batch as one append-only segment and reconstructs the same text', async () => {
    await withStore(async (store, dbPath) => {
      const partial = (id: string, ts: number, text: string): RuntimeEvent =>
        functionCallEvent({
          id,
          ts,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text },
          refs: { providerEventId: 'message-1' },
        });
      await store.appendRuntimeEvent('session-1', 'run-1', partial('partial-1', 1, 'a'));
      await store.appendRuntimePartialBatch('session-1', 'run-1', [
        partial('partial-2', 2, 'b'),
        partial('partial-3', 3, 'c'),
      ]);

      const events = await store.readRuntimeEvents('session-1', 'run-1');
      assert.equal(events.length, 1);
      assert.equal(events[0]?.content?.kind, 'text');
      assert.equal(events[0]?.content?.kind === 'text' ? events[0].content.text : undefined, 'abc');

      const inspect = new DatabaseSync(dbPath);
      try {
        assert.deepEqual(
          inspect
            .prepare(`
              SELECT segment_seq, text_content
              FROM runtime_partial_segments
              ORDER BY segment_seq ASC
            `)
            .all()
            .map((row) => ({ ...row })),
          [{ segment_seq: 1, text_content: 'abc' }],
        );
      } finally {
        inspect.close();
      }
    });
  });

  it('coalesces partial text into fixed-size tail segments', async () => {
    await withStore(async (store, dbPath) => {
      const chunks = ['x'.repeat(40 * 1024), 'y'.repeat(40 * 1024), 'z'];
      for (const [index, text] of chunks.entries()) {
        await store.appendRuntimeEvent(
          'session-1',
          'run-1',
          functionCallEvent({
            id: `partial-${index}`,
            ts: index + 1,
            partial: true,
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text },
            refs: { providerEventId: 'message-1' },
          }),
        );
      }

      const events = await store.readRuntimeEvents('session-1', 'run-1');
      assert.equal(events[0]?.content?.kind, 'text');
      assert.equal(
        events[0]?.content?.kind === 'text' ? events[0].content.text : undefined,
        chunks.join(''),
      );

      const inspect = new DatabaseSync(dbPath);
      try {
        const snapshot = inspect
          .prepare('SELECT text_content FROM runtime_partial_snapshots')
          .get() as { text_content?: unknown };
        const segments = inspect
          .prepare(`
            SELECT segment_seq, length(CAST(text_content AS BLOB)) AS stored_bytes
            FROM runtime_partial_segments
            ORDER BY segment_seq ASC
          `)
          .all()
          .map((row) => ({ ...row }));
        assert.equal(snapshot.text_content, '');
        assert.deepEqual(segments, [
          { segment_seq: 1, stored_bytes: 40 * 1024 },
          { segment_seq: 2, stored_bytes: 40 * 1024 + 1 },
        ]);
      } finally {
        inspect.close();
      }
    });
  });

  it('rejects a partial batch that crosses presentation streams atomically', async () => {
    await withStore(async (store) => {
      const partial = (id: string, providerEventId: string, text: string): RuntimeEvent =>
        functionCallEvent({
          id,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text },
          refs: { providerEventId },
        });
      await assert.rejects(
        store.appendRuntimePartialBatch('session-1', 'run-1', [
          partial('partial-1', 'message-1', 'a'),
          partial('partial-2', 'message-2', 'b'),
        ]),
        /exactly one presentation stream/,
      );
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), []);
    });
  });

  it('rejects a physical immutable prefix with an event-seq gap', async () => {
    await withStore(async (store, dbPath) => {
      for (let eventSeq = 1; eventSeq <= 3; eventSeq += 1) {
        await store.appendRuntimeEvent(
          'session-1',
          'run-1',
          functionCallEvent({
            id: `event-${eventSeq}`,
            ts: eventSeq,
            role: 'user',
            author: 'user',
            content: { kind: 'text', text: String(eventSeq) },
          }),
        );
      }
      store.close();
      const raw = new DatabaseSync(dbPath);
      try {
        raw.prepare('DELETE FROM runtime_events WHERE event_seq = 2').run();
      } finally {
        raw.close();
      }

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        await assert.rejects(
          reopened.readImmutableRuntimePrefix({
            sessionId: 'session-1',
            runId: 'run-1',
          }),
          /event_seq gap/,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it('replaces text and tool partial snapshots when their durable final arrives', async () => {
    await withStore(async (store, dbPath) => {
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'text-partial',
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'working' },
          refs: { providerEventId: 'message-1' },
        }),
      );
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'tool-partial',
          partial: true,
          role: 'tool',
          author: 'tool',
          content: undefined,
          refs: { toolCallId: 'provider-call-1' },
        }),
      );
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'text-final',
          ts: 2,
          partial: false,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'done' },
          refs: { providerEventId: 'message-1' },
        }),
      );
      await store.appendRuntimeEvent('session-1', 'run-1', functionCallEvent());
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionResponseEvent({
          refs: { toolCallId: 'provider-call-1' },
        }),
      );

      assert.deepEqual(
        (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['text-final', 'call-event-1', 'response-event-1'],
      );
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 3);
      const inspect = new DatabaseSync(dbPath);
      try {
        assert.equal(
          (
            inspect.prepare('SELECT count(*) AS count FROM runtime_partial_segments').get() as {
              count: number;
            }
          ).count,
          0,
        );
      } finally {
        inspect.close();
      }
    });
  });

  it('uses the immutable SQLite event as the steering-message recovery proof', async () => {
    await withStore(async (store) => {
      const steering = functionCallEvent({
        id: 'steering-event-1',
        content: { kind: 'text', text: 'steer', steering: true },
        refs: { providerEventId: 'message-steering' },
      });

      await store.appendRuntimeEvent('session-1', 'run-1', steering, { durable: true });
      await store.appendRuntimeEvent('session-1', 'run-1', steering, { durable: true });

      assert.deepEqual(
        await store.readImmutableSteeringMessageProof('session-1', 'message-steering'),
        { event: steering },
      );
      await store.repairImmutableSteeringMessageProofsForRecovery('session-1');
      await assert.rejects(
        store.appendRuntimeEvent(
          'session-1',
          'run-2',
          functionCallEvent({
            id: 'steering-event-conflict',
            invocationId: 'invocation-2',
            runId: 'run-2',
            turnId: 'turn-2',
            content: { kind: 'text', text: 'different', steering: true },
            refs: { providerEventId: 'message-steering' },
          }),
        ),
        /Immutable steering message identity conflict: message-steering/,
      );
      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-2'), []);
    });
  });
});

type Store = ReturnType<typeof createSqliteRuntimeStore>;

async function withStore(
  run: (
    store: Store,
    dbPath: string,
    setFailpoint: (point: SqliteRuntimeStoreFailpoint | undefined) => void,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-runtime-'));
  const dbPath = join(root, 'runtime.sqlite');
  let failpoint: SqliteRuntimeStoreFailpoint | undefined;
  const store = createSqliteRuntimeStore(dbPath, {
    failpoint: (point) => {
      if (failpoint === point) throw new Error(`sqlite runtime failpoint: ${point}`);
    },
  });
  try {
    await run(store, dbPath, (point) => {
      failpoint = point;
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function continuationClaim(
  input: Parameters<typeof continuationClaimForBoundary>[1] = {},
): ContinuationClaimV1 {
  const boundary = createRuntimeBoundaryCursor([runtimePrefixSegment(continuationSourcePrefix())]);
  return continuationClaimForBoundary(boundary, input);
}

function continuationClaimForBoundary(
  boundary: ContinuationClaimV1['boundary'],
  input: {
    claimId?: string;
    claimedAt?: number;
    target?: ContinuationClaimV1['target'];
  } = {},
): ContinuationClaimV1 {
  const source = boundary.segments.at(-1)!;
  const target =
    input.target ??
    ({
      sessionId: 'session-1',
      invocationId: 'invocation-2',
      runId: 'run-2',
      turnId: 'turn-2',
    } satisfies ContinuationClaimV1['target']);
  const claimId = input.claimId ?? 'claim-1';
  const claimedAt = input.claimedAt ?? 10;
  return {
    protocol: 'continuation_claim_v1',
    claimId,
    boundaryDigest: boundary.manifestDigest,
    boundary,
    providerProjectionVersion: 1,
    providerReplayDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    target,
    targetRunHeader: {
      ...target,
      status: 'created',
      backendKind: 'fake',
      llmConnectionSlug: 'connection-1',
      modelId: 'model-1',
      cwd: '/workspace/repo',
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      orchestrationSource: 'session',
      agentSwarmAuthorization: 'none',
      createdAt: claimedAt,
      updatedAt: claimedAt,
      parentRunId: source.identity.runId,
      parentTurnId: source.identity.turnId,
      continuationSource: {
        protocol: 'continuation_source_v2',
        claimId,
        boundaryDigest: boundary.manifestDigest,
        sourceInvocationId: source.identity.invocationId,
        sourceRunId: source.identity.runId,
        sourceTurnId: source.identity.turnId,
        sourceRuntimeEventHighWater: source.position.lastEventSeq,
        sourcePrefixDigest: source.prefixDigest,
        replayManifestDigest: boundary.manifestDigest,
      },
    },
    claimedAt,
  };
}

function continuationSourcePrefix(): ImmutableRuntimePrefixV1 {
  return buildImmutableRuntimePrefix(
    {
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      runId: 'run-1',
      turnId: 'turn-1',
    },
    [
      ...activeContinuationSourcePrefix().events.map((event, index) => ({
        eventSeq: index + 1,
        event,
      })),
      {
        eventSeq: 2,
        event: functionCallEvent({
          id: 'source-terminal-1',
          ts: 2,
          content: undefined,
          role: 'system',
          author: 'system',
          status: 'failed',
          actions: { endInvocation: true },
        }),
      },
    ],
  );
}

function activeContinuationSourcePrefix(): ImmutableRuntimePrefixV1 {
  return buildImmutableRuntimePrefix(
    {
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      runId: 'run-1',
      turnId: 'turn-1',
    },
    [
      {
        eventSeq: 1,
        event: functionCallEvent({
          id: 'source-user-1',
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue this interrupted Run' },
        }),
      },
    ],
  );
}

async function persistImmutablePrefix(
  store: Store,
  prefix: ImmutableRuntimePrefixV1,
): Promise<void> {
  for (const runtimeEvent of prefix.events) {
    await store.appendRuntimeEvent(prefix.identity.sessionId, prefix.identity.runId, runtimeEvent);
  }
}

function continuationStartEvent(
  claim: ContinuationClaimV1,
  overrides: {
    id?: string;
    provenance?: 'runtime_admission' | 'claim_repair';
    toolBoundaryProtocol?: 't1_after_preflight_v1';
  } = {},
): RuntimeEvent {
  const source = claim.boundary.segments.at(-1)!;
  return {
    id: overrides.id ?? 'continuation-start-1',
    ...claim.target,
    ts: 12,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      ...(overrides.toolBoundaryProtocol
        ? { runtimeProtocol: { toolBoundary: overrides.toolBoundaryProtocol } }
        : {}),
      continuationStart: {
        protocol: 'continuation_start_v2',
        provenance: overrides.provenance ?? 'runtime_admission',
        claimId: claim.claimId,
        boundaryDigest: claim.boundaryDigest,
        immediateSource: {
          sessionId: source.identity.sessionId,
          invocationId: source.identity.invocationId,
          runId: source.identity.runId,
          turnId: source.identity.turnId,
          highWater: source.position.lastEventSeq,
          prefixDigest: source.prefixDigest,
        },
        replayManifestDigest: claim.boundary.manifestDigest,
        providerProjectionVersion: claim.providerProjectionVersion,
        providerReplayDigest: claim.providerReplayDigest,
      },
    },
  };
}

function functionCallEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'call-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: 'provider-call-1',
      name: 'Read',
      args: { path: '/workspace/repo/README.md' },
    },
    ...overrides,
  };
}

function functionResponseEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'response-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 2,
    partial: false,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'provider-call-1',
      name: 'Read',
      result: 'contents',
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
    ...overrides,
  };
}

function toolDispatchEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'dispatch-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 10,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: READ_ARGS_HASH,
        recoveryMode: 'replay_safe',
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
    ...overrides,
  };
}

function commitPrepared(store: Store) {
  return store.commitToolPrepared({
    operationId: 'operation-1',
    journalEventId: 'operation-1_prepared',
    runtimeEvent: functionCallEvent(),
    dispatchRuntimeEvent: toolDispatchEvent(),
    providerToolCallId: 'provider-call-1',
    toolName: 'Read',
    canonicalArgsHash: READ_ARGS_HASH,
    recoveryMode: 'replay_safe',
    committedAt: 10,
  });
}

const READ_ARGS_HASH = canonicalToolArgsHash('Read', {
  path: '/workspace/repo/README.md',
});
const DIFFERENT_READ_ARGS_HASH = canonicalToolArgsHash('Read', {
  path: '/workspace/repo/OTHER.md',
});
