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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  encodeRuntimeHostPeerMeshManagementFrame,
  encodeRuntimeHostServiceManagementFrame,
  encodeRuntimeHostSetupFrame,
  RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV,
  RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV,
} from '@maka/runtime-host/operator';
import {
  createDesktopRuntimeHostLocalOperator,
  runtimeHostLocalSetupCommand,
} from '../runtime-host-local-operator.js';

const OPERATOR = {
  kind: 'node' as const,
  platform: 'posix' as const,
  nodePath: '/usr/bin/node',
  modulePath: '/tmp/maka/operator.mjs',
};

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
        operator: OPERATOR,
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

test('local setup scratch cleanup cannot replace its framed outcome', async (t) => {
  const frames = [
    {
      schemaVersion: 1 as const,
      sequence: 0,
      kind: 'complete' as const,
      version: '0.2.0',
      serviceId: 'b'.repeat(64),
      deploymentId: '00000000-0000-4000-8000-000000000001',
      operator: OPERATOR,
      rootPath: '/tmp/maka/root',
      rootId: 'a'.repeat(64),
      endpoint: 'ws://127.0.0.1:7443/runtime-host',
      credentialId: 'credential-1',
      credential: 'secret-access-token',
    },
    {
      schemaVersion: 1 as const,
      sequence: 0,
      kind: 'error' as const,
      error: { code: 'setup_failed', message: 'primary setup failure' },
    },
  ];
  let invocation = 0;
  let cleanupCount = 0;
  const spawnProcess = (() => {
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const frame = frames[invocation++];
    Object.assign(child, { pid: 1234, stdout, stderr, kill: () => true });
    process.nextTick(() => {
      stdout.end(encodeRuntimeHostSetupFrame(frame));
      stderr.end();
      child.emit('close', frame.kind === 'complete' ? 0 : 1, null);
    });
    return child;
  }) as typeof spawn;
  const operator = createDesktopRuntimeHostLocalOperator({
    environment: { PATH: process.env.PATH },
    spawnProcess,
    removeSetupWorkingDirectory: async (path) => {
      cleanupCount += 1;
      await rm(path, { recursive: true, force: true });
      throw new Error('scratch cleanup failed');
    },
  });
  t.after(() => operator.close());
  const setup = {
    setupPackage: { kind: 'npm' as const, specifier: 'maka-agent@0.2.0' },
    clientDataRoot: '/tmp/maka/client',
    rootPath: '/tmp/maka/root',
    principalId: 'desktop-owner:pairing',
    expectedTarget: {
      serviceId: 'b'.repeat(64),
      rootPath: '/tmp/maka/root',
      rootId: 'a'.repeat(64),
    },
  };

  const complete = await operator.runSetup(setup, () => undefined);
  assert.equal(complete.kind, 'complete');
  await assert.rejects(
    operator.runSetup(setup, () => undefined),
    /primary setup failure/u,
  );
  assert.equal(cleanupCount, 2);
});

test('Windows npm discovery cannot outlive setup cancellation', async (t) => {
  const originalPlatform = process.platform;
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'maka-windows-npm-lookup-'));
  const resolver = join(fixtureRoot, 'hang.cjs');
  await writeFile(
    resolver,
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n',
  );
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(async () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  let setupSpawned = false;
  const operator = createDesktopRuntimeHostLocalOperator({
    environment: { PATH: process.env.PATH, NODE_OPTIONS: `--require=${resolver}` },
    setupTimeoutMs: 60_000,
    spawnProcess: (() => {
      setupSpawned = true;
      throw new Error('npm must not start after cancellation');
    }) as typeof spawn,
  });
  t.after(() => operator.close());
  const cancellation = new AbortController();
  const startedAt = Date.now();
  const setup = operator.runSetup(
    {
      setupPackage: { kind: 'npm', specifier: 'maka-agent@0.2.0' },
      clientDataRoot: '/tmp/maka/client',
      rootPath: '/tmp/maka/root',
      principalId: 'desktop-owner:pairing',
      expectedTarget: {
        serviceId: 'b'.repeat(64),
        rootPath: '/tmp/maka/root',
        rootId: 'a'.repeat(64),
      },
      signal: cancellation.signal,
    },
    () => undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  cancellation.abort(new Error('setup cancelled'));

  await assert.rejects(setup, /setup cancelled/u);
  assert.equal(setupSpawned, false);
  assert.ok(Date.now() - startedAt < 1_000);
});

test('local update runs the selected package against the exact managed deployment', async (t) => {
  let executable: string | undefined;
  let args: readonly string[] | undefined;
  let environment: NodeJS.ProcessEnv | undefined;
  const phases: string[] = [];
  const spawnProcess = ((command, commandArgs, options) => {
    executable = command;
    args = commandArgs;
    environment = options?.env;
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { pid: 1234, stdout, stderr, kill: () => true });
    process.nextTick(() => {
      stdout.end(
        encodeRuntimeHostServiceManagementFrame({
          schemaVersion: 1,
          kind: 'progress',
          action: 'update',
          phase: 'staging',
          currentVersion: '0.2.0',
          targetVersion: '0.3.0',
        }) +
        encodeRuntimeHostServiceManagementFrame({
          schemaVersion: 1,
          kind: 'result',
          action: 'update',
          service: {
            platform: 'darwin',
            arch: 'arm64',
            osRelease: '25.6.0',
            state: 'running',
            pid: 42,
            lastExitCode: 0,
            installedVersion: '0.3.0',
            projectDirectoryRoots: [],
          },
          update: { kind: 'updated', previousVersion: '0.2.0', targetVersion: '0.3.0' },
        }),
      );
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
  const deploymentId = '00000000-0000-4000-8000-000000000001';
  const operatorArgs = () => {
    if (process.platform !== 'win32') {
      assert.equal(executable, 'npm');
      return args;
    }
    assert.match(executable ?? '', /[\\/]node\.exe$/ui);
    assert.match(args?.[0] ?? '', /[\\/]npm-cli\.js$/u);
    return args?.slice(1);
  };

  await operator.runUpdate(
    {
      setupPackage: { kind: 'npm', specifier: 'maka-agent@0.3.0' },
      target: {
        serviceId: 'a'.repeat(64),
        rootPath: '/tmp/maka/root',
        rootId: 'a'.repeat(64),
        deploymentId,
      },
      expectedHost: { hostEpoch: 'older-host', pid: 42 },
      allowManualUpdate: true,
    },
    (phase) => phases.push(phase),
  );

  assert.deepEqual(operatorArgs(), [
    'exec', '--yes', '--package', 'maka-agent@0.3.0', '--',
    'maka', 'runtime-host', 'service', 'update', '--framed',
    '--target', '0.3.0',
    '--managed-root-id', 'a'.repeat(64),
    '--expected-host-json', JSON.stringify({ hostEpoch: 'older-host', pid: 42 }),
    '--expected-service-id', 'a'.repeat(64),
    '--expected-root-path', '/tmp/maka/root',
    '--expected-root-id', 'a'.repeat(64),
    '--expected-deployment-id', deploymentId,
    '--allow-manual-update',
  ]);
  assert.equal(
    environment?.[RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV],
    '1',
  );
  assert.deepEqual(phases, ['staging']);

  const developmentIntegrity = `sha512-${Buffer.alloc(64, 9).toString('base64')}`;
  await operator.runUpdate(
    {
      setupPackage: {
        kind: 'development_archive',
        path: '/tmp/maka-agent-development.tgz',
        integrity: developmentIntegrity,
      },
      target: {
        serviceId: 'a'.repeat(64),
        rootPath: '/tmp/maka/root',
        rootId: 'a'.repeat(64),
        deploymentId,
      },
      allowManualUpdate: true,
      allowInterruptActiveTasks: true,
    },
    () => undefined,
  );

  assert.deepEqual(operatorArgs(), [
    'exec', '--yes', '--package', '/tmp/maka-agent-development.tgz', '--',
    'maka', 'runtime-host', 'service', 'update', '--framed',
    '--managed-root-id', 'a'.repeat(64),
    '--expected-service-id', 'a'.repeat(64),
    '--expected-root-path', '/tmp/maka/root',
    '--expected-root-id', 'a'.repeat(64),
    '--expected-deployment-id', deploymentId,
    '--allow-interrupt-active-tasks',
  ]);
  assert.equal(
    environment?.[RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV],
    developmentIntegrity,
  );
});

test('local Peer Mesh join keeps invitations off argv and accepts bounded large results', async (t) => {
  let args: readonly string[] | undefined;
  let input = '';
  const largeSnapshot = {
    available: true,
    localPeerId: 'local-peer',
    meshes: Array.from({ length: 16 }, (_, meshIndex) => ({
      meshId: `mesh-${meshIndex}`,
      role: 'authority' as const,
      authorityPeerId: 'local-peer',
      revision: 1,
      closed: false,
      members: Array.from({ length: 64 }, (_, memberIndex) => ({
        peerId: `peer-${meshIndex}-${memberIndex}-${'x'.repeat(48)}`,
        endpointKind: 'client' as const,
        displayName: `Member ${meshIndex}-${memberIndex} ${'x'.repeat(60)}`,
        state: 'reachable' as const,
        expiresAt: 4_000_000_000_000,
      })),
      pendingInvitationCount: 0,
    })),
    transit: {
      meshId: null,
      allowedMemberCount: 0,
      activeReservationCount: 0,
      activeCircuitCount: 0,
      maxReservationCount: 32,
      maxCircuitCount: 8,
      maxCircuitsPerPeer: 2,
      maxCircuitDurationSeconds: 7_200,
      maxCircuitBytes: 256 * 1024 * 1024,
    },
  };
  const spawnProcess = ((_command, commandArgs) => {
    args = Array.isArray(commandArgs) ? commandArgs : undefined;
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.on('data', (chunk: Buffer) => { input += chunk.toString('utf8'); });
    Object.assign(child, { pid: 1234, stdin, stdout, stderr, kill: () => true });
    process.nextTick(() => {
      const resultFrame = encodeRuntimeHostPeerMeshManagementFrame({
        kind: 'result',
        action: 'join',
        result: largeSnapshot,
      });
      assert.ok(resultFrame.length > 30_000);
      stdout.write(
        encodeRuntimeHostPeerMeshManagementFrame({ kind: 'input', action: 'join' }) +
        resultFrame.slice(0, 30_000),
      );
      stdout.end(resultFrame.slice(30_000));
      stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  }) as typeof spawn;
  const operator = createDesktopRuntimeHostLocalOperator({ spawnProcess });
  t.after(() => operator.close());
  const invitation = JSON.stringify({ secret: 'one-time-mesh-secret' });

  const result = await operator.runPeerMesh({
    operator: OPERATOR,
    action: 'join',
    target: {
      serviceId: 'b'.repeat(64),
      rootPath: '/tmp/maka/root',
      rootId: 'a'.repeat(64),
      deploymentId: '00000000-0000-4000-8000-000000000001',
    },
    invitation,
  });

  assert.deepEqual(args, [
    OPERATOR.modulePath,
    'mesh', 'join', '--framed',
    '--expected-service-id', 'b'.repeat(64),
    '--expected-root-path', '/tmp/maka/root',
    '--expected-root-id', 'a'.repeat(64),
    '--expected-deployment-id', '00000000-0000-4000-8000-000000000001',
  ]);
  assert.equal(input, `${invitation}\n`);
  assert.equal(
    result.kind === 'result' && result.action === 'join' ? result.result.meshes.length : 0,
    16,
  );
});
