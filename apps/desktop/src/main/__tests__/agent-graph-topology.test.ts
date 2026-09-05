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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type {
  AgentGraphClientEdge,
  AgentGraphClientOperator,
} from '@maka/runtime/stream-graph-read-model';
import {
  agentGraphEdgePath,
  agentGraphStatusSemantic,
  firstScheduledWorkPreview,
  layoutAgentGraph,
  revealAgentGraphNode,
  scheduledWorkPresentation,
} from '../../renderer/features/agent-graph/testing.js';

describe('layoutAgentGraph', () => {
  it('preserves graph operator status semantics', () => {
    assert.equal(agentGraphStatusSemantic('running'), 'active');
    assert.equal(agentGraphStatusSemantic('blocked'), 'attention');
    assert.equal(agentGraphStatusSemantic('completed'), 'success');
    assert.equal(agentGraphStatusSemantic('failed'), 'error');
  });

  it('uses the bounded preview without duplicating its truncation marker', () => {
    const preview = firstScheduledWorkPreview(operator('a', ['work-a']), [
      {
        workId: 'work-a',
        target: { kind: 'operator', operatorId: 'a' },
        inputIds: [],
        status: 'requested',
        instructionPreview: 'Collect inputs…',
        instructionTruncated: true,
        revision: 1,
        committedAt: 1,
      },
    ]);

    assert.equal(preview, 'Collect inputs…');
  });

  it('prefers the newest requested work and does not substitute an operator id', () => {
    const selected = firstScheduledWorkPreview(operator('a', ['old', 'stopped', 'new']), [
      work('old', 'requested', 1, 'Old request'),
      work('stopped', 'stopped', 3, 'Stopped request'),
      work('new', 'requested', 2, 'New request'),
    ]);

    assert.equal(selected, 'New request');
    assert.equal(firstScheduledWorkPreview(operator('b'), []), undefined);
  });

  it('counts operator work omitted by both operator and snapshot bounds', () => {
    const boundedOperator = operator('a', ['visible', 'snapshot-omitted']);
    boundedOperator.omitted.scheduledWorkIds = 2;

    assert.deepEqual(
      scheduledWorkPresentation(boundedOperator, [
        work('visible', 'requested', 1, 'Visible request'),
      ]),
      { preview: 'Visible request', omitted: 3 },
    );
  });

  it('places a dependency chain in successive columns', () => {
    const layout = layoutAgentGraph(
      [operator('a'), operator('b'), operator('c')],
      [edge('a-b', 'a', 'b'), edge('b-c', 'b', 'c')],
    );
    const positions = positionMap(layout.nodes);

    assert.ok(positions.a.x < positions.b.x);
    assert.ok(positions.b.x < positions.c.x);
    assert.equal(positions.a.y, positions.b.y);
    assert.equal(positions.b.y, positions.c.y);
  });

  it('keeps fan-out peers together and places their join downstream', () => {
    const layout = layoutAgentGraph(
      [operator('a'), operator('b'), operator('c'), operator('d')],
      [edge('a-b', 'a', 'b'), edge('a-c', 'a', 'c'), edge('b-d', 'b', 'd'), edge('c-d', 'c', 'd')],
    );
    const positions = positionMap(layout.nodes);

    assert.equal(positions.b.x, positions.c.x);
    assert.notEqual(positions.b.y, positions.c.y);
    assert.ok(positions.a.x < positions.b.x);
    assert.ok(positions.b.x < positions.d.x);
  });

  it('keeps depth propagated from visited ancestors when edges form a cycle', () => {
    const layout = layoutAgentGraph(
      [operator('a'), operator('b'), operator('c')],
      [edge('a-b', 'a', 'b'), edge('b-c', 'b', 'c'), edge('c-b', 'c', 'b')],
    );
    const positions = positionMap(layout.nodes);

    assert.ok(positions.a.x < positions.b.x);
  });

  it('ignores omitted edge endpoints without moving visible nodes', () => {
    const operators = [operator('a'), operator('b')];
    const complete = layoutAgentGraph(operators, [edge('a-b', 'a', 'b')]);
    const partial = layoutAgentGraph(operators, [
      edge('a-b', 'a', 'b'),
      edge('missing-a', 'missing', 'a'),
      edge('b-missing', 'b', 'missing'),
    ]);

    assert.deepEqual(partial, complete);
  });

  it('keeps rows stable when the read model reorders operators by lifecycle state', () => {
    const original = [operator('a', [], 1), operator('b', [], 2), operator('c', [], 3)];
    const reordered = [
      { ...original[2]!, status: 'running' as const },
      { ...original[0]!, status: 'completed' as const },
      { ...original[1]!, status: 'waiting' as const },
    ];

    assert.deepEqual(
      positionMap(layoutAgentGraph(original, []).nodes),
      positionMap(layoutAgentGraph(reordered, []).nodes),
    );
  });

  it('routes skip-level edges through the gap above intervening nodes', () => {
    const layout = layoutAgentGraph(
      [operator('a'), operator('b'), operator('c'), operator('d')],
      [edge('a-b', 'a', 'b'), edge('b-c', 'b', 'c'), edge('c-d', 'c', 'd')],
    );
    const positions = positionMap(layout.nodes);
    const path = agentGraphEdgePath(positions.a, positions.d);

    assert.doesNotMatch(path, / C /u);
    assert.match(path, / L \d+ 8 L \d+ 8 /u);
    assert.ok(8 < positions.b.y);
    assert.ok(8 < positions.c.y);
  });

  it('reveals a node without scrolling an ancestor', () => {
    const viewport = {
      clientHeight: 168,
      clientWidth: 240,
      scrollLeft: 10,
      scrollTop: 20,
    };

    revealAgentGraphNode(viewport, { operatorId: 'a', x: 300, y: 220 });

    assert.deepEqual(viewport, {
      clientHeight: 168,
      clientWidth: 240,
      scrollLeft: 268,
      scrollTop: 156,
    });
  });
});

function operator(
  operatorId: string,
  scheduledWorkIds: string[] = [],
  provisionedAt = 1,
): AgentGraphClientOperator {
  return {
    operatorId,
    childSessionId: `session-${operatorId}`,
    provisionId: `provision-${operatorId}`,
    agentId: `agent-${operatorId}`,
    provisionedAt,
    status: 'not_started',
    inboundEdgeIds: [],
    outboundEdgeIds: [],
    scheduledWorkIds,
    readiness: [],
    omitted: {
      inboundEdgeIds: 0,
      outboundEdgeIds: 0,
      scheduledWorkIds: 0,
      readiness: 0,
      readinessWaits: 0,
    },
  };
}

function work(
  workId: string,
  status: 'requested' | 'stopped' | 'superseded',
  revision: number,
  instructionPreview: string,
) {
  return {
    workId,
    target: { kind: 'operator' as const, operatorId: 'a' },
    inputIds: [],
    status,
    instructionPreview,
    instructionTruncated: false,
    revision,
    committedAt: revision,
  };
}

function edge(edgeId: string, fromOperatorId: string, toOperatorId: string): AgentGraphClientEdge {
  return { edgeId, fromOperatorId, toOperatorId };
}

function positionMap(nodes: readonly { operatorId: string; x: number; y: number }[]) {
  return Object.fromEntries(nodes.map((node) => [node.operatorId, node])) as Record<
    string,
    { operatorId: string; x: number; y: number }
  >;
}
