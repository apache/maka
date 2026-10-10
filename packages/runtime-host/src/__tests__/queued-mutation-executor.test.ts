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
import type { OperationSpec } from '../protocol/operation-spec.js';
import {
  type QueuedMutationKind,
  QueuedMutationExecutor,
} from '../server/queued-mutation-executor.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

interface Input {
  originHostEpoch: string;
  sessionId: string;
  value: number;
}

const spec: OperationSpec<Input, { value: number }, 'internal_failure'> = {
  mode: 'command',
  availability: 'ready',
  errors: ['internal_failure'],
  decodeInput: (value) => value as Input,
  decodeOutput: (value) => value as { value: number },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function request(
  input: Input,
  execute: () => Promise<{ ok: true; result: { value: number } }>,
  options: {
    kind?: QueuedMutationKind;
    id?: string;
    verb?: string;
    operationSpec?: OperationSpec<Input, { value: number }, 'internal_failure'>;
  } = {},
) {
  return {
    spec: options.operationSpec ?? spec,
    kind: options.kind ?? ('reorder' as const),
    id: options.id ?? 'operation-1',
    verb: options.verb ?? 'reorder',
    input,
    payloadIdentity: { value: input.value },
    execute,
  };
}

test('identical concurrent retries share one execution and one promise', async () => {
  const result = deferred<{ ok: true; result: { value: number } }>();
  let executions = 0;
  const executor = new QueuedMutationExecutor({
    hostEpoch: 'epoch-1',
    admissions: new SessionAdmissionGate(),
    isFailStopped: () => false,
    readCompleted: () => undefined,
  });
  const input = { originHostEpoch: 'epoch-1', sessionId: 'session-1', value: 7 };
  const first = executor.run(
    request(input, () => {
      executions += 1;
      return result.promise;
    }),
  );
  const retry = executor.run(
    request({ ...input }, () => {
      executions += 1;
      return result.promise;
    }),
  );

  assert.strictEqual(retry, first);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);
  assert.deepEqual(executor.pendingResults('session-1'), [first]);
  assert.deepEqual(executor.pendingResults('session-2'), []);
  result.resolve({ ok: true, result: { value: 7 } });
  assert.deepEqual(await first, { ok: true, result: { value: 7 } });
  await Promise.resolve();
  assert.deepEqual(executor.pendingResults('session-1'), []);
});

test('same operation identity with a different payload conflicts before execution', async () => {
  const held = deferred<{ ok: true; result: { value: number } }>();
  let executions = 0;
  const executor = new QueuedMutationExecutor({
    hostEpoch: 'epoch-1',
    admissions: new SessionAdmissionGate(),
    isFailStopped: () => false,
    readCompleted: () => undefined,
  });
  void executor.run(
    request({ originHostEpoch: 'epoch-1', sessionId: 'session-1', value: 1 }, () => {
      executions += 1;
      return held.promise;
    }),
  );
  const conflict = await executor.run(
    request({ originHostEpoch: 'epoch-1', sessionId: 'session-1', value: 2 }, async () => {
      executions += 1;
      return { ok: true, result: { value: 2 } };
    }),
  );
  assert.deepEqual(conflict, {
    ok: false,
    error: { code: 'operation_conflict', message: 'reorder identity has a different payload' },
  });
  assert.equal(executions, 1);
  held.resolve({ ok: true, result: { value: 1 } });
});

test('mutation identity is namespaced by kind, Session, and operation id', async () => {
  const executor = new QueuedMutationExecutor({
    hostEpoch: 'epoch-1',
    admissions: new SessionAdmissionGate(),
    isFailStopped: () => false,
    readCompleted: () => undefined,
  });
  const held = Array.from({ length: 4 }, () => deferred<{ ok: true; result: { value: number } }>());
  let executions = 0;
  const run = (
    sessionId: string,
    id: string,
    kind: QueuedMutationKind,
    result: (typeof held)[number],
  ) =>
    executor.run(
      request(
        { originHostEpoch: 'epoch-1', sessionId, value: 1 },
        () => {
          executions += 1;
          return result.promise;
        },
        { id, kind, verb: kind },
      ),
    );

  const results = [
    run('session-1', 'operation-1', 'reorder', held[0]!),
    run('session-2', 'operation-1', 'reorder', held[1]!),
    run('session-1', 'operation-2', 'reorder', held[2]!),
    run('session-1', 'operation-1', 'promote', held[3]!),
  ];
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(executions, 2);
  assert.equal(new Set(results).size, 4);
  assert.deepEqual(executor.pendingResults('session-1'), [results[0], results[2], results[3]]);
  assert.deepEqual(executor.pendingResults('session-2'), [results[1]]);

  held[0]!.resolve({ ok: true, result: { value: 0 } });
  held[1]!.resolve({ ok: true, result: { value: 1 } });
  await Promise.all([results[0], results[1]]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(executions, 3);

  held[2]!.resolve({ ok: true, result: { value: 2 } });
  await results[2];
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(executions, 4);

  held[3]!.resolve({ ok: true, result: { value: 3 } });
  await results[3];
});

test('rejected execution is removed from the pending Session view', async () => {
  const executor = new QueuedMutationExecutor({
    hostEpoch: 'epoch-1',
    admissions: new SessionAdmissionGate(),
    isFailStopped: () => false,
    readCompleted: () => undefined,
  });
  const failure = new Error('persistence failed');
  const pending = executor.run(
    request({ originHostEpoch: 'epoch-1', sessionId: 'session-1', value: 1 }, async () => {
      throw failure;
    }),
  );

  assert.deepEqual(executor.pendingResults('session-1'), [pending]);
  await assert.rejects(pending, (error) => error === failure);
  await Promise.resolve();
  assert.deepEqual(executor.pendingResults('session-1'), []);
});

test('a stale Epoch retry cannot attach to current-Epoch pending work', async () => {
  const held = deferred<{ ok: true; result: { value: number } }>();
  const executor = new QueuedMutationExecutor({
    hostEpoch: 'epoch-1',
    admissions: new SessionAdmissionGate(),
    isFailStopped: () => false,
    readCompleted: () => undefined,
  });
  const current = executor.run(
    request({ originHostEpoch: 'epoch-1', sessionId: 'session-1', value: 1 }, () => held.promise),
  );
  const stale = await executor.run(
    request({ originHostEpoch: 'old-epoch', sessionId: 'session-1', value: 1 }, async () =>
      assert.fail('stale Epoch work must not execute'),
    ),
  );

  assert.deepEqual(stale, {
    ok: false,
    error: {
      code: 'outcome_unknown',
      message: 'reorder outcome is not durable across Host Epochs',
    },
  });
  assert.deepEqual(executor.pendingResults('session-1'), [current]);
  held.resolve({ ok: true, result: { value: 1 } });
  await current;
});

test('epoch and fail-stop fences reject work without entering admission', async () => {
  for (const scenario of [
    { epoch: 'old-epoch', draining: false, code: 'outcome_unknown' },
    { epoch: 'epoch-1', draining: true, code: 'host_draining' },
  ] as const) {
    let executed = false;
    let admissions = 0;
    const executor = new QueuedMutationExecutor({
      hostEpoch: 'epoch-1',
      admissions: {
        run: async () => {
          admissions += 1;
          return assert.fail('fenced work must not enter Session admission');
        },
      } as unknown as SessionAdmissionGate,
      isFailStopped: () => scenario.draining,
      readCompleted: () => undefined,
    });
    const outcome = await executor.run(
      request({ originHostEpoch: scenario.epoch, sessionId: 'session-1', value: 1 }, async () => {
        executed = true;
        return { ok: true, result: { value: 1 } };
      }),
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.code, scenario.code);
    assert.equal(executed, false);
    assert.equal(admissions, 0);
  }
});

test('fail-stop is checked again after waiting for Session admission', async () => {
  const gate = new SessionAdmissionGate();
  const blocker = deferred<void>();
  const admitted = gate.run('session-1', () => blocker.promise);
  let failStopped = false;
  let executed = false;
  const executor = new QueuedMutationExecutor({
    hostEpoch: 'epoch-1',
    admissions: gate,
    isFailStopped: () => failStopped,
    readCompleted: () => undefined,
  });
  const pending = executor.run(
    request({ originHostEpoch: 'epoch-1', sessionId: 'session-1', value: 1 }, async () => {
      executed = true;
      return { ok: true, result: { value: 1 } };
    }),
  );

  failStopped = true;
  blocker.resolve();
  await admitted;
  assert.deepEqual(await pending, {
    ok: false,
    error: { code: 'host_draining', message: 'Runtime Host message authority has failed' },
  });
  assert.equal(executed, false);
});

test('a completed mutation replays only when its payload identity matches', async () => {
  const executor = new QueuedMutationExecutor({
    hostEpoch: 'epoch-1',
    admissions: new SessionAdmissionGate(),
    isFailStopped: () => false,
    readCompleted: () => ({ payloadIdentity: { value: 7 }, result: { value: 11 } }),
  });
  const replay = await executor.run(
    request({ originHostEpoch: 'epoch-1', sessionId: 'session-1', value: 7 }, async () =>
      assert.fail('completed mutation must not execute again'),
    ),
  );
  assert.deepEqual(replay, { ok: true, result: { value: 11 } });

  const conflict = await executor.run(
    request({ originHostEpoch: 'epoch-1', sessionId: 'session-1', value: 8 }, async () =>
      assert.fail('conflicting replay must not execute'),
    ),
  );
  assert.deepEqual(conflict, {
    ok: false,
    error: { code: 'operation_conflict', message: 'reorder identity has a different payload' },
  });
});

test('a malformed durable replay fails as a Host authority invariant', async () => {
  const invalidReplaySpec: typeof spec = {
    ...spec,
    decodeOutput: () => {
      throw new TypeError('invalid replay payload');
    },
  };
  const executor = new QueuedMutationExecutor({
    hostEpoch: 'epoch-1',
    admissions: new SessionAdmissionGate(),
    isFailStopped: () => false,
    readCompleted: () => ({ payloadIdentity: { value: 7 }, result: { invalid: true } }),
  });

  await assert.rejects(
    executor.run(
      request(
        { originHostEpoch: 'epoch-1', sessionId: 'session-1', value: 7 },
        async () => assert.fail('malformed replay must not execute'),
        { operationSpec: invalidReplaySpec },
      ),
    ),
    /Invalid queued mutation replay outcome: invalid replay payload/,
  );

  const nonErrorReplaySpec: typeof spec = {
    ...spec,
    decodeOutput: () => {
      throw 'invalid replay payload';
    },
  };
  await assert.rejects(
    executor.run(
      request(
        { originHostEpoch: 'epoch-1', sessionId: 'session-2', value: 7 },
        async () => assert.fail('malformed replay must not execute'),
        { operationSpec: nonErrorReplaySpec },
      ),
    ),
    /Invalid queued mutation replay outcome: malformed/,
  );
});
