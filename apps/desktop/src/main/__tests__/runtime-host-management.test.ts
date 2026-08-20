import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopRuntimeHostManagement } from '../runtime-host-management.js';
import type { DesktopRuntimeHostSshManagementInput } from '../runtime-host-ssh-terminal.js';

test('manages only the service identity bound by Desktop onboarding', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let managementInput: DesktopRuntimeHostSshManagementInput | undefined;
  const managedProfile = {
    id: 'office',
    name: 'Office',
    kind: 'remote' as const,
    rootId: 'a'.repeat(64),
    managedService: { id: 'b'.repeat(64), rootPath: '/srv/maka' },
    transport: {
      kind: 'ssh' as const,
      destination: 'operator@example.com',
      remotePort: 7443,
      websocketPath: '/runtime-host',
    },
  };
  const management = createDesktopRuntimeHostManagement({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    clientInstanceId: 'stable-client',
    profiles: {
      getSnapshot: async () => ({
        defaultProfileId: 'local',
        entries: [
          { profile: managedProfile, enabled: true, isDefault: false, readiness: 'ready' },
          {
            profile: { ...managedProfile, id: 'manual', managedService: undefined },
            enabled: false,
            isDefault: false,
            readiness: 'disabled',
          },
        ],
      }),
    },
    setupPackage: { kind: 'npm', specifier: 'maka-agent@1.2.3' },
    runServiceManagement: async (input) => {
      managementInput = input;
      return {
        schemaVersion: 1,
        kind: 'error',
        action: input.action,
        error: { code: 'test', message: 'test' },
      };
    },
  });
  const run = handlers.get('runtime-host-management:run');
  assert.ok(run);

  await assert.rejects(
    run({}, 'manual', 'uninstall') as Promise<unknown>,
    /not bound to a managed service/u,
  );
  await run({}, 'office', 'status');
  assert.deepEqual(managementInput && {
    destination: managementInput.destination,
    expectedServiceId: managementInput.expectedServiceId,
    expectedRootPath: managementInput.expectedRootPath,
    expectedRootId: managementInput.expectedRootId,
  }, {
    destination: 'operator@example.com',
    expectedServiceId: managedProfile.managedService.id,
    expectedRootPath: managedProfile.managedService.rootPath,
    expectedRootId: managedProfile.rootId,
  });
  management.close();
  assert.equal(handlers.size, 0);
});
