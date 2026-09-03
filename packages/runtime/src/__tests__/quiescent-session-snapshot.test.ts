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
import { test } from 'node:test';
import { SessionSnapshotError } from '@maka/storage/quiescent-session-snapshot';
import { RuntimeKernel, SessionQuiescentMutationBusyError } from '../runtime-kernel.js';
import { createRuntimeSessionSnapshotQuiescenceAuthority } from '../quiescent-session-snapshot.js';

test('enters Runtime Kernel quiescence before preparing a Session snapshot', async () => {
  const calls: string[][] = [];
  const authority = createRuntimeSessionSnapshotQuiescenceAuthority(
    {
      async runSessionQuiescentMutation(sessionIds, operation) {
        calls.push([...sessionIds]);
        return await operation();
      },
    },
    {
      assertSnapshotEligible(makaSessionId) {
        assert.equal(makaSessionId, 'session-1');
      },
    },
  );
  const value = await authority.runQuiescent(
    { makaSessionId: 'session-1', cancellation: { signal: new AbortController().signal } },
    async () => 'prepared',
  );
  assert.equal(value, 'prepared');
  assert.deepEqual(calls, [['session-1']]);
});

test('maps an active Runtime execution claim to a stable snapshot_busy error', async () => {
  const authority = createRuntimeSessionSnapshotQuiescenceAuthority(
    {
      async runSessionQuiescentMutation() {
        throw new SessionQuiescentMutationBusyError(['session-1']);
      },
    },
    {
      assertSnapshotEligible() {},
    },
  );
  await assert.rejects(
    authority.runQuiescent(
      { makaSessionId: 'session-1', cancellation: { signal: new AbortController().signal } },
      async () => undefined,
    ),
    (error) => {
      assert.ok(error instanceof SessionSnapshotError);
      assert.equal(error.code, 'snapshot_busy');
      assert.deepEqual(error.details, { phase: 'admission' });
      return true;
    },
  );
});

test('does not invoke snapshot work when Host eligibility rejects the Session', async () => {
  let invoked = false;
  const authority = createRuntimeSessionSnapshotQuiescenceAuthority(
    {
      async runSessionQuiescentMutation(_sessionIds, operation) {
        return await operation();
      },
    },
    {
      assertSnapshotEligible() {
        throw new SessionSnapshotError('snapshot_busy', 'Session has a pending approval', {
          details: { phase: 'admission' },
        });
      },
    },
  );
  await assert.rejects(
    authority.runQuiescent(
      { makaSessionId: 'session-1', cancellation: { signal: new AbortController().signal } },
      async () => {
        invoked = true;
      },
    ),
    (error) => error instanceof SessionSnapshotError && error.code === 'snapshot_busy',
  );
  assert.equal(invoked, false);
});

test('preserves an operation AbortError for coordinator cancellation normalization', async () => {
  const authority = createRuntimeSessionSnapshotQuiescenceAuthority(
    {
      async runSessionQuiescentMutation(_sessionIds, operation) {
        return await operation();
      },
    },
    {
      assertSnapshotEligible() {},
    },
  );
  const controller = new AbortController();

  await assert.rejects(
    authority.runQuiescent(
      { makaSessionId: 'session-1', cancellation: { signal: controller.signal } },
      async () => {
        controller.abort();
        controller.signal.throwIfAborted();
      },
    ),
    (error) => error instanceof Error && error.name === 'AbortError',
  );
});

test('actual Runtime Kernel serializes an admitted mutation before snapshot work', async () => {
  const kernel = new RuntimeKernel({} as never);
  let releaseMutation!: () => void;
  const mutationRelease = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  let markMutationStarted!: () => void;
  const mutationStarted = new Promise<void>((resolve) => {
    markMutationStarted = resolve;
  });
  const mutation = kernel.runSessionAdmissionMutation(['session-1'], async () => {
    markMutationStarted();
    await mutationRelease;
  });
  await mutationStarted;

  let snapshotInvoked = false;
  const authority = createRuntimeSessionSnapshotQuiescenceAuthority(kernel, {
    assertSnapshotEligible() {},
  });
  const snapshot = authority.runQuiescent(
    { makaSessionId: 'session-1', cancellation: { signal: new AbortController().signal } },
    async () => {
      snapshotInvoked = true;
    },
  );
  await Promise.resolve();
  assert.equal(snapshotInvoked, false);
  releaseMutation();
  await Promise.all([mutation, snapshot]);
  assert.equal(snapshotInvoked, true);
});

test('does not run a snapshot admitted after its cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  let invoked = false;
  const authority = createRuntimeSessionSnapshotQuiescenceAuthority(
    {
      async runSessionQuiescentMutation(_sessionIds, operation) {
        return await operation();
      },
    },
    {
      assertSnapshotEligible() {},
    },
  );
  await assert.rejects(
    authority.runQuiescent(
      { makaSessionId: 'session-1', cancellation: { signal: controller.signal } },
      async () => {
        invoked = true;
      },
    ),
    (error) => error instanceof SessionSnapshotError && error.code === 'snapshot_cancelled',
  );
  assert.equal(invoked, false);
});
