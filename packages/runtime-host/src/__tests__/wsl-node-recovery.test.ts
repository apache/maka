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
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveRuntimeHostWslNodeOperator } from '../client/wsl-node-recovery.js';
import { connectRuntimeHostWslEnvironment } from '../client/wsl-environment.js';

const op = (nodePath: string) => ({
  kind: 'node' as const,
  platform: 'posix' as const,
  nodePath,
  modulePath: '/operator.mjs',
});
const shell = (_exe: string, args: readonly string[]) =>
  spawn(args[3]!, args.slice(4), { stdio: ['pipe', 'pipe', 'pipe'] });

for (const state of ['missing', 'existing', 'non-executable', 'dangling-symlink'] as const) {
  test(`WSL Node recovery trigger: ${state}`, { skip: process.platform === 'win32' }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-wsl-node-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const nodePath = join(root, "version manager's", 'bin', 'node');
    await mkdir(join(root, "version manager's", 'bin'), { recursive: true });
    if (state === 'existing' || state === 'non-executable') {
      await writeFile(nodePath, 'not a working Node executable');
      await chmod(nodePath, state === 'existing' ? 0o700 : 0o600);
    } else if (state === 'dangling-symlink') await symlink(join(root, 'deleted-target'), nodePath);
    let discoveries = 0;
    const recovered = await resolveRuntimeHostWslNodeOperator(
      { distribution: 'Ubuntu', rootId: 'a'.repeat(64), operator: op(nodePath) },
      async () => {
        discoveries++;
        return op(process.execPath);
      },
      { wslExecutable: 'wsl-test', processFactory: shell },
    );
    assert.equal(discoveries, state === 'missing' ? 1 : 0);
    assert.ok(recovered.kind === 'node');
    assert.equal(recovered.nodePath, state === 'missing' ? process.execPath : nodePath);
  });
}

test('Host startup/handshake failure never triggers WSL Node discovery', async () => {
  let discoveries = 0;
  let probes = 0;
  await assert.rejects(
    connectRuntimeHostWslEnvironment(
      {
        distribution: 'Ubuntu',
        operator: op('/existing/node'),
        rootId: 'a'.repeat(64),
        clientInstanceId: 'test',
        recoverMissingNode: async () => {
          discoveries++;
          return op('/other/node');
        },
      },
      {
        wslExecutable: 'wsl-test',
        processFactory: (_exe, args) => {
          if (args[3] === '/bin/sh') {
            probes++;
            return spawn(process.execPath, ['-e', 'process.exit(0)'], {
              stdio: ['pipe', 'pipe', 'pipe'],
            });
          }
          return spawn(
            process.execPath,
            ['-e', 'process.stderr.write("Host failed to start");process.exit(1)'],
            { stdio: ['pipe', 'pipe', 'pipe'] },
          );
        },
      },
    ),
    /handshake_failed/,
  );
  assert.equal(probes, 1);
  assert.equal(discoveries, 0);
});

test('WSL probe errors and cancellation do not trigger discovery', async () => {
  for (const code of [1, 2, 44, 127]) {
    let discoveries = 0;
    await assert.rejects(
      resolveRuntimeHostWslNodeOperator(
        { distribution: 'Ubuntu', rootId: 'a'.repeat(64), operator: op('/node') },
        async () => {
          discoveries++;
          return op('/other/node');
        },
        {
          wslExecutable: 'wsl-test',
          processFactory: () =>
            spawn(process.execPath, ['-e', `process.exit(${code})`], {
              stdio: ['pipe', 'pipe', 'pipe'],
            }),
        },
      ),
      /could not check/,
    );
    assert.equal(discoveries, 0);
  }
  const signal = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(
    resolveRuntimeHostWslNodeOperator(
      { distribution: 'Ubuntu', rootId: 'a'.repeat(64), operator: op('/node'), signal },
      async () => assert.fail('cancelled discovery'),
      { wslExecutable: 'wsl-test', processFactory: () => assert.fail('cancelled probe') },
    ),
    /cancelled/,
  );
});

test('a missing WSL Node is recovered once before connecting, never retried for subsequent Host failure', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-wsl-node-connect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let discoveries = 0;
  let bridgeLaunches = 0;
  await assert.rejects(
    connectRuntimeHostWslEnvironment(
      {
        distribution: 'Ubuntu',
        rootId: 'a'.repeat(64),
        operator: op(join(root, 'deleted-node')),
        clientInstanceId: 'test',
        recoverMissingNode: async () => {
          discoveries++;
          return op(process.execPath);
        },
      },
      {
        wslExecutable: 'wsl-test',
        processFactory: (exe, args) => {
          if (args[3] === '/bin/sh') return shell(exe, args);
          bridgeLaunches++;
          assert.equal(args[3], process.execPath);
          assert.equal(args[4], '/operator.mjs');
          return spawn(process.execPath, ['-e', 'process.exit(1)'], {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        },
      },
    ),
    /handshake_failed/,
  );
  assert.equal(discoveries, 1);
  assert.equal(bridgeLaunches, 1);
});
