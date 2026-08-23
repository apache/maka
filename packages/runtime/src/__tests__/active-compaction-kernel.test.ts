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
import test from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';

import {
  activeCompactionCoverageFromEntries,
  buildActiveCompactionHeadAnchor,
  buildActiveCompactionSourceIndex,
  selectActiveCompactionSafeSpan,
  validateActiveCompactionCoverageForSourceIndex,
} from '../active-compaction-kernel.js';
import type { ModelMessage } from '../model-protocol.js';
import {
  ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
  type ActiveArchivedToolResultPlaceholder,
} from '../active-tool-result-prune.js';
import { ARCHIVED_TOOL_RESULT_REWRITE_VERSION } from '../tool-result-archive.js';

test('active compaction kernel selects only complete provider episodes after the head anchor', () => {
  const messages = fixtureMessages();
  const index = buildActiveCompactionSourceIndex({
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages,
    stepNumber: 2,
    charsPerToken: 1,
  });

  const selection = selectActiveCompactionSafeSpan({
    index,
    messages,
    headAnchor: buildActiveCompactionHeadAnchor(messages, 0, 1),
    policy: {
      enabled: true,
      minStepNumber: 1,
      highWaterRatio: 0.1,
      maxActiveEstimatedTokens: 1,
      minSafePrefixEstimatedTokens: 0,
      preserveRecentCompletedEpisodes: 1,
    },
  });

  assert.equal(selection.decision, 'selected');
  if (selection.decision !== 'selected') return;
  assert.equal(selection.startMessageIndex, 1);
  assert.equal(selection.endMessageIndex, 2);
  assert.deepEqual(selection.coverage.toolCallIds, ['call-1']);
  assert.equal(
    validateActiveCompactionCoverageForSourceIndex(selection.coverage, index).valid,
    true,
  );
});

test('active compaction kernel fails closed on hash drift and split tool pairs', () => {
  const messages = fixtureMessages();
  const index = buildActiveCompactionSourceIndex({
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages,
  });
  const callEntry = index.entries.find((entry) => entry.contentKind === 'function_call');
  assert.ok(callEntry);

  const splitCoverage = activeCompactionCoverageFromEntries([callEntry]);
  const splitValidation = validateActiveCompactionCoverageForSourceIndex(splitCoverage, index);
  assert.equal(splitValidation.valid, false);
  assert.ok(splitValidation.reasons.includes('tool_pair_split'));

  const hashValidation = validateActiveCompactionCoverageForSourceIndex(
    { ...splitCoverage, bodySha256: ['not-the-source-hash'] },
    index,
  );
  assert.equal(hashValidation.valid, false);
  assert.ok(hashValidation.reasons.includes('source_hash_mismatch'));
});

test('active compaction kernel does not relabel a tool result from a call-only runtime match', () => {
  const index = buildActiveCompactionSourceIndex({
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages: fixtureMessages(),
    runtimeEvents: [
      {
        id: 'event-call-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        ts: 1,
        partial: false,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'call-1',
          name: 'Read',
          args: { path: 'README.md' },
        },
      } satisfies RuntimeEvent,
    ],
  });

  const resultEntry = index.entries.find((entry) => entry.messageIndex === 2);
  assert.ok(resultEntry);
  assert.equal(resultEntry.contentKind, 'tool_result');
  assert.equal(resultEntry.runtimeEventId, undefined);
});

test('active compaction kernel binds runtime events by role exactly once', () => {
  const sharedText = 'same provider-visible text';
  const messages = [
    { role: 'user', content: sharedText },
    { role: 'assistant', content: sharedText },
    { role: 'assistant', content: sharedText },
  ] as ModelMessage[];
  const index = buildActiveCompactionSourceIndex({
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages,
    runtimeEvents: [
      runtimeTextEvent('event-user', 'user', sharedText),
      runtimeTextEvent('event-model', 'model', sharedText),
    ],
  });

  assert.equal(index.entries[0]?.runtimeEventId, 'event-user');
  assert.equal(index.entries[1]?.runtimeEventId, 'event-model');
  assert.equal(index.entries[2]?.runtimeEventId, undefined);
});

test('active compaction kernel leaves ambiguous runtime matches unbound', () => {
  const sharedText = 'ambiguous model text';
  const index = buildActiveCompactionSourceIndex({
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages: [{ role: 'assistant', content: sharedText }] as ModelMessage[],
    runtimeEvents: [
      runtimeTextEvent('event-model-1', 'model', sharedText),
      runtimeTextEvent('event-model-2', 'model', sharedText),
    ],
  });

  assert.equal(index.entries[0]?.runtimeEventId, undefined);
});

test('active compaction kernel fails open on duplicate or missing tool identities', () => {
  for (const messages of malformedToolEpisodes()) {
    const index = buildActiveCompactionSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      stepNumber: 2,
      charsPerToken: 1,
    });
    const selection = selectActiveCompactionSafeSpan({
      index,
      messages,
      headAnchor: buildActiveCompactionHeadAnchor(messages, 0, 1),
      policy: {
        enabled: true,
        minStepNumber: 1,
        highWaterRatio: 0.1,
        maxActiveEstimatedTokens: 1,
        minSafePrefixEstimatedTokens: 0,
      },
    });

    assert.ok(selection.decision === 'failedOpen');
    assert.equal(selection.reason, 'tool_pair_split');
  }
});

test('active compaction kernel preserves archived placeholder provenance with archiveRequired', () => {
  const placeholder = activePlaceholder();
  const messages = [
    { role: 'user', content: 'inspect the archive' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: placeholder.toolCallId,
          toolName: placeholder.toolName,
          input: { path: 'notes.md' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: placeholder.toolCallId,
          toolName: placeholder.toolName,
          output: { type: 'text', value: JSON.stringify(placeholder) },
        },
      ],
    },
  ] as ModelMessage[];
  const index = buildActiveCompactionSourceIndex({
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages,
    stepNumber: 2,
    charsPerToken: 1,
    runtimeEvents: [runtimeToolCallEvent(placeholder.toolCallId, placeholder.toolName)],
  });
  const archived = index.entries.find(
    (entry) => entry.contentKind === 'active_archive_placeholder',
  );

  assert.ok(archived);
  assert.equal(archived.archiveRef?.artifactId, placeholder.artifactId);
  assert.equal(archived.archiveRef?.bodySha256, placeholder.bodySha256);
  assert.equal(archived.archiveRef?.originalEstimatedTokens, placeholder.originalEstimatedTokens);
  assert.equal(archived.archiveRef?.originalBytes, placeholder.originalBytes);
  assert.equal(archived.toolCallId, placeholder.toolCallId);

  const selection = selectActiveCompactionSafeSpan({
    index,
    messages,
    headAnchor: buildActiveCompactionHeadAnchor(messages, 0, 1),
    policy: {
      enabled: true,
      minStepNumber: 1,
      highWaterRatio: 0.1,
      maxActiveEstimatedTokens: 1,
      minSafePrefixEstimatedTokens: 0,
      archiveRequired: true,
    },
  });
  assert.equal(selection.decision, 'selected');
});

test('active compaction kernel binds safe-span selection to the exact user head', () => {
  const messages = fixtureMessages();
  const headAnchor = buildActiveCompactionHeadAnchor(messages, 0);
  const changedMessages: ModelMessage[] = [
    { role: 'user', content: 'changed request' } as ModelMessage,
    ...messages.slice(1),
  ];
  const index = buildActiveCompactionSourceIndex({
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages: changedMessages,
  });

  const selection = selectActiveCompactionSafeSpan({
    index,
    messages: changedMessages,
    headAnchor,
    policy: { enabled: true, minStepNumber: 0 },
  });

  assert.equal(selection.decision, 'failedOpen');
  assert.equal(selection.reason, 'head_anchor_mismatch');
});

function fixtureMessages(): ModelMessage[] {
  return [
    { role: 'user', content: 'inspect the repository' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'Read',
          input: { path: 'README.md' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'Read',
          output: { type: 'text', value: 'contents' },
        },
      ],
    },
    { role: 'assistant', content: 'The repository is ready.' },
  ] as ModelMessage[];
}

function runtimeTextEvent(id: string, role: RuntimeEvent['role'], text: string): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role,
    author: role === 'user' ? 'user' : 'agent',
    content: { kind: 'text', text },
  };
}

function runtimeToolCallEvent(toolCallId: string, toolName: string): RuntimeEvent {
  return {
    id: 'event-call',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: toolCallId,
      name: toolName,
      args: { path: 'notes.md' },
    },
  };
}

function activePlaceholder(): ActiveArchivedToolResultPlaceholder {
  return {
    kind: ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
    rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
    artifactId: 'artifact-tool-1',
    turnId: 'turn-1',
    toolCallId: 'call-archive-1',
    toolName: 'Read',
    bodySha256: 'a'.repeat(64),
    originalEstimatedTokens: 123,
    originalBytes: 456,
    reason: 'active_current_turn_tool_result_pruned_before_next_step',
  };
}

function malformedToolEpisodes(): ModelMessage[][] {
  const head = { role: 'user', content: 'inspect' } as ModelMessage;
  const call = (toolCallId?: string) =>
    ({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          ...(toolCallId ? { toolCallId } : {}),
          toolName: 'Read',
          input: { path: 'README.md' },
        },
      ],
    }) as ModelMessage;
  const result = (toolCallId: string) =>
    ({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: 'Read',
          output: { type: 'text', value: 'contents' },
        },
      ],
    }) as ModelMessage;
  return [
    [head, call('duplicate'), call('duplicate'), result('duplicate')],
    [head, call('duplicate'), result('duplicate'), result('duplicate')],
    [head, call(), result('missing')],
  ];
}
