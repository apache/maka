import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  aggregateMessageContents,
  failureClassFromCompleteStopReason,
  TOOL_OUTPUT_DELTA_MAX_CHARS,
  TOOL_OUTPUT_STREAMS,
} from '../events.js';

test('aggregates inline references against the combined display text', () => {
  expect(
    aggregateMessageContents([
      {
        text: '<skill>Alpha</skill>\n\nFirst',
        displayText: '/skill:alpha First',
        inlineReferences: [{ kind: 'skill', value: '/skill:alpha', label: 'Alpha', start: 0 }],
      },
      {
        text: '<skill>Beta</skill>\n\nSecond',
        displayText: '/skill:beta Second',
        inlineReferences: [{ kind: 'skill', value: '/skill:beta', label: 'Beta', start: 0 }],
      },
    ]),
  ).toEqual({
    text: '<skill>Alpha</skill>\n\nFirst\n\n<skill>Beta</skill>\n\nSecond',
    displayText: '/skill:alpha First\n\n/skill:beta Second',
    inlineReferences: [
      { kind: 'skill', value: '/skill:alpha', label: 'Alpha', start: 0 },
      { kind: 'skill', value: '/skill:beta', label: 'Beta', start: 20 },
    ],
  });
});

test('preserves an explicit empty inline-reference marker while aggregating', () => {
  expect(aggregateMessageContents([{ text: 'plain', inlineReferences: [] }])).toEqual({
    text: 'plain',
    inlineReferences: [],
  });
});

describe('ToolOutputDelta event contract', () => {
  test('locks finite stream union and chunk bound constant', () => {
    expect(TOOL_OUTPUT_STREAMS).toEqual(['stdout', 'stderr']);
    expect(TOOL_OUTPUT_DELTA_MAX_CHARS).toBe(8192);
  });
});

describe('failureClassFromCompleteStopReason', () => {
  test('defines the shared failure vocabulary for incomplete turns', () => {
    expect(failureClassFromCompleteStopReason('error')).toBe('runtime_error');
    expect(failureClassFromCompleteStopReason('step_limit')).toBe('tool_step_cap_reached');
    expect(failureClassFromCompleteStopReason('end_turn')).toBe(undefined);
    expect(failureClassFromCompleteStopReason('max_tokens')).toBe(undefined);
    expect(failureClassFromCompleteStopReason('plan_handoff')).toBe(undefined);
    expect(failureClassFromCompleteStopReason('permission_handoff')).toBe(undefined);
    expect(failureClassFromCompleteStopReason('user_stop')).toBe(undefined);
    expect(failureClassFromCompleteStopReason('context_budget_exhausted')).toBe(
      'context_budget_exhausted',
    );
  });
});
