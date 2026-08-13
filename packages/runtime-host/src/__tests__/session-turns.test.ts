import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeSessionTurnsQueryResult,
  projectSessionTurnContribution,
  projectSessionTurnContributionForWire,
  SESSION_TURN_DIAGNOSTIC_MAX_BYTES,
} from '../protocol/session-turns.js';

test('keeps legacy assistant presence distinct from retained output', () => {
  assert.deepEqual(
    projectSessionTurnContribution({
      turnId: 'turn-1',
      firstSequence: 0,
      latestState: null,
      userPromptPreview: 'hello',
      hasAssistantMessage: true,
      hasAssistantOutput: false,
      hasToolResult: false,
      hasFailedToolResult: true,
      hasAbortNote: false,
    }),
    {
      turnId: 'turn-1',
      firstSequence: 0,
      userPromptPreview: 'hello',
      status: 'completed',
      statusSource: 'inferred',
      partialOutputRetained: false,
    },
  );
});

test('bounds turn diagnostics before publishing a contribution', () => {
  const contribution = projectSessionTurnContributionForWire({
    turnId: 'turn-1',
    firstSequence: 0,
    latestState: {
      sequence: 0,
      message: {
        type: 'turn_state',
        id: 'state-1',
        turnId: 'turn-1',
        ts: 1,
        status: 'failed',
        partialOutputRetained: false,
        errorClass: '失败'.repeat(100_000),
      },
    },
    userPromptPreview: 'hello',
    hasAssistantMessage: false,
    hasAssistantOutput: false,
    hasToolResult: false,
    hasFailedToolResult: false,
    hasAbortNote: false,
  });

  assert.ok(
    Buffer.byteLength(contribution.latestState!.message.errorClass!, 'utf8') <=
      SESSION_TURN_DIAGNOSTIC_MAX_BYTES,
  );
  assert.doesNotThrow(() =>
    decodeSessionTurnsQueryResult({
      sessionId: 'session-1',
      throughSequence: 0,
      contributions: [contribution],
      nextPosition: null,
    }),
  );
});

test('rejects invalid turn-state references before publishing a contribution', () => {
  assert.throws(() =>
    projectSessionTurnContributionForWire({
      turnId: 'turn-1',
      firstSequence: 0,
      latestState: {
        sequence: 0,
        message: {
          type: 'turn_state',
          id: 'state-1',
          turnId: 'turn-1',
          ts: 1,
          status: 'completed',
          parentTurnId: 'x'.repeat(129),
          partialOutputRetained: false,
        },
      },
      userPromptPreview: null,
      hasAssistantMessage: false,
      hasAssistantOutput: false,
      hasToolResult: false,
      hasFailedToolResult: false,
      hasAbortNote: false,
    }),
  );
});
