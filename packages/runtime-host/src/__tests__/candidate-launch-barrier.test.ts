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
import type { ConnectOrSpawnRuntimeHostInput } from '../client/connect-or-spawn.js';
import {
  createRuntimeHostCandidateLaunchBarrierWithDependencies,
  type RuntimeHostCandidateLaunchBarrierDependencies,
} from '../client/candidate-launch-barrier.js';
import type { OwnedCandidateAttempt } from '../client/launcher.js';

const connectInput = {} as ConnectOrSpawnRuntimeHostInput;
const launchInput = {
  rootPath: 'C:\\workspace',
  expectedRootId: 'root-id',
  entrypoint: 'candidate.js',
};

test('retires every owned candidate except the adopted Host while launches are paused', async () => {
  const first = candidateAttempt(42);
  const second = candidateAttempt(77);
  const attempts = [first, second];
  const barrier = createRuntimeHostCandidateLaunchBarrierWithDependencies({
    launchCandidate: () => ({ spawned: Promise.resolve(attempts.shift()!.attempt) }),
    connect: async (_input, launchCandidate) => {
      await Promise.all([
        launchCandidate(launchInput).spawned,
        launchCandidate(launchInput).spawned,
      ]);
      return { kind: 'failed', reason: 'startup_timeout' };
    },
    retireTimeoutMs: 25,
  });

  await barrier.connect(connectInput);
  barrier.pause();
  await barrier.retireExcept(42);

  assert.deepEqual(first.settleTimeouts, []);
  assert.deepEqual(second.settleTimeouts, [25]);
  barrier.release();
  assert.equal(first.releaseCalls, 1);
  assert.equal(second.releaseCalls, 0);
});

test('waits for a committed candidate spawn before retirement', async () => {
  const late = candidateAttempt(77);
  let resolveSpawn!: (attempt: OwnedCandidateAttempt) => void;
  const spawned = new Promise<OwnedCandidateAttempt>((resolve) => {
    resolveSpawn = resolve;
  });
  const barrier = createRuntimeHostCandidateLaunchBarrierWithDependencies({
    launchCandidate: () => ({ spawned }),
    connect: async (_input, launchCandidate) => {
      void launchCandidate(launchInput);
      return { kind: 'failed', reason: 'startup_timeout' };
    },
    retireTimeoutMs: 25,
  });

  await barrier.connect(connectInput);
  barrier.pause();
  const retirement = barrier.retireExcept(42);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(late.settleTimeouts, []);
  resolveSpawn(late.attempt);
  await retirement;
  assert.deepEqual(late.settleTimeouts, [25]);
});

test('pause blocks new candidate connections until rollback resumes them', async () => {
  let connectCalls = 0;
  const dependencies: RuntimeHostCandidateLaunchBarrierDependencies = {
    launchCandidate: () => assert.fail('this connection does not need a candidate'),
    connect: async () => {
      connectCalls += 1;
      return { kind: 'failed', reason: 'startup_timeout' };
    },
    retireTimeoutMs: 25,
  };
  const barrier = createRuntimeHostCandidateLaunchBarrierWithDependencies(dependencies);

  barrier.pause();
  await assert.rejects(barrier.connect(connectInput), /candidate launches are paused/);
  assert.equal(connectCalls, 0);
  barrier.resume();
  assert.deepEqual(await barrier.connect(connectInput), {
    kind: 'failed',
    reason: 'startup_timeout',
  });
  assert.equal(connectCalls, 1);
});

test('releases a candidate that finishes spawning after the barrier closes', async () => {
  const late = candidateAttempt(77);
  let resolveSpawn!: (attempt: OwnedCandidateAttempt) => void;
  const spawned = new Promise<OwnedCandidateAttempt>((resolve) => {
    resolveSpawn = resolve;
  });
  const barrier = createRuntimeHostCandidateLaunchBarrierWithDependencies({
    launchCandidate: () => ({ spawned }),
    connect: async (_input, launchCandidate) => {
      void launchCandidate(launchInput);
      return { kind: 'failed', reason: 'startup_timeout' };
    },
    retireTimeoutMs: 25,
  });

  await barrier.connect(connectInput);
  barrier.release();
  resolveSpawn(late.attempt);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(late.releaseCalls, 1);
  assert.deepEqual(late.settleTimeouts, []);
});

function candidateAttempt(pid: number) {
  let releaseCalls = 0;
  const settleTimeouts: number[] = [];
  const attempt: OwnedCandidateAttempt = {
    pid,
    startupFailure: new Promise(() => undefined),
    releaseToEnvironment() {
      releaseCalls += 1;
    },
    async settle(timeoutMs) {
      settleTimeouts.push(timeoutMs);
      return false;
    },
  };
  return {
    attempt,
    settleTimeouts,
    get releaseCalls() {
      return releaseCalls;
    },
  };
}
