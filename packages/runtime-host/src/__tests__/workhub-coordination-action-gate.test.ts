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
import type {
  WorkHubDelegationAssignedMessage,
  WorkHubDelegationReplacementAbortedMessage,
  WorkHubDelegationReplacementRequestedMessage,
  WorkHubDelegationSupersededMessage,
} from '@maka/core/session';
import {
  WorkHubActionEffectFailure,
  WorkHubActionGateFailure,
  WorkHubCoordinationActionGate,
  type WorkHubActionGateEffects,
  type WorkHubActionGateSession,
  type WorkHubDelegationAssignmentInput,
  type WorkHubDelegationReplacementAbortInput,
  type WorkHubDelegationReplacementInput,
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

  test('replacement creation rejects negated user intent at the host gate', async () => {
    const effects = fakeEffects([session('source')]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'a'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Original work',
        },
        'source-turn',
      ),
    );

    const negatedCreationCases = [
      '不是这个，而是不要真的创建一个新的 Session',
      '不是这个，而是不要在没有我确认的情况下创建一个新的 Session',
      'Wrong session; do not under any circumstances whatsoever ever create a new session',
      'Wrong session; create a note and do not ever create a new session',
    ];
    for (const [index, userText] of negatedCreationCases.entries()) {
      await assert.rejects(
        new WorkHubCoordinationActionGate(effects).act(
          {
            actionId: `negated-replacement-create-${index}`,
            userText,
            confirmation: { kind: 'user_correction' },
            proposal: {
              disposition: 'replace',
              replacesActionId: 'source-action',
              target: { disposition: 'create_new', title: 'New Session' },
            },
            create: { workspace: { kind: 'host_path', path: '/workspace' } },
          },
          CONTEXT,
        ),
        (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
      );
    }
    assert.equal(effects.replacements.size, 0);
    assert.equal(effects.retirements.length, 0);
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

  test('rejects a changed candidate when replaying an action after restart', async () => {
    const effects = fakeEffects([session('payments'), session('login')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const payments = snapshot.candidates.find((candidate) => candidate.sessionId === 'payments')!;
    const login = snapshot.candidates.find((candidate) => candidate.sessionId === 'login')!;
    const input = {
      actionId: 'delegate-restart-conflict',
      userText: 'Continue the work',
      candidateSetId: snapshot.candidateSetId,
      proposal: {
        disposition: 'delegate_existing' as const,
        candidateRef: payments.candidateRef,
      },
    };

    await gate.act(input, CONTEXT);

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          ...input,
          proposal: { ...input.proposal, candidateRef: login.candidateRef },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.assignments.length, 1);
  });

  test('replaces only an explicitly confirmed durable delegation', async () => {
    const effects = fakeEffects([session('source'), session('destination')]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'a'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Wrong target',
        },
        'source-turn',
      ),
    );
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const destination = snapshot.candidates.find(
      (candidate) => candidate.sessionId === 'destination',
    )!;
    const input = {
      actionId: 'replacement-action',
      userText: 'No, send this to destination',
      candidateSetId: snapshot.candidateSetId,
      proposal: {
        disposition: 'replace' as const,
        replacesActionId: 'source-action',
        target: {
          disposition: 'delegate_existing' as const,
          candidateRef: destination.candidateRef,
        },
      },
    };

    await assert.rejects(
      gate.act(input, CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    await assert.rejects(
      gate.act(
        {
          ...input,
          userText: 'Send this to destination',
          confirmation: { kind: 'user_correction' as const },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    await assert.rejects(
      gate.act(
        {
          ...input,
          userText: 'No, keep going with the current work',
          confirmation: { kind: 'user_correction' as const },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    const result = await gate.act(
      { ...input, confirmation: { kind: 'user_correction' as const } },
      CONTEXT,
    );

    assert.deepEqual(result, {
      disposition: 'replace',
      replacementDisposition: 'delegate_existing',
      targetSessionId: 'destination',
      targetTurnId: 'turn-replacement-action',
    });
    assert.equal(effects.replacements.size, 1);
    assert.equal(effects.retirements[0]?.actionId, 'source-action');
    assert.equal(effects.assignments[0]?.replacesActionId, 'source-action');
    assert.equal(
      effects.supersessions.get('delegation-source-action')?.actionId,
      'replacement-action',
    );
  });

  test('recovers a prepared replacement after retirement and before assignment', async () => {
    const effects = fakeEffects([session('source'), session('destination'), session('other')]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'b'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Wrong target',
        },
        'source-turn',
      ),
    );
    const snapshot = await new WorkHubCoordinationActionGate(effects).candidates();
    const input = {
      actionId: 'recover-replacement',
      userText: 'No, move this to destination',
      candidateSetId: snapshot.candidateSetId,
      confirmation: { kind: 'user_correction' as const },
      proposal: {
        disposition: 'replace' as const,
        replacesActionId: 'source-action',
        target: {
          disposition: 'delegate_existing' as const,
          candidateRef: snapshot.candidates.find(
            (candidate) => candidate.sessionId === 'destination',
          )!.candidateRef,
        },
      },
    };
    const assign = effects.assign;
    effects.assign = async () => {
      throw new WorkHubActionEffectFailure('internal_failure', 'simulated crash seam');
    };

    await assert.rejects(new WorkHubCoordinationActionGate(effects).act(input, CONTEXT));
    assert.equal(effects.replacements.has('delegation-source-action'), true);
    assert.equal(effects.retirements.length, 1);
    assert.equal(effects.assignmentRecords.has(input.actionId), false);

    effects.sessions = effects.sessions.map((candidate) =>
      candidate.id === 'destination' ? { ...candidate, name: 'Renamed destination' } : candidate,
    );
    const refreshed = await new WorkHubCoordinationActionGate(effects).candidates();
    const refreshedDestination = refreshed.candidates.find(
      (candidate) => candidate.sessionId === 'destination',
    )!;
    effects.assign = assign;
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          ...input,
          candidateSetId: refreshed.candidateSetId,
          proposal: {
            ...input.proposal,
            target: {
              ...input.proposal.target,
              candidateRef: refreshed.candidates.find(
                (candidate) => candidate.sessionId === 'other',
              )!.candidateRef,
            },
          },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.retirements.length, 1);
    const recovered = await new WorkHubCoordinationActionGate(effects).act(
      {
        ...input,
        candidateSetId: refreshed.candidateSetId,
        proposal: {
          ...input.proposal,
          target: {
            ...input.proposal.target,
            candidateRef: refreshedDestination.candidateRef,
          },
        },
      },
      CONTEXT,
    );
    assert.equal(recovered.disposition, 'replace');
    assert.equal(effects.retirements.length, 1);
    assert.equal(effects.assignmentRecords.has(input.actionId), true);
    assert.equal(effects.supersessions.has('delegation-source-action'), true);
  });

  test('refreshes replacement target display identity after retiring the source', async () => {
    const effects = fakeEffects([
      session('source'),
      session('destination', { name: 'Destination' }),
    ]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'d'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Wrong target',
        },
        'source-turn',
      ),
    );
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    const destination = snapshot.candidates.find(
      (candidate) => candidate.sessionId === 'destination',
    )!;
    const retireDelegation = effects.retireDelegation;
    effects.retireDelegation = async (assignment) => {
      await retireDelegation.call(effects, assignment);
      effects.sessions = effects.sessions.map((candidate) =>
        candidate.id === 'destination' ? { ...candidate, name: 'Renamed destination' } : candidate,
      );
    };
    const assign = effects.assign;
    effects.assign = async (input) => {
      const current = effects.sessions.find((candidate) => candidate.id === input.targetSessionId);
      if (current?.name !== input.targetSessionName) {
        throw new WorkHubActionEffectFailure(
          'internal_failure',
          'Target Session changed before replacement assignment',
        );
      }
      return assign.call(effects, input);
    };

    const result = await gate.act(
      {
        actionId: 'rename-race',
        userText: 'No, move this to destination',
        candidateSetId: snapshot.candidateSetId,
        confirmation: { kind: 'user_correction' },
        proposal: {
          disposition: 'replace',
          replacesActionId: 'source-action',
          target: {
            disposition: 'delegate_existing',
            candidateRef: destination.candidateRef,
          },
        },
      },
      CONTEXT,
    );
    assert.equal(result.disposition, 'replace');
    assert.equal(effects.retirements.length, 1);
    assert.equal(effects.assignments[0]?.targetSessionName, 'Renamed destination');
  });

  for (const lifecycle of ['archived', 'waiting'] as const) {
    test(`records a terminal abort when the replacement target becomes ${lifecycle} after retirement`, async () => {
      const effects = fakeEffects([session('source'), session('destination')]);
      effects.assignmentRecords.set(
        'source-action',
        assignmentRecord(
          {
            actionId: 'source-action',
            actionFingerprint: `sha256:${'e'.repeat(64)}`,
            targetSessionId: 'source',
            targetSessionName: 'source',
            disposition: 'delegate_existing',
            userText: 'Wrong target',
          },
          'source-turn',
        ),
      );
      const gate = new WorkHubCoordinationActionGate(effects);
      const snapshot = await gate.candidates();
      const destination = snapshot.candidates.find(
        (candidate) => candidate.sessionId === 'destination',
      )!;
      const retireDelegation = effects.retireDelegation;
      effects.retireDelegation = async (assignment) => {
        await retireDelegation.call(effects, assignment);
        effects.sessions = effects.sessions.map((candidate) =>
          candidate.id !== 'destination'
            ? candidate
            : lifecycle === 'archived'
              ? { ...candidate, isArchived: true }
              : { ...candidate, status: 'waiting_for_user' },
        );
      };
      const input = {
        actionId: `target-became-${lifecycle}`,
        userText: 'No, move this to destination',
        candidateSetId: snapshot.candidateSetId,
        confirmation: { kind: 'user_correction' as const },
        proposal: {
          disposition: 'replace' as const,
          replacesActionId: 'source-action',
          target: {
            disposition: 'delegate_existing' as const,
            candidateRef: destination.candidateRef,
          },
        },
      };

      await assert.rejects(
        gate.act(input, CONTEXT),
        (error) =>
          error instanceof WorkHubActionGateFailure &&
          error.code ===
            (lifecycle === 'archived' ? 'candidate_unavailable' : 'target_waiting_for_user'),
      );
      assert.equal(effects.retirements.length, 1);
      assert.equal(effects.assignments.length, 0);
      assert.equal(
        effects.replacementAborts.get('delegation-source-action')?.reason,
        lifecycle === 'archived' ? 'target_unavailable' : 'target_waiting_for_user',
      );

      effects.sessions = effects.sessions.map((candidate) =>
        candidate.id === 'destination'
          ? { ...candidate, isArchived: false, status: 'active' }
          : candidate,
      );
      await assert.rejects(
        new WorkHubCoordinationActionGate(effects).act(input, CONTEXT),
        (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
      );
      assert.equal(effects.retirements.length, 1);
    });
  }

  test('retry records an abort when the process crashed after source retirement', async () => {
    const effects = fakeEffects([session('source'), session('destination')]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'e'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Wrong target',
        },
        'source-turn',
      ),
    );
    const snapshot = await new WorkHubCoordinationActionGate(effects).candidates();
    const destination = snapshot.candidates.find(
      (candidate) => candidate.sessionId === 'destination',
    )!;
    const input = {
      actionId: 'crashed-after-retirement',
      userText: 'No, move this to destination',
      candidateSetId: snapshot.candidateSetId,
      confirmation: { kind: 'user_correction' as const },
      proposal: {
        disposition: 'replace' as const,
        replacesActionId: 'source-action',
        target: {
          disposition: 'delegate_existing' as const,
          candidateRef: destination.candidateRef,
        },
      },
    };
    const retireDelegation = effects.retireDelegation;
    effects.retireDelegation = async (assignment) => {
      await retireDelegation.call(effects, assignment);
      throw new Error('simulated process exit after retirement');
    };

    await assert.rejects(new WorkHubCoordinationActionGate(effects).act(input, CONTEXT));
    effects.sessions = effects.sessions.map((candidate) =>
      candidate.id === 'destination' ? { ...candidate, isArchived: true } : candidate,
    );

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(input, CONTEXT),
      (error) =>
        error instanceof WorkHubActionGateFailure && error.code === 'candidate_unavailable',
    );
    assert.equal(effects.retirements.length, 1);
    assert.equal(
      effects.replacementAborts.get('delegation-source-action')?.reason,
      'target_unavailable',
    );
  });

  test('the first durable correction intent owns a delegation', async () => {
    const effects = fakeEffects([session('source'), session('first'), session('second')]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'c'.repeat(64)}`,
          targetSessionId: 'source',
          targetSessionName: 'source',
          disposition: 'delegate_existing',
          userText: 'Start source work',
        },
        'source-turn',
      ),
    );
    const snapshot = await new WorkHubCoordinationActionGate(effects).candidates();
    const inputFor = (actionId: string, targetId: string) => ({
      actionId,
      userText: `No, use ${targetId} instead`,
      candidateSetId: snapshot.candidateSetId,
      confirmation: { kind: 'user_correction' as const },
      proposal: {
        disposition: 'replace' as const,
        replacesActionId: 'source-action',
        target: {
          disposition: 'delegate_existing' as const,
          candidateRef: snapshot.candidates.find((candidate) => candidate.sessionId === targetId)!
            .candidateRef,
        },
      },
    });
    const assign = effects.assign;
    effects.assign = async () => {
      throw new WorkHubActionEffectFailure('internal_failure', 'hold after durable intent');
    };
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        inputFor('first-correction', 'first'),
        CONTEXT,
      ),
    );
    effects.assign = assign;
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        inputFor('second-correction', 'second'),
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(
      effects.replacements.get('delegation-source-action')?.actionId,
      'first-correction',
    );
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
  const assignmentRecords = new Map<string, WorkHubDelegationAssignedMessage>();
  const replacements = new Map<string, WorkHubDelegationReplacementRequestedMessage>();
  const replacementAborts = new Map<string, WorkHubDelegationReplacementAbortedMessage>();
  const supersessions = new Map<string, WorkHubDelegationSupersededMessage>();
  return {
    sessions: [...initialSessions],
    answers: [] as Array<{ turnId: string; text: string }>,
    clarifications: [] as Array<{
      turnId: string;
      userText: string;
      assistantText: string;
    }>,
    assignments: [] as WorkHubDelegationAssignmentInput[],
    assignmentRecords,
    replacements,
    replacementAborts,
    supersessions,
    retirements: [] as WorkHubDelegationAssignedMessage[],
    async listSessions() {
      return this.sessions;
    },
    async readAssignment(actionId: string) {
      return assignmentRecords.get(actionId);
    },
    async readReplacement(delegationId: string) {
      return replacements.get(delegationId);
    },
    async readReplacementAbort(delegationId: string) {
      return replacementAborts.get(delegationId);
    },
    async readSupersession(delegationId: string) {
      return supersessions.get(delegationId);
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
      const record = assignmentRecord(input, result.turnId);
      assignmentRecords.set(input.actionId, record);
      if (input.replacesDelegationId) {
        supersessions.set(input.replacesDelegationId, {
          type: 'workhub_coordination',
          id: `superseded-${input.actionId}`,
          turnId: input.actionId,
          ts: 3,
          schemaVersion: 2,
          kind: 'delegation_superseded',
          actionId: input.actionId,
          actionFingerprint: input.actionFingerprint,
          coordinationTurnId: input.actionId,
          supersededActionId: input.replacesActionId!,
          supersededDelegationId: input.replacesDelegationId,
          replacementDelegationId: record.delegationId,
        });
      }
      return result;
    },
    async prepareReplacement(input: WorkHubDelegationReplacementInput) {
      const existing = replacements.get(input.replacesDelegationId);
      if (existing) return existing;
      const replacement: WorkHubDelegationReplacementRequestedMessage = {
        type: 'workhub_coordination',
        id: `replacement-${input.actionId}`,
        turnId: input.actionId,
        ts: 2,
        schemaVersion: 2,
        kind: 'delegation_replacement_requested',
        actionId: input.actionId,
        actionFingerprint: input.actionFingerprint,
        coordinationTurnId: input.actionId,
        targetSessionId: input.targetSessionId,
        targetSessionName: input.targetSessionName,
        disposition: input.disposition,
        userText: input.userText,
        ...(input.create ? { create: input.create } : {}),
        replacesActionId: input.replacesActionId,
        replacesDelegationId: input.replacesDelegationId,
        replacedTargetSessionId: input.replacedTargetSessionId,
        replacedTargetMessageId: input.replacedTargetMessageId,
      };
      replacements.set(input.replacesDelegationId, replacement);
      return replacement;
    },
    async abortReplacement(input: WorkHubDelegationReplacementAbortInput) {
      const replacement = input.replacement;
      const existing = replacementAborts.get(replacement.replacesDelegationId);
      if (existing) return existing;
      const aborted: WorkHubDelegationReplacementAbortedMessage = {
        type: 'workhub_coordination',
        id: `aborted-${replacement.actionId}`,
        turnId: replacement.actionId,
        ts: 4,
        schemaVersion: 2,
        kind: 'delegation_replacement_aborted',
        actionId: replacement.actionId,
        actionFingerprint: replacement.actionFingerprint,
        coordinationTurnId: replacement.actionId,
        abortedActionId: replacement.replacesActionId,
        abortedDelegationId: replacement.replacesDelegationId,
        targetSessionId: replacement.targetSessionId,
        reason: input.reason,
      };
      replacementAborts.set(replacement.replacesDelegationId, aborted);
      return aborted;
    },
    async readDelegationRetirement(assignment: WorkHubDelegationAssignedMessage) {
      return this.retirements.some((retired) => retired.delegationId === assignment.delegationId)
        ? ('retired' as const)
        : ('not_retired' as const);
    },
    async retireDelegation(assignment: WorkHubDelegationAssignedMessage) {
      this.retirements.push(assignment);
    },
  } satisfies WorkHubActionGateEffects & {
    sessions: WorkHubActionGateSession[];
    answers: Array<{ turnId: string; text: string }>;
    clarifications: Array<{ turnId: string; userText: string; assistantText: string }>;
    assignments: WorkHubDelegationAssignmentInput[];
    assignmentRecords: Map<string, WorkHubDelegationAssignedMessage>;
    replacements: Map<string, WorkHubDelegationReplacementRequestedMessage>;
    replacementAborts: Map<string, WorkHubDelegationReplacementAbortedMessage>;
    supersessions: Map<string, WorkHubDelegationSupersededMessage>;
    retirements: WorkHubDelegationAssignedMessage[];
  };
}

function assignmentRecord(
  input: WorkHubDelegationAssignmentInput,
  targetTurnId: string,
): WorkHubDelegationAssignedMessage {
  return {
    type: 'workhub_coordination',
    id: `assignment-${input.actionId}`,
    turnId: input.actionId,
    ts: 1,
    schemaVersion: input.replacesDelegationId ? 2 : 1,
    kind: 'delegation_assigned',
    actionId: input.actionId,
    actionFingerprint: input.actionFingerprint,
    coordinationTurnId: input.actionId,
    targetSessionId: input.targetSessionId,
    targetSessionName: input.targetSessionName,
    targetTurnId,
    targetMessageId: `message-${input.actionId}`,
    delegationId: `delegation-${input.actionId}`,
    disposition: input.disposition,
    userText: input.userText,
    ...(input.create ? { create: input.create } : {}),
    ...(input.replacesActionId ? { replacesActionId: input.replacesActionId } : {}),
    ...(input.replacesDelegationId ? { replacesDelegationId: input.replacesDelegationId } : {}),
  };
}
