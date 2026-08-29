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
import type { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  encodeRuntimeHostSetupFrame,
  RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV,
} from '@maka/runtime-host/operator';
import {
  createDesktopRuntimeHostLocalOperator,
  runtimeHostLocalSetupCommand,
} from '../runtime-host-local-operator.js';

test('local setup installs one managed service for the Desktop root with Direct peer enabled', () => {
  assert.deepEqual(
    runtimeHostLocalSetupCommand({
      packageSpecifier: 'maka-agent@0.2.0',
      clientDataRoot: '/Users/ada/Library/Application Support/Maka',
      rootPath: '/Users/ada/Library/Application Support/Maka/workspaces/default',
      principalId: 'desktop-owner:pairing',
      coordinationRelays: ['/dns4/discovery.example/udp/443/quic-v1'],
      expectedTarget: {
        serviceId: 'b'.repeat(64),
        rootPath: '/Users/ada/Library/Application Support/Maka/workspaces/default',
        rootId: 'a'.repeat(64),
      },
    }),
    {
      executable: 'npm',
      args: [
        'exec', '--yes', '--package', 'maka-agent@0.2.0', '--',
        'maka', 'runtime-host', 'setup',
        '--client-data-root', '/Users/ada/Library/Application Support/Maka',
        '--root', '/Users/ada/Library/Application Support/Maka/workspaces/default',
        '--principal', 'desktop-owner:pairing',
        '--preset', 'desktop-client',
        '--defer-pairing-commit',
        '--bind-pairing-to-client',
        '--enable-direct-peer',
        '--expected-service-id', 'b'.repeat(64),
        '--expected-root-path', '/Users/ada/Library/Application Support/Maka/workspaces/default',
        '--expected-root-id', 'a'.repeat(64),
        '--coordination-relay', '/dns4/discovery.example/udp/443/quic-v1',
        '--json',
      ],
    },
  );
});

test('local setup forwards the exact development archive evidence', async (t) => {
  const archive = '/tmp/maka-agent-development.tgz';
  const archiveBytes = Buffer.from('development package');
  const integrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`;
  let environment: NodeJS.ProcessEnv | undefined;
  const spawnProcess = ((_command, _args, options) => {
    environment = options?.env;
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { pid: 1234, stdout, stderr, kill: () => true });
    process.nextTick(() => {
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
      stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  }) as typeof spawn;
  const operator = createDesktopRuntimeHostLocalOperator({
    environment: { PATH: process.env.PATH },
    spawnProcess,
  });
  t.after(() => operator.close());

  await operator.runSetup({
    setupPackage: { kind: 'development_archive', path: archive, integrity },
    clientDataRoot: '/tmp/maka/client',
    rootPath: '/tmp/maka/root',
    principalId: 'desktop-owner:pairing',
    expectedTarget: {
      serviceId: 'b'.repeat(64),
      rootPath: '/tmp/maka/root',
      rootId: 'a'.repeat(64),
    },
  }, () => undefined);

  assert.equal(environment?.[RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV], integrity);
});
