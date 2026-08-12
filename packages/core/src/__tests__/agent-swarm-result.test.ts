import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ToolResultContent } from '../events.js';
import { decodeCanonicalToolResultContent } from '../tool-result-record-schema.js';
import { isCancelledToolResultContent, toolResultActivityStatus } from '../tool-result-status.js';

describe('agent swarm result contract', () => {
  test('rejects malformed or widened result rows', () => {
    assert.throws(
      () =>
        decodeCanonicalToolResultContent({
          ...agentSwarmResult(),
          items: [
            {
              ...agentSwarmResult().items[0],
              unexpected: true,
            },
          ],
        }),
      /Invalid tool result content/,
    );
    assert.throws(
      () =>
        decodeCanonicalToolResultContent({
          ...agentSwarmResult(),
          status: 'unknown',
        }),
      /Invalid tool result content/,
    );
  });

  test('keeps partial batches settled and classifies failed and cancelled batches', () => {
    const partial = { ...agentSwarmResult(), status: 'partial' as const };
    const failed = decodeCanonicalToolResultContent({
      ...agentSwarmResult(),
      status: 'failed',
      items: [{ ...agentSwarmResult().items[0], status: 'failed' }],
    });
    const cancelled = { ...agentSwarmResult(), status: 'cancelled' as const };

    assert.equal(toolResultActivityStatus(false, partial), 'completed');
    assert.equal(toolResultActivityStatus(true, failed), 'errored');
    assert.equal(isCancelledToolResultContent(cancelled), true);
    assert.equal(toolResultActivityStatus(true, cancelled), 'interrupted');
  });
});

function agentSwarmResult(): Extract<ToolResultContent, { kind: 'agent_swarm' }> {
  return {
    kind: 'agent_swarm',
    status: 'completed',
    items: [
      {
        itemId: 'auth',
        index: 0,
        profile: 'local_read',
        started: true,
        childSessionId: 'child-session-auth',
        agentId: 'local-read',
        agentName: 'Local Read',
        turnId: 'turn-auth',
        runId: 'run-auth',
        resumedFromRunId: 'run-auth-source',
        status: 'completed',
        summary: 'Auth boundaries are documented.',
        artifactIds: ['artifact-auth'],
        startedAt: 10,
        completedAt: 20,
        durationMs: 10,
      },
    ],
    startedAt: 10,
    completedAt: 20,
    durationMs: 10,
  };
}
