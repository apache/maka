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
import { test } from 'node:test';
import type { AgentRunHeader, AgentRunStore, EmittedAgentRunEvent } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { StoredMessage } from '@maka/core/session';
import { decodeCanonicalToolResultContent } from '@maka/core/tool-result-record-schema';
import { isSessionInlineRun } from '@maka/core/agent-run';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import {
  createSqliteAgentRunStore,
  createSqliteRuntimeStore,
  createWorkspaceRuntimeStore,
} from '@maka/storage';
import {
  archivedToolResultContainsConversationOwnedReferences,
  cloneConversationRuntimeLedger,
  createConversationCopySlice,
  prepareConversationRuntimeLedgerCopy,
  rewriteConversationCopyMessage,
} from '../conversation-copy.js';
import {
  buildHistoryCompactCheckpoint,
  matchHistoryCompactCheckpointPrefix,
  validateHistoryCompactCheckpointShape,
} from '../history-compact-checkpoint.js';
import { isHistoryCompactContentEvent } from '../history-compact.js';
import { RuntimeReadModel, type RuntimeReadModelSessionView } from '../runtime-read-model.js';
import { buildToolOperationId } from '../runtime-commit-sink.js';
import { buildToolResultArchiveResourceRef } from '../tool-result-archive-resource.js';

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
  for (const message of [messages[2]!, messages[3]!]) {
    assert.throws(
      () =>
        rewriteConversationCopyMessage(message, {
          ...references,
          artifactIds: new Map(),
        }),
      /missing Artifact artifact-source/,
    );
  }
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
  const parent = agentRunHeader({ runId: 'run-parent', turnId: 'turn-parent' });
  const child = agentRunHeader({
    runId: 'run-child-retry',
    turnId: 'turn-child-retry',
    parentRunId: 'run-parent',
    agentId: 'agent-child',
    continuationSource: {
      sourceInvocationId: parent.invocationId!,
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
        listSessionRuns: async () => runs,
        readEvents: async () => [],
      },
      runtimeEventStore: {
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

test('conversation copy rejects a retained AgentRun without RuntimeEvent facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-missing-runtime-copy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const rootRun = agentRunHeader({
      runId: 'run-root',
      invocationId: 'invocation-root',
      turnId: 'turn-root',
      cwd: root,
    });
    const childRun = agentRunHeader({
      runId: 'run-child',
      invocationId: 'invocation-child',
      turnId: 'turn-child',
      parentRunId: 'run-root',
      agentId: 'researcher',
      agentName: 'Researcher',
      cwd: root,
    });
    await runStore.createRun(rootRun);
    await runStore.createRun(childRun);
    for (const event of [
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
    ]) {
      await runtimeEventStore.appendRuntimeEvent(event.sessionId, event.runId, event);
    }
    const source = await new RuntimeReadModel({
      runStore,
      runtimeEventStore,
    }).getSessionView('session-source');
    let sequence = 0;

    await assert.rejects(
      async () =>
        cloneConversationRuntimeLedger({
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
        }),
      /Cannot copy AgentRun run-child without RuntimeEvent facts/,
    );
    assert.deepEqual(await runStore.listSessionRuns('session-target'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy rewrites a complete tool recovery bundle atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-recovery-copy-'));
  const runStore = createSqliteAgentRunStore(root);
  const runtimeEventStore = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  try {
    await runStore.ready?.();
    await runStore.createRun(
      agentRunHeader({
        runId: 'run-source',
        invocationId: 'invocation-source',
        turnId: 'turn-1',
        cwd: root,
      }),
    );
    const sourceEvents: RuntimeEvent[] = [
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
      type: 'run_completed',
      id: 'completed-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 7,
    });
    const source = await new RuntimeReadModel({
      runStore,
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
    const [targetRun] = await runStore.listSessionRuns('session-target');
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

test('conversation copy validates operational events before persisting target ledgers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-copy-preflight-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    await runStore.createRun(
      agentRunHeader({
        runId: 'run-source',
        invocationId: 'invocation-source',
        turnId: 'turn-1',
        cwd: root,
      }),
    );
    for (const event of [
      runtimeEvent({
        id: 'event-user',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'copy this turn' },
      }),
      runtimeEvent({
        id: 'event-terminal',
        ts: 2,
        status: 'completed',
      }),
    ]) {
      await runtimeEventStore.appendRuntimeEvent('session-source', 'run-source', event);
    }
    await runStore.appendEvent('session-source', 'run-source', {
      type: 'provider_request_captured',
      id: 'capture-source',
      runId: 'run-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      ts: 1.5,
      data: {
        traceId: 'trace-source',
        captureId: 'wrong-capture-id',
        artifactId: 'artifact-source',
      },
    });
    const source = await new RuntimeReadModel({
      runStore,
      runtimeEventStore,
    }).getSessionView('session-source');

    await assert.rejects(
      async () =>
        cloneConversationRuntimeLedger({
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
        }),
      /Cannot copy invalid provider request capture capture-source/,
    );
    assert.deepEqual(await runStore.listSessionRuns('session-target'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy clones one terminal Runtime ledger with new owned identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-runtime-copy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const sourceRun: AgentRunHeader = {
      runId: 'run-source',
      invocationId: 'invocation-source',
      sessionId: 'session-source',
      turnId: 'turn-1',
      status: 'completed',
      backendKind: 'fake',
      llmConnectionSlug: 'fake',
      modelId: 'model',
      cwd: root,
      permissionMode: 'ask',
      createdAt: 1,
      updatedAt: 3,
      completedAt: 3,
    };
    await runStore.createRun(sourceRun);
    const sourceEvents: RuntimeEvent[] = [
      runtimeEvent({
        id: 'event-user',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'hello' },
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
            permissionMode: 'ask',
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
      summary: 'The source turn called one opaque tool.',
      summaryFormat: 'legacy_freeform',
      highWaterSeq: 3,
    });
    const providerCheckpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-source',
      coveredRuntimeEvents: sourceEvents.filter(isHistoryCompactContentEvent),
      providerState: {
        kind: 'openai_codex_remote_v2',
        connectionSlug: 'codex-source',
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
    });
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
    });
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
    });
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
      type: 'run_completed',
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
      runStore,
      runtimeEventStore,
    }).getSessionView('session-source');
    await assert.rejects(
      async () =>
        cloneConversationRuntimeLedger({
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
        }),
      /missing Artifact artifact-deleted/,
    );
    assert.deepEqual(await runStore.listSessionRuns('session-missing-artifact'), []);
    const ids = [
      'run-target',
      'invocation-target',
      'event-target-1',
      'event-target-2',
      'event-target-3',
      'event-target-4',
      'event-target-5',
      'event-target-6',
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
    const [targetRun] = await runStore.listSessionRuns('session-target');
    assert.equal(targetRun?.runId, 'run-target');
    assert.equal(targetRun?.invocationId, 'invocation-target');
    assert.equal(targetRun?.status, 'completed');
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
      ],
    );
    assert.ok(
      targetEvents.every(
        (event) =>
          event.sessionId === 'session-target' &&
          event.runId === 'run-target' &&
          event.invocationId === 'invocation-target',
      ),
    );
    assert.equal(targetEvents[0]?.refs?.artifactId, 'artifact-target');
    assert.equal(targetEvents[1]?.refs?.sourceInvocationId, 'invocation-target');
    assert.deepEqual(
      targetEvents[1]?.content?.kind === 'function_call' ? targetEvents[1].content.args : undefined,
      sourceEvents[1]?.content?.kind === 'function_call' ? sourceEvents[1].content.args : undefined,
    );
    assert.deepEqual(
      targetEvents[2]?.content?.kind === 'function_response'
        ? targetEvents[2].content.result
        : undefined,
      sourceEvents[2]?.content?.kind === 'function_response'
        ? sourceEvents[2].content.result
        : undefined,
    );
    const typedResultValue =
      targetEvents[4]?.content?.kind === 'function_response'
        ? targetEvents[4].content.result
        : undefined;
    const typedResult = decodeCanonicalToolResultContent(typedResultValue);
    assert.deepEqual(typedResult.kind === 'subagent' ? typedResult.artifactIds : undefined, [
      'artifact-target-deleted',
    ]);
    const targetOperationalEvents = await runStore.readEvents('session-target', 'run-target');
    assert.deepEqual(
      targetOperationalEvents.map((event) => event.type),
      [
        'provider_request_captured',
        'provider_request_attempt_recorded',
        'history_compact_checkpoint_recorded',
        'run_completed',
      ],
    );
    const targetCapture = targetOperationalEvents.find(
      (event) => event.type === 'provider_request_captured',
    );
    const targetAttempt = targetOperationalEvents.find(
      (event) => event.type === 'provider_request_attempt_recorded',
    );
    assert.ok(targetCapture);
    assert.ok(targetAttempt);
    assert.equal(targetCapture.data?.captureId, targetCapture.id);
    assert.equal(targetCapture.data?.artifactId, 'artifact-target');
    assert.notEqual(targetCapture.data?.traceId, 'provider-trace-source');
    assert.equal(targetAttempt.data?.attemptId, targetAttempt.id);
    assert.equal(targetAttempt.data?.captureId, targetCapture.id);
    assert.equal(targetAttempt.data?.captureArtifactId, 'artifact-target');
    assert.equal(targetAttempt.data?.traceId, targetCapture.data?.traceId);
    assert.equal(targetEvents[1]?.refs?.providerRequestTraceId, targetCapture.data?.traceId);
    assert.equal(targetEvents[1]?.refs?.traceEventId, targetCapture.id);
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
    assert.equal((await runStore.readRun('session-source', 'run-source')).status, 'completed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation copy rebuilds an inline checkpoint without legacy child events in its prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-checkpoint-copy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const firstRun = agentRunHeader({
      runId: 'run-1',
      invocationId: 'invocation-1',
      turnId: 'turn-1',
      cwd: root,
    });
    const secondRun = agentRunHeader({
      runId: 'run-2',
      invocationId: 'invocation-2',
      turnId: 'turn-2',
      cwd: root,
      createdAt: 3,
      updatedAt: 5,
      completedAt: 5,
    });
    const childRun = agentRunHeader({
      runId: 'run-child',
      invocationId: 'invocation-child',
      turnId: 'turn-child',
      parentRunId: 'run-1',
      cwd: root,
      createdAt: 2.1,
      updatedAt: 2.9,
      completedAt: 2.9,
    });
    await runStore.createRun(firstRun);
    await runStore.createRun(childRun);
    await runStore.createRun(secondRun);
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
    for (const event of [...firstEvents, ...childEvents, ...secondEvents]) {
      await runtimeEventStore.appendRuntimeEvent(event.sessionId, event.runId, event);
    }
    const sourceEvents = [...firstEvents, ...secondEvents];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-source',
      coveredRuntimeEvents: sourceEvents.filter(isHistoryCompactContentEvent),
      summary: 'Both retained turns are complete.',
      summaryFormat: 'legacy_freeform',
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
      runStore,
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

    const targetRuns = await runStore.listSessionRuns('session-target');
    const targetEvents = (
      await Promise.all(
        targetRuns.map((run) => runtimeEventStore.readRuntimeEvents('session-target', run.runId)),
      )
    ).flat();
    const targetInlineRunIds = new Set(
      targetRuns.filter(isSessionInlineRun).map((run) => run.runId),
    );
    assert.ok(targetRuns.some((run) => !isSessionInlineRun(run)));
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

test('conversation copy rebuilds a resumed child checkpoint over its child run chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-conversation-child-checkpoint-copy-'));
  try {
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const rootRun = agentRunHeader({
      runId: 'run-root',
      invocationId: 'invocation-root',
      turnId: 'turn-root',
      cwd: root,
    });
    const firstChild = agentRunHeader({
      runId: 'run-child-1',
      invocationId: 'invocation-child-1',
      turnId: 'turn-child-1',
      parentRunId: 'run-root',
      agentId: 'researcher',
      agentName: 'Researcher',
      cwd: root,
      createdAt: 3,
      updatedAt: 5,
      completedAt: 5,
    });
    const resumedChild = agentRunHeader({
      runId: 'run-child-2',
      invocationId: 'invocation-child-2',
      turnId: 'turn-child-2',
      parentRunId: 'run-root',
      resumedFromRunId: 'run-child-1',
      agentId: 'researcher',
      agentName: 'Researcher',
      cwd: root,
      createdAt: 6,
      updatedAt: 8,
      completedAt: 8,
    });
    for (const run of [rootRun, firstChild, resumedChild]) await runStore.createRun(run);

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
      summary: 'The resumed child retained both child turns.',
      summaryFormat: 'legacy_freeform',
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
      runStore,
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
    const targetResumedChild = await runStore.readRun('session-target', runIds.get('run-child-2')!);
    assert.equal(targetResumedChild.resumedFromRunId, runIds.get('run-child-1'));
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

function prepareTestCopyPlan(
  source: RuntimeReadModelSessionView,
  copiedMessages: readonly StoredMessage[],
  runStore: Pick<AgentRunStore, 'listSessionRuns' | 'readEvents'>,
  runtimeEventStore: Pick<RuntimeEventStore, 'readRuntimeEvents'>,
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

function agentRunHeader(overrides: Partial<AgentRunHeader>): AgentRunHeader {
  return {
    runId: 'run',
    invocationId: 'invocation',
    sessionId: 'session-source',
    turnId: 'turn',
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'model',
    cwd: '/tmp',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
    ...overrides,
  };
}
