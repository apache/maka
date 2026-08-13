import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSessionTurnContribution } from '../protocol/session-turns.js';

test('keeps legacy assistant presence distinct from retained output', () => {
  assert.deepEqual(
    projectSessionTurnContribution({
      turnId: 'turn-1',
      firstSequence: 0,
      latestState: null,
      hasAssistantMessage: true,
      hasAssistantOutput: false,
      hasToolResult: false,
      hasFailedToolResult: true,
      hasAbortNote: false,
    }),
    {
      turnId: 'turn-1',
      status: 'completed',
      statusSource: 'inferred',
      partialOutputRetained: false,
    },
  );
});
