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
  WorkHubActionEffectFailure,
  WorkHubActionGateFailure,
  WorkHubCoordinationActionGate,
  type WorkHubActionGateEffects,
  type WorkHubActionGateSession,
  type WorkHubDelegationAssignmentInput,
} from '../server/workhub-coordination-action-gate.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const CONTEXT: ConnectionContext = {
  hostEpoch: 'workhub-action-gate-test',
  connectionId: 'workhub-action-gate-client',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

describe('WorkHub Coordination Action Gate', () => {
  test('exposes only bounded ordinary candidates and opaque refs', async () => {
    const effects = fakeEffects([
      session('ordinary'),
      session('archived', { isArchived: true }),
      session('waiting', { status: 'waiting_for_user' }),
      session('side', { labels: ['mode:side_conversation'] }),
      session('child', {
        subagentParent: {
          kind: 'subagent',
          parentSessionId: 'ordinary',
          spawnedBy: { parentTurnId: 'turn', parentRunId: 'run', toolCallId: 'tool' },
          lifecycle: 'foreground',
        },
      }),
      session('maka_workhub_coordination', { role: 'workhub_coordination' }),
    ]);
    const result = await new WorkHubCoordinationActionGate(effects).candidates();
    assert.deepEqual(
      result.candidates.map(({ sessionId }) => sessionId),
      ['ordinary', 'waiting'],
    );
    assert.match(result.candidateSetId, /^sha256:[a-f0-9]{64}$/u);
    assert.notEqual(result.candidates[0]?.candidateRef, 'ordinary');

    const bounded = await new WorkHubCoordinationActionGate(
      fakeEffects(Array.from({ length: 40 }, (_, index) => session(`ordinary-${index}`))),
    ).candidates();
    assert.equal(bounded.candidates.length, 32);
  });

  test('rejects stale candidates before assignment', async () => {
    const effects = fakeEffects([session('payments')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    effects.sessions[0] = session('payments', { lastMessageAt: 9 });
    await assert.rejects(
      gate.act(
        {
          actionId: 'stale',
          userText: 'Continue payments',
          candidateSetId: snapshot.candidateSetId,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: snapshot.candidates[0]!.candidateRef,
          },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'candidate_set_stale',
    );
    assert.equal(effects.assignments.length, 0);

    const refreshed = await gate.candidates();
    const retried = await gate.act(
      {
        actionId: 'stale',
        userText: 'Continue payments',
        candidateSetId: refreshed.candidateSetId,
        proposal: {
          disposition: 'delegate_existing',
          candidateRef: refreshed.candidates[0]!.candidateRef,
        },
      },
      CONTEXT,
    );
    assert.equal(retried.disposition, 'delegate_existing');

    const current = await gate.candidates();
    await assert.rejects(
      gate.act(
        {
          actionId: 'invented',
          userText: 'Continue payments',
          candidateSetId: current.candidateSetId,
          proposal: { disposition: 'delegate_existing', candidateRef: 'invented_candidate' },
        },
        CONTEXT,
      ),
      (error) =>
        error instanceof WorkHubActionGateFailure && error.code === 'candidate_unavailable',
    );
    assert.equal(effects.assignments.length, 1);
  });

  test('rejects waiting targets independently of strategy behavior', async () => {
    const effects = fakeEffects([session('waiting', { status: 'waiting_for_user' })]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    await assert.rejects(
      gate.act(
        {
          actionId: 'waiting',
          userText: 'Continue',
          candidateSetId: snapshot.candidateSetId,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: snapshot.candidates[0]!.candidateRef,
          },
        },
        CONTEXT,
      ),
      (error) =>
        error instanceof WorkHubActionGateFailure && error.code === 'target_waiting_for_user',
    );
  });

  test('answers and clarifies only through Coordination effects', async () => {
    const effects = fakeEffects([session('ordinary')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    await gate.act(
      { actionId: 'answer', userText: 'Summarize', proposal: { disposition: 'answer_here' } },
      CONTEXT,
    );
    await gate.act(
      {
        actionId: 'clarify',
        userText: 'Which one?',
        proposal: { disposition: 'clarify', assistantText: 'Choose a Session' },
      },
      CONTEXT,
    );
    assert.equal(effects.answers.length, 1);
    assert.equal(effects.clarifications.length, 1);
    assert.equal(effects.assignments.length, 0);
  });

  test('delegates through one assignment effect', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const result = await gate.act(
      {
        actionId: 'delegate',
        userText: 'Continue payments',
        candidateSetId: snapshot.candidateSetId,
        proposal: {
          disposition: 'delegate_existing',
          candidateRef: snapshot.candidates[0]!.candidateRef,
        },
      },
      CONTEXT,
    );
    assert.deepEqual(result, {
      disposition: 'delegate_existing',
      targetSessionId: 'payments',
      targetTurnId: 'turn-delegate',
    });
    assert.equal(effects.assignments[0]!.targetSessionName, 'Payments');
    assert.equal(effects.assignments[0]!.userText, 'Continue payments');
  });

  test('create_new carries creation context into the same assignment', async () => {
    const effects = fakeEffects([]);
    const gate = new WorkHubCoordinationActionGate(effects);
    await assert.rejects(
      gate.act(
        {
          actionId: 'missing-create-context',
          userText: 'Create an accessibility audit',
          proposal: { disposition: 'create_new', title: 'Accessibility audit' },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    const input = {
      actionId: 'create',
      userText: 'Create an accessibility audit',
      proposal: { disposition: 'create_new' as const, title: 'Accessibility audit' },
      create: { workspace: { kind: 'host_path' as const, path: '/workspace' } },
    };
    const first = await gate.act(input, CONTEXT);
    const replay = await gate.act(input, CONTEXT);
    assert.deepEqual(replay, first);
    assert.equal(effects.assignments.length, 1);
    const restartedReplay = await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT);
    assert.deepEqual(restartedReplay, first);
    assert.equal(effects.assignments.length, 2);
    assert.deepEqual(effects.assignments[0], effects.assignments[1]);
    assert.match(effects.assignments[0]!.targetSessionId, /^whs_[a-f0-9]{48}$/u);
    assert.deepEqual(effects.assignments[0]!.create, {
      title: 'Accessibility audit',
      workspace: input.create.workspace,
    });
    await assert.rejects(
      gate.act({ ...input, proposal: { disposition: 'create_new', title: 'Different' } }, CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.assignments.length, 2);
  });

  test('one in-memory action identity cannot change payload', async () => {
    const effects = fakeEffects([session('payments'), session('login', { lastMessageAt: 1 })]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const input = {
      actionId: 'same-action',
      userText: 'Continue payments',
      candidateSetId: snapshot.candidateSetId,
      proposal: {
        disposition: 'delegate_existing' as const,
        candidateRef: snapshot.candidates[0]!.candidateRef,
      },
    };
    await gate.act(input, CONTEXT);
    await assert.rejects(
      gate.act({ ...input, userText: 'Different work' }, CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    await assert.rejects(
      gate.act(
        {
          ...input,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: snapshot.candidates[1]!.candidateRef,
          },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
  });

  test('an assignment rejection releases the action identity for retry', async () => {
    const effects = fakeEffects([session('payments')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const input = {
      actionId: 'permission-rejected',
      userText: 'Continue payments',
      candidateSetId: snapshot.candidateSetId,
      proposal: {
        disposition: 'delegate_existing' as const,
        candidateRef: snapshot.candidates[0]!.candidateRef,
      },
    };
    const assign = effects.assign;
    effects.assign = async () => {
      throw new WorkHubActionEffectFailure('unauthorized', 'Target permission denied');
    };
    await assert.rejects(
      gate.act(input, CONTEXT),
      (error) => error instanceof WorkHubActionEffectFailure && error.code === 'unauthorized',
    );
    effects.assign = assign;
    assert.equal((await gate.act(input, CONTEXT)).disposition, 'delegate_existing');
  });

  test('replays an ordinary delegation without assigning twice', async () => {
    const effects = fakeEffects([session('payments')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const input = {
      actionId: 'delegate-replay',
      userText: 'Continue payments',
      candidateSetId: snapshot.candidateSetId,
      proposal: {
        disposition: 'delegate_existing' as const,
        candidateRef: snapshot.candidates[0]!.candidateRef,
      },
    };

    const first = await gate.act(input, CONTEXT);
    const replay = await gate.act(input, CONTEXT);

    assert.deepEqual(replay, first);
    assert.equal(effects.assignments.length, 1);
  });
});

function session(
  id: string,
  patch: Partial<WorkHubActionGateSession> = {},
): WorkHubActionGateSession {
  return {
    id,
    cwd: '/workspace',
    projectId: null,
    createdAt: 1,
    lastMessageAt: 2,
    name: id,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 2,
    ...patch,
  };
}

function fakeEffects(initialSessions: WorkHubActionGateSession[]) {
  const durable = new Map<
    string,
    { input: WorkHubDelegationAssignmentInput; result: { turnId: string } }
  >();
  return {
    sessions: [...initialSessions],
    answers: [] as Array<{ turnId: string; text: string }>,
    clarifications: [] as Array<{
      turnId: string;
      userText: string;
      assistantText: string;
    }>,
    assignments: [] as WorkHubDelegationAssignmentInput[],
    async listSessions() {
      return this.sessions;
    },
    async readAssignment() {
      return undefined;
    },
    async answer(input: { turnId: string; text: string }) {
      this.answers.push(input);
    },
    async clarify(input: { turnId: string; userText: string; assistantText: string }) {
      this.clarifications.push(input);
    },
    async assign(input: WorkHubDelegationAssignmentInput) {
      this.assignments.push(input);
      const existing = durable.get(input.actionId);
      if (existing) {
        assert.deepEqual(existing.input, input);
        return existing.result;
      }
      const result = { turnId: `turn-${input.actionId}` };
      durable.set(input.actionId, { input, result });
      return result;
    },
  } satisfies WorkHubActionGateEffects & {
    sessions: WorkHubActionGateSession[];
    answers: Array<{ turnId: string; text: string }>;
    clarifications: Array<{ turnId: string; userText: string; assistantText: string }>;
    assignments: WorkHubDelegationAssignmentInput[];
  };
}
