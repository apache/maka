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
  encodeRuntimeHostOwnerConnectionCode,
  RuntimeHostOperationError,
} from '@maka/runtime-host/client';
import {
  RUNTIME_HOST_OPERATOR_PEER_RELAY_DISCOVERY_CAPABILITY,
  RUNTIME_HOST_OPERATOR_PEER_WEBRTC_STUN_CAPABILITY,
  runtimeHostAccessCredentialFingerprint,
  type RuntimeHostServiceManagementFrame,
} from '@maka/runtime-host/operator';
import { createDesktopRuntimeHostManagement } from '../runtime-host-management.js';
import { createDesktopRuntimeHostPeerMeshManagement } from '../runtime-host-peer-mesh-management.js';
import type { DesktopRuntimeHostManagementProvider } from '../runtime-host-management-provider.js';
import type {
  DesktopRuntimeHostSshAccessInput,
  DesktopRuntimeHostSshCleanupInput,
  DesktopRuntimeHostSshManagementInput,
  DesktopRuntimeHostSshUpdateInput,
  DesktopRuntimeHostSshUpdatePolicyInput,
  DesktopRuntimeHostSshUpdateReconciliationInput,
} from '../runtime-host-ssh-terminal.js';
import type { DesktopRuntimeHostWslManagementInput } from '../runtime-host-wsl-controller.js';

const DEPLOYMENT_ID = '11111111-1111-4111-8111-111111111111';

test('cancels a live Runtime Host Mesh status query', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const pending = new Promise<never>(() => undefined);
  const management = createDesktopRuntimeHostPeerMeshManagement({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    localHost: {
      getSnapshot: async () => assert.fail('status must use the live Host'),
      inspectManaged: async () => assert.fail('status must use the live Host'),
    },
    runLocal: async () => assert.fail('status must use the live Host'),
    liveHost: () => ({
      request: ((operation: string) => {
        assert.equal(operation, 'peer.mesh.query');
        markStarted();
        return pending;
      }) as never,
    }),
    profiles: {
      resolveManagedService: async () => assert.fail('status must use the live Host'),
    },
    runRemote: async () => assert.fail('status must use the live Host'),
    readConnectivityPolicy: async () => ({ kind: 'default' }),
    writeConnectivityPolicy: async () => ({ kind: 'default' }),
  });
  const execute = handlers.get('runtime-host-peer-mesh:execute');
  const cancel = handlers.get('runtime-host-peer-mesh:cancel');
  assert.ok(execute && cancel);

  const status = execute(
    {},
    { kind: 'local_host' },
    'status',
    undefined,
    undefined,
    undefined,
    undefined,
    'status-1',
  ) as Promise<unknown>;
  await started;
  cancel({}, 'status-1');
  await assert.rejects(status, /cancelled/u);
  management.close();
});

test('projects an unknown live Mesh mutation outcome across IPC', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const management = createDesktopRuntimeHostPeerMeshManagement({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    localHost: {
      getSnapshot: async () => assert.fail('mutation must use the live Host'),
      inspectManaged: async () => assert.fail('mutation must use the live Host'),
    },
    runLocal: async () => assert.fail('mutation must use the live Host'),
    liveHost: () => ({
      request: (() =>
        Promise.reject(
          new RuntimeHostOperationError(
            'peer.mesh.close',
            'commit_outcome_unknown',
            'Mesh close outcome is unknown',
          ),
        )) as never,
    }),
    profiles: {
      resolveManagedService: async () => assert.fail('mutation must use the live Host'),
    },
    runRemote: async () => assert.fail('mutation must use the live Host'),
    readConnectivityPolicy: async () => ({ kind: 'default' }),
    writeConnectivityPolicy: async () => ({ kind: 'default' }),
  });
  const execute = handlers.get('runtime-host-peer-mesh:execute');
  assert.ok(execute);

  assert.deepEqual(
    await execute({}, { kind: 'local_host' }, 'close', 'mesh-1', undefined, undefined, undefined, 'close-1'),
    { kind: 'outcome_unknown' },
  );
  management.close();
});

test('requires explicit interruption authority before a provider restarts active work', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const provider = {
    profileId: 'local',
    accessManagementAvailable: false,
    run: async (action: string, allowInterruptActiveTasks: boolean) => {
      return action === 'restart' && !allowInterruptActiveTasks
        ? {
            schemaVersion: 1 as const,
            kind: 'error' as const,
            action: 'restart' as const,
            error: { code: 'active_tasks', message: 'Runtime Host still owns active work' },
          }
        : serviceResult(action as DesktopRuntimeHostSshManagementInput['action']);
    },
    uninstall: async () => ({ kind: 'uninstalled' as const, retainedStateRoot: '/state' }),
  } as unknown as DesktopRuntimeHostManagementProvider;
  createDesktopRuntimeHostManagement({
    ...unusedUpdateDependencies(),
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      ...unusedDirectPeerProfileDependencies(),
      resolveManagedService: async () => assert.fail('Local must not resolve an SSH service'),
      resolveManagedAccess: async () => assert.fail('Local must not resolve SSH access'),
      markManagedServiceUninstalling: async () => assert.fail('Local must not mutate SSH state'),
      markManagedServiceCleanupPending: async () => assert.fail('Local must not mutate SSH state'),
      clearManagedServiceBinding: async () => assert.fail('Local must not mutate SSH state'),
      rotateManagedCredential: async () => assert.fail('Local must not mutate SSH state'),
    },
    runServiceManagement: async () => assert.fail('Local must not use SSH transport'),
    runAccessManagement: async () => assert.fail('Local must not use SSH transport'),
    cleanupManagedDeployment: async () => assert.fail('Local must not use SSH transport'),
    providers: [provider],
  });

  const run = handlers.get('runtime-host-management:run');
  assert.ok(run);
  const blocked = await run({}, 'local', 'restart');
  const restarted = await run({}, 'local', 'restart', true);

  assert.equal((blocked as { kind: string }).kind, 'error');
  assert.equal((restarted as { kind: string }).kind, 'result');
  assert.throws(
    () => run({}, 'local', 'status', true),
    /authority is not valid for this action/u,
  );
});

test('routes WSL status and directory configuration through the persisted operator route', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const calls: DesktopRuntimeHostWslManagementInput[] = [];
  const profile = {
    id: 'ubuntu',
    name: 'Ubuntu',
    kind: 'environment' as const,
    provider: { kind: 'wsl' as const, distribution: 'Ubuntu-24.04' },
    rootId: 'a'.repeat(64),
    operatorPath: '/home/operator/.local/share/maka/operator',
  };
  const binding = {
    profile,
    deployment: {
      id: 'a'.repeat(64),
      rootPath: '/home/operator/.config/Maka/workspaces/default',
      deploymentId: DEPLOYMENT_ID,
    },
    state: 'active' as const,
  };
  let reconnects = 0;
  createDesktopRuntimeHostManagement({
    ...unusedUpdateDependencies(),
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      ...unusedDirectPeerProfileDependencies(),
      resolveManagedService: async () => binding,
      resolveManagedAccess: async () => undefined,
      rotateManagedCredential: async () => assert.fail('credential rotation is not expected'),
      markManagedServiceUninstalling: async () => assert.fail('uninstall is not expected'),
      markManagedServiceCleanupPending: async () => assert.fail('uninstall is not expected'),
      clearManagedServiceBinding: async () => assert.fail('uninstall is not expected'),
    },
    runServiceManagement: async () => assert.fail('WSL must not use SSH management'),
    runWslManagement: async (input) => {
      calls.push(input);
      return serviceResult(input.action);
    },
    runAccessManagement: async () => assert.fail('access management is not expected'),
    cleanupManagedDeployment: async () => assert.fail('cleanup is not expected'),
    currentHostEpoch: () => 'before-configure',
    awaitUpdatedConnection: async () => {
      reconnects += 1;
    },
  });

  const run = handlers.get('runtime-host-management:run');
  const configure = handlers.get('runtime-host-management:configure-project-directories');
  assert.ok(run);
  assert.ok(configure);
  await run({}, profile.id, 'status');
  await configure(
    {},
    profile.id,
    [{ label: 'Work', path: '/srv/work' }],
    `sha256:${'b'.repeat(64)}`,
    false,
  );

  assert.deepEqual(calls.map(({ action, distribution, operatorPath, expectedTarget }) => ({
    action,
    distribution,
    operatorPath,
    expectedTarget,
  })), [
    {
      action: 'status',
      distribution: 'Ubuntu-24.04',
      operatorPath: profile.operatorPath,
      expectedTarget: {
        serviceId: 'a'.repeat(64),
        rootPath: '/home/operator/.config/Maka/workspaces/default',
        rootId: 'a'.repeat(64),
        deploymentId: DEPLOYMENT_ID,
      },
    },
    {
      action: 'configure',
      distribution: 'Ubuntu-24.04',
      operatorPath: profile.operatorPath,
      expectedTarget: {
        serviceId: 'a'.repeat(64),
        rootPath: '/home/operator/.config/Maka/workspaces/default',
        rootId: 'a'.repeat(64),
        deploymentId: DEPLOYMENT_ID,
      },
    },
  ]);
  assert.equal(reconnects, 0);
});

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
  let issuedConnectionCode = encodeRuntimeHostOwnerConnectionCode({
    name: profile.name,
    rootId: profile.rootId,
    transport: {
      kind: 'libp2p-direct',
      reachability: testPeerReachability('12D3KooWoffice'),
    },
    credential: 'pending-credential',
  });
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
      ...unusedDirectPeerProfileDependencies(),
      resolveManagedDirectPeerProfile: async () => ({
        exists: true,
        enabled: false,
        peerId: '12D3KooWoffice',
      }),
      resolveManagedService: async () => managedBinding(profile, service, 'active'),
      resolveManagedAccess: async () => ({
        ...managedBinding(profile, service, 'active'),
        credentialFingerprint: currentFingerprint,
        enabled: profileEnabled,
      }),
      rotateManagedCredential: async (expected, credential) => {
        assert.equal(expected.profile, profile);
        assert.deepEqual(expected.deployment, {
          id: service.id,
          rootPath: service.rootPath,
          deploymentId: DEPLOYMENT_ID,
        });
        assert.deepEqual(expected.control, {
          kind: 'ssh_operator',
          operatorPath: service.operatorPath,
        });
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
      if (input.action === 'connection-code') {
        assert.equal(input.name, profile.name);
        return {
          schemaVersion: 1,
          kind: 'result',
          action: 'connection-code',
          connectionCode: issuedConnectionCode,
        };
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
  const connectionCode = handlers.get('runtime-host-management:create-connection-code');
  const rotate = handlers.get('runtime-host-management:rotate-credential');
  const revoke = handlers.get('runtime-host-management:revoke-credential');
  assert.ok(list && connectionCode && rotate && revoke);
  assert.equal(await connectionCode({}, profile.id), issuedConnectionCode);
  issuedConnectionCode = encodeRuntimeHostOwnerConnectionCode({
    name: profile.name,
    rootId: 'c'.repeat(64),
    transport: {
      kind: 'libp2p-direct',
      reachability: testPeerReachability('12D3KooWoffice'),
    },
    credential: 'pending-credential',
  });
  await assert.rejects(
    connectionCode({}, profile.id) as Promise<unknown>,
    /different Host/u,
  );
  issuedConnectionCode = encodeRuntimeHostOwnerConnectionCode({
    name: profile.name,
    rootId: profile.rootId,
    transport: {
      kind: 'libp2p-direct',
      reachability: testPeerReachability('12D3KooWunexpected'),
    },
    credential: 'pending-credential',
  });
  await assert.rejects(
    connectionCode({}, profile.id) as Promise<unknown>,
    /different Direct peer/u,
  );
  issuedConnectionCode = 'not-a-connection-code';
  await assert.rejects(
    connectionCode({}, profile.id) as Promise<unknown>,
    /connection code is invalid/u,
  );
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
      ...unusedDirectPeerProfileDependencies(),
      resolveManagedService: async (profileId) =>
        profileId === managedProfile.id
          ? managedBinding(managedProfile, managedService, 'active')
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
      deploymentId: DEPLOYMENT_ID,
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
    'cleanup-deployment',
    'clear-binding',
  ]);
  assert.deepEqual(cleanupInputs, [
    {
      destination: managedProfile.transport.destination,
      operatorPath: managedService.operatorPath,
      expectedTarget: {
        serviceId: managedService.id,
        rootPath: managedService.rootPath,
        rootId: managedProfile.rootId,
        deploymentId: DEPLOYMENT_ID,
      },
    },
    {
      destination: managedProfile.transport.destination,
      operatorPath: managedService.operatorPath,
      expectedTarget: {
        serviceId: managedService.id,
        rootPath: managedService.rootPath,
        rootId: managedProfile.rootId,
        deploymentId: DEPLOYMENT_ID,
      },
      finalize: true,
    },
  ]);
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
      ...unusedDirectPeerProfileDependencies(),
      resolveManagedService: async () =>
        bindingPresent ? managedBinding(profile, service, 'active') : undefined,
      resolveManagedAccess: async () => undefined,
      rotateManagedCredential: async () => assert.fail('credential rotation is not expected'),
      markManagedServiceUninstalling: async (binding) => binding,
      markManagedServiceCleanupPending: async (binding) => binding,
      clearManagedServiceBinding: async () => undefined,
    },
    runServiceManagement: async () => assert.fail('ordinary management is not expected'),
    runWslManagement: async () => assert.fail('WSL management is not expected'),
    runPeerManagement: async () => assert.fail('direct peer management is not expected'),
    directPeerClientAvailable: false,
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
    runUpdatePolicy: async () => assert.fail('update policy is not expected'),
    runUpdateReconciliation: async () =>
      assert.fail('update reconciliation is not expected'),
    setupPackageMode: 'published',
    resolveSshDevelopmentPeerTarget: async () =>
      assert.fail('published update must not inspect the development target'),
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
      deploymentId: DEPLOYMENT_ID,
    },
  }]);
  assert.deepEqual(progress, [
    { profileId: profile.id, phase: 'preparing_cli' },
    { profileId: profile.id, phase: 'staging' },
  ]);
  assert.deepEqual(connectionCompletions, [
    [profile.id, profile.rootId, 'host-before-update', true],
  ]);

  removeBindingAfterUpdate = true;
  const changedProfile = await update({}, profile.id, false);
  assert.equal(
    (changedProfile as { reconnectError?: { message: string } }).reconnectError?.message,
    'The Runtime Host change was applied, but Desktop could not reconnect: ' +
      'Runtime Host profile changed while its service was updating',
  );
  assert.equal((changedProfile as { kind: string }).kind, 'result');

  bindingPresent = true;
  removeBindingAfterUpdate = false;
  failConnection = true;
  const reconnectFailure = await update({}, profile.id, false);
  assert.equal((reconnectFailure as { kind: string }).kind, 'result');
  assert.deepEqual(
    (reconnectFailure as { reconnectError: { code: string; message: string } }).reconnectError,
    {
      code: 'desktop_reconnect_failed',
      message:
        'The Runtime Host change was applied, but Desktop could not reconnect: authentication required',
    },
  );
});

test('configures Project roots with CAS and reconnects only after a committed cutover', async () => {
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
  const fingerprint = `sha256:${'c'.repeat(64)}`;
  const inputs: DesktopRuntimeHostSshManagementInput[] = [];
  const reconnects: unknown[][] = [];
  let failReconnect = false;
  createDesktopRuntimeHostManagement({
    ...unusedUpdateDependencies(),
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      ...unusedDirectPeerProfileDependencies(),
      resolveManagedService: async () => managedBinding(profile, service, 'active'),
      resolveManagedAccess: async () => undefined,
      rotateManagedCredential: async () => assert.fail('credential rotation is not expected'),
      markManagedServiceUninstalling: async (binding) => binding,
      markManagedServiceCleanupPending: async (binding) => binding,
      clearManagedServiceBinding: async () => undefined,
    },
    runServiceManagement: async (input) => {
      inputs.push(input);
      assert.equal(input.action, 'configure');
      return {
        schemaVersion: 1,
        kind: 'result',
        action: 'configure',
        service: {
          ...serviceSummary('1.2.3'),
          configurationFingerprint:
            input.allowInterruptActiveTasks ? `sha256:${'d'.repeat(64)}` : fingerprint,
          projectDirectoryRoots: [...(input.projectDirectoryRoots ?? [])],
        },
        configuration: {
          kind: input.allowInterruptActiveTasks ? 'configured' : 'active_tasks',
        },
      };
    },
    runAccessManagement: async () => assert.fail('access management is not expected'),
    cleanupManagedDeployment: async () => assert.fail('cleanup is not expected'),
    currentHostEpoch: () => 'host-before-configure',
    awaitUpdatedConnection: async (...args) => {
      reconnects.push(args);
      if (failReconnect) throw new Error('authentication required');
    },
  });
  const configure = handlers.get('runtime-host-management:configure-project-directories');
  assert.ok(configure);
  const roots = [{ label: 'Work', path: '/srv/work ' }];
  const blocked = await configure({}, profile.id, roots, fingerprint, false);
  assert.equal(
    (blocked as { configuration: { kind: string } }).configuration.kind,
    'active_tasks',
  );
  assert.equal(reconnects.length, 0);

  const configured = await configure({}, profile.id, roots, fingerprint, true);
  assert.equal(
    (configured as { configuration: { kind: string } }).configuration.kind,
    'configured',
  );
  assert.deepEqual(inputs.map((input) => ({
    roots: input.projectDirectoryRoots,
    fingerprint: input.expectedConfigFingerprint,
    allowInterruptActiveTasks: input.allowInterruptActiveTasks ?? false,
  })), [
    { roots, fingerprint, allowInterruptActiveTasks: false },
    { roots, fingerprint, allowInterruptActiveTasks: true },
  ]);
  assert.deepEqual(reconnects, [[profile.id, profile.rootId, 'host-before-configure', true]]);

  failReconnect = true;
  const committedWithoutReconnect = await configure({}, profile.id, roots, fingerprint, true);
  assert.equal((committedWithoutReconnect as { kind: string }).kind, 'result');
  assert.equal(
    (committedWithoutReconnect as { service: { configurationFingerprint?: string } }).service
      .configurationFingerprint,
    `sha256:${'d'.repeat(64)}`,
  );
  assert.deepEqual(
    (committedWithoutReconnect as { reconnectError?: { code: string; message: string } })
      .reconnectError,
    {
      code: 'desktop_reconnect_failed',
      message:
        'The Runtime Host change was applied, but Desktop could not reconnect: authentication required',
    },
  );
});

test('manages one Host update policy and reconciles it through the bound operator', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const policyInputs: DesktopRuntimeHostSshUpdatePolicyInput[] = [];
  const reconciliationInputs: DesktopRuntimeHostSshUpdateReconciliationInput[] = [];
  const progress: unknown[] = [];
  const connections: unknown[] = [];
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
    ...unusedUpdateDependencies(),
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      ...unusedDirectPeerProfileDependencies(),
      resolveManagedService: async () => managedBinding(profile, service, 'active'),
      resolveManagedAccess: async () => undefined,
      rotateManagedCredential: async () => assert.fail('credential rotation is not expected'),
      markManagedServiceUninstalling: async (binding) => binding,
      markManagedServiceCleanupPending: async (binding) => binding,
      clearManagedServiceBinding: async () => undefined,
    },
    runServiceManagement: async () => assert.fail('ordinary management is not expected'),
    runUpdatePolicy: async (input) => {
      policyInputs.push(input);
      const policy = input.policy ?? { kind: 'manual' as const };
      return {
        schemaVersion: 1,
        kind: 'result',
        action: 'update_policy',
        updateSchedulerState: 'ready',
        updatePolicy: {
          policy,
          ...(policy.kind === 'manual' ? {} : { target: input.expectedTarget! }),
        },
      };
    },
    runUpdateReconciliation: async (input, onProgress) => {
      reconciliationInputs.push(input);
      onProgress('replacing');
      return {
        schemaVersion: 1,
        kind: 'result',
        action: 'reconcile_update',
        updateSchedulerState: 'ready',
        updatePolicy: {
          policy: { kind: 'channel', channel: 'latest' },
          target: {
            serviceId: service.id,
            rootPath: service.rootPath,
            rootId: profile.rootId,
            deploymentId: DEPLOYMENT_ID,
          },
        },
        service: serviceSummary('1.3.0'),
        reconciliation: {
          kind: 'updated',
          previousVersion: '1.2.3',
          targetVersion: '1.3.0',
        },
      };
    },
    currentHostEpoch: () => 'host-before-update',
    awaitUpdatedConnection: async (...args) => {
      connections.push(args);
    },
    sendProgress: (event) => progress.push(event),
    runAccessManagement: async () => assert.fail('access management is not expected'),
    cleanupManagedDeployment: async () => assert.fail('cleanup is not expected'),
  });

  const getPolicy = handlers.get('runtime-host-management:get-update-policy');
  const setPolicy = handlers.get('runtime-host-management:set-update-policy');
  const reconcile = handlers.get('runtime-host-management:reconcile-update');
  assert.ok(getPolicy && setPolicy && reconcile);

  assert.deepEqual(await getPolicy({}, profile.id), {
    policy: { kind: 'manual' },
    schedulingState: 'ready',
  });
  assert.deepEqual(
    await setPolicy({}, profile.id, { kind: 'channel', channel: 'latest' }),
    {
      policy: { kind: 'channel', channel: 'latest' },
      target: {
        serviceId: service.id,
        rootPath: service.rootPath,
        rootId: profile.rootId,
        deploymentId: DEPLOYMENT_ID,
      },
      schedulingState: 'ready',
    },
  );
  await assert.rejects(
    setPolicy({}, profile.id, { kind: 'fixed', version: '' }) as Promise<unknown>,
    /update policy is invalid/u,
  );
  for (const policyInput of policyInputs) {
    assert.deepEqual(policyInput.expectedTarget, {
      serviceId: service.id,
      rootPath: service.rootPath,
      rootId: profile.rootId,
      deploymentId: DEPLOYMENT_ID,
    });
  }
  assert.deepEqual(reconciliationInputs, []);

  const response = await reconcile({}, profile.id);
  assert.equal(
    (response as { reconciliation?: { kind: string } }).reconciliation?.kind,
    'updated',
  );
  assert.equal(
    (response as { updatePolicy?: { schedulingState: string } }).updatePolicy?.schedulingState,
    'ready',
  );
  assert.deepEqual(
    (response as { service?: unknown }).service,
    serviceSummary('1.3.0'),
  );
  assert.deepEqual(reconciliationInputs, [{
    destination: profile.transport.destination,
    operatorPath: service.operatorPath,
    expectedTarget: {
      serviceId: service.id,
      rootPath: service.rootPath,
      rootId: profile.rootId,
      deploymentId: DEPLOYMENT_ID,
    },
  }]);
  assert.deepEqual(progress, [{ profileId: profile.id, phase: 'replacing' }]);
  assert.deepEqual(connections, [[profile.id, profile.rootId, 'host-before-update', true]]);
});

test('retries acknowledged deployment cleanup without repeating uninstall', async () => {
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
  let clearAttempts = 0;
  createDesktopRuntimeHostManagement({
    ...unusedUpdateDependencies(),
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      ...unusedDirectPeerProfileDependencies(),
      resolveManagedService: async () => {
        const binding = managedBinding(profile, service, 'cleanup_pending');
        return {
          ...binding,
          deployment: {
            id: binding.deployment.id,
            rootPath: binding.deployment.rootPath,
          },
        };
      },
      resolveManagedAccess: async () => undefined,
      markManagedServiceUninstalling: async () =>
        assert.fail('remote uninstall must not repeat'),
      markManagedServiceCleanupPending: async () =>
        assert.fail('cleanup intent is already acknowledged'),
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
    cleanupManagedDeployment: async () => undefined,
  });

  const run = handlers.get('runtime-host-management:run');
  assert.ok(run);
  await assert.rejects(
    run({}, profile.id, 'uninstall') as Promise<unknown>,
    /local metadata is unavailable/u,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await run({}, profile.id, 'uninstall'), {
    kind: 'uninstalled',
    retainedStateRoot: service.rootPath,
  });
  assert.equal(calls.length, 0);
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
      ...unusedDirectPeerProfileDependencies(),
      resolveManagedService: async () => {
        const binding = managedBinding(
          {
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
          {
            id: 'b'.repeat(64),
            rootPath: '/srv/maka',
            operatorPath: '/home/operator/.local/share/maka/operator',
          },
          'uninstalling',
        );
        return {
          ...binding,
          deployment: {
            id: binding.deployment.id,
            rootPath: binding.deployment.rootPath,
          },
        };
      },
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

test('keeps the SSH profile while adding and removing its managed Direct peer', async () => {
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
  let peerProfileExists = false;
  const actions: string[] = [];

  createDesktopRuntimeHostManagement({
    ...unusedUpdateDependencies(),
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      ...unusedDirectPeerProfileDependencies(),
      resolveManagedService: async () => managedBinding(profile, service, 'active'),
      resolveManagedAccess: async () => undefined,
      rotateManagedCredential: async () => assert.fail('credential rotation is not expected'),
      markManagedServiceUninstalling: async (binding) => binding,
      markManagedServiceCleanupPending: async (binding) => binding,
      clearManagedServiceBinding: async () => undefined,
      resolveManagedDirectPeerProfile: async () => ({
        exists: peerProfileExists,
        enabled: false,
      }),
      upsertManagedDirectPeerProfile: async (_profileId, peerId) => {
        assert.equal(peerId, '12D3KooWpeer');
        peerProfileExists = true;
      },
      removeManagedDirectPeerProfile: async () => {
        peerProfileExists = false;
      },
    },
    directPeerClientAvailable: true,
    runServiceManagement: async (input) => {
      assert.equal(input.action, 'status');
      assert.equal(
        input.capabilityRequest,
        RUNTIME_HOST_OPERATOR_PEER_WEBRTC_STUN_CAPABILITY,
      );
      return {
        ...serviceResult('status'),
        operatorCapabilities: [RUNTIME_HOST_OPERATOR_PEER_WEBRTC_STUN_CAPABILITY],
      };
    },
    runAccessManagement: async () => assert.fail('access management is not expected'),
    runPeerManagement: async (input) => {
      actions.push(input.action);
      assert.equal(input.webRtcStunStatus, true);
      if (input.action === 'enable') {
        assert.deepEqual(input.webRtcStunPolicy, { kind: 'disabled' });
      }
      const status = input.action === 'disable'
          ? {
              state: 'not_configured' as const,
              serviceState: 'running',
              routeHints: [],
              coordinationRelays: [],
            }
          : {
              state: 'enabled' as const,
              serviceState: 'running',
              peerId: '12D3KooWpeer',
              rootId: profile.rootId,
              routeHints: ['/ip4/192.0.2.8/udp/44001/quic-v1'],
              coordinationRelays: [],
              webRtcStunPolicy: { kind: 'disabled' as const },
            };
      return input.action === 'status'
        ? { kind: 'result', action: input.action, status }
        : { kind: 'result', action: input.action, status, restarted: true };
    },
    cleanupManagedDeployment: async () => assert.fail('cleanup is not expected'),
  });

  const configure = handlers.get('runtime-host-management:configure-direct-peer');
  assert.ok(configure);
  const enabled = await configure({}, profile.id, true, [], true, { kind: 'disabled' });
  assert.equal((enabled as { profilePresent: boolean }).profilePresent, true);
  assert.deepEqual(
    (enabled as { webRtcStunPolicy: unknown }).webRtcStunPolicy,
    { kind: 'disabled' },
  );
  const disabled = await configure({}, profile.id, false, [], true);
  assert.equal((disabled as { profilePresent: boolean }).profilePresent, false);
  assert.deepEqual(actions, ['enable', 'disable']);
});

test('disables a newly enabled listener when its Desktop profile cannot be committed', async () => {
  for (const failure of ['descriptor', 'persistence'] as const) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const actions: string[] = [];
    createDesktopRuntimeHostManagement({
      ...unusedUpdateDependencies(),
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
        removeHandler: (channel) => handlers.delete(channel),
      },
      profiles: {
        ...unusedDirectPeerProfileDependencies(),
        resolveManagedService: async () => managedSshBinding(),
        resolveManagedAccess: async () => undefined,
        rotateManagedCredential: async () => assert.fail('credential rotation is not expected'),
        markManagedServiceUninstalling: async (binding) => binding,
        markManagedServiceCleanupPending: async (binding) => binding,
        clearManagedServiceBinding: async () => undefined,
        resolveManagedDirectPeerProfile: async () => ({ exists: false, enabled: false }),
        upsertManagedDirectPeerProfile: async () => {
          if (failure === 'persistence') throw new Error('profile store failed');
        },
        removeManagedDirectPeerProfile: async () => undefined,
      },
      directPeerClientAvailable: true,
      runServiceManagement: async () => ({
        ...serviceResult('status'),
        operatorCapabilities: [RUNTIME_HOST_OPERATOR_PEER_RELAY_DISCOVERY_CAPABILITY],
      }),
      runAccessManagement: async () => assert.fail('access management is not expected'),
      runPeerManagement: async (input) => {
        actions.push(input.action);
        const status = input.action === 'disable'
            ? {
                state: 'disabled' as const,
                serviceState: 'running',
                peerId: '12D3KooWpeer',
                rootId: 'a'.repeat(64),
                routeHints: [],
                coordinationRelays: [],
              }
            : {
                state: 'enabled' as const,
                serviceState: 'running',
                peerId: '12D3KooWpeer',
                rootId: 'a'.repeat(64),
                routeHints: failure === 'descriptor' ? [] : ['/ip4/192.0.2.8/udp/44001/quic-v1'],
                coordinationRelays: [],
              };
        return input.action === 'status'
          ? { kind: 'result', action: input.action, status }
          : { kind: 'result', action: input.action, status, restarted: true };
      },
      cleanupManagedDeployment: async () => assert.fail('cleanup is not expected'),
    });

    const configure = handlers.get('runtime-host-management:configure-direct-peer');
    assert.ok(configure);
    await assert.rejects(
      configure({}, 'office', true, [], true) as Promise<unknown>,
      failure === 'descriptor' ? /usable direct-peer descriptor/u : /profile store failed/u,
    );
    assert.deepEqual(actions, ['enable', 'disable']);
  }
});

test('does not invoke peer management when the remote operator lacks its capability', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  createDesktopRuntimeHostManagement({
    ...unusedUpdateDependencies(),
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    profiles: {
      ...unusedDirectPeerProfileDependencies(),
      resolveManagedService: async () => managedSshBinding(),
      resolveManagedAccess: async () => undefined,
      rotateManagedCredential: async () => assert.fail('credential rotation is not expected'),
      markManagedServiceUninstalling: async (binding) => binding,
      markManagedServiceCleanupPending: async (binding) => binding,
      clearManagedServiceBinding: async () => undefined,
      resolveManagedDirectPeerProfile: async () => ({ exists: false, enabled: false }),
    },
    directPeerClientAvailable: true,
    runServiceManagement: async () => serviceResult('status'),
    runAccessManagement: async () => assert.fail('access management is not expected'),
    runPeerManagement: async () => assert.fail('peer management is not expected'),
    cleanupManagedDeployment: async () => assert.fail('cleanup is not expected'),
  });

  const get = handlers.get('runtime-host-management:get-direct-peer');
  const configure = handlers.get('runtime-host-management:configure-direct-peer');
  assert.ok(get);
  assert.ok(configure);
  assert.deepEqual(await get({}, 'office'), {
    state: 'unsupported',
    routeHints: [],
    coordinationRelays: [],
    automaticRelayDiscovery: false,
    profilePresent: false,
    profileEnabled: false,
    clientAvailable: true,
    managementAvailable: false,
  });
  await assert.rejects(
    configure({}, 'office', true, [], true) as Promise<unknown>,
    /Update this Runtime Host/u,
  );
});

function managedSshBinding() {
  return managedBinding(
    {
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
    {
      id: 'b'.repeat(64),
      rootPath: '/srv/maka',
      operatorPath: '/home/operator/.local/share/maka/operator',
    },
    'active',
  );
}

function managedBinding<
  Profile,
  Service extends { readonly id: string; readonly rootPath: string; readonly operatorPath: string },
  State extends 'active' | 'uninstalling' | 'cleanup_pending',
>(profile: Profile, service: Service, state: State) {
  return {
    profile,
    deployment: { id: service.id, rootPath: service.rootPath, deploymentId: DEPLOYMENT_ID },
    control: { kind: 'ssh_operator' as const, operatorPath: service.operatorPath },
    state,
  };
}

function serviceResult(
  action: DesktopRuntimeHostSshManagementInput['action'],
  operatorAccess = false,
): Exclude<
  Extract<RuntimeHostServiceManagementFrame, { kind: 'result' }>,
  { action: 'check_update' | 'update' | 'update_policy' | 'reconcile_update' }
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
  if (action === 'retire') return { ...result, action, retirement: { kind: 'stopped' } };
  if (action === 'uninstall') return { ...result, action, retirement: { kind: 'stopped' } };
  if (action === 'configure') {
    return { ...result, action, configuration: { kind: 'unchanged' } };
  }
  return { ...result, action };
}

function serviceSummary(installedVersion: string) {
  return {
    platform: 'linux',
    arch: 'x64',
    osRelease: '6.8.0',
    state: 'running' as const,
    pid: 42,
    lastExitCode: 0,
    installedVersion,
    projectDirectoryRoots: [],
  };
}

function unusedUpdateDependencies() {
  return {
    runWslManagement: async (): Promise<never> =>
      assert.fail('WSL management is not expected'),
    runUpdate: async (): Promise<never> => assert.fail('update is not expected'),
    runUpdatePolicy: async (): Promise<never> => assert.fail('update policy is not expected'),
    runUpdateReconciliation: async (): Promise<never> =>
      assert.fail('update reconciliation is not expected'),
    runPeerManagement: async (): Promise<never> =>
      assert.fail('direct peer management is not expected'),
    directPeerClientAvailable: false,
    setupPackageMode: 'published' as const,
    resolveSshDevelopmentPeerTarget: async (): Promise<never> =>
      assert.fail('published update must not inspect the development target'),
    resolveUpdatePackage: () => ({ kind: 'npm', specifier: 'maka-agent@1.2.3' } as const),
    currentHostEpoch: () => undefined,
    awaitUpdatedConnection: async () => undefined,
    sendProgress: () => undefined,
  };
}

function unusedDirectPeerProfileDependencies() {
  return {
    assertPairingComplete: () => undefined,
    resolveManagedDirectPeerProfile: async (): Promise<never> =>
      assert.fail('direct peer profile inspection is not expected'),
    upsertManagedDirectPeerProfile: async (): Promise<never> =>
      assert.fail('direct peer profile creation is not expected'),
    removeManagedDirectPeerProfile: async (): Promise<never> =>
      assert.fail('direct peer profile removal is not expected'),
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

function testPeerReachability(peerId: string) {
  return {
    lease: {
      version: 1 as const,
      peerId,
      revision: 1,
      issuedAt: 1,
      expiresAt: 2,
      directRoutes: ['/ip4/192.0.2.8/udp/44001/quic-v1'],
      coordinationRoutes: [],
    },
    publicKey: Buffer.from('public').toString('base64url'),
    signature: Buffer.from('signature').toString('base64url'),
  };
}
