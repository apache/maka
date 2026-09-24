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
import { DEFAULT_TOOL_MODE } from '@maka/core/tool-mode';
import { decodeRuntimeEvent, type RuntimeEvent } from '@maka/core/runtime-event';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import { RunSealedError } from '@maka/core/runtime-event-store';
import { buildInvocationOpenedEvent } from '@maka/core/runtime-invocation';
import { readLogicalRuntimeExecution } from '@maka/core/runtime-logical-execution';
import {
  RuntimeTranscriptOversizedTurnError,
  RuntimeTranscriptQuery,
} from '../runtime-transcript-query.js';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import {
  acquireOperationalStateDatabase,
  resolveOperationalStateDatabasePath,
} from '../operational-state-store.js';
import { createConversationOperationalStateStore } from '../conversation-operational-state.js';
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
  type SqliteRuntimeStoreOptions,
} from '../sqlite-runtime-store.js';

const PREFIX_PROOF_TEST_BUDGET = {
  maxEvents: 64,
  maxBytes: 1024 * 1024,
  maxRecordBytes: 256 * 1024,
};

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
    await withStore(async (store, dbPath) => {
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

  it('loads full recovery payloads only for unfinished and handoff invocations', async () => {
    await withStore(async (store, dbPath) => {
      await appendSettledTurn(store, 1);
      await store.appendRuntimeEvent('session-1', 'run-2', invocationOpeningEvent(2));
      await store.appendRuntimeEvent('session-1', 'run-3', invocationOpeningEvent(3));
      await store.appendRuntimeEvent('session-1', 'run-3', {
        id: 'terminal-3',
        sessionId: 'session-1',
        invocationId: 'invocation-3',
        runId: 'run-3',
        turnId: 'turn-3',
        ts: 32,
        partial: false,
        role: 'system',
        author: 'host',
        actions: {
          endInvocation: true,
          handoffPause: {
            protocol: 'runtime_handoff_pause_v1',
            handoffId: 'handoff-3',
            remainingSteps: null,
            hostEpoch: 'host-1',
            rootRunId: 'run-3',
            successorRunId: 'run-4',
            successorInvocationId: 'invocation-4',
            claimId: 'claim-3',
          },
        },
      });
      const ambiguousOpening = invocationOpeningEvent(4);
      await store.appendRuntimeEvent('session-1', 'run-4', {
        ...ambiguousOpening,
        invocationId: 'transcript-ordinary-invocation',
      });
      await store.appendRuntimeEvent('session-1', 'run-4', {
        id: 'terminal-4',
        sessionId: 'session-1',
        invocationId: 'transcript-ordinary-invocation',
        runId: 'run-4',
        turnId: 'turn-4',
        ts: 42,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      });

      const database = new DatabaseSync(dbPath);
      try {
        assert.equal(
          (
            database
              .prepare('SELECT event_kind FROM runtime_events WHERE event_id = ?')
              .get('terminal-3') as { event_kind: string }
          ).event_kind,
          'invocation_end',
          'the cheap handoff discriminator must remain implied by the protocol shape',
        );
        const plan = database
          .prepare(`
            EXPLAIN QUERY PLAN
            WITH selected(session_id) AS (SELECT value FROM json_each(?))
            SELECT
              opening.rowid,
              opening.session_id,
              opening.invocation_id,
              (
                SELECT terminal.rowid
                FROM runtime_events AS terminal INDEXED BY runtime_events_terminal
                WHERE terminal.invocation_id = opening.invocation_id
                  AND (
                    json_valid(terminal.payload_json)
                    AND (
                      json_extract(terminal.payload_json, '$.actions.endInvocation') = 1
                      OR json_extract(terminal.payload_json, '$.status')
                        IN ('completed', 'failed', 'aborted', 'cancelled')
                    )
                  )
                ORDER BY terminal.event_seq
                LIMIT 1
              ) AS terminal_rowid
            FROM selected
            JOIN runtime_events AS opening INDEXED BY runtime_events_by_session_kind
              ON opening.session_id = selected.session_id
              AND opening.event_kind = 'invocation_opened'
          `)
          .all(JSON.stringify(['session-1'])) as Array<{ detail: string }>;
        assert.ok(
          plan.some((row) =>
            row.detail.includes(
              'SEARCH opening USING COVERING INDEX runtime_events_by_session_kind',
            ),
          ),
          `recovery inventory must identify obligations without opening payload pages: ${JSON.stringify(plan)}`,
        );
        database
          .prepare("UPDATE runtime_events SET payload_json = '{' WHERE event_id = ?")
          .run('opened-1');
      } finally {
        database.close();
      }

      const inventory = await store.listInvocationRecoveryInventory(['session-1']);
      assert.deepEqual(
        inventory.map((entry) => ({
          invocationId: entry.invocationId,
          candidate: entry.candidate?.invocationId ?? null,
          identityRunId: entry.identity?.runId ?? null,
          terminalId: entry.candidate?.terminalEvent?.id ?? null,
        })),
        [
          {
            invocationId: 'invocation-1',
            candidate: null,
            identityRunId: null,
            terminalId: null,
          },
          {
            invocationId: 'invocation-2',
            candidate: 'invocation-2',
            identityRunId: null,
            terminalId: null,
          },
          {
            invocationId: 'invocation-3',
            candidate: 'invocation-3',
            identityRunId: null,
            terminalId: 'terminal-3',
          },
          {
            invocationId: 'transcript-ordinary-invocation',
            candidate: null,
            identityRunId: 'run-4',
            terminalId: null,
          },
        ],
      );
    });
  });

  it('bounds a transcript Turn by stored total and per-record bytes', async () => {
    await withStore(async (store) => {
      const run = {
        sessionId: 'session-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
      };
      await store.appendRuntimeEvent(
        run.sessionId,
        run.runId,
        buildInvocationOpenedEvent({
          id: 'oversized-opening',
          run,
          openedAt: 1,
          opening: {
            kind: 'invocation_opened',
            protocol: 'invocation_opened_v1',
            route: {
              provenance: 'runtime',
              backendKind: 'fake',
              llmConnectionId: 'fake-connection',
              llmConnectionSlug: 'fake',
              modelId: 'fake-model',
            },
            configuration: {
              cwd: '/tmp',
              permissionMode: 'ask',
              collaborationMode: 'agent',
              orchestrationMode: 'default',
              orchestrationSource: 'session',
              toolMode: DEFAULT_TOOL_MODE,
            },
            root: { kind: 'user' },
            source: { kind: 'fresh' },
          },
        }),
      );
      // Every character here is three stored bytes, so a budget read as UTF-16
      // code units admits a Turn three times the size it was asked to bound.
      const text = '本'.repeat(4_000);
      await store.appendRuntimeEvent(run.sessionId, run.runId, {
        id: 'oversized-prompt',
        ...run,
        ts: 2,
        partial: false,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text },
      });
      await store.appendRuntimeEvent(run.sessionId, run.runId, {
        id: 'oversized-terminal',
        ...run,
        ts: 3,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      });

      const request = {
        direction: 'newer' as const,
        throughOrdinal: Number.MAX_SAFE_INTEGER,
        position: 1,
        maxEvents: 64,
        maxRecordBytes: 64_000,
      };
      await assert.rejects(
        store.readTranscriptRun(run.sessionId, { ...request, maxBytes: 6_000 }, (_run, events) => [
          ...events,
        ]),
        (error: unknown) => error instanceof RuntimeTranscriptOversizedTurnError,
      );
      await assert.rejects(
        store.readTranscriptRun(
          run.sessionId,
          { ...request, maxBytes: 64_000, maxRecordBytes: 6_000 },
          (_run, events) => [...events],
        ),
        (error: unknown) => error instanceof RuntimeTranscriptOversizedTurnError,
      );
      await assert.rejects(
        store.readTranscriptRun(
          run.sessionId,
          { ...request, maxEvents: 2, maxBytes: 64_000 },
          (_run, events) => [...events],
        ),
        (error: unknown) => error instanceof RuntimeTranscriptOversizedTurnError,
      );
      const served = await store.readTranscriptRun(
        run.sessionId,
        { ...request, maxBytes: 64_000 },
        (_run, events) => [...events],
      );
      assert.equal(served?.length, 3);
    });
  });

  it('projects transcript RuntimeEvents from a bounded row iterator', async () => {
    await withStore(async (store) => {
      await appendSettledTurn(store, 1);

      const projected = await store.readTranscriptRun(
        'session-1',
        {
          direction: 'newer',
          throughOrdinal: Number.MAX_SAFE_INTEGER,
          position: 1,
          maxEvents: 3,
          maxBytes: 64_000,
          maxRecordBytes: 32_000,
        },
        (run, events) => {
          assert.equal(Array.isArray(events), false);
          return {
            invocationId: run.invocation.invocationId,
            firstOrdinal: run.firstOrdinal,
            lastOrdinal: run.lastOrdinal,
            rows: [...events].map(({ ordinal, event }) => ({ ordinal, eventId: event.id })),
          };
        },
      );

      assert.deepEqual(projected, {
        invocationId: 'invocation-1',
        firstOrdinal: 1,
        // The Session holds nothing after this Turn, so its run reaches the
        // read's own bound rather than stopping at another Turn's first event.
        lastOrdinal: Number.MAX_SAFE_INTEGER,
        rows: [
          { ordinal: 1, eventId: 'opened-1' },
          { ordinal: 2, eventId: 'prompt-1' },
          { ordinal: 3, eventId: 'terminal-1' },
        ],
      });
    });
  });

  it('pages the transcript without reading rows the page does not contain', async () => {
    await withStore(async (store, dbPath) => {
      for (let turn = 0; turn < 4; turn += 1) await appendSettledTurn(store, turn);
      store.close();
      const db = new DatabaseSync(dbPath);
      try {
        const executed: { sql: string; bind: unknown[] }[] = [];
        const query = new RuntimeTranscriptQuery(
          watchStatements(db, executed),
          () =>
            ({
              sessionId: 'session-1',
            }) as unknown as RuntimeInvocationRecord,
        );
        const request = {
          throughOrdinal: Number.MAX_SAFE_INTEGER,
          position: 6,
          maxEvents: 64,
          maxBytes: 64_000,
          maxRecordBytes: 64_000,
        };
        query.highWater('session-1');
        query.run('session-1', { ...request, direction: 'older' }, (_run, events) => [...events]);
        query.run('session-1', { ...request, direction: 'newer' }, (_run, events) => [...events]);
        // A full scan is how a page starts costing the Session it sits in: the
        // rows it walks are every Turn's, not the page's.
        for (const { sql, bind } of executed) {
          const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(bind as [])) as unknown as {
            detail: string;
          }[];
          const scans = plan.filter((step) => step.detail.startsWith('SCAN'));
          assert.deepEqual(scans, [], `${scans[0]?.detail} in ${sql}`);
        }
      } finally {
        db.close();
      }
    });
  });

  it('reads recovery message evidence by Turn and exact identity without scanning the Session', async () => {
    await withStore(async (store, dbPath) => {
      const prompt = functionCallEvent({
        id: 'recovery-prompt',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: '恢复这条提示' },
      });
      const exact = functionCallEvent({
        id: 'recovery-exact-tool-call',
        invocationId: 'invocation-2',
        runId: 'run-2',
        turnId: 'turn-2',
      });
      const unrelated = functionCallEvent({
        id: 'recovery-unrelated',
        invocationId: 'invocation-3',
        runId: 'run-3',
        turnId: 'turn-3',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'cold history' },
      });
      const steering = functionCallEvent({
        id: 'recovery-steering',
        invocationId: 'invocation-4',
        runId: 'run-4',
        turnId: 'turn-4',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'steer', steering: true },
        refs: { providerEventId: 'recovery-steering-message' },
      });
      const foreignExact = functionCallEvent({
        id: 'recovery-foreign-exact',
        sessionId: 'session-2',
        invocationId: 'foreign-invocation',
        runId: 'foreign-run',
        turnId: 'foreign-turn',
      });
      const sameTurnModelText = functionCallEvent({
        id: 'recovery-model-text',
        ts: 2,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'cold model body' },
      });
      const sameTurnSteering = functionCallEvent({
        id: 'recovery-same-turn-steering',
        ts: 3,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'not the prompt', steering: true },
        refs: { providerEventId: 'recovery-same-turn-steering-message' },
      });
      for (const event of [
        prompt,
        sameTurnModelText,
        sameTurnSteering,
        exact,
        foreignExact,
        unrelated,
        steering,
      ]) {
        await store.appendRuntimeEvent(event.sessionId, event.runId, event);
      }

      const query = {
        sessionId: 'session-1',
        turnIds: ['turn-1', 'turn-1'],
        eventIds: [
          'recovery-exact-tool-call',
          'recovery-exact-tool-call',
          'recovery-foreign-exact',
        ],
      };
      const evidence = await store.readRecoveryMessageEvents({
        ...query,
        budget: { maxRecords: 4, maxBytes: 64 * 1024 },
      });
      assert.equal(evidence.status, 'complete');
      if (evidence.status !== 'complete') throw new Error('expected recovery message evidence');
      assert.deepEqual(
        evidence.records.map((event) => event.id),
        ['recovery-prompt', 'recovery-exact-tool-call'],
      );
      assert.equal(evidence.sourceRecordCount, 2);
      assert.ok(evidence.storedBytes > Buffer.byteLength('恢复这条提示', 'utf8'));
      assert.deepEqual(
        await store.readRecoveryMessageEvents({
          ...query,
          budget: { maxRecords: 4, maxBytes: 1 },
        }),
        { status: 'limit_exceeded' },
      );

      const inspect = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const turnPlan = inspect
          .prepare(`
            EXPLAIN QUERY PLAN
            SELECT event_id
              FROM runtime_events
             WHERE session_id = ?
               AND turn_id IN (?)
               AND event_kind = 'text'
               AND CASE
                 WHEN json_valid(payload_json)
                 THEN json_extract(payload_json, '$.partial')
               END = 0
               AND CASE
                 WHEN json_valid(payload_json)
                 THEN json_extract(payload_json, '$.role')
               END = 'user'
               AND coalesce(CASE
                 WHEN json_valid(payload_json)
                 THEN json_extract(payload_json, '$.content.steering')
               END, 0) = 0
          `)
          .all('session-1', 'turn-1') as Array<{ detail: string }>;
        assert.ok(
          turnPlan.some((step) =>
            step.detail.includes('USING COVERING INDEX runtime_events_recovery_user_message'),
          ),
          JSON.stringify(turnPlan),
        );

        const exactPlan = inspect
          .prepare(`
            EXPLAIN QUERY PLAN
            SELECT event_id
              FROM runtime_events
             WHERE event_id IN (?)
          `)
          .all('recovery-exact-tool-call') as Array<{ detail: string }>;
        assert.ok(
          exactPlan.some(
            (step) => step.detail.startsWith('SEARCH') && step.detail.includes('event_id=?'),
          ),
          JSON.stringify(exactPlan),
        );

        const steeringPlan = inspect
          .prepare(`
            EXPLAIN QUERY PLAN
            SELECT event_id
              FROM runtime_events
             WHERE session_id = ?
               AND event_kind = 'text'
               AND CASE
                 WHEN json_valid(payload_json)
                 THEN json_extract(payload_json, '$.partial')
               END = 0
               AND CASE
                 WHEN json_valid(payload_json)
                 THEN json_extract(payload_json, '$.content.steering')
               END = 1
               AND CASE
                 WHEN json_valid(payload_json)
                 THEN json_extract(payload_json, '$.refs.providerEventId')
               END = ?
          `)
          .all('session-1', 'recovery-steering-message') as Array<{ detail: string }>;
        assert.ok(
          steeringPlan.some((step) => step.detail.includes('runtime_events_steering_message')),
          JSON.stringify(steeringPlan),
        );
      } finally {
        inspect.close();
      }
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
  it('publishes RuntimeEvent commits once, after a committed transaction', async () => {
    await withStore(async (store) => {
      const commits: string[] = [];
      store.subscribeRuntimeEventCommits((sessionId) => commits.push(sessionId));
      const first = textEvent('batch-1');
      const second = textEvent('batch-2');
      await assert.rejects(
        store.importRuntimeEventsBatch({
          sessionId: first.sessionId,
          runId: first.runId,
          events: [first, { ...first, ts: 99 }],
        }),
      );
      assert.deepEqual(await store.readSessionRuntimeEventEntries('session-1'), []);
      assert.deepEqual(commits, []);
      await store.importRuntimeEventsBatch({
        sessionId: first.sessionId,
        runId: first.runId,
        events: [first, second],
      });
      assert.deepEqual(commits, ['session-1']);
    });
  });

  it('publishes leased RuntimeEvent commits when the outermost transaction settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-runtime-lease-'));
    const outer = acquireOperationalStateDatabase(root);
    const store = createSqliteRuntimeStore(resolveOperationalStateDatabasePath(root), {
      databaseLease: acquireOperationalStateDatabase(root),
    });
    try {
      const commits: string[] = [];
      store.subscribeRuntimeEventCommits((sessionId) => commits.push(sessionId));
      const appends: Promise<void>[] = [];
      assert.throws(() =>
        outer.transaction('write', () => {
          appends.push(store.appendRuntimeEvent('session-1', 'run-1', textEvent('lost')));
          throw new Error('roll back');
        }),
      );
      await Promise.all(appends);
      assert.deepEqual(commits, []);
      assert.deepEqual(await store.readSessionRuntimeEventEntries('session-1'), []);

      outer.transaction('write', () => {
        for (const id of ['kept-1', 'kept-2']) {
          appends.push(store.appendRuntimeEvent('session-1', 'run-1', textEvent(id)));
        }
        assert.deepEqual(commits, []);
      });
      assert.deepEqual(commits, ['session-1']);
      await Promise.all(appends);
    } finally {
      store.close();
      outer.close();
      await rm(root, { recursive: true, force: true });
    }
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

  it('invalidates a warmed tool-ledger cache after a same-connection conversation copy', async () => {
    await withStore(async (store) => {
      const outcome = functionResponseEvent({ ts: 11 });
      const orphan = functionResponseEvent({
        id: 'cache-warming-orphan',
        ts: 10,
        refs: { toolCallId: 'provider-call-1' },
      });
      await assert.rejects(
        store.appendRuntimeEvent(orphan.sessionId, orphan.runId, orphan),
        (error: unknown) =>
          error instanceof ToolLedgerRejectionError && error.code === 'orphan_response',
      );

      await store.importConversationCopyRuntimeEvents(outcome.sessionId, [
        {
          runId: outcome.runId,
          events: [functionCallEvent(), toolDispatchEvent(), outcome],
        },
      ]);

      assert.deepEqual(
        await store.commitToolOutcome({
          operationId: 'operation-1',
          journalEventId: 'operation-1_outcome',
          runtimeEvent: outcome,
          committedAt: 20,
        }),
        { created: false, runtimeEventSeq: 3 },
      );
    });
  });

  it('rebuilds a legacy terminal-without-tool-result gap as interrupted_unknown', async () => {
    await withStore(async (store) => {
      await commitPreparedInvocation(store, 0);
      const identity = cacheInvocationIdentity(0);
      await store.importRuntimeEventsBatch({
        sessionId: identity.sessionId,
        runId: identity.runId,
        events: [
          {
            id: 'cache-terminal-0',
            ...identity,
            ts: 4,
            partial: false,
            role: 'system',
            author: 'system',
            status: 'failed',
            actions: { endInvocation: true },
          },
        ],
      });

      await store.rebuildToolProjectionsFromRuntimeEvents();

      assert.equal(
        (await store.readToolOperation('cache-operation-0'))?.currentState,
        'interrupted_unknown',
      );
      assert.deepEqual(
        (await store.readToolJournal('cache-operation-0')).map((event) => event.state),
        ['prepared', 'interrupted_unknown'],
      );
      assert.equal((await store.listUnsettledToolOperations(identity.sessionId)).length, 0);
    });
  });

  it('repairs a terminal unsettled tool without decoding opaque Session history', async () => {
    await withStore(async (store, dbPath) => {
      await commitPreparedInvocation(store, 0);
      const identity = cacheInvocationIdentity(0);
      const secondArgs = { path: '/workspace/cache-0-second.txt' };
      const secondArgsHash = canonicalToolArgsHash('Read', secondArgs);
      await store.commitToolPrepared({
        operationId: 'cache-operation-0-second',
        journalEventId: 'cache-operation-0-second_prepared',
        runtimeEvent: functionCallEvent({
          id: 'cache-call-0-second',
          ...identity,
          ts: 3,
          content: {
            kind: 'function_call',
            id: 'cache-tool-call-0-second',
            name: 'Read',
            args: secondArgs,
          },
        }),
        dispatchRuntimeEvent: toolDispatchEvent({
          id: 'cache-dispatch-0-second',
          ...identity,
          ts: 4,
          actions: {
            toolDispatch: {
              protocol: 't1_after_preflight_v1',
              operationId: 'cache-operation-0-second',
              providerToolCallId: 'cache-tool-call-0-second',
              toolName: 'Read',
              canonicalArgsHash: secondArgsHash,
              recoveryMode: 'replay_safe',
            },
          },
          refs: { operationId: 'cache-operation-0-second', toolCallId: 'cache-tool-call-0-second' },
        }),
        providerToolCallId: 'cache-tool-call-0-second',
        toolName: 'Read',
        canonicalArgsHash: secondArgsHash,
        recoveryMode: 'replay_safe',
        committedAt: 4,
      });
      await store.importRuntimeEventsBatch({
        sessionId: identity.sessionId,
        runId: identity.runId,
        events: [
          {
            id: 'cache-terminal-0',
            ...identity,
            ts: 4,
            partial: false,
            role: 'system',
            author: 'system',
            status: 'failed',
            actions: { endInvocation: true },
          },
        ],
      });
      await store.importRuntimeEventsBatch({
        sessionId: identity.sessionId,
        runId: 'legacy-run',
        events: [
          {
            id: 'opaque-legacy-event',
            invocationId: 'legacy-invocation',
            runId: 'legacy-run',
            sessionId: identity.sessionId,
            turnId: 'legacy-turn',
            ts: 5,
            partial: false,
            role: 'system',
            author: 'system',
            content: { kind: 'text', text: 'preserve this event' },
          },
        ],
      });
      store.close();

      const raw = new DatabaseSync(dbPath);
      let legacyPayload = '';
      try {
        const event = raw
          .prepare('SELECT payload_json FROM runtime_events WHERE event_id = ?')
          .get('opaque-legacy-event') as { payload_json: string };
        legacyPayload = `${event.payload_json.slice(0, -1)},"legacyBytePreserved":true}`;
        assert.throws(
          () => decodeRuntimeEvent(JSON.parse(legacyPayload) as unknown),
          /Invalid RuntimeEvent schema/,
        );
        raw
          .prepare('UPDATE runtime_events SET payload_json = ? WHERE event_id = ?')
          .run(legacyPayload, 'opaque-legacy-event');
      } finally {
        raw.close();
      }

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        await reopened.rebuildTerminalToolProjectionsForSessions([identity.sessionId]);
        assert.equal(
          (await reopened.readToolOperation('cache-operation-0'))?.currentState,
          'interrupted_unknown',
        );
        assert.deepEqual(
          (await reopened.readToolJournal('cache-operation-0')).map(({ state }) => state),
          ['prepared', 'interrupted_unknown'],
        );
        assert.equal(
          (await reopened.readToolOperation('cache-operation-0-second'))?.currentState,
          'interrupted_unknown',
        );
        assert.deepEqual(
          (await reopened.readToolJournal('cache-operation-0-second')).map(({ state }) => state),
          ['prepared', 'interrupted_unknown'],
        );
        const retained = new DatabaseSync(dbPath, { readOnly: true });
        try {
          assert.equal(
            (
              retained
                .prepare('SELECT payload_json FROM runtime_events WHERE event_id = ?')
                .get('opaque-legacy-event') as { payload_json: string }
            ).payload_json,
            legacyPayload,
          );
        } finally {
          retained.close();
        }
      } finally {
        reopened.close();
      }
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

  it('isolates unrelated ledger damage while keeping the damaged invocation fail-closed', async () => {
    await withStore(async (store, dbPath) => {
      store.close();

      // Seed damage the store would never have written itself, in a session
      // this run never touches. Scoped validation must not turn it into a
      // workspace-wide write outage.
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
        await reopened.appendRuntimeEvent(healthy.sessionId, healthy.runId, healthy);
        assert.deepEqual(
          await reopened.readImmutableRuntimeEvents(healthy.sessionId, healthy.runId),
          [healthy],
        );

        // The hot write path is closure-scoped. Explicit projection rebuild is
        // the maintenance owner for auditing every invocation in the workspace.
        await assert.rejects(
          reopened.rebuildToolProjectionsFromRuntimeEvents(),
          /Corrupt tool RuntimeEvent ledger: orphan_response at stranded-response/,
        );

        const related = functionCallEvent({
          id: 'related-call',
          sessionId: stranded.sessionId,
          invocationId: stranded.invocationId,
          runId: stranded.runId,
          turnId: stranded.turnId,
        });
        await assert.rejects(
          reopened.appendRuntimeEvent(related.sessionId, related.runId, related),
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
    await withStore(async (store, dbPath) => {
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

      const database = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const plan = database
          .prepare(`
            EXPLAIN QUERY PLAN
            SELECT call_event.session_id,
              tool_operations.operation_id, tool_operations.invocation_id,
              tool_operations.run_id, tool_operations.turn_id,
              tool_operations.provider_tool_call_id, tool_operations.tool_name,
              tool_operations.canonical_args_hash, tool_operations.recovery_mode,
              tool_operations.current_state, tool_operations.call_event_id,
              tool_operations.dispatch_event_id, tool_operations.result_event_id,
              tool_operations.version
            FROM tool_operations
            JOIN runtime_events AS call_event
              ON call_event.event_id = tool_operations.call_event_id
            WHERE tool_operations.current_state = 'prepared'
              AND tool_operations.result_event_id IS NULL
              AND tool_operations.dispatch_event_id IS NOT NULL
            ORDER BY tool_operations.invocation_id ASC, tool_operations.operation_id ASC
          `)
          .all() as Array<{ detail: string }>;
        assert.ok(
          plan.some((row) => row.detail.includes('tool_operations_unsettled')),
          `unsettled recovery query must avoid historical tool-operation pages: ${JSON.stringify(plan)}`,
        );
      } finally {
        database.close();
      }
    });
  });

  it('commits nested T1 events with parent operation linkage', async () => {
    await withStore(async (store, dbPath) => {
      const parentRefs = {
        parentToolCallId: 'exec-call-1',
        parentOperationId: 'exec-operation-1',
      } as const;
      const parentCall = functionCallEvent({
        id: 'exec-call-event',
        invocationId: 'exec-invocation',
        runId: 'exec-run',
        turnId: 'exec-turn',
        content: {
          kind: 'function_call',
          id: parentRefs.parentToolCallId,
          name: 'Read',
          args: { path: '/workspace/repo/README.md' },
        },
      });
      const parentDispatch = toolDispatchEvent({
        id: 'exec-dispatch-event',
        invocationId: 'exec-invocation',
        runId: 'exec-run',
        turnId: 'exec-turn',
        actions: {
          toolDispatch: {
            protocol: 't1_after_preflight_v1',
            operationId: parentRefs.parentOperationId,
            providerToolCallId: parentRefs.parentToolCallId,
            toolName: 'Read',
            canonicalArgsHash: READ_ARGS_HASH,
            recoveryMode: 'replay_safe',
          },
        },
        refs: {
          operationId: parentRefs.parentOperationId,
          toolCallId: parentRefs.parentToolCallId,
        },
      });
      await store.commitToolPrepared({
        operationId: parentRefs.parentOperationId,
        journalEventId: 'exec-operation-1_prepared',
        runtimeEvent: parentCall,
        dispatchRuntimeEvent: parentDispatch,
        providerToolCallId: parentRefs.parentToolCallId,
        toolName: 'Read',
        canonicalArgsHash: READ_ARGS_HASH,
        recoveryMode: 'replay_safe',
        committedAt: 5,
      });
      const inspect = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const plan = inspect
          .prepare(`
            EXPLAIN QUERY PLAN
            SELECT DISTINCT invocation_id
              FROM runtime_events
             WHERE event_kind = 'tool_dispatch'
               AND CASE
                 WHEN json_valid(payload_json)
                 THEN json_extract(payload_json, '$.actions.toolDispatch.operationId')
               END IN (?)
          `)
          .all(parentRefs.parentOperationId) as Array<{ detail: string }>;
        assert.ok(
          plan.some((step) => step.detail.includes('runtime_events_tool_dispatch_operation')),
          JSON.stringify(plan),
        );
      } finally {
        inspect.close();
      }
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

  it('invalidates scoped tool caches across sibling write-view commit and rollback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tool-cache-rollback-'));
    const outer = acquireOperationalStateDatabase(root);
    const parentWriter = createSqliteRuntimeStore(resolveOperationalStateDatabasePath(root), {
      databaseLease: acquireOperationalStateDatabase(root),
    });
    const purge = createConversationOperationalStateStore(root);
    let store: Store | undefined;
    const identity = {
      sessionId: 'rollback-cache-session',
      invocationId: 'rollback-cache-invocation',
      runId: 'rollback-cache-run',
      turnId: 'rollback-cache-turn',
    } as const;
    const parentRefs = {
      operationId: 'rollback-cache-parent-operation',
      toolCallId: 'rollback-cache-parent-call',
    } as const;
    const parentCall = functionCallEvent({
      id: 'rollback-cache-parent-call-event',
      ...identity,
      content: {
        kind: 'function_call',
        id: parentRefs.toolCallId,
        name: 'Read',
        args: { path: '/workspace/repo/README.md' },
      },
    });
    const parentDispatch = toolDispatchEvent({
      id: 'rollback-cache-parent-dispatch-event',
      ...identity,
      actions: {
        toolDispatch: {
          protocol: 't1_after_preflight_v1',
          operationId: parentRefs.operationId,
          providerToolCallId: parentRefs.toolCallId,
          toolName: 'Read',
          canonicalArgsHash: READ_ARGS_HASH,
          recoveryMode: 'replay_safe',
        },
      },
      refs: {
        operationId: parentRefs.operationId,
        toolCallId: parentRefs.toolCallId,
      },
    });
    const childRefs = {
      operationId: 'rollback-cache-child-operation',
      toolCallId: 'rollback-cache-child-call',
      parentOperationId: parentRefs.operationId,
      parentToolCallId: parentRefs.toolCallId,
    } as const;
    const childCall = functionCallEvent({
      id: 'rollback-cache-child-call-event',
      ...identity,
      ts: 20,
      content: {
        kind: 'function_call',
        id: childRefs.toolCallId,
        name: 'Read',
        args: { path: '/workspace/repo/README.md' },
      },
      refs: childRefs,
    });
    const childDispatch = toolDispatchEvent({
      id: 'rollback-cache-child-dispatch-event',
      ...identity,
      ts: 21,
      actions: {
        toolDispatch: {
          protocol: 't1_after_preflight_v1',
          operationId: childRefs.operationId,
          providerToolCallId: childRefs.toolCallId,
          toolName: 'Read',
          canonicalArgsHash: READ_ARGS_HASH,
          recoveryMode: 'replay_safe',
        },
      },
      refs: childRefs,
    });
    const childInput = {
      operationId: childRefs.operationId,
      journalEventId: `${childRefs.operationId}_prepared`,
      runtimeEvent: childCall,
      dispatchRuntimeEvent: childDispatch,
      providerToolCallId: childRefs.toolCallId,
      toolName: 'Read',
      canonicalArgsHash: READ_ARGS_HASH,
      recoveryMode: 'replay_safe',
      committedAt: 21,
    } as const;

    try {
      await parentWriter.commitToolPrepared({
        operationId: parentRefs.operationId,
        journalEventId: `${parentRefs.operationId}_prepared`,
        runtimeEvent: parentCall,
        dispatchRuntimeEvent: parentDispatch,
        providerToolCallId: parentRefs.toolCallId,
        toolName: 'Read',
        canonicalArgsHash: READ_ARGS_HASH,
        recoveryMode: 'replay_safe',
        committedAt: 10,
      });

      const committedPurges: Promise<void>[] = [];
      const committedAttempts: Promise<unknown>[] = [];
      outer.transaction('write', () => {
        committedPurges.push(purge.purge(identity.sessionId));
        committedAttempts.push(parentWriter.commitToolPrepared(childInput));
      });
      await Promise.all(committedPurges);
      await assert.rejects(
        committedAttempts[0]!,
        (error: unknown) =>
          error instanceof ToolLedgerRejectionError &&
          error.code === 'parent_operation_missing' &&
          error.eventId === childDispatch.id,
      );
      assert.equal(await parentWriter.readToolOperation(parentRefs.operationId), undefined);
      assert.equal(await parentWriter.readToolOperation(childRefs.operationId), undefined);

      await parentWriter.commitToolPrepared({
        operationId: parentRefs.operationId,
        journalEventId: `${parentRefs.operationId}_prepared`,
        runtimeEvent: parentCall,
        dispatchRuntimeEvent: parentDispatch,
        providerToolCallId: parentRefs.toolCallId,
        toolName: 'Read',
        canonicalArgsHash: READ_ARGS_HASH,
        recoveryMode: 'replay_safe',
        committedAt: 10,
      });
      parentWriter.close();
      store = createSqliteRuntimeStore(resolveOperationalStateDatabasePath(root), {
        databaseLease: acquireOperationalStateDatabase(root),
      });

      const purges: Promise<void>[] = [];
      const attempts: Promise<unknown>[] = [];
      assert.throws(
        () =>
          outer.transaction('write', () => {
            purges.push(purge.purge(identity.sessionId));
            attempts.push(store!.commitToolPrepared(childInput));
            throw new Error('roll back sibling write view');
          }),
        /roll back sibling write view/,
      );
      await Promise.all(purges);
      await assert.rejects(
        attempts[0]!,
        (error: unknown) =>
          error instanceof ToolLedgerRejectionError &&
          error.code === 'parent_operation_missing' &&
          error.eventId === childDispatch.id,
      );

      const retried = await store.commitToolPrepared(childInput);
      assert.equal(retried.created, true);
      assert.equal(
        (await store.readToolOperation(parentRefs.operationId))?.currentState,
        'prepared',
      );
    } finally {
      store?.close();
      parentWriter.close();
      purge.close();
      outer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('invalidates a lease-less reducer base loaded from a rolled-back transaction', async () => {
    await withStore(async (store) => {
      const identity = {
        sessionId: 'local-rollback-cache-session',
        invocationId: 'local-rollback-cache-invocation',
        runId: 'local-rollback-cache-run',
        turnId: 'local-rollback-cache-turn',
      } as const;
      const parentRefs = {
        operationId: 'local-rollback-parent-operation',
        toolCallId: 'local-rollback-parent-call',
      } as const;
      const parentCall = functionCallEvent({
        id: 'local-rollback-parent-call-event',
        ...identity,
        refs: parentRefs,
        content: {
          kind: 'function_call',
          id: parentRefs.toolCallId,
          name: 'Read',
          args: { path: '/workspace/repo/README.md' },
        },
      });
      const parentDispatch = toolDispatchEvent({
        id: 'local-rollback-parent-dispatch-event',
        ...identity,
        refs: parentRefs,
        actions: {
          toolDispatch: {
            protocol: 't1_after_preflight_v1',
            operationId: parentRefs.operationId,
            providerToolCallId: parentRefs.toolCallId,
            toolName: 'Read',
            canonicalArgsHash: READ_ARGS_HASH,
            recoveryMode: 'replay_safe',
          },
        },
      });
      const childRefs = {
        operationId: 'local-rollback-child-operation',
        toolCallId: 'local-rollback-child-call',
        parentOperationId: parentRefs.operationId,
        parentToolCallId: parentRefs.toolCallId,
      } as const;
      const childCall = functionCallEvent({
        id: 'local-rollback-child-call-event',
        ...identity,
        ts: 20,
        refs: childRefs,
        content: {
          kind: 'function_call',
          id: childRefs.toolCallId,
          name: 'Read',
          args: { path: '/workspace/repo/README.md' },
        },
      });
      const childDispatch = toolDispatchEvent({
        id: 'local-rollback-child-dispatch-event',
        ...identity,
        ts: 21,
        refs: childRefs,
        actions: {
          toolDispatch: {
            protocol: 't1_after_preflight_v1',
            operationId: childRefs.operationId,
            providerToolCallId: childRefs.toolCallId,
            toolName: 'Read',
            canonicalArgsHash: READ_ARGS_HASH,
            recoveryMode: 'replay_safe',
          },
        },
      });
      const internal = store as unknown as {
        transaction<T>(operation: () => T): T;
        insertRuntimeEvent(event: RuntimeEvent, committedAt: number, exact: boolean): number;
        assertToolLedgerTransition(
          candidateEvents: readonly RuntimeEvent[],
          expectedTransition: 't1_prepare',
        ): void;
      };

      assert.throws(
        () =>
          internal.transaction(() => {
            internal.insertRuntimeEvent(parentCall, 10, true);
            internal.insertRuntimeEvent(parentDispatch, 11, false);
            internal.assertToolLedgerTransition([childCall, childDispatch], 't1_prepare');
            throw new Error('roll back local write view');
          }),
        /roll back local write view/,
      );

      await assert.rejects(
        store.commitToolPrepared({
          operationId: childRefs.operationId,
          journalEventId: `${childRefs.operationId}_prepared`,
          runtimeEvent: childCall,
          dispatchRuntimeEvent: childDispatch,
          providerToolCallId: childRefs.toolCallId,
          toolName: 'Read',
          canonicalArgsHash: READ_ARGS_HASH,
          recoveryMode: 'replay_safe',
          committedAt: 21,
        }),
        (error: unknown) =>
          error instanceof ToolLedgerRejectionError &&
          error.code === 'parent_operation_missing' &&
          error.eventId === childDispatch.id,
      );
    });
  });

  it('bounds active tool reducer residency with least-recently-used eviction', async () => {
    await withStore(
      async (store) => {
        for (let index = 0; index < 4; index += 1) {
          assert.equal((await commitPreparedInvocation(store, index)).created, true);
        }
        assert.deepEqual(toolLedgerCacheSnapshot(store).seedInvocationIds, [
          'cache-invocation-1',
          'cache-invocation-2',
          'cache-invocation-3',
        ]);

        assert.equal((await commitOutcomeInvocation(store, 1)).created, true);
        assert.equal((await commitPreparedInvocation(store, 4)).created, true);

        const snapshot = toolLedgerCacheSnapshot(store);
        assert.deepEqual(snapshot.seedInvocationIds, [
          'cache-invocation-3',
          'cache-invocation-1',
          'cache-invocation-4',
        ]);
        assert.equal(snapshot.entries, 3);
        assert.ok(snapshot.events <= 12);
        assert.ok(snapshot.estimatedBytes <= 1024 * 1024);
        assert.equal(snapshot.metrics.hits, 1);
        assert.equal(snapshot.metrics.misses, 5);
        assert.equal(snapshot.metrics.budgetEvictions, 2);
      },
      {
        toolLedgerCacheBudget: {
          maxEntries: 3,
          maxEstimatedBytes: 1024 * 1024,
          maxSingleEntryEstimatedBytes: 1024 * 1024,
        },
      },
    );
  });

  it('routes nested-tool partial heartbeats to the partial stream, not the ledger', async () => {
    await withStore(async (store) => {
      const run = {
        sessionId: 'session-nested',
        invocationId: 'invocation-nested',
        runId: 'run-nested',
        turnId: 'turn-nested',
      };
      await store.appendRuntimeEvent(
        run.sessionId,
        run.runId,
        buildInvocationOpenedEvent({
          id: 'run-nested-invocation-opened',
          run,
          openedAt: 1,
          opening: {
            kind: 'invocation_opened',
            protocol: 'invocation_opened_v1',
            route: {
              provenance: 'runtime',
              backendKind: 'fake',
              llmConnectionId: 'fake-connection',
              llmConnectionSlug: 'fake',
              modelId: 'fake-model',
            },
            configuration: {
              cwd: '/tmp',
              permissionMode: 'ask',
              collaborationMode: 'agent',
              orchestrationMode: 'default',
              orchestrationSource: 'session',
              toolMode: DEFAULT_TOOL_MODE,
            },
            root: { kind: 'user' },
            source: { kind: 'fresh' },
          },
        }),
      );
      // Code Mode emits one of these per nested-tool progress tick: a
      // contentless tool heartbeat whose refs carry the nesting provenance
      // alongside the call it belongs to (apache/maka#5699).
      await store.appendRuntimeEvent(run.sessionId, run.runId, {
        id: 'nested-heartbeat-0',
        ...run,
        ts: 2,
        partial: true,
        role: 'tool',
        author: 'tool',
        origin: 'code_mode',
        modelVisibility: 'hidden',
        refs: {
          toolCallId: 'outer-call:nested:nested-call',
          parentToolCallId: 'outer-call',
          parentOperationId: 'outer-operation',
        },
      });
      const immutable = await store.readImmutableRuntimeEvents(run.sessionId, run.runId);
      assert.equal(
        immutable.some((event) => event.id === 'nested-heartbeat-0'),
        false,
        'a transient heartbeat must not enter the immutable ledger',
      );
    });
  });

  it('records cache misses across streaming partial commits and hits only in quiet windows', async () => {
    await withStore(async (store) => {
      await commitPreparedInvocation(store, 0);
      assert.deepEqual(toolLedgerCacheSnapshot(store).metrics, {
        hits: 0,
        misses: 1,
        budgetEvictions: 0,
        terminalEvictions: 0,
        transientEntries: 0,
      });

      const identity = cacheInvocationIdentity(0);
      await store.appendRuntimeEvent(identity.sessionId, identity.runId, {
        id: 'cache-stream-partial-0',
        ...identity,
        ts: 2.5,
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'working' },
        refs: { providerEventId: 'cache-stream-message-0' },
      });
      await commitOutcomeInvocation(store, 0);
      let snapshot = toolLedgerCacheSnapshot(store);
      assert.equal(snapshot.metrics.hits, 0);
      assert.equal(snapshot.metrics.misses, 2);

      await commitOutcomeInvocation(store, 0);
      snapshot = toolLedgerCacheSnapshot(store);
      assert.equal(snapshot.metrics.hits, 1);
      assert.equal(snapshot.metrics.misses, 2);

      await store.appendRuntimeEvent(identity.sessionId, identity.runId, {
        id: 'cache-stream-partial-1',
        ...identity,
        ts: 3.5,
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'still working' },
        refs: { providerEventId: 'cache-stream-message-0' },
      });
      await commitOutcomeInvocation(store, 0);
      snapshot = toolLedgerCacheSnapshot(store);
      assert.equal(snapshot.metrics.hits, 1);
      assert.equal(snapshot.metrics.misses, 3);
    });
  });

  it('evicts a cached tool reducer when its invocation is sealed', async () => {
    await withStore(async (store) => {
      await commitPreparedInvocation(store, 0);
      await commitOutcomeInvocation(store, 0);
      assert.equal(toolLedgerCacheSnapshot(store).entries, 1);

      const identity = cacheInvocationIdentity(0);
      await store.appendRuntimeEvent(identity.sessionId, identity.runId, {
        id: 'cache-terminal-0',
        ...identity,
        ts: 4,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      });

      const snapshot = toolLedgerCacheSnapshot(store);
      assert.equal(snapshot.entries, 0);
      assert.equal(snapshot.events, 0);
      assert.equal(snapshot.estimatedBytes, 0);
      assert.equal(snapshot.metrics.terminalEvictions, 1);
    });
  });

  it('evicts a cached reducer after confirming a sibling terminal write', async () => {
    await withStore(async (store, dbPath) => {
      await commitPreparedInvocation(store, 0);
      await commitOutcomeInvocation(store, 0);
      assert.equal(toolLedgerCacheSnapshot(store).entries, 1);

      const identity = cacheInvocationIdentity(0);
      const terminal: RuntimeEvent = {
        id: 'cache-sibling-terminal-0',
        ...identity,
        ts: 4,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      };
      const sibling = createSqliteRuntimeStore(dbPath);
      try {
        await sibling.appendRuntimeEvent(identity.sessionId, identity.runId, terminal);
      } finally {
        sibling.close();
      }

      await store.ensureTerminalRuntimeEventDurable(identity.sessionId, identity.runId, terminal);
      const snapshot = toolLedgerCacheSnapshot(store);
      assert.equal(snapshot.entries, 0);
      assert.equal(snapshot.metrics.terminalEvictions, 1);
    });
  });

  it('bounds aggregate tool reducer residency by estimated bytes', async () => {
    await withStore(
      async (store) => {
        assert.equal((await commitPreparedInvocation(store, 0)).created, true);

        const snapshot = toolLedgerCacheSnapshot(store);
        assert.equal(snapshot.entries, 0);
        assert.equal(snapshot.events, 0);
        assert.equal(snapshot.estimatedBytes, 0);
        assert.equal(snapshot.metrics.budgetEvictions, 1);
        assert.equal(snapshot.metrics.transientEntries, 0);
      },
      {
        toolLedgerCacheBudget: {
          maxEntries: 3,
          maxEstimatedBytes: 1,
          maxSingleEntryEstimatedBytes: 1024 * 1024,
        },
      },
    );
  });

  it('uses a transient reducer when one scope exceeds its byte admission budget', async () => {
    await withStore(
      async (store) => {
        assert.equal((await commitPreparedInvocation(store, 0)).created, true);
        let snapshot = toolLedgerCacheSnapshot(store);
        assert.equal(snapshot.entries, 0);
        assert.equal(snapshot.metrics.budgetEvictions, 1);

        assert.equal((await commitPreparedInvocation(store, 0)).created, false);
        snapshot = toolLedgerCacheSnapshot(store);
        assert.equal(snapshot.entries, 0);
        assert.equal(snapshot.metrics.transientEntries, 1);
      },
      {
        toolLedgerCacheBudget: {
          maxEntries: 3,
          maxEstimatedBytes: 1024 * 1024,
          maxSingleEntryEstimatedBytes: 1,
        },
      },
    );
  });

  it('keeps a transaction-pinned reducer until settlement then enforces the byte budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tool-cache-pin-'));
    const outer = acquireOperationalStateDatabase(root);
    const store = createSqliteRuntimeStore(resolveOperationalStateDatabasePath(root), {
      databaseLease: acquireOperationalStateDatabase(root),
      toolLedgerCacheBudget: {
        maxEntries: 3,
        maxEstimatedBytes: 16 * 1024,
        maxSingleEntryEstimatedBytes: 1024 * 1024,
      },
    });
    try {
      await commitPreparedInvocation(store, 0);
      assert.equal(toolLedgerCacheSnapshot(store).entries, 1);

      let duringTransaction: ReturnType<typeof toolLedgerCacheSnapshot> | undefined;
      const writes: Array<ReturnType<typeof commitOutcomeInvocation>> = [];
      outer.transaction('write', () => {
        writes.push(commitOutcomeInvocation(store, 0, 'x'.repeat(32 * 1024)));
        duringTransaction = toolLedgerCacheSnapshot(store);
      });
      await Promise.all(writes);

      assert.ok(duringTransaction);
      assert.equal(duringTransaction.entries, 1);
      assert.ok(duringTransaction.estimatedBytes > 16 * 1024);
      const settled = toolLedgerCacheSnapshot(store);
      assert.equal(settled.entries, 0);
      assert.equal(settled.estimatedBytes, 0);
      assert.equal(settled.metrics.budgetEvictions, 1);
    } finally {
      store.close();
      outer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a nested T1 whose referenced parent operation is missing', async () => {
    await withStore(async (store) => {
      const parentRefs = {
        parentToolCallId: 'missing-parent-call',
        parentOperationId: 'missing-parent-operation',
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

      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'operation-1',
          journalEventId: 'operation-1_prepared',
          runtimeEvent: call,
          dispatchRuntimeEvent: dispatch,
          providerToolCallId: 'provider-call-1',
          toolName: 'Read',
          canonicalArgsHash: READ_ARGS_HASH,
          recoveryMode: 'replay_safe',
          committedAt: 10,
        }),
        (error: unknown) =>
          error instanceof ToolLedgerRejectionError &&
          error.code === 'parent_operation_missing' &&
          error.eventId === dispatch.id,
      );
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), []);
    });
  });

  it('reports a referenced parent invocation corruption as existing damage', async () => {
    await withStore(async (store, dbPath) => {
      store.close();
      const parentRefs = {
        parentToolCallId: 'corrupt-parent-call',
        parentOperationId: 'corrupt-parent-operation',
      } as const;
      const parentIdentity = {
        sessionId: 'parent-session',
        invocationId: 'corrupt-parent-invocation',
        runId: 'corrupt-parent-run',
        turnId: 'corrupt-parent-turn',
      } as const;
      const parentCall = functionCallEvent({
        id: 'corrupt-parent-call-event',
        ...parentIdentity,
        content: {
          kind: 'function_call',
          id: parentRefs.parentToolCallId,
          name: 'Read',
          args: { path: '/workspace/repo/README.md' },
        },
      });
      const parentDispatch = toolDispatchEvent({
        id: 'corrupt-parent-dispatch-event',
        ...parentIdentity,
        actions: {
          toolDispatch: {
            protocol: 't1_after_preflight_v1',
            operationId: parentRefs.parentOperationId,
            providerToolCallId: parentRefs.parentToolCallId,
            toolName: 'Read',
            canonicalArgsHash: READ_ARGS_HASH,
            recoveryMode: 'replay_safe',
          },
        },
        refs: {
          operationId: parentRefs.parentOperationId,
          toolCallId: parentRefs.parentToolCallId,
        },
      });
      const stranded = functionResponseEvent({
        id: 'corrupt-parent-orphan-response',
        ...parentIdentity,
        content: {
          kind: 'function_response',
          id: 'stranded-parent-call',
          name: 'Read',
          result: 'unbound',
        },
        refs: { toolCallId: 'stranded-parent-call' },
      });
      const raw = new DatabaseSync(dbPath);
      try {
        const insert = raw.prepare(`
          INSERT INTO runtime_events
            (event_id, session_id, invocation_id, run_id, turn_id, event_seq, event_kind,
             payload_json, committed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const [index, event] of [parentCall, parentDispatch, stranded].entries()) {
          const canonical = encodeCanonicalRuntimeEvent(event).event;
          const eventKind = canonical.actions?.toolDispatch
            ? 'tool_dispatch'
            : (canonical.content?.kind ?? 'control');
          insert.run(
            canonical.id,
            canonical.sessionId,
            canonical.invocationId,
            canonical.runId,
            canonical.turnId,
            index + 1,
            eventKind,
            JSON.stringify(canonical),
            canonical.ts,
          );
        }
      } finally {
        raw.close();
      }

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
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
        await assert.rejects(
          reopened.commitToolPrepared({
            operationId: 'operation-1',
            journalEventId: 'operation-1_prepared',
            runtimeEvent: call,
            dispatchRuntimeEvent: dispatch,
            providerToolCallId: 'provider-call-1',
            toolName: 'Read',
            canonicalArgsHash: READ_ARGS_HASH,
            recoveryMode: 'replay_safe',
            committedAt: 10,
          }),
          (error: unknown) =>
            error instanceof ToolLedgerCorruptionError &&
            !(error instanceof ToolLedgerRejectionError) &&
            error.code === 'orphan_response' &&
            error.eventId === stranded.id,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it('does not reuse a corrupt child cache scope for its clean parent', async () => {
    await withStore(async (store, dbPath) => {
      const parentRefs = {
        parentToolCallId: 'clean-parent-call',
        parentOperationId: 'clean-parent-operation',
      } as const;
      const parentIdentity = {
        sessionId: 'parent-session',
        invocationId: 'clean-parent-invocation',
        runId: 'clean-parent-run',
        turnId: 'clean-parent-turn',
      } as const;
      const parentCall = functionCallEvent({
        id: 'clean-parent-call-event',
        ...parentIdentity,
        content: {
          kind: 'function_call',
          id: parentRefs.parentToolCallId,
          name: 'Read',
          args: { path: '/workspace/repo/README.md' },
        },
      });
      const parentDispatch = toolDispatchEvent({
        id: 'clean-parent-dispatch-event',
        ...parentIdentity,
        actions: {
          toolDispatch: {
            protocol: 't1_after_preflight_v1',
            operationId: parentRefs.parentOperationId,
            providerToolCallId: parentRefs.parentToolCallId,
            toolName: 'Read',
            canonicalArgsHash: READ_ARGS_HASH,
            recoveryMode: 'replay_safe',
          },
        },
        refs: {
          operationId: parentRefs.parentOperationId,
          toolCallId: parentRefs.parentToolCallId,
        },
      });
      await store.commitToolPrepared({
        operationId: parentRefs.parentOperationId,
        journalEventId: 'clean-parent-operation_prepared',
        runtimeEvent: parentCall,
        dispatchRuntimeEvent: parentDispatch,
        providerToolCallId: parentRefs.parentToolCallId,
        toolName: 'Read',
        canonicalArgsHash: READ_ARGS_HASH,
        recoveryMode: 'replay_safe',
        committedAt: 5,
      });

      const childIdentity = {
        sessionId: 'child-session',
        invocationId: 'corrupt-child-invocation',
        runId: 'corrupt-child-run',
        turnId: 'corrupt-child-turn',
      } as const;
      const childRefs = {
        operationId: 'corrupt-child-operation',
        toolCallId: 'corrupt-child-call',
        ...parentRefs,
      } as const;
      const childCall = functionCallEvent({
        id: 'corrupt-child-call-event',
        ...childIdentity,
        content: {
          kind: 'function_call',
          id: childRefs.toolCallId,
          name: 'Read',
          args: { path: '/workspace/repo/child.md' },
        },
        refs: childRefs,
      });
      const childDispatch = toolDispatchEvent({
        id: 'corrupt-child-dispatch-event',
        ...childIdentity,
        actions: {
          toolDispatch: {
            protocol: 't1_after_preflight_v1',
            operationId: childRefs.operationId,
            providerToolCallId: childRefs.toolCallId,
            toolName: 'Read',
            canonicalArgsHash: canonicalToolArgsHash('Read', {
              path: '/workspace/repo/child.md',
            }),
            recoveryMode: 'replay_safe',
          },
        },
        refs: childRefs,
      });
      const stranded = functionResponseEvent({
        id: 'corrupt-child-orphan-response',
        ...childIdentity,
        content: {
          kind: 'function_response',
          id: 'stranded-child-call',
          name: 'Read',
          result: 'unbound',
        },
        refs: { toolCallId: 'stranded-child-call' },
      });
      const raw = new DatabaseSync(dbPath);
      try {
        const insert = raw.prepare(`
          INSERT INTO runtime_events
            (event_id, session_id, invocation_id, run_id, turn_id, event_seq, event_kind,
             payload_json, committed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const [index, event] of [childCall, childDispatch, stranded].entries()) {
          const canonical = encodeCanonicalRuntimeEvent(event).event;
          const eventKind = canonical.actions?.toolDispatch
            ? 'tool_dispatch'
            : (canonical.content?.kind ?? 'control');
          insert.run(
            canonical.id,
            canonical.sessionId,
            canonical.invocationId,
            canonical.runId,
            canonical.turnId,
            index + 1,
            eventKind,
            JSON.stringify(canonical),
            canonical.ts,
          );
        }
      } finally {
        raw.close();
      }

      await assert.rejects(
        store.commitToolPrepared({
          operationId: childRefs.operationId,
          journalEventId: 'corrupt-child-operation_prepared',
          runtimeEvent: childCall,
          dispatchRuntimeEvent: childDispatch,
          providerToolCallId: childRefs.toolCallId,
          toolName: 'Read',
          canonicalArgsHash: canonicalToolArgsHash('Read', {
            path: '/workspace/repo/child.md',
          }),
          recoveryMode: 'replay_safe',
          committedAt: 10,
        }),
        (error: unknown) =>
          error instanceof ToolLedgerCorruptionError && error.code === 'orphan_response',
      );

      const parentOutcome = functionResponseEvent({
        id: 'clean-parent-response-event',
        ...parentIdentity,
        content: {
          kind: 'function_response',
          id: parentRefs.parentToolCallId,
          name: 'Read',
          result: 'clean',
        },
        refs: {
          operationId: parentRefs.parentOperationId,
          toolCallId: parentRefs.parentToolCallId,
        },
      });
      const result = await store.commitToolOutcome({
        operationId: parentRefs.parentOperationId,
        journalEventId: 'clean-parent-operation_outcome',
        runtimeEvent: parentOutcome,
        committedAt: 20,
      });
      assert.equal(result.created, true);
      assert.equal(
        (await store.readToolOperation(parentRefs.parentOperationId))?.currentState,
        'outcome_committed',
      );
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

      setFailpoint(undefined);
      const retried = await store.commitToolPrepared({
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
      });
      assert.equal(retried.created, true);
    });
  });

  it('commits function_response, outcome journal fact, and projection atomically in T2', async () => {
    await withStore(async (store) => {
      await commitPrepared(store, { resultProjectionVersion: 1 });
      const outcome = functionResponseEvent({
        content: {
          kind: 'function_response',
          id: 'provider-call-1',
          name: 'Read',
          result: 'private execution contents',
          modelProjection: { version: 1, kind: 'text', text: 'bounded model contents' },
        },
      });

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
        toolDispatchEvent({
          actions: {
            toolDispatch: {
              protocol: 't1_after_preflight_v1',
              operationId: 'operation-1',
              providerToolCallId: 'provider-call-1',
              toolName: 'Read',
              canonicalArgsHash: READ_ARGS_HASH,
              recoveryMode: 'replay_safe',
              resultProjectionVersion: 1,
            },
          },
        }),
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

  it('keeps projected T2 prepared when its atomic model projection is missing', async () => {
    await withStore(async (store) => {
      await commitPrepared(store, { resultProjectionVersion: 1 });

      await assert.rejects(
        store.commitToolOutcome({
          operationId: 'operation-1',
          journalEventId: 'operation-1_outcome',
          runtimeEvent: functionResponseEvent(),
          committedAt: 20,
        }),
        /requires its durable model projection/,
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
    });
  });

  it('rolls back T2 without hiding the previously committed prepared boundary', async () => {
    await withStore(async (store, _dbPath, setFailpoint) => {
      await commitPrepared(store);
      const cacheBefore = toolLedgerCacheSnapshot(store);
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
      const cacheAfter = toolLedgerCacheSnapshot(store);
      assert.equal(cacheAfter.entries, cacheBefore.entries);
      assert.equal(cacheAfter.events, cacheBefore.events);
      assert.equal(cacheAfter.estimatedBytes, cacheBefore.estimatedBytes);
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

  it('refuses a continuation target opening it cannot read, stored or submitted', async () => {
    await withStore(async (store, dbPath) => {
      const claim = continuationClaim();
      await persistImmutablePrefix(store, continuationSourcePrefix());
      await assert.rejects(
        () =>
          store.claimContinuation({
            claim: {
              ...claim,
              targetOpening: {
                ...claim.targetOpening,
                configuration: {
                  ...claim.targetOpening.configuration,
                  permissionMode: 'execute',
                },
              } as unknown as ContinuationClaimV1['targetOpening'],
            },
          }),
        /Invalid RuntimeEvent invocation_opened schema/,
      );
      assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');

      const database = new DatabaseSync(dbPath);
      try {
        database.exec(`
          UPDATE runtime_continuation_claims
          SET target_opening_json = json_set(
            target_opening_json,
            '$.configuration.permissionMode',
            'execute'
          )
          WHERE claim_id = 'claim-1';
        `);
      } finally {
        database.close();
      }

      // A persisted Run header used to be widened on read. The opening fact has
      // no legacy layer and none is wanted: a claim whose frozen opening cannot
      // be read cannot authenticate the start event it exists to authenticate,
      // and admitting one against a guessed opening would be the failure this
      // record is meant to prevent.
      await assert.rejects(
        store.readContinuationClaimByBoundary(claim.boundaryDigest),
        /Invalid RuntimeEvent invocation_opened schema/,
      );
    });
  });

  for (const initialKind of ['fresh', 'continuation'] as const) {
    it(`authenticates repeated handoff under one ${initialKind} logical admission across reopen`, async () => {
      await withStore(async (store, dbPath) => {
        const manual = continuationClaim();
        let source: RuntimeEvent;
        const segments: ReturnType<typeof runtimePrefixSegment>[] = [];
        if (initialKind === 'continuation') {
          const ancestor = continuationSourcePrefix();
          await persistImmutablePrefix(store, ancestor);
          segments.push(runtimePrefixSegment(ancestor));
          await store.claimContinuation({ claim: manual });
          source = continuationStartEvent(manual);
          await store.commitContinuationStart({ claim: manual, event: source });
        } else {
          source = {
            ...continuationStartEvent(manual),
            id: 'root-opening',
            actions: undefined,
            content: {
              ...manual.targetOpening,
              source: { kind: 'fresh' },
              root: { kind: 'goal', goalId: 'original-goal' },
              lineage: { parentRunId: 'owning-agent', parentTurnId: 'owning-turn' },
            },
          };
          await store.appendRuntimeEvent(source.sessionId, source.runId, source);
        }
        const rootRunId = source.runId;
        const logicalIdentity = {
          sessionId: source.sessionId,
          turnId: source.turnId,
          runId: rootRunId,
        };
        let fullEventReads = 0;
        const membershipStore = {
          listSessionInvocations: store.listSessionInvocations.bind(store),
          readRunInvocation: store.readRunInvocation.bind(store),
          readContinuationClaimStateByBoundary:
            store.readContinuationClaimStateByBoundary.bind(store),
          readImmutableRuntimePrefixProof: (input: {
            sessionId: string;
            runId: string;
            upToEventSeq?: number;
          }) => store.readImmutableRuntimePrefixProof(input, PREFIX_PROOF_TEST_BUDGET),
          readImmutableRuntimeEvents: async () => {
            fullEventReads += 1;
            throw new Error('membership read loaded full events');
          },
        };
        for (let index = 0; index < 2; index += 1) {
          const target = {
            sessionId: source.sessionId,
            turnId: source.turnId,
            runId: `handoff-run-${index}`,
            invocationId: `handoff-invocation-${index}`,
          };
          const claimId = `handoff-claim-${index}`;
          const seal: RuntimeEvent = {
            ...source,
            id: `pause-${index}`,
            content: undefined,
            ts: 15 + index,
            actions: {
              endInvocation: true,
              handoffPause: {
                protocol: 'runtime_handoff_pause_v1',
                handoffId: `handoff-${index}`,
                remainingSteps: null,
                hostEpoch: 'old-host',
                rootRunId,
                successorRunId: target.runId,
                successorInvocationId: target.invocationId,
                claimId,
              },
            },
          };
          await store.appendRuntimeEvent(seal.sessionId, seal.runId, seal);
          assert.equal(
            (await readLogicalRuntimeExecution(store, logicalIdentity))?.pendingHandoff?.claimId,
            claimId,
          );
          assert.equal(
            (
              await readLogicalRuntimeExecution(membershipStore, logicalIdentity, undefined, {
                mode: 'membership',
              })
            )?.pendingHandoff?.claimId,
            claimId,
          );
          segments.push(
            runtimePrefixSegment(
              await store.readImmutableRuntimePrefix({
                sessionId: source.sessionId,
                runId: source.runId,
              }),
            ),
          );
          const boundary = createRuntimeBoundaryCursor(
            segments as [(typeof segments)[number], ...typeof segments],
          );
          const proposed = continuationClaimForBoundary(boundary, { claimId, target });
          assert.equal(source.content?.kind, 'invocation_opened');
          const opening = source.content as ContinuationClaimV1['targetOpening'];
          assert.equal(proposed.targetOpening.source.kind, 'continuation');
          const claim: ContinuationClaimV1 = {
            ...proposed,
            targetOpening: {
              ...opening,
              source: {
                ...(proposed.targetOpening.source as Extract<
                  ContinuationClaimV1['targetOpening']['source'],
                  { kind: 'continuation' }
                >),
                kind: 'handoff',
                rootRunId,
                claimId,
                boundaryDigest: boundary.manifestDigest,
              },
            },
          };
          for (const targetOpening of [
            { ...claim.targetOpening, root: { kind: 'user' as const } },
            { ...claim.targetOpening, lineage: { parentRunId: 'stolen-owner' } },
            { ...claim.targetOpening, configuration: { ...opening.configuration, cwd: '/other' } },
          ]) {
            if (JSON.stringify(targetOpening) === JSON.stringify(claim.targetOpening)) continue;
            await assert.rejects(
              store.claimContinuation({ claim: { ...claim, targetOpening } }),
              /sealed source authority/,
            );
          }
          await assert.rejects(
            store.claimContinuation({
              claim: {
                ...claim,
                target: { ...claim.target, invocationId: 'unauthorized-physical-target' },
              },
            }),
            /sealed source authority/,
          );
          assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');
          assert.equal((await store.claimContinuation({ claim })).kind, 'existing');
          assert.equal(
            (await readLogicalRuntimeExecution(store, logicalIdentity))?.pendingHandoff?.claimId,
            claimId,
          );
          source = continuationStartEvent(claim, { id: `handoff-start-${index}` });
          await store.commitContinuationStart({ claim, event: source });
          await store.commitContinuationStart({ claim, event: source });
          const live = await readLogicalRuntimeExecution(store, logicalIdentity);
          const membership = await readLogicalRuntimeExecution(
            membershipStore,
            logicalIdentity,
            undefined,
            { mode: 'membership' },
          );
          assert.equal(live?.root.runId, rootRunId);
          assert.equal(live?.tip.runId, source.runId);
          assert.equal(live?.pendingHandoff, undefined);
          assert.deepEqual(membership?.runIds, live?.runIds);
          assert.equal(membership?.root.runId, live?.root.runId);
          assert.equal(membership?.tip.runId, live?.tip.runId);
          assert.equal(membership?.pendingHandoff, undefined);
          assert.equal(fullEventReads, 0);
          if (index === 0) {
            await assert.rejects(
              readLogicalRuntimeExecution(
                {
                  ...membershipStore,
                  readImmutableRuntimePrefixProof: async (input) => ({
                    ...(await membershipStore.readImmutableRuntimePrefixProof(input)),
                    prefixDigest:
                      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  }),
                },
                logicalIdentity,
                undefined,
                { mode: 'membership' },
              ),
              /successor opened without its continuation claim/,
            );
          }
          await assert.rejects(
            store.appendRuntimeEvent(source.sessionId, 'rogue', {
              ...source,
              id: `rogue-${index}`,
              runId: 'rogue',
              invocationId: 'rogue',
              content: { kind: 'text', text: 'unauthorized' },
              actions: undefined,
            }),
            /target identity conflict/,
          );
        }
        const terminal: RuntimeEvent = {
          ...source,
          id: 'logical-completion',
          content: undefined,
          status: 'completed',
          actions: { endInvocation: true },
        };
        await store.appendRuntimeEvent(terminal.sessionId, terminal.runId, terminal);
        store.close();
        const reopened = createSqliteRuntimeStore(dbPath);
        try {
          const claims = await reopened.listContinuationClaimsForRecovery(source.sessionId);
          assert.equal(claims.length, initialKind === 'fresh' ? 2 : 3);
          assert.equal(claims.at(-1)?.claim.target.turnId, source.turnId);
          assert.deepEqual(
            (await reopened.readRuntimeEvents(source.sessionId, source.runId)).at(-1),
            encodeCanonicalRuntimeEvent(terminal).event,
          );
          assert.equal(
            (await readLogicalRuntimeExecution(reopened, logicalIdentity))?.tip.terminalEvent
              ?.status,
            'completed',
          );
        } finally {
          reopened.close();
        }
      });
    });
  }

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

  it('lets a started continuation target be purged instead of refusing the delete', async () => {
    await withStore(async (store, dbPath) => {
      const claim = continuationClaim();
      await persistImmutablePrefix(store, continuationSourcePrefix());
      assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');

      const db = new DatabaseSync(dbPath);
      try {
        db.exec('PRAGMA foreign_keys = ON');
        // Stand the claim up the way starting a continuation does: its start
        // event is event one of the target Session's run.
        const start = db
          .prepare('SELECT event_id, session_id FROM runtime_events ORDER BY event_seq ASC LIMIT 1')
          .get() as { event_id: string; session_id: string };
        db.prepare(
          "UPDATE runtime_continuation_claims SET start_event_id = ?, start_kind = 'runtime_admission' WHERE claim_id = ?",
        ).run(start.event_id, claim.claimId);

        // Purging a conversation deletes its events. The claim used to have no
        // ON DELETE clause, so the constraint refused this and rolled the whole
        // purge back — for the user's delete, a copy rollback, an import
        // discard and Session retirement alike.
        db.prepare('DELETE FROM runtime_events WHERE session_id = ?').run(start.session_id);

        assert.equal(
          (
            db
              .prepare(
                'SELECT COUNT(*) AS count FROM runtime_continuation_claims WHERE claim_id = ?',
              )
              .get(claim.claimId) as { count: number }
          ).count,
          0,
          'a continuation whose target was deleted no longer names anything, so it goes too',
        );
      } finally {
        db.close();
      }
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

  it('lists only selected continuation claims whose target invocation is not terminal', async () => {
    await withStore(async (store) => {
      const claim = continuationClaim();
      const start = continuationStartEvent(claim);
      await persistImmutablePrefix(store, continuationSourcePrefix());
      assert.equal((await store.claimContinuation({ claim })).kind, 'acquired');

      assert.deepEqual(
        await store.listUnsettledContinuationClaimsForRecovery([claim.target.sessionId]),
        [{ claim }],
      );
      assert.deepEqual(
        await store.listUnsettledContinuationClaimsForRecovery(['unrelated-session']),
        [],
      );

      await store.commitContinuationStart({ claim, event: start });
      assert.deepEqual(
        await store.listUnsettledContinuationClaimsForRecovery([claim.target.sessionId]),
        [{ claim, startEventId: start.id, startKind: 'runtime_admission' }],
      );

      await store.appendRuntimeEvent(claim.target.sessionId, claim.target.runId, {
        ...start,
        id: 'continuation-terminal-1',
        ts: start.ts + 1,
        content: undefined,
        status: 'failed',
        actions: { endInvocation: true },
      });
      assert.deepEqual(
        await store.listUnsettledContinuationClaimsForRecovery([claim.target.sessionId]),
        [],
      );
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
      const proof = await store.readImmutableRuntimePrefixProof(
        { sessionId: 'session-1', runId: 'run-1' },
        PREFIX_PROOF_TEST_BUDGET,
      );
      const pinnedProof = await store.readImmutableRuntimePrefixProof(
        { sessionId: 'session-1', runId: 'run-1', upToEventSeq: 1 },
        PREFIX_PROOF_TEST_BUDGET,
      );

      assert.equal(pinned.prefixDigest, beforePartial.prefixDigest);
      assert.equal(latest.position.lastEventSeq, 2);
      assert.notEqual(latest.prefixDigest, beforePartial.prefixDigest);
      assert.equal(proof.prefixDigest, latest.prefixDigest);
      assert.deepEqual(proof.position, latest.position);
      assert.equal(proof.firstEvent.id, 'user-event-1');
      assert.equal(proof.lastEvent.id, 'model-event-2');
      assert.equal(pinnedProof.prefixDigest, pinned.prefixDigest);
      assert.equal(pinnedProof.firstEvent.id, pinnedProof.lastEvent.id);
      for (const [budget, message] of [
        [{ ...PREFIX_PROOF_TEST_BUDGET, maxEvents: 1 }, /event limit/],
        [{ ...PREFIX_PROOF_TEST_BUDGET, maxBytes: 1 }, /byte limit/],
        [{ ...PREFIX_PROOF_TEST_BUDGET, maxRecordBytes: 1 }, /record byte limit/],
      ] as const) {
        await assert.rejects(
          store.readImmutableRuntimePrefixProof({ sessionId: 'session-1', runId: 'run-1' }, budget),
          message,
        );
      }
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
        await assert.rejects(
          reopened.readImmutableRuntimePrefixProof(
            { sessionId: 'session-1', runId: 'run-1' },
            PREFIX_PROOF_TEST_BUDGET,
          ),
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
  options: SqliteRuntimeStoreOptions = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-runtime-'));
  const dbPath = join(root, 'runtime.sqlite');
  let failpoint: SqliteRuntimeStoreFailpoint | undefined;
  const store = createSqliteRuntimeStore(dbPath, {
    ...options,
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
    targetOpening: {
      kind: 'invocation_opened',
      protocol: 'invocation_opened_v1',
      route: {
        provenance: 'unknown',
        backendKind: 'fake',
        llmConnectionSlug: 'connection-1',
        modelId: 'model-1',
      },
      configuration: {
        cwd: '/workspace/repo',
        permissionMode: 'ask',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
        orchestrationSource: 'session',
        toolMode: DEFAULT_TOOL_MODE,
        agentSwarmAuthorization: 'none',
      },
      root: { kind: 'user' },
      source: {
        kind: 'continuation',
        sourceInvocationId: source.identity.invocationId,
        sourceRunId: source.identity.runId,
        sourceTurnId: source.identity.turnId,
        sourceRuntimeEventHighWater: source.position.lastEventSeq,
        claimId,
        boundaryDigest: boundary.manifestDigest,
      },
      lineage: {
        parentRunId: source.identity.runId,
        parentTurnId: source.identity.turnId,
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
    modelVisibility: 'hidden',
    content: claim.targetOpening,
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

/** A DatabaseSync that records what each statement was actually run with. */
function watchStatements(
  db: DatabaseSync,
  executed: { sql: string; bind: unknown[] }[],
): DatabaseSync {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      const record =
        <T>(call: (...bind: unknown[]) => T) =>
        (...bind: unknown[]) => {
          executed.push({ sql, bind });
          return call(...bind);
        };
      return {
        all: record((...bind) => statement.all(...(bind as []))),
        get: record((...bind) => statement.get(...(bind as []))),
        iterate: record((...bind) => statement.iterate(...(bind as []))),
      };
    },
  } as unknown as DatabaseSync;
}

async function appendSettledTurn(store: Store, index: number): Promise<void> {
  const run = {
    sessionId: 'session-1',
    invocationId: `invocation-${index}`,
    runId: `run-${index}`,
    turnId: `turn-${index}`,
  };
  await store.appendRuntimeEvent(run.sessionId, run.runId, invocationOpeningEvent(index));
  await store.appendRuntimeEvent(run.sessionId, run.runId, {
    id: `prompt-${index}`,
    ...run,
    ts: index * 10 + 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: `turn ${index}` },
  });
  await store.appendRuntimeEvent(run.sessionId, run.runId, {
    id: `terminal-${index}`,
    ...run,
    ts: index * 10 + 2,
    partial: false,
    role: 'system',
    author: 'system',
    status: 'completed',
    actions: { endInvocation: true },
  });
}

function invocationOpeningEvent(index: number): RuntimeEvent {
  return buildInvocationOpenedEvent({
    id: `opened-${index}`,
    run: {
      sessionId: 'session-1',
      invocationId: `invocation-${index}`,
      runId: `run-${index}`,
      turnId: `turn-${index}`,
    },
    openedAt: index * 10,
    opening: {
      kind: 'invocation_opened',
      protocol: 'invocation_opened_v1',
      route: {
        provenance: 'runtime',
        backendKind: 'fake',
        llmConnectionId: 'fake-connection',
        llmConnectionSlug: 'fake',
        modelId: 'fake-model',
      },
      configuration: {
        cwd: '/tmp',
        permissionMode: 'ask',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
        orchestrationSource: 'session',
        toolMode: DEFAULT_TOOL_MODE,
      },
      root: { kind: 'user' },
      source: { kind: 'fresh' },
    },
  });
}

function textEvent(id: string): RuntimeEvent {
  return functionCallEvent({ id, content: { kind: 'text', text: id } });
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

function cacheInvocationIdentity(index: number) {
  return {
    sessionId: `cache-session-${index}`,
    invocationId: `cache-invocation-${index}`,
    runId: `cache-run-${index}`,
    turnId: `cache-turn-${index}`,
  } as const;
}

function commitPreparedInvocation(store: Store, index: number) {
  const identity = cacheInvocationIdentity(index);
  const operationId = `cache-operation-${index}`;
  const toolCallId = `cache-tool-call-${index}`;
  const args = { path: `/workspace/cache-${index}.txt` };
  const canonicalArgsHash = canonicalToolArgsHash('Read', args);
  return store.commitToolPrepared({
    operationId,
    journalEventId: `${operationId}_prepared`,
    runtimeEvent: functionCallEvent({
      id: `cache-call-${index}`,
      ...identity,
      ts: index * 10 + 1,
      content: { kind: 'function_call', id: toolCallId, name: 'Read', args },
    }),
    dispatchRuntimeEvent: toolDispatchEvent({
      id: `cache-dispatch-${index}`,
      ...identity,
      ts: index * 10 + 2,
      actions: {
        toolDispatch: {
          protocol: 't1_after_preflight_v1',
          operationId,
          providerToolCallId: toolCallId,
          toolName: 'Read',
          canonicalArgsHash,
          recoveryMode: 'replay_safe',
        },
      },
      refs: { operationId, toolCallId },
    }),
    providerToolCallId: toolCallId,
    toolName: 'Read',
    canonicalArgsHash,
    recoveryMode: 'replay_safe',
    committedAt: index * 10 + 2,
  });
}

function commitOutcomeInvocation(store: Store, index: number, result = `cache contents ${index}`) {
  const identity = cacheInvocationIdentity(index);
  const operationId = `cache-operation-${index}`;
  const toolCallId = `cache-tool-call-${index}`;
  return store.commitToolOutcome({
    operationId,
    journalEventId: `${operationId}_outcome`,
    runtimeEvent: functionResponseEvent({
      id: `cache-response-${index}`,
      ...identity,
      ts: index * 10 + 3,
      content: {
        kind: 'function_response',
        id: toolCallId,
        name: 'Read',
        result,
      },
      refs: { operationId, toolCallId },
    }),
    committedAt: index * 10 + 3,
  });
}

function toolLedgerCacheSnapshot(store: Store) {
  const internal = store as unknown as {
    toolLedgerCache: Map<
      string,
      {
        seedInvocationIds: ReadonlySet<string>;
      }
    >;
    toolLedgerCacheEstimatedBytes: number;
    toolLedgerCacheEventCount: number;
    toolLedgerCacheMetrics: {
      hits: number;
      misses: number;
      budgetEvictions: number;
      terminalEvictions: number;
      transientEntries: number;
    };
  };
  return {
    entries: internal.toolLedgerCache.size,
    estimatedBytes: internal.toolLedgerCacheEstimatedBytes,
    events: internal.toolLedgerCacheEventCount,
    seedInvocationIds: [...internal.toolLedgerCache.values()].flatMap((entry) => [
      ...entry.seedInvocationIds,
    ]),
    metrics: { ...internal.toolLedgerCacheMetrics },
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

function commitPrepared(store: Store, options: { resultProjectionVersion?: 1 } = {}) {
  return store.commitToolPrepared({
    operationId: 'operation-1',
    journalEventId: 'operation-1_prepared',
    runtimeEvent: functionCallEvent(),
    dispatchRuntimeEvent: toolDispatchEvent({
      actions: {
        toolDispatch: {
          protocol: 't1_after_preflight_v1',
          operationId: 'operation-1',
          providerToolCallId: 'provider-call-1',
          toolName: 'Read',
          canonicalArgsHash: READ_ARGS_HASH,
          recoveryMode: 'replay_safe',
          ...(options.resultProjectionVersion !== undefined
            ? { resultProjectionVersion: options.resultProjectionVersion }
            : {}),
        },
      },
    }),
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
