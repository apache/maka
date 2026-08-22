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
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import {
  RuntimeHostOperationError,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import type {
  OperationInput,
  OperationKey,
  SessionCatalogProjection,
} from '@maka/runtime-host/protocol';
import {
  DesktopRuntimeHostClient,
  DesktopRuntimeHostClientError,
} from '../runtime-host-client.js';

test('restarts a paginated catalog read instead of mixing revisions', async () => {
  const revisionOne = catalogRevision('1');
  const revisionTwo = catalogRevision('2');
  const { client, requests } = clientWithResponses([
    {
      kind: 'page',
      revision: revisionOne,
      sessions: [session('stale', 1)],
      nextCursor: 'stale-cursor',
    },
    {
      kind: 'revision_changed',
      expectedRevision: revisionOne,
      actualRevision: revisionTwo,
    },
    {
      kind: 'page',
      revision: revisionTwo,
      sessions: [session('fresh-1', 2)],
      nextCursor: 'fresh-cursor',
    },
    {
      kind: 'page',
      revision: revisionTwo,
      sessions: [session('fresh-2', 1)],
      nextCursor: null,
    },
  ]);

  assert.deepEqual(
    (await client.listSessions()).map(({ id }) => id),
    ['fresh-1', 'fresh-2'],
  );
  assert.deepEqual(requests, [
    {
      operation: 'session.catalog.query',
      input: { kind: 'list_start' },
    },
    {
      operation: 'session.catalog.query',
      input: {
        kind: 'list_continue',
        revision: revisionOne,
        cursor: 'stale-cursor',
      },
    },
    {
      operation: 'session.catalog.query',
      input: { kind: 'list_start' },
    },
    {
      operation: 'session.catalog.query',
      input: {
        kind: 'list_continue',
        revision: revisionTwo,
        cursor: 'fresh-cursor',
      },
    },
  ]);
});

test('re-reads the Session revision before retrying a product update', async () => {
  const { client, requests } = clientWithResponses([
    { kind: 'session', session: session('session-1', 4) },
    { kind: 'revision_conflict', expectedRevision: 4, actualRevision: 5 },
    { kind: 'session', session: session('session-1', 5) },
    { kind: 'committed', session: session('session-1', 6, { name: 'Renamed' }) },
  ]);

  const updated = await client.updateSessionMetadata('session-1', { name: 'Renamed' });

  assert.equal(updated.revision, 6);
  assert.equal(updated.name, 'Renamed');
  assert.deepEqual(requests, [
    {
      operation: 'session.catalog.query',
      input: { kind: 'get', sessionId: 'session-1' },
    },
    {
      operation: 'session.metadata.update',
      input: {
        sessionId: 'session-1',
        expectedRevision: 4,
        patch: { name: 'Renamed' },
      },
    },
    {
      operation: 'session.catalog.query',
      input: { kind: 'get', sessionId: 'session-1' },
    },
    {
      operation: 'session.metadata.update',
      input: {
        sessionId: 'session-1',
        expectedRevision: 5,
        patch: { name: 'Renamed' },
      },
    },
  ]);
});

test('settles cleanup when its copy target is already absent', async () => {
  const { client } = clientWithResponses([{ kind: 'session', session: null }]);

  assert.equal(await client.removeSessionCopy('lost-copy-response'), 'removed');
});

test('settles branch cleanup when its target disappears between catalog reads', async () => {
  const { client } = clientWithResponses([
    { kind: 'session', session: session('branch-copy', 1) },
    { kind: 'session', session: null },
  ]);

  assert.equal(await client.removeSessionCopy('branch-copy'), 'removed');
});

test('settles revision cleanup when abandon observes an already absent target', async () => {
  const { client } = clientWithResponses([
    {
      kind: 'session',
      session: session('revision-copy', 1, { revisionOfTurnId: 'source-turn' }),
    },
    new RuntimeHostOperationError(
      'session.revision.abandon',
      'not_found',
      'Revision copy is already absent',
    ),
  ]);

  assert.equal(await client.removeSessionCopy('revision-copy'), 'removed');
});

test('merges a configuration patch into each fresh CAS projection', async () => {
  const { client, requests } = clientWithResponses([
    { kind: 'session', session: session('session-1', 10) },
    { kind: 'revision_conflict', expectedRevision: 10, actualRevision: 11 },
    {
      kind: 'session',
      session: session('session-1', 11, { collaborationMode: 'plan' }),
    },
    {
      kind: 'committed',
      session: session('session-1', 12, {
        collaborationMode: 'plan',
        permissionMode: 'execute',
      }),
    },
  ]);

  const updated = await client.updateSessionConfiguration('session-1', {
    permissionMode: 'execute',
  });

  assert.equal(updated.permissionMode, 'execute');
  assert.equal(updated.collaborationMode, 'plan');
  assert.deepEqual(
    requests
      .filter(({ operation }) => operation === 'session.configuration.update')
      .map(({ input }) => input),
    [
      {
        sessionId: 'session-1',
        expectedRevision: 10,
        configuration: {
          modelTarget: {
            kind: 'explicit',
            connectionSlug: 'test-connection',
            model: 'test-model',
          },
          thinkingLevel: null,
          permissionMode: 'execute',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        },
      },
      {
        sessionId: 'session-1',
        expectedRevision: 11,
        configuration: {
          modelTarget: {
            kind: 'explicit',
            connectionSlug: 'test-connection',
            model: 'test-model',
          },
          thinkingLevel: null,
          permissionMode: 'execute',
          collaborationMode: 'plan',
          orchestrationMode: 'default',
        },
      },
    ],
  );
});

test('retries a Session update through transient revision churn', async () => {
  const responses: unknown[] = [];
  for (let revision = 10; revision < 14; revision += 1) {
    responses.push(
      { kind: 'session', session: session('session-1', revision) },
      {
        kind: 'revision_conflict',
        expectedRevision: revision,
        actualRevision: revision + 1,
      },
    );
  }
  responses.push(
    { kind: 'session', session: session('session-1', 14) },
    {
      kind: 'committed',
      session: session('session-1', 15, { collaborationMode: 'plan' }),
    },
  );
  const { client } = clientWithResponses(responses);

  const updated = await client.updateSessionConfiguration('session-1', {
    collaborationMode: 'plan',
  });

  assert.equal(updated.revision, 15);
  assert.equal(updated.collaborationMode, 'plan');
});

test('abandons a remove whose task was restored under it', async () => {
  // A lifecycle write bumps the revision, so the conflict IS the restore: the
  // premise the caller decided on ("this task is archived") no longer holds,
  // and replaying the delete at the fresh revision destroys a task somebody
  // just pulled back out of the archive.
  const { client, requests } = clientWithResponses([
    { kind: 'session', session: session('session-1', 4, { isArchived: true }) },
    { kind: 'revision_conflict', expectedRevision: 4, actualRevision: 5 },
    { kind: 'session', session: session('session-1', 5, { isArchived: false }) },
    // Only a replayed delete reaches this, and reaching it is the defect.
    { kind: 'removed' },
  ]);

  assert.equal(await client.removeSession('session-1', { requireArchived: true }), 'restored');
  assert.deepEqual(
    requests.map(({ operation }) => operation),
    ['session.catalog.query', 'session.remove', 'session.catalog.query'],
  );
});

test('retries a remove through revision churn that left the task archived', async () => {
  // Not every conflict is a restore. A task still archived at the fresh
  // revision was only written around, and the delete still means what it did.
  const { client, requests } = clientWithResponses([
    { kind: 'session', session: session('session-1', 4, { isArchived: true }) },
    { kind: 'revision_conflict', expectedRevision: 4, actualRevision: 5 },
    { kind: 'session', session: session('session-1', 5, { isArchived: true }) },
    { kind: 'removed' },
  ]);

  assert.equal(await client.removeSession('session-1', { requireArchived: true }), 'removed');
  assert.deepEqual(
    requests.filter(({ operation }) => operation === 'session.remove').map(({ input }) => input),
    [
      { sessionId: 'session-1', expectedRevision: 4 },
      { sessionId: 'session-1', expectedRevision: 5 },
    ],
  );
});

test('removes a task that was never archived when no premise was stated', async () => {
  // Deleting an active task from the rail has no archived premise to lose, so
  // the precondition is the caller's to ask for, not the client's to assume.
  const { client } = clientWithResponses([
    { kind: 'session', session: session('session-1', 4) },
    { kind: 'removed' },
  ]);

  assert.equal(await client.removeSession('session-1'), 'removed');
});

test('rebuilds a Runtime Policy mutation from each fresh CAS projection', async () => {
  const initial = createDefaultRuntimePolicy();
  const concurrent = {
    ...initial,
    personalization: {
      ...initial.personalization,
      assistantTone: 'Changed by another Client',
    },
  };
  const { client, requests } = clientWithResponses([
    { revision: 1, policy: initial },
    { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 },
    { revision: 2, policy: concurrent },
    { kind: 'committed', revision: 3 },
    {
      revision: 3,
      policy: {
        ...concurrent,
        personalization: {
          ...concurrent.personalization,
          displayName: 'Alice',
        },
      },
    },
  ]);

  await client.updateRuntimePolicy((policy) => ({
    kind: 'set_personalization',
    value: { ...policy.personalization, displayName: 'Alice' },
  }));

  assert.deepEqual(
    requests
      .filter(({ operation }) => operation === 'runtime.policy.mutate')
      .map(({ input }) => input),
    [
      {
        expectedRevision: 1,
        operation: {
          kind: 'set_personalization',
          value: { ...initial.personalization, displayName: 'Alice' },
        },
      },
      {
        expectedRevision: 2,
        operation: {
          kind: 'set_personalization',
          value: {
            ...concurrent.personalization,
            displayName: 'Alice',
          },
        },
      },
    ],
  );
});

test('treats empty configuration patches as read-only lookups', async () => {
  const unlocked = session('session-1', 10, { connectionLocked: false });
  const { client, requests } = clientWithResponses([
    { kind: 'session', session: unlocked },
    { kind: 'session', session: unlocked },
  ]);

  assert.deepEqual(await client.updateSessionConfiguration('session-1', {}), unlocked);
  assert.deepEqual(
    await client.updateSessionConfiguration('session-1', { thinkingLevel: undefined }),
    unlocked,
  );
  assert.deepEqual(requests, [
    {
      operation: 'session.catalog.query',
      input: { kind: 'get', sessionId: 'session-1' },
    },
    {
      operation: 'session.catalog.query',
      input: { kind: 'get', sessionId: 'session-1' },
    },
  ]);
});


test('binds message controls to the current Host Epoch', async () => {
  const { client, requests } = clientWithResponses([
    { disposition: 'steering', queueRevision: 2 },
    { queueRevision: 3, retracted: [] },
    {
      queueRevision: 4,
      retracted: [],
      turn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'cancelled',
        terminalEventId: 'event-1',
        abortSource: 'user',
      },
    },
  ]);

  await client.submitMessage({
    sessionId: 'session-1',
    messageId: 'message-1',
    content: { text: 'Steer it' },
    placement: 'current_turn',
  });
  await client.retractQueue({ sessionId: 'session-1', retractId: 'retract-1' });
  await client.interruptTurn({
    sessionId: 'session-1',
    interruptId: 'interrupt-1',
    turnId: 'turn-1',
    runId: 'run-1',
  });

  assert.deepEqual(requests, [
    {
      operation: 'turn.message.submit',
      input: {
        sessionId: 'session-1',
        messageId: 'message-1',
        content: { text: 'Steer it' },
        placement: 'current_turn',
        originHostEpoch: 'host-current',
      },
    },
    {
      operation: 'queue.retract',
      input: {
        sessionId: 'session-1',
        retractId: 'retract-1',
        originHostEpoch: 'host-current',
      },
    },
    {
      operation: 'turn.interrupt',
      input: {
        sessionId: 'session-1',
        interruptId: 'interrupt-1',
        turnId: 'turn-1',
        runId: 'run-1',
        originHostEpoch: 'host-current',
      },
    },
  ]);
});

test('uploads Attachment bytes in bounded Host chunks and commits the digest', async () => {
  const bytes = new Uint8Array(48 * 1024 + 3).fill(7);
  const attachment = {
    kind: 'file' as const,
    name: 'notes.txt',
    mimeType: 'text/plain',
    bytes: bytes.byteLength,
    ref: {
      kind: 'session_file' as const,
      sessionId: 'session-1',
      relativePath: 'artifact-1',
    },
  };
  const { client, requests } = clientWithResponses([
    { kind: 'upload_opened', nextOffset: 0 },
    { kind: 'chunk_accepted', nextOffset: 48 * 1024 },
    { kind: 'chunk_accepted', nextOffset: bytes.byteLength },
    { kind: 'committed', attachment },
  ]);

  assert.deepEqual(
    await client.ingestAttachment({
      sessionId: 'session-1',
      uploadId: 'upload-1',
      name: 'notes.txt',
      mimeType: 'text/plain',
      content: bytes,
    }),
    attachment,
  );
  assert.deepEqual(
    requests.map(({ operation, input }) => ({
      operation,
      kind: (input as { kind?: string }).kind,
      offset: (input as { offset?: number }).offset,
    })),
    [
      { operation: 'artifact.ingest', kind: 'begin', offset: undefined },
      { operation: 'artifact.ingest', kind: 'chunk', offset: 0 },
      { operation: 'artifact.ingest', kind: 'chunk', offset: 48 * 1024 },
      { operation: 'artifact.ingest', kind: 'commit', offset: undefined },
    ],
  );
  const begin = requests[0]?.input as { contentSha256: string; totalBytes: number };
  assert.equal(begin.totalBytes, bytes.byteLength);
  assert.match(begin.contentSha256, /^sha256:[a-f0-9]{64}$/);
});

test('aborts an opened Attachment upload when a later chunk fails', async () => {
  const requests: RecordedRequest[] = [];
  const connection = {
    hostEpoch: 'host-current',
    request: async <K extends OperationKey>(operation: K, input: OperationInput<K>) => {
      requests.push({ operation, input });
      if ((input as { kind?: string }).kind === 'begin') {
        return { kind: 'upload_opened', nextOffset: 0 };
      }
      if ((input as { kind?: string }).kind === 'abort') {
        return { kind: 'upload_aborted', uploadId: 'upload-1' };
      }
      throw new Error('chunk failed');
    },
    close: async () => undefined,
  } as unknown as RuntimeHostConnection;
  const client = new DesktopRuntimeHostClient(connection);

  await assert.rejects(
    () =>
      client.ingestAttachment({
        sessionId: 'session-1',
        uploadId: 'upload-1',
        name: 'notes.txt',
        mimeType: 'text/plain',
        content: new Uint8Array([1]),
      }),
    /chunk failed/,
  );
  assert.deepEqual(
    requests.map(({ input }) => (input as { kind: string }).kind),
    ['begin', 'chunk', 'abort'],
  );
});

test('accepts an idempotently committed Attachment upload at begin', async () => {
  const attachment = {
    kind: 'file' as const,
    name: 'notes.txt',
    mimeType: 'text/plain',
    bytes: 1,
    ref: {
      kind: 'session_file' as const,
      sessionId: 'session-1',
      relativePath: 'artifact-1',
    },
  };
  const { client, requests } = clientWithResponses([
    { kind: 'committed', uploadId: 'upload-1', attachment },
  ]);

  assert.deepEqual(
    await client.ingestAttachment({
      sessionId: 'session-1',
      uploadId: 'upload-1',
      name: 'notes.txt',
      mimeType: 'text/plain',
      content: new Uint8Array([1]),
    }),
    attachment,
  );
  assert.equal(requests.length, 1);
});

test('streams Artifact content without mixing chunk offsets or totals', async () => {
  const first = Buffer.alloc(32 * 1024, 3);
  const second = Buffer.from('tail');
  const { client, requests } = clientWithResponses([
    {
      kind: 'chunk',
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      offset: 0,
      totalBytes: first.byteLength + second.byteLength,
      chunkBase64: first.toString('base64'),
      nextOffset: first.byteLength,
    },
    {
      kind: 'chunk',
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      offset: first.byteLength,
      totalBytes: first.byteLength + second.byteLength,
      chunkBase64: second.toString('base64'),
      nextOffset: null,
    },
  ]);
  const chunks: Buffer[] = [];

  assert.equal(
    await client.streamArtifact('session-1', 'artifact-1', async (chunk) => {
      chunks.push(Buffer.from(chunk));
    }),
    first.byteLength + second.byteLength,
  );
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([first, second]));
  assert.deepEqual(
    requests.map(({ input }) => input),
    [
      {
        kind: 'read_chunk',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        offset: 0,
      },
      {
        kind: 'read_chunk',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        offset: first.byteLength,
      },
    ],
  );
});

test('restarts Session sidecar reads when a paginated revision changes', async () => {
  const taskRevisionOne = catalogRevision('3');
  const taskRevisionTwo = catalogRevision('4');
  const resourceRevisionOne = catalogRevision('5');
  const resourceRevisionTwo = catalogRevision('6');
  const { client, requests } = clientWithResponses([
    {
      kind: 'page',
      sessionId: 'session-1',
      revision: taskRevisionOne,
      tasks: [{ id: 'stale' }],
      nextCursor: 'task-stale',
    },
    { kind: 'revision_changed', expected: taskRevisionOne, actual: taskRevisionTwo },
    {
      kind: 'page',
      sessionId: 'session-1',
      revision: taskRevisionTwo,
      tasks: [{ id: 'fresh' }],
      nextCursor: null,
    },
    {
      kind: 'page',
      sessionId: 'session-1',
      storeVersion: 7,
      latestProposalId: 'proposal-stale',
      activeExecutionId: null,
      items: [{ kind: 'proposal', proposal: { proposalId: 'proposal-stale' } }],
      nextCursor: 'plan-stale',
    },
    { kind: 'revision_changed', expected: 7, actual: 8 },
    {
      kind: 'page',
      sessionId: 'session-1',
      storeVersion: 8,
      latestProposalId: 'proposal-1',
      activeExecutionId: null,
      items: [{ kind: 'proposal', proposal: { proposalId: 'proposal-1' } }],
      nextCursor: null,
    },
    {
      kind: 'page',
      sessionId: 'session-1',
      revision: resourceRevisionOne,
      resources: [{ result: { ref: 'shell:stale' } }],
      nextCursor: 'resource-stale',
    },
    { kind: 'revision_changed', expected: resourceRevisionOne, actual: resourceRevisionTwo },
    {
      kind: 'page',
      sessionId: 'session-1',
      revision: resourceRevisionTwo,
      resources: [{ result: { ref: 'shell:1' } }],
      nextCursor: null,
    },
  ]);

  assert.deepEqual(
    (await client.listTasks('session-1')).map((task) => task.id),
    ['fresh'],
  );
  const plan = await client.getPlanState('session-1');
  assert.equal(plan.storeVersion, 8);
  assert.equal(plan.latestProposalId, 'proposal-1');
  assert.equal(plan.proposals[0]?.proposalId, 'proposal-1');
  assert.equal((await client.listRuntimeResources('session-1'))[0]?.result.ref, 'shell:1');
  assert.deepEqual(
    requests.slice(0, 3).map(({ input }) => input),
    [
      { kind: 'list_start', sessionId: 'session-1' },
      {
        kind: 'list_continue',
        sessionId: 'session-1',
        revision: taskRevisionOne,
        cursor: 'task-stale',
      },
      { kind: 'list_start', sessionId: 'session-1' },
    ],
  );
});

test('retries Goal clear only while the same Goal generation remains active', async () => {
  const first = goalProjection(1);
  const second = goalProjection(2);
  const conflict = new RuntimeHostOperationError(
    'goal.control',
    'operation_conflict',
    'Goal revision changed',
  );
  const { client, requests } = clientWithResponses([
    { sessionId: 'session-1', goal: first },
    conflict,
    { sessionId: 'session-1', goal: second },
    { sessionId: 'session-1', goal: { ...second, status: 'cleared' } },
  ]);

  await client.clearGoal('session-1');

  assert.deepEqual(
    requests.filter(({ operation }) => operation === 'goal.control').map(({ input }) => input),
    [
      { sessionId: 'session-1', goalId: 'goal-1', expectedRevision: 1, action: 'clear' },
      { sessionId: 'session-1', goalId: 'goal-1', expectedRevision: 2, action: 'clear' },
    ],
  );
});

test('controlGoalWithRetry applies pause/resume with the queried revision', async () => {
  const active = goalProjection(1);
  const paused = { ...goalProjection(2), status: 'paused' as const, pausedAt: 5 };
  const { client, requests } = clientWithResponses([
    { sessionId: 'session-1', goal: active }, // queryGoal
    { sessionId: 'session-1', goal: paused }, // goal.control pause result
    { sessionId: 'session-1', goal: paused }, // queryGoal for resume
    { sessionId: 'session-1', goal: { ...goalProjection(3) } }, // goal.control resume result
  ]);

  await client.controlGoalWithRetry('session-1', 'pause');
  await client.controlGoalWithRetry('session-1', 'resume');

  assert.deepEqual(
    requests.filter(({ operation }) => operation === 'goal.control').map(({ input }) => input),
    [
      { sessionId: 'session-1', goalId: 'goal-1', expectedRevision: 1, action: 'pause' },
      { sessionId: 'session-1', goalId: 'goal-1', expectedRevision: 2, action: 'resume' },
    ],
  );
});

test('controlGoalWithRetry rethrows a status refusal instead of retrying it away', async () => {
  // The host folds invalid transitions into operation_conflict. Every accepted
  // transition bumps the revision, so a conflict at an unchanged revision is a
  // status refusal — the reason must surface, not a retry-exhaustion error.
  const paused = { ...goalProjection(2), status: 'paused' as const, pausedAt: 5 };
  const refusal = new RuntimeHostOperationError(
    'goal.control',
    'operation_conflict',
    'Goal cannot pause from status paused',
  );
  const { client, requests } = clientWithResponses([
    { sessionId: 'session-1', goal: paused }, // queryGoal
    refusal, // goal.control conflict
    { sessionId: 'session-1', goal: paused }, // re-query: SAME revision
  ]);

  await assert.rejects(
    () => client.controlGoalWithRetry('session-1', 'pause'),
    /Goal cannot pause from status paused/,
  );
  // No futile retries: exactly one control attempt.
  assert.equal(
    requests.filter(({ operation }) => operation === 'goal.control').length,
    1,
  );
});

test('arms a Goal in one request and reports a conflicting Goal instead of retrying', async () => {
  const armed = goalProjection(0);
  const { client, requests } = clientWithResponses([
    { sessionId: 'session-1', goal: armed },
  ]);

  const result = await client.armGoal({
    sessionId: 'session-1',
    condition: 'All tests pass',
    maxIterations: 20,
    tokenBudget: null,
  });

  assert.deepEqual(result, { sessionId: 'session-1', goal: armed });
  assert.deepEqual(
    requests.filter(({ operation }) => operation === 'goal.arm').map(({ input }) => input),
    [
      {
        sessionId: 'session-1',
        condition: 'All tests pass',
        maxIterations: 20,
        tokenBudget: null,
      },
    ],
  );

  // Arming names no revision, so a conflict is an answer for the user — the
  // Session already has a Goal — not a stale read to refresh and re-send.
  const conflicted = clientWithResponses([
    new RuntimeHostOperationError('goal.arm', 'operation_conflict', 'Goal already set'),
  ]);
  await assert.rejects(
    conflicted.client.armGoal({
      sessionId: 'session-1',
      condition: 'All tests pass',
      maxIterations: null,
      tokenBudget: null,
    }),
    /Goal already set/,
  );
  assert.equal(
    conflicted.requests.filter(({ operation }) => operation === 'goal.arm').length,
    1,
  );
});

test('rejects an invalid sidecar continuation without misclassifying it as revision churn', async () => {
  const revision = catalogRevision('7');
  const { client, requests } = clientWithResponses([
    {
      kind: 'page',
      sessionId: 'session-1',
      revision,
      tasks: [],
      nextCursor: 'next',
    },
    {
      kind: 'page',
      sessionId: 'session-other',
      revision,
      tasks: [],
      nextCursor: null,
    },
  ]);

  await assert.rejects(
    () => client.listTasks('session-1'),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError && error.code === 'projection_unstable',
  );
  assert.equal(requests.length, 2);
});

interface RecordedRequest {
  operation: OperationKey;
  input: unknown;
}

function clientWithResponses(responses: unknown[]): {
  client: DesktopRuntimeHostClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const connection = {
    hostEpoch: 'host-current',
    request: async <K extends OperationKey>(operation: K, input: OperationInput<K>) => {
      requests.push({ operation, input });
      if (responses.length === 0) throw new Error(`Unexpected operation: ${operation}`);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    close: async () => undefined,
  } as unknown as RuntimeHostConnection;
  return { client: new DesktopRuntimeHostClient(connection), requests };
}

function goalProjection(revision: number) {
  return {
    goalId: 'goal-1',
    revision,
    sessionId: 'session-1',
    condition: 'Finish the adapter',
    status: 'active' as const,
    setAt: 1,
    iterations: 0,
    maxIterations: 20,
    consecutiveNoProgress: 0,
    blockCap: 8,
    tokenBudget: null,
    tokensSpent: 0,
    lastReason: null,
    achievedAt: null,
    pausedAt: null,
  };
}

function catalogRevision(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64)}`;
}

function session(
  id: string,
  revision: number,
  overrides: Partial<SessionCatalogProjection> = {},
): SessionCatalogProjection {
  return {
    id,
    revision,
    workspace: {
      target: { kind: 'host_path', path: '/workspace' },
      hostCwd: '/workspace',
    },
    createdAt: 1,
    lastUsedAt: 1,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test-connection',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}
