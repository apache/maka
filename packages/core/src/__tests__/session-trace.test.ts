import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SESSION_TRACE_SCHEMA_VERSION,
  emptyTraceTotals,
  mergeDisjointTraceCoverage,
  mergeSessionTraces,
  type SessionTrace,
  type SessionTraceCoverage,
} from '../session-trace.js';

function coverage(modelCalls: SessionTraceCoverage['modelCalls'], unreadableRecords = 0) {
  return {
    modelCalls,
    turnsMissingModelCalls: [],
    turnsWithFewerModelCallsThanSteps: [],
    unreadableRecords,
  } satisfies SessionTraceCoverage;
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
});

test('page merge orders and deduplicates turns while recomputing totals', () => {
  const page = (runId: string, startedAt: number, inputTokens: number): SessionTrace => ({
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
        totals: { ...emptyTraceTotals(), inputTokens },
      },
    ],
    totals: { ...emptyTraceTotals(), inputTokens },
    coverage: coverage('no_known_gap'),
  });

  const merged = mergeSessionTraces([
    page('run-2', 2, 2),
    page('run-1', 1, 1),
    page('run-2', 2, 2),
  ]);
  assert.deepEqual(
    merged.turns.map((turn) => turn.runId),
    ['run-1', 'run-2'],
  );
  assert.equal(merged.totals.inputTokens, 3);
});
