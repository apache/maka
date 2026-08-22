/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
