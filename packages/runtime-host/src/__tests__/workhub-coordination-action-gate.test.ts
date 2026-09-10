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
  WorkHubActionClaim,
  WorkHubActionClaimOutcome,
  WorkHubDelegationAssignedMessage,
  WorkHubDelegationReplacementAbortedMessage,
  WorkHubDelegationReplacementRequestedMessage,
  WorkHubDelegationStopRequestedMessage,
  WorkHubDelegationStopResolvedMessage,
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
  type WorkHubDelegationResumeInput,
  type WorkHubDelegationRetirementClaim,
  type WorkHubDelegationStopInput,
  type WorkHubDelegationStopResolutionInput,
  type WorkHubRetirementResult,
} from '../server/workhub-coordination-action-gate.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const CONTEXT: ConnectionContext = {
  hostEpoch: 'workhub-action-gate-test',
  connectionId: 'workhub-action-gate-client',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

describe('WorkHub Coordination Action Gate', () => {
  test('delegation content remains separate from authorization and survives durable replay', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const candidates = await gate.candidates();
    const input = {
      actionId: 'model-tool-call',
      userText: 'Continue Payments and explain the result here',
      delegationText: 'Inspect and fix the payment retry state',
      candidateSetId: candidates.candidateSetId,
      proposal: {
        disposition: 'delegate_existing' as const,
        candidateRef: candidates.candidates[0]!.candidateRef,
      },
    };
    const result = await gate.act(input, CONTEXT);
    assert.equal(effects.assignments[0]?.userText, input.userText);
    assert.equal(effects.assignments[0]?.delegationText, input.delegationText);
    assert.equal(
      effects.assignmentRecords.get(input.actionId)?.delegationText,
      input.delegationText,
    );
    assert.deepEqual(await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT), result);
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        { ...input, delegationText: 'Delete all payment work' },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
  });

  test('replacement intent retains delegated content across a restart before assignment', async () => {
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
          userText: 'Start source work',
        },
        'source-turn',
      ),
    );
    const candidates = await new WorkHubCoordinationActionGate(effects).candidates();
    const input = {
      actionId: 'replacement-tool-call',
      userText: 'No, use destination instead',
      delegationText: 'Fix the login retries',
      candidateSetId: candidates.candidateSetId,

      proposal: {
        disposition: 'replace' as const,
        replacesActionId: 'source-action',
        target: {
          disposition: 'delegate_existing' as const,
          candidateRef: candidates.candidates.find(({ sessionId }) => sessionId === 'destination')!
            .candidateRef,
        },
      },
    };
    const assign = effects.assign;
    effects.assign = async () => {
      throw new WorkHubActionEffectFailure('internal_failure', 'Interrupted after intent');
    };
    await assert.rejects(new WorkHubCoordinationActionGate(effects).act(input, CONTEXT));
    assert.equal(
      effects.replacements.get('delegation-source-action')?.delegationText,
      input.delegationText,
    );
    effects.assign = assign;
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        { ...input, delegationText: 'Different work' },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT);
    assert.equal(
      effects.assignmentRecords.get(input.actionId)?.delegationText,
      input.delegationText,
    );
  });

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

  /**
   * A stop proposal as the Action Policy produces it: opaque identities plus
   * the active-delegation state it resolved against, never a display name.
   */
  const stopProposal = (targetSessionId: string) => ({
    disposition: 'stop_work' as const,
    expects: { targetSessionId },
  });

  const resumeProposal = (targetSessionId: string, resumesActionId = 'source-action') => ({
    resumesActionId,
    disposition: 'resume_work' as const,
    expects: { targetSessionId },
  });

  const delegatedTo = (effects: ReturnType<typeof fakeEffects>, sessionId: string) => {
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'a'.repeat(64)}`,
          targetSessionId: sessionId,
          targetSessionName: 'Payments',
          disposition: 'delegate_existing',
          userText: 'Fix payment retry',
        },
        'source-turn',
      ),
    );
  };

  test('resumes the one delegation the named Session owns', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    delegatedTo(effects, 'payments');

    const result = await new WorkHubCoordinationActionGate(effects).act(
      {
        actionId: 'resume-action',
        userText: 'Resume Payments',
        proposal: resumeProposal('payments'),
      },
      CONTEXT,
    );

    assert.deepEqual(result, {
      disposition: 'resume_work',
      outcome: 'resume_started',
      targetSessionId: 'payments',
      targetTurnId: 'resumed-turn',
    });
    assert.equal(effects.resumeCalls.length, 1);
    const resumeCall = effects.resumeCalls[0];
    assert.ok(resumeCall);
    assert.equal(resumeCall.source.actionId, 'source-action');
    assert.equal(effects.actionClaims.has('resume-action'), false);
  });

  test('resume refuses a Session that does not own exactly one delegation', async () => {
    const none = fakeEffects([session('payments', { name: 'Payments' })]);
    await assert.rejects(
      () =>
        new WorkHubCoordinationActionGate(none).act(
          {
            actionId: 'resume-none',
            userText: 'Resume Payments',
            proposal: resumeProposal('payments'),
          },
          CONTEXT,
        ),
      /resume target delegation changed/u,
    );

    const several = fakeEffects([session('payments', { name: 'Payments' })]);
    delegatedTo(several, 'payments');
    several.assignmentRecords.set(
      'second-action',
      assignmentRecord(
        {
          actionId: 'second-action',
          actionFingerprint: `sha256:${'b'.repeat(64)}`,
          targetSessionId: 'payments',
          targetSessionName: 'Payments',
          disposition: 'delegate_existing',
          userText: 'Also fix the receipts',
        },
        'second-turn',
      ),
    );
    await assert.rejects(
      () =>
        new WorkHubCoordinationActionGate(several).act(
          {
            actionId: 'resume-many',
            userText: 'Resume Payments',
            proposal: resumeProposal('payments'),
          },
          CONTEXT,
        ),
      /does not identify one active durable delegation/u,
    );
    assert.equal(several.resumeCalls.length, 0);
  });

  test('resume ignores a retired link when one delegation still holds work', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    delegatedTo(effects, 'payments');
    const retired = effects.assignmentRecords.get('source-action')!;
    effects.assignmentRecords.set(
      'second-action',
      assignmentRecord(
        {
          actionId: 'second-action',
          actionFingerprint: `sha256:${'b'.repeat(64)}`,
          targetSessionId: 'payments',
          targetSessionName: 'Payments',
          disposition: 'delegate_existing',
          userText: 'Fix the interrupted receipt retry',
        },
        'second-turn',
      ),
    );
    effects.retirements.push(retired);

    const result = await new WorkHubCoordinationActionGate(effects).act(
      {
        actionId: 'resume-one-live',
        userText: 'Resume Payments',
        proposal: resumeProposal('payments', 'second-action'),
      },
      CONTEXT,
    );

    assert.equal(result.disposition, 'resume_work');
    const call = effects.resumeCalls[0];
    assert.ok(call);
    assert.equal(call.source.actionId, 'second-action');
  });

  test('resume retries cannot move an explicitly named assignment to another delegation', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    delegatedTo(effects, 'payments');

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          actionId: 'resume-retry',
          userText: 'Resume Payments',
          proposal: resumeProposal('payments', 'retired-assignment'),
        },
        CONTEXT,
      ),
      /resume target delegation changed/u,
    );
    assert.equal(effects.resumeCalls.length, 0);
  });

  test('resume reports when the delegated work is already running', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    delegatedTo(effects, 'payments');
    effects.resumeOutcome = { outcome: 'already_running' };

    const result = await new WorkHubCoordinationActionGate(effects).act(
      {
        actionId: 'resume-already-running',
        userText: 'Resume Payments',
        proposal: resumeProposal('payments'),
      },
      CONTEXT,
    );

    assert.deepEqual(result, {
      disposition: 'resume_work',
      outcome: 'already_running',
      targetSessionId: 'payments',
    });
  });

  test('stops exactly one named durable delegation and replays its observed outcome', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'a'.repeat(64)}`,
          targetSessionId: 'payments',
          targetSessionName: 'Payments',
          disposition: 'delegate_existing',
          userText: 'Fix payment retry',
        },
        'source-turn',
      ),
    );
    const input = {
      actionId: 'stop-action',
      userText: 'Stop Payments',
      proposal: stopProposal('payments'),
    };

    const first = await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT);
    assert.deepEqual(first, {
      disposition: 'stop_work',
      outcome: 'cancelled_pending',
      targetSessionId: 'payments',
    });
    assert.equal(effects.retirements.length, 1);
    assert.equal(effects.stopRequests.size, 1);
    assert.equal(effects.stopResolutions.size, 1);

    const replay = await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT);
    assert.deepEqual(replay, first);
    assert.equal(effects.retirements.length, 1);
  });

  test('a deleted delegation target does not disable stop for every other Session', async () => {
    const effects = fakeEffects([
      session('payments', { name: 'Payments' }),
      session('login', { name: 'Login' }),
    ]);
    for (const [actionId, targetSessionId, name] of [
      ['pay-action', 'payments', 'Payments'],
      ['login-action', 'login', 'Login'],
    ] as const) {
      effects.assignmentRecords.set(
        actionId,
        assignmentRecord(
          {
            actionId,
            actionFingerprint: `sha256:${(actionId === 'pay-action' ? '4' : '5').repeat(64)}`,
            targetSessionId,
            targetSessionName: name,
            disposition: 'delegate_existing',
            userText: `Work in ${name}`,
          },
          `${actionId}-turn`,
        ),
      );
    }

    // Nothing retires a delegation when its Session is deleted, so this one
    // stays active forever. It must not be able to veto an unrelated stop.
    effects.sessions = effects.sessions.filter(({ id }) => id !== 'payments');

    const stopped = await new WorkHubCoordinationActionGate(effects).act(
      {
        actionId: 'stop-login',
        userText: 'Stop Login',
        proposal: stopProposal('login'),
      },
      CONTEXT,
    );
    assert.equal(stopped.disposition, 'stop_work');

    // The dangling delegation itself still fails closed: its own target is gone.
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          actionId: 'stop-payments',
          userText: 'Stop Payments',
          proposal: stopProposal('payments'),
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
  });

  test('a finished delegation stops competing for the sole-delegation proof', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    for (const actionId of ['finished-action', 'live-action']) {
      effects.assignmentRecords.set(
        actionId,
        assignmentRecord(
          {
            actionId,
            actionFingerprint: `sha256:${(actionId === 'live-action' ? '6' : '7').repeat(64)}`,
            targetSessionId: 'payments',
            targetSessionName: 'Payments',
            disposition: 'delegate_existing',
            userText: `Work from ${actionId}`,
          },
          `${actionId}-turn`,
        ),
      );
    }
    // The link outlives the work, so the completed delegation is still active.
    const settled = new Set(['delegation-finished-action']);
    effects.readDelegationRetirement = async (assignment) =>
      settled.has(assignment.delegationId) ? 'retired' : 'not_retired';

    const stopped = await new WorkHubCoordinationActionGate(effects).act(
      {
        actionId: 'stop-live',
        userText: 'Stop Payments',
        proposal: stopProposal('payments'),
      },
      CONTEXT,
    );
    assert.equal(stopped.disposition, 'stop_work');
  });

  test('a competitor the Host cannot resolve yet fails the stop closed', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    for (const actionId of ['unreadable-action', 'live-action']) {
      effects.assignmentRecords.set(
        actionId,
        assignmentRecord(
          {
            actionId,
            actionFingerprint: `sha256:${(actionId === 'live-action' ? '6' : '7').repeat(64)}`,
            targetSessionId: 'payments',
            targetSessionName: 'Payments',
            disposition: 'delegate_existing',
            userText: `Work from ${actionId}`,
          },
          `${actionId}-turn`,
        ),
      );
    }
    // Unreadable is not the same as finished, so it still blocks the proof.
    effects.readDelegationRetirement = async (assignment) =>
      assignment.actionId === 'unreadable-action' ? 'recovering' : 'not_retired';

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          actionId: 'stop-unresolved-competitor',
          userText: 'Stop Payments',
          proposal: stopProposal('payments'),
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.stopRequests.size, 0);
  });

  test('rejects a stop that does not identify one active durable delegation', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    for (const actionId of ['source-action', 'other-action']) {
      effects.assignmentRecords.set(
        actionId,
        assignmentRecord(
          {
            actionId,
            actionFingerprint: `sha256:${(actionId === 'source-action' ? '1' : '2').repeat(64)}`,
            targetSessionId: 'payments',
            targetSessionName: 'Payments',
            disposition: 'delegate_existing',
            userText: `Work from ${actionId}`,
          },
          `${actionId}-turn`,
        ),
      );
    }

    // Stop admits a sole active delegation, and the Host proves that from
    // durable state — the proposal cannot assert its way past it.
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          actionId: 'stop-ambiguous-payments',
          userText: 'Stop Payments',
          proposal: stopProposal('payments'),
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.stopRequests.size, 0);
    assert.equal(effects.retirements.length, 0);
  });

  test('rejects a stop whose target precondition disagrees with durable ownership', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'b'.repeat(64)}`,
          targetSessionId: 'payments',
          targetSessionName: 'Payments',
          disposition: 'delegate_existing',
          userText: 'Fix payment retry',
        },
        'source-turn',
      ),
    );
    // A precondition that disagrees with durable state fails closed: this
    // delegation does not belong to the Session the proposal resolved.
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          actionId: 'stop-wrong-session',
          userText: 'Stop Payments',
          proposal: stopProposal('login'),
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.retirements.length, 0);
  });

  test('records not_owned without treating a shared user Turn as stopped', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'c'.repeat(64)}`,
          targetSessionId: 'payments',
          targetSessionName: 'Payments',
          disposition: 'delegate_existing',
          userText: 'Fix payment retry',
        },
        'source-turn',
      ),
    );
    effects.retireDelegation = async () => ({
      outcome: 'not_owned',
      targetTurnId: 'shared-turn',
    });

    const result = await new WorkHubCoordinationActionGate(effects).act(
      {
        actionId: 'stop-shared',
        userText: 'Stop Payments',
        proposal: stopProposal('payments'),
      },
      CONTEXT,
    );
    assert.deepEqual(result, {
      disposition: 'stop_work',
      outcome: 'not_owned',
      targetSessionId: 'payments',
      targetTurnId: 'shared-turn',
    });
    assert.equal(effects.supersessions.size, 0);
    effects.supersessions.set('delegation-source-action', {
      type: 'workhub_coordination',
      id: 'later-supersession',
      turnId: 'later-correction',
      ts: 9,
      schemaVersion: 2,
      kind: 'delegation_superseded',
      actionId: 'later-correction',
      actionFingerprint: `sha256:${'d'.repeat(64)}`,
      coordinationTurnId: 'later-correction',
      supersededActionId: 'source-action',
      supersededDelegationId: 'delegation-source-action',
      replacementDelegationId: 'replacement-delegation',
    });
    assert.deepEqual(
      await new WorkHubCoordinationActionGate(effects).act(
        {
          actionId: 'stop-shared',
          userText: 'Stop Payments',
          proposal: stopProposal('payments'),
        },
        CONTEXT,
      ),
      result,
    );
  });

  test('a recovering stop keeps its action identity out of a second delegation', async () => {
    const effects = fakeEffects([
      session('payments', { name: 'Payments' }),
      session('login', { name: 'Login' }),
    ]);
    for (const [actionId, targetSessionId, name] of [
      ['source-action', 'payments', 'Payments'],
      ['other-action', 'login', 'Login'],
    ] as const) {
      effects.assignmentRecords.set(
        actionId,
        assignmentRecord(
          {
            actionId,
            actionFingerprint: `sha256:${(actionId === 'source-action' ? '1' : '2').repeat(64)}`,
            targetSessionId,
            targetSessionName: name,
            disposition: 'delegate_existing',
            userText: `Work in ${name}`,
          },
          `${actionId}-turn`,
        ),
      );
    }
    effects.retireDelegation = async () => ({ outcome: 'recovering' as const });

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          actionId: 'reused-stop',
          userText: 'Stop Payments',
          proposal: stopProposal('payments'),
        },
        CONTEXT,
      ),
      (error) =>
        error instanceof WorkHubActionEffectFailure && error.code === 'operation_unavailable',
    );
    assert.deepEqual([...effects.stopRequests.keys()], ['delegation-source-action']);

    // A fresh gate is the Host after restart: only the durable action owner can
    // refuse the second delegation this identity is now trying to claim.
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          actionId: 'reused-stop',
          userText: 'Stop Login',
          proposal: stopProposal('login'),
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.deepEqual([...effects.stopRequests.keys()], ['delegation-source-action']);
    assert.equal(effects.stopResolutions.size, 0);
  });

  test('a committed stop identity cannot replay against another Session with the same name', async () => {
    const effects = fakeEffects([
      session('payments-primary', { name: 'Payments' }),
      session('payments-secondary', { name: 'Payments' }),
    ]);
    for (const [actionId, targetSessionId] of [
      ['primary-action', 'payments-primary'],
      ['secondary-action', 'payments-secondary'],
    ] as const) {
      effects.assignmentRecords.set(
        actionId,
        assignmentRecord(
          {
            actionId,
            actionFingerprint: `sha256:${(actionId === 'primary-action' ? '1' : '2').repeat(64)}`,
            targetSessionId,
            targetSessionName: 'Payments',
            disposition: 'delegate_existing',
            userText: 'Fix payment retry',
          },
          `${actionId}-turn`,
        ),
      );
    }
    effects.retireDelegation = async () => ({ outcome: 'recovering' as const });
    const stopInput = (targetSessionId: string) => ({
      actionId: 'reused-stop',
      userText: 'Stop Payments',
      proposal: stopProposal(targetSessionId),
    });

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(stopInput('payments-primary'), CONTEXT),
      (error) =>
        error instanceof WorkHubActionEffectFailure && error.code === 'operation_unavailable',
    );
    assert.deepEqual([...effects.stopRequests.keys()], ['delegation-primary-action']);

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(stopInput('payments-secondary'), CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.deepEqual([...effects.stopRequests.keys()], ['delegation-primary-action']);
  });

  test('a stop action identity cannot cross into a delegation assignment', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'7'.repeat(64)}`,
          targetSessionId: 'payments',
          targetSessionName: 'Payments',
          disposition: 'delegate_existing',
          userText: 'Fix payment retry',
        },
        'source-turn',
      ),
    );
    await new WorkHubCoordinationActionGate(effects).act(
      {
        actionId: 'crossing-action',
        userText: 'Stop Payments',
        proposal: stopProposal('payments'),
      },
      CONTEXT,
    );

    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    await assert.rejects(
      gate.act(
        {
          actionId: 'crossing-action',
          userText: 'Fix the login redirect',
          candidateSetId: snapshot.candidateSetId,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: snapshot.candidates[0]!.candidateRef,
          },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.assignments.length, 0);
  });

  test('a fresh attempt after not_owned converges instead of conflicting forever', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'8'.repeat(64)}`,
          targetSessionId: 'payments',
          targetSessionName: 'Payments',
          disposition: 'delegate_existing',
          userText: 'Fix payment retry',
        },
        'source-turn',
      ),
    );
    let retirements = 0;
    effects.retireDelegation = async () => {
      retirements += 1;
      return { outcome: 'not_owned' as const, targetTurnId: 'shared-turn' };
    };
    const first = await new WorkHubCoordinationActionGate(effects).act(
      {
        actionId: 'stop-first',
        userText: 'Stop Payments',
        proposal: stopProposal('payments'),
      },
      CONTEXT,
    );

    const retried = await new WorkHubCoordinationActionGate(effects).act(
      {
        actionId: 'stop-second',
        userText: 'Stop Payments',
        proposal: stopProposal('payments'),
      },
      CONTEXT,
    );

    assert.deepEqual(retried, first);
    assert.equal(retirements, 1);
    assert.equal(effects.stopResolutions.size, 1);
  });

  test('a committed stop converges once its target Session is durably removed', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'9'.repeat(64)}`,
          targetSessionId: 'payments',
          targetSessionName: 'Payments',
          disposition: 'delegate_existing',
          userText: 'Fix payment retry',
        },
        'source-turn',
      ),
    );
    effects.retireDelegation = async () => ({ outcome: 'recovering' as const });
    const input = {
      actionId: 'stop-removed-target',
      userText: 'Stop Payments',
      proposal: stopProposal('payments'),
    };
    const unresolved = (error: unknown) =>
      error instanceof WorkHubActionEffectFailure && error.code === 'operation_unavailable';

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(input, CONTEXT),
      unresolved,
    );
    assert.equal(effects.stopRequests.size, 1);

    // Unreadable is not proof. Only the removal tombstone resolves the claim.
    effects.sessions = [];
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(input, CONTEXT),
      unresolved,
    );
    assert.equal(effects.stopResolutions.size, 0);

    effects.removedSessionIds.add('payments');
    const resolved = await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT);
    assert.deepEqual(resolved, {
      disposition: 'stop_work',
      outcome: 'already_terminal',
      targetSessionId: 'payments',
    });
    assert.deepEqual(
      await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT),
      resolved,
    );
    assert.equal(effects.stopResolutions.size, 1);
  });

  test('keeps display names as stop evidence rather than admission authority', async () => {
    const effects = fakeEffects([session('payments', { name: 'Renamed Payments' })]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'e'.repeat(64)}`,
          targetSessionId: 'payments',
          targetSessionName: 'Old Payments',
          disposition: 'delegate_existing',
          userText: 'Fix payment retry',
        },
        'source-turn',
      ),
    );
    // The reference the user typed is the Session's old name. Resolution is the
    // Resolver's business; admission proves the opaque identity, so a rename
    // between resolution and admission cannot invalidate the claim.
    const input = {
      actionId: 'stop-renamed',
      userText: 'Stop Old Payments',
      proposal: stopProposal('payments'),
    };
    assert.equal(
      (await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT)).disposition,
      'stop_work',
    );
    assert.equal(
      effects.stopRequests.get('delegation-source-action')?.targetSessionName,
      'Renamed Payments',
    );
    effects.sessions[0] = session('payments', { name: 'Renamed Again' });
    assert.equal(
      (await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT)).disposition,
      'stop_work',
    );
    assert.equal(
      effects.stopRequests.get('delegation-source-action')?.targetSessionName,
      'Renamed Payments',
    );
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
      attachments: [
        {
          name: 'requirements.txt',
          kind: 'other' as const,
          mimeType: 'text/plain',
          bytes: 12,
          ref: {
            kind: 'session_file' as const,
            sessionId: 'maka_workhub_coordination',
            relativePath: 'artifact-1',
          },
        },
      ],
      newWorkDefaults: {
        model: { llmConnectionId: 'conn', llmConnectionSlug: 'test', model: 'chosen-model' },
        permissionMode: 'ask' as const,
      },
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
    assert.deepEqual(effects.assignments[0]?.attachments, input.attachments);
    assert.match(effects.assignments[0]!.targetSessionId, /^whs_[a-f0-9]{48}$/u);
    assert.deepEqual(effects.assignments[0]!.create, {
      title: 'Accessibility audit',
      workspace: input.create.workspace,
      defaults: input.newWorkDefaults,
    });
    await assert.rejects(
      gate.act({ ...input, proposal: { disposition: 'create_new', title: 'Different' } }, CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        { ...input, newWorkDefaults: { ...input.newWorkDefaults, permissionMode: 'bypass' } },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.assignments.length, 2);
  });

  test('replacement creation records a terminal abort when admission fails after retirement', async () => {
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
    effects.assign = async () => {
      throw new WorkHubActionEffectFailure('internal_failure', 'creation admission failed');
    };
    const input = {
      actionId: 'failed-replacement-create',
      userText: 'No, create a new Session for Payments instead',

      proposal: {
        disposition: 'replace' as const,
        replacesActionId: 'source-action',
        target: { disposition: 'create_new' as const, title: 'Payments' },
      },
      create: { workspace: { kind: 'host_path' as const, path: '/workspace' } },
    };

    await assert.rejects(new WorkHubCoordinationActionGate(effects).act(input, CONTEXT));
    assert.equal(effects.retirements.length, 1);
    assert.equal(
      effects.replacementAborts.get('delegation-source-action')?.reason,
      'target_unavailable',
    );
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(input, CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
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

  test('replaces a durable delegation it owns', async () => {
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

    const result = await gate.act({ ...input }, CONTEXT);

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
      userText: 'Not this session; move it to destination',
      candidateSetId: snapshot.candidateSetId,

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

  test('rejects a conflicting post-migration claim before replaying a prepared replacement', async () => {
    const effects = fakeEffects([session('source'), session('destination')]);
    effects.assignmentRecords.set(
      'source-action',
      assignmentRecord(
        {
          actionId: 'source-action',
          actionFingerprint: `sha256:${'c'.repeat(64)}`,
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
    const input = {
      actionId: 'migrated-prepared-replacement',
      userText: 'No, send this to destination',
      candidateSetId: snapshot.candidateSetId,

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
    const prepareReplacement = effects.prepareReplacement;
    effects.prepareReplacement = async (replacement) => {
      await prepareReplacement(replacement);
      throw new WorkHubActionEffectFailure('internal_failure', 'simulated pre-retirement crash');
    };

    await assert.rejects(gate.act(input, CONTEXT));
    assert.equal(effects.replacements.has('delegation-source-action'), true);
    assert.equal(effects.retirements.length, 0);

    effects.actionClaims.clear();
    effects.actionClaims.set(input.actionId, {
      actionId: input.actionId,
      operation: 'answer_here',
      actionFingerprint: `sha256:${'d'.repeat(64)}`,
      subject: 'coordination-session',
    });

    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(input, CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.retirements.length, 0);
    assert.equal(effects.assignments.length, 0);
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
    effects.retireDelegation = async (assignment, retirement) => {
      const result = await retireDelegation.call(effects, assignment, retirement);
      effects.sessions = effects.sessions.map((candidate) =>
        candidate.id === 'destination' ? { ...candidate, name: 'Renamed destination' } : candidate,
      );
      return result;
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
      effects.retireDelegation = async (assignment, retirement) => {
        const result = await retireDelegation.call(effects, assignment, retirement);
        effects.sessions = effects.sessions.map((candidate) =>
          candidate.id !== 'destination'
            ? candidate
            : lifecycle === 'archived'
              ? { ...candidate, isArchived: true }
              : { ...candidate, status: 'waiting_for_user' },
        );
        return result;
      };
      const input = {
        actionId: `target-became-${lifecycle}`,
        userText: 'No, move this to destination',
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
    effects.retireDelegation = async (assignment, retirement) => {
      await retireDelegation.call(effects, assignment, retirement);
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
  const stopRequests = new Map<string, WorkHubDelegationStopRequestedMessage>();
  const stopResolutions = new Map<string, WorkHubDelegationStopResolvedMessage>();
  const actionClaims = new Map<string, WorkHubActionClaim>();
  return {
    sessions: [...initialSessions],
    actionClaims,
    removedSessionIds: new Set<string>(),

    assignments: [] as WorkHubDelegationAssignmentInput[],
    assignmentRecords,
    replacements,
    replacementAborts,
    supersessions,
    stopRequests,
    stopResolutions,
    retirements: [] as WorkHubDelegationAssignedMessage[],
    retirementClaims: [] as WorkHubDelegationRetirementClaim[],
    async listSessions() {
      return this.sessions;
    },
    async claimAction(claim: WorkHubActionClaim): Promise<WorkHubActionClaimOutcome> {
      const existing = actionClaims.get(claim.actionId);
      if (!existing) {
        actionClaims.set(claim.actionId, claim);
        return 'claimed';
      }
      return existing.operation === claim.operation &&
        existing.actionFingerprint === claim.actionFingerprint &&
        existing.subject === claim.subject
        ? 'same_claim'
        : 'conflict';
    },
    resumeCalls: [] as WorkHubDelegationResumeInput[],
    resumeOutcome: {
      outcome: 'resume_started' as const,
      targetTurnId: 'resumed-turn',
    } as {
      outcome: 'resume_started' | 'already_running';
      targetTurnId?: string;
    },
    async resume(input: WorkHubDelegationResumeInput) {
      await input.validateFreshTarget();
      this.resumeCalls.push(input);
      return {
        disposition: 'resume_work' as const,
        outcome: this.resumeOutcome.outcome,
        targetSessionId: input.source.targetSessionId,
        ...(this.resumeOutcome.targetTurnId
          ? { targetTurnId: this.resumeOutcome.targetTurnId }
          : {}),
      };
    },
    async readActionClaim(actionId: string) {
      return actionClaims.get(actionId);
    },
    async probeTargetRemoval(sessionId: string) {
      if (this.sessions.some((session) => session.id === sessionId)) return 'present' as const;
      return this.removedSessionIds.has(sessionId) ? ('removed' as const) : ('absent' as const);
    },
    async readAssignment(actionId: string) {
      return assignmentRecords.get(actionId);
    },
    async listActiveAssignments(targetSessionId) {
      return [...assignmentRecords.values()].filter((assignment) => {
        const stopOutcome = stopResolutions.get(assignment.delegationId)?.outcome;
        return (
          assignment.targetSessionId === targetSessionId &&
          !supersessions.has(assignment.delegationId) &&
          !replacementAborts.has(assignment.delegationId) &&
          (stopOutcome === undefined || stopOutcome === 'not_owned')
        );
      });
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
    async readStopRequest(delegationId: string) {
      return stopRequests.get(delegationId);
    },
    async readStopResolution(delegationId: string) {
      return stopResolutions.get(delegationId);
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
        ...(input.delegationText === undefined ? {} : { delegationText: input.delegationText }),
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
    async prepareStop(input: WorkHubDelegationStopInput) {
      const existing = stopRequests.get(input.stopsDelegationId);
      if (existing) return existing;
      const requested: WorkHubDelegationStopRequestedMessage = {
        type: 'workhub_coordination',
        id: `stop-${input.actionId}`,
        turnId: input.actionId,
        ts: 5,
        schemaVersion: 3,
        kind: 'delegation_stop_requested',
        actionId: input.actionId,
        actionFingerprint: input.actionFingerprint,
        coordinationTurnId: input.actionId,
        stopsActionId: input.stopsActionId,
        stopsDelegationId: input.stopsDelegationId,
        targetSessionId: input.targetSessionId,
        targetMessageId: input.targetMessageId,
        targetSessionName: input.targetSessionName,
        userText: input.userText,
      };
      stopRequests.set(input.stopsDelegationId, requested);
      return requested;
    },
    async resolveStop(input: WorkHubDelegationStopResolutionInput) {
      const request = input.request;
      const existing = stopResolutions.get(request.stopsDelegationId);
      if (existing) return existing;
      const resolved: WorkHubDelegationStopResolvedMessage = {
        type: 'workhub_coordination',
        id: `resolved-${request.actionId}`,
        turnId: request.actionId,
        ts: 6,
        schemaVersion: 3,
        kind: 'delegation_stop_resolved',
        actionId: request.actionId,
        actionFingerprint: request.actionFingerprint,
        coordinationTurnId: request.coordinationTurnId,
        stopsActionId: request.stopsActionId,
        stopsDelegationId: request.stopsDelegationId,
        targetSessionId: request.targetSessionId,
        outcome: input.outcome,
        ...(input.targetTurnId ? { targetTurnId: input.targetTurnId } : {}),
      };
      stopResolutions.set(request.stopsDelegationId, resolved);
      return resolved;
    },
    async readDelegationRetirement(
      assignment: WorkHubDelegationAssignedMessage,
    ): Promise<'not_retired' | 'retired' | 'recovering'> {
      return this.retirements.some((retired) => retired.delegationId === assignment.delegationId)
        ? 'retired'
        : 'not_retired';
    },
    async retireDelegation(
      assignment: WorkHubDelegationAssignedMessage,
      retirement: WorkHubDelegationRetirementClaim,
    ): Promise<WorkHubRetirementResult> {
      this.retirements.push(assignment);
      this.retirementClaims.push(retirement);
      return { outcome: 'cancelled_pending' as const };
    },
  } satisfies WorkHubActionGateEffects & {
    sessions: WorkHubActionGateSession[];
    actionClaims: Map<string, WorkHubActionClaim>;
    removedSessionIds: Set<string>;
    retirementClaims: WorkHubDelegationRetirementClaim[];

    assignments: WorkHubDelegationAssignmentInput[];
    assignmentRecords: Map<string, WorkHubDelegationAssignedMessage>;
    replacements: Map<string, WorkHubDelegationReplacementRequestedMessage>;
    replacementAborts: Map<string, WorkHubDelegationReplacementAbortedMessage>;
    supersessions: Map<string, WorkHubDelegationSupersededMessage>;
    stopRequests: Map<string, WorkHubDelegationStopRequestedMessage>;
    stopResolutions: Map<string, WorkHubDelegationStopResolvedMessage>;
    retirements: WorkHubDelegationAssignedMessage[];
    resumeCalls: WorkHubDelegationResumeInput[];
    resumeOutcome: {
      outcome: 'resume_started' | 'already_running';
      targetTurnId?: string;
    };
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
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.delegationText === undefined ? {} : { delegationText: input.delegationText }),
    ...(input.create ? { create: input.create } : {}),
    ...(input.replacesActionId ? { replacesActionId: input.replacesActionId } : {}),
    ...(input.replacesDelegationId ? { replacesDelegationId: input.replacesDelegationId } : {}),
  };
}
