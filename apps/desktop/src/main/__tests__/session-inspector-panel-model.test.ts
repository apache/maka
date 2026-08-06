import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  SESSION_TRACE_SCHEMA_VERSION,
  emptyTraceTotals,
  type SessionTrace,
  type TraceStep,
} from '@maka/core/session-trace';
import { deriveInspectorPanelModel } from '../../renderer/session-inspector-panel-model.js';

function trace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
    sessionId: 'session-1',
    turns: [],
    totals: emptyTraceTotals(),
    coverage: {
      modelCalls: 'none',
      turnsMissingModelCalls: [],
      turnsWithFewerModelCallsThanSteps: [],
      unreadableRecords: 0,
    },
    ...overrides,
  };
}

describe('inspector panel model', () => {
  it('shows no coverage notice when the trace reports no known gap', () => {
    // A notice that always shows is a notice nobody reads.
    const model = deriveInspectorPanelModel(
      trace({
        coverage: {
          modelCalls: 'no_known_gap',
          turnsMissingModelCalls: [],
          turnsWithFewerModelCallsThanSteps: [],
          unreadableRecords: 0,
        },
      }),
    );

    assert.equal(model.coverage, undefined);
  });

  it('surfaces a partial coverage notice with what is missing', () => {
    const model = deriveInspectorPanelModel(
      trace({
        coverage: {
          modelCalls: 'partial',
          turnsMissingModelCalls: ['turn-1'],
          turnsWithFewerModelCallsThanSteps: ['turn-2', 'turn-3'],
          unreadableRecords: 2,
        },
      }),
    );

    assert.deepEqual(model.coverage, {
      kind: 'partial',
      turnsMissing: 1,
      turnsShort: 2,
      unreadableRecords: 2,
    });
  });

  it('leaves an unpriced model call without a cost rather than showing zero', () => {
    const model = deriveInspectorPanelModel(
      trace({
        turns: [
          {
            turnId: 'turn-1',
            runId: 'run-1',
            startedAt: 1_000,
            endedAt: 1_500,
            durationMs: 500,
            totals: emptyTraceTotals(),
            steps: [
              {
                kind: 'model_call',
                id: 'call-1',
                turnId: 'turn-1',
                runId: 'run-1',
                startedAt: 1_000,
                endedAt: 1_500,
                durationMs: 500,
                callKind: 'main',
                providerId: 'anthropic',
                modelId: 'claude-test',
                step: 0,
                attempts: [
                  {
                    attemptId: 'a-0',
                    attempt: 0,
                    status: 'completed',
                    startedAt: 1_000,
                    completedAt: 1_500,
                    latencyMs: 500,
                    costBasis: 'unpriced',
                    usageBasis: 'reported',
                  },
                ],
                status: 'completed',
              },
            ],
          },
        ],
      }),
    );

    const step = model.turns[0]?.steps[0];
    assert.equal(step?.label, 'claude-test');
    assert.equal(step?.retries, undefined, 'a single attempt is not a retry');
  });

  it('marks the attributed step as the failure, not every later step', () => {
    const model = deriveInspectorPanelModel(
      trace({
        turns: [
          {
            turnId: 'turn-1',
            runId: 'run-1',
            startedAt: 1_000,
            endedAt: 3_000,
            durationMs: 2_000,
            totals: emptyTraceTotals(),
            failure: { code: 'tool_failed', attributedToStepId: 'dispatch-1' },
            steps: [
              {
                kind: 'tool',
                id: 'dispatch-1',
                turnId: 'turn-1',
                runId: 'run-1',
                startedAt: 1_000,
                endedAt: 1_200,
                durationMs: 200,
                toolName: 'Bash',
                status: 'failed',
              } satisfies TraceStep,
              {
                kind: 'permission',
                id: 'permission-1',
                turnId: 'turn-1',
                runId: 'run-1',
                startedAt: 2_000,
                decision: 'allow',
              } satisfies TraceStep,
            ],
          },
        ],
      }),
    );

    const [tool, permission] = model.turns[0]!.steps;
    assert.equal(tool?.failed, true);
    assert.equal(permission?.failed, false, 'a later step is not implicated by sequence');
    assert.equal(model.turns[0]?.failureCode, 'tool_failed');
  });

  it('leaves the naming of kind-only steps to the panel', () => {
    // A compaction and an error have no identifier of their own. Baking
    // `label: 'compaction'` here would ship an English word to every locale
    // from a file that has no business choosing words.
    const model = deriveInspectorPanelModel(
      trace({
        turns: [
          {
            turnId: 'turn-1',
            runId: 'run-1',
            startedAt: 1_000,
            endedAt: 2_000,
            durationMs: 1_000,
            totals: emptyTraceTotals(),
            steps: [
              {
                kind: 'compaction',
                id: 'compaction-1',
                turnId: 'turn-1',
                runId: 'run-1',
                startedAt: 1_000,
                checkpointId: 'checkpoint-1',
              } satisfies TraceStep,
              {
                kind: 'error',
                id: 'error-1',
                turnId: 'turn-1',
                runId: 'run-1',
                startedAt: 1_500,
                message: 'sandbox denied the write',
              } satisfies TraceStep,
            ],
          },
        ],
      }),
    );

    const [compaction, error] = model.turns[0]!.steps;
    assert.equal(compaction?.label, undefined);
    assert.equal(compaction?.detail, undefined, 'the checkpoint id is not a reader-facing fact');
    assert.equal(error?.label, undefined);
    assert.equal(error?.detail, 'sandbox denied the write', 'the message is already words');
  });

  it('reports an empty model for a session with no turns', () => {
    assert.equal(deriveInspectorPanelModel(trace()).empty, true);
    assert.equal(deriveInspectorPanelModel(undefined).empty, true);
  });

  it('a session whose every record is unreadable is a gap, not an empty session', () => {
    // "Nothing to trace" and "N records nobody could read" are opposite claims;
    // rendering both is how unreadable spend hides in plain sight.
    const model = deriveInspectorPanelModel(
      trace({
        coverage: {
          modelCalls: 'partial',
          turnsMissingModelCalls: [],
          turnsWithFewerModelCallsThanSteps: [],
          unreadableRecords: 3,
        },
      }),
    );

    assert.equal(model.turns.length, 0);
    assert.equal(model.empty, false, 'a reported gap is never an empty session');
    assert.equal(model.coverage?.unreadableRecords, 3);
  });
});
