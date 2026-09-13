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
import test from 'node:test';
import { terminateProcess } from '../process-termination.js';

function childProcess(pid = 123): {
  child: ChildProcess;
  signals: Array<NodeJS.Signals | undefined>;
} {
  const signals: Array<NodeJS.Signals | undefined> = [];
  return {
    child: {
      pid,
      exitCode: null,
      signalCode: null,
      kill: (signal?: NodeJS.Signals) => {
        signals.push(signal);
        return true;
      },
    } as unknown as ChildProcess,
    signals,
  };
}

test('uses taskkill for first-stage Windows termination so descendants cannot outlive the root', async () => {
  const { child, signals } = childProcess();
  const pids: number[] = [];

  assert.equal(
    await terminateProcess(child, 'SIGTERM', {
      platform: 'win32',
      runTaskkill: async (pid) => {
        pids.push(pid);
        return true;
      },
    }),
    true,
  );
  assert.deepEqual(pids, [123]);
  assert.deepEqual(signals, []);
});

test('uses taskkill for forced Windows termination and preserves the process tree', async () => {
  const { child, signals } = childProcess(456);
  const pids: number[] = [];

  assert.equal(
    await terminateProcess(child, 'SIGKILL', {
      platform: 'win32',
      runTaskkill: async (pid) => {
        pids.push(pid);
        return true;
      },
    }),
    true,
  );
  assert.deepEqual(pids, [456]);
  assert.deepEqual(signals, []);
});

test('falls back to the root process when Windows taskkill is unavailable', async () => {
  const { child, signals } = childProcess();

  assert.equal(
    await terminateProcess(child, 'SIGKILL', {
      platform: 'win32',
      runTaskkill: async () => false,
    }),
    true,
  );
  assert.deepEqual(signals, [undefined]);
});

test('preserves POSIX signal semantics', async () => {
  const { child, signals } = childProcess();

  assert.equal(await terminateProcess(child, 'SIGTERM', { platform: 'linux' }), true);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('does not signal a child that has already exited', async () => {
  const { child, signals } = childProcess();
  Object.assign(child, { exitCode: 0 });

  assert.equal(await terminateProcess(child, 'SIGKILL', { platform: 'win32' }), false);
  assert.deepEqual(signals, []);
});
