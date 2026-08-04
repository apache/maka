import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import {
  createSqliteModelCallLedger,
  ModelCallLedgerClosedError,
  repairPendingModelCallProjections,
  type ModelCallLedger,
} from '../model-call-ledger.js';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';

const NOW = 1_750_000_000_000;

function attempt(overrides: Partial<ModelCallAttempt> = {}): ModelCallAttempt {
  return {
    schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
    logicalCallId: 'call-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    step: 0,
    attempt: 0,
    callKind: 'main',
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    startedAt: NOW - 1_000,
    completedAt: NOW - 500,
    latencyMs: 500,
    status: 'completed',
    usageBasis: 'reported',
    inputTokens: 100,
    outputTokens: 20,
    costBasis: 'priced',
    costUsd: 0.004,
    ...overrides,
  };
}

async function withLedger(run: (ledger: ModelCallLedger, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-call-ledger-'));
  const ledger = createSqliteModelCallLedger(root);
  try {
    await run(ledger, root);
  } finally {
    await ledger.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

describe('canonical model call ledger', () => {
  test('reads back what it recorded, bounded to the queried window', async () => {
    await withLedger(async (ledger) => {
      await ledger.record(attempt({ attemptId: 'inside', completedAt: NOW - 500 }));
      await ledger.record(
        attempt({ attemptId: 'before', startedAt: NOW - 10_500, completedAt: NOW - 10_000 }),
      );

      const page = ledger.read({ from: NOW - 1_000, to: NOW });
      assert.deepEqual(
        page.attempts.map((row) => row.attemptId),
        ['inside'],
      );
      assert.equal(page.unreadableRecords, 0);
    });
  });

  test('a late settlement replaces the provisional record under the same attempt id', async () => {
    // The abort path records provisionally without usage; a `finish` arriving
    // afterwards settles the same attempt. Two rows would double-count it.
    await withLedger(async (ledger) => {
      await ledger.record(
        attempt({
          status: 'aborted',
          usageBasis: 'missing',
          inputTokens: undefined,
          outputTokens: undefined,
        }),
      );
      await ledger.record(attempt({ status: 'completed', usageBasis: 'reported' }));

      const page = ledger.read({ from: 0, to: NOW });
      assert.equal(page.attempts.length, 1);
      assert.equal(page.attempts[0]?.status, 'completed');
      assert.equal(page.attempts[0]?.inputTokens, 100);
    });
  });

  test('rejects a record that does not satisfy the canonical schema', async () => {
    await withLedger(async (ledger) => {
      await assert.rejects(
        () => ledger.record(attempt({ costBasis: 'unpriced', costUsd: 0.004 })),
        /unpriced record carries a cost/,
      );
      assert.equal(ledger.read({ from: 0, to: NOW }).attempts.length, 0);
    });
  });

  test('one unreadable row is reported rather than failing the whole query', async () => {
    await withLedger(async (ledger, root) => {
      await ledger.record(attempt({ attemptId: 'good' }));
      const lease = acquireOperationalStateDatabase(root);
      try {
        lease.transaction('write', () => {
          lease.database
            .prepare(
              'INSERT INTO usage_model_call_attempts(attempt_id, completed_at, record_json) VALUES (?, ?, ?)',
            )
            .run('corrupt', NOW - 400, '{"schemaVersion":1,');
        });
      } finally {
        lease.close();
      }

      const page = ledger.read({ from: 0, to: NOW });
      assert.deepEqual(
        page.attempts.map((row) => row.attemptId),
        ['good'],
      );
      assert.equal(page.unreadableRecords, 1);
    });
  });

  test('reads and writes after close report the lifecycle rather than corrupting state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-model-call-ledger-'));
    const ledger = createSqliteModelCallLedger(root);
    await ledger.record(attempt());
    await ledger.close();

    await assert.rejects(
      () => ledger.record(attempt({ attemptId: 'after' })),
      ModelCallLedgerClosedError,
    );
    assert.throws(() => ledger.read({ from: 0, to: NOW }), ModelCallLedgerClosedError);
    await rm(root, { recursive: true, force: true });
  });
});

describe('re-projecting a run the read model fell behind on', () => {
  const runEvents = (attempts: readonly ModelCallAttempt[]) => [
    { type: 'model_stream_started', data: {} },
    ...attempts.map((attempt) => ({
      type: 'model_call_attempt_recorded',
      data: { ...attempt } as Record<string, unknown>,
    })),
  ];

  function target(ledger: ModelCallLedger) {
    return {
      record: (attempt: ModelCallAttempt) => ledger.record(attempt),
      pending: () => ledger.pendingReprojections(),
      clear: (sessionId: string, runId: string) =>
        ledger.clearPendingReprojection(sessionId, runId),
    };
  }

  test('a call the authority holds but the table missed is recovered, not lost', async () => {
    await withLedger(async (ledger) => {
      // The AgentRun append committed and the table write failed: the marker is
      // all that survived, and the record has to come back from the stream.
      const committed = attempt({ attemptId: 'missed' });
      await ledger.markRunPendingReprojection('session-1', 'run-1');
      assert.equal(ledger.read({ from: 0, to: NOW }).attempts.length, 0);

      const result = await repairPendingModelCallProjections({
        ledger: target(ledger),
        readRunEvents: async () => runEvents([committed]),
      });

      assert.deepEqual(result, { repaired: 1, remaining: 0, unreadableEvents: 0 });
      assert.deepEqual(
        ledger.read({ from: 0, to: NOW }).attempts.map((row) => row.attemptId),
        ['missed'],
      );
      assert.deepEqual(ledger.pendingReprojections(), []);
    });
  });

  test('re-projecting a run the table already holds changes nothing', async () => {
    await withLedger(async (ledger) => {
      const committed = attempt({ attemptId: 'already-there' });
      await ledger.record(committed);
      await ledger.markRunPendingReprojection('session-1', 'run-1');

      await repairPendingModelCallProjections({
        ledger: target(ledger),
        readRunEvents: async () => runEvents([committed, committed]),
      });

      assert.equal(ledger.read({ from: 0, to: NOW }).attempts.length, 1);
    });
  });

  test('a run whose authority read fails keeps its marker and is reported', async () => {
    await withLedger(async (ledger) => {
      await ledger.markRunPendingReprojection('session-1', 'run-1');

      const result = await repairPendingModelCallProjections({
        ledger: target(ledger),
        readRunEvents: async () => {
          throw new Error('authority unavailable');
        },
      });

      assert.deepEqual(result, { repaired: 0, remaining: 1, unreadableEvents: 0 });
      assert.equal(ledger.pendingReprojections().length, 1);
    });
  });

  test('an undecodable authority event keeps durable incomplete evidence', async () => {
    await withLedger(async (ledger) => {
      await ledger.markRunPendingReprojection('session-1', 'run-1');

      const result = await repairPendingModelCallProjections({
        ledger: target(ledger),
        readRunEvents: async () => [
          { type: 'model_call_attempt_recorded', data: { schemaVersion: 1 } },
          ...runEvents([attempt({ attemptId: 'good' })]),
        ],
      });

      assert.equal(result.unreadableEvents, 1);
      assert.equal(result.repaired, 0);
      assert.equal(result.remaining, 1);
      assert.equal(ledger.pendingReprojections().length, 1);
    });
  });

  test('an undecodable event does not block the rest of its run', async () => {
    await withLedger(async (ledger) => {
      await ledger.markRunPendingReprojection('session-1', 'run-1');

      await repairPendingModelCallProjections({
        ledger: target(ledger),
        readRunEvents: async () => [
          { type: 'model_call_attempt_recorded', data: { schemaVersion: 1 } },
          ...runEvents([attempt({ attemptId: 'good' })]),
        ],
      });

      assert.deepEqual(
        ledger.read({ from: 0, to: NOW }).attempts.map((row) => row.attemptId),
        ['good'],
      );
      assert.equal(ledger.pendingReprojections().length, 1);
    });
  });
});
