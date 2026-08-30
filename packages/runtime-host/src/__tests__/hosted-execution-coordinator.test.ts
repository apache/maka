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
import { HostHostedExecutionCoordinator } from '../server/hosted-execution-coordinator.js';

test('cancel before start prevents the hosted execution from running', async () => {
  let runs = 0;
  const coordinator = new HostHostedExecutionCoordinator(
    async (input) => {
      runs += 1;
      return settled(input.executionId, 'completed');
    },
    () => {},
  );

  const cancelled = await coordinator.handlers['hosted.execution.cancel'](
    { executionId: ID },
    context(),
  );
  const started = await coordinator.handlers['hosted.execution.start'](
    { execution: input(), admissionToken: TOKEN },
    context(),
  );

  assert.equal(cancelled.ok, true);
  assert.equal(started.ok, true);
  if (started.ok) assert.equal(started.result.kind, 'indeterminate');
  assert.equal(runs, 0);
});

test('admit returns a server-owned token before start waits for settlement', async () => {
  const release = deferred();
  const coordinator = new HostHostedExecutionCoordinator(
    async (input) => {
      await release.promise;
      return settled(input.executionId, 'completed');
    },
    () => {},
  );

  const admitted = await coordinator.handlers['hosted.execution.admit'](input(), context());
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  assert.equal(admitted.result.executionId, ID);
  assert.match(admitted.result.admissionToken, /^[0-9a-f-]{36}$/i);

  const waiting = coordinator.handlers['hosted.execution.start'](
    { execution: input(), admissionToken: admitted.result.admissionToken },
    context(),
  );
  const again = await coordinator.handlers['hosted.execution.admit'](input(), context());
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.result.admissionToken, admitted.result.admissionToken);
  release.resolve();
  const started = await waiting;
  assert.equal(started.ok, true);
  if (started.ok) assert.equal(started.result.kind, 'settled');
});

test('cancelling a settled subject reclaims its verification environment', async () => {
  let drains = 0;
  const coordinator = new HostHostedExecutionCoordinator(
    async (execution) => settled(execution.executionId, 'failed'),
    () => {
      drains += 1;
    },
  );
  const admitted = await coordinator.handlers['hosted.execution.admit'](input(), context());
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  await coordinator.handlers['hosted.execution.start'](
    { execution: input(), admissionToken: admitted.result.admissionToken },
    context(),
  );

  await coordinator.handlers['hosted.execution.cancel']({ executionId: ID }, context());

  assert.equal(drains, 1);
});

test('start without server admission is rejected without running', async () => {
  let runs = 0;
  const coordinator = new HostHostedExecutionCoordinator(
    async (execution) => {
      runs += 1;
      return settled(execution.executionId, 'completed');
    },
    () => {},
  );

  const started = await coordinator.handlers['hosted.execution.start'](
    { execution: input(), admissionToken: TOKEN },
    context(),
  );

  assert.equal(started.ok, false);
  if (!started.ok) assert.equal(started.error.code, 'invalid_request');
  assert.equal(runs, 0);
});

test('wrong admission token cannot claim an admitted execution', async () => {
  let runs = 0;
  const coordinator = new HostHostedExecutionCoordinator(
    async (execution) => {
      runs += 1;
      return settled(execution.executionId, 'completed');
    },
    () => {},
  );
  const admitted = await coordinator.handlers['hosted.execution.admit'](input(), context());
  assert.equal(admitted.ok, true);
  if (admitted.ok) assert.notEqual(admitted.result.admissionToken, TOKEN);

  const started = await coordinator.handlers['hosted.execution.start'](
    { execution: input(), admissionToken: TOKEN },
    context(),
  );

  assert.equal(started.ok, false);
  if (!started.ok) assert.equal(started.error.code, 'operation_conflict');
  assert.equal(runs, 1);
});

test('fast settlement remains cached and cannot execute twice', async () => {
  let runs = 0;
  const coordinator = new HostHostedExecutionCoordinator(
    async (execution) => {
      runs += 1;
      return settled(execution.executionId, 'completed');
    },
    () => {},
  );
  const admitted = await coordinator.handlers['hosted.execution.admit'](input(), context());
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));

  const startInput = { execution: input(), admissionToken: admitted.result.admissionToken };
  const first = await coordinator.handlers['hosted.execution.start'](startInput, context());
  const replay = await coordinator.handlers['hosted.execution.start'](startInput, context());

  assert.equal(first.ok, true);
  assert.deepEqual(replay, first);
  assert.equal(runs, 1);
});

test('one-shot Host rejects every different execution identity and retains one receipt', async () => {
  let runs = 0;
  let aborts = 0;
  const coordinator = new HostHostedExecutionCoordinator(
    async (execution, signal) => {
      runs += 1;
      signal.addEventListener('abort', () => {
        aborts += 1;
      });
      return settled(execution.executionId, 'completed');
    },
    () => {},
  );
  const admitted = await coordinator.handlers['hosted.execution.admit'](input(), context());
  assert.equal(admitted.ok, true);

  const outcomes = await Promise.all(
    Array.from({ length: 200 }, (_, index) =>
      coordinator.handlers['hosted.execution.admit'](
        input(`00000000-0000-4000-8001-${String(index).padStart(12, '0')}`),
        context(),
      ),
    ),
  );

  assert.equal(
    outcomes.every((outcome) => !outcome.ok),
    true,
  );
  for (const outcome of outcomes) {
    if (!outcome.ok) assert.equal(outcome.error.code, 'operation_conflict');
  }
  assert.equal(runs, 1);
  assert.equal(aborts, 0);
  coordinator.beginDrain();
  assert.equal(aborts, 1);
});

test('cancelling first binds the one-shot Host to that execution identity', async () => {
  const coordinator = new HostHostedExecutionCoordinator(
    async (execution) => settled(execution.executionId, 'completed'),
    () => {},
  );
  const cancelled = await coordinator.handlers['hosted.execution.cancel'](
    { executionId: ID },
    context(),
  );
  assert.equal(cancelled.ok, true);

  const different = await coordinator.handlers['hosted.execution.admit'](
    input('00000000-0000-4000-8000-000000000002'),
    context(),
  );
  assert.equal(different.ok, false);
  if (!different.ok) assert.equal(different.error.code, 'operation_conflict');
});

test('admission authority cannot cross connection or Host epoch', async () => {
  const coordinator = new HostHostedExecutionCoordinator(
    async (execution) => settled(execution.executionId, 'completed'),
    () => {},
  );
  const owner = context();
  const admitted = await coordinator.handlers['hosted.execution.admit'](input(), owner);
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  const startInput = { execution: input(), admissionToken: admitted.result.admissionToken };

  for (const foreign of [
    context({ connectionId: 'other-connection' }),
    context({ hostEpoch: 'other-epoch' }),
  ]) {
    const started = await coordinator.handlers['hosted.execution.start'](startInput, foreign);
    assert.equal(started.ok, false);
    if (!started.ok) assert.equal(started.error.code, 'operation_conflict');

    const readmitted = await coordinator.handlers['hosted.execution.admit'](input(), foreign);
    assert.equal(readmitted.ok, false);
    if (!readmitted.ok) assert.equal(readmitted.error.code, 'operation_conflict');
  }
});

const ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = '00000000-0000-4000-8000-0000000000ff';

function settled(executionId: string, status: 'completed' | 'failed') {
  return {
    executionId,
    kind: 'settled' as const,
    status,
    ...(status === 'failed' ? { failureReason: 'subject failed' } : {}),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    costUsd: 0,
  };
}

function input(executionId = ID) {
  return {
    executionId,
    session: {
      workspace: { kind: 'host_path' as const, path: '/workspace' },
      modelTarget: {
        kind: 'explicit' as const,
        connectionId: 'connection-1',
        connectionSlug: 'env-openai',
        model: 'model',
      },
    },
    content: { text: 'solve' },
  };
}

function context(overrides: { hostEpoch?: string; connectionId?: string } = {}) {
  return {
    hostEpoch: overrides.hostEpoch ?? 'host-epoch',
    connectionId: overrides.connectionId ?? 'hosted-execution',
    principal: 'runtime_host' as const,
    acquireResidency: () => ({ release() {} }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
