import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { emptyTraceTotals, type TraceTotals } from '@maka/core/session-trace';
import {
  applyInspectorFilter,
  isEmptyInspectorFilter,
} from '../../renderer/session-inspector-filter.js';
import type {
  InspectorPanelModel,
  InspectorStepRow,
  InspectorTurnRow,
} from '../../renderer/session-inspector-panel-model.js';

function step(overrides: Partial<InspectorStepRow> = {}): InspectorStepRow {
  return {
    id: 'step-1',
    kind: 'model_call',
    label: 'claude-test',
    failed: false,
    ...overrides,
  };
}

function turn(overrides: Partial<InspectorTurnRow> = {}): InspectorTurnRow {
  return {
    turnId: 'turn-1',
    startedAt: 1_000,
    durationMs: 500,
    totals: emptyTraceTotals(),
    failed: false,
    steps: [step()],
    ...overrides,
  };
}

function model(turns: InspectorTurnRow[], totals: TraceTotals = emptyTraceTotals()): InspectorPanelModel {
  return { turns, totals, empty: turns.length === 0 };
}

describe('inspector filter', () => {
  it('treats an absent or blank filter as no filter at all', () => {
    assert.equal(isEmptyInspectorFilter(undefined), true);
    assert.equal(isEmptyInspectorFilter({ query: '   ' }), true);
    assert.equal(isEmptyInspectorFilter({ query: 'bash' }), false);
    assert.equal(isEmptyInspectorFilter({ failedOnly: true }), false);

    const source = model([turn()]);
    const result = applyInspectorFilter(source, undefined);
    assert.equal(result.filtered, false);
    assert.deepEqual(result.turns, source.turns);
  });

  it('matches free text across the fields the panel renders', () => {
    const source = model([
      turn({
        turnId: 'turn-a',
        steps: [step({ id: 'a', kind: 'tool', label: 'Bash' }), step({ id: 'b', label: 'gpt-x' })],
      }),
    ]);

    const byTool = applyInspectorFilter(source, { query: 'bash' });
    assert.deepEqual(
      byTool.turns[0]?.steps.map((entry) => entry.id),
      ['a'],
      'case-insensitive on the tool name',
    );
    assert.equal(byTool.hiddenSteps, 1);

    const byModel = applyInspectorFilter(source, { query: 'GPT' });
    assert.deepEqual(byModel.turns[0]?.steps.map((entry) => entry.id), ['b']);
  });

  it('keeps a turn whose id matches even when it has no steps at all', () => {
    // The zero-step path is the one worth pinning: with steps present, the step
    // haystack could carry the match instead and the branch would never run.
    const source = model([turn({ turnId: 'turn-a', steps: [] })]);
    const result = applyInspectorFilter(source, { query: 'turn-a' });

    assert.equal(result.turns.length, 1, 'answering "where is turn-a" with silence is wrong');
    assert.equal(result.hiddenTurns, 0);
    assert.equal(result.turns[0]?.steps.length, 0);
  });

  it('keeps a failed turn with no steps when the filter asks only about outcome', () => {
    // A turn that failed before recording a step is exactly what "failed only"
    // is asked to surface; a text-free filter must not drop it for being empty.
    const source = model([
      turn({ turnId: 'ok' }),
      turn({ turnId: 'bad', failed: true, steps: [] }),
    ]);
    const result = applyInspectorFilter(source, { failedOnly: true });

    assert.deepEqual(
      result.turns.map((entry) => entry.turnId),
      ['bad'],
    );
  });

  it('does not let one turn-level failure message retain every step', () => {
    // Turn text belongs to the turn. Folding it into each step's haystack made
    // a single match keep steps that explain nothing about it.
    const source = model([
      turn({
        turnId: 'turn-a',
        failed: true,
        failureMessage: 'disk full',
        steps: [step({ id: 'a', label: 'Bash' }), step({ id: 'b', label: 'claude' })],
      }),
    ]);

    const result = applyInspectorFilter(source, { query: 'disk full' });
    assert.equal(result.turns.length, 0, 'no rendered row explains that phrase');
  });

  it('failed-only drops whole turns that succeeded', () => {
    const source = model([
      turn({ turnId: 'ok' }),
      turn({ turnId: 'bad', failed: true, failureCode: 'tool_failed' }),
    ]);

    const result = applyInspectorFilter(source, { failedOnly: true });
    assert.deepEqual(result.turns.map((entry) => entry.turnId), ['bad']);
    assert.equal(result.hiddenTurns, 1);
  });

  it('a filter that matches nothing is not an empty session', () => {
    // "Nothing matches your filter" and "this session did nothing" are
    // different claims, and only the panel can tell the reader which it is.
    const source = model([turn()]);
    const result = applyInspectorFilter(source, { query: 'no-such-thing' });

    assert.equal(result.turns.length, 0);
    assert.equal(result.filtered, true);
    assert.equal(result.hiddenTurns, 1);
    assert.equal(result.empty, false, 'the session still happened');
  });

  it('leaves session totals alone so a filtered view cannot restate the bill', () => {
    // Totals answer "what did this session cost". Recomputing them per filter
    // would produce a number that is true of nothing.
    const totals: TraceTotals = { ...emptyTraceTotals(), modelAttempts: 4, costUsd: 0.2 };
    const source = model([turn({ steps: [step({ costUsd: 0.05 })] })], totals);

    const result = applyInspectorFilter(source, { query: 'no-such-thing' });
    assert.deepEqual(result.totals, totals);
  });
});
