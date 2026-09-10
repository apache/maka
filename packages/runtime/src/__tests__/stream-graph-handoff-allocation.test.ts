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
import { test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import {
  DEFAULT_AGENT_GRAPH_HANDOFF_MAX_CONCLUSION_BYTES,
  hydrateAgentGraphInputHandoffs,
  renderAgentGraphScheduledWorkPrompt,
} from '../stream-graph-handoff.js';
import { projectAgentGraphRecords } from '../stream-graph-projection.js';
import { testInvocationRecord } from './invocation-fixture.js';

test('SQLite graph handoffs preserve their envelope while bounding oversized text iteration', async (t) => {
  const store = createSqliteRuntimeStore(':memory:');
  t.after(() => store.close());
  const run = testInvocationRecord({
    sessionId: 'handoff-session',
    invocationId: 'handoff-invocation',
    runId: 'handoff-run',
    turnId: 'handoff-turn',
  });
  const text = 'A'.repeat(256 * 1024);
  const result: RuntimeEvent = {
    id: 'handoff-result',
    invocationId: run.invocationId,
    sessionId: run.sessionId,
    runId: run.runId,
    turnId: run.turnId,
    ts: 11,
    role: 'model',
    author: 'agent',
    partial: false,
    content: { kind: 'text', text },
  };
  const terminal: RuntimeEvent = {
    ...result,
    id: 'handoff-terminal',
    ts: 12,
    role: 'system',
    author: 'system',
    content: undefined,
    status: 'completed',
    actions: { endInvocation: true },
  };
  for (const event of [result, terminal]) {
    await store.appendRuntimeEvent(run.sessionId, run.runId, event);
  }
  const records = projectAgentGraphRecords({
    graphId: 'bounded-handoff-graph',
    streams: [
      {
        operator: { operatorId: 'researcher', sessionId: run.sessionId },
        run,
        events: [result, terminal],
      },
    ],
  }).records;
  assert.equal(records.length, 2);
  const maxBytes = DEFAULT_AGENT_GRAPH_HANDOFF_MAX_CONCLUSION_BYTES;
  const iterationSteps: number[] = [];
  const originalIterator = String.prototype[Symbol.iterator];
  let reads = 0;

  // This file has one non-concurrent test. Restore the observer before assertions.
  t.mock.method(String.prototype, Symbol.iterator, function* (this: string) {
    const observed = this.toString() === text;
    let steps = 0;
    try {
      for (const point of originalIterator.call(this)) {
        if (observed) steps += 1;
        yield point;
      }
    } finally {
      if (observed) iterationSteps.push(steps);
    }
  });
  let handoffs;
  try {
    handoffs = await hydrateAgentGraphInputHandoffs({
      records,
      runtimeEventStore: {
        readImmutableRuntimeEvents(sessionId, runId) {
          reads += 1;
          return store.readImmutableRuntimeEvents(sessionId, runId);
        },
      },
    });
  } finally {
    t.mock.restoreAll();
  }

  assert.equal(reads, 1);
  assert.deepEqual(
    handoffs,
    records.map((record) => ({
      schemaVersion: 1,
      record: {
        recordId: record.recordId,
        graphId: record.graphId,
        operatorId: record.operatorId,
        activationId: record.activationId,
        facets: record.facets,
        source: record.source,
      },
      conclusion: {
        format: 'operator_handoff_markdown_v1',
        sourceRuntimeEventId: result.id,
        text: `${'A'.repeat(maxBytes - 3)}…`,
        originalBytes: 256 * 1024,
        textTruncated: true,
      },
    })),
  );
  for (let index = 0; index < records.length; index += 1) {
    assert.notEqual(handoffs[index]!.record.facets, records[index]!.facets);
    assert.notEqual(handoffs[index]!.record.source, records[index]!.source);
  }
  const prompt = renderAgentGraphScheduledWorkPrompt({
    work: {
      workId: 'review-work',
      status: 'requested',
      target: { kind: 'agent', agentId: 'reviewer' },
      instruction: 'Review the conclusion.',
      inputIds: records.map((record) => record.recordId),
      updateId: 'review-update',
      revision: 1,
      committedAt: 20,
    },
    inputHandoffs: handoffs,
  });
  const encoded = prompt
    .split('<agent_graph_input_handoffs encoding="json">\n')[1]!
    .split('\n</agent_graph_input_handoffs>')[0]!;
  assert.deepEqual(JSON.parse(encoded), handoffs);

  // Check behavior before the allocation bound so the old implementation fails
  // specifically for visiting the entire source, not for different output.
  assert.equal(iterationSteps.length, 2);
  assert.ok(
    iterationSteps.every((steps) => steps > 0 && steps <= maxBytes + 1),
    `oversized conclusions visited ${iterationSteps.join(', ')} code points; limit ${maxBytes + 1}`,
  );
});
