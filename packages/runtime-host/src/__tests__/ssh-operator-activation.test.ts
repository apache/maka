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
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  activateRuntimeHostSshOperator,
  runtimeHostSshOperatorRemoteCommand,
  type RuntimeHostSshOperatorProcess,
  type RuntimeHostSshOperatorProcessFactory,
} from '../client/ssh-operator-activation.js';
import {
  RUNTIME_HOST_ACTIVATION_FRAME_MAX_BYTES,
  encodeRuntimeHostActivationFrame,
} from '../operator/activation-frame.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';

const ROOT_ID = 'a'.repeat(64);
const execFileAsync = promisify(execFile);
const RESULT = {
  schemaVersion: 1,
  kind: 'result',
  deploymentId: '00000000-0000-4000-8000-000000000001',
  configRevision: 1,
  rootId: ROOT_ID,
  hostEpoch: 'host-epoch',
  pid: 4321,
  protocolVersion: RUNTIME_HOST_PROTOCOL_VERSION,
  endpoint: { host: '127.0.0.1', port: 45_678, websocketPath: '/runtime-host' },
} as const;

const operator = (modulePath: string) => ({
  kind: 'node' as const,
  platform: 'posix' as const,
  nodePath: '/usr/bin/node',
  modulePath,
});

test('SSH activation accepts a strict final frame that drains after process exit', async () => {
  let invocation: Parameters<RuntimeHostSshOperatorProcessFactory>[0] | undefined;
  const result = await activateRuntimeHostSshOperator(
    {
      destination: 'operator@example.com',
      sshPort: 2222,
      operator: operator("/opt/maka/operator's bin"),
      rootId: ROOT_ID,
      interaction: 'batch',
    },
    {
      spawnProcess: (input) => {
        invocation = input;
        return completedProcess(encodeRuntimeHostActivationFrame(RESULT), true);
      },
    },
  );

  assert.deepEqual(result, RESULT);
  assert.equal(invocation?.executable, 'ssh');
  assert.deepEqual(invocation?.args.slice(0, 13), [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'RemoteCommand=none',
    '-o',
    'ConnectTimeout=15',
  ]);
  assert.deepEqual(invocation?.args.slice(-4), [
    '-p',
    '2222',
    'operator@example.com',
    `exec '/usr/bin/node' '${"/opt/maka/operator's bin".replaceAll("'", `'"'"'`)}' 'activate' '--framed' '--root-id' '${ROOT_ID}'`,
  ]);
});

test('POSIX operator commands apply environment before exec', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-ssh-operator-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modulePath = join(directory, 'operator.mjs');
  await writeFile(modulePath, `process.stdout.write(process.env.MAKA_TEST_VALUE ?? 'missing');\n`);
  const command = runtimeHostSshOperatorRemoteCommand(
    { ...operator(modulePath), nodePath: process.execPath },
    [],
    { MAKA_TEST_VALUE: "value with ' quotes" },
  );

  const { stdout } = await execFileAsync('/bin/sh', ['-c', command]);
  assert.equal(stdout, "value with ' quotes");
  assert.equal(
    runtimeHostSshOperatorRemoteCommand(
      { kind: 'legacy_posix_executable', executablePath: '/opt/maka/operator' },
      ['activate'],
    ),
    "exec '/opt/maka/operator' 'activate'",
  );
});

test('SSH activation rejects multiple framed results', async () => {
  await assert.rejects(
    activateRuntimeHostSshOperator(
      {
        destination: 'operator@example.com',
        operator: operator('/opt/maka/operator.mjs'),
        rootId: ROOT_ID,
        interaction: 'batch',
      },
      {
        spawnProcess: () =>
          completedProcess(
            `${encodeRuntimeHostActivationFrame(RESULT)}${encodeRuntimeHostActivationFrame(RESULT)}`,
          ),
      },
    ),
    /multiple or malformed frames/u,
  );
});

test('SSH activation kills and rejects oversized operator output', async () => {
  let killedWith: NodeJS.Signals | undefined;
  const process = completedProcess('x'.repeat(RUNTIME_HOST_ACTIVATION_FRAME_MAX_BYTES + 257));
  process.kill = (signal) => {
    killedWith = signal;
  };
  await assert.rejects(
    activateRuntimeHostSshOperator(
      {
        destination: 'operator@example.com',
        operator: operator('/opt/maka/operator.mjs'),
        rootId: ROOT_ID,
        interaction: 'batch',
      },
      { spawnProcess: () => process },
    ),
    /too much output/u,
  );
  assert.equal(killedWith, 'SIGKILL');
});

function completedProcess(output: string, exitBeforeOutput = false): RuntimeHostSshOperatorProcess {
  const stdout = new PassThrough();
  const exited = new Promise<{ code: 0; signal: null }>((resolve) => {
    queueMicrotask(() => {
      resolve({ code: 0, signal: null });
      if (exitBeforeOutput) setImmediate(() => stdout.end(output));
      else stdout.end(output);
    });
  });
  return { stdout, exited, kill: () => undefined };
}
