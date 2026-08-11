import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION,
  isAgentGraphScheduleUpdateRequest,
  type AgentGraphScheduleUpdateRequest,
} from '../agent-graph-schedule.js';

describe('agent graph schedule contract', () => {
  test('rejects ambiguous, duplicate, empty, and add-plus-finish updates', () => {
    assert.equal(
      isAgentGraphScheduleUpdateRequest({
        ...scheduleRequest(),
        addWork: [
          {
            ...scheduleRequest().addWork[0],
            target: { kind: 'agent', agentId: '' },
          },
        ],
      }),
      false,
    );
    assert.equal(
      isAgentGraphScheduleUpdateRequest({
        ...scheduleRequest(),
        addWork: [],
        stop: [],
      }),
      false,
    );
    assert.equal(
      isAgentGraphScheduleUpdateRequest({
        ...scheduleRequest(),
        addWork: [],
        stop: [
          { targetId: 'work-1', reason: 'stop duplicate work' },
          { targetId: 'work-1', reason: 'stop duplicate work again' },
        ],
      }),
      false,
    );
    assert.equal(
      isAgentGraphScheduleUpdateRequest({
        ...scheduleRequest(),
        finish: { resultIds: ['result-1'], reason: 'enough evidence' },
      }),
      false,
    );
  });
});

function scheduleRequest(): AgentGraphScheduleUpdateRequest {
  return {
    schemaVersion: AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION,
    updateId: `graph_update_${'a'.repeat(32)}`,
    updateFingerprint: `sha256:${'b'.repeat(64)}`,
    graphId: 'graph-1',
    source: {
      sessionId: 'session-main',
      runId: 'run-main',
      turnId: 'turn-main',
      toolCallId: 'tool-main',
    },
    addWork: [
      {
        workId: `graph_work_${'c'.repeat(32)}`,
        target: { kind: 'agent', agentId: 'fact-checker' },
        instruction: 'Verify the selected evidence.',
        inputIds: ['result-1'],
      },
    ],
    stop: [],
  };
}
