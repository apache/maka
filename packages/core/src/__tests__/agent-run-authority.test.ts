import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeAgentRunHeader, type AgentRunHeader } from '../agent-run.js';

test('rejects a Run header with multiple hosted root authorities', () => {
  assert.throws(
    () =>
      decodeAgentRunHeader({
        ...runHeader(),
        scheduledTaskId: 'scheduled-task-1',
        goalId: 'goal-1',
      }),
    /Invalid AgentRun header schema/,
  );
});

test('decodes a released Automation Run as read-only legacy provenance', () => {
  const decoded = decodeAgentRunHeader({
    ...runHeader(),
    automationId: 'automation-1',
  });
  assert.equal(decoded.legacyAutomationId, 'automation-1');
  assert.equal(Object.hasOwn(decoded, 'automationId'), false);
});

function runHeader(): AgentRunHeader {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
  };
}
