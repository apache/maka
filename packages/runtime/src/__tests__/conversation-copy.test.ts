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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AgentRunStore, EmittedAgentRunEvent } from '@maka/core/agent-run';
import type { RuntimeEvent, RuntimeEventInvocationOpenedContent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { StoredMessage } from '@maka/core/session';
import { decodeCanonicalToolResultContent } from '@maka/core/tool-result-record-schema';
import { decodeModelCallAttempt } from '@maka/core/model-call-attempt';
import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import {
  buildModelProjectionTransition,
  MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
  type ModelProjectionTransition,
} from '@maka/core/model-projection-transition';
import {
  buildInvocationOpenedEvent,
  isSessionInlineInvocation,
  type RuntimeInvocationRecord,
} from '@maka/core/runtime-invocation';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { sectionedSummary } from './history-compact-test-fixtures.js';
import { OPERATIONAL_STATE_DATABASE_NAME } from '@maka/storage/operational-state-store';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import {
  archivedToolResultContainsLinkedChildReferences,
  archivedToolResultContainsConversationOwnedReferences,
  cloneConversationRuntimeLedger,
  collectConversationCopyLinkedChildReferences,
  collectConversationCopySessionContextRefIds,
  collectConversationCopySessionFileRefs,
  createConversationCopySlice,
  prepareConversationRuntimeLedgerCopy,
  rewriteConversationCopyMessage,
} from '../conversation-copy.js';
import {
  buildHistoryCompactCheckpoint,
  matchHistoryCompactCheckpointPrefix,
  validateHistoryCompactCheckpointShape,
} from '../history-compact-checkpoint.js';
import { isHistoryCompactContentEvent } from '../history-compaction.js';
import { RuntimeReadModel, type RuntimeReadModelSessionView } from '../runtime-read-model.js';
import { buildToolOperationId } from '../runtime-commit-sink.js';
import { buildToolResultArchiveResourceRef } from '../tool-result-archive-resource.js';
import { sha256 } from '../context-budget-helpers.js';
import {
  baseToolResultProjection,
  loadModelProjectionTransitionsFromRunLedger,
  reduceEffectiveModelProjections,
} from '../model-projection-transition-ledger.js';
import {
  archivedToolResultProjection,
  collectReachableArchiveArtifactIds,
  serializedToolResultProjection,
} from '../tool-result-archive-transition.js';
import {
  buildArchivedToolResultPlaceholder,
  isArchivedToolResultPlaceholder,
} from '../tool-result-archive.js';
import { testInvocationOpening, testInvocationRecord } from './invocation-fixture.js';

test('archived tool-result copy preflight detects conversation-owned references', () => {
  const serialized = (value: unknown): string => JSON.stringify(value);
  assert.equal(
    archivedToolResultContainsConversationOwnedReferences(
      serialized({ kind: 'text', text: 'safe result' }),
      'session-source',
    ),
    false,
  );
  assert.equal(
    archivedToolResultContainsConversationOwnedReferences(
      serialized({
        kind: 'image',
        mimeType: 'image/png',
        ref: {
          kind: 'session_file',
          sessionId: 'session-source',
          relativePath: 'session-source/image.png',
        },
      }),
      'session-source',
    ),
    true,
  );
  assert.equal(
    archivedToolResultContainsConversationOwnedReferences(
      serialized({
        kind: 'subagent',
        agentName: 'Researcher',
        turnId: 'retired-turn',
        runId: 'retired-run',
        status: 'completed',
        permissionMode: 'execute',
        summary: 'done',
        artifactIds: [],
      }),
      'session-source',
    ),
    true,
  );
  const linkedChildReferences = new Map([
    [
      'child-session',
      {
        runIds: new Set(['child-run']),
        artifactIds: new Set(['child-artifact']),
      },
    ],
  ]);
  const linkedResult = serialized({
    kind: 'subagent',
    childSessionId: 'child-session',
    agentName: 'Researcher',
    turnId: 'child-turn',
    runId: 'child-run',
    status: 'completed',
    permissionMode: 'ask',
    summary: 'done',
    artifactIds: ['child-artifact'],
  });
  assert.equal(
    archivedToolResultContainsConversationOwnedReferences(
      linkedResult,
      'session-source',
      linkedChildReferences,
    ),
    false,
  );
  assert.equal(
    archivedToolResultContainsConversationOwnedReferences(
      linkedResult,
      'session-source',
      new Map([
        [
          'child-session',
          { runIds: new Set(['other-run']), artifactIds: new Set(['child-artifact']) },
        ],
      ]),
    ),
    true,
  );
  assert.equal(
    archivedToolResultContainsConversationOwnedReferences(
      serialized({
        kind: 'subagent',
        agentName: 'Researcher',
        turnId: 'turn-child',
        runId: 'run-child',
        status: 'completed',
        permissionMode: 'ask',
        summary: 'done',
        artifactIds: [],
      }),
      'session-source',
    ),
    true,
  );
  assert.equal(
    archivedToolResultContainsConversationOwnedReferences(
      serialized({
        kind: 'agent_swarm',
        status: 'completed',
        items: [
          {
            itemId: 'item-1',
            index: 0,
            profile: 'default',
            started: true,
            resumedFromRunId: 'run-source',
            status: 'completed',
            summary: 'done',
            artifactIds: [],
          },
        ],
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      }),
      'session-source',
    ),
    true,
  );
});

test('conversation copy discovers linked children in persisted retired tool results', () => {
  const result = {
    kind: 'subagent',
    childSessionId: 'child-session',
    agentName: 'Researcher',
    turnId: 'child-turn',
    runId: 'child-run',
    status: 'completed',
    permissionMode: 'execute',
    summary: 'done',
    artifactIds: ['child-artifact'],
  };
  const runtimeEvent = {
    id: 'event-retired-result',
    invocationId: 'invocation-source',
    runId: 'run-source',
    sessionId: 'session-source',
    turnId: 'turn-source',
    ts: 1,
    partial: false,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'tool-1',
      name: 'subagent',
      result,
    },
  } as RuntimeEvent;

  assert.deepEqual(
    collectConversationCopyLinkedChildReferences({
      messages: [],
      runtimeEvents: [runtimeEvent],
      archivedResults: [JSON.stringify(result)],
    }),
    [
      {
        childSessionId: 'child-session',
        runId: 'child-run',
        turnId: 'child-turn',
        artifactIds: ['child-artifact'],
        status: 'completed',
      },
      {
        childSessionId: 'child-session',
        runId: 'child-run',
        turnId: 'child-turn',
        artifactIds: ['child-artifact'],
        status: 'completed',
      },
    ],
  );
});

test('collectConversationCopySessionFileRefs gathers source-Session refs across sites', () => {
  const sourceRef = (relativePath: string, sessionId = 'session-source') => ({
    kind: 'session_file' as const,
    sessionId,
    relativePath,
  });
  const messages: StoredMessage[] = [
    {
      type: 'user',
      id: 'user-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'attached',
      attachments: [
        {
          kind: 'image',
          name: 'upload.png',
          mimeType: 'image/png',
          bytes: 10,
          ref: sourceRef('attachment-upload'),
        },
        {
          kind: 'image',
          name: 'child.png',
          mimeType: 'image/png',
          bytes: 10,
          ref: sourceRef('attachment-child', 'child-session'),
        },
      ],
    },
    {
      type: 'tool_result',
      id: 'result-1',
      turnId: 'turn-1',
      ts: 2,
      toolUseId: 'tool-1',
      content: { kind: 'image', mimeType: 'image/png', ref: sourceRef('attachment-tool-result') },
    } as StoredMessage,
  ];
  const runtimeEvents: RuntimeEvent[] = [
    {
      author: 'user',
      content: {
        kind: 'text',
        text: 'evt',
        attachments: [
          {
            kind: 'image',
            name: 'event.png',
            mimeType: 'image/png',
            bytes: 10,
            ref: sourceRef('attachment-event'),
          },
        ],
      },
    } as RuntimeEvent,
    {
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'fn-1',
        name: 'Read',
        result: { kind: 'image', mimeType: 'image/png', ref: sourceRef('attachment-fn') },
      },
    } as RuntimeEvent,
  ];

  const refs = collectConversationCopySessionFileRefs({
    sourceSessionId: 'session-source',
    messages,
    runtimeEvents,
    archivedResults: [
      JSON.stringify({
        kind: 'image',
        mimeType: 'image/png',
        ref: sourceRef('attachment-archived'),
      }),
      // A child-Session archived image must be ignored.
      JSON.stringify({
        kind: 'image',
        mimeType: 'image/png',
        ref: sourceRef('attachment-archived-child', 'child-session'),
      }),
    ],
  });

  assert.deepEqual([...refs].sort(), [
    'attachment-archived',
    'attachment-event',
    'attachment-fn',
    'attachment-tool-result',
    'attachment-upload',
  ]);
});

test('Side Conversation preflight identifies linked-child archive bodies', () => {
  assert.equal(
    archivedToolResultContainsLinkedChildReferences(
      JSON.stringify({
        kind: 'subagent',
        childSessionId: 'child-session',
        agentName: 'Researcher',
        turnId: 'child-turn',
        runId: 'child-run',
        status: 'completed',
        permissionMode: 'ask',
        summary: 'done',
        artifactIds: ['child-artifact'],
      }),
    ),
    true,
  );
  assert.equal(
    archivedToolResultContainsLinkedChildReferences(
      JSON.stringify({ kind: 'text', text: 'safe result' }),
    ),
    false,
  );
});

test('Side Conversation snapshots remove linked child ownership identifiers', () => {
  const message: Extract<StoredMessage, { readonly type: 'tool_result' }> = {
    type: 'tool_result',
    id: 'linked-result',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'linked-call',
    isError: false,
    content: {
      kind: 'agent_swarm',
      status: 'completed',
      items: [
        {
          itemId: 'item-1',
          index: 0,
          profile: 'default',
          started: true,
          childSessionId: 'child-session',
          turnId: 'child-turn',
          runId: 'child-run',
          resumedFromRunId: 'child-parent-run',
          status: 'completed',
          summary: 'The delegated review found one issue.',
          artifactIds: ['child-artifact'],
        },
      ],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    },
  };
  const rewritten = rewriteConversationCopyMessage(message, {
    mode: 'exact',
    sourceSessionId: 'session-source',
    targetSessionId: 'session-target',
    artifactIds: new Map([['child-artifact', 'child-artifact-snapshot']]),
    relativePaths: new Map(),
    linkedChildren: {
      mode: 'snapshot',
      archivedResults: new Map(),
    },
    runIds: new Map(),
    runtimeEventIds: new Map(),
    providerTraceIds: new Map(),
  });

  assert.equal(rewritten.type, 'tool_result');
  if (rewritten.type !== 'tool_result' || rewritten.content.kind !== 'agent_swarm') {
    assert.fail('Expected the Agent Graph result snapshot');
  }
  assert.deepEqual(rewritten.content.items, [
    {
      itemId: 'item-1',
      index: 0,
      profile: 'default',
      started: true,
      turnId: 'child-turn',
      status: 'completed',
      summary: 'The delegated review found one issue.',
      artifactIds: ['child-artifact-snapshot'],
    },
  ]);
});

test('Side Conversation snapshots rewrite source-owned Agent Swarm identities', () => {
  const message: Extract<StoredMessage, { readonly type: 'tool_result' }> = {
    type: 'tool_result',
    id: 'source-owned-result',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'source-owned-call',
    isError: false,
    content: {
      kind: 'agent_swarm',
      status: 'completed',
      items: [
        {
          itemId: 'item-1',
          index: 0,
          profile: 'default',
          started: true,
          runId: 'run-source',
          resumedFromRunId: 'run-parent-source',
          status: 'completed',
          summary: 'The source-owned run completed.',
          artifactIds: ['artifact-source'],
        },
      ],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    },
  };
  const rewritten = rewriteConversationCopyMessage(message, {
    mode: 'exact',
    sourceSessionId: 'session-source',
    targetSessionId: 'session-target',
    artifactIds: new Map([['artifact-source', 'artifact-target']]),
    relativePaths: new Map(),
    linkedChildren: {
      mode: 'snapshot',
      archivedResults: new Map(),
    },
    runIds: new Map([
      ['run-source', 'run-target'],
      ['run-parent-source', 'run-parent-target'],
    ]),
    runtimeEventIds: new Map(),
    providerTraceIds: new Map(),
  });

  assert.equal(rewritten.type, 'tool_result');
  if (rewritten.type !== 'tool_result' || rewritten.content.kind !== 'agent_swarm') {
    assert.fail('Expected the source-owned Agent Swarm result');
  }
  assert.deepEqual(rewritten.content.items, [
    {
      itemId: 'item-1',
      index: 0,
      profile: 'default',
      started: true,
      runId: 'run-target',
      resumedFromRunId: 'run-parent-target',
      status: 'completed',
      summary: 'The source-owned run completed.',
      artifactIds: ['artifact-target'],
    },
  ]);
});

test('Side Conversation snapshots rewrite source-owned subagent identities', () => {
  const message: Extract<StoredMessage, { readonly type: 'tool_result' }> = {
    type: 'tool_result',
    id: 'source-owned-result',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'source-owned-call',
    isError: false,
    content: {
      kind: 'subagent',
      agentName: 'Researcher',
      turnId: 'turn-1',
      runId: 'run-source',
      status: 'completed',
      permissionMode: 'ask',
      summary: 'The source-owned run completed.',
      artifactIds: ['artifact-source'],
    },
  };
  const rewritten = rewriteConversationCopyMessage(message, {
    mode: 'exact',
    sourceSessionId: 'session-source',
    targetSessionId: 'session-target',
    artifactIds: new Map([['artifact-source', 'artifact-target']]),
    relativePaths: new Map(),
    linkedChildren: {
      mode: 'snapshot',
      archivedResults: new Map(),
    },
    runIds: new Map([['run-source', 'run-target']]),
    runtimeEventIds: new Map(),
    providerTraceIds: new Map(),
  });

  assert.equal(rewritten.type, 'tool_result');
  if (rewritten.type !== 'tool_result' || rewritten.content.kind !== 'subagent') {
    assert.fail('Expected the source-owned subagent result');
  }
  assert.equal(rewritten.content.runId, 'run-target');
  assert.deepEqual(rewritten.content.artifactIds, ['artifact-target']);
});

test('Side Conversation snapshots preserve ordinary archived tool results', () => {
  const message: Extract<StoredMessage, { readonly type: 'tool_result' }> = {
    type: 'tool_result',
    id: 'archived-result',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'tool-1',
    isError: false,
    content: {
      kind: 'json',
      value: {
        kind: 'maka.archived_tool_result',
        rewriteVersion: 1,
        artifactId: 'artifact-source',
        runtimeEventId: 'event-source',
        toolCallId: 'tool-1',
        toolName: 'search',
        bodySha256: 'a'.repeat(64),
        originalEstimatedTokens: 42,
        originalBytes: 128,
        reason: 'stale_tool_result_pruned_before_compact',
      },
    },
  };
  const rewritten = rewriteConversationCopyMessage(message, {
    mode: 'exact',
    sourceSessionId: 'session-source',
    targetSessionId: 'session-target',
    artifactIds: new Map([['artifact-source', 'artifact-target']]),
    relativePaths: new Map(),
    linkedChildren: {
      mode: 'snapshot',
      archivedResults: new Map(),
    },
    runIds: new Map(),
    runtimeEventIds: new Map([['event-source', 'event-target']]),
    providerTraceIds: new Map(),
  });

  assert.equal(rewritten.type, 'tool_result');
  if (rewritten.type !== 'tool_result' || rewritten.content.kind !== 'json') {
    assert.fail('Expected an archived JSON tool result');
  }
  assert.deepEqual(rewritten.content.value, {
    kind: 'maka.archived_tool_result',
    rewriteVersion: 1,
    artifactId: 'artifact-target',
    runtimeEventId: 'event-target',
    toolCallId: 'tool-1',
    toolName: 'search',
    bodySha256: 'a'.repeat(64),
    originalEstimatedTokens: 42,
    originalBytes: 128,
    reason: 'stale_tool_result_pruned_before_compact',
  });
});

test('Side Conversation snapshots retire archived linked-child results', () => {
  const message: Extract<StoredMessage, { readonly type: 'tool_result' }> = {
    type: 'tool_result',
    id: 'archived-result',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'tool-1',
    isError: false,
    content: {
      kind: 'json',
      value: {
        kind: 'maka.archived_tool_result',
        rewriteVersion: 1,
        artifactId: 'artifact-source',
        runtimeEventId: 'event-source',
        toolCallId: 'tool-1',
        toolName: 'subagent',
        bodySha256: 'b'.repeat(64),
        originalEstimatedTokens: 42,
        originalBytes: 128,
        reason: 'stale_tool_result_pruned_before_compact',
      },
    },
  };
  const rewritten = rewriteConversationCopyMessage(message, {
    mode: 'exact',
    sourceSessionId: 'session-source',
    targetSessionId: 'session-target',
    artifactIds: new Map([['child-artifact', 'child-artifact-snapshot']]),
    relativePaths: new Map(),
    linkedChildren: {
      mode: 'snapshot',
      archivedResults: new Map([
        [
          'artifact-source',
          JSON.stringify({
            kind: 'subagent',
            childSessionId: 'child-session',
            agentName: 'Researcher',
            turnId: 'child-turn',
            runId: 'child-run',
            status: 'completed',
            permissionMode: 'ask',
            summary: 'The archived review found one issue.',
            artifactIds: ['child-artifact'],
          }),
        ],
      ]),
    },
    runIds: new Map(),
    runtimeEventIds: new Map([['event-source', 'event-target']]),
    providerTraceIds: new Map(),
  });

  assert.equal(rewritten.type, 'tool_result');
  if (rewritten.type !== 'tool_result') assert.fail('Expected a tool result');
  assert.deepEqual(rewritten.content, {
    kind: 'subagent',
    agentName: 'Researcher',
    turnId: 'child-turn',
    status: 'completed',
    permissionMode: 'ask',
    summary: 'The archived review found one issue.',
    artifactIds: ['child-artifact-snapshot'],
  });
});

test('conversation copy slices exact turns on inclusive and exclusive boundaries', () => {
  const messages = [
    { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'first' },
    { type: 'user', id: 'user-2', turnId: 'turn-2', ts: 3, text: 'second' },
    {
      type: 'assistant',
      id: 'assistant-1',
      turnId: 'turn-1',
      ts: 2,
      text: 'first response',
      modelId: 'model',
    },
  ] as const;

  const inclusive = createConversationCopySlice(messages, 'turn-1', 'through');
  assert.deepEqual(inclusive?.turnIds, ['turn-1']);
  assert.deepEqual(
    inclusive?.messages.map((message) => message.id),
    ['user-1', 'assistant-1'],
  );
  assert.equal(inclusive?.beforeTs, 3);

  const exclusive = createConversationCopySlice(messages, 'turn-2', 'before');
  assert.deepEqual(exclusive, inclusive);
  assert.equal(createConversationCopySlice(messages, 'missing', 'through'), null);
});

test('conversation copy rewrites owned references without changing opaque tool payloads', () => {
  const resourceRef = buildToolResultArchiveResourceRef({
    artifactId: 'artifact-source',
    bodySha256: 'a'.repeat(64),
    originalBytes: 12,
  });
  const messages: StoredMessage[] = [
    {
      type: 'user',
      id: 'user-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'attached',
      attachments: [
        {
          kind: 'code',
          name: 'artifact.txt',
          mimeType: 'text/plain',
          bytes: 12,
          ref: {
            kind: 'session_file',
            sessionId: 'session-source',
            relativePath: 'session-source/artifact-source-file.txt',
          },
        },
        {
          kind: 'image',
          name: 'snapshot.png',
          mimeType: 'image/png',
          bytes: 4,
          ref: {
            kind: 'session_context',
            sessionId: 'session-source',
            refId: 'context-source',
          },
        },
      ],
    },
    {
      type: 'tool_call',
      id: 'tool-1',
      turnId: 'turn-1',
      ts: 2,
      toolName: 'opaque',
      args: {
        sessionId: 'session-source',
        runId: 'run-source',
        artifactId: 'artifact-source',
        opaqueStorageRefShape: {
          kind: 'session_context',
          sessionId: 'session-source',
          refId: 'context-opaque',
        },
      },
      providerOptions: {
        sourceInvocationId: 'invocation-source',
      },
    },
    {
      type: 'tool_result',
      id: 'result-1',
      turnId: 'turn-1',
      ts: 3,
      toolUseId: 'tool-1',
      isError: false,
      content: {
        kind: 'json',
        value: {
          kind: 'maka.archived_tool_result',
          rewriteVersion: 1,
          artifactId: 'artifact-source',
          resourceRef,
          runtimeEventId: 'event-source',
          toolCallId: 'tool-1',
          toolName: 'opaque',
          bodySha256: 'a'.repeat(64),
          originalEstimatedTokens: 3,
          originalBytes: 12,
          reason: 'stale_tool_result_pruned_before_compact',
        },
      },
    },
    {
      type: 'tool_result',
      id: 'result-2',
      turnId: 'turn-1',
      ts: 4,
      toolUseId: 'tool-2',
      isError: false,
      content: {
        kind: 'agent_swarm',
        status: 'completed',
        items: [
          {
            itemId: 'item-1',
            index: 0,
            profile: 'default',
            started: true,
            runId: 'run-source',
            resumedFromRunId: 'run-source',
            status: 'completed',
            summary: 'done',
            artifactIds: ['artifact-source'],
          },
        ],
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      },
    },
  ];
  const references = {
    mode: 'exact' as const,
    linkedChildren: { mode: 'reject' as const },
    sourceSessionId: 'session-source',
    targetSessionId: 'session-target',
    artifactIds: new Map([['artifact-source', 'artifact-target']]),
    relativePaths: new Map([
      ['session-source/artifact-source-file.txt', 'session-target/artifact-target-file.txt'],
    ]),
    contextRefs: new Map([['context-source', 'context-target']]),
    runIds: new Map([['run-source', 'run-target']]),
    invocationIds: new Map([['invocation-source', 'invocation-target']]),
    runtimeEventIds: new Map([['event-source', 'event-target']]),
    providerTraceIds: new Map<string, string>(),
  };
  const rewritten = messages.map((message) => rewriteConversationCopyMessage(message, references));

  assert.deepEqual(rewritten[0]?.type === 'user' ? rewritten[0].attachments?.[0]?.ref : undefined, {
    kind: 'session_file',
    sessionId: 'session-target',
    relativePath: 'session-target/artifact-target-file.txt',
  });
  assert.deepEqual(rewritten[0]?.type === 'user' ? rewritten[0].attachments?.[1]?.ref : undefined, {
    kind: 'session_context',
    sessionId: 'session-target',
    refId: 'context-target',
  });
  assert.deepEqual(
    collectConversationCopySessionContextRefIds({
      sourceSessionId: 'session-source',
      messages,
      runtimeEvents: [
        runtimeEvent({
          id: 'selected-image-result',
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-image',
            name: 'Read',
            result: {
              kind: 'image',
              mimeType: 'image/png',
              ref: {
                kind: 'session_context',
                sessionId: 'session-source',
                refId: 'context-selected-event',
              },
            },
          },
        }),
        runtimeEvent({
          id: 'opaque-json-result',
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-opaque',
            name: 'opaque',
            result: {
              kind: 'json',
              value: {
                kind: 'session_context',
                sessionId: 'session-source',
                refId: 'context-opaque-event',
              },
            },
          },
        }),
      ],
      archivedResults: [],
    }),
    ['context-selected-event', 'context-source'],
  );
  assert.throws(
    () =>
      rewriteConversationCopyMessage(messages[0]!, {
        ...references,
        contextRefs: new Map(),
      }),
    /missing Session context context-source/,
  );
  const userMessage = messages[0];
  assert.equal(userMessage?.type, 'user');
  if (userMessage?.type !== 'user') return;
  const canonicalAttachment = userMessage.attachments?.[0];
  assert.ok(canonicalAttachment);
  const canonical = rewriteConversationCopyMessage(
    {
      ...userMessage,
      attachments: [
        {
          ...canonicalAttachment,
          ref: {
            kind: 'session_file',
            sessionId: 'session-source',
            relativePath: 'artifact-source',
          },
        },
      ],
    },
    references,
  );
  assert.equal(
    canonical.type === 'user' && canonical.attachments?.[0]?.ref.kind === 'session_file'
      ? canonical.attachments[0].ref.relativePath
      : undefined,
    'artifact-target',
  );
  assert.deepEqual(
    rewritten[1]?.type === 'tool_call' ? rewritten[1].args : undefined,
    messages[1]?.type === 'tool_call' ? messages[1].args : undefined,
  );
  assert.deepEqual(
    rewritten[1]?.type === 'tool_call' ? rewritten[1].providerOptions : undefined,
    messages[1]?.type === 'tool_call' ? messages[1].providerOptions : undefined,
  );
  const archived =
    rewritten[2]?.type === 'tool_result' &&
    rewritten[2].content.kind === 'json' &&
    typeof rewritten[2].content.value === 'object' &&
    rewritten[2].content.value !== null
      ? (rewritten[2].content.value as {
          artifactId?: string;
          resourceRef?: string;
          runtimeEventId?: string;
        })
      : undefined;
  assert.equal(archived?.artifactId, 'artifact-target');
  assert.equal(archived?.runtimeEventId, 'event-target');
  assert.equal(
    archived?.resourceRef,
    buildToolResultArchiveResourceRef({
      artifactId: 'artifact-target',
      bodySha256: 'a'.repeat(64),
      originalBytes: 12,
    }),
  );
  const swarm =
    rewritten[3]?.type === 'tool_result' && rewritten[3].content.kind === 'agent_swarm'
      ? rewritten[3].content.items[0]
      : undefined;
  assert.equal(swarm?.runId, 'run-target');
  assert.equal(swarm?.resumedFromRunId, 'run-target');
  assert.deepEqual(swarm?.artifactIds, ['artifact-target']);
  const unavailableArchive = rewriteConversationCopyMessage(
    {
      type: 'tool_result',
      id: 'result-3',
      turnId: 'turn-1',
      ts: 5,
      toolUseId: 'tool-3',
      isError: false,
      content: {
        kind: 'archived_tool_result',
        status: 'missing',
        runtimeEventId: 'event-source',
        toolCallId: 'tool-3',
        toolName: 'opaque',
        originalEstimatedTokens: 3,
        originalBytes: 12,
        rewriteVersion: 1,
        reason: 'stale_tool_result_pruned_before_compact',
      },
    },
    references,
  );
  assert.equal(
    unavailableArchive.type === 'tool_result' &&
      unavailableArchive.content.kind === 'archived_tool_result'
      ? unavailableArchive.content.runtimeEventId
      : undefined,
    'event-target',
  );
  const preserved = rewriteConversationCopyMessage(messages[0]!, {
    mode: 'preserve_external',
    sourceSessionId: 'session-source',
    targetSessionId: 'session-target',
    runIds: new Map(),
    runtimeEventIds: new Map(),
    providerTraceIds: new Map(),
  });
  assert.deepEqual(
    preserved.type === 'user' ? preserved.attachments?.[0]?.ref : undefined,
    messages[0]?.type === 'user' ? messages[0].attachments?.[0]?.ref : undefined,
  );
  // An archived tool result's Artifact holds that result's own bytes, and the
  // two are removed together, so a copy that lost it has lost what a reader
  // will ask for.
  assert.throws(
    () =>
      rewriteConversationCopyMessage(messages[2]!, {
        ...references,
        artifactIds: new Map(),
      }),
    /missing Artifact artifact-source/,
  );
  // A child result is the opposite case: it lists every Artifact its turn
  // held, in a ledger that cannot be rewritten, so an id in it outlives what
  // it named. The copy carries what is still there and drops the rest, rather
  // than making a whole Session uncopyable over a reclaimed byte nobody reads.
  const reclaimed = rewriteConversationCopyMessage(messages[3]!, {
    ...references,
    artifactIds: new Map(),
  });
  assert.deepEqual(
    reclaimed.type === 'tool_result' && reclaimed.content.kind === 'agent_swarm'
      ? reclaimed.content.items[0]?.artifactIds
      : undefined,
    [],
  );
  assert.throws(
    () =>
      rewriteConversationCopyMessage(messages[3]!, {
        ...references,
        runIds: new Map(),
      }),
    /missing AgentRun run-source/,
  );

  const linked = rewriteConversationCopyMessage(
    {
      type: 'tool_result',
      id: 'linked-result',
      turnId: 'turn-1',
      ts: 6,
      toolUseId: 'linked-call',
      isError: false,
      content: {
        kind: 'subagent',
        childSessionId: 'child-session',
        agentName: 'Researcher',
        turnId: 'child-turn',
        runId: 'child-run',
        status: 'completed',
        permissionMode: 'ask',
        summary: 'done',
        artifactIds: ['child-artifact'],
      },
    },
    {
      ...references,
      linkedChildren: {
        mode: 'preserve_validated',
        references: new Map([
          [
            'child-session',
            {
              runIds: new Set(['child-run']),
              artifactIds: new Set(['child-artifact']),
            },
          ],
        ]),
      },
    },
  );
  assert.equal(
    linked.type === 'tool_result' && linked.content.kind === 'subagent'
      ? linked.content.runId
      : undefined,
    'child-run',
  );
  assert.deepEqual(
    linked.type === 'tool_result' && linked.content.kind === 'subagent'
      ? linked.content.artifactIds
      : undefined,
    ['child-artifact'],
  );
  assert.deepEqual(
    rewriteConversationCopyMessage(linked, {
      mode: 'preserve_external',
      sourceSessionId: 'session-source',
      targetSessionId: 'session-target',
      runIds: new Map(),
      runtimeEventIds: new Map(),
      providerTraceIds: new Map(),
    }),
    linked,
  );
  assert.throws(
    () =>
      rewriteConversationCopyMessage(linked, {
        ...references,
        linkedChildren: { mode: 'preserve_validated', references: new Map() },
      }),
    /missing linked child Session child-session/,
  );
});

test('conversation copy rejects continuation authority selected through the child-run closure', async () => {
  const parent = invocationRecord({ runId: 'run-parent', turnId: 'turn-parent' });
  const child = invocationRecord({
    runId: 'run-child-retry',
    invocationId: 'invocation-child-retry',
    turnId: 'turn-child-retry',
    parentRunId: 'run-parent',
    agentId: 'agent-child',
    source: {
      kind: 'continuation',
      sourceInvocationId: parent.invocationId,
      sourceRunId: parent.runId,
      sourceTurnId: parent.turnId,
      sourceRuntimeEventHighWater: 1,
    },
  });
  const runs = [parent, child];

  await assert.rejects(
    prepareConversationRuntimeLedgerCopy({
      sourceSessionId: 'session-source',
      sourceEvents: [],
      copiedMessages: [
        {
          type: 'user',
          id: 'message-parent',
          turnId: parent.turnId,
          ts: 1,
          text: 'retain the parent and its child closure',
        },
      ],
      runStore: {
        readEvents: async () => [],
      },
      runtimeEventStore: {
        listSessionInvocations: async () => runs,
        readRuntimeEvents: async (_sessionId, runId) => {
          const run = runs.find((candidate) => candidate.runId === runId);
          assert.ok(run);
          return [
            runtimeEvent({
              id: `terminal-${runId}`,
              runId,
              invocationId: run.invocationId,
              turnId: run.turnId,
              status: 'completed',
            }),
          ];
        },
      },
    }),
    /typed identity rewriting/i,
  );
});

test('conversation copy rewrites a complete tool recovery bundle atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-recovery-copy-'));
  const runStore = createSqliteAgentRunStore(root);
  const runtimeEventStore = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  try {
    await runStore.ready?.();
    const sourceEvents: RuntimeEvent[] = [
      invocationOpenedEvent({
        runId: 'run-source',
        invocationId: 'invocation-source',
        turnId: 'turn-1',
        cwd: root,
      }),
      runtimeEvent({
        id: 'event-user',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'recover the write' },
      }),
      runtimeEvent({
        id: 'event-call',
        ts: 2,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'provider-call-1',
          name: 'Write',
          args: { path: 'notes.txt', content: 'after' },
        },
      }),
      runtimeEvent({
        id: 'event-dispatch',
        ts: 3,
        actions: {
          toolDispatch: {
            protocol: 't1_after_preflight_v1',
            operationId: 'operation-1',
            providerToolCallId: 'provider-call-1',
            toolName: 'Write',
            canonicalArgsHash: canonicalToolArgsHash('Write', {
              path: 'notes.txt',
              content: 'after',
            }),
            recoveryMode: 'reconcile',
          },
        },
        refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
      }),
      runtimeEvent({
        id: 'event-reconcile',
        ts: 4,
        actions: {
          toolRecovery: {
            kind: 'maka.tool.reconcile_result',
            version: 1,
            payload: {
              protocol: 'tool_reconcile_v1',
              operationId: 'operation-1',
              observation: 'matches_expected_state',
              observationSchema: 'state_identity_v1',
              observationDigest: `sha256:${'b'.repeat(64)}`,
            },
          },
        },
        refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
      }),
      runtimeEvent({
        id: 'event-outcome',
        ts: 5,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'provider-call-1',
          name: 'Write',
          result: { kind: 'text', text: 'ok' },
          isError: false,
        },
        refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
      }),
      runtimeEvent({
        id: 'event-decision',
        ts: 6,
        actions: {
          toolRecovery: {
            kind: 'maka.tool.recovery_decision',
            version: 1,
            payload: {
              protocol: 'tool_recovery_v1',
              operationId: 'operation-1',
              disposition: 'completed',
              reasonCode: 'reconcile_matches_expected_state',
              outcomeEventId: 'event-outcome',
              evidenceEventIds: [
                'event-call',
                'event-dispatch',
                'event-reconcile',
                'event-outcome',
              ],
            },
          },
        },
        refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
      }),
      runtimeEvent({
        id: 'event-terminal',
        ts: 7,
        status: 'completed',
      }),
    ];
    await runtimeEventStore.importConversationCopyRuntimeEvents('session-source', [
      { runId: 'run-source', events: sourceEvents },
    ]);
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'model_stream_completed',
      id: 'completed-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 7,
    });
    const source = await new RuntimeReadModel({
      runtimeEventStore,
    }).getSessionView('session-source');
    await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, source.messages, runStore, runtimeEventStore),
      copiedMessages: source.messages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        artifactIds: new Map(),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => crypto.randomUUID(),
    });
    const [targetRun] = await runtimeEventStore.listSessionInvocations('session-target');
    assert.ok(targetRun);
    assert.ok(targetRun.invocationId);
    const targetOperationId = buildToolOperationId({
      invocationId: targetRun.invocationId,
      providerToolCallId: 'provider-call-1',
    });
    assert.notEqual(targetOperationId, 'operation-1');
    const targetEvents = await runtimeEventStore.readRuntimeEvents(
      'session-target',
      targetRun.runId,
    );
    const dispatch = targetEvents.find((event) => event.actions?.toolDispatch)?.actions
      ?.toolDispatch;
    const reconcile = targetEvents.find(
      (event) => event.actions?.toolRecovery?.kind === 'maka.tool.reconcile_result',
    )?.actions?.toolRecovery;
    const decisionEvent = targetEvents.find(
      (event) => event.actions?.toolRecovery?.kind === 'maka.tool.recovery_decision',
    );
    const decision = decisionEvent?.actions?.toolRecovery;
    const callEvent = targetEvents.find((event) => event.content?.kind === 'function_call');
    const dispatchEvent = targetEvents.find((event) => event.actions?.toolDispatch);
    const reconcileEvent = targetEvents.find(
      (event) => event.actions?.toolRecovery?.kind === 'maka.tool.reconcile_result',
    );
    const outcomeEvent = targetEvents.find((event) => event.content?.kind === 'function_response');
    assert.ok(callEvent);
    assert.ok(dispatchEvent);
    assert.ok(reconcileEvent);
    assert.ok(outcomeEvent);
    assert.equal(dispatch?.operationId, targetOperationId);
    assert.equal(reconcile?.payload.operationId, targetOperationId);
    assert.equal(decision?.kind, 'maka.tool.recovery_decision');
    if (decision?.kind !== 'maka.tool.recovery_decision') {
      assert.fail('Copied recovery decision is missing');
    }
    assert.equal(decision.payload.disposition, 'completed');
    if (decision.payload.disposition !== 'completed') {
      assert.fail('Copied recovery decision must be completed');
    }
    assert.equal(decision.payload.outcomeEventId, outcomeEvent.id);
    assert.deepEqual(decision.payload.evidenceEventIds, [
      callEvent.id,
      dispatchEvent.id,
      reconcileEvent.id,
      outcomeEvent.id,
    ]);
    assert.equal(decision.payload.operationId, targetOperationId);
    assert.ok(
      targetEvents
        .filter((event) => event.refs?.operationId)
        .every((event) => event.refs?.operationId === targetOperationId),
    );
    assert.equal((await runtimeEventStore.readToolOperation('operation-1'))?.runId, 'run-source');
    assert.equal(
      (await runtimeEventStore.readToolOperation(targetOperationId))?.runId,
      targetRun.runId,
    );
  } finally {
    runtimeEventStore.close();
    runStore.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy rewrites the parent operation id of a nested Code Mode call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-copy-parent-op-'));
  const runStore = createSqliteAgentRunStore(root);
  const runtimeEventStore = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  try {
    await runStore.ready?.();
    const sourceEvents: RuntimeEvent[] = [
      invocationOpenedEvent({
        runId: 'run-source',
        invocationId: 'invocation-source',
        turnId: 'turn-1',
        cwd: root,
      }),
      runtimeEvent({
        id: 'event-user',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'run some code' },
      }),
      runtimeEvent({
        id: 'event-call',
        ts: 2,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'provider-call-1',
          name: 'CodeMode',
          args: { code: 'await tools.Write({ path: "notes.txt", content: "hi" })' },
        },
      }),
      runtimeEvent({
        id: 'event-dispatch',
        ts: 3,
        actions: {
          toolDispatch: {
            protocol: 't1_after_preflight_v1',
            operationId: 'operation-1',
            providerToolCallId: 'provider-call-1',
            toolName: 'CodeMode',
            canonicalArgsHash: canonicalToolArgsHash('CodeMode', {
              code: 'await tools.Write({ path: "notes.txt", content: "hi" })',
            }),
            recoveryMode: 'replay_safe',
          },
        },
        refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
      }),
      // Nested tool call produced from inside the Code Mode cell. Its enclosing
      // operation is `operation-1`; ai-sdk-backend writes that source-owned id
      // into refs.parentOperationId. The provider-owned parentToolCallId is not
      // runtime-owned and must be preserved unchanged.
      runtimeEvent({
        id: 'event-nested-call',
        ts: 4,
        role: 'model',
        author: 'agent',
        origin: 'code_mode',
        modelVisibility: 'hidden',
        content: {
          kind: 'function_call',
          id: 'provider-call-1:nested:nested-1',
          name: 'Write',
          args: { path: 'notes.txt', content: 'hi' },
        },
        refs: {
          parentOperationId: 'operation-1',
          parentToolCallId: 'provider-call-1',
        },
      }),
      runtimeEvent({
        id: 'event-outcome',
        ts: 5,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'provider-call-1',
          name: 'CodeMode',
          result: { kind: 'text', text: 'ok' },
          isError: false,
        },
        refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
      }),
      runtimeEvent({
        id: 'event-terminal',
        ts: 6,
        status: 'completed',
      }),
    ];
    await runtimeEventStore.importConversationCopyRuntimeEvents('session-source', [
      { runId: 'run-source', events: sourceEvents },
    ]);
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'model_stream_completed',
      id: 'completed-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 6,
    });
    const source = await new RuntimeReadModel({
      runtimeEventStore,
    }).getSessionView('session-source');
    await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, source.messages, runStore, runtimeEventStore),
      copiedMessages: source.messages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        artifactIds: new Map(),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => crypto.randomUUID(),
    });
    const [targetRun] = await runtimeEventStore.listSessionInvocations('session-target');
    assert.ok(targetRun);
    assert.ok(targetRun.invocationId);
    const targetOperationId = buildToolOperationId({
      invocationId: targetRun.invocationId,
      providerToolCallId: 'provider-call-1',
    });
    assert.notEqual(targetOperationId, 'operation-1');
    const targetEvents = await runtimeEventStore.readRuntimeEvents(
      'session-target',
      targetRun.runId,
    );
    const nested = targetEvents.find((event) => event.refs?.parentOperationId !== undefined);
    assert.ok(nested, 'nested Code Mode call survived the copy');
    // The parent operation id is rewritten to the target namespace, not stranded
    // at the source identity.
    assert.equal(nested.refs?.parentOperationId, targetOperationId);
    // The provider-owned parentToolCallId is not runtime-owned and is preserved.
    assert.equal(nested.refs?.parentToolCallId, 'provider-call-1');
    const dispatch = targetEvents.find((event) => event.actions?.toolDispatch)?.actions
      ?.toolDispatch;
    assert.equal(dispatch?.operationId, targetOperationId);
  } finally {
    runtimeEventStore.close();
    runStore.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy rewrites the nested identity of a model call attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-model-call-copy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    await seedRun(runtimeEventStore, {
      runId: 'run-source',
      invocationId: 'invocation-source',
      turnId: 'turn-1',
      cwd: root,
    });
    for (const event of [
      runtimeEvent({
        id: 'event-user',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'copy this turn' },
      }),
      runtimeEvent({ id: 'event-terminal', ts: 2, status: 'completed' }),
    ]) {
      await runtimeEventStore.appendRuntimeEvent('session-source', 'run-source', event);
    }
    // The envelope identity (session/run/id) and the nested ModelCallAttempt
    // identity start out equal, exactly as the writer emits them.
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'model_call_attempt_recorded',
      id: 'attempt-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 2,
      data: {
        schemaVersion: 1,
        logicalCallId: 'logical-source',
        attemptId: 'attempt-source',
        traceId: 'trace-source',
        sessionId: 'session-source',
        runId: 'run-source',
        turnId: 'turn-1',
        step: 0,
        attempt: 0,
        callKind: 'main',
        providerId: 'provider',
        modelId: 'model',
        captureArtifactId: 'artifact-source',
        startedAt: 1,
        completedAt: 2,
        latencyMs: 1,
        status: 'completed',
        usageBasis: 'reported',
        inputTokens: 10,
        outputTokens: 5,
        costBasis: 'priced',
        costUsd: 0.01,
      },
    });
    const source = await new RuntimeReadModel({
      runtimeEventStore,
    }).getSessionView('session-source');
    await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, source.messages, runStore, runtimeEventStore),
      copiedMessages: source.messages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        artifactIds: new Map([['artifact-source', 'artifact-target']]),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => crypto.randomUUID(),
    });
    const [targetRun] = await runtimeEventStore.listSessionInvocations('session-target');
    assert.ok(targetRun);
    const targetEvents = await runStore.readEvents('session-target', targetRun.runId);
    const attempt = targetEvents.find((event) => event.type === 'model_call_attempt_recorded');
    assert.ok(attempt);
    // The envelope moved to the target session/run.
    assert.equal(attempt.sessionId, 'session-target');
    assert.equal(attempt.runId, targetRun.runId);
    // The nested payload identity now agrees with the rewritten envelope instead
    // of retaining the source identity — the model-call projection guard rejects
    // any attempt whose payload disagrees with its envelope as unreadable.
    assert.equal(attempt.data?.sessionId, 'session-target');
    assert.equal(attempt.data?.runId, targetRun.runId);
    assert.equal(attempt.data?.attemptId, attempt.id);
    assert.equal(attempt.data?.turnId, 'turn-1');
    // Owned trace/logical-call/artifact identity is remapped, not carried over.
    assert.notEqual(attempt.data?.logicalCallId, 'logical-source');
    assert.notEqual(attempt.data?.traceId, 'trace-source');
    assert.equal(attempt.data?.captureArtifactId, 'artifact-target');
    // The rewritten record is still a valid accounting authority whose identity
    // matches the envelope the ledger projects it under.
    const decoded = decodeModelCallAttempt(attempt.data);
    assert.equal(decoded.sessionId, attempt.sessionId);
    assert.equal(decoded.runId, attempt.runId);
    assert.equal(decoded.attemptId, attempt.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy survives a capture the store has already reclaimed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-reclaimed-capture-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    await seedRun(runtimeEventStore, {
      runId: 'run-source',
      invocationId: 'invocation-source',
      turnId: 'turn-1',
      cwd: root,
    });
    for (const event of [
      runtimeEvent({
        id: 'event-user',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'copy this turn' },
      }),
      runtimeEvent({ id: 'event-terminal', ts: 2, status: 'completed' }),
    ]) {
      await runtimeEventStore.appendRuntimeEvent('session-source', 'run-source', event);
    }
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'model_call_attempt_recorded',
      id: 'attempt-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 2,
      data: {
        schemaVersion: 1,
        logicalCallId: 'logical-source',
        attemptId: 'attempt-source',
        traceId: 'trace-source',
        sessionId: 'session-source',
        runId: 'run-source',
        turnId: 'turn-1',
        step: 0,
        attempt: 0,
        callKind: 'main',
        providerId: 'provider',
        modelId: 'model',
        captureArtifactId: 'artifact-gone',
        startedAt: 1,
        completedAt: 2,
        latencyMs: 1,
        status: 'completed',
        usageBasis: 'reported',
        inputTokens: 10,
        outputTokens: 5,
        costBasis: 'priced',
        costUsd: 0.01,
      },
    });
    const source = await new RuntimeReadModel({
      runtimeEventStore,
    }).getSessionView('session-source');

    // The sweep purged the capture Artifact, so the copy never sees it. Before
    // the join keys were made droppable this threw and no Session holding a
    // historical model call could be branched or copied again.
    await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, source.messages, runStore, runtimeEventStore),
      copiedMessages: source.messages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        artifactIds: new Map(),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => crypto.randomUUID(),
    });
    const [targetRun] = await runtimeEventStore.listSessionInvocations('session-target');
    assert.ok(targetRun);
    const events = await runStore.readEvents('session-target', targetRun.runId);
    const attempt = events.find((event) => event.type === 'model_call_attempt_recorded');
    assert.ok(attempt, 'the attempt itself still copies');
    assert.equal(attempt.data?.captureArtifactId, undefined);
    // Still a valid accounting authority without the join.
    const decoded = decodeModelCallAttempt(attempt.data);
    assert.equal(decoded.attemptId, attempt.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy repairs a model call attempt stranded by a pre-fix copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-model-call-legacy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    await seedRun(runtimeEventStore, {
      runId: 'run-source',
      invocationId: 'invocation-source',
      turnId: 'turn-1',
      cwd: root,
    });
    for (const event of [
      runtimeEvent({
        id: 'event-user',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'copy this turn again' },
      }),
      runtimeEvent({ id: 'event-terminal', ts: 2, status: 'completed' }),
    ]) {
      await runtimeEventStore.appendRuntimeEvent('session-source', 'run-source', event);
    }
    // Simulate a session that was itself copied before this fix existed: the
    // pre-fix copy path rewrote the envelope id but left the nested payload at
    // the *grandparent* identity, so the envelope id and the nested attemptId /
    // session / run disagree. Such a session must still be copyable.
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'model_call_attempt_recorded',
      id: 'attempt-envelope',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 2,
      data: {
        schemaVersion: 1,
        logicalCallId: 'logical-grandparent',
        attemptId: 'attempt-grandparent',
        traceId: 'trace-grandparent',
        sessionId: 'session-grandparent',
        runId: 'run-grandparent',
        turnId: 'turn-1',
        step: 0,
        attempt: 0,
        callKind: 'main',
        providerId: 'provider',
        modelId: 'model',
        startedAt: 1,
        completedAt: 2,
        latencyMs: 1,
        status: 'completed',
        usageBasis: 'reported',
        inputTokens: 10,
        outputTokens: 5,
        costBasis: 'priced',
        costUsd: 0.01,
      },
    });
    const source = await new RuntimeReadModel({
      runtimeEventStore,
    }).getSessionView('session-source');
    // The whole copy must not throw `Cannot copy invalid model call attempt`.
    await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, source.messages, runStore, runtimeEventStore),
      copiedMessages: source.messages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        artifactIds: new Map(),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => crypto.randomUUID(),
    });
    const [targetRun] = await runtimeEventStore.listSessionInvocations('session-target');
    assert.ok(targetRun);
    const targetEvents = await runStore.readEvents('session-target', targetRun.runId);
    const attempt = targetEvents.find((event) => event.type === 'model_call_attempt_recorded');
    assert.ok(attempt);
    // The stranded nested identity is repaired to the target, not carried over.
    assert.equal(attempt.data?.sessionId, 'session-target');
    assert.equal(attempt.data?.runId, targetRun.runId);
    assert.equal(attempt.data?.attemptId, attempt.id);
    assert.notEqual(attempt.data?.attemptId, 'attempt-grandparent');
    assert.notEqual(attempt.data?.logicalCallId, 'logical-grandparent');
    assert.notEqual(attempt.data?.traceId, 'trace-grandparent');
    // The repaired record decodes and its identity matches the envelope the
    // ledger projects it under.
    const legacyDecoded = decodeModelCallAttempt(attempt.data);
    assert.equal(legacyDecoded.sessionId, attempt.sessionId);
    assert.equal(legacyDecoded.runId, attempt.runId);
    assert.equal(legacyDecoded.attemptId, attempt.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy clones one terminal Runtime ledger with new owned identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-runtime-copy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const sourceRun = runFacts({
      runId: 'run-source',
      invocationId: 'invocation-source',
      turnId: 'turn-1',
      cwd: root,
      openedAt: 1,
      closedAt: 3,
    });
    await seedRun(runtimeEventStore, sourceRun);
    const sourceAttachmentText = [
      '![chart](maka://runtime/attachments/artifact-source)',
      'maka://runtime/attachments/artifact-source?session=other',
    ].join('\n');
    const targetAttachmentText = [
      '![chart](maka://runtime/attachments/artifact-target)',
      'maka://runtime/attachments/artifact-source?session=other',
    ].join('\n');
    const sourceEvents: RuntimeEvent[] = [
      runtimeEvent({
        id: 'event-user',
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: sourceAttachmentText },
        refs: { artifactId: 'artifact-source' },
      }),
      runtimeEvent({
        id: 'event-model',
        ts: 2,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'tool-1',
          name: 'opaque',
          args: {
            sessionId: 'session-source',
            runId: 'run-source',
            artifactId: 'artifact-source',
          },
          providerOptions: {
            sourceInvocationId: 'invocation-source',
          },
        },
        refs: {
          sourceInvocationId: 'invocation-source',
          providerRequestTraceId: 'provider-trace-source',
          traceEventId: 'capture-source',
        },
      }),
      runtimeEvent({
        id: 'event-tool',
        ts: 2.5,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'tool-1',
          name: 'opaque',
          result: {
            kind: 'json',
            value: {
              sessionId: 'session-source',
              runId: 'run-source',
              artifactId: 'artifact-source',
            },
          },
        },
      }),
      runtimeEvent({
        id: 'event-typed-call',
        ts: 2.6,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'tool-2',
          name: 'subagent',
          args: {},
        },
      }),
      runtimeEvent({
        id: 'event-typed-tool',
        ts: 2.75,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'tool-2',
          name: 'subagent',
          result: {
            kind: 'subagent',
            agentName: 'Researcher',
            turnId: 'turn-1',
            runId: 'run-source',
            status: 'completed',
            permissionMode: 'execute' as never,
            summary: 'done',
            artifactIds: ['artifact-deleted'],
          },
        },
      }),
      runtimeEvent({
        id: 'event-terminal',
        ts: 3,
        role: 'system',
        author: 'system',
        status: 'completed',
      }),
    ];
    for (const event of sourceEvents) {
      await runtimeEventStore.appendRuntimeEvent('session-source', 'run-source', event);
    }
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-source',
      coveredRuntimeEvents: sourceEvents.filter(isHistoryCompactContentEvent),
      summary: sectionedSummary('The source turn called one opaque tool.'),
      highWaterSeq: 3,
    });
    const providerCheckpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-source',
      coveredRuntimeEvents: sourceEvents.filter(isHistoryCompactContentEvent),
      providerState: {
        kind: 'openai_codex_remote_v2',
        connectionId: 'connection-codex-source',
        modelId: 'gpt-5-codex',
        itemId: 'cmp-source',
        encryptedContent: 'OPAQUE_SOURCE_COMPACTION_STATE',
      },
      highWaterSeq: 4,
      previousCheckpointId: checkpoint.checkpointId,
    });
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'provider_request_captured',
      id: 'capture-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 2,
      data: {
        schemaVersion: 2,
        traceId: 'provider-trace-source',
        captureId: 'capture-source',
        turnId: 'turn-1',
        step: 1,
        providerId: 'provider',
        modelId: 'model',
        requestHash: 'request-hash',
        requestPayloadWithoutProviderOptionsHash: 'payload-hash',
        requestBytes: 12,
        segments: [],
        artifactId: 'artifact-source',
      },
    } as unknown as EmittedAgentRunEvent);
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'provider_request_attempt_recorded',
      id: 'attempt-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 2.5,
      data: {
        traceId: 'provider-trace-source',
        attemptId: 'attempt-source',
        turnId: 'turn-1',
        step: 1,
        attempt: 1,
        captureId: 'capture-source',
        captureArtifactId: 'artifact-source',
        providerId: 'provider',
        modelId: 'model',
        requestHash: 'request-hash',
        requestBytes: 12,
        segments: [],
        startedAt: 2,
        completedAt: 2.5,
        status: 'completed',
        latencyMs: 0.5,
      },
    } as unknown as EmittedAgentRunEvent);
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'provider_request_attempt_recorded',
      id: 'attempt-without-capture-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 2.55,
      data: {
        traceId: 'provider-trace-without-capture-source',
        attemptId: 'attempt-without-capture-source',
        turnId: 'turn-1',
        step: 2,
        attempt: 1,
        providerId: 'provider-without-capture',
        modelId: 'model',
        requestHash: 'request-hash-without-capture',
        requestBytes: 13,
        segments: [],
        startedAt: 2.5,
        completedAt: 2.55,
        status: 'completed',
        latencyMs: 0.05,
      },
    } as unknown as EmittedAgentRunEvent);
    // A legacy event from the retired active-full writer is treated like any
    // other event this build cannot emit and is therefore not copied.
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'active_full_compact_block_recorded',
      id: 'active-compact-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 2.6,
      data: { blockId: 'active-source', block: { sourceOwnedHash: true } },
    } as unknown as EmittedAgentRunEvent);
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'semantic_compact_block_recorded',
      id: 'semantic-compact-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 2.7,
      data: { blockId: 'semantic-source', block: { sourceOwnedHash: true } },
    } as unknown as EmittedAgentRunEvent);
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'history_compact_checkpoint_recorded',
      id: 'checkpoint-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 2.75,
      data: {
        checkpointId: checkpoint.checkpointId,
        highWaterName: checkpoint.highWaterName,
        highWaterSeq: checkpoint.highWaterSeq,
        boundaryKind: 'historyCompact',
        checkpoint,
      },
    });
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'history_compact_checkpoint_recorded',
      id: 'provider-checkpoint-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 2.8,
      data: {
        checkpointId: providerCheckpoint.checkpointId,
        highWaterName: providerCheckpoint.highWaterName,
        highWaterSeq: providerCheckpoint.highWaterSeq,
        boundaryKind: 'historyCompact',
        checkpoint: providerCheckpoint,
      },
    });
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'model_stream_completed',
      id: 'completed-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 3,
    });
    // A record left by a build whose writer this one no longer has. The cast is the point: the
    // write contract forbids producing this type, and only another version could have put it in
    // the source ledger. The rewriters cannot check an unknown payload for source-owned ids, so
    // the copy must drop it rather than carry those ids into the target (#1942).
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'written_by_another_version',
      id: 'foreign-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 3.5,
      data: { runtimeEventId: 'event-source-1' },
    } as unknown as EmittedAgentRunEvent);
    assert.ok(
      (await runStore.readEvents('session-source', 'run-source')).some(
        (event) => event.type === 'written_by_another_version',
      ),
    );
    const source = await new RuntimeReadModel({
      runtimeEventStore,
    }).getSessionView('session-source');
    // The child result names an Artifact the copy has no mapping for, because
    // it was reclaimed after the ledger recorded it. The copy carries the run
    // and drops that one id, rather than making the Session uncopyable.
    const withReclaimed = await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, source.messages, runStore, runtimeEventStore),
      copiedMessages: source.messages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-missing-artifact',
        artifactIds: new Map([['artifact-source', 'artifact-target']]),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => crypto.randomUUID(),
    });
    const reclaimedResult = withReclaimed.copiedMessages.find(
      (message) => message.type === 'tool_result' && message.content.kind === 'subagent',
    );
    assert.deepEqual(
      reclaimedResult?.type === 'tool_result' && reclaimedResult.content.kind === 'subagent'
        ? reclaimedResult.content.artifactIds
        : undefined,
      [],
    );
    assert.equal(
      (await runtimeEventStore.listSessionInvocations('session-missing-artifact')).length,
      1,
    );
    // A copied run and its copied invocation share one fresh identity, so the
    // copy mints one id here rather than two.
    const ids = [
      'run-target',
      'event-target-1',
      'event-target-2',
      'event-target-3',
      'event-target-4',
      'event-target-5',
      'event-target-6',
      'event-target-7',
    ];
    let nextId = 0;

    const copied = await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, source.messages, runStore, runtimeEventStore),
      copiedMessages: source.messages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        artifactIds: new Map([
          ['artifact-source', 'artifact-target'],
          ['artifact-deleted', 'artifact-target-deleted'],
        ]),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => ids[nextId++] ?? `generated-${nextId}`,
    });

    assert.deepEqual(copied.runIdMap, [{ sourceRunId: 'run-source', targetRunId: 'run-target' }]);
    const copiedTypedResult = copied.copiedMessages.find(
      (message) => message.type === 'tool_result' && message.content.kind === 'subagent',
    );
    assert.deepEqual(
      copiedTypedResult?.type === 'tool_result' && copiedTypedResult.content.kind === 'subagent'
        ? copiedTypedResult.content.artifactIds
        : undefined,
      ['artifact-target-deleted'],
    );
    const [targetRun] = await runtimeEventStore.listSessionInvocations('session-target');
    assert.equal(targetRun?.runId, 'run-target');
    assert.equal(targetRun?.invocationId, 'run-target');
    assert.equal(targetRun?.terminalEvent?.status, 'completed');
    const targetEvents = await runtimeEventStore.readRuntimeEvents('session-target', 'run-target');
    assert.deepEqual(
      targetEvents.map((event) => event.id),
      [
        'event-target-1',
        'event-target-2',
        'event-target-3',
        'event-target-4',
        'event-target-5',
        'event-target-6',
        'event-target-7',
      ],
    );
    assert.ok(
      targetEvents.every(
        (event) =>
          event.sessionId === 'session-target' &&
          event.runId === 'run-target' &&
          event.invocationId === 'run-target',
      ),
    );
    // The opening fact is the run's first event, so the copied source events
    // line up with it one place along.
    const copiedEvents = targetEvents.slice(1);
    assert.equal(copiedEvents[0]?.refs?.artifactId, 'artifact-target');
    assert.equal(
      copiedEvents[0]?.content?.kind === 'text' ? copiedEvents[0].content.text : undefined,
      targetAttachmentText,
    );
    assert.equal(
      copied.copiedMessages.find((message) => message.type === 'assistant')?.text,
      targetAttachmentText,
    );
    assert.equal(copiedEvents[1]?.refs?.sourceInvocationId, 'run-target');
    assert.deepEqual(
      copiedEvents[1]?.content?.kind === 'function_call' ? copiedEvents[1].content.args : undefined,
      sourceEvents[1]?.content?.kind === 'function_call' ? sourceEvents[1].content.args : undefined,
    );
    assert.deepEqual(
      copiedEvents[2]?.content?.kind === 'function_response'
        ? copiedEvents[2].content.result
        : undefined,
      sourceEvents[2]?.content?.kind === 'function_response'
        ? sourceEvents[2].content.result
        : undefined,
    );
    const typedResultValue =
      copiedEvents[4]?.content?.kind === 'function_response'
        ? copiedEvents[4].content.result
        : undefined;
    const typedResult = decodeCanonicalToolResultContent(typedResultValue);
    assert.equal(typedResult.kind === 'subagent' ? typedResult.permissionMode : undefined, 'ask');
    assert.deepEqual(typedResult.kind === 'subagent' ? typedResult.artifactIds : undefined, [
      'artifact-target-deleted',
    ]);
    const targetOperationalEvents = await runStore.readEvents('session-target', 'run-target');
    // The retired provider-request writers are treated like any other type this
    // build cannot emit: their rows are not carried into the target.
    assert.deepEqual(
      targetOperationalEvents.map((event) => event.type),
      ['history_compact_checkpoint_recorded', 'model_stream_completed'],
    );
    // A copied RuntimeEvent still points somewhere new, though. Carrying the
    // source's trace identity into the target is the thing the copy exists to
    // prevent, whether or not the record naming that trace came along.
    assert.notEqual(copiedEvents[1]?.refs?.providerRequestTraceId, 'provider-trace-source');
    assert.ok(copiedEvents[1]?.refs?.providerRequestTraceId);
    assert.equal(targetEvents[1]?.refs?.traceEventId, undefined);
    assert.doesNotMatch(JSON.stringify(targetOperationalEvents), /OPAQUE_SOURCE_COMPACTION_STATE/);
    const projectedCheckpoint = await runStore.readEventProjection?.(
      'session-target',
      'history_compact_checkpoint_recorded',
    );
    assert.ok(projectedCheckpoint);
    const targetCheckpoint = projectedCheckpoint.data?.checkpoint;
    assert.ok(validateHistoryCompactCheckpointShape(targetCheckpoint, 'session-target'));
    assert.equal(
      matchHistoryCompactCheckpointPrefix(
        targetCheckpoint,
        targetEvents.filter(isHistoryCompactContentEvent),
      ).reason,
      undefined,
    );
    const [sourceInvocation] = await runtimeEventStore.listSessionInvocations('session-source');
    assert.equal(sourceInvocation?.terminalEvent?.status, 'completed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy rebuilds an inline checkpoint without legacy child events in its prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-checkpoint-copy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const firstRun = runFacts({
      runId: 'run-1',
      invocationId: 'invocation-1',
      turnId: 'turn-1',
      cwd: root,
    });
    const secondRun = runFacts({
      runId: 'run-2',
      invocationId: 'invocation-2',
      turnId: 'turn-2',
      cwd: root,
      openedAt: 3,
      closedAt: 5,
    });
    const childRun = runFacts({
      runId: 'run-child',
      invocationId: 'invocation-child',
      turnId: 'turn-child',
      parentRunId: 'run-1',
      cwd: root,
      openedAt: 2.1,
      closedAt: 2.9,
    });
    await seedRun(runtimeEventStore, firstRun);
    await seedRun(runtimeEventStore, childRun);
    await seedRun(runtimeEventStore, secondRun);
    const firstEvents = [
      runtimeEvent({
        id: 'event-1-user',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'first' },
      }),
      runtimeEvent({
        id: 'event-1-assistant',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 4,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'first response' },
      }),
      runtimeEvent({
        id: 'event-1-terminal',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 2,
        role: 'system',
        author: 'system',
        status: 'completed',
      }),
    ];
    const secondEvents = [
      runtimeEvent({
        id: 'event-2-user',
        invocationId: 'invocation-2',
        runId: 'run-2',
        turnId: 'turn-2',
        ts: 3,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'second' },
      }),
      runtimeEvent({
        id: 'event-2-assistant',
        invocationId: 'invocation-2',
        runId: 'run-2',
        turnId: 'turn-2',
        ts: 4.5,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'second response' },
      }),
      runtimeEvent({
        id: 'event-2-terminal',
        invocationId: 'invocation-2',
        runId: 'run-2',
        turnId: 'turn-2',
        ts: 5,
        role: 'system',
        author: 'system',
        status: 'completed',
      }),
    ];
    const childEvents = [
      runtimeEvent({
        id: 'event-child-output',
        invocationId: 'invocation-child',
        runId: 'run-child',
        turnId: 'turn-child',
        ts: 2.5,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'legacy child output' },
      }),
      runtimeEvent({
        id: 'event-child-terminal',
        invocationId: 'invocation-child',
        runId: 'run-child',
        turnId: 'turn-child',
        ts: 2.9,
        role: 'system',
        author: 'system',
        status: 'completed',
      }),
    ];
    for (const event of [
      firstEvents[0]!,
      childEvents[0]!,
      secondEvents[0]!,
      firstEvents[1]!,
      secondEvents[1]!,
      firstEvents[2]!,
      childEvents[1]!,
      secondEvents[2]!,
    ]) {
      await runtimeEventStore.appendRuntimeEvent(event.sessionId, event.runId, event);
    }
    const sourceEvents = [
      firstEvents[0]!,
      secondEvents[0]!,
      firstEvents[1]!,
      secondEvents[1]!,
      firstEvents[2]!,
      secondEvents[2]!,
    ];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-source',
      coveredRuntimeEvents: sourceEvents.filter(isHistoryCompactContentEvent),
      summary: sectionedSummary('Both retained turns are complete.'),
      highWaterSeq: 5,
    });
    await runStore.appendEvent('session-source', 'run-2', {
      type: 'history_compact_checkpoint_recorded',
      id: 'checkpoint-cross-run',
      runId: 'run-2',
      sessionId: 'session-source',
      turnId: 'turn-2',
      ts: 4,
      data: {
        checkpointId: checkpoint.checkpointId,
        highWaterName: checkpoint.highWaterName,
        highWaterSeq: checkpoint.highWaterSeq,
        boundaryKind: 'historyCompact',
        checkpoint,
      },
    });
    const source = await new RuntimeReadModel({
      runtimeEventStore,
    }).getSessionView('session-source');
    let sequence = 0;

    await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, source.messages, runStore, runtimeEventStore),
      copiedMessages: source.messages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        artifactIds: new Map(),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => `target-${++sequence}`,
    });

    const targetRuns = await runtimeEventStore.listSessionInvocations('session-target');
    const targetInlineRunIds = new Set(
      targetRuns.filter((run) => isSessionInlineInvocation(run.opening)).map((run) => run.runId),
    );
    const targetEvents = (await runtimeEventStore.readSessionRuntimeEventEntries('session-target'))
      .map(({ event }) => event)
      .filter((event) => targetInlineRunIds.has(event.runId));
    assert.ok(targetRuns.some((run) => !isSessionInlineInvocation(run.opening)));
    const projectedCheckpoint = await runStore.readEventProjection?.(
      'session-target',
      'history_compact_checkpoint_recorded',
    );
    assert.ok(projectedCheckpoint);
    assert.ok(
      validateHistoryCompactCheckpointShape(projectedCheckpoint.data?.checkpoint, 'session-target'),
    );
    assert.equal(
      matchHistoryCompactCheckpointPrefix(
        projectedCheckpoint.data.checkpoint,
        targetEvents.filter(
          (event) => targetInlineRunIds.has(event.runId) && isHistoryCompactContentEvent(event),
        ),
      ).reason,
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy drops a checkpoint from a superseded source policy instead of failing', async () => {
  // A ledger keeps every checkpoint it ever recorded, so a session that
  // compacted under an older source policy still carries that record forever.
  // Copy must treat it as absent — the copy carries the canonical raw
  // RuntimeEvents and can compact again — or those sessions become permanently
  // unbranchable (apache/maka#4283).
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-legacy-policy-copy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const run = runFacts({
      runId: 'run-source',
      invocationId: 'invocation-1',
      turnId: 'turn-1',
      cwd: root,
      closedAt: 3,
    });
    await seedRun(runtimeEventStore, run);
    const sourceEvents = [
      runtimeEvent({
        id: 'event-user',
        invocationId: 'invocation-1',
        runId: 'run-source',
        turnId: 'turn-1',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'first' },
      }),
      runtimeEvent({
        id: 'event-terminal',
        invocationId: 'invocation-1',
        runId: 'run-source',
        turnId: 'turn-1',
        ts: 2,
        role: 'system',
        author: 'system',
        status: 'completed',
      }),
    ];
    for (const event of sourceEvents) {
      await runtimeEventStore.appendRuntimeEvent(event.sessionId, event.runId, event);
    }
    const current = buildHistoryCompactCheckpoint({
      sessionId: 'session-source',
      coveredRuntimeEvents: sourceEvents.filter(isHistoryCompactContentEvent),
      summary: sectionedSummary('Everything so far is complete.'),
      highWaterSeq: 5,
    });
    const legacyPolicyCheckpoint = {
      ...current,
      source: {
        ...current.source,
        policyVersion: 'maka.compactable_runtime_event_projection.v1',
      },
    };
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'history_compact_checkpoint_recorded',
      id: 'checkpoint-legacy-policy',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 2.5,
      data: {
        checkpointId: legacyPolicyCheckpoint.checkpointId,
        highWaterName: legacyPolicyCheckpoint.highWaterName,
        highWaterSeq: legacyPolicyCheckpoint.highWaterSeq,
        boundaryKind: 'historyCompact',
        checkpoint: legacyPolicyCheckpoint,
      },
    });
    const source = await new RuntimeReadModel({
      runtimeEventStore,
    }).getSessionView('session-source');
    let sequence = 0;

    await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, source.messages, runStore, runtimeEventStore),
      copiedMessages: source.messages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        artifactIds: new Map(),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => `target-${++sequence}`,
    });

    const targetRuns = await runtimeEventStore.listSessionInvocations('session-target');
    assert.ok(targetRuns.length > 0);
    const targetOperationalEvents = (
      await Promise.all(targetRuns.map((run) => runStore.readEvents('session-target', run.runId)))
    ).flat();
    assert.equal(
      targetOperationalEvents.some((event) => event.type === 'history_compact_checkpoint_recorded'),
      false,
    );
    const targetEvents = (
      await Promise.all(
        targetRuns.map((run) => runtimeEventStore.readRuntimeEvents('session-target', run.runId)),
      )
    ).flat();
    // The opening fact is one of the run's events, so the copy carries it too.
    assert.equal(targetEvents.length, sourceEvents.length + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy rebuilds a resumed child checkpoint over its child run chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-child-checkpoint-copy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const rootRun = runFacts({
      runId: 'run-root',
      invocationId: 'invocation-root',
      turnId: 'turn-root',
      cwd: root,
    });
    const firstChild = runFacts({
      runId: 'run-child-1',
      invocationId: 'invocation-child-1',
      turnId: 'turn-child-1',
      parentRunId: 'run-root',
      agentId: 'researcher',
      agentName: 'Researcher',
      cwd: root,
      openedAt: 3,
      closedAt: 5,
    });
    const resumedChild = runFacts({
      runId: 'run-child-2',
      invocationId: 'invocation-child-2',
      turnId: 'turn-child-2',
      parentRunId: 'run-root',
      resumedFromRunId: 'run-child-1',
      agentId: 'researcher',
      agentName: 'Researcher',
      cwd: root,
      openedAt: 6,
      closedAt: 8,
    });
    for (const run of [rootRun, firstChild, resumedChild]) await seedRun(runtimeEventStore, run);

    const rootEvents = [
      runtimeEvent({
        id: 'event-root-user',
        invocationId: 'invocation-root',
        runId: 'run-root',
        turnId: 'turn-root',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'delegate' },
      }),
      runtimeEvent({
        id: 'event-root-terminal',
        invocationId: 'invocation-root',
        runId: 'run-root',
        turnId: 'turn-root',
        ts: 2,
        status: 'completed',
      }),
    ];
    const firstChildEvents = [
      runtimeEvent({
        id: 'event-child-1-user',
        invocationId: 'invocation-child-1',
        runId: 'run-child-1',
        turnId: 'turn-child-1',
        ts: 3,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'first child prompt' },
      }),
      runtimeEvent({
        id: 'event-child-1-terminal',
        invocationId: 'invocation-child-1',
        runId: 'run-child-1',
        turnId: 'turn-child-1',
        ts: 5,
        status: 'completed',
      }),
    ];
    const resumedChildEvents = [
      runtimeEvent({
        id: 'event-child-2-user',
        invocationId: 'invocation-child-2',
        runId: 'run-child-2',
        turnId: 'turn-child-2',
        ts: 6,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'resume child work' },
      }),
      runtimeEvent({
        id: 'event-child-2-terminal',
        invocationId: 'invocation-child-2',
        runId: 'run-child-2',
        turnId: 'turn-child-2',
        ts: 8,
        status: 'completed',
      }),
    ];
    for (const event of [...rootEvents, ...firstChildEvents, ...resumedChildEvents]) {
      await runtimeEventStore.appendRuntimeEvent(event.sessionId, event.runId, event);
    }
    const childSourceEvents = [...firstChildEvents, ...resumedChildEvents].filter(
      isHistoryCompactContentEvent,
    );
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-source',
      coveredRuntimeEvents: childSourceEvents,
      summary: sectionedSummary('The resumed child retained both child turns.'),
      highWaterSeq: 8,
    });
    await runStore.appendEvent('session-source', 'run-child-2', {
      type: 'history_compact_checkpoint_recorded',
      id: 'checkpoint-child-chain',
      runId: 'run-child-2',
      sessionId: 'session-source',
      turnId: 'turn-child-2',
      ts: 7,
      data: {
        checkpointId: checkpoint.checkpointId,
        highWaterName: checkpoint.highWaterName,
        highWaterSeq: checkpoint.highWaterSeq,
        boundaryKind: 'historyCompact',
        checkpoint,
      },
    });
    const source = await new RuntimeReadModel({
      runtimeEventStore,
    }).getSessionView('session-source');
    let sequence = 0;

    const copied = await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, source.messages, runStore, runtimeEventStore),
      copiedMessages: source.messages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        artifactIds: new Map(),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => `target-${++sequence}`,
    });

    const runIds = new Map(
      copied.runIdMap.map(({ sourceRunId, targetRunId }) => [sourceRunId, targetRunId]),
    );
    const targetResumedChild = (
      await runtimeEventStore.listSessionInvocations('session-target')
    ).find((run) => run.runId === runIds.get('run-child-2'));
    assert.ok(targetResumedChild);
    const targetChildEvents = (
      await Promise.all(
        ['run-child-1', 'run-child-2'].map((sourceRunId) =>
          runtimeEventStore.readRuntimeEvents('session-target', runIds.get(sourceRunId)!),
        ),
      )
    )
      .flat()
      .filter(isHistoryCompactContentEvent);
    const projectedCheckpoint = await runStore.readEventProjection?.(
      'session-target',
      'history_compact_checkpoint_recorded',
    );
    assert.ok(projectedCheckpoint);
    assert.ok(
      validateHistoryCompactCheckpointShape(projectedCheckpoint.data?.checkpoint, 'session-target'),
    );
    assert.equal(
      matchHistoryCompactCheckpointPrefix(projectedCheckpoint.data.checkpoint, targetChildEvents)
        .reason,
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const TRANSITION_SECRET_BODY = 'SECRET_ARCHIVED_TOOL_RESULT_BODY';

function sourceProjectionTransition(input: {
  event: RuntimeEvent;
  sourceProjection: DurableToolResultProjection;
  artifactId: string;
  createdAt: number;
  previousTransitionId?: string;
}): ModelProjectionTransition {
  const serialized = serializedToolResultProjection(input.sourceProjection);
  const placeholder = buildArchivedToolResultPlaceholder({
    artifactId: input.artifactId,
    runtimeEventId: input.event.id,
    toolCallId: 'tool-1',
    toolName: 'Read',
    bodySha256: sha256(serialized),
    originalEstimatedTokens: serialized.length,
    originalBytes: serialized.length,
    reason: 'stale_tool_result_pruned_before_compact',
  });
  return buildModelProjectionTransition({
    sessionId: 'session-source',
    target: {
      runtimeEventId: input.event.id,
      part: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'Read',
    },
    sourceProjection: input.sourceProjection,
    replacement: archivedToolResultProjection(placeholder),
    ...(input.previousTransitionId ? { previousTransitionId: input.previousTransitionId } : {}),
    now: input.createdAt,
  });
}

test('conversation copy rebuilds projection transitions against the copied events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-transition-copy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    await seedRun(runtimeEventStore, {
      runId: 'run-source',
      invocationId: 'invocation-source',
      turnId: 'turn-1',
      cwd: root,
    });
    const resultEvent = runtimeEvent({
      id: 'event-result',
      ts: 2,
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'tool-1',
        name: 'Read',
        result: { kind: 'text', text: TRANSITION_SECRET_BODY },
      },
    });
    for (const event of [
      runtimeEvent({
        id: 'event-user',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'copy this turn' },
      }),
      runtimeEvent({
        id: 'event-call',
        ts: 1.5,
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'notes.txt' } },
      }),
      resultEvent,
      runtimeEvent({ id: 'event-terminal', ts: 3, status: 'completed' }),
    ]) {
      await runtimeEventStore.appendRuntimeEvent('session-source', 'run-source', event);
    }
    // Two chained transitions on one target: the copy has to remap the target,
    // both archives and the lineage link, and re-derive each source digest
    // against what the previous rebuilt transition left behind.
    const first = sourceProjectionTransition({
      event: resultEvent,
      sourceProjection: baseToolResultProjection(resultEvent)!,
      artifactId: 'artifact-source-1',
      createdAt: 101,
    });
    const second = sourceProjectionTransition({
      event: resultEvent,
      sourceProjection: first.replacement,
      artifactId: 'artifact-source-2',
      createdAt: 102,
      previousTransitionId: first.transitionId,
    });
    for (const transition of [first, second]) {
      await runStore.appendEvent('session-source', 'run-source', {
        type: MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
        id: transition.transitionId,
        runId: 'run-source',
        sessionId: 'session-source',
        turnId: 'turn-1',
        ts: transition.createdAt,
        data: {
          runtimeEventId: transition.target.runtimeEventId,
          part: transition.target.part,
          transition,
        },
      });
    }
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'model_stream_completed',
      id: 'completed-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 4,
    });
    const source = await new RuntimeReadModel({
      runtimeEventStore,
    }).getSessionView('session-source');

    await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, source.messages, runStore, runtimeEventStore),
      copiedMessages: source.messages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        artifactIds: new Map([
          ['artifact-source-1', 'artifact-target-1'],
          ['artifact-source-2', 'artifact-target-2'],
        ]),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => crypto.randomUUID(),
    });

    const [targetRun] = await runtimeEventStore.listSessionInvocations('session-target');
    assert.ok(targetRun);
    const targetEvents = await runtimeEventStore.readRuntimeEvents(
      'session-target',
      targetRun.runId,
    );
    const targetResult = targetEvents.find((event) => event.content?.kind === 'function_response');
    assert.ok(targetResult);
    assert.notEqual(targetResult.id, 'event-result');
    const copiedTransitions = await loadModelProjectionTransitionsFromRunLedger(
      runStore,
      'session-target',
      (await runtimeEventStore.listSessionInvocations('session-target')).map((run) => run.runId),
    );
    assert.equal(copiedTransitions.transitions.length, 2);
    const copiedFirst = copiedTransitions.transitions.find(
      (transition) => transition.previousTransitionId === undefined,
    );
    assert.ok(copiedFirst);
    const copiedSecond = copiedTransitions.transitions.find(
      (transition) => transition.previousTransitionId === copiedFirst.transitionId,
    );
    assert.ok(copiedSecond);
    for (const transition of copiedTransitions.transitions) {
      assert.equal(transition.sessionId, 'session-target');
      assert.equal(transition.target.runtimeEventId, targetResult.id);
    }
    // Lineage is preserved through the remapped ids, never through the source's.
    assert.notEqual(copiedFirst.transitionId, first.transitionId);
    assert.doesNotMatch(
      JSON.stringify(copiedTransitions.transitions),
      /artifact-source|event-result/,
    );

    // The copied ledger still carries the raw body — it is append-only — but the
    // copied transitions still reduce it away, which is the only property that
    // makes a copy of an archived Session safe.
    assert.match(JSON.stringify(targetEvents), /SECRET_ARCHIVED_TOOL_RESULT_BODY/);
    const reduced = reduceEffectiveModelProjections(targetEvents, copiedTransitions.transitions);
    assert.equal(reduced.applied.length, 2);
    assert.equal(reduced.rejected.length, 0);
    assert.doesNotMatch(JSON.stringify(reduced.events), /SECRET_ARCHIVED_TOOL_RESULT_BODY/);
    const effective = reduced.events.find((event) => event.content?.kind === 'function_response');
    assert.ok(effective?.content?.kind === 'function_response');
    assert.ok(isArchivedToolResultPlaceholder(effective.content.result));
    assert.equal(effective.content.result.artifactId, 'artifact-target-2');
    assert.equal(effective.content.result.runtimeEventId, targetResult.id);
    // Only the surviving placeholder's archive is reachable; the one it
    // superseded is not, and cleanup may reclaim it.
    assert.deepEqual(
      [...collectReachableArchiveArtifactIds(reduced.events)],
      ['artifact-target-2'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy carries a transition recorded by a later, uncopied run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-transition-run-copy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    for (const [runId, turnId] of [
      ['run-first', 'turn-1'],
      ['run-second', 'turn-2'],
    ]) {
      await seedRun(
        runtimeEventStore,
        runFacts({
          runId,
          invocationId: `invocation-${runId}`,
          turnId,
          cwd: root,
        }),
      );
    }
    const resultEvent = runtimeEvent({
      id: 'event-result',
      runId: 'run-first',
      invocationId: 'invocation-run-first',
      ts: 2,
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'tool-1',
        name: 'Read',
        result: { kind: 'text', text: TRANSITION_SECRET_BODY },
      },
    });
    for (const event of [
      runtimeEvent({
        id: 'event-user',
        runId: 'run-first',
        invocationId: 'invocation-run-first',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'first turn' },
      }),
      runtimeEvent({
        id: 'event-call',
        runId: 'run-first',
        invocationId: 'invocation-run-first',
        ts: 1.5,
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'notes.txt' } },
      }),
      resultEvent,
      runtimeEvent({
        id: 'event-terminal',
        runId: 'run-first',
        invocationId: 'invocation-run-first',
        ts: 3,
        status: 'completed',
      }),
    ]) {
      await runtimeEventStore.appendRuntimeEvent('session-source', 'run-first', event);
    }
    for (const event of [
      runtimeEvent({
        id: 'event-user-2',
        runId: 'run-second',
        invocationId: 'invocation-run-second',
        turnId: 'turn-2',
        ts: 4,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'second turn' },
      }),
      runtimeEvent({
        id: 'event-terminal-2',
        runId: 'run-second',
        invocationId: 'invocation-run-second',
        turnId: 'turn-2',
        ts: 5,
        status: 'completed',
      }),
    ]) {
      await runtimeEventStore.appendRuntimeEvent('session-source', 'run-second', event);
    }
    // The stale prune runs during Turn 2 and archives a Turn 1 result, so the
    // record lives in a run that a copy of Turn 1 alone never visits.
    const transition = sourceProjectionTransition({
      event: resultEvent,
      sourceProjection: baseToolResultProjection(resultEvent)!,
      artifactId: 'artifact-source-1',
      createdAt: 401,
    });
    await runStore.appendEvent('session-source', 'run-second', {
      type: MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
      id: transition.transitionId,
      runId: 'run-second',
      sessionId: 'session-source',
      turnId: 'turn-2',
      ts: transition.createdAt,
      data: {
        runtimeEventId: transition.target.runtimeEventId,
        part: transition.target.part,
        transition,
      },
    });
    for (const [runId, turnId, id] of [
      ['run-first', 'turn-1', 'completed-first'],
      ['run-second', 'turn-2', 'completed-second'],
    ]) {
      await runStore.appendEvent('session-source', runId, {
        type: 'model_stream_completed',
        id,
        runId,
        sessionId: 'session-source',
        turnId,
        ts: 6,
      });
    }
    const source = await new RuntimeReadModel({
      runtimeEventStore,
    }).getSessionView('session-source');
    const firstTurnMessages = source.messages.filter(
      (message) => 'turnId' in message && message.turnId === 'turn-1',
    );

    await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, firstTurnMessages, runStore, runtimeEventStore),
      copiedMessages: firstTurnMessages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        artifactIds: new Map([['artifact-source-1', 'artifact-target-1']]),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => crypto.randomUUID(),
    });

    const targetRuns = await runtimeEventStore.listSessionInvocations('session-target');
    assert.equal(targetRuns.length, 1);
    const targetEvents = await runtimeEventStore.readRuntimeEvents(
      'session-target',
      targetRuns[0]!.runId,
    );
    const copied = await loadModelProjectionTransitionsFromRunLedger(runStore, 'session-target', [
      targetRuns[0]!.runId,
    ]);
    assert.equal(copied.transitions.length, 1);
    assert.equal(
      copied.transitions[0]?.target.runtimeEventId,
      targetEvents.find((event) => event.content?.kind === 'function_response')?.id,
    );
    // Dropping the record while keeping its target would restore the archived
    // body in the copy — the one thing the protocol exists to prevent.
    const reduced = reduceEffectiveModelProjections(targetEvents, copied.transitions);
    assert.equal(reduced.applied.length, 1);
    assert.doesNotMatch(JSON.stringify(reduced.events), /SECRET_ARCHIVED_TOOL_RESULT_BODY/);
    assert.deepEqual(
      [...collectReachableArchiveArtifactIds(reduced.events)],
      ['artifact-target-1'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy reproduces the source fold rather than re-deciding it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-transition-rival-copy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    for (const [runId, turnId] of [
      ['run-first', 'turn-1'],
      ['run-second', 'turn-2'],
    ]) {
      await seedRun(
        runtimeEventStore,
        runFacts({ runId, invocationId: `invocation-${runId}`, turnId, cwd: root }),
      );
    }
    const resultEvent = runtimeEvent({
      id: 'event-result',
      runId: 'run-first',
      invocationId: 'invocation-run-first',
      ts: 2,
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'tool-1',
        name: 'Read',
        result: { kind: 'text', text: TRANSITION_SECRET_BODY },
      },
    });
    for (const event of [
      runtimeEvent({
        id: 'event-user',
        runId: 'run-first',
        invocationId: 'invocation-run-first',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'first turn' },
      }),
      runtimeEvent({
        id: 'event-call',
        runId: 'run-first',
        invocationId: 'invocation-run-first',
        ts: 1.5,
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'notes.txt' } },
      }),
      resultEvent,
      runtimeEvent({
        id: 'event-terminal',
        runId: 'run-first',
        invocationId: 'invocation-run-first',
        ts: 3,
        status: 'completed',
      }),
    ]) {
      await runtimeEventStore.appendRuntimeEvent('session-source', 'run-first', event);
    }
    for (const event of [
      runtimeEvent({
        id: 'event-user-2',
        runId: 'run-second',
        invocationId: 'invocation-run-second',
        turnId: 'turn-2',
        ts: 4,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'second turn' },
      }),
      runtimeEvent({
        id: 'event-terminal-2',
        runId: 'run-second',
        invocationId: 'invocation-run-second',
        turnId: 'turn-2',
        ts: 5,
        status: 'completed',
      }),
    ]) {
      await runtimeEventStore.appendRuntimeEvent('session-source', 'run-second', event);
    }
    // Two rival roots against the same source. The source fold accepts exactly
    // one of them — by content-derived id, not by which run or which timestamp.
    const rivals = ['artifact-source-a', 'artifact-source-b'].map((artifactId, index) =>
      sourceProjectionTransition({
        event: resultEvent,
        sourceProjection: baseToolResultProjection(resultEvent)!,
        artifactId,
        createdAt: 401 + index,
      }),
    );
    const [inCopiedRun, inLaterRun] = [...rivals].sort((left, right) =>
      left.transitionId < right.transitionId ? 1 : -1,
    );
    assert.ok(inCopiedRun && inLaterRun);
    for (const [transition, runId, turnId] of [
      [inCopiedRun, 'run-first', 'turn-1'],
      [inLaterRun, 'run-second', 'turn-2'],
    ] as const) {
      await runStore.appendEvent('session-source', runId, {
        type: MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
        id: transition.transitionId,
        runId,
        sessionId: 'session-source',
        turnId,
        ts: transition.createdAt,
        data: {
          runtimeEventId: transition.target.runtimeEventId,
          part: transition.target.part,
          transition,
        },
      });
    }
    for (const [runId, turnId, id] of [
      ['run-first', 'turn-1', 'completed-first'],
      ['run-second', 'turn-2', 'completed-second'],
    ]) {
      await runStore.appendEvent('session-source', runId, {
        type: 'model_stream_completed',
        id,
        runId,
        sessionId: 'session-source',
        turnId,
        ts: 6,
      });
    }
    const source = await new RuntimeReadModel({
      runtimeEventStore,
    }).getSessionView('session-source');
    const firstTurnMessages = source.messages.filter(
      (message) => 'turnId' in message && message.turnId === 'turn-1',
    );

    await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, firstTurnMessages, runStore, runtimeEventStore),
      copiedMessages: firstTurnMessages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        artifactIds: new Map([
          ['artifact-source-a', 'artifact-target-a'],
          ['artifact-source-b', 'artifact-target-b'],
        ]),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => crypto.randomUUID(),
    });

    const [targetRun] = await runtimeEventStore.listSessionInvocations('session-target');
    assert.ok(targetRun);
    const targetEvents = await runtimeEventStore.readRuntimeEvents(
      'session-target',
      targetRun.runId,
    );
    const copied = await loadModelProjectionTransitionsFromRunLedger(runStore, 'session-target', [
      targetRun.runId,
    ]);
    // Only the transition the source fold applied is rebuilt. Carrying the
    // rejected rival would let the copy re-decide and show a placeholder the
    // source never showed.
    assert.equal(copied.transitions.length, 1);
    const reduced = reduceEffectiveModelProjections(targetEvents, copied.transitions);
    assert.equal(reduced.applied.length, 1);
    const effective = reduced.events.find((event) => event.content?.kind === 'function_response');
    assert.ok(effective?.content?.kind === 'function_response');
    assert.ok(isArchivedToolResultPlaceholder(effective.content.result));
    const sourceWinner = reduceEffectiveModelProjections([resultEvent], rivals).applied[0]!;
    assert.equal(
      effective.content.result.artifactId,
      sourceWinner.transitionId === inCopiedRun.transitionId
        ? 'artifact-target-a'
        : 'artifact-target-b',
    );
    assert.doesNotMatch(JSON.stringify(reduced.events), /SECRET_ARCHIVED_TOOL_RESULT_BODY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy gives a run whose opening the migration shelved its opening back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-shelved-copy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    await seedRun(
      runtimeEventStore,
      runFacts({ runId: 'run-source', invocationId: 'run-source', turnId: 'turn-1', cwd: root }),
    );
    const sourceEvents: RuntimeEvent[] = [
      runtimeEvent({
        id: 'event-user',
        invocationId: 'run-source',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'hello' },
      }),
      runtimeEvent({
        id: 'event-terminal',
        invocationId: 'run-source',
        ts: 3,
        status: 'completed',
      }),
    ];
    for (const event of sourceEvents) {
      await runtimeEventStore.appendRuntimeEvent('session-source', 'run-source', event);
    }
    // Leave the run the way the migration leaves one that already owned an
    // immutable sequence: its opening on the legacy shelf, not among its events.
    const db = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
    try {
      const opening = db
        .prepare(
          "SELECT event_id, payload_json, committed_at FROM runtime_events WHERE run_id = 'run-source' AND event_kind = 'invocation_opened'",
        )
        .get() as { event_id: string; payload_json: string; committed_at: number };
      db.prepare('DELETE FROM runtime_session_event_ordinals WHERE event_id = ?').run(
        opening.event_id,
      );
      db.prepare('DELETE FROM runtime_events WHERE event_id = ?').run(opening.event_id);
      const anchor = db
        .prepare(
          "SELECT event_id FROM runtime_events WHERE run_id = 'run-source' ORDER BY event_seq ASC LIMIT 1",
        )
        .get() as { event_id: string };
      db.prepare(`
        INSERT INTO runtime_legacy_invocation_openings (
          invocation_id, session_id, run_id, turn_id, opened_at, opening_json,
          anchor_event_id
        ) VALUES ('run-source', 'session-source', 'run-source', 'turn-1', ?, ?, ?)
      `).run(
        opening.committed_at,
        JSON.stringify((JSON.parse(opening.payload_json) as { content: unknown }).content),
        anchor.event_id,
      );
    } finally {
      db.close();
    }
    const [sourceRun] = await runtimeEventStore.listSessionInvocations('session-source');
    assert.equal(sourceRun?.runId, 'run-source', 'the shelved opening still names the run');
    assert.equal(
      (await runtimeEventStore.readRuntimeEvents('session-source', 'run-source')).some(
        (event) => event.content?.kind === 'invocation_opened',
      ),
      false,
      'but its events do not carry it',
    );

    const source = await new RuntimeReadModel({ runtimeEventStore }).getSessionView(
      'session-source',
    );
    const copied = await cloneConversationRuntimeLedger({
      plan: await prepareTestCopyPlan(source, source.messages, runStore, runtimeEventStore),
      copiedMessages: source.messages,
      referenceMap: {
        mode: 'exact',
        linkedChildren: { mode: 'reject' },
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        artifactIds: new Map(),
        relativePaths: new Map(),
      },
      runStore,
      runtimeEventStore,
      newId: () => crypto.randomUUID(),
    });

    const [targetRun] = await runtimeEventStore.listSessionInvocations('session-target');
    assert.equal(targetRun?.runId, copied.runIdMap[0]?.targetRunId);
    assert.equal(targetRun?.terminalEvent?.status, 'completed');
    assert.deepEqual(targetRun?.opening.configuration.cwd, root);
    const targetEvents = await runtimeEventStore.readRuntimeEvents(
      'session-target',
      targetRun!.runId,
    );
    assert.deepEqual(
      targetEvents.map((event) => event.content?.kind ?? event.status),
      ['invocation_opened', 'text', 'completed'],
      'the copy is a fresh sequence, so the opening is its first event',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function prepareTestCopyPlan(
  source: RuntimeReadModelSessionView,
  copiedMessages: readonly StoredMessage[],
  runStore: Pick<AgentRunStore, 'readEvents'>,
  runtimeEventStore: Pick<RuntimeEventStore, 'readRuntimeEvents' | 'listSessionInvocations'>,
) {
  return prepareConversationRuntimeLedgerCopy({
    sourceSessionId: 'session-source',
    sourceEvents: source.events,
    copiedMessages,
    runStore,
    runtimeEventStore,
  });
}

function runtimeEvent(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event',
    invocationId: 'invocation-source',
    runId: 'run-source',
    sessionId: 'session-source',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

interface SeededRun {
  runId?: string;
  invocationId?: string;
  sessionId?: string;
  turnId?: string;
  cwd?: string;
  parentRunId?: string;
  resumedFromRunId?: string;
  agentId?: string;
  agentName?: string;
  openedAt?: number;
  closedAt?: number;
  /** How the run ended. `open` leaves it with no terminal event. */
  outcome?: 'completed' | 'failed' | 'aborted' | 'open';
}

/** The facts a test states about a run it seeds. Nothing keeps this shape after the seed. */
function runFacts(overrides: SeededRun): SeededRun {
  return { sessionId: 'session-source', ...overrides };
}

/** One invocation as a reader sees it, for tests that stub the store instead of writing to it. */
function invocationRecord(
  run: SeededRun & { source?: RuntimeEventInvocationOpenedContent['source'] } = {},
): RuntimeInvocationRecord {
  const openedAt = run.openedAt ?? 1;
  return testInvocationRecord({
    sessionId: run.sessionId ?? 'session-source',
    invocationId: run.invocationId ?? 'invocation',
    runId: run.runId ?? 'run',
    turnId: run.turnId ?? 'turn',
    openedAt,
    closedAt: run.closedAt ?? openedAt + 1,
    ...(run.outcome === 'open' ? {} : { outcome: run.outcome ?? 'completed' }),
    opening: invocationOpening(run),
  });
}

function invocationOpening(
  run: SeededRun & { source?: RuntimeEventInvocationOpenedContent['source'] },
): RuntimeEventInvocationOpenedContent {
  const lineage = {
    ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
    ...(run.resumedFromRunId ? { resumedFromRunId: run.resumedFromRunId } : {}),
    ...(run.agentId ? { agentId: run.agentId } : {}),
    ...(run.agentName ? { agentName: run.agentName } : {}),
  };
  return testInvocationOpening({
    route: {
      provenance: 'runtime',
      backendKind: 'fake',
      llmConnectionId: 'fake-connection',
      llmConnectionSlug: 'fake',
      modelId: 'model',
    },
    configuration: { cwd: run.cwd ?? '/tmp' },
    ...(run.source ? { source: run.source } : {}),
    ...(Object.keys(lineage).length > 0 ? { lineage } : {}),
  });
}

/**
 * Open one invocation on the spine.
 *
 * Every test here writes the run's own events afterwards, ending included, so
 * the seed states only that the run began and what it was routed to.
 */
async function seedRun(
  runtimeEventStore: Pick<RuntimeEventStore, 'appendRuntimeEvent'>,
  run: SeededRun = {},
): Promise<void> {
  const event = invocationOpenedEvent(run);
  await runtimeEventStore.appendRuntimeEvent(event.sessionId, event.runId, event);
}

/** The opening event of one seeded run, for a test that writes its ledger in one batch. */
function invocationOpenedEvent(run: SeededRun = {}): RuntimeEvent {
  const identity = {
    sessionId: run.sessionId ?? 'session-source',
    invocationId: run.invocationId ?? 'invocation',
    runId: run.runId ?? 'run',
    turnId: run.turnId ?? 'turn',
  };
  return buildInvocationOpenedEvent({
    id: `${identity.runId}-invocation-opened`,
    run: identity,
    openedAt: run.openedAt ?? 1,
    opening: invocationOpening(run),
  });
}
