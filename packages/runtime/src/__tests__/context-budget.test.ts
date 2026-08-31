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
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { applyRuntimeEventContextBudget } from '../context-budget.js';
import { estimateRuntimeEventsTokens } from '../model-history.js';
import { buildHistoryCompactCheckpoint } from '../history-compact-checkpoint.js';

test('estimates only model-visible provider context', () => {
  const visible = textEvent('visible', 'visible context');
  const hidden = { ...textEvent('hidden', 'hidden context'), modelVisibility: 'hidden' as const };
  assert.equal(
    estimateRuntimeEventsTokens([visible, hidden], 1),
    estimateRuntimeEventsTokens([visible], 1),
  );
});

test('capacity policy keeps the canonical ledger until a checkpoint replaces it', () => {
  const events = [textEvent('user', 'large history '.repeat(100))];
  const result = applyRuntimeEventContextBudget(events, {
    maxHistoryEstimatedTokens: 1,
    historyCompact: { enabled: true },
  });
  assert.deepEqual(result?.events, events);
});

test('checkpoint replay uses the canonical ledger before stale tool results are pruned', () => {
  const payload = 'large tool result '.repeat(200);
  const serializedPayload = JSON.stringify(payload);
  const coveredEvents = [
    textEvent('user', 'inspect the result'),
    toolCallEvent('call'),
    toolResultEvent('result', payload),
  ];
  const tail = { ...textEvent('tail', 'newer history'), turnId: 'turn-2' };
  const checkpoint = buildHistoryCompactCheckpoint({
    sessionId: 'session-1',
    coveredRuntimeEvents: coveredEvents,
    charsPerToken: 1,
    providerState: {
      kind: 'openai_codex_remote_v2',
      connectionId: 'connection-codex',
      modelId: 'gpt-test',
      itemId: 'compact-item',
      encryptedContent: 'encrypted',
    },
  });

  const result = applyRuntimeEventContextBudget([...coveredEvents, tail], {
    charsPerToken: 1,
    historyCompact: { enabled: true, checkpoint },
  });

  assert.equal(result?.historyCompactCheckpoint?.checkpointId, checkpoint.checkpointId);
  assert.equal(result?.diagnostic.compactionDecisions?.[0]?.decision, 'replaced');
  assert.deepEqual(result?.events, [tail]);
});

function textEvent(id: string, text: string): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    status: 'completed',
    modelVisibility: 'visible',
    content: { kind: 'text', text },
  };
}

function toolCallEvent(id: string): RuntimeEvent {
  return {
    ...textEvent(id, ''),
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: 'tool-call', name: 'Bash', args: {} },
  };
}

function toolResultEvent(id: string, result: string): RuntimeEvent {
  return {
    ...textEvent(id, ''),
    role: 'tool',
    author: 'tool',
    content: { kind: 'function_response', id: 'tool-call', name: 'Bash', result },
  };
}
