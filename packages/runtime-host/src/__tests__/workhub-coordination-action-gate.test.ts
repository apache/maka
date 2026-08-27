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
  type WorkHubDelegationCommit,
  type WorkHubDelegationIntent,
  type WorkHubDelegationRecord,
} from '../server/workhub-coordination-action-gate.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const CONTEXT: ConnectionContext = {
  hostEpoch: 'workhub-action-gate-test',
  connectionId: 'workhub-action-gate-client',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

describe('WorkHub Coordination Action Gate', () => {
  test('exposes only bounded ordinary candidates and proposals use opaque refs', async () => {
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

  test('rejects stale and invented candidates before any Session effect', async () => {
    const effects = fakeEffects([session('payments')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    effects.sessions[0] = session('payments', { statusUpdatedAt: 9 });

    await assert.rejects(
      gate.act(
        {
          actionId: 'stale-action',
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
    assert.deepEqual(effects.submissions, []);

    const refreshed = await gate.candidates();
    const retried = await gate.act(
      {
        actionId: 'stale-action',
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
    effects.submissions.length = 0;

    const current = await gate.candidates();
    await assert.rejects(
      gate.act(
        {
          actionId: 'invented-action',
          userText: 'Continue payments',
          candidateSetId: current.candidateSetId,
          proposal: { disposition: 'delegate_existing', candidateRef: 'invented_candidate' },
        },
        CONTEXT,
      ),
      (error) =>
        error instanceof WorkHubActionGateFailure && error.code === 'candidate_unavailable',
    );
    assert.deepEqual(effects.submissions, []);
  });

  test('rejects waiting targets independently of strategy behavior', async () => {
    const effects = fakeEffects([session('waiting', { status: 'waiting_for_user' })]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();

    await assert.rejects(
      gate.act(
        {
          actionId: 'waiting-action',
          userText: 'Do another thing',
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
    assert.deepEqual(effects.submissions, []);
  });

  test('answers and clarifies only through the Coordination transcript effects', async () => {
    const effects = fakeEffects([session('ordinary')]);
    const gate = new WorkHubCoordinationActionGate(effects);

    const answered = await gate.act(
      {
        actionId: 'answer-action',
        userText: 'What is useMemo?',
        proposal: { disposition: 'answer_here' },
      },
      CONTEXT,
    );
    const clarified = await gate.act(
      {
        actionId: 'clarify-action',
        userText: 'Continue that task',
        proposal: { disposition: 'clarify', assistantText: 'Which task do you mean?' },
      },
      CONTEXT,
    );

    assert.equal(answered.disposition, 'answer_here');
    assert.equal(clarified.disposition, 'clarify');
    assert.equal(effects.answers.length, 1);
    assert.equal(effects.clarifications.length, 1);
    assert.deepEqual(effects.submissions, []);
    assert.equal(effects.creations.length, 0);
  });

  test('only create_new creates and retries the exact action idempotently', async () => {
    const effects = fakeEffects([session('ordinary')]);
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
    assert.equal(effects.creations.length, 0);
    const input = {
      actionId: 'create-action',
      userText: 'Create an accessibility audit',
      proposal: { disposition: 'create_new' as const, title: 'Accessibility audit' },
      create: {
        workspace: { kind: 'host_path' as const, path: '/workspace' },
      },
    };

    const first = await gate.act(input, CONTEXT);
    const replay = await gate.act(input, CONTEXT);
    const restartedReplay = await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT);

    assert.deepEqual(replay, first);
    assert.deepEqual(restartedReplay, first);
    assert.equal(effects.creations.length, 1);
    assert.equal(effects.submissions.length, 1);
    assert.match(effects.creations[0]?.sessionId ?? '', /^whs_[a-f0-9]{48}$/u);
    assert.equal(first.disposition, 'create_new');
    if (first.disposition === 'create_new') {
      assert.equal(first.targetSessionId, effects.creations[0]?.sessionId);
    }
    assert.deepEqual(Object.keys(effects.creations[0]!).sort(), [
      'sessionId',
      'title',
      'workspace',
    ]);
    assert.deepEqual(
      await new WorkHubCoordinationActionGate(effects).act(
        {
          ...input,
          proposal: { disposition: 'create_new', title: 'Recomputed title' },
          create: { workspace: { kind: 'project', projectId: 'new-current-project' } },
        },
        CONTEXT,
      ),
      first,
    );
    await assert.rejects(
      gate.act({ ...input, userText: 'Create different work' }, CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.creations.length, 1);
  });

  test('effect rejection grants no root ownership and lets the durable intent retry', async () => {
    const effects = fakeEffects([session('ordinary')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const submit = effects.submit;
    effects.submit = async () => {
      throw new WorkHubActionEffectFailure('unauthorized', 'Target permission denied');
    };
    const input = {
      actionId: 'permission-rejected-action',
      userText: 'Continue ordinary work',
      candidateSetId: snapshot.candidateSetId,
      proposal: {
        disposition: 'delegate_existing' as const,
        candidateRef: snapshot.candidates[0]!.candidateRef,
      },
    };

    await assert.rejects(
      gate.act(input, CONTEXT),
      (error) => error instanceof WorkHubActionEffectFailure && error.code === 'unauthorized',
    );
    effects.submit = submit;
    assert.equal((await gate.act(input, CONTEXT)).disposition, 'delegate_existing');
  });

  test('commits a delegation after recovering an unknown submit outcome', async () => {
    const effects = fakeEffects([session('ordinary')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    effects.submitUnknownAfterAdmission = true;

    const result = await gate.act(
      {
        actionId: 'unknown-submit-action',
        userText: 'Continue ordinary work',
        candidateSetId: snapshot.candidateSetId,
        proposal: {
          disposition: 'delegate_existing',
          candidateRef: snapshot.candidates[0]!.candidateRef,
        },
      },
      CONTEXT,
    );

    assert.equal(result.disposition, 'delegate_existing');
    assert.equal(effects.submissions.length, 1);
    assert.equal(effects.delegations.get('unknown-submit-action')?.kind, 'delegation_committed');
  });

  test('replays an ordinary delegation durably across Action Gate restart', async () => {
    const effects = fakeEffects([session('ordinary')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const input = {
      actionId: 'delegate-action',
      userText: 'Continue ordinary work',
      candidateSetId: snapshot.candidateSetId,
      proposal: {
        disposition: 'delegate_existing' as const,
        candidateRef: snapshot.candidates[0]!.candidateRef,
      },
    };

    const first = await gate.act(input, CONTEXT);
    const replay = await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT);

    assert.deepEqual(replay, first);
    assert.equal(effects.submissions.length, 1);
    assert.equal(effects.submissions[0]?.sessionId, 'ordinary');
    assert.equal(effects.delegations.get(input.actionId)?.kind, 'delegation_committed');

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        { ...input, userText: 'Different work' },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.submissions.length, 1);
  });

  test('resumes a durable intent after restart without re-admitting stale candidates', async () => {
    const effects = fakeEffects([session('ordinary')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const input = {
      actionId: 'interrupted-delegate-action',
      userText: 'Continue ordinary work',
      candidateSetId: snapshot.candidateSetId,
      proposal: {
        disposition: 'delegate_existing' as const,
        candidateRef: snapshot.candidates[0]!.candidateRef,
      },
    };
    effects.commitFailuresRemaining = 1;

    await assert.rejects(
      gate.act(input, CONTEXT),
      (error) =>
        error instanceof WorkHubActionEffectFailure && error.code === 'commit_outcome_unknown',
    );
    assert.equal(effects.delegations.get(input.actionId)?.kind, 'delegation_intent');
    assert.equal(effects.submissions.length, 1);

    effects.sessions[0] = session('ordinary', { statusUpdatedAt: 99 });
    const restarted = new WorkHubCoordinationActionGate(effects);
    const refreshed = await restarted.candidates();
    await assert.rejects(
      restarted.act(
        {
          actionId: input.actionId,
          userText: input.userText,
          proposal: { disposition: 'answer_here' },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    const recovered = await restarted.act(
      {
        ...input,
        candidateSetId: refreshed.candidateSetId,
        proposal: {
          disposition: 'delegate_existing',
          candidateRef: refreshed.candidates[0]!.candidateRef,
        },
      },
      CONTEXT,
    );

    assert.equal(recovered.disposition, 'delegate_existing');
    assert.equal(effects.submissions.length, 1);
    assert.equal(effects.delegations.get(input.actionId)?.kind, 'delegation_committed');
  });

  test('resumes create_new from the durable payload instead of recomputed caller context', async () => {
    const effects = fakeEffects([session('ordinary')]);
    const input = {
      actionId: 'interrupted-create-action',
      userText: 'Create a login audit',
      proposal: { disposition: 'create_new' as const, title: 'Login audit' },
      create: { workspace: { kind: 'project' as const, projectId: 'original-project' } },
    };
    effects.commitFailuresRemaining = 1;

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(input, CONTEXT),
      (error) =>
        error instanceof WorkHubActionEffectFailure && error.code === 'commit_outcome_unknown',
    );
    const recovered = await new WorkHubCoordinationActionGate(effects).act(
      {
        ...input,
        proposal: { disposition: 'create_new', title: 'Recomputed title' },
        create: { workspace: { kind: 'project', projectId: 'new-current-project' } },
      },
      CONTEXT,
    );

    assert.equal(recovered.disposition, 'create_new');
    assert.deepEqual(effects.creations, [
      {
        sessionId: effects.creations[0]!.sessionId,
        workspace: { kind: 'project', projectId: 'original-project' },
        title: 'Login audit',
      },
    ]);
    assert.equal(effects.submissions.length, 1);
  });

  test('definitive create_new submit rejection retires the empty created Session', async () => {
    const effects = fakeEffects([session('ordinary')]);
    effects.submitFailure = new WorkHubActionEffectFailure(
      'operation_conflict',
      'Target submit was definitively rejected',
    );

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          actionId: 'rejected-create-action',
          userText: 'Create a login audit',
          proposal: { disposition: 'create_new', title: 'Login audit' },
          create: { workspace: { kind: 'project', projectId: 'project-1' } },
        },
        CONTEXT,
      ),
      /definitively rejected/u,
    );

    assert.equal(effects.discardedCreatedSessionIds.length, 1);
    assert.match(effects.discardedCreatedSessionIds[0] ?? '', /^whs_[a-f0-9]{48}$/u);
    assert.deepEqual(effects.creations, []);
  });

  test('unknown create_new submit outcome never retires a possibly admitted Session', async () => {
    const effects = fakeEffects([session('ordinary')]);
    effects.submitUnknownAfterAdmission = true;
    effects.recoverSubmissionMiss = true;

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          actionId: 'unknown-create-action',
          userText: 'Create a login audit',
          proposal: { disposition: 'create_new', title: 'Login audit' },
          create: { workspace: { kind: 'project', projectId: 'project-1' } },
        },
        CONTEXT,
      ),
      (error) =>
        error instanceof WorkHubActionEffectFailure && error.code === 'commit_outcome_unknown',
    );

    assert.equal(effects.creations.length, 1);
    assert.deepEqual(effects.discardedCreatedSessionIds, []);
  });

  test('retries definitive create_new cleanup after the first discard outcome is unknown', async () => {
    const effects = fakeEffects([session('ordinary')]);
    const input = {
      actionId: 'retry-create-cleanup-action',
      userText: 'Create a login audit',
      proposal: { disposition: 'create_new' as const, title: 'Login audit' },
      create: { workspace: { kind: 'project' as const, projectId: 'project-1' } },
    };
    effects.submitFailure = new WorkHubActionEffectFailure(
      'operation_conflict',
      'Target submit was definitively rejected',
    );
    effects.discardFailuresRemaining = 1;

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(input, CONTEXT),
      (error) =>
        error instanceof WorkHubActionEffectFailure && error.code === 'commit_outcome_unknown',
    );
    assert.equal(effects.creations.length, 1);

    effects.submitFailure = new WorkHubActionEffectFailure(
      'operation_conflict',
      'Target submit was definitively rejected again',
    );
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(input, CONTEXT),
      /definitively rejected again/u,
    );

    assert.equal(effects.discardAttempts, 2);
    assert.deepEqual(effects.creations, []);
  });
});

function session(
  id: string,
  patch: Partial<WorkHubActionGateSession> = {},
): WorkHubActionGateSession {
  return {
    id,
    cwd: `/workspace/${id}`,
    projectId: null,
    createdAt: 1,
    name: id,
    labels: [],
    isArchived: false,
    status: 'active',
    ...patch,
  };
}

function fakeEffects(initialSessions: WorkHubActionGateSession[]) {
  const submitted = new Map<
    string,
    {
      readonly input: { sessionId: string; messageId: string; text: string };
      readonly turnId: string;
    }
  >();
  const state = {
    sessions: [...initialSessions],
    answers: [] as Array<{ turnId: string; text: string }>,
    clarifications: [] as Array<{
      turnId: string;
      userText: string;
      assistantText: string;
    }>,
    creations: [] as Array<{
      sessionId: string;
      workspace: { kind: 'project'; projectId: string } | { kind: 'host_path'; path: string };
      title: string;
    }>,
    submissions: [] as Array<{ sessionId: string; messageId: string; text: string }>,
    delegations: new Map<string, WorkHubDelegationRecord>(),
    commitFailuresRemaining: 0,
    submitUnknownAfterAdmission: false as boolean,
    submitFailure: undefined as WorkHubActionEffectFailure | undefined,
    recoverSubmissionMiss: false as boolean,
    discardAttempts: 0,
    discardFailuresRemaining: 0,
    discardedCreatedSessionIds: [] as string[],
    async listSessions() {
      return this.sessions;
    },
    async answer(input: { turnId: string; text: string }) {
      this.answers.push(input);
    },
    async clarify(input: { turnId: string; userText: string; assistantText: string }) {
      this.clarifications.push(input);
    },
    async create(input: {
      sessionId: string;
      workspace: { kind: 'project'; projectId: string } | { kind: 'host_path'; path: string };
      title: string;
    }) {
      const existing = this.creations.find(({ sessionId }) => sessionId === input.sessionId);
      if (existing) assert.deepEqual(existing, input);
      else this.creations.push(input);
      return { discardRevision: 1 };
    },
    async submit(input: { sessionId: string; messageId: string; text: string }) {
      if (this.submitFailure) {
        const error = this.submitFailure;
        this.submitFailure = undefined;
        throw error;
      }
      const existing = submitted.get(input.messageId);
      if (existing) {
        assert.deepEqual(existing.input, input);
        return { turnId: existing.turnId };
      }
      this.submissions.push(input);
      const turnId = `turn-${input.sessionId}`;
      submitted.set(input.messageId, { input, turnId });
      if (this.submitUnknownAfterAdmission) {
        this.submitUnknownAfterAdmission = false;
        throw new WorkHubActionEffectFailure(
          'commit_outcome_unknown',
          'Target submit outcome is unknown',
        );
      }
      return { turnId };
    },
    async discardCreated(input: { sessionId: string; expectedRevision: number }) {
      assert.equal(input.expectedRevision, 1);
      this.discardAttempts += 1;
      if (this.discardFailuresRemaining > 0) {
        this.discardFailuresRemaining -= 1;
        throw new WorkHubActionEffectFailure(
          'commit_outcome_unknown',
          'Created Session retirement outcome is unknown',
        );
      }
      this.discardedCreatedSessionIds.push(input.sessionId);
      const index = this.creations.findIndex(({ sessionId }) => sessionId === input.sessionId);
      if (index >= 0) this.creations.splice(index, 1);
    },
    async recoverSubmission(input: { sessionId: string; messageId: string; text: string }) {
      if (this.recoverSubmissionMiss) return undefined;
      const existing = submitted.get(input.messageId);
      if (!existing) return undefined;
      assert.deepEqual(existing.input, input);
      return { turnId: existing.turnId };
    },
    async readDelegation(actionId: string) {
      return this.delegations.get(actionId);
    },
    async prepareDelegation(intent: WorkHubDelegationIntent) {
      const existing = this.delegations.get(intent.actionId);
      if (existing) {
        assert.deepEqual(existing, intent);
        return;
      }
      this.delegations.set(intent.actionId, intent);
    },
    async commitDelegation(commit: WorkHubDelegationCommit) {
      const existing = this.delegations.get(commit.actionId);
      assert.equal(existing?.kind, 'delegation_intent');
      if (this.commitFailuresRemaining > 0) {
        this.commitFailuresRemaining -= 1;
        throw new WorkHubActionEffectFailure(
          'commit_outcome_unknown',
          'Delegation commit outcome is unknown',
        );
      }
      this.delegations.set(commit.actionId, commit);
    },
  } satisfies WorkHubActionGateEffects & {
    sessions: WorkHubActionGateSession[];
    answers: Array<{ turnId: string; text: string }>;
    clarifications: Array<{ turnId: string; userText: string; assistantText: string }>;
    creations: Array<{
      sessionId: string;
      workspace: { kind: 'project'; projectId: string } | { kind: 'host_path'; path: string };
      title: string;
    }>;
    submissions: Array<{ sessionId: string; messageId: string; text: string }>;
    delegations: Map<string, WorkHubDelegationRecord>;
    commitFailuresRemaining: number;
    submitUnknownAfterAdmission: boolean;
    submitFailure: WorkHubActionEffectFailure | undefined;
    recoverSubmissionMiss: boolean;
    discardAttempts: number;
    discardFailuresRemaining: number;
    discardedCreatedSessionIds: string[];
  };
  return state;
}
