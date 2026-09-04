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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  aggregateMessageContents,
  messageContentDigest,
  type MessageContent,
} from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SkillInvocationResult } from '@maka/core/skill-invocation';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
} from '@maka/core/session';
import { RuntimeMessageAuthorityInvariantError } from '@maka/runtime/message-authority';
import type {
  MarkMessagesHandedOffInput,
  MessageAdmissionStore,
  PendingMessageAdmission,
  RootTurnSourceMessage,
  RootTurnSourceMessageReceipt,
} from '@maka/storage/execution-stores';
import { rootTurnAdmissionRecordFits } from '@maka/storage/execution-stores';
import { createSessionStore } from '@maka/storage/session-store';
import {
  MESSAGE_OPERATION_RESULT_MAX_BYTES,
  MESSAGE_QUEUE_MAX_ENTRIES,
  MESSAGE_QUEUE_PROJECTION_MAX_BYTES,
  decodeSessionMessageQueueProjection,
  type SessionMessageQueueProjection,
  type TurnSnapshot,
} from '../protocol/index.js';
import {
  HostMessageCoordinator,
  type HostMessageCoordinatorOptions,
  type HostMessageRootPort,
  type HostMessageRecoveryBatch,
  type HostMessageRootState,
} from '../server/message-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const ROOT = { sessionId: 'session-1', turnId: 'turn-1', runId: 'run-1' } as const;
const EMPTY_SKILL_INVOCATION = { loaded: [], failed: [], receipts: [] } as const;

test('consumes an active-target admission before the terminal transition can make it idle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-active-consume-'));
  const store = createSessionStore(root);
  t.after(async () => {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  });
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
  await store.createStableSession({
    sessionId: ROOT.sessionId,
    requestFingerprint: `sha256:${'b'.repeat(64)}`,
    input: {
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    },
  });
  const fixture = createFixture(undefined, () => true, store);
  fixture.coordinator.reserveRootTurn(ROOT);
  fixture.coordinator.bindRun(ROOT);
  const content = { text: 'atomic WorkHub assignment' };
  const actionId = 'action-active-target';
  const suffix = createHash('sha256').update(actionId, 'utf8').digest('hex').slice(0, 48);
  const messageId = `whm_${suffix}`;
  await store.assignWorkHubMessage({
    assignment: {
      type: 'workhub_coordination',
      id: `wha_${suffix}`,
      turnId: actionId,
      ts: 10,
      schemaVersion: 1,
      kind: 'delegation_assigned',
      actionId,
      actionFingerprint: `sha256:${'c'.repeat(64)}`,
      coordinationTurnId: actionId,
      targetSessionId: ROOT.sessionId,
      targetSessionName: 'Payments',
      targetTurnId: ROOT.turnId,
      targetMessageId: messageId,
      delegationId: `whd_${suffix}`,
      disposition: 'delegate_existing',
      userText: content.text,
      steered: true,
    },
    admission: {
      ...ROOT,
      messageId,
      content,
      submittedContentDigest: messageContentDigest(content),
      submittedPlacement: 'current_turn',
      placement: 'current_turn',
      disposition: 'steering',
      skillInvocation: EMPTY_SKILL_INVOCATION,
      admittedAt: 10,
    },
  });

  const admitted = deferred<void>();
  const releaseAdmission = deferred<void>();
  const consume = fixture.sessionAdmission.run(ROOT.sessionId, async (lease) => {
    admitted.resolve(undefined);
    await releaseAdmission.promise;
    await fixture.coordinator.consumePendingAdmissionsAdmitted(ROOT.sessionId, lease);
  });
  await admitted.promise;
  const terminal = fixture.sessionAdmission.run(ROOT.sessionId, () => {
    fixture.setRootState({ kind: 'idle' });
  });
  releaseAdmission.resolve(undefined);
  await consume;
  await terminal;

  assert.equal(fixture.coordinator.projection(ROOT.sessionId).steering.length, 1);
  assert.equal(fixture.recoveredBatches.length, 0);
  assert.equal(fixture.drainRequests(), 0);
});

test('idle recovery starts one real preassigned WorkHub root and restores the remainder', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-idle-recovery-'));
  const store = createSessionStore(root);
  t.after(async () => {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  });
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
  await store.createStableSession({
    sessionId: ROOT.sessionId,
    requestFingerprint: `sha256:${'b'.repeat(64)}`,
    input: {
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    },
  });
  const fixture = createFixture(undefined, () => true, store);
  fixture.setRootState({ kind: 'idle' });
  const messageIds: string[] = [];
  for (const actionId of ['preassigned-action-a', 'preassigned-action-b']) {
    const suffix = createHash('sha256').update(actionId, 'utf8').digest('hex').slice(0, 48);
    const messageId = `whm_${suffix}`;
    const turnId = `wht_${suffix}`;
    const runId = `whr_${suffix}`;
    messageIds.push(messageId);
    const content = { text: `recover ${messageId}` };
    await store.assignWorkHubMessage({
      assignment: {
        type: 'workhub_coordination',
        id: `wha_${suffix}`,
        turnId: actionId,
        ts: 10,
        schemaVersion: 1,
        kind: 'delegation_assigned',
        actionId,
        actionFingerprint: `sha256:${suffix.padEnd(64, '0')}`,
        coordinationTurnId: actionId,
        targetSessionId: ROOT.sessionId,
        targetSessionName: 'Payments',
        targetTurnId: turnId,
        targetMessageId: messageId,
        delegationId: `whd_${suffix}`,
        disposition: 'delegate_existing',
        userText: content.text,
      },
      admission: {
        sessionId: ROOT.sessionId,
        turnId,
        runId,
        messageId,
        content,
        submittedContentDigest: messageContentDigest(content),
        submittedPlacement: 'current_turn',
        placement: 'current_turn',
        disposition: 'steering',
        skillInvocation: EMPTY_SKILL_INVOCATION,
        admittedAt: 10,
      },
    });
  }

  await fixture.coordinator.consumePendingAdmissions([ROOT.sessionId]);
  assert.deepEqual(
    fixture.recoveredBatches.map((batch) => batch.sources.map((s) => s.messageId)),
    [[messageIds[0]]],
  );
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).steering.map((entry) => entry.messageId),
    [messageIds[1]],
  );
  const resolved = await fixture.coordinator.handlers['turn.message.execution.query'](
    {
      sessionId: ROOT.sessionId,
      messageIds,
    },
    operationContext(),
  );

  assert.deepEqual(resolved, {
    ok: true,
    result: {
      resolutions: [
        {
          messageId: messageIds[0],
          state: 'owned',
          turnId: 'recovered-turn',
          runId: 'durable-run',
        },
        {
          messageId: messageIds[1],
          state: 'pending',
        },
      ],
    },
  });
});

test('idle recovery keeps promoted steering ahead of distinct real WorkHub roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-promoted-recovery-'));
  const store = createSessionStore(root);
  t.after(async () => {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  });
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
  await store.createStableSession({
    sessionId: ROOT.sessionId,
    requestFingerprint: `sha256:${'b'.repeat(64)}`,
    input: {
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    },
  });
  const fixture = createFixture(undefined, () => true, store);
  fixture.setRootState({ kind: 'idle' });
  const promotedContent = { text: 'promoted correction' };
  await fixture.admissions.commitMessageAdmission({
    sessionId: ROOT.sessionId,
    turnId: 'earlier-turn',
    runId: 'earlier-run',
    messageId: 'promoted-message',
    content: promotedContent,
    submittedContentDigest: messageContentDigest(promotedContent),
    submittedPlacement: 'next_turn',
    placement: 'current_turn',
    disposition: 'steering',
    skillInvocation: EMPTY_SKILL_INVOCATION,
    admittedAt: 9,
  });
  const workHubMessageIds: string[] = [];
  for (const actionId of ['later-action-a', 'later-action-b']) {
    const suffix = createHash('sha256').update(actionId, 'utf8').digest('hex').slice(0, 48);
    const messageId = `whm_${suffix}`;
    const content = { text: `recover ${messageId}` };
    workHubMessageIds.push(messageId);
    await store.assignWorkHubMessage({
      assignment: {
        type: 'workhub_coordination',
        id: `wha_${suffix}`,
        turnId: actionId,
        ts: 10,
        schemaVersion: 1,
        kind: 'delegation_assigned',
        actionId,
        actionFingerprint: `sha256:${suffix.padEnd(64, '0')}`,
        coordinationTurnId: actionId,
        targetSessionId: ROOT.sessionId,
        targetSessionName: 'Payments',
        targetTurnId: `wht_${suffix}`,
        targetMessageId: messageId,
        delegationId: `whd_${suffix}`,
        disposition: 'delegate_existing',
        userText: content.text,
      },
      admission: {
        sessionId: ROOT.sessionId,
        turnId: `wht_${suffix}`,
        runId: `whr_${suffix}`,
        messageId,
        content,
        submittedContentDigest: messageContentDigest(content),
        submittedPlacement: 'current_turn',
        placement: 'current_turn',
        disposition: 'steering',
        skillInvocation: EMPTY_SKILL_INVOCATION,
        admittedAt: 10,
      },
    });
  }

  await fixture.coordinator.consumePendingAdmissions([ROOT.sessionId]);

  assert.deepEqual(
    fixture.recoveredBatches.map((batch) => batch.sources.map((s) => s.messageId)),
    [['promoted-message']],
  );
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).steering.map((entry) => entry.messageId),
    workHubMessageIds,
  );
});

test('idle recovery preserves the exact root identity of durable steering', async () => {
  const fixture = createFixture();
  fixture.setRootState({ kind: 'idle' });
  const content = { text: 'recover exact steering' };
  await fixture.admissions.commitMessageAdmission({
    ...ROOT,
    messageId: 'workhub-message',
    content,
    submittedContentDigest: messageContentDigest(content),
    submittedPlacement: 'current_turn',
    placement: 'current_turn',
    disposition: 'steering',
    skillInvocation: EMPTY_SKILL_INVOCATION,
    admittedAt: 10,
  });

  await fixture.coordinator.consumePendingAdmissions([ROOT.sessionId]);

  assert.deepEqual(fixture.recoveredBatches[0]?.rootIdentity, {
    turnId: ROOT.turnId,
    runId: ROOT.runId,
  });
});

test('idle submit starts exactly one root Turn and retry identity is connection-independent', async () => {
  const fixture = createFixture();
  fixture.setRootState({ kind: 'idle' });
  const input = {
    originHostEpoch: 'epoch-1',
    sessionId: ROOT.sessionId,
    messageId: 'idle-message',
    content: { text: 'start from idle' },
    placement: 'next_turn',
  } as const;

  const first = await fixture.coordinator.handlers['turn.message.submit'](
    input,
    operationContext('connection-before-disconnect'),
  );
  const retry = await fixture.coordinator.handlers['turn.message.submit'](
    input,
    operationContext('connection-after-disconnect'),
  );

  assert.deepEqual(first, {
    ok: true,
    result: {
      disposition: 'turn_started',
      turnId: 'idle-turn',
      skillInvocation: EMPTY_SKILL_INVOCATION,
    },
  });
  assert.deepEqual(retry, first);
  assert.equal(fixture.startCalls(), 1);
  assert.equal(fixture.liveResidencies(), 0);
});

test('a retry that changes exact-Turn intent is a conflict, not the earlier success', async () => {
  const fixture = createFixture();
  fixture.setRootState({ kind: 'idle' });
  const submitted = (mode: 'graph' | 'swarm') =>
    ({
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      messageId: 'exact-message',
      content: { text: 'run this exactly' },
      placement: 'current_turn',
      turnOrchestration: { mode, source: 'slash_command' },
    }) as const;

  const first = await fixture.coordinator.handlers['turn.message.submit'](
    submitted('graph'),
    operationContext(),
  );
  assert.equal(first.ok, true);

  // Same Message identity, same text, same placement — but a different
  // execution mode. Answering the earlier success here would run one exact
  // request and report it as another.
  const changed = await fixture.coordinator.handlers['turn.message.submit'](
    submitted('swarm'),
    operationContext(),
  );
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.error.code, 'operation_conflict');

  const unchanged = await fixture.coordinator.handlers['turn.message.submit'](
    submitted('graph'),
    operationContext(),
  );
  assert.deepEqual(unchanged, first);
  assert.equal(fixture.startCalls(), 1);
});

test('message query reports only durable cancellation proof', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  await submit(fixture, 'cancelled-message', 'discard me', 'next_turn');
  await submit(fixture, 'accepted-message', 'waiting', 'next_turn');
  await fixture.coordinator.cancelMessages(ROOT.sessionId, ['cancelled-message']);
  const result = await fixture.coordinator.handlers['turn.message.query'](
    {
      sessionId: ROOT.sessionId,
      messageIds: ['cancelled-message', 'accepted-message', 'unknown-message'],
    },
    operationContext(),
  );

  assert.deepEqual(result, {
    ok: true,
    result: { cancelledMessageIds: ['cancelled-message'] },
  });
});

test('exact pending cancellation removes only the linked Message', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  await submit(fixture, 'linked-message', 'wrong delegation', 'next_turn');
  await submit(fixture, 'unrelated-message', 'keep this queued', 'next_turn');

  assert.deepEqual(
    await fixture.coordinator.cancelMessageIfPending(
      ROOT.sessionId,
      'linked-message',
      'first-claim',
    ),
    { kind: 'cancelled_pending' },
  );
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).followup.map((entry) => entry.messageId),
    ['unrelated-message'],
  );
  assert.deepEqual(
    await fixture.coordinator.cancelMessageIfPending(
      ROOT.sessionId,
      'linked-message',
      'second-claim',
    ),
    { kind: 'cancelled' },
  );
});

test('a durable cancellation claim preserves cancelled_pending across restart-style replay', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  await submit(fixture, 'linked-message', 'wrong delegation', 'next_turn');

  assert.deepEqual(
    await fixture.coordinator.cancelMessageIfPending(
      ROOT.sessionId,
      'linked-message',
      'stop-claim',
    ),
    { kind: 'cancelled_pending' },
  );
  assert.deepEqual(
    await fixture.coordinator.cancelMessageIfPending(
      ROOT.sessionId,
      'linked-message',
      'stop-claim',
    ),
    { kind: 'cancelled_pending' },
  );
  assert.deepEqual(
    await fixture.coordinator.cancelMessageIfPending(
      ROOT.sessionId,
      'linked-message',
      'different-claim',
    ),
    { kind: 'cancelled' },
  );
});

test('a consumed steering Message cannot claim ownership of its pre-existing root Turn', async () => {
  const fixture = createFixture();
  fixture.events.push(steeringEvent('linked-message', 'wrong delegation'));

  assert.deepEqual(
    await fixture.coordinator.cancelMessageIfPending(
      ROOT.sessionId,
      'linked-message',
      'stop-claim',
    ),
    {
      kind: 'shared_turn',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
  );
});

test('a root source Message owns only the root Turn it created', async () => {
  const fixture = createFixture();
  fixture.receipts.set(
    'linked-message',
    sourceReceipt('linked-message', 'wrong delegation', 'current_turn', 'turn_started'),
  );

  assert.deepEqual(
    await fixture.coordinator.cancelMessageIfPending(
      ROOT.sessionId,
      'linked-message',
      'stop-claim',
    ),
    {
      kind: 'owned_root',
      turnId: 'durable-turn',
      runId: 'durable-run',
    },
  );
});

test('a recovered multi-source successor remains shared by every source Message', async () => {
  const fixture = createFixture();
  const first = sourceReceipt('linked-message', 'wrong delegation', 'current_turn', 'steering');
  const second = sourceReceipt('other-message', 'other delegation', 'current_turn', 'steering');
  const sourceMessages = [first.sourceMessage, second.sourceMessage];
  fixture.receipts.set('linked-message', {
    ...first,
    admission: { ...first.admission, userMessageId: null, sourceMessages },
  });
  fixture.receipts.set('other-message', {
    ...second,
    admission: { ...second.admission, userMessageId: null, sourceMessages },
  });

  for (const messageId of ['linked-message', 'other-message']) {
    assert.deepEqual(
      await fixture.coordinator.cancelMessageIfPending(ROOT.sessionId, messageId, 'stop-claim'),
      {
        kind: 'shared_turn',
        turnId: 'durable-turn',
        runId: 'durable-run',
      },
    );
  }
});

test('message execution query reports the Turn that durably owns each Message', async () => {
  const fixture = createFixture();
  const pendingContent = { text: 'not handed off yet' };
  await fixture.admissions.commitMessageAdmission({
    ...ROOT,
    messageId: 'pending-message',
    content: pendingContent,
    submittedContentDigest: messageContentDigest(pendingContent),
    submittedPlacement: 'current_turn',
    placement: 'current_turn',
    disposition: 'steering',
    skillInvocation: { loaded: [], failed: [], receipts: [] },
    admittedAt: 10,
  });
  fixture.receipts.set(
    'handed-off-message',
    sourceReceipt(
      'handed-off-message',
      'delivered by successor',
      'current_turn',
      'steering',
      'successor-turn',
    ),
  );
  fixture.events.push(steeringEvent('steered-message', 'consumed by admission Turn'));

  const result = await fixture.coordinator.handlers['turn.message.execution.query'](
    {
      sessionId: ROOT.sessionId,
      messageIds: ['pending-message', 'handed-off-message', 'steered-message', 'unknown-message'],
    },
    operationContext(),
  );

  assert.deepEqual(result, {
    ok: true,
    result: {
      resolutions: [
        {
          messageId: 'pending-message',
          state: 'pending',
        },
        {
          messageId: 'handed-off-message',
          state: 'owned',
          turnId: 'successor-turn',
          runId: 'durable-run',
        },
        {
          messageId: 'steered-message',
          state: 'owned',
          turnId: ROOT.turnId,
          runId: ROOT.runId,
        },
      ],
    },
  });
});

test('submit re-runs admission when the queue revision moves during preflight', async () => {
  let preflightCalls = 0;
  const fixture = createFixture(undefined, async () => {
    preflightCalls += 1;
    if (preflightCalls === 2) {
      // The steering submit already passed its preflight (call 1). This is
      // the follow-up submit's preflight: a running Turn consumes the queued
      // steering outside the admission lock while it awaits, so the queue
      // revision moves and the stale candidate must be re-admitted instead
      // of surfacing a spurious session_busy to the client.
      const [lease] = owner.pull();
      assert.ok(lease);
      owner.ack([lease.id]);
    }
    return true;
  });
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  const input = (messageId: string, text: string, placement: 'current_turn' | 'next_turn') =>
    ({
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      messageId,
      content: { text },
      placement,
    }) as const;

  const steering = await fixture.coordinator.handlers['turn.message.submit'](
    input('steering-1', 'steer', 'current_turn'),
    operationContext(),
  );
  assert.equal(steering.ok, true);
  let preparationCalls = 0;
  fixture.setMessagePreparation(async (message) => {
    preparationCalls += 1;
    return {
      kind: 'ready',
      content: message.content,
      skillInvocation: EMPTY_SKILL_INVOCATION,
    };
  });

  const followup = await fixture.coordinator.handlers['turn.message.submit'](
    input('followup-1', 'queued task', 'next_turn'),
    operationContext(),
  );
  assert.equal(followup.ok, true);
  assert.equal(followup.ok && followup.result.disposition, 'followup');
  assert.ok(
    preflightCalls >= 2,
    `expected admission retry, preflight ran ${preflightCalls} time(s)`,
  );
  assert.equal(preparationCalls, 1, 'one admission must prepare Skills only once');
  owner.release();
});

test('persists prepared Skill content while projecting the submitted text', async () => {
  const fixture = createFixture();
  const skillInvocation = {
    loaded: [{ id: 'writer', name: 'Writer' }],
    failed: [{ request: 'typo', reason: 'not_found' as const }],
    receipts: [],
  };
  fixture.setMessagePreparation(async (input) => ({
    kind: 'ready',
    content: {
      text: `<invoked-skill>Prepared</invoked-skill>\n\n${input.content.text}`,
      displayText: input.content.text,
    },
    skillInvocation,
  }));
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  const steeringResult = await submit(
    fixture,
    'skill-steering',
    '/skill:writer steer',
    'current_turn',
  );
  assert.deepEqual(steeringResult, {
    ok: true,
    result: { disposition: 'steering', queueRevision: 1, skillInvocation },
  });
  assert.deepEqual(
    fixture.readMessageAdmission('skill-steering')?.skillInvocation,
    skillInvocation,
  );
  assert.deepEqual(
    await submit(fixture, 'skill-steering', '/skill:writer steer', 'current_turn'),
    steeringResult,
  );
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering[0]?.content, {
    text: '/skill:writer steer',
  });
  const [steering] = owner.pull();
  assert.deepEqual(steering?.content, {
    text: '<invoked-skill>Prepared</invoked-skill>\n\n/skill:writer steer',
    displayText: '/skill:writer steer',
  });
  assert.equal(
    steering?.submittedContentDigest,
    messageContentDigest({ text: '/skill:writer steer' }),
  );
  if (steering) owner.ack([steering.id]);

  const followupResult = await submit(
    fixture,
    'skill-followup',
    '/skill:writer follow',
    'next_turn',
  );
  assert.deepEqual(followupResult, {
    ok: true,
    result: { disposition: 'followup', queueRevision: 4, skillInvocation },
  });
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(batch.content, {
    text: '<invoked-skill>Prepared</invoked-skill>\n\n/skill:writer follow',
    displayText: '/skill:writer follow',
  });
  assert.deepEqual(batch.sources[0]?.content, {
    text: '<invoked-skill>Prepared</invoked-skill>\n\n/skill:writer follow',
    displayText: '/skill:writer follow',
  });
  assert.deepEqual(batch.sources[0]?.skillInvocation, skillInvocation);
  const nextRoot = { sessionId: ROOT.sessionId, turnId: 'turn-2', runId: 'run-2' };
  fixture.coordinator.commitNextRoot(batch, nextRoot);
  fixture.coordinator.abandonRootReservation(nextRoot);
});

test('blocks a queued Message when every Skill fails without mutating the queue', async () => {
  const fixture = createFixture();
  const skillInvocation = {
    loaded: [],
    failed: [{ request: 'missing', reason: 'not_found' as const }],
    receipts: [],
  };
  fixture.setMessagePreparation(async () => ({
    kind: 'rejected',
    error: 'Explicit Skill invocation could not be resolved',
    skillInvocation,
  }));
  fixture.coordinator.reserveRootTurn(ROOT);

  assert.deepEqual(
    await submit(fixture, 'skill-blocked', '/skill:missing inspect this', 'current_turn'),
    {
      ok: true,
      result: { disposition: 'blocked', skillInvocation },
    },
  );
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
    hostEpoch: 'epoch-1',
    queueRevision: 0,
    steering: [],
    followup: [],
  });
  assert.equal(fixture.readMessageAdmission('skill-blocked'), undefined);
});

test('an all-failed Skill invocation stays blocked when the queue is full', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  for (let index = 0; index < MESSAGE_QUEUE_MAX_ENTRIES; index += 1) {
    const admitted = await submit(fixture, `queued-${index}`, 'x', 'next_turn');
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
  }
  const skillInvocation = {
    loaded: [],
    failed: [{ request: 'missing', reason: 'not_found' as const }],
    receipts: [],
  };
  fixture.setMessagePreparation(async () => ({
    kind: 'rejected',
    error: 'Explicit Skill invocation could not be resolved',
    skillInvocation,
  }));

  assert.deepEqual(await submit(fixture, 'blocked-at-capacity', '/skill:missing', 'current_turn'), {
    ok: true,
    result: { disposition: 'blocked', skillInvocation },
  });
  assert.equal(
    fixture.coordinator.projection(ROOT.sessionId).followup.length,
    MESSAGE_QUEUE_MAX_ENTRIES,
  );

  await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-full-queue' },
    operationContext(),
  );
  fixture.coordinator.abandonRootReservation(ROOT);
  await fixture.coordinator.close();
});

test('queued steering admission budgets per-source Skill outcomes into its durable root record', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const skillInvocation = largeSkillInvocation();
  fixture.setMessagePreparation(async (message) => ({
    kind: 'ready',
    content: message.content,
    skillInvocation,
  }));

  let admittedCount = 0;
  let rejectedMessageId = '';
  for (let index = 0; index < MESSAGE_QUEUE_MAX_ENTRIES; index += 1) {
    const messageId = `large-outcome-${index}`;
    const outcome = await submit(fixture, messageId, 'x', 'current_turn');
    if (!outcome.ok) {
      assert.equal(outcome.error.code, 'session_busy');
      rejectedMessageId = messageId;
      break;
    }
    admittedCount += 1;
  }

  assert.ok(admittedCount > 0 && admittedCount < MESSAGE_QUEUE_MAX_ENTRIES);
  assert.equal(fixture.coordinator.projection(ROOT.sessionId).steering.length, admittedCount);
  assert.equal(fixture.readMessageAdmission(rejectedMessageId), undefined);

  await fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'cleanup-large-outcome-queue',
    },
    operationContext(),
  );
  fixture.coordinator.abandonRootReservation(ROOT);
  await fixture.coordinator.close();
});

test('queued steering capacity preflight includes the original submitted placement', async () => {
  const skillInvocation = largeSkillInvocation();
  const source = (
    messageId: string,
    sourceSkillInvocation: SkillInvocationResult,
    includeSubmittedPlacement = true,
    text = 'x',
  ): RootTurnSourceMessage => ({
    messageId,
    content: { text },
    submittedContentDigest: messageContentDigest({ text }),
    ...(includeSubmittedPlacement ? { submittedPlacement: 'current_turn' as const } : {}),
    skillInvocation: sourceSkillInvocation,
    placement: 'current_turn',
    disposition: 'steering',
  });
  const fits = (sources: readonly RootTurnSourceMessage[]) =>
    rootTurnAdmissionRecordFits({
      sessionId: ROOT.sessionId,
      turnId: 'i'.repeat(128),
      proposedRunId: 'i'.repeat(128),
      proposedUserMessageId: sources.length === 1 ? 'i'.repeat(128) : null,
      execution: {
        kind: 'external_message',
        inputDigest: `sha256:${'f'.repeat(64)}`,
      },
      previousRootTurnId: ROOT.turnId,
      normalizedInput: aggregateMessageContents(sources.map((candidate) => candidate.content)),
      sourceMessages: sources,
      admittedAt: Number.MAX_SAFE_INTEGER,
    });
  const tunableSkillInvocation = (bytes: number): SkillInvocationResult => {
    assert.ok(bytes >= 100 && bytes <= 50 * 1024);
    let remaining = bytes - 100;
    const loaded = Array.from({ length: 50 }, (_, index) => ({
      id: `skill-${index}`,
      name: `Skill ${index}`,
    }));
    const receipts = loaded.map((skill) => {
      const requestExtra = Math.min(511, remaining);
      remaining -= requestExtra;
      const refExtra = Math.min(511, remaining);
      remaining -= refExtra;
      return {
        invocation: 'explicit' as const,
        request: 'q'.repeat(1 + requestExtra),
        success: true as const,
        ref: 'r'.repeat(1 + refExtra),
        id: skill.id,
        name: skill.name,
        scope: 'project' as const,
        source: 'maka' as const,
        truncated: false,
      };
    });
    assert.equal(remaining, 0);
    return { loaded, failed: [], receipts };
  };

  const existingSourceCountAtBoundary = 22;
  const candidateSkillBytesAtBoundary = 33_424;
  const existing = Array.from({ length: existingSourceCountAtBoundary }, (_, index) =>
    source(`capacity-source-${index}`, skillInvocation),
  );
  const candidateSkillInvocation = tunableSkillInvocation(candidateSkillBytesAtBoundary);
  assert.equal(
    fits([...existing, source('capacity-boundary', candidateSkillInvocation, false, 'boundary')]),
    true,
  );
  assert.equal(
    fits([...existing, source('capacity-boundary', candidateSkillInvocation, true, 'boundary')]),
    false,
  );

  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  fixture.setMessagePreparation(async (message) => ({
    kind: 'ready',
    content: message.content,
    skillInvocation:
      message.content.text === 'boundary' ? candidateSkillInvocation : skillInvocation,
  }));
  for (const existingSource of existing) {
    const outcome = await submit(fixture, existingSource.messageId, 'x', 'current_turn');
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
  }
  const revisionBeforeCandidate = fixture.coordinator.projection(ROOT.sessionId).queueRevision;

  const outcome = await submit(fixture, 'capacity-boundary', 'boundary', 'current_turn');

  assert.deepEqual(outcome, {
    ok: false,
    error: {
      code: 'session_busy',
      message: 'Message queue cannot form a durable follow-up Turn',
    },
  });
  assert.equal(
    fixture.coordinator.projection(ROOT.sessionId).queueRevision,
    revisionBeforeCandidate,
  );
  assert.equal(fixture.readMessageAdmission('capacity-boundary'), undefined);

  await fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'cleanup-placement-capacity-boundary',
    },
    operationContext(),
  );
  fixture.coordinator.abandonRootReservation(ROOT);
  await fixture.coordinator.close();
});

test('queue update budgets its new Skill outcome into the durable root record', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  assert.equal((await submit(fixture, 'update-target', 'small', 'current_turn')).ok, true);
  const skillInvocation = largeSkillInvocation();
  fixture.setMessagePreparation(async (message) => ({
    kind: 'ready',
    content: message.content,
    skillInvocation,
  }));
  for (let index = 0; index < MESSAGE_QUEUE_MAX_ENTRIES; index += 1) {
    const outcome = await submit(fixture, `large-before-update-${index}`, 'x', 'current_turn');
    if (!outcome.ok) {
      assert.equal(outcome.error.code, 'session_busy');
      break;
    }
  }
  const projection = fixture.coordinator.projection(ROOT.sessionId);
  const target = projection.steering[0];
  assert.ok(target);

  const updated = await fixture.coordinator.handlers['queue.entry.update'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: target.entryId,
      updateId: 'large-outcome-update',
      expectedQueueRevision: projection.queueRevision,
      text: 'edited',
    },
    operationContext(),
  );

  assert.equal(updated.ok, false);
  if (!updated.ok) assert.equal(updated.error.code, 'session_busy');
  assert.deepEqual(fixture.readMessageAdmission('update-target')?.content, { text: 'small' });
  assert.deepEqual(
    fixture.readMessageAdmission('update-target')?.skillInvocation,
    EMPTY_SKILL_INVOCATION,
  );

  await fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'cleanup-large-outcome-update',
    },
    operationContext(),
  );
  fixture.coordinator.abandonRootReservation(ROOT);
  await fixture.coordinator.close();
});

test('invalidates the canonical projection after each observable queue mutation', async () => {
  const changedSessions: string[] = [];
  const fixture = createFixture((sessionId) => changedSessions.push(sessionId));
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  assert.equal((await submit(fixture, 'steering-1', 'first', 'current_turn')).ok, true);
  const [lease] = owner.pull();
  assert.ok(lease);
  owner.ack([lease.id]);
  owner.release();
  fixture.coordinator.completeIdle(fixture.coordinator.beginTerminalTransition(ROOT));

  assert.deepEqual(
    changedSessions,
    Array.from({ length: 4 }, () => ROOT.sessionId),
  );
  await fixture.coordinator.close();
});

test('hands each explicit follow-up to its own Session successor', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  const input = (messageId: string, text: string, placement: 'current_turn' | 'next_turn') => ({
    originHostEpoch: 'epoch-1',
    sessionId: ROOT.sessionId,
    messageId,
    content: { text },
    placement,
  });

  const first = await fixture.coordinator.handlers['turn.message.submit'](
    input('followup-from-b', 'first successor', 'next_turn'),
    operationContext('connection-b'),
  );
  const second = await fixture.coordinator.handlers['turn.message.submit'](
    input('followup-from-c', 'second successor', 'next_turn'),
    operationContext('connection-c'),
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  owner.release();
  const firstBatch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(
    firstBatch.sources.map((source) => source.messageId),
    ['followup-from-b'],
  );

  const secondRoot = {
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  };
  fixture.coordinator.commitNextRoot(firstBatch, secondRoot);
  assert.equal(fixture.liveResidencies(), 1);
  const nextOwner = fixture.coordinator.bindRun(secondRoot);
  nextOwner.release();
  const secondBatch = fixture.coordinator.beginTerminalTransition(secondRoot);
  assert.deepEqual(
    secondBatch.sources.map((source) => source.messageId),
    ['followup-from-c'],
  );
  fixture.coordinator.commitNextRoot(secondBatch, {
    sessionId: ROOT.sessionId,
    turnId: 'turn-3',
    runId: 'run-3',
  });
  assert.equal(fixture.liveResidencies(), 0);
  const finalOwner = fixture.coordinator.bindRun({
    sessionId: ROOT.sessionId,
    turnId: 'turn-3',
    runId: 'run-3',
  });
  finalOwner.release();
  fixture.coordinator.completeIdle(
    fixture.coordinator.beginTerminalTransition({
      sessionId: ROOT.sessionId,
      turnId: 'turn-3',
      runId: 'run-3',
    }),
  );
  await fixture.coordinator.close();
});

test('recovered followups without a connection owner still form one successor batch', async () => {
  const fixture = createFixture();
  await fixture.admissions.commitMessageAdmission({
    sessionId: ROOT.sessionId,
    turnId: ROOT.turnId,
    runId: ROOT.runId,
    messageId: 'recovered-followup',
    content: { text: 'recover without a connection owner' },
    submittedContentDigest: messageContentDigest({
      text: 'recover without a connection owner',
    }),
    submittedPlacement: 'next_turn',
    placement: 'next_turn',
    disposition: 'followup',
    skillInvocation: EMPTY_SKILL_INVOCATION,
    admittedAt: 1,
  });

  await fixture.coordinator.recoverPendingAfterHostRestart([ROOT.sessionId]);
  const owner = fixture.coordinator.bindRun(ROOT);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(
    batch.sources.map((source) => source.messageId),
    ['recovered-followup'],
  );
  fixture.coordinator.commitNextRoot(batch, {
    sessionId: ROOT.sessionId,
    turnId: 'turn-recovered-successor',
    runId: 'run-recovered-successor',
  });
  const successor = fixture.coordinator.bindRun({
    sessionId: ROOT.sessionId,
    turnId: 'turn-recovered-successor',
    runId: 'run-recovered-successor',
  });
  successor.release();
  fixture.coordinator.completeIdle(
    fixture.coordinator.beginTerminalTransition({
      sessionId: ROOT.sessionId,
      turnId: 'turn-recovered-successor',
      runId: 'run-recovered-successor',
    }),
  );
});

test('recovery starts one explicit follow-up and keeps later messages queued', async () => {
  const fixture = createFixture();
  for (const [index, messageId] of ['recovered-first', 'recovered-second'].entries()) {
    const content = { text: messageId };
    await fixture.admissions.commitMessageAdmission({
      sessionId: ROOT.sessionId,
      turnId: ROOT.turnId,
      runId: ROOT.runId,
      messageId,
      content,
      submittedContentDigest: messageContentDigest(content),
      submittedPlacement: 'next_turn',
      placement: 'next_turn',
      disposition: 'followup',
      skillInvocation: EMPTY_SKILL_INVOCATION,
      admittedAt: index + 1,
    });
  }

  fixture.setRootState({ kind: 'idle' });
  await fixture.coordinator.recoverPendingAfterHostRestart([ROOT.sessionId]);

  assert.deepEqual(
    fixture.recoveredBatches.map((batch) => batch.sources.map((source) => source.messageId)),
    [['recovered-first']],
  );
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).followup.map((entry) => entry.messageId),
    ['recovered-second'],
  );

  const projection = fixture.coordinator.projection(ROOT.sessionId);
  const remainingEntryId = projection.followup[0]?.entryId;
  assert.ok(remainingEntryId);
  const updated = await fixture.coordinator.handlers['queue.entry.update'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: remainingEntryId,
      updateId: 'update-recovered-second',
      expectedQueueRevision: projection.queueRevision,
      text: 'edited after recovery',
    },
    operationContext(),
  );
  assert.equal(updated.ok, true);
  assert.deepEqual(fixture.readMessageAdmission('recovered-second'), {
    sessionId: ROOT.sessionId,
    turnId: ROOT.turnId,
    runId: ROOT.runId,
    messageId: 'recovered-second',
    content: { text: 'edited after recovery' },
    submittedContentDigest: messageContentDigest({ text: 'edited after recovery' }),
    submittedPlacement: 'next_turn',
    placement: 'next_turn',
    disposition: 'followup',
    skillInvocation: EMPTY_SKILL_INVOCATION,
    admittedAt: 2,
  });
});

test('recovery folds later steering ahead of an earlier explicit follow-up', async () => {
  const fixture = createFixture();
  for (const admission of [
    {
      messageId: 'recovered-followup',
      content: { text: 'future work' },
      submittedPlacement: 'next_turn' as const,
      placement: 'next_turn' as const,
      disposition: 'followup' as const,
      admittedAt: 1,
    },
    {
      messageId: 'recovered-steering',
      content: { text: 'correct the current work' },
      submittedPlacement: 'current_turn' as const,
      placement: 'current_turn' as const,
      disposition: 'steering' as const,
      admittedAt: 2,
    },
  ]) {
    await fixture.admissions.commitMessageAdmission({
      sessionId: ROOT.sessionId,
      turnId: ROOT.turnId,
      runId: ROOT.runId,
      ...admission,
      submittedContentDigest: messageContentDigest(admission.content),
      skillInvocation: EMPTY_SKILL_INVOCATION,
    });
  }

  fixture.setRootState({ kind: 'idle' });
  await fixture.coordinator.recoverPendingAfterHostRestart([ROOT.sessionId]);

  assert.deepEqual(
    fixture.recoveredBatches.map((batch) => batch.sources.map((source) => source.messageId)),
    [['recovered-steering']],
  );
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).followup.map((entry) => entry.messageId),
    ['recovered-followup'],
  );
});

test('recovery folds promoted steering ahead of an earlier explicit follow-up', async () => {
  const fixture = createFixture();
  for (const admission of [
    {
      messageId: 'recovered-followup',
      content: { text: 'future work' },
      turnId: ROOT.turnId,
      runId: ROOT.runId,
      submittedPlacement: 'next_turn' as const,
      placement: 'next_turn' as const,
      disposition: 'followup' as const,
      admittedAt: 1,
    },
    {
      messageId: 'recovered-promoted',
      content: { text: 'promoted correction' },
      turnId: 'earlier-turn',
      runId: 'earlier-run',
      submittedPlacement: 'next_turn' as const,
      placement: 'current_turn' as const,
      disposition: 'steering' as const,
      admittedAt: 2,
    },
  ]) {
    await fixture.admissions.commitMessageAdmission({
      sessionId: ROOT.sessionId,
      ...admission,
      submittedContentDigest: messageContentDigest(admission.content),
      skillInvocation: EMPTY_SKILL_INVOCATION,
    });
  }

  fixture.setRootState({ kind: 'idle' });
  await fixture.coordinator.recoverPendingAfterHostRestart([ROOT.sessionId]);

  assert.deepEqual(
    fixture.recoveredBatches.map((batch) => batch.sources.map((source) => source.messageId)),
    [['recovered-promoted']],
  );
  assert.equal(fixture.recoveredBatches[0]?.rootIdentity, undefined);
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).followup.map((entry) => entry.messageId),
    ['recovered-followup'],
  );
});

// The Host stopped after the Message admission committed and before the root
// admission that carries the exact-Turn intent was written.
async function recoverExactTurnAcrossHostStop(): Promise<ReturnType<typeof createFixture>> {
  const fixture = createFixture();
  fixture.setRootState({ kind: 'idle' });
  await fixture.admissions.commitMessageAdmission({
    sessionId: ROOT.sessionId,
    turnId: ROOT.turnId,
    runId: ROOT.runId,
    messageId: 'recovered-exact',
    content: { text: 'run this as a graph' },
    submittedContentDigest: messageContentDigest({ text: 'run this as a graph' }),
    submittedPlacement: 'current_turn',
    placement: 'current_turn',
    disposition: 'steering',
    submittedIntent: {
      skillIds: ['review'],
      turnOrchestration: { mode: 'graph', source: 'slash_command' },
    },
    skillInvocation: EMPTY_SKILL_INVOCATION,
    admittedAt: 1,
  });
  await fixture.coordinator.recoverPendingAfterHostRestart([ROOT.sessionId]);
  return fixture;
}

function resubmitRecoveredExact(
  fixture: ReturnType<typeof createFixture>,
  mode: 'graph' | 'swarm',
) {
  return fixture.coordinator.handlers['turn.message.submit'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      messageId: 'recovered-exact',
      content: { text: 'run this as a graph' },
      placement: 'current_turn',
      skillIds: ['review'],
      turnOrchestration: { mode, source: 'slash_command' },
    },
    operationContext(),
  );
}

test('recovery re-opens a Turn under the intent the Message asked for', async () => {
  const fixture = await recoverExactTurnAcrossHostStop();

  assert.equal(fixture.recoveredBatches.length, 1);
  assert.deepEqual(fixture.recoveredBatches[0]?.submittedIntent, {
    skillIds: ['review'],
    turnOrchestration: { mode: 'graph', source: 'slash_command' },
  });
});

test('a retry of a recovered exact-Turn Message is not a conflict', async () => {
  const fixture = await recoverExactTurnAcrossHostStop();

  const retried = await resubmitRecoveredExact(fixture, 'graph');

  // The intent survived the crash cut whole, so the unchanged retry reads as
  // the same submit. The durable source retains the queued disposition and
  // Skill outcome even though its previous Host Epoch's revision is gone.
  assert.deepEqual(retried, {
    ok: true,
    result: { disposition: 'steering', skillInvocation: EMPTY_SKILL_INVOCATION },
  });
  assert.equal(fixture.startCalls(), 0);
});

test('a retry that changes intent after recovery is still a conflict', async () => {
  const fixture = await recoverExactTurnAcrossHostStop();

  const changed = await resubmitRecoveredExact(fixture, 'swarm');
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.error.code, 'operation_conflict');
});

test('recovery treats a durable steering event as the handoff proof', async () => {
  const fixture = createFixture();
  await fixture.admissions.commitMessageAdmission({
    sessionId: ROOT.sessionId,
    turnId: ROOT.turnId,
    runId: ROOT.runId,
    messageId: 'recovered-steering',
    content: { text: 'recover this steering event' },
    submittedContentDigest: messageContentDigest({ text: 'recover this steering event' }),
    submittedPlacement: 'current_turn',
    placement: 'current_turn',
    disposition: 'steering',
    skillInvocation: EMPTY_SKILL_INVOCATION,
    admittedAt: 1,
  });
  fixture.events.push(steeringEvent('recovered-steering', 'recover this steering event'));

  await fixture.coordinator.recoverPendingAfterHostRestart([ROOT.sessionId]);

  assert.equal(fixture.readMessageAdmission('recovered-steering'), undefined);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
    hostEpoch: 'epoch-1',
    queueRevision: 0,
    steering: [],
    followup: [],
  });
  await fixture.coordinator.close();
});

test('active recovery rebuilds only admissions without a durable proof', async () => {
  const fixture = createFixture();
  for (const [messageId, text] of [
    ['proved-steering', 'already delivered'],
    ['still-pending', 'deliver after recovery'],
  ] as const) {
    await fixture.admissions.commitMessageAdmission({
      sessionId: ROOT.sessionId,
      turnId: ROOT.turnId,
      runId: ROOT.runId,
      messageId,
      content: { text },
      submittedContentDigest: messageContentDigest({ text }),
      submittedPlacement: 'current_turn',
      placement: 'current_turn',
      disposition: 'steering',
      skillInvocation: EMPTY_SKILL_INVOCATION,
      admittedAt: 1,
    });
  }
  fixture.events.push(steeringEvent('proved-steering', 'already delivered'));

  await fixture.coordinator.recoverPendingAfterHostRestart([ROOT.sessionId]);

  assert.equal(fixture.readMessageAdmission('proved-steering'), undefined);
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).steering.map((entry) => entry.messageId),
    ['still-pending'],
  );
});

test('a retry of a recovered queued Message reuses its durable Skill outcome', async () => {
  const fixture = createFixture();
  const skillInvocation = {
    loaded: [{ id: 'writer', name: 'Writer' }],
    failed: [{ request: 'typo', reason: 'not_found' as const }],
    receipts: [],
  };
  await fixture.admissions.commitMessageAdmission({
    sessionId: ROOT.sessionId,
    turnId: ROOT.turnId,
    runId: ROOT.runId,
    messageId: 'recovered-skill',
    content: {
      text: '<invoked-skill>Writer</invoked-skill>',
      displayText: '/skill:writer /skill:typo draft',
    },
    submittedContentDigest: messageContentDigest({
      text: '/skill:writer /skill:typo draft',
    }),
    submittedPlacement: 'current_turn',
    placement: 'current_turn',
    disposition: 'steering',
    skillInvocation,
    admittedAt: 1,
  });
  await fixture.coordinator.recoverPendingAfterHostRestart([ROOT.sessionId]);
  fixture.setMessagePreparation(async () => {
    throw new Error('recovered retries must not prepare Skills again');
  });

  const retried = await submit(
    fixture,
    'recovered-skill',
    '/skill:writer /skill:typo draft',
    'current_turn',
  );

  assert.deepEqual(retried, {
    ok: true,
    result: { disposition: 'steering', queueRevision: 1, skillInvocation },
  });
  assert.equal(fixture.coordinator.projection(ROOT.sessionId).steering.length, 1);
});

test('an idle retry reuses the Skill outcome from its pending admission', async () => {
  const fixture = createFixture();
  fixture.setRootState({ kind: 'idle' });
  const skillInvocation = {
    loaded: [{ id: 'writer', name: 'Writer' }],
    failed: [{ request: 'typo', reason: 'not_found' as const }],
    receipts: [],
  };
  await fixture.admissions.commitMessageAdmission({
    sessionId: ROOT.sessionId,
    turnId: 'pending-turn',
    runId: 'pending-run',
    messageId: 'pending-skill',
    content: {
      text: '<invoked-skill>Writer</invoked-skill>',
      displayText: '/skill:writer /skill:typo draft',
    },
    submittedContentDigest: messageContentDigest({
      text: '/skill:writer /skill:typo draft',
    }),
    submittedPlacement: 'current_turn',
    placement: 'current_turn',
    disposition: 'steering',
    skillInvocation,
    admittedAt: 1,
  });

  assert.deepEqual(
    await submit(fixture, 'pending-skill', '/skill:writer /skill:typo draft', 'current_turn'),
    {
      ok: true,
      result: { disposition: 'turn_started', turnId: 'idle-turn', skillInvocation },
    },
  );
  assert.deepEqual(
    fixture.receipts.get('pending-skill')?.sourceMessage.skillInvocation,
    skillInvocation,
  );
});

test('binds the exact reserved Run after a pre-bind stop fence', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  assert.equal((await submit(fixture, 'queued-before-bind', 'discard me', 'next_turn')).ok, true);

  const fence = fixture.coordinator.commitStopFence(ROOT);
  assert.equal(fence.retracted.length, 1);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).followup, []);
  assert.equal(fixture.liveResidencies(), 0);

  const owner = fixture.coordinator.bindRun(ROOT);
  assert.deepEqual(owner.pull(), []);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(batch.sources, []);
  fixture.coordinator.completeIdle(batch);
  await fixture.coordinator.close();
});

test('queue projection capacity is rejected before mutation or residency acquisition', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);

  const outcome = await submit(fixture, 'oversized', 'x'.repeat(52 * 1024), 'current_turn');

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, 'session_busy');
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);
  assert.equal(fixture.liveResidencies(), 0);
  fixture.coordinator.abandonRootReservation(ROOT);
  await fixture.coordinator.close();
});

test('full snapshot preflight rejection leaves queue, replay outcome, residency, and publication unchanged', async () => {
  let fits = false;
  let observedQueue: SessionMessageQueueProjection | undefined;
  const changedSessions: string[] = [];
  const fixture = createFixture(
    (sessionId) => changedSessions.push(sessionId),
    async (_sessionId, candidate) => {
      observedQueue = candidate.queue;
      return fits;
    },
  );
  fixture.coordinator.reserveRootTurn(ROOT);

  const rejected = await submit(fixture, 'capacity-candidate', 'small message', 'current_turn');
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'session_busy');
  assert.equal(observedQueue?.queueRevision, 1);
  assert.equal(observedQueue?.steering[0]?.state, 'queued');
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);
  assert.equal(fixture.liveResidencies(), 0);
  assert.deepEqual(changedSessions, []);

  fits = true;
  const accepted = await submit(fixture, 'capacity-candidate', 'small message', 'current_turn');
  assert.equal(accepted.ok && accepted.result.disposition, 'steering');
  assert.equal(fixture.liveResidencies(), 1);
  assert.deepEqual(changedSessions, [ROOT.sessionId]);

  await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-capacity' },
    operationContext(),
  );
  fixture.coordinator.abandonRootReservation(ROOT);
  await fixture.coordinator.close();
});

test('separate follow-ups do not share one root-admission capacity budget', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);

  const first = await submit(fixture, 'large-followup', 'x'.repeat(40 * 1024), 'next_turn');
  assert.equal(first.ok && first.result.disposition, 'followup');
  const second = await submitContent(
    fixture,
    'display-followup',
    { text: 'model', displayText: 'human' },
    'next_turn',
  );
  assert.equal(second.ok && second.result.disposition, 'followup');
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).followup.map((entry) => entry.messageId),
    ['large-followup', 'display-followup'],
  );
  assert.equal(fixture.liveResidencies(), 2);

  const retracted = await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-large' },
    operationContext(),
  );
  assert.equal(retracted.ok, true);
  fixture.coordinator.abandonRootReservation(ROOT);
  await fixture.coordinator.close();
});

test('pull crosses the retract commit cut and only queued entries are retracted', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  await submit(fixture, 'steer-1', 'steer me', 'current_turn');
  await submit(fixture, 'follow-1', 'later', 'next_turn');
  const [lease] = owner.pull();
  assert.ok(lease);

  const outcome = await fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'retract-1',
    },
    operationContext(),
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(
    outcome.result.retracted.map((entry) => entry.messageId),
    ['follow-1'],
  );
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
    hostEpoch: 'epoch-1',
    queueRevision: 4,
    steering: [
      {
        entryId: 'id-1',
        messageId: 'steer-1',
        content: { text: 'steer me' },
        placement: 'current_turn',
        state: 'in_flight',
      },
    ],
    followup: [],
  });

  owner.ack([lease.id]);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  assert.equal(fixture.liveResidencies(), 0);
});

test('entry retract removes one queued entry, replays its outcome, and rejects stale targets', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);

  await submit(fixture, 'steer-1', 'steer me', 'current_turn');
  await submit(fixture, 'follow-1', 'first', 'next_turn');
  await submit(fixture, 'follow-2', 'second', 'next_turn');

  const retracted = await fixture.coordinator.handlers['queue.entry.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-2',
      retractId: 'retract-entry-1',
    },
    operationContext(),
  );
  assert.equal(retracted.ok, true);
  if (!retracted.ok) return;
  assert.equal(retracted.result.queueRevision, 4);
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).followup.map((entry) => entry.messageId),
    ['follow-2'],
  );
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).steering.map((entry) => entry.messageId),
    ['steer-1'],
  );
  assert.deepEqual(
    await fixture.coordinator.handlers['turn.message.execution.query'](
      { sessionId: ROOT.sessionId, messageIds: ['follow-1'] },
      operationContext(),
    ),
    {
      ok: true,
      result: {
        resolutions: [{ messageId: 'follow-1', state: 'cancelled' }],
      },
    },
  );

  const retry = await fixture.coordinator.handlers['queue.entry.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-2',
      retractId: 'retract-entry-1',
    },
    operationContext(),
  );
  assert.deepEqual(retry, retracted);

  const conflict = await fixture.coordinator.handlers['queue.entry.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-3',
      retractId: 'retract-entry-1',
    },
    operationContext(),
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, 'operation_conflict');

  const missing = await fixture.coordinator.handlers['queue.entry.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-2',
      retractId: 'retract-entry-2',
    },
    operationContext(),
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, 'not_found');

  const steering = await fixture.coordinator.handlers['queue.entry.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-1',
      retractId: 'retract-entry-3',
    },
    operationContext(),
  );
  assert.equal(steering.ok, true);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);
  assert.equal(fixture.liveResidencies(), 1);

  await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-entry' },
    operationContext(),
  );
  fixture.coordinator.abandonRootReservation(ROOT);
  await fixture.coordinator.close();
});

test('entry retract of an in-flight steering lease conflicts', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  await submit(fixture, 'steer-1', 'steer me', 'current_turn');
  const [lease] = owner.pull();
  assert.ok(lease);

  const outcome = await fixture.coordinator.handlers['queue.entry.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-1',
      retractId: 'retract-in-flight',
    },
    operationContext(),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, 'operation_conflict');

  owner.ack([lease.id]);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  assert.equal(fixture.liveResidencies(), 0);
});

test('entry update preserves queue identity, order, and placement and replays its outcome', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);

  await submit(fixture, 'steer-1', 'steer me', 'current_turn');
  await submitContent(
    fixture,
    'follow-1',
    {
      text: 'first @src/a.ts',
      inlineReferences: [
        {
          kind: 'workspace_file',
          value: '@src/a.ts',
          label: 'src/a.ts',
          start: 6,
        },
      ],
    },
    'next_turn',
  );
  await submit(fixture, 'follow-2', 'second', 'next_turn');
  let preparedUpdateContent: MessageContent | undefined;
  fixture.setMessagePreparation(async (input) => {
    preparedUpdateContent = input.content;
    return {
      kind: 'ready',
      content: input.content,
      skillInvocation: { loaded: [], failed: [], receipts: [] },
    };
  });

  const updated = await fixture.coordinator.handlers['queue.entry.update'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-2',
      updateId: 'update-entry-1',
      expectedQueueRevision: 3,
      text: 'please first @src/a.ts',
    },
    operationContext(),
  );
  assert.equal(updated.ok, true);
  assert.deepEqual(preparedUpdateContent, {
    text: 'please first @src/a.ts',
    inlineReferences: [
      {
        kind: 'workspace_file',
        value: '@src/a.ts',
        label: 'src/a.ts',
        start: 13,
      },
    ],
  });
  const projection = fixture.coordinator.projection(ROOT.sessionId);
  assert.deepEqual(
    projection.followup.map((entry) => [entry.entryId, entry.content.text, entry.placement]),
    [
      ['id-2', 'please first @src/a.ts', 'next_turn'],
      ['id-3', 'second', 'next_turn'],
    ],
  );
  assert.deepEqual(
    projection.steering.map((entry) => [entry.entryId, entry.content.text, entry.placement]),
    [['id-1', 'steer me', 'current_turn']],
  );

  const stale = await fixture.coordinator.handlers['queue.entry.update'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-2',
      updateId: 'update-entry-stale',
      expectedQueueRevision: 3,
      text: 'stale overwrite',
    },
    operationContext(),
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, 'operation_conflict');

  const retry = await fixture.coordinator.handlers['queue.entry.update'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-2',
      updateId: 'update-entry-1',
      expectedQueueRevision: 3,
      text: 'please first @src/a.ts',
    },
    operationContext(),
  );
  assert.deepEqual(retry, updated);

  const conflict = await fixture.coordinator.handlers['queue.entry.update'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-3',
      updateId: 'update-entry-1',
      expectedQueueRevision: 3,
      text: 'conflicting retry',
    },
    operationContext(),
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, 'operation_conflict');

  await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-update' },
    operationContext(),
  );
  fixture.coordinator.abandonRootReservation(ROOT);
  await fixture.coordinator.close();
});

test('entry update of an in-flight steering lease conflicts', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  await submit(fixture, 'steer-1', 'steer me', 'current_turn');
  const [lease] = owner.pull();
  assert.ok(lease);

  const outcome = await fixture.coordinator.handlers['queue.entry.update'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-1',
      updateId: 'update-in-flight',
      expectedQueueRevision: 2,
      text: 'too late',
    },
    operationContext(),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, 'operation_conflict');

  owner.ack([lease.id]);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  assert.equal(fixture.liveResidencies(), 0);
});

test('entry update keeps relocated inline references ordered and non-overlapping', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  await submitContent(
    fixture,
    'reordered-refs',
    {
      text: '@src/a @src/b',
      inlineReferences: [
        { kind: 'workspace_file', value: '@src/a', label: 'src/a', start: 0 },
        { kind: 'workspace_file', value: '@src/b', label: 'src/b', start: 7 },
      ],
    },
    'next_turn',
  );
  await submitContent(
    fixture,
    'overlapping-refs',
    {
      text: '@src/a @src/a.ts',
      inlineReferences: [
        { kind: 'workspace_file', value: '@src/a', label: 'src/a', start: 0 },
        { kind: 'workspace_file', value: '@src/a.ts', label: 'src/a.ts', start: 7 },
      ],
    },
    'next_turn',
  );

  const reordered = await fixture.coordinator.handlers['queue.entry.update'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-1',
      updateId: 'update-reordered-refs',
      expectedQueueRevision: 2,
      text: '@src/b @src/a',
    },
    operationContext(),
  );
  assert.equal(reordered.ok, true);

  const overlapping = await fixture.coordinator.handlers['queue.entry.update'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-2',
      updateId: 'update-overlapping-refs',
      expectedQueueRevision: 3,
      text: '@src/a.ts',
    },
    operationContext(),
  );
  assert.equal(overlapping.ok, true);

  const [first, second] = fixture.coordinator.projection(ROOT.sessionId).followup;
  assert.deepEqual(first?.content.inlineReferences, [
    { kind: 'workspace_file', value: '@src/b', label: 'src/b', start: 0 },
    { kind: 'workspace_file', value: '@src/a', label: 'src/a', start: 7 },
  ]);
  assert.deepEqual(second?.content.inlineReferences, [
    { kind: 'workspace_file', value: '@src/a.ts', label: 'src/a.ts', start: 0 },
  ]);
});

test('entry promote moves a follow-up into the steering queue', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  await submit(fixture, 'follow-1', 'first', 'next_turn');
  await submit(fixture, 'follow-2', 'second', 'next_turn');

  const promoted = await fixture.coordinator.handlers['queue.entry.promote'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-2',
      promoteId: 'promote-1',
    },
    operationContext(),
  );
  assert.equal(promoted.ok, true);
  const projection = fixture.coordinator.projection(ROOT.sessionId);
  assert.deepEqual(
    projection.steering.map((entry) => [entry.messageId, entry.placement]),
    [['follow-2', 'current_turn']],
  );
  assert.deepEqual(
    projection.followup.map((entry) => entry.messageId),
    ['follow-1'],
  );

  const retry = await fixture.coordinator.handlers['queue.entry.promote'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-2',
      promoteId: 'promote-1',
    },
    operationContext(),
  );
  assert.deepEqual(retry, promoted);

  const again = await fixture.coordinator.handlers['queue.entry.promote'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-2',
      promoteId: 'promote-2',
    },
    operationContext(),
  );
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.error.code, 'operation_conflict');

  const leases = owner.pull();
  assert.deepEqual(
    leases.map((lease) => lease.messageId),
    ['follow-2'],
  );
  owner.ack(leases.map((lease) => lease.id));
  owner.release();

  const retracted = await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-promote' },
    operationContext(),
  );
  assert.equal(retracted.ok, true);
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  assert.equal(fixture.liveResidencies(), 0);
});

test('a carried follow-up promoted in its successor requeues after nack', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const firstOwner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'first-successor', 'first', 'next_turn');
  await submit(fixture, 'carried-followup', 'second', 'next_turn');
  firstOwner.release();
  const firstBatch = fixture.coordinator.beginTerminalTransition(ROOT);
  const successor = { sessionId: ROOT.sessionId, turnId: 'turn-2', runId: 'run-2' };
  fixture.coordinator.commitNextRoot(firstBatch, successor);
  fixture.setRootState({ kind: 'active', ...successor });

  const owner = fixture.coordinator.bindRun(successor);
  const entryId = fixture.coordinator.projection(ROOT.sessionId).followup[0]?.entryId;
  assert.ok(entryId);
  const promoted = await fixture.coordinator.handlers['queue.entry.promote'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId,
      promoteId: 'promote-carried-for-nack',
    },
    operationContext(),
  );
  assert.equal(promoted.ok, true);
  const leases = owner.pull();
  assert.deepEqual(
    leases.map((lease) => lease.messageId),
    ['carried-followup'],
  );
  owner.nack(leases.map((lease) => lease.id));
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).steering.map((entry) => entry.messageId),
    ['carried-followup'],
  );
});

test('an acked carried follow-up is not redelivered after restart', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const firstOwner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'first-successor', 'first', 'next_turn');
  await submit(fixture, 'carried-followup', 'second', 'next_turn');
  firstOwner.release();
  const firstBatch = fixture.coordinator.beginTerminalTransition(ROOT);
  const successor = { sessionId: ROOT.sessionId, turnId: 'turn-2', runId: 'run-2' };
  fixture.coordinator.commitNextRoot(firstBatch, successor);
  fixture.setRootState({ kind: 'active', ...successor });

  const owner = fixture.coordinator.bindRun(successor);
  const entryId = fixture.coordinator.projection(ROOT.sessionId).followup[0]?.entryId;
  assert.ok(entryId);
  const promoted = await fixture.coordinator.handlers['queue.entry.promote'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId,
      promoteId: 'promote-carried-for-ack',
    },
    operationContext(),
  );
  assert.equal(promoted.ok, true);
  const leases = owner.pull();
  assert.equal(leases.length, 1);
  owner.ack(leases.map((lease) => lease.id));
  fixture.events.push({
    ...steeringEvent('carried-followup', 'second'),
    turnId: successor.turnId,
    runId: successor.runId,
  });

  await fixture.coordinator.materializeMessageHandoffsForRun({
    ...successor,
    messageIds: [],
  });
  assert.equal(fixture.readMessageAdmission('carried-followup'), undefined);
  await fixture.admissions.markMessagesHandedOff({
    sessionId: ROOT.sessionId,
    messageIds: ['first-successor'],
    turnId: successor.turnId,
  });
  fixture.setRootState({ kind: 'idle' });
  await fixture.coordinator.recoverPendingAfterHostRestart([ROOT.sessionId]);
  assert.deepEqual(fixture.recoveredBatches, []);
});

test('editing a promoted entry preserves its original submitted placement', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);

  await submit(fixture, 'follow-1', 'first', 'next_turn');
  const promoted = await fixture.coordinator.handlers['queue.entry.promote'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-1',
      promoteId: 'promote-edit',
    },
    operationContext(),
  );
  assert.equal(promoted.ok, true);

  const updated = await fixture.coordinator.handlers['queue.entry.update'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-1',
      updateId: 'update-promoted',
      expectedQueueRevision: 2,
      text: 'edited after promotion',
    },
    operationContext(),
  );
  assert.equal(updated.ok, true);
  const admission = fixture.readMessageAdmission('follow-1');
  assert.ok(admission);
  assert.equal(admission.submittedPlacement, 'next_turn');
  assert.equal(admission.placement, 'current_turn');
  assert.equal(admission.disposition, 'steering');
  assert.deepEqual(admission.content, { text: 'edited after promotion' });
  assert.equal(
    admission.submittedContentDigest,
    messageContentDigest({ text: 'edited after promotion' }),
  );
});

test('entry promote requires an active Turn', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);

  await submit(fixture, 'follow-1', 'first', 'next_turn');
  fixture.setRootState({ kind: 'idle' });

  const promoted = await fixture.coordinator.handlers['queue.entry.promote'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-1',
      promoteId: 'promote-idle',
    },
    operationContext(),
  );
  assert.equal(promoted.ok, false);
  if (!promoted.ok) assert.equal(promoted.error.code, 'operation_conflict');
});

test('entries reorder permutes the follow-up queue and rejects stale orders', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);

  await submit(fixture, 'follow-1', 'first', 'next_turn');
  await submit(fixture, 'follow-2', 'second', 'next_turn');
  await submit(fixture, 'follow-3', 'third', 'next_turn');
  const revisionBefore = fixture.coordinator.projection(ROOT.sessionId).queueRevision;

  const reordered = await fixture.coordinator.handlers['queue.entries.reorder'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      reorderId: 'reorder-1',
      entryIds: ['id-3', 'id-1', 'id-2'],
    },
    operationContext(),
  );
  assert.equal(reordered.ok, true);
  if (!reordered.ok) return;
  assert.equal(reordered.result.queueRevision, revisionBefore + 1);
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).followup.map((entry) => entry.messageId),
    ['follow-3', 'follow-1', 'follow-2'],
  );

  const retry = await fixture.coordinator.handlers['queue.entries.reorder'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      reorderId: 'reorder-1',
      entryIds: ['id-3', 'id-1', 'id-2'],
    },
    operationContext(),
  );
  assert.deepEqual(retry, reordered);

  const stale = await fixture.coordinator.handlers['queue.entries.reorder'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      reorderId: 'reorder-2',
      entryIds: ['id-2', 'id-1'],
    },
    operationContext(),
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, 'operation_conflict');

  const unchanged = await fixture.coordinator.handlers['queue.entries.reorder'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      reorderId: 'reorder-3',
      entryIds: ['id-3', 'id-1', 'id-2'],
    },
    operationContext(),
  );
  assert.equal(unchanged.ok, true);
  if (unchanged.ok) assert.equal(unchanged.result.queueRevision, revisionBefore + 1);

  await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-reorder' },
    operationContext(),
  );
  fixture.coordinator.abandonRootReservation(ROOT);
  await fixture.coordinator.close();
});

test('queued mutations reject a queue that is draining into the next Turn', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  await submit(fixture, 'follow-1', 'first', 'next_turn');
  await submit(fixture, 'follow-2', 'second', 'next_turn');
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);

  const retracted = await fixture.coordinator.handlers['queue.entry.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      entryId: 'id-2',
      retractId: 'retract-draining',
    },
    operationContext(),
  );
  assert.equal(retracted.ok, false);
  if (!retracted.ok) assert.equal(retracted.error.code, 'operation_conflict');

  const reordered = await fixture.coordinator.handlers['queue.entries.reorder'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      reorderId: 'reorder-draining',
      entryIds: ['id-2', 'id-1'],
    },
    operationContext(),
  );
  assert.equal(reordered.ok, false);
  if (!reordered.ok) assert.equal(reordered.error.code, 'operation_conflict');

  fixture.coordinator.commitNextRoot(batch, {
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  const after = await fixture.coordinator.handlers['queue.entries.reorder'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      reorderId: 'reorder-after-commit',
      entryIds: ['id-2'],
    },
    operationContext(),
  );
  assert.equal(after.ok, true);
  await fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'cleanup-after-commit',
    },
    operationContext(),
  );
  fixture.coordinator.abandonRootReservation({
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  await fixture.coordinator.close();
});

test('concurrent and completed submit retries share one Host-Epoch outcome', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  const submitted = submit(fixture, 'delayed-submit', 'steer now', 'current_turn');
  const retry = submit(fixture, 'delayed-submit', 'steer now', 'current_turn');
  assert.equal(retry, submitted);
  const conflict = await submit(fixture, 'delayed-submit', 'different', 'current_turn');
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, 'operation_conflict');

  const outcome = await submitted;
  assert.deepEqual(outcome, {
    ok: true,
    result: {
      disposition: 'steering',
      queueRevision: 1,
      skillInvocation: EMPTY_SKILL_INVOCATION,
    },
  });
  assert.deepEqual(await submit(fixture, 'delayed-submit', 'steer now', 'current_turn'), outcome);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
    hostEpoch: 'epoch-1',
    queueRevision: 1,
    steering: [
      {
        entryId: 'id-1',
        messageId: 'delayed-submit',
        content: { text: 'steer now' },
        placement: 'current_turn',
        state: 'queued',
      },
    ],
    followup: [],
  });

  await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-submit-cut' },
    operationContext(),
  );
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('concurrent and completed retract retries preserve one exact cut', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'steer-1', 'first', 'current_turn');
  await submit(fixture, 'steer-2', 'second', 'current_turn');
  await submit(fixture, 'follow-1', 'later', 'next_turn');
  const leases = owner.pull();
  assert.equal(leases.length, 2);
  const retracted = fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'delayed-retract',
    },
    operationContext(),
  );
  const retry = fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'delayed-retract',
    },
    operationContext(),
  );
  assert.equal(retry, retracted);

  const outcome = await retracted;
  assert.deepEqual(outcome, {
    ok: true,
    result: {
      queueRevision: 5,
      retracted: [
        {
          entryId: 'id-3',
          messageId: 'follow-1',
          content: { text: 'later' },
          placement: 'next_turn',
          state: 'retracted',
        },
      ],
    },
  });
  assert.deepEqual(await retry, outcome);
  owner.ack([leases[0]!.id]);
  owner.nack([leases[1]!.id]);

  await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-retract-cut' },
    operationContext(),
  );
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('stop delivery failure after the queue fence fail-stops and retry is prompt', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'queued-before-stop-failure', 'retract at fence', 'next_turn');
  fixture.failStopDelivery(new Error('stop delivery failed'));
  const input = {
    originHostEpoch: 'epoch-1',
    sessionId: ROOT.sessionId,
    interruptId: 'interrupt-delivery-failure',
    turnId: ROOT.turnId,
    runId: ROOT.runId,
  } as const;

  await assert.rejects(
    fixture.coordinator.handlers['turn.interrupt'](input, operationContext()),
    /stop delivery failed/,
  );
  assert.equal(fixture.drainRequests(), 1);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).followup, []);

  const retry = await fixture.coordinator.handlers['turn.interrupt'](
    input,
    operationContext('retry-after-delivery-failure'),
  );
  assert.equal(retry.ok, false);
  if (!retry.ok) assert.equal(retry.error.code, 'host_draining');

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  await fixture.coordinator.close();
});

test('an interrupt generation fence makes a late nack discard its in-flight entry', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'steer-1', 'leased', 'current_turn');
  const interruptedContent = {
    text: '<model>queued</model>',
    displayText: 'queued',
    attachments: [attachment('interrupt', 'queued.png')],
  };
  await submitContent(fixture, 'follow-1', interruptedContent, 'next_turn');
  const [lease] = owner.pull();
  assert.ok(lease);

  const interrupted = fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'interrupt-1',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
    operationContext(),
  );
  const retry = fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'interrupt-1',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
    operationContext(),
  );
  await fixture.stopClaimed.promise;

  owner.nack([lease.id]);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);
  assert.equal(fixture.liveResidencies(), 0);
  fixture.resolveTerminal({
    ...ROOT,
    status: 'cancelled',
    terminalEventId: 'terminal-1',
    abortSource: 'user_interrupt',
  });
  const [outcome, retryOutcome] = await Promise.all([interrupted, retry]);
  assert.equal(outcome.ok, true);
  assert.deepEqual(retryOutcome, outcome);
  if (outcome.ok) {
    assert.deepEqual(outcome.result.retracted, [
      {
        entryId: 'id-2',
        messageId: 'follow-1',
        content: interruptedContent,
        placement: 'next_turn',
        state: 'retracted',
      },
    ]);
  }
  assert.deepEqual(
    await fixture.coordinator.handlers['turn.interrupt'](
      {
        originHostEpoch: 'epoch-1',
        sessionId: ROOT.sessionId,
        interruptId: 'interrupt-1',
        turnId: ROOT.turnId,
        runId: ROOT.runId,
      },
      operationContext('connection-after-terminal'),
    ),
    outcome,
  );
  const identityConflict = await fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'interrupt-1',
      turnId: ROOT.turnId,
      runId: 'different-run',
    },
    operationContext(),
  );
  assert.equal(identityConflict.ok, false);
  if (!identityConflict.ok) assert.equal(identityConflict.error.code, 'operation_conflict');

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('stale interrupt deletion reclaims state after terminal transition completes first', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'consumed-before-stale', 'consume', 'current_turn');
  const [lease] = owner.pull();
  assert.ok(lease);
  owner.ack([lease.id]);
  const rootRead = fixture.delayRootState();

  const interrupted = fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'interrupt-stale',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
    operationContext(),
  );
  await rootRead.started.promise;
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  fixture.setRootState({ kind: 'idle' });
  rootRead.release.resolve(undefined);

  const outcome = await interrupted;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, 'operation_conflict');
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
    hostEpoch: 'epoch-1',
    queueRevision: 0,
    steering: [],
    followup: [],
  });
});

test('every admitted queue state retains an encodable interrupt result', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  for (let index = 0; index < 64; index += 1) {
    const admitted = await submit(fixture, `message-${index}`, 'x'.repeat(723), 'next_turn');
    assert.equal(admitted.ok && admitted.result.disposition, 'followup');
  }
  const projectionBytes = Buffer.byteLength(
    JSON.stringify(fixture.coordinator.projection(ROOT.sessionId)),
    'utf8',
  );
  assert.ok(projectionBytes > MESSAGE_QUEUE_PROJECTION_MAX_BYTES - 32);
  assert.ok(projectionBytes <= MESSAGE_QUEUE_PROJECTION_MAX_BYTES);

  const interrupted = fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'interrupt-capacity',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
    operationContext(),
  );
  await fixture.stopClaimed.promise;
  fixture.resolveTerminal({
    ...ROOT,
    status: 'failed',
    terminalEventId: 'x'.repeat(128),
    failureClass: '\0'.repeat(128),
  });
  const outcome = await interrupted;
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.retracted.length, 64);
    assert.ok(
      Buffer.byteLength(JSON.stringify(outcome.result), 'utf8') <=
        MESSAGE_OPERATION_RESULT_MAX_BYTES,
    );
  }

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('release folds unpulled steering ahead of follow-up without changing source semantics', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  const firstAttachment = attachment('first-source', 'same-name.png');
  const secondAttachment = attachment('second-source', 'same-name.png');
  const thirdAttachment = attachment('third-source', 'same-name.png');
  const firstQuotes = [
    { text: 'first excerpt', label: 'assistant', sourceTurnId: 'turn-source-1' },
    { text: 'second excerpt', sourceTurnId: 'turn-source-2' },
  ];
  const secondQuotes = [{ text: 'third excerpt', label: 'tool output' }];
  const thirdQuotes = [{ text: 'fourth excerpt', sourceTurnId: 'turn-source-3' }];
  const first = await submitContent(
    fixture,
    'steer-1',
    {
      text: '<model>first</model>',
      displayText: 'first',
      attachments: [firstAttachment],
      quotes: firstQuotes,
    },
    'current_turn',
  );
  assert.equal(first.ok, true, JSON.stringify(first));
  const third = await submitContent(
    fixture,
    'follow-1',
    {
      text: '<model>third</model>',
      displayText: 'third',
      attachments: [thirdAttachment],
      quotes: thirdQuotes,
    },
    'next_turn',
  );
  assert.equal(third.ok, true, JSON.stringify(third));
  const second = await submitContent(
    fixture,
    'steer-2',
    { text: 'second', attachments: [secondAttachment], quotes: secondQuotes },
    'current_turn',
  );
  assert.equal(second.ok, true, JSON.stringify(second));

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(batch.content, {
    text: '<model>first</model>\n\nsecond',
    displayText: 'first\n\nsecond',
    attachments: [firstAttachment, secondAttachment],
    quotes: [...firstQuotes, ...secondQuotes],
  });
  assert.deepEqual(batch.sources, [
    {
      messageId: 'steer-1',
      content: {
        text: '<model>first</model>',
        displayText: 'first',
        attachments: [firstAttachment],
        quotes: firstQuotes,
      },
      submittedContentDigest: messageContentDigest({
        text: '<model>first</model>',
        displayText: 'first',
        attachments: [firstAttachment],
        quotes: firstQuotes,
      }),
      submittedPlacement: 'current_turn',
      skillInvocation: EMPTY_SKILL_INVOCATION,
      placement: 'current_turn',
      disposition: 'steering',
    },
    {
      messageId: 'steer-2',
      content: { text: 'second', attachments: [secondAttachment], quotes: secondQuotes },
      submittedContentDigest: messageContentDigest({
        text: 'second',
        attachments: [secondAttachment],
        quotes: secondQuotes,
      }),
      submittedPlacement: 'current_turn',
      skillInvocation: EMPTY_SKILL_INVOCATION,
      placement: 'current_turn',
      disposition: 'steering',
    },
  ]);
  assert.equal(fixture.liveResidencies(), 3);

  const steeringSuccessor = {
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  };
  fixture.coordinator.commitNextRoot(batch, steeringSuccessor);
  assert.equal(fixture.liveResidencies(), 1);
  const next = fixture.coordinator.bindRun(steeringSuccessor);
  next.release();
  const followupBatch = fixture.coordinator.beginTerminalTransition(steeringSuccessor);
  assert.deepEqual(followupBatch.content, {
    text: '<model>third</model>',
    displayText: 'third',
    attachments: [thirdAttachment],
    quotes: thirdQuotes,
  });
  assert.deepEqual(
    followupBatch.sources.map((source) => source.messageId),
    ['follow-1'],
  );
  const followupSuccessor = {
    sessionId: ROOT.sessionId,
    turnId: 'turn-3',
    runId: 'run-3',
  };
  fixture.coordinator.commitNextRoot(followupBatch, followupSuccessor);
  assert.equal(fixture.liveResidencies(), 0);
  const final = fixture.coordinator.bindRun(followupSuccessor);
  final.release();
  const empty = fixture.coordinator.beginTerminalTransition({
    sessionId: ROOT.sessionId,
    turnId: 'turn-3',
    runId: 'run-3',
  });
  fixture.coordinator.completeIdle(empty);
});

test('terminal transition atomically folds messages submitted after run release', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  owner.release();
  const submitted = await submit(fixture, 'late-steer', 'next intent', 'current_turn');
  assert.equal(submitted.ok && submitted.result.disposition, 'steering');

  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(batch.sources, [
    {
      messageId: 'late-steer',
      content: { text: 'next intent' },
      submittedContentDigest: messageContentDigest({ text: 'next intent' }),
      submittedPlacement: 'current_turn',
      skillInvocation: EMPTY_SKILL_INVOCATION,
      placement: 'current_turn',
      disposition: 'steering',
    },
  ]);
  fixture.coordinator.commitNextRoot(batch, {
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  const next = fixture.coordinator.bindRun({
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  next.release();
  const empty = fixture.coordinator.beginTerminalTransition({
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  fixture.coordinator.completeIdle(empty);
});

test('run settlement hands off only steering admissions with immutable proof', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'steer-proved', 'provider must see this', 'current_turn');
  const admittedAt = fixture.readMessageAdmission('steer-proved')?.admittedAt;
  assert.ok(admittedAt);
  const [lease] = owner.pull();
  assert.ok(lease);
  owner.ack([lease.id]);
  owner.release();
  fixture.events.push(steeringEvent('steer-proved', 'provider must see this'));

  await fixture.coordinator.materializeMessageHandoffsForRun({
    sessionId: ROOT.sessionId,
    turnId: ROOT.turnId,
    runId: ROOT.runId,
    messageIds: [],
  });

  assert.equal(fixture.readMessageAdmission('steer-proved'), undefined);
  assert.deepEqual(fixture.handoffCalls, [
    {
      sessionId: ROOT.sessionId,
      messageIds: ['steer-proved'],
      turnId: ROOT.turnId,
      provenSteeringMessages: [
        {
          messageId: 'steer-proved',
          admissionTurnId: ROOT.turnId,
          admissionRunId: ROOT.runId,
          executionTurnId: ROOT.turnId,
          eventId: 'event-steer-proved',
          eventTs: 1,
          content: { text: 'provider must see this' },
          admittedAt,
        },
      ],
    },
  ]);
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('run materialization preserves exact Root source receipt fallback order', async () => {
  const fixture = createFixture();
  fixture.receipts.set('exact-root', matchingSourceReceipt('exact-root', 42));
  fixture.receipts.set('exact-second', matchingSourceReceipt('exact-second', 43));

  await fixture.coordinator.materializeMessageHandoffsForRun({
    ...ROOT,
    messageIds: ['exact-root', 'exact-second', 'exact-root'],
  });

  assert.deepEqual(fixture.handoffCalls, [
    {
      sessionId: ROOT.sessionId,
      turnId: ROOT.turnId,
      messageIds: ['exact-root', 'exact-second'],
      provenRootMessages: [
        {
          messageId: 'exact-root',
          content: { text: 'canonical exact-root' },
          admittedAt: 42,
        },
        {
          messageId: 'exact-second',
          content: { text: 'canonical exact-second' },
          admittedAt: 43,
        },
      ],
    },
  ]);
});

test('run materialization rejects the whole requested Root batch when any receipt mismatches', async () => {
  const mismatches: Array<{
    messageId: string;
    receipt?: RootTurnSourceMessageReceipt;
  }> = [
    { messageId: 'proof-less' },
    {
      messageId: 'wrong-session',
      receipt: matchingSourceReceipt('wrong-session', 10, { sessionId: 'other' }),
    },
    {
      messageId: 'wrong-turn',
      receipt: matchingSourceReceipt('wrong-turn', 11, { turnId: 'other' }),
    },
    {
      messageId: 'wrong-run',
      receipt: matchingSourceReceipt('wrong-run', 12, { runId: 'other' }),
    },
    {
      messageId: 'wrong-message',
      receipt: matchingSourceReceipt('other-message', 13),
    },
  ];

  for (const mismatch of mismatches) {
    const fixture = createFixture();
    fixture.receipts.set('exact-root', matchingSourceReceipt('exact-root', 42));
    if (mismatch.receipt) fixture.receipts.set(mismatch.messageId, mismatch.receipt);

    await assert.rejects(
      () =>
        fixture.coordinator.materializeMessageHandoffsForRun({
          ...ROOT,
          messageIds: ['exact-root', mismatch.messageId],
        }),
      (error: unknown) =>
        error instanceof RuntimeMessageAuthorityInvariantError &&
        error.message === `Root admission does not prove Message handoff ${mismatch.messageId}`,
    );
    assert.deepEqual(fixture.handoffCalls, []);
  }
});

test('a failed terminal root leaves no handed-off payload for restart recovery', async () => {
  const fixture = createFixture();
  await fixture.admissions.commitMessageAdmission({
    sessionId: ROOT.sessionId,
    turnId: ROOT.turnId,
    runId: ROOT.runId,
    messageId: 'failed-before-provider',
    content: { text: 'handed off before the provider failed' },
    submittedContentDigest: messageContentDigest({
      text: 'handed off before the provider failed',
    }),
    submittedPlacement: 'current_turn',
    placement: 'current_turn',
    disposition: 'steering',
    skillInvocation: EMPTY_SKILL_INVOCATION,
    admittedAt: 1,
  });
  fixture.events.push(
    steeringEvent('failed-before-provider', 'handed off before the provider failed'),
  );

  await fixture.coordinator.materializeMessageHandoffsForRun({
    sessionId: ROOT.sessionId,
    turnId: ROOT.turnId,
    runId: ROOT.runId,
    messageIds: [],
  });
  await fixture.coordinator.recoverPendingAfterHostRestart([ROOT.sessionId]);

  assert.equal(fixture.readMessageAdmission('failed-before-provider'), undefined);
  assert.equal(fixture.startCalls(), 0);
  await fixture.coordinator.close();
});

test('administrative drain preserves accepted entries until the terminal stop fence', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'steer-drain', 'current intent', 'current_turn');
  await submit(fixture, 'follow-drain', 'next intent', 'next_turn');

  fixture.coordinator.beginDrain();
  const rejected = await submit(fixture, 'late-drain', 'too late', 'current_turn');
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'host_draining');
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).steering.map((entry) => entry.messageId),
    ['steer-drain'],
  );
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).followup.map((entry) => entry.messageId),
    ['follow-drain'],
  );

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(batch.sources, []);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).followup, []);
  fixture.coordinator.completeIdle(batch);
  assert.equal(fixture.liveResidencies(), 0);
  await fixture.coordinator.close();
});

test('semantic retry history does not become a permanent Session admission cap', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);

  for (let index = 0; index < 65; index += 1) {
    const outcome = await fixture.coordinator.handlers['queue.retract'](
      {
        originHostEpoch: 'epoch-1',
        sessionId: ROOT.sessionId,
        retractId: `retract-${index}`,
      },
      operationContext(),
    );
    assert.equal(outcome.ok, true);
  }
});

test('submit retries use keyed Host-Epoch outcomes and durable proof while old-Epoch rich conflicts fail', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  const first = await submit(fixture, 'same-1', 'same text', 'current_turn');
  const retry = await submit(fixture, 'same-1', 'same text', 'current_turn');
  assert.deepEqual(retry, first);
  const conflict = await submit(fixture, 'same-1', 'changed', 'current_turn');
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, 'operation_conflict');
  assert.equal(fixture.coordinator.projection(ROOT.sessionId).steering.length, 1);

  fixture.receipts.set(
    'current-follow',
    sourceReceipt('current-follow', 'durable current follow-up', 'next_turn', 'followup'),
  );
  fixture.receipts.set(
    'old-follow',
    sourceReceipt(
      'old-follow',
      {
        text: '<model>durable follow-up</model>',
        displayText: 'durable follow-up',
        attachments: [attachment('proof-follow', 'proof.png')],
      },
      'next_turn',
      'followup',
    ),
  );
  const oldFollow = await submitContent(
    fixture,
    'old-follow',
    {
      text: '<model>durable follow-up</model>',
      displayText: 'durable follow-up',
      attachments: [attachment('proof-follow', 'proof.png')],
    },
    'next_turn',
    'old-epoch',
  );
  assert.deepEqual(oldFollow, {
    ok: true,
    result: { disposition: 'followup', skillInvocation: EMPTY_SKILL_INVOCATION },
  });

  fixture.events.push(
    steeringEvent('old-steer', {
      text: '<model>durable steering</model>',
      displayText: 'durable steering',
      attachments: [attachment('proof-steer', 'proof.png')],
    }),
  );
  const oldSteer = await submitContent(
    fixture,
    'old-steer',
    {
      text: '<model>durable steering</model>',
      displayText: 'durable steering',
      attachments: [attachment('proof-steer', 'proof.png')],
    },
    'current_turn',
    'old-epoch',
  );
  assert.equal(oldSteer.ok, false);
  if (!oldSteer.ok) assert.equal(oldSteer.error.code, 'outcome_unknown');

  const durableBeforeRetries = {
    receipts: structuredClone([...fixture.receipts]),
    events: structuredClone(fixture.events),
  };
  const queueBeforeRetries = structuredClone(fixture.coordinator.projection(ROOT.sessionId));
  const currentFollow = await submit(
    fixture,
    'current-follow',
    'durable current follow-up',
    'next_turn',
  );
  assert.deepEqual(currentFollow, {
    ok: true,
    result: { disposition: 'followup', skillInvocation: EMPTY_SKILL_INVOCATION },
  });
  const displayConflict = await submitContent(
    fixture,
    'old-follow',
    {
      text: '<model>durable follow-up</model>',
      displayText: 'changed display',
      attachments: [attachment('proof-follow', 'proof.png')],
    },
    'next_turn',
    'old-epoch',
  );
  assert.equal(displayConflict.ok, false);
  if (!displayConflict.ok) assert.equal(displayConflict.error.code, 'operation_conflict');
  const attachmentRefConflict = await submitContent(
    fixture,
    'old-steer',
    {
      text: '<model>durable steering</model>',
      displayText: 'durable steering',
      attachments: [attachment('changed-proof-steer', 'proof.png')],
    },
    'current_turn',
    'old-epoch',
  );
  assert.equal(attachmentRefConflict.ok, false);
  if (!attachmentRefConflict.ok) {
    assert.equal(attachmentRefConflict.error.code, 'operation_conflict');
  }
  assert.deepEqual(
    {
      receipts: [...fixture.receipts],
      events: fixture.events,
    },
    durableBeforeRetries,
  );
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), queueBeforeRetries);

  const unknown = await submit(fixture, 'old-unknown', 'not durable', 'current_turn', 'old-epoch');
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'outcome_unknown');

  const retracted = await fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'cleanup',
    },
    operationContext(),
  );
  assert.equal(retracted.ok, true);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
    hostEpoch: 'epoch-1',
    queueRevision: 0,
    steering: [],
    followup: [],
  });
  assert.deepEqual(await submit(fixture, 'same-1', 'same text', 'current_turn'), first);
  const reclaimedConflict = await submit(fixture, 'same-1', 'changed after idle', 'current_turn');
  assert.equal(reclaimedConflict.ok, false);
  if (!reclaimedConflict.ok) assert.equal(reclaimedConflict.error.code, 'operation_conflict');
});

test('old-Epoch durable receipts replay queued Skill outcomes without a queue revision', async () => {
  const fixture = createFixture();
  const skillInvocation = {
    loaded: [{ id: 'writer', name: 'Writer' }],
    failed: [{ request: 'typo', reason: 'not_found' as const }],
    receipts: [],
  };
  fixture.setMessagePreparation(async (input) => ({
    kind: 'ready',
    content: {
      text: `<invoked-skill>Writer</invoked-skill>\n\n${input.content.text}`,
      displayText: input.content.text,
    },
    skillInvocation,
  }));
  fixture.coordinator.reserveRootTurn(ROOT);
  fixture.coordinator.bindRun(ROOT);

  for (const [messageId, placement, disposition, turnId] of [
    ['durable-skill-steering', 'current_turn', 'steering', ROOT.turnId],
    ['durable-skill-followup', 'next_turn', 'followup', 'successor-turn'],
  ] as const) {
    const submittedContent = { text: `/skill:writer /skill:typo ${disposition}` };
    const submitted = await submitContent(fixture, messageId, submittedContent, placement);
    assert.equal(submitted.ok, true);
    const admission = fixture.readMessageAdmission(messageId);
    assert.ok(admission);
    const receipt = sourceReceipt(
      messageId,
      admission.content,
      placement,
      disposition,
      turnId,
      submittedContent,
      skillInvocation,
    );
    fixture.receipts.set(messageId, receipt);
    await fixture.coordinator.handoffRootSources({
      sessionId: ROOT.sessionId,
      turnId: receipt.admission.turnId,
      runId: receipt.admission.runId,
      messageIds: [messageId],
    });

    assert.deepEqual(
      await submitContent(fixture, messageId, submittedContent, placement, 'old-epoch'),
      {
        ok: true,
        result: { disposition, skillInvocation },
      },
    );
  }
});

test('old-Epoch durable proof ignores structured content key order', async () => {
  const fixture = createFixture();
  const messageId = 'ordered-content';
  const content: MessageContent = {
    text: '/skill:vision inspect the image',
    attachments: [attachment('ordered-content', 'proof.png')],
    inlineReferences: [{ kind: 'skill', value: '/skill:vision', label: 'Vision', start: 0 }],
  };
  const skillInvocation = {
    loaded: [{ id: 'vision', name: 'Vision' }],
    failed: [],
    receipts: [
      {
        invocation: 'explicit' as const,
        request: 'vision',
        success: true as const,
        ref: '/skill:vision',
        id: 'vision',
        name: 'Vision',
        scope: 'project' as const,
        source: 'maka' as const,
        truncated: false,
      },
    ],
  };
  fixture.receipts.set(
    messageId,
    sourceReceipt(
      messageId,
      content,
      'next_turn',
      'turn_started',
      'durable-turn',
      content,
      skillInvocation,
    ),
  );

  const reordered: MessageContent = {
    inlineReferences: [{ start: 0, label: 'Vision', value: '/skill:vision', kind: 'skill' }],
    attachments: [
      {
        ref: { relativePath: 'attachments/ordered-content.png', kind: 'workspace_file' },
        bytes: 10,
        mimeType: 'image/png',
        name: 'proof.png',
        kind: 'image',
      },
    ],
    text: '/skill:vision inspect the image',
  };

  assert.equal(messageContentDigest(reordered), messageContentDigest(content));
  assert.deepEqual(await submitContent(fixture, messageId, reordered, 'next_turn', 'old-epoch'), {
    ok: true,
    result: { disposition: 'turn_started', turnId: 'durable-turn', skillInvocation },
  });
});

test('old-Epoch steering proof compares ordered quote provenance before reporting ambiguity', async () => {
  const fixture = createFixture();
  const messageId = 'old-steer';
  const content = {
    text: 'durable steering',
    quotes: [
      { text: 'first durable excerpt', label: 'assistant', sourceTurnId: 'turn-source-1' },
      { text: 'second durable excerpt', sourceTurnId: 'turn-source-2' },
    ],
  };
  fixture.events.push({ ...steeringEvent(messageId, content), partial: true });

  const unknown = await submitContent(fixture, messageId, content, 'current_turn', 'old-epoch');
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'outcome_unknown');

  fixture.events.push(steeringEvent(messageId, content));
  const proven = await submitContent(fixture, messageId, content, 'current_turn', 'old-epoch');
  assert.equal(proven.ok, false);
  if (!proven.ok) assert.equal(proven.error.code, 'outcome_unknown');

  const provenanceConflict = await submitContent(
    fixture,
    messageId,
    {
      ...content,
      quotes: [content.quotes[0]!, { ...content.quotes[1]!, sourceTurnId: 'turn-source-changed' }],
    },
    'current_turn',
    'old-epoch',
  );
  assert.equal(provenanceConflict.ok, false);
  if (!provenanceConflict.ok) {
    assert.equal(provenanceConflict.error.code, 'operation_conflict');
  }
});

test('old-Epoch prepared Skill proofs retain the exact submitted message identity', async () => {
  const fixture = createFixture();
  const rawFollowup = { text: '/skill:writer first' };
  const preparedFollowup = {
    text: '<invoked-skill>Prepared</invoked-skill>',
    displayText: rawFollowup.text,
  };
  fixture.receipts.set(
    'prepared-followup',
    sourceReceipt(
      'prepared-followup',
      preparedFollowup,
      'next_turn',
      'followup',
      'durable-turn',
      rawFollowup,
    ),
  );
  const exactFollowup = await submitContent(
    fixture,
    'prepared-followup',
    rawFollowup,
    'next_turn',
    'old-epoch',
  );
  assert.deepEqual(exactFollowup, {
    ok: true,
    result: { disposition: 'followup', skillInvocation: EMPTY_SKILL_INVOCATION },
  });
  const conflictingFollowup = await submitContent(
    fixture,
    'prepared-followup',
    { text: '/skill:writer second', displayText: rawFollowup.text },
    'next_turn',
    'old-epoch',
  );
  assert.equal(conflictingFollowup.ok, false);
  if (!conflictingFollowup.ok) {
    assert.equal(conflictingFollowup.error.code, 'operation_conflict');
  }

  const rawSteering = { text: '/skill:writer steer' };
  fixture.events.push(
    steeringEvent(
      'prepared-steering',
      {
        text: '<invoked-skill>Prepared steering</invoked-skill>',
        displayText: rawSteering.text,
      },
      rawSteering,
    ),
  );
  const exactSteering = await submitContent(
    fixture,
    'prepared-steering',
    rawSteering,
    'current_turn',
    'old-epoch',
  );
  assert.equal(exactSteering.ok, false);
  if (!exactSteering.ok) assert.equal(exactSteering.error.code, 'outcome_unknown');
  const conflictingSteering = await submitContent(
    fixture,
    'prepared-steering',
    { text: '/skill:writer other', displayText: rawSteering.text },
    'current_turn',
    'old-epoch',
  );
  assert.equal(conflictingSteering.ok, false);
  if (!conflictingSteering.ok) {
    assert.equal(conflictingSteering.error.code, 'operation_conflict');
  }
});

test('old-Epoch retries prove each submitted message in a prepared follow-up batch', async () => {
  const fixture = createFixture();
  const raw = [{ text: '/skill:writer first' }, { text: '/skill:writer second' }] as const;
  const prepared = raw.map((content, index) => ({
    text: `<invoked-skill>Prepared ${index + 1}</invoked-skill>`,
    displayText: content.text,
  }));
  const sourceMessages = prepared.map((content, index) => ({
    messageId: `prepared-batch-${index + 1}`,
    content,
    submittedContentDigest: messageContentDigest(raw[index]!),
    placement: 'next_turn' as const,
    disposition: 'followup' as const,
  }));
  const admission: RootTurnSourceMessageReceipt['admission'] = {
    schemaVersion: 1,
    sessionId: ROOT.sessionId,
    turnId: 'durable-batch-turn',
    runId: 'durable-batch-run',
    userMessageId: 'durable-batch-user-message',
    execution: {
      kind: 'external_message',
      inputDigest: messageContentDigest({ text: raw.map((content) => content.text).join('\n\n') }),
    },
    previousRootTurnId: ROOT.turnId,
    normalizedInput: {
      text: prepared.map((content) => content.text).join('\n\n'),
      displayText: prepared.map((content) => content.displayText).join('\n\n'),
    },
    sourceMessages,
    admittedAt: 1,
  };
  for (const sourceMessage of sourceMessages) {
    fixture.receipts.set(sourceMessage.messageId, { admission, sourceMessage });
  }

  for (const [index, content] of raw.entries()) {
    const exact = await submitContent(
      fixture,
      `prepared-batch-${index + 1}`,
      content,
      'next_turn',
      'old-epoch',
    );
    assert.deepEqual(exact, {
      ok: true,
      result: { disposition: 'followup', skillInvocation: EMPTY_SKILL_INVOCATION },
    });
  }
  const conflict = await submitContent(
    fixture,
    'prepared-batch-1',
    { text: '/skill:writer changed', displayText: raw[0].text },
    'next_turn',
    'old-epoch',
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, 'operation_conflict');
});

test('canonical content preserves ordered attachment and quote identity across queue projections', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  const firstAttachment = attachment('first', 'same-name.png');
  const secondAttachment = attachment('second', 'same-name.png');
  const steeringQuotes = [
    { text: 'first quote', label: 'assistant', sourceTurnId: 'turn-source-1' },
    { text: 'second quote', sourceTurnId: 'turn-source-2' },
  ];
  const followupQuotes = [{ text: 'follow-up quote', label: 'user selection' }];

  const submitted = await submitContent(
    fixture,
    'rich-steer',
    {
      text: '<model>first</model>',
      displayText: 'first',
      attachments: [firstAttachment, secondAttachment],
      quotes: steeringQuotes,
    },
    'current_turn',
  );
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const reordered = await submitContent(
    fixture,
    'rich-steer',
    {
      text: '<model>first</model>',
      displayText: 'first',
      attachments: [secondAttachment, firstAttachment],
      quotes: steeringQuotes,
    },
    'current_turn',
  );
  assert.equal(reordered.ok, false);
  if (!reordered.ok) assert.equal(reordered.error.code, 'operation_conflict');
  const quoteOrderConflict = await submitContent(
    fixture,
    'rich-steer',
    {
      text: '<model>first</model>',
      displayText: 'first',
      attachments: [firstAttachment, secondAttachment],
      quotes: [...steeringQuotes].reverse(),
    },
    'current_turn',
  );
  assert.equal(quoteOrderConflict.ok, false);
  if (!quoteOrderConflict.ok) assert.equal(quoteOrderConflict.error.code, 'operation_conflict');
  const followup = await submitContent(
    fixture,
    'rich-followup',
    {
      text: '<model>later</model>',
      displayText: 'later',
      quotes: followupQuotes,
    },
    'next_turn',
  );
  assert.equal(followup.ok, true);

  const projection = fixture.coordinator.projection(ROOT.sessionId);
  assert.deepEqual(projection.steering[0]?.content, {
    text: '<model>first</model>',
    displayText: 'first',
    attachments: [firstAttachment, secondAttachment],
    quotes: steeringQuotes,
  });
  assert.deepEqual(projection.followup[0]?.content, {
    text: '<model>later</model>',
    displayText: 'later',
    quotes: followupQuotes,
  });

  const [lease] = owner.pull();
  assert.ok(lease);
  assert.deepEqual(lease.content, {
    text: '<model>first</model>',
    displayText: 'first',
    attachments: [firstAttachment, secondAttachment],
    quotes: steeringQuotes,
  });
  const retracted = await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-rich-followup' },
    operationContext(),
  );
  assert.equal(retracted.ok, true);
  if (retracted.ok) {
    assert.deepEqual(retracted.result.retracted[0]?.content, projection.followup[0]?.content);
  }
  owner.ack([lease.id]);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('canonical retry omits redundant display text and empty ordered refs', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  const first = await submitContent(
    fixture,
    'canonical',
    { text: 'same', displayText: 'same', attachments: [], quotes: [] },
    'current_turn',
  );
  assert.deepEqual(
    await submitContent(fixture, 'canonical', { text: 'same' }, 'current_turn'),
    first,
  );
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering[0]?.content, {
    text: 'same',
  });

  const retracted = await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup' },
    operationContext(),
  );
  assert.equal(retracted.ok, true);
  if (retracted.ok) {
    assert.deepEqual(retracted.result.retracted[0]?.content, { text: 'same' });
  }
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

function createFixture(
  onProjectionChanged?: (sessionId: string) => void,
  preflightSessionSnapshot: HostMessageCoordinatorOptions['preflightSessionSnapshot'] = () => true,
  admissionsOverride?: MessageAdmissionStore,
) {
  let nextId = 1;
  let liveResidencies = 0;
  let startCalls = 0;
  let drainRequests = 0;
  let stopDeliveryError: Error | undefined;
  let prepareMessage: NonNullable<HostMessageRootPort['prepareMessage']> = async (input) => ({
    kind: 'ready',
    content: input.content,
    skillInvocation: { loaded: [], failed: [], receipts: [] },
  });
  let rootState: HostMessageRootState = { kind: 'active', ...ROOT };
  let rootStateDelay:
    | {
        readonly started: ReturnType<typeof deferred<void>>;
        readonly release: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  const receipts = new Map<string, RootTurnSourceMessageReceipt>();
  const recoveredBatches: HostMessageRecoveryBatch[] = [];
  const events: RuntimeEvent[] = [];
  const messageAdmissions = new Map<
    string,
    {
      admission: PendingMessageAdmission;
      state: 'accepted' | 'handed_off' | 'executed' | 'cancelled';
    }
  >();
  const handoffCalls: MarkMessagesHandedOffInput[] = [];
  const admissions =
    admissionsOverride ??
    memoryMessageAdmissionStore(messageAdmissions, (input) => {
      handoffCalls.push(input);
    });
  const sessionAdmission = new SessionAdmissionGate();
  const stopClaimed = deferred<void>();
  const terminal = deferred<TurnSnapshot>();
  let coordinator: HostMessageCoordinator;
  const root: HostMessageRootPort = {
    readSessionHeader: async () => {
      return { isArchived: false };
    },
    readRootState: async () => {
      const delay = rootStateDelay;
      if (delay) {
        rootStateDelay = undefined;
        delay.started.resolve(undefined);
        await delay.release.promise;
      }
      return rootState;
    },
    claimStopFence: async (_input, commitQueueFence) => {
      commitQueueFence();
      return {
        ready: Promise.resolve(),
        deliverStop: async () => {
          stopClaimed.resolve(undefined);
          if (stopDeliveryError) throw stopDeliveryError;
        },
      };
    },
    startFromMessage: async (input) => {
      startCalls += 1;
      const turnId = 'idle-turn';
      const skillInvocation = input.preparedSkillInvocation ?? EMPTY_SKILL_INVOCATION;
      // Store the source message the coordinator actually produced. Rebuilding
      // one from parts drops whatever the coordinator recorded about the
      // submit, which is the very thing a retry is compared against.
      const receipt = sourceReceipt(
        input.sourceMessage.messageId,
        input.sourceMessage.content,
        input.sourceMessage.placement,
        'turn_started',
        turnId,
      );
      receipts.set(input.sourceMessage.messageId, {
        admission: {
          ...receipt.admission,
          skillInvocation,
          sourceMessages: [
            {
              ...input.sourceMessage,
              content: input.content,
              skillInvocation,
            },
          ],
          ...(input.turnOrchestration ? { turnOrchestration: input.turnOrchestration } : {}),
        },
        sourceMessage: {
          ...input.sourceMessage,
          content: input.content,
          skillInvocation,
        },
      });
      rootState = { kind: 'active', sessionId: input.sessionId, turnId, runId: 'idle-run' };
      coordinator.reserveRootTurn(rootState);
      return { turnId, skillInvocation };
    },
    startRecoveredMessages: async (input) => {
      recoveredBatches.push(input);
      const turnId = 'recovered-turn';
      // Recovery admits a root Turn from the reconstructed sources, so the
      // durable receipt a later retry is compared against is written here too.
      // Skipping it would leave the retry with nothing to disagree with.
      for (const source of input.sources) {
        const receipt = sourceReceipt(
          source.messageId,
          source.content,
          source.placement,
          source.disposition,
          turnId,
        );
        receipts.set(source.messageId, {
          admission: {
            ...receipt.admission,
            sourceMessages: [source],
            ...(input.submittedIntent?.turnOrchestration
              ? { turnOrchestration: input.submittedIntent.turnOrchestration }
              : {}),
          },
          sourceMessage: source,
        });
      }
      rootState = { kind: 'active', sessionId: input.sessionId, turnId, runId: 'recovered-run' };
      coordinator.reserveRootTurn(rootState);
      return { turnId };
    },
    prepareMessage: (input) => prepareMessage(input),
    claimStop: async (_input, commitQueueFence) => {
      commitQueueFence();
      return {
        deliverStop: () => Promise.resolve(),
        terminal: terminal.promise,
      };
    },
  };
  const options: HostMessageCoordinatorOptions = {
    hostEpoch: 'epoch-1',
    root,
    durableProof: {
      readRootTurnSourceMessageReceipt: async (_sessionId, messageId) => receipts.get(messageId),
      readImmutableSteeringMessageProof: async (_sessionId, messageId) => {
        const event = events.find(
          (candidate) =>
            candidate.partial === false &&
            candidate.refs?.providerEventId === messageId &&
            candidate.content?.kind === 'text' &&
            candidate.content.steering === true,
        );
        return event ? { event } : undefined;
      },
    },
    admissions,
    sessionAdmission,
    acquireResidency: () => {
      liveResidencies += 1;
      let released = false;
      return {
        release: () => {
          assert.equal(released, false);
          released = true;
          liveResidencies -= 1;
        },
      };
    },
    requestDrain: () => {
      drainRequests += 1;
    },
    ...(onProjectionChanged ? { onProjectionChanged } : {}),
    preflightSessionSnapshot,
    createId: () => `id-${nextId++}`,
  };
  coordinator = new HostMessageCoordinator(options);
  return {
    coordinator,
    admissions,
    sessionAdmission,
    setRootState: (state: HostMessageRootState) => {
      rootState = state;
    },
    setMessagePreparation: (prepare: NonNullable<HostMessageRootPort['prepareMessage']>) => {
      prepareMessage = prepare;
    },
    startCalls: () => startCalls,
    events,
    receipts,
    recoveredBatches,
    handoffCalls,
    readMessageAdmission: (messageId: string) => messageAdmissions.get(messageId)?.admission,
    stopClaimed,
    resolveTerminal: terminal.resolve,
    liveResidencies: () => liveResidencies,
    drainRequests: () => drainRequests,
    failStopDelivery: (error: Error) => {
      stopDeliveryError = error;
    },
    delayRootState: () => {
      const delay = { started: deferred<void>(), release: deferred<void>() };
      rootStateDelay = delay;
      return delay;
    },
  };
}

function memoryMessageAdmissionStore(
  admissions: Map<
    string,
    {
      admission: PendingMessageAdmission;
      state: 'accepted' | 'handed_off' | 'executed' | 'cancelled';
    }
  >,
  onMessagesHandedOff?: (input: MarkMessagesHandedOffInput) => void,
): MessageAdmissionStore {
  const cancellationClaims = new Map<string, string>();
  return {
    commitMessageAdmission: async (admission) => {
      const existing = admissions.get(admission.messageId);
      if (existing) return existing.admission;
      admissions.set(admission.messageId, { admission, state: 'accepted' });
      return admission;
    },
    readMessageAdmission: async (_sessionId, messageId) => admissions.get(messageId)?.admission,
    hasCancelledMessageAdmission: async (_sessionId, messageId) =>
      admissions.get(messageId)?.state === 'cancelled',
    claimMessageAdmissionCancellation: async (_sessionId, messageId, claimId) => {
      const existing = admissions.get(messageId);
      if (existing?.state === 'cancelled') {
        return cancellationClaims.get(messageId) === claimId ? 'same_claim' : 'already_cancelled';
      }
      if (!existing) throw new Error(`Missing admission ${messageId}`);
      existing.state = 'cancelled';
      cancellationClaims.set(messageId, claimId);
      return 'cancelled_by_claim';
    },
    listMessageAdmissions: async (sessionId) =>
      [...admissions.values()]
        .filter(({ admission, state }) => admission.sessionId === sessionId && state === 'accepted')
        .map(({ admission }) => admission),
    updateMessageAdmission: async (admission) => {
      const existing = admissions.get(admission.messageId);
      if (!existing) throw new Error(`Missing admission ${admission.messageId}`);
      if (
        existing.admission.turnId !== admission.turnId ||
        existing.admission.runId !== admission.runId ||
        existing.admission.submittedPlacement !== admission.submittedPlacement ||
        existing.admission.admittedAt !== admission.admittedAt
      ) {
        throw new Error(`Message admission update identity conflict: ${admission.messageId}`);
      }
      existing.admission = admission;
    },
    reorderMessageAdmissions: async () => undefined,
    cancelMessageAdmissions: async (_sessionId, messageIds) => {
      for (const messageId of messageIds) {
        const existing = admissions.get(messageId);
        if (existing && (existing.state === 'accepted' || existing.state === 'handed_off')) {
          existing.state = 'cancelled';
        }
      }
    },
    markMessagesHandedOff: async (input) => {
      onMessagesHandedOff?.(input);
      const { messageIds } = input;
      for (const messageId of messageIds) admissions.delete(messageId);
    },
  };
}

function submit(
  fixture: ReturnType<typeof createFixture>,
  messageId: string,
  text: string,
  placement: 'current_turn' | 'next_turn',
  originHostEpoch = 'epoch-1',
) {
  return submitContent(fixture, messageId, { text }, placement, originHostEpoch);
}

function submitContent(
  fixture: ReturnType<typeof createFixture>,
  messageId: string,
  content: MessageContent,
  placement: 'current_turn' | 'next_turn',
  originHostEpoch = 'epoch-1',
) {
  return fixture.coordinator.handlers['turn.message.submit'](
    {
      originHostEpoch,
      sessionId: ROOT.sessionId,
      messageId,
      content,
      placement,
    },
    operationContext(),
  );
}

function sourceReceipt(
  messageId: string,
  content: MessageContent | string,
  placement: 'current_turn' | 'next_turn',
  disposition: 'steering' | 'followup' | 'turn_started',
  turnId = 'durable-turn',
  submittedContent?: MessageContent,
  skillInvocation?: SkillInvocationResult,
): RootTurnSourceMessageReceipt {
  const normalizedContent = typeof content === 'string' ? { text: content } : content;
  const sourceMessage = {
    messageId,
    content: normalizedContent,
    ...(submittedContent ? { submittedContentDigest: messageContentDigest(submittedContent) } : {}),
    placement,
    disposition,
  };
  return {
    admission: {
      schemaVersion: 1,
      sessionId: ROOT.sessionId,
      turnId,
      runId: 'durable-run',
      userMessageId: 'durable-user-message',
      execution: {
        kind: 'external_message',
        ...(submittedContent ? { inputDigest: messageContentDigest(submittedContent) } : {}),
      },
      previousRootTurnId: ROOT.turnId,
      normalizedInput: normalizedContent,
      ...(skillInvocation ? { skillInvocation } : {}),
      sourceMessages: [sourceMessage],
      admittedAt: 1,
    },
    sourceMessage,
  };
}

function matchingSourceReceipt(
  messageId: string,
  admittedAt: number,
  overrides: Partial<RootTurnSourceMessageReceipt['admission']> = {},
): RootTurnSourceMessageReceipt {
  const base = sourceReceipt(
    messageId,
    { text: `canonical ${messageId}` },
    'current_turn',
    'steering',
    ROOT.turnId,
  );
  return {
    ...base,
    admission: {
      ...base.admission,
      runId: ROOT.runId,
      admittedAt,
      ...overrides,
    },
  };
}

function steeringEvent(
  messageId: string,
  content: MessageContent | string,
  submittedContent?: MessageContent,
): RuntimeEvent {
  const normalizedContent = typeof content === 'string' ? { text: content } : content;
  return {
    id: `event-${messageId}`,
    invocationId: 'invocation-1',
    runId: ROOT.runId,
    sessionId: ROOT.sessionId,
    turnId: ROOT.turnId,
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', ...normalizedContent, steering: true },
    refs: {
      providerEventId: messageId,
      ...(submittedContent ? { sourceMessageDigest: messageContentDigest(submittedContent) } : {}),
    },
  };
}

function largeSkillInvocation() {
  const loaded = Array.from({ length: 40 }, (_, index) => ({
    id: `skill-${index}-${'i'.repeat(60)}`,
    name: `Skill ${index} ${'n'.repeat(120)}`,
  }));
  return {
    loaded,
    failed: [],
    receipts: loaded.map((skill, index) => ({
      invocation: 'explicit' as const,
      request: `request-${index}-${'q'.repeat(280)}`,
      success: true as const,
      ref: `project:maka:${index}:${'r'.repeat(280)}`,
      id: skill.id,
      name: skill.name,
      scope: 'project' as const,
      source: 'maka' as const,
      truncated: false,
    })),
  };
}

function attachment(id: string, name: string) {
  return {
    kind: 'image' as const,
    name,
    mimeType: 'image/png',
    bytes: 10,
    ref: { kind: 'workspace_file' as const, relativePath: `attachments/${id}.png` },
  };
}

function operationContext(connectionId = 'connection-1') {
  return {
    hostEpoch: 'epoch-1',
    connectionId,
    principal: 'local_os_user' as const,
    acquireResidency: () => ({ release: () => undefined }),
  };
}
test('a lone folded steering entry leaves the queue projection decodable', async () => {
  // A steer the run never pulls is folded into `followup` at the terminal
  // transition. It has to arrive there as a followup entry: the wire decoder
  // requires `next_turn`, and an undecodable projection takes down the whole
  // Host by way of the session continuity snapshot (#3530).
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  const submitted = await submitContent(
    fixture,
    'lone-steer',
    { text: 'late steer', displayText: 'late steer' },
    'current_turn',
  );
  assert.equal(submitted.ok, true, JSON.stringify(submitted));

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);

  const projection = fixture.coordinator.projection(ROOT.sessionId);
  assert.deepEqual(projection.steering, []);
  assert.equal(projection.followup.length, 1);
  assert.equal(projection.followup[0]?.placement, 'next_turn');
  assert.doesNotThrow(() => decodeSessionMessageQueueProjection(projection));

  // Durable provenance is unchanged: the source still records where the
  // message was aimed, which is what makes the fold auditable.
  assert.equal(batch.sources.length, 1);
  assert.equal(batch.sources[0]?.placement, 'current_turn');
  assert.equal(batch.sources[0]?.disposition, 'steering');

  fixture.coordinator.commitNextRoot(batch, {
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
});
