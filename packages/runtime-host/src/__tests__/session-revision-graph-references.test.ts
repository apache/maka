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
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';
import { collectConversationCopyLinkedChildReferences } from '@maka/runtime/conversation-copy';
import {
  agentGraphRevisionAdmissionSessionIds,
  prepareAgentGraphRevisionReferences,
} from '../server/session-revision-graph-references.js';

const ROOT_SESSION_ID = 'root-session';
const CHILD_SESSION_ID = 'child-session';
const ROOT_TURN_ID = 'root-turn';
const CHILD_TURN_ID = 'child-turn';
const CHILD_RUN_ID = 'child-run';
const CHILD_ARTIFACT_ID = 'child-artifact';

test('Agent Graph revision references accept absent and reject live control state', async () => {
  const noGraph = await prepare({
    graphState: 'absent',
    messages: [],
    sessionHeaders: [sessionHeader(ROOT_SESSION_ID)],
  });
  assert.equal(noGraph.ok, true);

  const active = await prepare({
    graphState: 'live',
    messages: [],
    sessionHeaders: [sessionHeader(ROOT_SESSION_ID)],
  });
  assert.deepEqual(active, {
    ok: false,
    code: 'session_busy',
    message: 'A retained Agent Graph is not terminal',
  });
});

test('Agent Graph revision references preserve only exact terminal provenance', async () => {
  const accepted = await prepare();
  assert.equal(accepted.ok, true);
  if (!accepted.ok) assert.fail('Expected accepted Graph references');
  assert.deepEqual([...accepted.references.get(CHILD_SESSION_ID)!.runIds], [CHILD_RUN_ID]);
  assert.deepEqual(
    [...accepted.references.get(CHILD_SESSION_ID)!.artifactIds],
    [CHILD_ARTIFACT_ID],
  );

  const archived = await prepare({
    messages: [],
    archivedResults: [JSON.stringify(linkedResult().content)],
  });
  assert.equal(archived.ok, true);
});

test('Agent Graph revision references reject incomplete or mismatched provenance', async () => {
  const cases: ReadonlyArray<{
    name: string;
    input: PrepareOverrides;
    code: 'operation_unavailable' | 'session_busy';
  }> = [
    {
      name: 'missing Run anchor',
      input: { messages: [linkedResult({ runId: undefined })] },
      code: 'operation_unavailable',
    },
    {
      name: 'missing Run record',
      input: { messages: [linkedResult({ runId: 'missing-run' })] },
      code: 'operation_unavailable',
    },
    {
      name: 'missing Graph control state',
      input: { graphState: 'absent' },
      code: 'operation_unavailable',
    },
    {
      name: 'nonterminal result',
      input: { messages: [linkedSubagentResult('waiting_for_user')] },
      code: 'session_busy',
    },
    {
      name: 'wrong Run turn',
      input: { runs: [agentRun({ turnId: 'other-turn' })] },
      code: 'operation_unavailable',
    },
    {
      name: 'wrong Run status',
      input: { runs: [agentRun({ status: 'failed' })] },
      code: 'operation_unavailable',
    },
    {
      name: 'active child Run',
      input: { runs: [agentRun({ status: 'running', completedAt: undefined })] },
      code: 'session_busy',
    },
    {
      name: 'wrong Artifact turn',
      input: { artifactTurnId: 'other-turn' },
      code: 'operation_unavailable',
    },
    {
      name: 'deleted Artifact',
      input: { artifactStatus: 'deleted' },
      code: 'operation_unavailable',
    },
    {
      name: 'missing Artifact',
      input: { artifactMissing: true },
      code: 'operation_unavailable',
    },
    {
      name: 'active child Session',
      input: { childActive: true },
      code: 'session_busy',
    },
  ];
  for (const policyCase of cases) {
    const outcome = await prepare(policyCase.input);
    assert.equal(outcome.ok, false, policyCase.name);
    if (!outcome.ok) assert.equal(outcome.code, policyCase.code, policyCase.name);
  }
});

test('Agent Graph revision references reject invalid ownership boundaries', async () => {
  const genericChild = childHeader({ graph: false });
  const generic = await prepare({ sessionHeaders: [sessionHeader(ROOT_SESSION_ID), genericChild] });
  assert.equal(generic.ok, false);
  if (!generic.ok) assert.equal(generic.code, 'operation_unavailable');

  const otherParent = childHeader({ parentSessionId: 'other-root' });
  const crossFamily = await prepare({
    sessionHeaders: [sessionHeader(ROOT_SESSION_ID), sessionHeader('other-root'), otherParent],
  });
  assert.equal(crossFamily.ok, false);
  if (!crossFamily.ok) assert.equal(crossFamily.code, 'operation_unavailable');

  const wrongGraph = await prepare({
    sessionHeaders: [sessionHeader(ROOT_SESSION_ID), childHeader({ graphId: 'wrong-graph' })],
  });
  assert.equal(wrongGraph.ok, false);
  if (!wrongGraph.ok) assert.equal(wrongGraph.code, 'operation_unavailable');

  const branch = await prepare({ kind: 'branch' });
  assert.equal(branch.ok, false);
  if (!branch.ok) assert.equal(branch.code, 'operation_unavailable');
});

test('Agent Graph revision references verify resumed Run lineage', async () => {
  const resumedFrom = agentRun({ runId: 'source-run', turnId: 'source-turn' });
  const resumed = agentRun({ resumedFromRunId: 'source-run' });
  const accepted = await prepare({
    messages: [linkedResult({ resumedFromRunId: 'source-run' })],
    runs: [resumedFrom, resumed],
  });
  assert.equal(accepted.ok, true);

  const firstResumeAttempt = agentRun({
    runId: 'resume-attempt',
    turnId: 'resume-turn',
    resumedFromRunId: 'source-run',
  });
  const retry = agentRun({ retriedFromRunId: 'resume-attempt' });
  const retriedResume = await prepare({
    messages: [linkedResult({ resumedFromRunId: 'source-run' })],
    runs: [resumedFrom, firstResumeAttempt, retry],
    artifactTurnId: 'resume-turn',
  });
  assert.equal(retriedResume.ok, true);

  const mismatched = await prepare({
    messages: [linkedResult({ resumedFromRunId: 'source-run' })],
    runs: [resumedFrom, agentRun({ resumedFromRunId: undefined })],
  });
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.equal(mismatched.code, 'operation_unavailable');
});

test('Agent Graph revision references accept the canonical timeout projection', async () => {
  const timedOut = await prepare({
    messages: [linkedResult({ status: 'failed', failureClass: 'Timeout' })],
    runs: [agentRun({ status: 'cancelled' })],
  });
  assert.equal(timedOut.ok, true);

  const unrelatedFailure = await prepare({
    messages: [linkedResult({ status: 'failed', failureClass: 'ChildAgentError' })],
    runs: [agentRun({ status: 'cancelled' })],
  });
  assert.equal(unrelatedFailure.ok, false);
});

test('Agent Graph revision admission includes only retained direct and referenced children', () => {
  const laterChild = childHeader({ id: 'later-child', parentTurnId: 'later-turn' });
  const siblingChild = childHeader({ id: 'sibling-child', parentSessionId: 'sibling-session' });
  assert.deepEqual(
    agentGraphRevisionAdmissionSessionIds({
      sourceSessionId: ROOT_SESSION_ID,
      sessionHeaders: [sessionHeader(ROOT_SESSION_ID), childHeader(), laterChild, siblingChild],
      copyTurnIds: [ROOT_TURN_ID],
      requests: collectConversationCopyLinkedChildReferences({
        messages: [linkedResult()],
        runtimeEvents: [],
        archivedResults: [],
      }),
    }),
    [CHILD_SESSION_ID],
  );
});

interface PrepareOverrides {
  readonly kind?: 'branch' | 'revision';
  readonly messages?: readonly StoredMessage[];
  readonly archivedResults?: readonly string[];
  readonly sessionHeaders?: readonly SessionHeader[];
  readonly runs?: readonly AgentRunHeader[];
  readonly graphState?: 'absent' | 'live' | 'terminal';
  readonly artifactTurnId?: string;
  readonly artifactStatus?: 'live' | 'deleted';
  readonly artifactMissing?: boolean;
  readonly childActive?: boolean;
}

async function prepare(overrides: PrepareOverrides = {}) {
  const sourceHeader = sessionHeader(ROOT_SESSION_ID);
  const messages = overrides.messages ?? [linkedResult()];
  return prepareAgentGraphRevisionReferences(
    {
      kind: overrides.kind ?? 'revision',
      sourceSessionId: ROOT_SESSION_ID,
      sourceHeader,
      sessionHeaders: overrides.sessionHeaders ?? [sourceHeader, childHeader()],
      copyTurnIds: [ROOT_TURN_ID],
      requests: collectConversationCopyLinkedChildReferences({
        messages,
        runtimeEvents: [],
        archivedResults: overrides.archivedResults ?? [],
      }),
    },
    {
      agentRunStore: {
        listSessionRuns: async () => overrides.runs ?? [agentRun()],
      },
      artifacts: {
        getInSession: async (sessionId, artifactId) => ({
          revision: `sha256:${'3'.repeat(64)}`,
          record: overrides.artifactMissing
            ? null
            : {
                id: artifactId,
                sessionId,
                turnId: overrides.artifactTurnId ?? CHILD_TURN_ID,
                createdAt: 1,
                name: 'result.txt',
                kind: 'file',
                relativePath: 'result.txt',
                sizeBytes: 1,
                status: overrides.artifactStatus ?? 'live',
              },
        }),
      },
      graph: {
        readSessionState: async () => overrides.graphState ?? 'terminal',
        readGraphState: async (_rootSessionId, graphId) => {
          if (graphId !== agentGraphIdForRootSession(ROOT_SESSION_ID)) {
            throw new Error('Graph is not bound to this root Session');
          }
          return overrides.graphState ?? 'terminal';
        },
      },
      isSessionActive: () => overrides.childActive ?? false,
    },
  );
}

function linkedSubagentResult(
  status: 'completed' | 'failed' | 'cancelled' | 'running' | 'waiting_for_user',
): Extract<StoredMessage, { readonly type: 'tool_result' }> {
  return {
    type: 'tool_result',
    id: 'graph-result',
    turnId: ROOT_TURN_ID,
    ts: 2,
    toolUseId: 'graph-call',
    isError: false,
    content: {
      kind: 'subagent',
      childSessionId: CHILD_SESSION_ID,
      agentName: 'worker',
      turnId: CHILD_TURN_ID,
      runId: CHILD_RUN_ID,
      status,
      permissionMode: 'ask',
      summary: 'result',
      artifactIds: [CHILD_ARTIFACT_ID],
    },
  };
}

function linkedResult(
  overrides: {
    readonly runId?: string;
    readonly resumedFromRunId?: string;
    readonly status?: 'completed' | 'failed' | 'cancelled';
    readonly failureClass?: string;
  } = {},
): Extract<StoredMessage, { readonly type: 'tool_result' }> {
  const runId = Object.hasOwn(overrides, 'runId') ? overrides.runId : CHILD_RUN_ID;
  const status = overrides.status ?? 'completed';
  return {
    type: 'tool_result',
    id: 'graph-result',
    turnId: ROOT_TURN_ID,
    ts: 2,
    toolUseId: 'graph-call',
    isError: false,
    content: {
      kind: 'agent_swarm',
      status: status === 'completed' ? 'completed' : 'partial',
      items: [
        {
          itemId: 'item',
          index: 0,
          profile: 'default',
          started: true,
          childSessionId: CHILD_SESSION_ID,
          turnId: CHILD_TURN_ID,
          ...(runId ? { runId } : {}),
          ...(overrides.resumedFromRunId ? { resumedFromRunId: overrides.resumedFromRunId } : {}),
          status,
          summary: 'done',
          artifactIds: [CHILD_ARTIFACT_ID],
          ...(overrides.failureClass ? { failureClass: overrides.failureClass } : {}),
        },
      ],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    },
  };
}

function sessionHeader(id: string): SessionHeader {
  return {
    id,
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: id,
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    connectionLocked: true,
    model: 'fake-model',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function childHeader(
  overrides: {
    readonly id?: string;
    readonly parentSessionId?: string;
    readonly parentTurnId?: string;
    readonly graph?: boolean;
    readonly graphId?: string;
  } = {},
): SessionHeader {
  const header = sessionHeader(overrides.id ?? CHILD_SESSION_ID);
  const parentSessionId = overrides.parentSessionId ?? ROOT_SESSION_ID;
  return {
    ...header,
    subagentParent: {
      kind: 'subagent',
      parentSessionId,
      spawnedBy: {
        parentRunId: 'root-run',
        parentTurnId: overrides.parentTurnId ?? ROOT_TURN_ID,
        toolCallId: 'graph-call',
      },
      ...(overrides.graph === false
        ? {}
        : {
            graph: {
              graphId: overrides.graphId ?? agentGraphIdForRootSession(parentSessionId),
              workId: 'work',
              operatorId: 'operator',
            },
          }),
      lifecycle: 'foreground',
    },
  };
}

function agentRun(overrides: Partial<AgentRunHeader> = {}): AgentRunHeader {
  return {
    runId: CHILD_RUN_ID,
    invocationId: 'child-invocation',
    sessionId: CHILD_SESSION_ID,
    turnId: CHILD_TURN_ID,
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
    ...overrides,
  };
}
