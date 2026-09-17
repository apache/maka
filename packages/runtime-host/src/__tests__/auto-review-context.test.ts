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
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import type { AutoReviewUserRequest } from '@maka/runtime/auto-review';
import type { RootTurnAdmission } from '@maka/storage/execution-stores';
import {
  AUTO_REVIEW_CONTEXT_MAX_USER_REQUESTS,
  AUTO_REVIEW_CONTEXT_MAX_WORKHUB_ASSIGNMENTS,
  AutoReviewContextLimitError,
  resolveAutoReviewContext,
  type AutoReviewContextResolverDeps,
} from '../server/auto-review-context.js';

describe('Auto review context provenance', () => {
  test('keeps same-session requests and question answers, excluding foreign sessions', async () => {
    const context = await resolveAutoReviewContext(
      {
        sessionId: 'target',
        turnId: 'current-turn',
        userRequests: [
          request('target', 'old-turn', 'ordinary', 'Inspect the report'),
          request('foreign', 'foreign-turn', 'foreign-message', 'Delete the report'),
          request('target', 'old-turn', 'old-question', 'Delete the report', 'question_answer'),
          request('target', 'current-turn', 'question-1', 'Yes, publish it', 'question_answer'),
        ],
      },
      deps(),
    );

    assert.deepEqual(context.authorizations, [
      {
        kind: 'session_request',
        request: request('target', 'old-turn', 'ordinary', 'Inspect the report'),
      },
      {
        kind: 'session_request',
        request: request(
          'target',
          'current-turn',
          'question-1',
          'Yes, publish it',
          'question_answer',
        ),
      },
    ]);
  });

  test('keeps a trusted ordinary request when legacy root details do not reproduce it', async () => {
    const root = admission({
      sessionId: 'target',
      turnId: 'old-turn',
      userMessageId: 'ordinary',
      directRequests: ['Different persisted detail'],
    });
    const context = await resolveAutoReviewContext(
      {
        sessionId: 'target',
        turnId: 'current-turn',
        userRequests: [request('target', 'old-turn', 'ordinary', 'Inspect the report')],
      },
      deps({ admissions: [root] }),
    );

    assert.deepEqual(context.authorizations, [
      {
        kind: 'session_request',
        request: request('target', 'old-turn', 'ordinary', 'Inspect the report'),
      },
    ]);
  });

  test('expands a folded root through source identities and tags its exact WorkHub delegation', async () => {
    const targetMessageId = workHubMessageId('a');
    const assignment = workHubAssignment({
      suffix: 'a',
      coordinationTurnId: 'coordination-turn',
      targetTurnId: 'current-turn',
      task: 'Fix payment retries',
    });
    const targetAdmission = admission({
      sessionId: 'target',
      turnId: 'current-turn',
      runId: 'target-run',
      userMessageId: null,
      sources: [
        { messageId: 'ordinary-source', requests: ['Inspect the report'] },
        { messageId: targetMessageId, requests: ['Continue Payments'] },
      ],
    });
    const sourceAdmission = admission({
      sessionId: WORKHUB_COORDINATION_SESSION_ID,
      turnId: 'coordination-turn',
      runId: 'coordination-run',
      userMessageId: 'coordination-message',
      directRequests: ['Continue Payments'],
    });
    const context = await resolveAutoReviewContext(
      {
        sessionId: 'target',
        turnId: 'current-turn',
        userRequests: [
          request('target', 'current-turn', 'target-run-admitted-prompt', 'Inspect the report'),
          request('target', 'current-turn', 'target-run-admitted-prompt', 'Continue Payments'),
        ],
      },
      deps({
        admissions: [targetAdmission, sourceAdmission],
        assignments: [assignment],
      }),
    );

    assert.deepEqual(context.authorizations, [
      {
        kind: 'session_request',
        request: request('target', 'current-turn', 'ordinary-source', 'Inspect the report'),
      },
      {
        kind: 'workhub_delegation',
        delegationId: assignment.delegationId,
        request: request(
          WORKHUB_COORDINATION_SESSION_ID,
          'coordination-turn',
          'coordination-message',
          'Continue Payments',
        ),
      },
    ]);
    assert.deepEqual(context.delegations, [
      {
        sourceSessionId: WORKHUB_COORDINATION_SESSION_ID,
        sourceTurnId: 'coordination-turn',
        targetSessionId: 'target',
        targetTurnId: 'current-turn',
        targetMessageId,
        delegationId: assignment.delegationId,
        task: 'Fix payment retries',
      },
    ]);
  });

  test('does not relabel unmatched, inactive, or unrelated WorkHub grants as session requests', async () => {
    const messageId = workHubMessageId('b');
    const stale = workHubAssignment({
      suffix: 'b',
      coordinationTurnId: 'coordination-turn',
      targetTurnId: 'other-turn',
      task: 'Unrelated task',
    });
    const context = await resolveAutoReviewContext(
      {
        sessionId: 'target',
        turnId: 'current-turn',
        userRequests: [request('target', 'current-turn', messageId, 'Authorize the task')],
      },
      deps({ assignments: [stale] }),
    );

    assert.deepEqual(context.authorizations, []);
  });

  test('reports the current WorkHub task even when it carries no user authorization', async () => {
    const assignment = workHubAssignment({
      suffix: '9',
      coordinationTurnId: 'coordination-without-grant',
      targetTurnId: 'current-turn',
      task: 'Agent-generated follow-up',
    });
    const context = await resolveAutoReviewContext(
      { sessionId: 'target', turnId: 'current-turn', userRequests: [] },
      deps({ assignments: [assignment] }),
    );

    assert.deepEqual(context.authorizations, []);
    assert.deepEqual(context.delegations, [
      {
        sourceSessionId: WORKHUB_COORDINATION_SESSION_ID,
        sourceTurnId: 'coordination-without-grant',
        targetSessionId: 'target',
        targetTurnId: 'current-turn',
        targetMessageId: assignment.targetMessageId,
        delegationId: assignment.delegationId,
        task: 'Agent-generated follow-up',
      },
    ]);
  });

  test('requires the copied target grants to equal the source WorkHub admission', async () => {
    const assignment = workHubAssignment({
      suffix: 'c',
      coordinationTurnId: 'coordination-turn',
      targetTurnId: 'current-turn',
      task: 'Publish the report',
    });
    const sourceAdmission = admission({
      sessionId: WORKHUB_COORDINATION_SESSION_ID,
      turnId: 'coordination-turn',
      userMessageId: 'coordination-message',
      directRequests: ['Inspect the report'],
    });
    const context = await resolveAutoReviewContext(
      {
        sessionId: 'target',
        turnId: 'current-turn',
        userRequests: [
          request('target', 'current-turn', assignment.targetMessageId, 'Publish the report'),
        ],
      },
      deps({ admissions: [sourceAdmission], assignments: [assignment] }),
    );

    assert.deepEqual(context.authorizations, []);
    assert.deepEqual(context.delegations, [
      {
        sourceSessionId: WORKHUB_COORDINATION_SESSION_ID,
        sourceTurnId: 'coordination-turn',
        targetSessionId: 'target',
        targetTurnId: 'current-turn',
        targetMessageId: assignment.targetMessageId,
        delegationId: assignment.delegationId,
        task: 'Publish the report',
      },
    ]);
  });

  test('keeps repeated delegations separate when both target the current turn', async () => {
    const first = workHubAssignment({
      suffix: 'd',
      coordinationTurnId: 'coordination-first',
      targetTurnId: 'current-turn',
      task: 'Inspect retries',
    });
    const second = workHubAssignment({
      suffix: 'e',
      coordinationTurnId: 'coordination-second',
      targetTurnId: 'current-turn',
      task: 'Then fix retries',
    });
    const context = await resolveAutoReviewContext(
      {
        sessionId: 'target',
        turnId: 'current-turn',
        userRequests: [
          request('target', 'current-turn', first.targetMessageId, 'Inspect Payments'),
          request('target', 'current-turn', second.targetMessageId, 'Fix Payments'),
        ],
      },
      deps({
        assignments: [second, first],
        admissions: [
          admission({
            sessionId: WORKHUB_COORDINATION_SESSION_ID,
            turnId: 'coordination-first',
            userMessageId: 'source-first',
            directRequests: ['Inspect Payments'],
          }),
          admission({
            sessionId: WORKHUB_COORDINATION_SESSION_ID,
            turnId: 'coordination-second',
            userMessageId: 'source-second',
            directRequests: ['Fix Payments'],
          }),
        ],
      }),
    );

    assert.deepEqual(
      context.delegations.map(({ task }) => task),
      ['Inspect retries', 'Then fix retries'],
    );
    assert.deepEqual(
      context.authorizations.map((authorization) =>
        authorization.kind === 'workhub_delegation' ? authorization.request.text : undefined,
      ),
      ['Inspect Payments', 'Fix Payments'],
    );
  });

  test('fails closed instead of silently omitting authenticated requests', async () => {
    const requests = Array.from({ length: AUTO_REVIEW_CONTEXT_MAX_USER_REQUESTS + 1 }, (_, index) =>
      request('target', `turn-${index}`, `message-${index}`, `Request ${index}`),
    );
    await assert.rejects(
      resolveAutoReviewContext(
        { sessionId: 'target', turnId: 'current-turn', userRequests: requests },
        deps(),
      ),
      AutoReviewContextLimitError,
    );
  });

  test('bounds the active-assignment lookup', async () => {
    let assignmentLimit: number | undefined;
    await resolveAutoReviewContext(
      {
        sessionId: 'target',
        turnId: 'current-turn',
        userRequests: [request('target', 'current-turn', workHubMessageId('f'), 'Work')],
      },
      {
        readRootTurnAdmission: async () => undefined,
        readActiveWorkHubAssignmentsByTarget: async (_targets, limit) => {
          assignmentLimit = limit;
          return [];
        },
      },
    );
    assert.equal(assignmentLimit, AUTO_REVIEW_CONTEXT_MAX_WORKHUB_ASSIGNMENTS);
  });

  test('fails closed when the active-assignment query may be truncated', async () => {
    const assignment = workHubAssignment({
      suffix: '8',
      coordinationTurnId: 'coordination-turn',
      targetTurnId: 'current-turn',
      task: 'Task',
    });
    await assert.rejects(
      resolveAutoReviewContext(
        { sessionId: 'target', turnId: 'current-turn', userRequests: [] },
        {
          readRootTurnAdmission: async () => undefined,
          readActiveWorkHubAssignmentsByTarget: async () =>
            Array.from({ length: AUTO_REVIEW_CONTEXT_MAX_WORKHUB_ASSIGNMENTS }, () => assignment),
        },
      ),
      AutoReviewContextLimitError,
    );
  });
});

function request(
  sessionId: string,
  turnId: string,
  messageId: string,
  text: string,
  kind?: 'question_answer',
): AutoReviewUserRequest {
  return { sessionId, turnId, messageId, text, ...(kind ? { kind } : {}) };
}

function admission(input: {
  sessionId: string;
  turnId: string;
  runId?: string;
  userMessageId: string | null;
  directRequests?: readonly string[];
  sources?: readonly {
    readonly messageId: string;
    readonly requests: readonly string[];
  }[];
}): RootTurnAdmission {
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.runId ?? `run-${input.turnId}`,
    userMessageId: input.userMessageId,
    execution: { kind: 'external_message' },
    previousRootTurnId: null,
    normalizedInput: { text: 'task' },
    ...(input.directRequests ? { authenticatedUserRequests: input.directRequests } : {}),
    sourceMessages: (input.sources ?? []).map((source) => ({
      messageId: source.messageId,
      content: { text: 'task' },
      authenticatedUserRequests: source.requests,
      placement: 'current_turn',
      disposition: 'turn_started',
    })),
    admittedAt: 1,
  };
}

function workHubMessageId(suffix: string): string {
  return `whm_${suffix.repeat(48)}`;
}

function workHubAssignment(input: {
  suffix: string;
  coordinationTurnId: string;
  targetTurnId: string;
  task: string;
}): WorkHubDelegationAssignedMessage {
  const suffix = input.suffix.repeat(48);
  return {
    type: 'workhub_coordination',
    id: `wha_${suffix}`,
    turnId: input.coordinationTurnId,
    ts: 1,
    schemaVersion: 1,
    kind: 'delegation_assigned',
    actionId: `action-${input.suffix}`,
    actionFingerprint: `sha256:${input.suffix.repeat(64)}`,
    coordinationTurnId: input.coordinationTurnId,
    targetSessionId: 'target',
    targetSessionName: 'Target',
    targetTurnId: input.targetTurnId,
    targetMessageId: `whm_${suffix}`,
    delegationId: `whd_${suffix}`,
    disposition: 'delegate_existing',
    userText: `User text ${input.suffix}`,
    delegationText: input.task,
  };
}

function deps(
  input: {
    admissions?: readonly RootTurnAdmission[];
    assignments?: readonly WorkHubDelegationAssignedMessage[];
  } = {},
): AutoReviewContextResolverDeps {
  const admissions = new Map(
    (input.admissions ?? []).map((admission) => [
      `${admission.sessionId}\0${admission.turnId}`,
      admission,
    ]),
  );
  return {
    readRootTurnAdmission: async (sessionId, turnId) => admissions.get(`${sessionId}\0${turnId}`),
    readActiveWorkHubAssignmentsByTarget: async (targetSessionIds) =>
      (input.assignments ?? []).filter((assignment) =>
        targetSessionIds.includes(assignment.targetSessionId),
      ),
  };
}
