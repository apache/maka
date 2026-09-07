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

/**
 * Budgeting, summarization, and checkpoint source digests must all read the
 * EFFECTIVE model history — the durable Tool Result projection committed at T2
 * — and never the raw execution fact it replaced (apache/maka#4283, PR 2).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import { estimateRuntimeEventsTokens } from '../model-history.js';
import {
  buildHistoryCompactCheckpoint,
  matchHistoryCompactCheckpointPrefix,
  validateHistoryCompactCheckpointShape,
} from '../history-compact-checkpoint.js';
import {
  buildLlmHistorySummarizer,
  type AiSdkGenerateTextLike,
} from '../history-compact-summarizer.js';

const RAW_SECRET = 'RAW-EXECUTION-EVIDENCE-'.repeat(200);
const PROJECTED = 'bounded model-visible result';

const STRUCTURED_SUMMARY = [
  '## Goal',
  'X',
  '',
  '## Progress',
  '- done',
  '',
  '## Next Steps',
  '1. continue',
  '',
  '## Critical Context',
  '- (none)',
].join('\n');

describe('effective model history feeds budgeting and compaction', () => {
  test('budgeting sizes the durable projection, not the raw execution fact', () => {
    const projected = toolResultEvent('evt-3', RAW_SECRET, textProjection(PROJECTED));
    const raw = toolResultEvent('evt-3', RAW_SECRET);

    // Same raw result, but only the un-projected legacy event is sized by it.
    assert.equal(estimateRuntimeEventsTokens([projected], 1), 'Bash'.length + PROJECTED.length);
    assert.ok(estimateRuntimeEventsTokens([raw], 1) > RAW_SECRET.length);
  });

  test('budgeting prices an artifact by what materialization rehydrates', () => {
    const text = toolResultEvent('evt-3', RAW_SECRET, textProjection(PROJECTED));
    const artifact = toolResultEvent('evt-3', RAW_SECRET, artifactProjection(PROJECTED));

    // The two projections serialize to comparable strings, but only one of them
    // puts image bytes in the request.
    assert.ok(
      estimateRuntimeEventsTokens([artifact], 1) - estimateRuntimeEventsTokens([text], 1) >= 1000,
    );
  });

  test('summarization cannot read raw output the projection replaced', async () => {
    let seen: Parameters<AiSdkGenerateTextLike>[0] | undefined;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async (options) => {
        seen = options;
        return { text: STRUCTURED_SUMMARY };
      },
    });

    await summarize({
      sessionId: 'session-1',
      turnId: 'turn-1',
      source: {
        foldedRuntimeEvents: [
          userEvent('evt-1', 'run it'),
          toolCallEvent('evt-2'),
          toolResultEvent('evt-3', RAW_SECRET, textProjection(PROJECTED)),
        ],
      },
    });

    const serialized = JSON.stringify(seen?.messages ?? []);
    assert.ok(serialized.includes(PROJECTED));
    assert.equal(serialized.includes('RAW-EXECUTION-EVIDENCE-'), false);
  });

  test('the source digest ignores raw evidence but tracks the effective projection', () => {
    const covered = [
      userEvent('evt-1', 'run it'),
      toolCallEvent('evt-2'),
      toolResultEvent('evt-3', RAW_SECRET, textProjection(PROJECTED)),
    ];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: covered,
      summary: STRUCTURED_SUMMARY,
      charsPerToken: 1,
    });

    // Raw evidence rewritten under an unchanged projection: still the same
    // folded model history, so the checkpoint keeps replaying.
    const rawRewritten = [
      ...covered.slice(0, 2),
      toolResultEvent('evt-3', 'a different raw fact', textProjection(PROJECTED)),
    ];
    assert.equal(matchHistoryCompactCheckpointPrefix(checkpoint, rawRewritten).reason, undefined);

    // The projection itself replaced: the folded content is no longer what
    // this checkpoint covered, so it must not replay over it.
    const projectionReplaced = [
      ...covered.slice(0, 2),
      toolResultEvent('evt-3', RAW_SECRET, textProjection('[archived]')),
    ];
    assert.equal(
      matchHistoryCompactCheckpointPrefix(checkpoint, projectionReplaced).reason,
      'source_hash_mismatch',
    );
  });

  test('a checkpoint minted under the raw-source policy no longer validates', () => {
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [userEvent('evt-1', 'run it')],
      summary: STRUCTURED_SUMMARY,
      charsPerToken: 1,
    });
    const legacy = {
      ...checkpoint,
      source: {
        ...checkpoint.source,
        policyVersion: 'maka.compactable_runtime_event_projection.v1',
      },
    } as unknown as typeof checkpoint;

    assert.equal(validateHistoryCompactCheckpointShape(checkpoint, 'session-1'), true);
    assert.equal(validateHistoryCompactCheckpointShape(legacy, 'session-1'), false);
  });
});

function textProjection(text: string): DurableToolResultProjection {
  return { version: 1, kind: 'text', text };
}

function artifactProjection(text: string): DurableToolResultProjection {
  return {
    version: 1,
    kind: 'content',
    parts: [
      { kind: 'text', text },
      {
        kind: 'artifact',
        mediaType: 'image/png',
        ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'artifact-1' },
      },
    ],
  };
}

function userEvent(id: string, text: string): RuntimeEvent {
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
    ...userEvent(id, ''),
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: 'tool-call', name: 'Bash', args: {} },
  };
}

function toolResultEvent(
  id: string,
  result: string,
  modelProjection?: DurableToolResultProjection,
): RuntimeEvent {
  return {
    ...userEvent(id, ''),
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'tool-call',
      name: 'Bash',
      result,
      ...(modelProjection ? { modelProjection } : {}),
    },
  };
}
