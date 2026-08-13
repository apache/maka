import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isAgentGraphOperatorProvisionRequest,
  type AgentGraphOperatorProvisionRequest,
} from '../agent-graph-topology.js';

describe('agent graph topology provisions', () => {
  test('strictly validates one monotonic operator addition', () => {
    const request = provisionRequest();
    assert.equal(
      isAgentGraphOperatorProvisionRequest({
        ...request,
        edges: [...request.edges, { ...request.edges[0]!, edgeId: `graph_edge_${'9'.repeat(32)}` }],
      }),
      false,
    );
    assert.equal(
      isAgentGraphOperatorProvisionRequest({
        ...request,
        edges: [{ ...request.edges[0]!, toOperatorId: 'another-operator' }],
      }),
      false,
    );
  });
});

function provisionRequest(): AgentGraphOperatorProvisionRequest {
  const operatorId = `graph_operator_${'4'.repeat(32)}`;
  return {
    schemaVersion: 1,
    provisionId: `graph_provision_${'1'.repeat(32)}`,
    provisionFingerprint: `sha256:${'2'.repeat(64)}`,
    graphId: 'graph-1',
    workId: `graph_work_${'3'.repeat(32)}`,
    agentId: 'local-read',
    operatorId,
    initialTurnId: 'turn-1',
    initialRunId: 'run-1',
    edges: [
      {
        edgeId: `graph_edge_${'5'.repeat(32)}`,
        fromOperatorId: 'writer',
        toOperatorId: operatorId,
      },
    ],
  };
}
