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
import { decodeCanonicalMessage } from '../session.js';

const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

describe('WorkHub Coordination stored records', () => {
  test('decodes one exact atomic delegation assignment', () => {
    const assigned = {
      type: 'workhub_coordination',
      id: 'assignment-id',
      turnId: 'coordination-turn',
      ts: 1,
      schemaVersion: 1,
      kind: 'delegation_assigned',
      actionId: 'action-id',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'coordination-turn',
      targetSessionId: 'payments',
      disposition: 'delegate_existing',
      userText: 'Continue payment work',
      delegationId: 'delegation-id',
      targetTurnId: 'target-turn',
      targetMessageId: 'target-message',
      targetSessionName: 'Payments',
      steered: true,
    } as const;

    assert.deepEqual(decodeCanonicalMessage(assigned), assigned);
  });

  test('rejects malformed or widened coordination records', () => {
    const base = {
      type: 'workhub_coordination',
      id: 'assignment-id',
      turnId: 'coordination-turn',
      ts: 1,
      schemaVersion: 1,
      kind: 'delegation_assigned',
      actionId: 'action-id',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'coordination-turn',
      targetSessionId: 'payments',
      disposition: 'delegate_existing',
      userText: 'Continue payment work',
      delegationId: 'delegation-id',
      targetTurnId: 'target-turn',
      targetMessageId: 'target-message',
      targetSessionName: 'Payments',
    } as const;

    for (const invalid of [
      { ...base, coordinationTurnId: 'different-turn' },
      { ...base, actionFingerprint: 'not-a-digest' },
      { ...base, disposition: 'replace' },
      { ...base, targetMessageId: undefined },
      { ...base, sourceSessionId: 'injected' },
      { ...base, kind: 'delegation_intent' },
      { ...base, schemaVersion: 2 },
    ]) {
      assert.throws(() => decodeCanonicalMessage(invalid), /Invalid stored message schema/u);
    }
  });

  test('requires a complete create payload only for create_new assignments', () => {
    const create = {
      type: 'workhub_coordination',
      id: 'create-assignment-id',
      turnId: 'coordination-turn',
      ts: 1,
      schemaVersion: 1,
      kind: 'delegation_assigned',
      actionId: 'action-id',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'coordination-turn',
      targetSessionId: 'created-session',
      disposition: 'create_new',
      userText: 'Create a login audit',
      create: {
        title: 'Login audit',
        workspace: { kind: 'project', projectId: 'project-maka' },
      },
      delegationId: 'delegation-id',
      targetTurnId: 'target-turn',
      targetMessageId: 'target-message',
      targetSessionName: 'Login audit',
    } as const;

    assert.deepEqual(decodeCanonicalMessage(create), create);
    assert.throws(
      () => decodeCanonicalMessage({ ...create, create: undefined }),
      /Invalid stored message schema/u,
    );
    assert.throws(
      () => decodeCanonicalMessage({ ...create, disposition: 'delegate_existing' }),
      /Invalid stored message schema/u,
    );
  });

  test('decodes the durable replacement intent and linked supersession proof', () => {
    const replacement = {
      type: 'workhub_coordination',
      id: 'replacement-intent-id',
      turnId: 'replacement-action',
      ts: 2,
      schemaVersion: 2,
      kind: 'delegation_replacement_requested',
      actionId: 'replacement-action',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'replacement-action',
      targetSessionId: 'login',
      targetSessionName: 'Login',
      disposition: 'delegate_existing',
      userText: 'No, use login instead',
      replacesActionId: 'original-action',
      replacesDelegationId: 'original-delegation',
      replacedTargetSessionId: 'payments',
      replacedTargetMessageId: 'payments-message',
    } as const;
    const assigned = {
      type: 'workhub_coordination',
      id: 'replacement-assignment-id',
      turnId: 'replacement-action',
      ts: 3,
      schemaVersion: 2,
      kind: 'delegation_assigned',
      actionId: 'replacement-action',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'replacement-action',
      targetSessionId: 'login',
      targetSessionName: 'Login',
      disposition: 'delegate_existing',
      userText: 'No, use login instead',
      delegationId: 'replacement-delegation',
      targetTurnId: 'login-turn',
      targetMessageId: 'login-message',
      replacesActionId: 'original-action',
      replacesDelegationId: 'original-delegation',
    } as const;
    const superseded = {
      type: 'workhub_coordination',
      id: 'supersession-id',
      turnId: 'replacement-action',
      ts: 3,
      schemaVersion: 2,
      kind: 'delegation_superseded',
      actionId: 'replacement-action',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'replacement-action',
      supersededActionId: 'original-action',
      supersededDelegationId: 'original-delegation',
      replacementDelegationId: 'replacement-delegation',
    } as const;
    const aborted = {
      type: 'workhub_coordination',
      id: 'replacement-aborted-id',
      turnId: 'replacement-action',
      ts: 3,
      schemaVersion: 2,
      kind: 'delegation_replacement_aborted',
      actionId: 'replacement-action',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'replacement-action',
      abortedActionId: 'original-action',
      abortedDelegationId: 'original-delegation',
      targetSessionId: 'login',
      reason: 'target_unavailable',
    } as const;

    assert.deepEqual(decodeCanonicalMessage(replacement), replacement);
    assert.deepEqual(decodeCanonicalMessage(assigned), assigned);
    assert.deepEqual(decodeCanonicalMessage(superseded), superseded);
    assert.deepEqual(decodeCanonicalMessage(aborted), aborted);
    assert.throws(
      () => decodeCanonicalMessage({ ...superseded, replacementDelegationId: '' }),
      /Invalid stored message schema/u,
    );
    assert.throws(
      () => decodeCanonicalMessage({ ...aborted, reason: 'retry_later' }),
      /Invalid stored message schema/u,
    );
  });

  test('decodes exact direct-stop request and observed resolution records', () => {
    const requested = {
      type: 'workhub_coordination',
      id: 'stop-request-id',
      turnId: 'stop-action',
      ts: 4,
      schemaVersion: 3,
      kind: 'delegation_stop_requested',
      actionId: 'stop-action',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'stop-action',
      stopsActionId: 'original-action',
      stopsDelegationId: 'original-delegation',
      targetSessionId: 'payments',
      targetMessageId: 'payments-message',
      targetSessionName: 'Payments',
      userText: 'Stop Payments',
    } as const;
    const resolved = {
      type: 'workhub_coordination',
      id: 'stop-resolution-id',
      turnId: 'stop-action',
      ts: 5,
      schemaVersion: 3,
      kind: 'delegation_stop_resolved',
      actionId: 'stop-action',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'stop-action',
      stopsActionId: 'original-action',
      stopsDelegationId: 'original-delegation',
      targetSessionId: 'payments',
      targetTurnId: 'payments-turn',
      outcome: 'stop_delivered',
    } as const;

    assert.deepEqual(decodeCanonicalMessage(requested), requested);
    assert.deepEqual(decodeCanonicalMessage(resolved), resolved);
    for (const invalid of [
      { ...requested, candidateRef: 'injected' },
      { ...requested, schemaVersion: 2 },
      { ...resolved, outcome: 'stopped' },
      { ...resolved, runId: 'injected' },
      { ...resolved, targetTurnId: '' },
      { ...resolved, targetTurnId: undefined },
      { ...resolved, outcome: 'cancelled_pending' },
    ]) {
      assert.throws(() => decodeCanonicalMessage(invalid), /Invalid stored message schema/u);
    }
    assert.deepEqual(
      decodeCanonicalMessage({
        ...resolved,
        outcome: 'cancelled_pending',
        targetTurnId: undefined,
      }),
      {
        ...resolved,
        outcome: 'cancelled_pending',
        targetTurnId: undefined,
      },
    );
  });
});
