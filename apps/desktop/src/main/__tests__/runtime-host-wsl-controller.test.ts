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
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { RuntimeHostWslProcessFactory } from '@maka/runtime-host/client';
import {
  encodeRuntimeHostServiceManagementFrame,
  encodeRuntimeHostSetupFrame,
  RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV,
  RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV,
} from '@maka/runtime-host/operator';
import {
  runDesktopRuntimeHostWslManagement,
  runDesktopRuntimeHostWslSetup,
} from '../runtime-host-wsl-controller.js';

const OPERATOR = {
  kind: 'node' as const,
  platform: 'posix' as const,
  nodePath: '/usr/bin/node',
  modulePath: '/home/operator/.local/share/maka/operator.mjs',
};

test('WSL management invokes the stable operator directly with the exact deployment target', async () => {
  let launch:
    | { readonly executable: string; readonly args: readonly string[]; readonly environment: NodeJS.ProcessEnv }
    | undefined;
  const frame = encodeRuntimeHostServiceManagementFrame({
    schemaVersion: 1,
    kind: 'result',
    action: 'configure',
    service: {
      platform: 'linux',
      arch: 'x64',
      osRelease: '6.8.0',
      state: 'running',
      pid: 42,
      lastExitCode: 0,
      installedVersion: '0.2.0',
      configurationFingerprint: `sha256:${'c'.repeat(64)}`,
      projectDirectoryRoots: [{ label: '工作', path: '/srv/work' }],
    },
    configuration: { kind: 'configured' },
  });
  const result = await runDesktopRuntimeHostWslManagement({
    distribution: 'Ubuntu',
    operator: OPERATOR,
    action: 'configure',
    expectedTarget: {
      serviceId: 'a'.repeat(64),
      rootPath: '/home/operator/.config/Maka/workspaces/default',
      rootId: 'a'.repeat(64),
      deploymentId: '00000000-0000-4000-8000-000000000001',
    },
    projectDirectoryRoots: [{ label: 'Work', path: '/srv/work' }],
    expectedConfigFingerprint: `sha256:${'b'.repeat(64)}`,
  }, {
    wslExecutable: 'wsl.exe',
    processFactory: (executable, args, environment) => {
      launch = { executable, args: [...args], environment };
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { stdin, stdout, stderr, kill: () => true });
      process.nextTick(() => {
        const bytes = Buffer.from(frame);
        const split = bytes.indexOf(Buffer.from('工作')) + 1;
        stdout.write(bytes.subarray(0, split));
        stdout.end(bytes.subarray(split));
        stderr.end();
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  assert.equal(launch?.executable, 'wsl.exe');
  assert.deepEqual(launch?.args.slice(0, 6), [
    '--distribution',
    'Ubuntu',
    '--exec',
    '/usr/bin/node',
    '/home/operator/.local/share/maka/operator.mjs',
    'configure',
  ]);
  assert.ok(launch?.args.includes('--expected-deployment-id'));
  assert.equal(
    launch?.environment[RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV],
    '1',
  );
  assert.ok(
    launch?.environment.WSLENV?.split(':').includes(
      RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV,
    ),
  );
  assert.equal(result.kind, 'result');
  assert.equal(result.action, 'configure');
  if (result.kind !== 'result' || result.action !== 'configure') {
    assert.fail('Expected the WSL operator configure result');
  }
  assert.deepEqual(result.service.projectDirectoryRoots, [
    { label: '工作', path: '/srv/work' },
  ]);
});

test('WSL setup forwards the development archive and its exact evidence', async () => {
  const launches: string[][] = [];
  const processFactory: RuntimeHostWslProcessFactory = (_executable, args) => {
    launches.push([...args]);
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, kill: () => true });
    process.nextTick(() => {
      if (launches.length === 1) stdout.end('/mnt/c/maka-development.tgz\n');
      else {
        stdout.end(encodeRuntimeHostSetupFrame({
          schemaVersion: 1,
          sequence: 0,
          kind: 'complete',
          version: '0.2.0-development',
          serviceId: 'b'.repeat(64),
          deploymentId: '00000000-0000-4000-8000-000000000001',
          operator: { ...OPERATOR, modulePath: '/tmp/maka/operator.mjs' },
          rootPath: '/tmp/maka/root',
          rootId: 'a'.repeat(64),
          endpoint: 'ws://127.0.0.1:7443/runtime-host',
          credentialId: 'credential-1',
          credential: 'secret-access-token',
        }));
      }
      stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  };
  const integrity = `sha512-${createHash('sha512').update('archive evidence').digest('base64')}`;

  await runDesktopRuntimeHostWslSetup({
    distribution: 'Ubuntu',
    setupPackage: {
      kind: 'development_archive',
      path: 'C:\\maka-development.tgz',
      integrity,
    },
    principalId: 'desktop-owner:pairing',
  }, () => undefined, undefined, { processFactory, wslExecutable: 'wsl.exe' });

  assert.deepEqual(launches[0], [
    '--distribution',
    'Ubuntu',
    '--exec',
    'wslpath',
    '-a',
    '-u',
    'C:\\maka-development.tgz',
  ]);
  const setupCommand = launches[1]?.at(-1) ?? '';
  assert.match(setupCommand, new RegExp(`${RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV}=`, 'u'));
  assert.ok(setupCommand.includes(integrity));
  assert.match(setupCommand, /--package.*\/mnt\/c\/maka-development\.tgz/u);
});
