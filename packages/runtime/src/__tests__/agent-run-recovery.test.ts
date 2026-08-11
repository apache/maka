import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentRunHeader } from '@maka/core/agent-run';
import { classifyAgentRunRecovery } from '../agent-run-recovery.js';

describe('AgentRun startup recovery', () => {
  test('fails a graph supervisor permission handoff once its live waiter is lost', () => {
    const header: AgentRunHeader = {
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      status: 'waiting_for_user',
      backendKind: 'fake',
      llmConnectionSlug: 'fake',
      modelId: 'fake-model',
      cwd: '/tmp/workspace',
      permissionMode: 'ask',
      agentGraphWakeId: 'wake-1',
      agentGraphWakeAttemptId: 'attempt-1',
      createdAt: 1,
      updatedAt: 2,
    };

    const decision = classifyAgentRunRecovery(header, []);
    assert.equal(decision?.status, 'failed');
    assert.equal(decision?.failureClass, 'app_restarted');
    assert.equal(decision?.diagnostic?.recoveryReason, 'stale_user_wait');
  });
});
