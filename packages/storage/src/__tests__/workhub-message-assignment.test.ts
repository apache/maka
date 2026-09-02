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
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { messageContentDigest, normalizeMessageContent } from '@maka/core/events';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
  type WorkHubDelegationAssignedMessage,
  type WorkHubDelegationReplacementAbortedMessage,
  type WorkHubDelegationSupersededMessage,
} from '@maka/core/session';
import { createSessionStore, isSessionNotFoundError } from '../session-store.js';

test('atomically commits one WorkHub assignment and target admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-assignment-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const request = assignmentRequest('action-one', target.id, 'Payments', 'target-turn');
    const first = await store.assignWorkHubMessage(request);
    const replay = await store.assignWorkHubMessage({
      ...request,
      assignment: {
        ...request.assignment,
        ts: request.assignment.ts + 10,
        targetTurnId: 'recomputed-turn',
        targetSessionName: 'Recomputed name',
      },
      admission: {
        ...request.admission,
        turnId: 'recomputed-turn',
        runId: 'recomputed-run',
      },
    });

    assert.equal(first.kind, 'assigned');
    assert.equal(replay.kind, 'existing');
    assert.equal(replay.assignment.targetTurnId, 'target-turn');
    assert.deepEqual(
      await store.readMessageAdmission(target.id, request.admission.messageId),
      request.admission,
    );
    assert.deepEqual(
      (await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID)).filter(
        (message) => message.type === 'workhub_coordination',
      ),
      [request.assignment],
    );
    const coordination = await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
    assert.equal(coordination.lastMessageAt, request.assignment.ts);
    await store.markMessagesHandedOff({
      sessionId: target.id,
      messageIds: [request.admission.messageId],
      turnId: request.admission.turnId,
    });
    const replayAfterConsumption = await store.assignWorkHubMessage(request);
    assert.equal(replayAfterConsumption.kind, 'existing');
    assert.deepEqual(replayAfterConsumption.assignment, request.assignment);
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('rolls create_new Session back when assignment validation fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-create-assignment-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const request = assignmentRequest(
      'create-action',
      'created-target',
      'Wrong name',
      'target-turn',
    );
    await assert.rejects(
      store.assignWorkHubMessage({
        ...request,
        assignment: {
          ...request.assignment,
          disposition: 'create_new',
          create: {
            title: 'Actual name',
            workspace: { kind: 'host_path', path: root },
          },
        },
        create: {
          sessionId: 'created-target',
          requestFingerprint: `sha256:${'b'.repeat(64)}`,
          input: {
            cwd: root,
            name: 'Actual name',
            llmConnectionSlug: 'test',
            model: 'test',
            permissionMode: 'ask',
          },
        },
      }),
      /display identity changed/u,
    );
    await assert.rejects(store.readHeaderSnapshot('created-target'), (error) =>
      isSessionNotFoundError(error),
    );
    assert.deepEqual(await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID), []);
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a stale display identity for a new delegation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-stale-assignment-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const request = assignmentRequest('stale-action', target.id, 'Old name', 'target-turn');

    await assert.rejects(store.assignWorkHubMessage(request), /display identity changed/u);
    assert.equal(await store.readWorkHubAssignment(request.assignment.actionId), undefined);
    assert.equal(
      await store.readMessageAdmission(target.id, request.assignment.targetMessageId),
      undefined,
    );
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('atomically commits a replacement assignment with the old-link supersession', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-replacement-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const source = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const destination = await store.create({
      cwd: root,
      name: 'Login before rename',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const original = assignmentRequest('original-action', source.id, 'Payments', 'source-turn');
    await store.assignWorkHubMessage(original);

    const base = assignmentRequest(
      'replacement-action',
      destination.id,
      'Login before rename',
      'destination-turn',
    );
    const assignment: WorkHubDelegationAssignedMessage = {
      ...base.assignment,
      schemaVersion: 2,
      replacesActionId: original.assignment.actionId,
      replacesDelegationId: original.assignment.delegationId,
    };
    const supersession: WorkHubDelegationSupersededMessage = {
      type: 'workhub_coordination',
      id: `whx_${createHash('sha256')
        .update(original.assignment.delegationId)
        .digest('hex')
        .slice(0, 48)}`,
      turnId: assignment.actionId,
      ts: assignment.ts,
      schemaVersion: 2,
      kind: 'delegation_superseded',
      actionId: assignment.actionId,
      actionFingerprint: assignment.actionFingerprint,
      coordinationTurnId: assignment.coordinationTurnId,
      supersededActionId: original.assignment.actionId,
      supersededDelegationId: original.assignment.delegationId,
      replacementDelegationId: assignment.delegationId,
    };
    await store.rename(destination.id, 'Login');

    const committed = await store.assignWorkHubMessage({
      ...base,
      assignment,
      supersession,
    });
    const committedAssignment = { ...assignment, targetSessionName: 'Login' };

    assert.equal(committed.kind, 'assigned');
    assert.deepEqual(committed.assignment, committedAssignment);
    assert.deepEqual(
      await store.readWorkHubSupersession(original.assignment.delegationId),
      supersession,
    );
    assert.deepEqual(await store.readWorkHubAssignment(assignment.actionId), committedAssignment);
    assert.deepEqual(
      await store.readMessageAdmission(destination.id, assignment.targetMessageId),
      base.admission,
    );
    assert.deepEqual(
      (await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID))
        .filter((message) => message.type === 'workhub_coordination')
        .map((message) => message.kind),
      ['delegation_assigned', 'delegation_assigned', 'delegation_superseded'],
    );
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('an aborted replacement cannot later commit a supersession', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-aborted-replacement-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const source = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const destination = await store.create({
      cwd: root,
      name: 'Login',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const original = assignmentRequest('original-aborted', source.id, 'Payments', 'source-turn');
    await store.assignWorkHubMessage(original);
    const base = assignmentRequest(
      'replacement-after-abort',
      destination.id,
      'Login',
      'destination-turn',
    );
    const assignment: WorkHubDelegationAssignedMessage = {
      ...base.assignment,
      schemaVersion: 2,
      replacesActionId: original.assignment.actionId,
      replacesDelegationId: original.assignment.delegationId,
    };
    const supersession: WorkHubDelegationSupersededMessage = {
      type: 'workhub_coordination',
      id: `whx_${createHash('sha256')
        .update(original.assignment.delegationId)
        .digest('hex')
        .slice(0, 48)}`,
      turnId: assignment.actionId,
      ts: assignment.ts,
      schemaVersion: 2,
      kind: 'delegation_superseded',
      actionId: assignment.actionId,
      actionFingerprint: assignment.actionFingerprint,
      coordinationTurnId: assignment.coordinationTurnId,
      supersededActionId: original.assignment.actionId,
      supersededDelegationId: original.assignment.delegationId,
      replacementDelegationId: assignment.delegationId,
    };
    const abort: WorkHubDelegationReplacementAbortedMessage = {
      type: 'workhub_coordination',
      id: `whb_${createHash('sha256')
        .update(original.assignment.delegationId)
        .digest('hex')
        .slice(0, 48)}`,
      turnId: assignment.actionId,
      ts: assignment.ts - 1,
      schemaVersion: 2,
      kind: 'delegation_replacement_aborted',
      actionId: assignment.actionId,
      actionFingerprint: assignment.actionFingerprint,
      coordinationTurnId: assignment.coordinationTurnId,
      abortedActionId: original.assignment.actionId,
      abortedDelegationId: original.assignment.delegationId,
      targetSessionId: destination.id,
      reason: 'target_unavailable',
    };
    await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [abort]);

    await assert.rejects(
      store.assignWorkHubMessage({ ...base, assignment, supersession }),
      /replacement is aborted/u,
    );
    assert.equal(await store.readWorkHubAssignment(assignment.actionId), undefined);
    assert.equal(await store.readWorkHubSupersession(original.assignment.delegationId), undefined);
    assert.equal(
      await store.readMessageAdmission(destination.id, assignment.targetMessageId),
      undefined,
    );
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

async function createCoordinationSession(
  store: ReturnType<typeof createSessionStore>,
  root: string,
): Promise<void> {
  await store.createStableSession({
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    requestFingerprint: `sha256:${'a'.repeat(64)}`,
    input: {
      cwd: root,
      name: 'WorkHub',
      role: WORKHUB_COORDINATION_SESSION_ROLE,
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'explore',
      toolProfile: 'workhub-coordination-v1',
    },
  });
}

function assignmentRequest(
  actionId: string,
  targetSessionId: string,
  targetSessionName: string,
  targetTurnId: string,
) {
  const suffix = createHash('sha256').update(actionId, 'utf8').digest('hex').slice(0, 48);
  const content = normalizeMessageContent({ text: 'Continue payment work' });
  const assignment: WorkHubDelegationAssignedMessage = {
    type: 'workhub_coordination',
    id: `wha_${suffix}`,
    turnId: actionId,
    ts: 10,
    schemaVersion: 1,
    kind: 'delegation_assigned',
    actionId,
    actionFingerprint: `sha256:${'c'.repeat(64)}`,
    coordinationTurnId: actionId,
    targetSessionId,
    targetSessionName,
    targetTurnId,
    targetMessageId: `whm_${suffix}`,
    delegationId: `whd_${suffix}`,
    disposition: 'delegate_existing',
    userText: content.text,
  };
  return {
    assignment,
    admission: {
      sessionId: targetSessionId,
      turnId: targetTurnId,
      runId: `whr_${suffix}`,
      messageId: assignment.targetMessageId,
      content,
      submittedContentDigest: messageContentDigest(content),
      submittedPlacement: 'current_turn' as const,
      placement: 'current_turn' as const,
      disposition: 'steering' as const,
      skillInvocation: { loaded: [], failed: [], receipts: [] },
      admittedAt: 10,
    },
  };
}
