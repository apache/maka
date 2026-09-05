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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import test from 'node:test';
import { connectRuntimeHostWslEnvironment } from '../client/wsl-environment.js';

const operator = (modulePath: string) => ({
  kind: 'node' as const,
  platform: 'posix' as const,
  nodePath: '/usr/bin/node',
  modulePath,
});

test('passes WSL target values as literal argv to the absolute operator', async () => {
  const sentinel = new Error('stop after argv capture');
  let invocation: { readonly executable: string; readonly args: readonly string[] } | undefined;
  await assert.rejects(
    connectRuntimeHostWslEnvironment(
      {
        distribution: 'Ubuntu work; echo unsafe',
        operator: operator("/opt/Maka operator's/bin/maka-operator.mjs"),
        rootId: 'a'.repeat(64),
        clientInstanceId: 'desktop-test',
      },
      {
        wslExecutable: 'C:\\Windows\\System32\\wsl.exe',
        processFactory: (executable, args) => {
          invocation = { executable, args };
          throw sentinel;
        },
      },
    ),
    sentinel,
  );
  assert.deepEqual(invocation, {
    executable: 'C:\\Windows\\System32\\wsl.exe',
    args: [
      '--distribution',
      'Ubuntu work; echo unsafe',
      '--exec',
      '/usr/bin/node',
      "/opt/Maka operator's/bin/maka-operator.mjs",
      'connect',
      '--framed',
      '--root-id',
      'a'.repeat(64),
      '--repair-root-after-remount',
    ],
  });
});

test('owns WSL bridge cancellation without emitting a child-stream error', async () => {
  const abort = new AbortController();
  const cancellation = new Error('cancelled by test');
  let child: ChildProcessWithoutNullStreams | undefined;
  const connection = connectRuntimeHostWslEnvironment(
    {
      distribution: 'Ubuntu',
      operator: operator('/opt/maka/operator.mjs'),
      rootId: 'a'.repeat(64),
      clientInstanceId: 'desktop-test',
      signal: abort.signal,
      handshakeTimeoutMs: 10_000,
    },
    {
      wslExecutable: 'C:\\Windows\\System32\\wsl.exe',
      processFactory: () => {
        child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return child;
      },
    },
  );

  abort.abort(cancellation);
  await assert.rejects(connection, /handshake_failed/u);
  assert.ok(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('contains oversized WSL bridge diagnostics inside the connection failure', async () => {
  await assert.rejects(
    connectRuntimeHostWslEnvironment(
      {
        distribution: 'Ubuntu',
        operator: operator('/opt/maka/operator.mjs'),
        rootId: 'a'.repeat(64),
        clientInstanceId: 'desktop-test',
        handshakeTimeoutMs: 10_000,
      },
      {
        wslExecutable: 'C:\\Windows\\System32\\wsl.exe',
        processFactory: () =>
          spawn(
            process.execPath,
            ['-e', "process.stderr.write('x'.repeat(9_000)); process.exit(7)"],
            { stdio: ['pipe', 'pipe', 'pipe'] },
          ),
      },
    ),
    /handshake_failed/u,
  );
});
