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
import { test } from 'node:test';
import { createDesktopRuntimeHostManagement } from '../runtime-host-management.js';
import type {
  DesktopRuntimeHostSshCleanupInput,
  DesktopRuntimeHostSshManagementInput,
} from '../runtime-host-ssh-terminal.js';

test('manages only the service identity bound by Desktop onboarding', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const managementInputs: DesktopRuntimeHostSshManagementInput[] = [];
  const cleanupInputs: DesktopRuntimeHostSshCleanupInput[] = [];
  const uninstallOrder: string[] = [];
  let cleared = 0;
  const managedProfile = {
    id: 'office',
    name: 'Office',
    kind: 'remote' as const,
    rootId: 'a'.repeat(64),
    transport: {
      kind: 'ssh' as const,
      destination: 'operator@example.com',
      remotePort: 7443,
      websocketPath: '/runtime-host',
    },
  };
  const managedService = {
    id: 'b'.repeat(64),
    rootPath: '/srv/maka',
    operatorPath: '/home/operator/.local/share/maka/operator',
  };
  const management = createDesktopRuntimeHostManagement({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      resolveManagedService: async (profileId) =>
        profileId === managedProfile.id
          ? { profile: managedProfile, service: managedService, state: 'active' as const }
          : undefined,
      markManagedServiceUninstalling: async (binding) => {
        uninstallOrder.push('mark-uninstalling');
        return { ...binding, state: 'uninstalling' as const };
      },
      clearManagedServiceBinding: async () => {
        cleared += 1;
        uninstallOrder.push('clear-binding');
      },
    },
    runServiceManagement: async (input) => {
      managementInputs.push(input);
      if (input.action === 'uninstall') {
        uninstallOrder.push('uninstall-service');
      }
      return serviceResult(input.action);
    },
    cleanupManagedDeployment: async (input) => {
      cleanupInputs.push(input);
      uninstallOrder.push('cleanup-deployment');
    },
  });
  const run = handlers.get('runtime-host-management:run');
  assert.ok(run);

  await assert.rejects(
    run({}, 'manual', 'uninstall') as Promise<unknown>,
    /not bound to a managed service/u,
  );
  await run({}, 'office', 'status');
  const managementInput = managementInputs.at(-1);
  assert.deepEqual(managementInput && {
    destination: managementInput.destination,
    operatorPath: managementInput.operatorPath,
    expectedTarget: managementInput.expectedTarget,
  }, {
    destination: 'operator@example.com',
    operatorPath: managedService.operatorPath,
    expectedTarget: {
      serviceId: managedService.id,
      rootPath: managedService.rootPath,
      rootId: managedProfile.rootId,
    },
  });

  await run({}, 'office', 'install');
  const repairInput = managementInputs.at(-1);
  assert.deepEqual(repairInput && {
    action: repairInput.action,
    rootPath: repairInput.rootPath,
    websocketPort: repairInput.websocketPort,
    websocketPath: repairInput.websocketPath,
  }, {
    action: 'install',
    rootPath: '/srv/maka',
    websocketPort: 7443,
    websocketPath: '/runtime-host',
  });

  await run({}, 'office', 'uninstall');
  assert.equal(cleared, 1);
  assert.deepEqual(uninstallOrder, [
    'uninstall-service',
    'mark-uninstalling',
    'cleanup-deployment',
    'clear-binding',
  ]);
  assert.deepEqual(cleanupInputs, [{
    destination: managedProfile.transport.destination,
    operatorPath: managedService.operatorPath,
  }]);
  management.close();
  assert.equal(handlers.size, 0);
});

test('resumes deployment cleanup without repeating the committed service uninstall', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const profile = {
    id: 'office',
    name: 'Office',
    kind: 'remote' as const,
    rootId: 'a'.repeat(64),
    transport: {
      kind: 'ssh' as const,
      destination: 'operator@example.com',
      remotePort: 7443,
      websocketPath: '/runtime-host',
    },
  };
  const service = {
    id: 'b'.repeat(64),
    rootPath: '/srv/maka',
    operatorPath: '/home/operator/.local/share/maka/operator',
  };
  const calls: DesktopRuntimeHostSshManagementInput[] = [];
  let cleanups = 0;
  let state: 'active' | 'uninstalling' = 'active';
  let clearAttempts = 0;
  createDesktopRuntimeHostManagement({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      resolveManagedService: async () => ({ profile, service, state }),
      markManagedServiceUninstalling: async (binding) => {
        state = 'uninstalling';
        return { ...binding, state };
      },
      clearManagedServiceBinding: async () => {
        clearAttempts += 1;
        if (clearAttempts === 1) throw new Error('local metadata is unavailable');
      },
    },
    runServiceManagement: async (input) => {
      calls.push(input);
      return serviceResult(input.action);
    },
    cleanupManagedDeployment: async () => {
      cleanups += 1;
    },
  });

  const run = handlers.get('runtime-host-management:run');
  assert.ok(run);
  await assert.rejects(
    run({}, profile.id, 'uninstall') as Promise<unknown>,
    /local metadata is unavailable/u,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.retainManagedDeployment, true);
  assert.deepEqual(await run({}, profile.id, 'uninstall'), {
    kind: 'uninstalled',
    retainedStateRoot: service.rootPath,
  });
  assert.equal(calls.length, 1);
  assert.equal(cleanups, 2);
});

test('does not commit uninstall until the remote service confirms it is removed', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let marked = false;
  createDesktopRuntimeHostManagement({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      resolveManagedService: async () => ({
        profile: {
          id: 'office',
          name: 'Office',
          kind: 'remote' as const,
          rootId: 'a'.repeat(64),
          transport: {
            kind: 'ssh' as const,
            destination: 'operator@example.com',
            remotePort: 7443,
            websocketPath: '/runtime-host',
          },
        },
        service: {
          id: 'b'.repeat(64),
          rootPath: '/srv/maka',
          operatorPath: '/home/operator/.local/share/maka/operator',
        },
        state: 'active' as const,
      }),
      markManagedServiceUninstalling: async (binding) => {
        marked = true;
        return { ...binding, state: 'uninstalling' as const };
      },
      clearManagedServiceBinding: async () => assert.fail('uninstall was not committed'),
    },
    runServiceManagement: async () => {
      const result = serviceResult('uninstall');
      return {
        ...result,
        service: { ...result.service, state: 'running' as const, pid: 42 },
      };
    },
    cleanupManagedDeployment: async () => assert.fail('cleanup must not start'),
  });

  const run = handlers.get('runtime-host-management:run');
  assert.ok(run);
  await assert.rejects(
    run({}, 'office', 'uninstall') as Promise<unknown>,
    /did not confirm/u,
  );
  assert.equal(marked, false);
});

function serviceResult(action: DesktopRuntimeHostSshManagementInput['action']) {
  return {
    schemaVersion: 1 as const,
    kind: 'result' as const,
    action,
    service: {
      platform: 'linux',
      arch: 'x64',
      osRelease: '6.8.0',
      state: action === 'uninstall' ? 'not_installed' as const : 'running' as const,
      pid: action === 'uninstall' ? null : 42,
      lastExitCode: 0,
      installedVersion: action === 'uninstall' ? null : '1.2.3',
      projectDirectoryRoots: [],
    },
  };
}
