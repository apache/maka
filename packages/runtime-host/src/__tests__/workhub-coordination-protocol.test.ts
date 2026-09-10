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
  decodeWorkHubCoordinationActFromTurnInput,
  decodeWorkHubCoordinationConfigureModelInput,
  decodeWorkHubCoordinationActResult,
  decodeWorkHubCoordinationAnswerInput,
  decodeWorkHubCoordinationCandidatesResult,
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

test('WorkHub model configuration only accepts a revision and explicit model identity', () => {
  const input = {
    expectedRevision: 3,
    modelTarget: {
      kind: 'explicit',
      connectionId: 'connection-1',
      connectionSlug: 'test',
      model: 'model-1',
    },
  };
  assert.deepEqual(decodeWorkHubCoordinationConfigureModelInput(input), input);
  for (const invalid of [
    { ...input, sessionId: 'another-session' },
    { ...input, permissionMode: 'bypass' },
    { ...input, expectedRevision: -1 },
    { ...input, modelTarget: { kind: 'default' } },
  ])
    assert.throws(
      () => decodeWorkHubCoordinationConfigureModelInput(invalid),
      RuntimeHostProtocolError,
    );
});

test('WorkHub model actions cannot supply user authority or attachment locators', () => {
  const input = {
    turnId: 'active-model-turn',
    actionId: 'tool-call-1',
    proposal: { disposition: 'create_new', title: 'Login audit' },
    delegationText: 'Inspect the login retries',
    create: { workspace: { kind: 'project', projectId: 'maka' } },
    newWorkDefaults: { permissionMode: 'ask' },
  };
  assert.deepEqual(decodeWorkHubCoordinationActFromTurnInput(input), input);
  for (const extra of [
    { userText: 'Create a new Session' },
    { confirmation: { kind: 'user_stop' } },
    { attachments: [] },
  ]) {
    assert.throws(
      () => decodeWorkHubCoordinationActFromTurnInput({ ...input, ...extra }),
      RuntimeHostProtocolError,
    );
  }
  assert.throws(
    () =>
      decodeWorkHubCoordinationActFromTurnInput({
        turnId: 'active-model-turn',
        actionId: 'tool-call-2',
        proposal: { disposition: 'answer_here' },
      }),
    RuntimeHostProtocolError,
  );
  assert.equal(HOST_OPERATION_SPECS['workhub.coordination.actFromTurn'].mode, 'command');
  assert.equal(REMOTE_OWNER_OPERATION_GRANTS.includes('workhub.coordination.actFromTurn'), true);
});

test('delegation content is optional, bounded, and unavailable to stop or resume', () => {
  const input = {
    actionId: 'delegate-content',
    turnId: 'active-turn',
    delegationText: 'Fix the payment retry state',
    candidateSetId: `sha256:${'a'.repeat(64)}`,
    proposal: { disposition: 'delegate_existing', candidateRef: 'candidate-payments' },
  };
  assert.deepEqual(decodeWorkHubCoordinationActFromTurnInput(input), input);
  for (const delegationText of ['', ' ', 'x'.repeat(48 * 1024 + 1), 7]) {
    assert.throws(
      () => decodeWorkHubCoordinationActFromTurnInput({ ...input, delegationText }),
      RuntimeHostProtocolError,
    );
  }
  assert.throws(
    () =>
      decodeWorkHubCoordinationActFromTurnInput({
        actionId: 'stop-content',
        turnId: 'active-turn',
        delegationText: 'Unrelated work',
        proposal: { disposition: 'stop_work', expects: { targetSessionId: 'payments' } },
      }),
    RuntimeHostProtocolError,
  );
});

test('WorkHub Coordination candidates are bounded and carry opaque proposal identities', () => {
  assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 110);
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
        latestDelegationActionId: 'action-a',
      },
    ],
  });
  assert.equal(result.candidates[0]?.candidateRef, 'candidate_a');
  assert.equal(result.candidates[0]?.latestDelegationActionId, 'action-a');
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

test('model actions retain closed task inputs and bounded answer content', () => {
  const candidateSetId = 'sha256:' + 'a'.repeat(64);
  const base = { turnId: 'active-turn', actionId: 'action' };
  const workspace = { kind: 'host_path', path: '/workspace' };
  for (const fields of [
    { proposal: { disposition: 'delegate_existing', candidateRef: 'candidate' }, candidateSetId },
    {
      proposal: { disposition: 'create_new', title: 'Audit' },
      create: { workspace },
      newWorkDefaults: { permissionMode: 'ask' },
    },
    {
      proposal: {
        disposition: 'replace',
        replacesActionId: 'source',
        target: { disposition: 'delegate_existing', candidateRef: 'candidate' },
      },
      candidateSetId,
    },
    { proposal: { disposition: 'stop_work', expects: { targetSessionId: 'target' } } },
    {
      proposal: {
        disposition: 'resume_work',
        resumesActionId: 'source',
        expects: { targetSessionId: 'target' },
      },
    },
  ])
    assert.deepEqual(decodeWorkHubCoordinationActFromTurnInput({ ...base, ...fields }), {
      ...base,
      ...fields,
    });
  for (const fields of [
    { proposal: { disposition: 'create_new', title: 'Audit' } },
    { proposal: { disposition: 'delegate_existing', candidateRef: 'candidate' } },
    {
      proposal: { disposition: 'create_new', title: 'Audit' },
      create: { workspace },
      newWorkDefaults: { permissionMode: 'invented' },
    },
    {
      proposal: {
        disposition: 'stop_work',
        expects: { targetSessionId: 'target', activeActionIds: ['forged'] },
      },
    },
    {
      proposal: {
        disposition: 'resume_work',
        resumesActionId: 'source',
        expects: { targetSessionId: 'target' },
      },
      create: { workspace },
    },
  ])
    assert.throws(() => decodeWorkHubCoordinationActFromTurnInput({ ...base, ...fields }));
  const attachments = [
    {
      name: 'brief.txt',
      kind: 'other',
      mimeType: 'text/plain',
      bytes: 4,
      ref: { kind: 'session_file', sessionId: 'maka_workhub_coordination', relativePath: 'brief' },
    },
  ];
  const answer = { turnId: 'answer', text: 'Review file', attachments };
  assert.deepEqual(decodeWorkHubCoordinationAnswerInput(answer), answer);
  for (const invalid of [
    { ...answer, extra: true },
    { ...answer, text: 'x'.repeat(48 * 1024 + 1) },
    { ...answer, attachments: Array(9).fill(attachments[0]) },
  ])
    assert.throws(() => decodeWorkHubCoordinationAnswerInput(invalid));
});

test('action outcomes cannot invent a target Turn or revive removed local dispositions', () => {
  for (const result of [
    {
      disposition: 'delegate_existing',
      targetSessionId: 'target',
      targetTurnId: 'turn',
      steered: true,
    },
    { disposition: 'create_new', targetSessionId: 'target', targetTurnId: 'turn' },
    {
      disposition: 'replace',
      replacementDisposition: 'create_new',
      targetSessionId: 'target',
      targetTurnId: 'turn',
    },
    { disposition: 'stop_work', outcome: 'cancelled_pending', targetSessionId: 'target' },
    {
      disposition: 'stop_work',
      outcome: 'not_owned',
      targetSessionId: 'target',
      targetTurnId: 'user-turn',
    },
    {
      disposition: 'resume_work',
      outcome: 'resume_started',
      targetSessionId: 'target',
      targetTurnId: 'turn',
    },
    { disposition: 'resume_work', outcome: 'already_running', targetSessionId: 'target' },
  ])
    assert.deepEqual(decodeWorkHubCoordinationActResult(result), result);
  for (const result of [
    { disposition: 'answer_here', coordinationTurnId: 'turn' },
    { disposition: 'clarify', coordinationTurnId: 'turn' },
    {
      disposition: 'stop_work',
      outcome: 'cancelled_pending',
      targetSessionId: 'target',
      targetTurnId: 'forged',
    },
    { disposition: 'stop_work', outcome: 'not_owned', targetSessionId: 'target' },
    {
      disposition: 'resume_work',
      outcome: 'already_running',
      targetSessionId: 'target',
      targetTurnId: 'forged',
    },
    { disposition: 'resume_work', outcome: 'resume_started', targetSessionId: 'target' },
  ])
    assert.throws(() => decodeWorkHubCoordinationActResult(result));
});
