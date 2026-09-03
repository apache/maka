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
import {
  applyRuntimeEventContextBudget,
  shouldAppendContextCompactedNote,
  shouldAppendContextCompactionFailedOpenNote,
} from '../context-budget.js';
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

test('compaction notes fire for a fold made by the request hook, not only for a replay', () => {
  // Since #4486 every new fold happens in the request-projection hook
  // (`activeStep`); the turn that was compacted must show the note in that
  // turn, not one turn later when the checkpoint is replayed (#4559).
  const shell = {
    enabled: true,
    estimatedTokensBefore: 1,
    estimatedTokensAfter: 1,
    keptTurns: 1,
    droppedTurns: 0,
    keptEvents: 1,
    droppedEvents: 0,
  };
  const decision = (stage: 'priorReplay' | 'activeStep', outcome: 'replaced' | 'failedOpen') => ({
    ...shell,
    compactionDecisions: [
      {
        stage,
        sourceKind: 'runtimeEvents' as const,
        decision: outcome,
        boundaryKind: 'historyCompact' as const,
      },
    ],
  });
  assert.equal(shouldAppendContextCompactedNote(decision('activeStep', 'replaced')), true);
  assert.equal(shouldAppendContextCompactedNote(decision('priorReplay', 'replaced')), true);
  assert.equal(shouldAppendContextCompactedNote(decision('activeStep', 'failedOpen')), false);
  assert.equal(
    shouldAppendContextCompactionFailedOpenNote(decision('activeStep', 'failedOpen')),
    true,
  );
  assert.equal(
    shouldAppendContextCompactionFailedOpenNote(decision('priorReplay', 'failedOpen')),
    true,
  );
  assert.equal(
    shouldAppendContextCompactionFailedOpenNote(decision('priorReplay', 'replaced')),
    false,
  );
  // A non-history boundary never speaks as a history compaction.
  assert.equal(
    shouldAppendContextCompactedNote({
      ...shell,
      compactionDecisions: [
        {
          stage: 'activeStep',
          sourceKind: 'runtimeEvents',
          decision: 'replaced',
          boundaryKind: 'activeToolResultPrune',
        },
      ],
    } as never),
    false,
  );
  assert.equal(shouldAppendContextCompactedNote(undefined), false);
});
