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
import type { RuntimeHostServiceManagementFrame } from '@maka/runtime-host/operator';
import { createDesktopRuntimeHostLocalManagement } from '../runtime-host-local-management.js';
import type { DesktopLocalRuntimeHostRemoteAccess } from '../runtime-host-local-remote-access.js';
import type { createDesktopRuntimeHostLocalOperator } from '../runtime-host-local-operator.js';

test('manages the built-in Local profile through its managed-service authority', async () => {
  const allowances: (boolean | undefined)[] = [];
  const progress: unknown[] = [];
  const reconnects: unknown[] = [];
  const target = {
    serviceId: 'a'.repeat(64),
    rootPath: '/Users/ada/Library/Application Support/Maka/workspaces/default',
    rootId: 'a'.repeat(64),
    deploymentId: '11111111-1111-4111-8111-111111111111',
    operatorPath: '/Users/ada/Library/Application Support/Maka/operator',
  };
  const remoteAccess = {
    manage: async <T>(
      allowInterruptActiveTasks: boolean | undefined,
      operation: (value: typeof target) => Promise<T>,
    ) => {
      allowances.push(allowInterruptActiveTasks);
      return { kind: 'complete' as const, value: await operation(target) };
    },
    uninstall: async (value: unknown) =>
      (value as { allowInterruptActiveTasks: boolean }).allowInterruptActiveTasks
        ? { kind: 'uninstalled' as const }
        : { kind: 'active_tasks' as const },
  } as unknown as DesktopLocalRuntimeHostRemoteAccess;
  const operator = {
    runService: async (input: { action: string }) => serviceResult(input.action),
    runUpdate: async (_input: unknown, onProgress: (phase: 'staging') => void) => {
      onProgress('staging');
      return updateResult();
    },
  } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>;
  const provider = createDesktopRuntimeHostLocalManagement({
    remoteAccess,
    operator,
    rootPath: target.rootPath,
    resolveUpdatePackage: () => ({ kind: 'npm', specifier: 'maka-agent@0.3.0' }),
    currentHostEpoch: () => 'before-update',
    awaitUpdatedConnection: async (...args) => {
      reconnects.push(args);
    },
    sendProgress: (event) => progress.push(event),
  });

  const status = await provider.run('status');
  assert.equal(status.kind, 'result');
  if (status.kind === 'result') assert.equal(status.accessManagementAvailable, false);
  assert.equal(provider.directPeer, undefined);
  assert.equal(provider.access, undefined);

  const updated = await provider.update(false);
  assert.equal(updated.kind, 'result');
  assert.deepEqual(progress, [
    { profileId: 'local', phase: 'preparing_cli' },
    { profileId: 'local', phase: 'staging' },
  ]);
  assert.deepEqual(reconnects, [['before-update', true]]);

  const blocked = await provider.run('uninstall');
  assert.equal(blocked.kind, 'error');
  const uninstalled = await provider.run('uninstall', true);
  assert.deepEqual(uninstalled, { kind: 'uninstalled', retainedStateRoot: target.rootPath });
  assert.deepEqual(allowances, [undefined, false]);
});

function serviceResult(action: string): RuntimeHostServiceManagementFrame {
  return {
    schemaVersion: 1,
    kind: 'result',
    action: action as 'status',
    service: serviceSummary('0.2.0'),
  };
}

function updateResult(): RuntimeHostServiceManagementFrame {
  return {
    schemaVersion: 1,
    kind: 'result',
    action: 'update',
    service: serviceSummary('0.3.0'),
    update: { kind: 'updated', previousVersion: '0.2.0', targetVersion: '0.3.0' },
  };
}

function serviceSummary(version: string) {
  return {
    platform: 'darwin',
    arch: 'arm64',
    osRelease: '25.6.0',
    state: 'running' as const,
    pid: 42,
    lastExitCode: 0,
    installedVersion: version,
    projectDirectoryRoots: [],
  };
}
