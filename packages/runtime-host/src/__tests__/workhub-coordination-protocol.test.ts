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
import { RuntimeHostProtocolError } from '../protocol/errors.js';
import {
  decodeWorkHubCoordinationActInput,
  decodeWorkHubCoordinationActResult,
  decodeWorkHubCoordinationAnswerInput,
  decodeWorkHubCoordinationCandidatesResult,
  decodeWorkHubCoordinationRecordInput,
  decodeWorkHubCoordinationResolveInput,
  decodeWorkHubCoordinationResolveResult,
  HOST_OPERATION_SPECS,
  REMOTE_OWNER_OPERATION_GRANTS,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
} from '../protocol/index.js';

test('WorkHub Coordination resolve has a closed empty input and bounded identity result', () => {
  assert.deepEqual(decodeWorkHubCoordinationResolveInput({}), {});
  assert.deepEqual(decodeWorkHubCoordinationResolveResult({ sessionId: 'coordination' }), {
    sessionId: 'coordination',
  });
  assert.equal(HOST_OPERATION_SPECS['workhub.coordination.resolve'].mode, 'command');
  assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 86);
  assert.throws(
    () => decodeWorkHubCoordinationResolveInput({ sessionId: 'caller-selected' }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  assert.throws(
    () => decodeWorkHubCoordinationResolveResult({ sessionId: 'coordination', role: 'injected' }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
});

test('WorkHub Coordination answer and summary inputs are closed and bounded', () => {
  assert.deepEqual(
    decodeWorkHubCoordinationAnswerInput({ turnId: 'answer-turn', text: 'What changed?' }),
    { turnId: 'answer-turn', text: 'What changed?' },
  );
  assert.deepEqual(
    decodeWorkHubCoordinationRecordInput({
      turnId: 'summary-turn',
      userText: 'Continue payment work',
      assistantText: 'Submitted to Payment',
    }),
    {
      turnId: 'summary-turn',
      userText: 'Continue payment work',
      assistantText: 'Submitted to Payment',
    },
  );
  assert.deepEqual(
    decodeWorkHubCoordinationActInput({
      actionId: 'action-correction',
      userText: 'No, use login instead',
      candidateSetId: `sha256:${'e'.repeat(64)}`,
      confirmation: { kind: 'user_correction' },
      proposal: {
        disposition: 'replace',
        replacesActionId: 'action-payments',
        target: { disposition: 'delegate_existing', candidateRef: 'candidate_login' },
      },
    }).proposal,
    {
      disposition: 'replace',
      replacesActionId: 'action-payments',
      target: { disposition: 'delegate_existing', candidateRef: 'candidate_login' },
    },
  );
  assert.deepEqual(
    decodeWorkHubCoordinationActInput({
      actionId: 'action-stop',
      userText: 'Stop Payments',
      proposal: {
        disposition: 'stop_work',
        expects: { targetSessionId: 'payments' },
      },
      confirmation: { kind: 'user_stop' },
    }),
    {
      actionId: 'action-stop',
      userText: 'Stop Payments',
      proposal: {
        disposition: 'stop_work',
        expects: { targetSessionId: 'payments' },
      },
      confirmation: { kind: 'user_stop' },
    },
  );
  for (const invalid of [
    {
      actionId: 'action-stop-no-confirmation',
      userText: 'Stop Payments',
      proposal: {
        disposition: 'stop_work',
        expects: { targetSessionId: 'payments' },
      },
    },
    {
      actionId: 'action-stop-wrong-confirmation',
      userText: 'Stop Payments',
      proposal: {
        disposition: 'stop_work',
        expects: { targetSessionId: 'payments' },
      },
      confirmation: { kind: 'user_correction' },
    },
    {
      actionId: 'action-stop-injected',
      userText: 'Stop Payments',
      proposal: {
        disposition: 'stop_work',
        expects: { targetSessionId: 'payments' },
        targetSessionId: 'injected',
      },
      confirmation: { kind: 'user_stop' },
    },
    // Preconditions are part of the closed proposal shape, not an optional hint.
    {
      actionId: 'action-stop-missing-preconditions',
      userText: 'Stop Payments',
      proposal: { disposition: 'stop_work', stopsActionId: 'action-payments' },
      confirmation: { kind: 'user_stop' },
    },
    // Preconditions are a closed shape: no room for a second, client-asserted proof.
    {
      actionId: 'action-stop-extra-precondition',
      userText: 'Stop Payments',
      proposal: {
        disposition: 'stop_work',
        expects: { targetSessionId: 'payments', activeActionIds: ['action-payments'] },
      },
      confirmation: { kind: 'user_stop' },
    },
  ]) {
    assert.throws(
      () => decodeWorkHubCoordinationActInput(invalid),
      (error) => error instanceof RuntimeHostProtocolError,
    );
  }
  assert.throws(
    () =>
      decodeWorkHubCoordinationActInput({
        actionId: 'action-unconfirmed-correction',
        userText: 'Use login instead',
        candidateSetId: `sha256:${'f'.repeat(64)}`,
        proposal: {
          disposition: 'replace',
          replacesActionId: 'action-payments',
          target: { disposition: 'delegate_existing', candidateRef: 'candidate_login' },
        },
      }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  assert.equal(HOST_OPERATION_SPECS['workhub.coordination.answer'].mode, 'command');
  assert.equal(HOST_OPERATION_SPECS['workhub.coordination.record'].mode, 'command');
  assert.equal(REMOTE_OWNER_OPERATION_GRANTS.includes('workhub.coordination.answer'), true);
  assert.equal(REMOTE_OWNER_OPERATION_GRANTS.includes('workhub.coordination.record'), true);
  assert.throws(
    () => decodeWorkHubCoordinationAnswerInput({ turnId: 'turn', text: 'answer', extra: true }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  assert.throws(
    () =>
      decodeWorkHubCoordinationRecordInput({
        turnId: 'turn',
        userText: 'user',
        assistantText: 'x'.repeat(8 * 1024 + 1),
      }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
});

test('WorkHub Coordination candidates are bounded and carry opaque proposal identities', () => {
  const result = decodeWorkHubCoordinationCandidatesResult({
    candidateSetId: `sha256:${'a'.repeat(64)}`,
    candidates: [
      {
        candidateRef: 'candidate_a',
        sessionId: 'session-a',
        sessionName: 'Payments',
        workspace: {
          target: { kind: 'host_path', path: '/workspace/payments' },
          hostCwd: '/workspace/payments',
        },
        state: 'active',
        updatedAt: 7,
      },
    ],
  });
  assert.equal(result.candidates[0]?.candidateRef, 'candidate_a');
  assert.equal(HOST_OPERATION_SPECS['workhub.coordination.candidates'].mode, 'query');
  assert.equal(REMOTE_OWNER_OPERATION_GRANTS.includes('workhub.coordination.candidates'), true);
  assert.throws(
    () =>
      decodeWorkHubCoordinationCandidatesResult({
        candidateSetId: 'caller-invented',
        candidates: [],
      }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
});

test('WorkHub Coordination action input is a closed disposition union', () => {
  assert.deepEqual(
    decodeWorkHubCoordinationActInput({
      actionId: 'action-answer',
      userText: 'What changed?',
      proposal: { disposition: 'answer_here' },
    }),
    {
      actionId: 'action-answer',
      userText: 'What changed?',
      proposal: { disposition: 'answer_here' },
    },
  );
  assert.deepEqual(
    decodeWorkHubCoordinationActInput({
      actionId: 'action-delegate',
      userText: 'Continue payments',
      candidateSetId: `sha256:${'b'.repeat(64)}`,
      proposal: { disposition: 'delegate_existing', candidateRef: 'candidate_payments' },
    }).proposal,
    { disposition: 'delegate_existing', candidateRef: 'candidate_payments' },
  );
  assert.deepEqual(
    decodeWorkHubCoordinationActInput({
      actionId: 'action-create',
      userText: 'Create an accessibility audit',
      proposal: { disposition: 'create_new', title: 'Accessibility audit' },
      create: {
        workspace: { kind: 'host_path', path: '/workspace' },
      },
    }).create,
    {
      workspace: { kind: 'host_path', path: '/workspace' },
    },
  );
  assert.throws(
    () =>
      decodeWorkHubCoordinationActInput({
        actionId: 'action-create-with-identity',
        userText: 'Create an accessibility audit',
        proposal: { disposition: 'create_new', title: 'Accessibility audit' },
        create: {
          sessionId: 'renderer-invented',
          workspace: { kind: 'host_path', path: '/workspace' },
        },
      }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  assert.throws(
    () =>
      decodeWorkHubCoordinationActInput({
        actionId: 'action-bypass',
        userText: 'Continue payments',
        proposal: {
          disposition: 'delegate_existing',
          candidateRef: 'candidate_payments',
          sessionId: 'invented-session',
        },
        candidateSetId: `sha256:${'c'.repeat(64)}`,
      }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  assert.throws(
    () =>
      decodeWorkHubCoordinationActInput({
        actionId: 'action-escalate',
        userText: 'Continue payments',
        proposal: { disposition: 'answer_here' },
        permissionMode: 'bypass',
        tools: ['shell'],
      }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  assert.throws(
    () =>
      decodeWorkHubCoordinationActInput({
        actionId: 'action-implicit-create',
        userText: 'Continue payments',
        proposal: { disposition: 'delegate_existing', candidateRef: 'candidate_payments' },
        candidateSetId: `sha256:${'d'.repeat(64)}`,
        create: {
          workspace: { kind: 'host_path', path: '/workspace' },
        },
      }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  assert.throws(
    () =>
      decodeWorkHubCoordinationActInput({
        actionId: 'action-replace',
        userText: 'No, use login instead',
        candidateSetId: `sha256:${'e'.repeat(64)}`,
        proposal: {
          disposition: 'delegate_existing',
          candidateRef: 'candidate_login',
          replace: {
            candidateRef: 'candidate_payments',
            expectedTurnId: 'turn-payments',
          },
        },
      }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  assert.equal(HOST_OPERATION_SPECS['workhub.coordination.act'].mode, 'command');
  assert.equal(REMOTE_OWNER_OPERATION_GRANTS.includes('workhub.coordination.act'), true);
});

test('WorkHub Coordination action results preserve the admitted disposition', () => {
  assert.deepEqual(
    decodeWorkHubCoordinationActResult({
      disposition: 'delegate_existing',
      targetSessionId: 'payments',
      targetTurnId: 'turn-payments',
      steered: true,
    }),
    {
      disposition: 'delegate_existing',
      targetSessionId: 'payments',
      targetTurnId: 'turn-payments',
      steered: true,
    },
  );
  assert.throws(
    () =>
      decodeWorkHubCoordinationActResult({
        disposition: 'delegate_existing',
        targetSessionId: 'payments',
        targetTurnId: 'turn-payments',
        permissionMode: 'bypass',
      }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  assert.deepEqual(
    decodeWorkHubCoordinationActResult({
      disposition: 'replace',
      replacementDisposition: 'delegate_existing',
      targetSessionId: 'login',
      targetTurnId: 'turn-login',
    }),
    {
      disposition: 'replace',
      replacementDisposition: 'delegate_existing',
      targetSessionId: 'login',
      targetTurnId: 'turn-login',
    },
  );
  assert.deepEqual(
    decodeWorkHubCoordinationActResult({
      disposition: 'stop_work',
      outcome: 'not_owned',
      targetSessionId: 'payments',
      targetTurnId: 'shared-turn',
    }),
    {
      disposition: 'stop_work',
      outcome: 'not_owned',
      targetSessionId: 'payments',
      targetTurnId: 'shared-turn',
    },
  );
  assert.throws(
    () =>
      decodeWorkHubCoordinationActResult({
        disposition: 'stop_work',
        outcome: 'stopped',
        targetSessionId: 'payments',
      }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  for (const invalid of [
    {
      disposition: 'stop_work',
      outcome: 'stop_delivered',
      targetSessionId: 'payments',
    },
    {
      disposition: 'stop_work',
      outcome: 'not_owned',
      targetSessionId: 'payments',
    },
    {
      disposition: 'stop_work',
      outcome: 'cancelled_pending',
      targetSessionId: 'payments',
      targetTurnId: 'unexpected-turn',
    },
  ]) {
    assert.throws(
      () => decodeWorkHubCoordinationActResult(invalid),
      (error) => error instanceof RuntimeHostProtocolError,
    );
  }
});
