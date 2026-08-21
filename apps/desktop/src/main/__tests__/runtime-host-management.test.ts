import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopRuntimeHostManagement } from '../runtime-host-management.js';
import type { DesktopRuntimeHostSshManagementInput } from '../runtime-host-ssh-terminal.js';

test('manages only the service identity bound by Desktop onboarding', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const managementInputs: DesktopRuntimeHostSshManagementInput[] = [];
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
        uninstallOrder.push(input.retainManagedDeployment ? 'retain-operator' : 'purge-package');
      }
      return serviceResult(input.action);
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

  await run({}, 'office', 'repair');
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
    'retain-operator',
    'mark-uninstalling',
    'purge-package',
    'clear-binding',
  ]);
  assert.equal(managementInputs.at(-1)?.resumeManagedDeploymentCleanup, true);
  management.close();
  assert.equal(handlers.size, 0);
});

test('retains the remote operator when local uninstall cleanup fails', async () => {
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
  createDesktopRuntimeHostManagement({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      resolveManagedService: async () => ({ profile, service, state: 'active' as const }),
      markManagedServiceUninstalling: async (binding) => ({
        ...binding,
        state: 'uninstalling' as const,
      }),
      clearManagedServiceBinding: async () => {
        throw new Error('local metadata is unavailable');
      },
    },
    runServiceManagement: async (input) => {
      calls.push(input);
      return serviceResult(input.action);
    },
  });

  const run = handlers.get('runtime-host-management:run');
  assert.ok(run);
  await assert.rejects(
    run({}, profile.id, 'uninstall') as Promise<unknown>,
    /local metadata is unavailable/u,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.retainManagedDeployment, true);
  assert.equal(calls[1]?.allowMissingOperator, true);
  assert.equal(calls[1]?.resumeManagedDeploymentCleanup, true);
});

test('finishes local uninstall cleanup after the remote operator was removed', async () => {
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
  let cleared = false;
  createDesktopRuntimeHostManagement({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      resolveManagedService: async () => ({
        profile,
        service,
        state: 'uninstalling' as const,
      }),
      markManagedServiceUninstalling: async () => assert.fail('already uninstalling'),
      clearManagedServiceBinding: async () => {
        cleared = true;
      },
    },
    runServiceManagement: async () => ({
      schemaVersion: 1,
      kind: 'error',
      action: 'uninstall',
      error: {
        code: 'operator_missing',
        message: 'operator is absent',
      },
    }),
  });

  const run = handlers.get('runtime-host-management:run');
  assert.ok(run);
  assert.deepEqual(await run({}, profile.id, 'uninstall'), {
    kind: 'uninstalled',
    retainedStateRoot: service.rootPath,
  });
  assert.equal(cleared, true);
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
