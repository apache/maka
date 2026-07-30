import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { projectAgentSwarmResult } from '../agent-swarm.js';
import type { ToolResultContent } from '../events.js';
import { decodeCanonicalToolResultContent } from '../tool-result-record-schema.js';
import { isCancelledToolResultContent, toolResultActivityStatus } from '../tool-result-status.js';

describe('agent swarm result contract', () => {
  test('decodes the exact structured result with stable child refs', () => {
    const result = agentSwarmResult();

    assert.deepEqual(decodeCanonicalToolResultContent(result), result);
  });

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
          status: 'failed',
        }),
      /Invalid tool result content/,
    );
  });

  test('keeps partial batches settled and classifies cancellation as interrupted', () => {
    const partial = { ...agentSwarmResult(), status: 'partial' as const };
    const cancelled = { ...agentSwarmResult(), status: 'cancelled' as const };

    assert.equal(toolResultActivityStatus(false, partial), 'completed');
    assert.equal(isCancelledToolResultContent(cancelled), true);
    assert.equal(toolResultActivityStatus(true, cancelled), 'interrupted');
  });

  test('projects bounded aggregate facts without duplicating child output', () => {
    const result = agentSwarmResult();
    result.items = [
      result.items[0]!,
      {
        itemId: 'storage',
        index: 1,
        profile: 'local_read',
        started: true,
        turnId: 'turn-storage',
        runId: 'run-storage',
        status: 'failed',
        summary: 'Storage inspection failed.',
        artifactIds: ['artifact-storage-1', 'artifact-storage-2'],
        durationMs: 20,
        failureClass: 'ChildFailed',
      },
      {
        itemId: 'tests',
        index: 2,
        profile: 'local_read',
        started: false,
        status: 'cancelled',
        summary: 'Cancelled before start.',
        artifactIds: [],
      },
    ];
    result.status = 'cancelled';
    result.durationMs = 30;

    assert.deepEqual(projectAgentSwarmResult(result), {
      status: 'cancelled',
      itemCount: 3,
      startedItemCount: 2,
      completedItemCount: 1,
      failedItemCount: 1,
      cancelledItemCount: 1,
      artifactCount: 3,
      durationMs: 30,
    });
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
