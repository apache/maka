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
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';

const POISONED_MESSAGE = 'Runtime policy activation is poisoned';

test('backend activations run concurrently while a mutation waits and blocks a later activation', async () => {
  const gate = new RuntimePolicyActivationGate();
  const firstEntered = deferred();
  const secondEntered = deferred();
  const releaseStarts = deferred();
  const mutationEntered = deferred();
  const releaseMutation = deferred();
  const laterStartEntered = deferred();
  let mutationHasEntered = false;
  let laterStartHasEntered = false;

  const firstStart = gate.runBackendActivation(async () => {
    firstEntered.resolve();
    await releaseStarts.promise;
  });
  const secondStart = gate.runBackendActivation(async () => {
    secondEntered.resolve();
    await releaseStarts.promise;
  });

  await Promise.all([firstEntered.promise, secondEntered.promise]);

  const mutation = gate.runMutation(async () => {
    mutationHasEntered = true;
    mutationEntered.resolve();
    await releaseMutation.promise;
  });
  const laterStart = gate.runBackendActivation(() => {
    laterStartHasEntered = true;
    laterStartEntered.resolve();
  });

  assert.equal(mutationHasEntered, false);
  assert.equal(laterStartHasEntered, false);

  releaseStarts.resolve();
  await mutationEntered.promise;
  assert.equal(laterStartHasEntered, false);

  releaseMutation.resolve();
  await laterStartEntered.promise;
  await Promise.all([firstStart, secondStart, mutation, laterStart]);
});

test('policy-dependent reads share the same mutation barrier as backend activation', async () => {
  const gate = new RuntimePolicyActivationGate();
  const readEntered = deferred();
  const releaseRead = deferred();
  const mutationEntered = deferred();
  const releaseMutation = deferred();
  const laterReadEntered = deferred();

  const read = gate.runReadActivation(async () => {
    readEntered.resolve();
    await releaseRead.promise;
  });
  await readEntered.promise;

  const mutation = gate.runMutation(async () => {
    mutationEntered.resolve();
    await releaseMutation.promise;
  });
  const laterRead = gate.runReadActivation(() => {
    laterReadEntered.resolve();
  });

  releaseRead.resolve();
  await mutationEntered.promise;
  let laterReadFinished = false;
  void laterReadEntered.promise.then(() => {
    laterReadFinished = true;
  });
  await Promise.resolve();
  assert.equal(laterReadFinished, false);

  releaseMutation.resolve();
  await laterReadEntered.promise;
  await Promise.all([read, mutation, laterRead]);
});

test('a failed mutation releases backend activations and the next mutation', async () => {
  const gate = new RuntimePolicyActivationGate();
  const expected = new Error('injected mutation failure');
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const laterStartEntered = deferred();
  const nextMutationEntered = deferred();

  const firstMutation = gate.runMutation(async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
    throw expected;
  });
  await firstEntered.promise;

  const laterStart = gate.runBackendActivation(() => {
    laterStartEntered.resolve();
  });
  const nextMutation = gate.runMutation(() => {
    nextMutationEntered.resolve();
  });
  const failed = assert.rejects(firstMutation, expected);

  releaseFirst.resolve();
  await failed;
  await Promise.all([laterStartEntered.promise, nextMutationEntered.promise]);
  await Promise.all([laterStart, nextMutation]);
});

test('poison preserves an executing mutation outcome and closes queued and later work', async () => {
  const gate = new RuntimePolicyActivationGate();
  const mutationEntered = deferred();
  const releaseMutation = deferred();
  let queuedStartEntered = false;
  let queuedMutationEntered = false;
  let laterStartEntered = false;
  let laterMutationEntered = false;

  const activeMutation = gate.runMutation(async () => {
    mutationEntered.resolve();
    await releaseMutation.promise;
    return { kind: 'committed' as const, revision: 7 };
  });
  await mutationEntered.promise;

  const queuedStart = gate.runBackendActivation(() => {
    queuedStartEntered = true;
  });
  const queuedMutation = gate.runMutation(() => {
    queuedMutationEntered = true;
  });
  const queuedStartRejected = assert.rejects(queuedStart, { message: POISONED_MESSAGE });
  const queuedMutationRejected = assert.rejects(queuedMutation, { message: POISONED_MESSAGE });

  gate.poison();
  gate.poison();
  releaseMutation.resolve();

  assert.deepEqual(await activeMutation, { kind: 'committed', revision: 7 });
  await Promise.all([queuedStartRejected, queuedMutationRejected]);
  assert.equal(queuedStartEntered, false);
  assert.equal(queuedMutationEntered, false);

  await assert.rejects(
    gate.runBackendActivation(() => {
      laterStartEntered = true;
    }),
    { message: POISONED_MESSAGE },
  );
  await assert.rejects(
    gate.runMutation(() => {
      laterMutationEntered = true;
    }),
    { message: POISONED_MESSAGE },
  );
  assert.equal(laterStartEntered, false);
  assert.equal(laterMutationEntered, false);
});

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
