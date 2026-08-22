import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SESSION_TRACE_SCHEMA_VERSION,
  mergeDisjointTraceCoverage,
  mergeSessionTraces,
  type SessionTrace,
  type SessionTraceCoverage,
} from '../session-trace.js';

function coverage(
  modelCalls: SessionTraceCoverage['modelCalls'],
  unreadableRecords = 0,
  oversizedRuns = 0,
): SessionTraceCoverage {
  return {
    modelCalls,
    turnsMissingModelCalls: [],
    turnsWithFewerModelCallsThanSteps: [],
    unreadableRecords,
    oversizedRuns,
  };
}

test('coverage merge distinguishes backend absence from a gap in only some pages', () => {
  const cases = [
    ['none', 'absent', 'absent'],
    ['absent', 'absent', 'absent'],
    ['no_known_gap', 'no_known_gap', 'no_known_gap'],
    ['absent', 'no_known_gap', 'partial'],
    ['partial', 'no_known_gap', 'partial'],
  ] as const;
  for (const [left, right, expected] of cases) {
    assert.equal(mergeDisjointTraceCoverage(coverage(left), coverage(right)).modelCalls, expected);
  }
  assert.equal(
    mergeDisjointTraceCoverage(coverage('partial', 1), coverage('partial', 2)).unreadableRecords,
    3,
  );
  assert.equal(
    mergeDisjointTraceCoverage(coverage('partial', 0, 1), coverage('partial', 0, 2)).oversizedRuns,
    3,
  );
});

test('page merge orders and deduplicates turns', () => {
  const page = (runId: string, startedAt: number): SessionTrace => ({
    schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
    sessionId: 'session-1',
    turns: [
      {
        turnId: `turn-${runId}`,
        runId,
        startedAt,
        endedAt: startedAt,
        durationMs: 0,
        steps: [],
      },
    ],
    coverage: coverage('no_known_gap'),
  });

  const merged = mergeSessionTraces([page('run-2', 2), page('run-1', 1), page('run-2', 2)]);
  assert.deepEqual(
    merged.turns.map((turn) => turn.runId),
    ['run-1', 'run-2'],
  );
});

test('page merge has a stable order when run timestamps and identities tie', () => {
  const page = (turnId: string): SessionTrace => ({
    schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
    sessionId: 'session-1',
    turns: [
      {
        turnId,
        runId: 'run-1',
        startedAt: 1,
        endedAt: 1,
        durationMs: 0,
        steps: [],
      },
    ],
    coverage: coverage('no_known_gap'),
  });

  const merged = mergeSessionTraces([page('turn-b'), page('turn-a')]);

  assert.deepEqual(
    merged.turns.map((turn) => turn.turnId),
    ['turn-a', 'turn-b'],
  );
});

test('coverage merge keeps equal turn ids from distinct runs separate', () => {
  const first = coverage('partial');
  first.turnsMissingModelCalls = [{ runId: 'run-1', turnId: 'turn-1' }];
  const second = coverage('partial');
  second.turnsMissingModelCalls = [{ runId: 'run-2', turnId: 'turn-1' }];

  assert.deepEqual(mergeDisjointTraceCoverage(first, second).turnsMissingModelCalls, [
    { runId: 'run-1', turnId: 'turn-1' },
    { runId: 'run-2', turnId: 'turn-1' },
  ]);
});
