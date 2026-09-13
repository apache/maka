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
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  manageChildProcessLifecycle,
  trackCapturedOutputDrain,
} from '../child-process-lifecycle.js';

test('captured output drain treats premature close and error as incomplete', async () => {
  const ended = new PassThrough();
  const closed = new PassThrough();
  const errored = new PassThrough();
  const drain = trackCapturedOutputDrain(
    [
      { key: 'ended', stream: ended },
      { key: 'closed', stream: closed },
      { key: 'errored', stream: errored },
    ],
    100,
  );
  ended.resume();
  ended.end('complete');
  closed.emit('close');
  errored.emit('error', new Error('capture failed'));
  drain.startDeadline();

  const result = await drain.completion;
  assert.deepEqual([...result.incomplete].sort(), ['closed', 'errored']);
});

test('completion waits for the bounded process-tree signal attempt after root exit', async () => {
  const child = new EventEmitter() as ChildProcess;
  let resolveSignal!: (applied: boolean) => void;
  const signalAttempt = new Promise<boolean>((resolve) => {
    resolveSignal = resolve;
  });
  const lifecycle = manageChildProcessLifecycle(child, [], {
    killGraceMs: 10,
    ioDrainTimeoutMs: 10,
    signalProcessTree: () => signalAttempt,
  });
  let completed = false;
  void lifecycle.completion.then(() => {
    completed = true;
  });

  lifecycle.terminate();
  child.emit('exit', 0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false);

  resolveSignal(true);
  assert.deepEqual(await lifecycle.completion, {
    exitCode: 0,
    signal: null,
    ioDrained: true,
    incompleteOutputs: new Set(),
  });
});

test('forced termination rejects boundedly when the direct root never acknowledges exit', async () => {
  const child = new EventEmitter() as ChildProcess;
  const signals: string[] = [];
  const lifecycle = manageChildProcessLifecycle(child, [], {
    killGraceMs: 10,
    exitAcknowledgementMs: 10,
    ioDrainTimeoutMs: 10,
    async signalProcessTree(signal) {
      signals.push(signal);
      return true;
    },
  });

  lifecycle.terminate();

  await assert.rejects(
    lifecycle.completion,
    /Child process did not acknowledge exit after forced termination/,
  );
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL', 'SIGKILL']);
});
