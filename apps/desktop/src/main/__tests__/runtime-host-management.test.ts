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
import {
  runtimeHostAccessCredentialFingerprint,
  type RuntimeHostServiceManagementFrame,
} from '@maka/runtime-host/operator';
import { createDesktopRuntimeHostManagement } from '../runtime-host-management.js';
import type {
  DesktopRuntimeHostSshAccessInput,
  DesktopRuntimeHostSshCleanupInput,
  DesktopRuntimeHostSshManagementInput,
  DesktopRuntimeHostSshUpdateInput,
} from '../runtime-host-ssh-terminal.js';

test('identifies, rotates, and revokes managed credentials without exposing secrets', async () => {
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
  const principalId = 'desktop:original-installation';
  const replacement = 'maka_rh_replacement-secret';
  let profileEnabled = true;
  let prepareCalls = 0;
  const currentFingerprint = runtimeHostAccessCredentialFingerprint('maka_rh_current-secret');
  const credentials = [
    accessCredential('current', principalId, currentFingerprint),
    accessCredential(
      'obsolete',
      principalId,
      runtimeHostAccessCredentialFingerprint('maka_rh_obsolete-secret'),
    ),
  ];

  createDesktopRuntimeHostManagement({
    ...unusedUpdateDependencies(),
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      resolveManagedService: async () => ({ profile, service, state: 'active' as const }),
      resolveManagedAccess: async () => ({
        profile,
        service,
        state: 'active' as const,
        credentialFingerprint: currentFingerprint,
        enabled: profileEnabled,
      }),
      rotateManagedCredential: async (expected, credential) => {
        assert.equal(expected.profile, profile);
        assert.equal(expected.service, service);
        assert.equal(expected.credentialFingerprint, currentFingerprint);
        assert.equal(credential, replacement);
      },
      markManagedServiceUninstalling: async (binding) => binding,
      markManagedServiceCleanupPending: async (binding) => binding,
      clearManagedServiceBinding: async () => undefined,
    },
    runServiceManagement: async () => assert.fail('service management is not expected'),
    runAccessManagement: async (input: DesktopRuntimeHostSshAccessInput) => {
      if (input.action === 'list') {
        return { schemaVersion: 1, kind: 'result', action: 'list', credentials };
      }
      if (input.action === 'prepare') {
        prepareCalls += 1;
        assert.equal(input.currentCredentialFingerprint, currentFingerprint);
        const pending = {
          ...accessCredential(
            'replacement',
            principalId,
            runtimeHostAccessCredentialFingerprint(replacement),
          ),
          status: 'pending' as const,
          expiresAt: '2026-08-21T01:15:00.000Z',
        };
        return {
          schemaVersion: 1,
          kind: 'result',
          action: 'prepare',
          credential: replacement,
          credentials: [credentials[0]!, pending],
        };
      }
      assert.equal(input.currentCredentialFingerprint, currentFingerprint);
      if (input.credentialId === 'current') {
        return {
          schemaVersion: 1,
          kind: 'error',
          action: 'revoke',
          error: {
            code: 'credential_protected',
            message: 'Rotate this Desktop credential instead of revoking it',
          },
        };
      }
      return {
        schemaVersion: 1,
        kind: 'result',
        action: 'revoke',
        credentialId: input.credentialId!,
        revoked: true,
        credentials: [credentials[0]!],
      };
    },
    cleanupManagedDeployment: async () => assert.fail('cleanup is not expected'),
  });

  const list = handlers.get('runtime-host-management:list-credentials');
  const rotate = handlers.get('runtime-host-management:rotate-credential');
  const revoke = handlers.get('runtime-host-management:revoke-credential');
  assert.ok(list && rotate && revoke);
  const initial = await list({}, profile.id);
  assert.equal((initial as { canRotate: boolean }).canRotate, true);
  assert.deepEqual(
    (initial as { credentials: { credentialId: string; isCurrentDesktop: boolean }[] }).credentials
      .map(({ credentialId, isCurrentDesktop }) => ({ credentialId, isCurrentDesktop })),
    [
      { credentialId: 'current', isCurrentDesktop: true },
      { credentialId: 'obsolete', isCurrentDesktop: false },
    ],
  );
  await assert.rejects(
    revoke({}, profile.id, 'current') as Promise<unknown>,
    /Rotate this Desktop credential/u,
  );
  const revoked = await revoke({}, profile.id, 'obsolete');
  assert.equal(JSON.stringify(revoked).includes('obsolete-secret'), false);
  const rotated = await rotate({}, profile.id);
  assert.equal(JSON.stringify(rotated).includes(replacement), false);
  assert.deepEqual(
    (rotated as { credentials: { credentialId: string; isCurrentDesktop: boolean }[] }).credentials,
    [{
      credentialId: 'replacement',
      principalKind: 'remote_owner',
      principalId,
      status: 'active',
      createdAt: '2026-08-21T01:00:00.000Z',
      isCurrentDesktop: true,
    }],
  );
  profileEnabled = false;
  assert.equal((await list({}, profile.id) as { canRotate: boolean }).canRotate, false);
  await assert.rejects(
    rotate({}, profile.id) as Promise<unknown>,
    /Enable this Runtime Host before rotating/u,
  );
  assert.equal(prepareCalls, 1);
});

test('manages only the service identity bound by Desktop onboarding', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const managementInputs: DesktopRuntimeHostSshManagementInput[] = [];
  const cleanupInputs: DesktopRuntimeHostSshCleanupInput[] = [];
  const uninstallOrder: string[] = [];
  let operatorAccess = false;
  let cleared = 0;
  let statusGate: Promise<void> | undefined;
  let releaseStatus: (() => void) | undefined;
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
    ...unusedUpdateDependencies(),
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      resolveManagedService: async (profileId) =>
        profileId === managedProfile.id
          ? { profile: managedProfile, service: managedService, state: 'active' as const }
          : undefined,
      resolveManagedAccess: async () => undefined,
      markManagedServiceUninstalling: async (binding) => {
        uninstallOrder.push('mark-uninstalling');
        return { ...binding, state: 'uninstalling' as const };
      },
      markManagedServiceCleanupPending: async (binding) => {
        uninstallOrder.push('mark-cleanup-pending');
        return { ...binding, state: 'cleanup_pending' as const };
      },
      clearManagedServiceBinding: async () => {
        cleared += 1;
        uninstallOrder.push('clear-binding');
      },
      rotateManagedCredential: async () => assert.fail('credential rotation is not expected'),
    },
    runServiceManagement: async (input) => {
      managementInputs.push(input);
      if (input.action === 'status') await statusGate;
      if (input.action === 'uninstall') {
        uninstallOrder.push('uninstall-service');
      }
      return serviceResult(input.action, operatorAccess);
    },
    runAccessManagement: async () => assert.fail('access management is not expected'),
    cleanupManagedDeployment: async (input) => {
      cleanupInputs.push(input);
      uninstallOrder.push('cleanup-deployment');
    },
  });
  const run = handlers.get('runtime-host-management:run');
  assert.ok(run);

  statusGate = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  const firstStatus = run({}, 'office', 'status');
  const secondStatus = run({}, 'office', 'status');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(managementInputs.length, 1);
  releaseStatus?.();
  await Promise.all([firstStatus, secondStatus]);
  statusGate = undefined;
  managementInputs.length = 0;

  await assert.rejects(
    run({}, 'manual', 'uninstall') as Promise<unknown>,
    /not bound to a managed service/u,
  );
  const legacyStatus = await run({}, 'office', 'status');
  assert.equal(
    (legacyStatus as { accessManagementAvailable: boolean }).accessManagementAvailable,
    false,
  );
  operatorAccess = true;
  const currentStatus = await run({}, 'office', 'status');
  assert.equal(
    (currentStatus as { accessManagementAvailable: boolean }).accessManagementAvailable,
    true,
  );
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
    'mark-uninstalling',
    'uninstall-service',
    'mark-cleanup-pending',
    'cleanup-deployment',
    'clear-binding',
  ]);
  assert.deepEqual(cleanupInputs, [{
    destination: managedProfile.transport.destination,
    operatorPath: managedService.operatorPath,
    expectedTarget: {
      serviceId: managedService.id,
      rootPath: managedService.rootPath,
      rootId: managedProfile.rootId,
    },
  }]);
  management.close();
  assert.equal(handlers.size, 0);
});

test('publishes update progress and waits for the managed profile to reconnect', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const updates: DesktopRuntimeHostSshUpdateInput[] = [];
  const progress: unknown[] = [];
  const connectionCompletions: unknown[] = [];
  let failConnection = false;
  let bindingPresent = true;
  let removeBindingAfterUpdate = false;
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
  createDesktopRuntimeHostManagement({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      resolveManagedService: async () =>
        bindingPresent ? { profile, service, state: 'active' as const } : undefined,
      resolveManagedAccess: async () => undefined,
      rotateManagedCredential: async () => assert.fail('credential rotation is not expected'),
      markManagedServiceUninstalling: async (binding) => binding,
      markManagedServiceCleanupPending: async (binding) => binding,
      clearManagedServiceBinding: async () => undefined,
    },
    runServiceManagement: async () => assert.fail('ordinary management is not expected'),
    runUpdate: async (input, onProgress) => {
      updates.push(input);
      onProgress('staging');
      if (removeBindingAfterUpdate) bindingPresent = false;
      return {
        schemaVersion: 1,
        kind: 'result',
        action: 'update',
        service: {
          platform: 'linux',
          arch: 'x64',
          osRelease: '6.8.0',
          state: 'running',
          pid: 43,
          lastExitCode: 0,
          installedVersion: '1.3.0',
          projectDirectoryRoots: [],
        },
        operatorCapabilities: ['access-management-v1'],
        update: { kind: 'updated', previousVersion: '1.2.3', targetVersion: '1.3.0' },
      };
    },
    resolveUpdatePackage: () => ({ kind: 'npm', specifier: 'maka-agent@1.3.0' }),
    currentHostEpoch: () => 'host-before-update',
    awaitUpdatedConnection: async (...args) => {
      connectionCompletions.push(args);
      if (failConnection) throw new Error('authentication required');
    },
    sendProgress: (event) => progress.push(event),
    runAccessManagement: async () => assert.fail('access management is not expected'),
    cleanupManagedDeployment: async () => assert.fail('cleanup is not expected'),
  });

  const update = handlers.get('runtime-host-management:update');
  assert.ok(update);
  const response = await update({}, profile.id, false);
  assert.equal((response as { accessManagementAvailable: boolean }).accessManagementAvailable, true);
  assert.deepEqual(updates, [{
    destination: profile.transport.destination,
    setupPackage: { kind: 'npm', specifier: 'maka-agent@1.3.0' },
    expectedTarget: {
      serviceId: service.id,
      rootPath: service.rootPath,
      rootId: profile.rootId,
    },
  }]);
  assert.deepEqual(progress, [{ profileId: profile.id, phase: 'staging' }]);
  assert.deepEqual(connectionCompletions, [
    [profile.id, profile.rootId, 'host-before-update', true],
  ]);

  removeBindingAfterUpdate = true;
  const changedProfile = await update({}, profile.id, false);
  assert.equal(
    (changedProfile as { kind: string; error?: { message: string } }).error?.message,
    'The Runtime Host update completed, but Desktop could not reconnect: ' +
      'Runtime Host profile changed while its service was updating',
  );

  bindingPresent = true;
  removeBindingAfterUpdate = false;
  failConnection = true;
  const reconnectFailure = await update({}, profile.id, false);
  assert.deepEqual(reconnectFailure, {
    schemaVersion: 1,
    kind: 'error',
    action: 'update',
    error: {
      code: 'desktop_reconnect_failed',
      message:
        'The Runtime Host update completed, but Desktop could not reconnect: authentication required',
    },
  });
});

test('resumes deployment cleanup without invoking the removed operator', async () => {
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
  let state: 'active' | 'uninstalling' | 'cleanup_pending' = 'active';
  let clearAttempts = 0;
  createDesktopRuntimeHostManagement({
    ...unusedUpdateDependencies(),
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      resolveManagedService: async () => ({ profile, service, state }),
      resolveManagedAccess: async () => undefined,
      markManagedServiceUninstalling: async (binding) => {
        state = 'uninstalling';
        return { ...binding, state };
      },
      markManagedServiceCleanupPending: async (binding) => {
        state = 'cleanup_pending';
        return { ...binding, state };
      },
      clearManagedServiceBinding: async () => {
        clearAttempts += 1;
        if (clearAttempts === 1) throw new Error('local metadata is unavailable');
      },
      rotateManagedCredential: async () => assert.fail('credential rotation is not expected'),
    },
    runServiceManagement: async (input) => {
      calls.push(input);
      return serviceResult(input.action);
    },
    runAccessManagement: async () => assert.fail('access management is not expected'),
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

test('rechecks uninstall intent before retrying the remote service', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let marked = false;
  createDesktopRuntimeHostManagement({
    ...unusedUpdateDependencies(),
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
        state: 'uninstalling' as const,
      }),
      resolveManagedAccess: async () => undefined,
      markManagedServiceUninstalling: async (binding) => {
        marked = true;
        return { ...binding, state: 'uninstalling' as const };
      },
      markManagedServiceCleanupPending: async () => assert.fail('uninstall was not confirmed'),
      clearManagedServiceBinding: async () => assert.fail('uninstall was not committed'),
      rotateManagedCredential: async () => assert.fail('credential rotation is not expected'),
    },
    runServiceManagement: async () => {
      const result = serviceResult('uninstall');
      return {
        ...result,
        service: { ...result.service, state: 'running' as const, pid: 42 },
      };
    },
    runAccessManagement: async () => assert.fail('access management is not expected'),
    cleanupManagedDeployment: async () => assert.fail('cleanup must not start'),
  });

  const run = handlers.get('runtime-host-management:run');
  assert.ok(run);
  await assert.rejects(
    run({}, 'office', 'uninstall') as Promise<unknown>,
    /did not confirm/u,
  );
  assert.equal(marked, true);
});

function serviceResult(
  action: DesktopRuntimeHostSshManagementInput['action'],
  operatorAccess = false,
): Exclude<
  Extract<RuntimeHostServiceManagementFrame, { kind: 'result' }>,
  { action: 'check_update' | 'update' }
> {
  const result = {
    schemaVersion: 1 as const,
    kind: 'result' as const,
    ...(operatorAccess
      ? { operatorCapabilities: ['access-management-v1' as const] }
      : {}),
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
  return action === 'retire'
    ? { ...result, action, retirement: { kind: 'stopped' } }
    : { ...result, action };
}

function unusedUpdateDependencies() {
  return {
    runUpdate: async (): Promise<never> => assert.fail('update is not expected'),
    resolveUpdatePackage: () => ({ kind: 'npm', specifier: 'maka-agent@1.2.3' } as const),
    currentHostEpoch: () => undefined,
    awaitUpdatedConnection: async () => undefined,
    sendProgress: () => undefined,
  };
}

function accessCredential(
  credentialId: string,
  principalId: string,
  credentialFingerprint: string,
) {
  return {
    credentialId,
    credentialFingerprint,
    principalKind: 'remote_owner' as const,
    principalId,
    status: 'active' as const,
    operationGrants: ['host.status', 'turn.start'],
    canPublishClientCapabilities: true,
    canUseHostPaths: false,
    createdAt: '2026-08-21T01:00:00.000Z',
  };
}
