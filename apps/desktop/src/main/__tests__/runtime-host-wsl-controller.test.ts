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
  encodeRuntimeHostSetupFrame,
  RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV,
} from '@maka/runtime-host/operator';
import { runDesktopRuntimeHostWslSetup } from '../runtime-host-wsl-controller.js';

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
          operatorPath: '/tmp/maka/operator',
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
