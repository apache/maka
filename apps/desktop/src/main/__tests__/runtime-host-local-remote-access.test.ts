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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeRuntimeHostOwnerConnectionCode } from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type HostRegistration,
} from '@maka/runtime-host/protocol';
import type { RuntimeHostDesktopManager } from '../runtime-host-desktop-manager.js';

const RECOVERY_DEPLOYMENT_ID = '33333333-3333-4333-8333-333333333333';
import { createDesktopLocalRuntimeHostRemoteAccess } from '../runtime-host-local-remote-access.js';
import type { createDesktopRuntimeHostLocalOperator } from '../runtime-host-local-operator.js';

test('enabling remote access hands the same root to one managed service before Desktop resumes', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-remote-access-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  await mkdir(rootPath, { recursive: true });
  const handlers = new Map<string, Parameters<Electron.IpcMain['handle']>[1]>();
  let retired = false;
  let resumed = false;
  const peer = {
    peerId: '12D3KooWpeer',
    routeHints: ['/ip4/192.0.2.1/udp/41000/quic-v1'],
    coordinationRelays: [],
  };
  const livePeer = peerReachability(
    peer.peerId,
    peer.routeHints,
    ['/dns4/relay.example/udp/443/quic-v1/p2p/12D3KooWrelay'],
  );
  const manager = {
    async retireOwnedLocalHost() {
      retired = true;
      return { kind: 'retired' as const, resume: () => { resumed = true; } };
    },
    async waitUntilReady(profileId: string) {
      assert.equal(profileId, 'local');
    },
    current(profileId: string) {
      assert.equal(profileId, 'local');
      return {
        candidate: {
          client: {
            async status() {
              return { peerEndpoint: livePeer };
            },
          },
        },
      };
    },
  } as unknown as RuntimeHostDesktopManager;
  const deploymentId = '11111111-1111-4111-8111-111111111111';
  const operator = {
    async runSetup(input: {
      readonly rootPath: string;
      readonly principalId: string;
      readonly expectedTarget: { readonly serviceId: string; readonly rootId: string };
    }) {
      assert.equal(retired, true);
      assert.equal(input.rootPath, rootPath);
      assert.equal(input.principalId, 'desktop-owner:local-runtime-host-sharing');
      assert.deepEqual(input.expectedTarget, {
        serviceId: 'a'.repeat(64),
        rootPath,
        rootId: 'a'.repeat(64),
      });
      return {
        serviceId: 'a'.repeat(64),
        operatorPath: join(base, 'operator'),
        rootPath,
        rootId: 'a'.repeat(64),
        deploymentId,
        credential: 'pending-credential',
        directPeer: peer,
      };
    },
    async runPeer() {
      return {
        kind: 'result' as const,
        action: 'status' as const,
        status: {
          state: 'enabled' as const,
          serviceState: 'running',
          rootId: 'a'.repeat(64),
          ...peer,
        },
      };
    },
    async runService() {
      throw new Error('rollback is not expected');
    },
    async close() {},
  } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>;
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: {
      handle: (channel, handler) => { handlers.set(channel, handler); },
      removeHandler: (channel) => { handlers.delete(channel); },
    },
    clientDataRoot,
    rootPath,
    rootId: 'a'.repeat(64),
    directPeerAvailable: true,
    manager: () => manager,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator,
  });
  t.after(() => service.close());

  const enable = handlers.get('local-runtime-host-remote-access:enable');
  assert.ok(enable);
  const result = await enable({} as Electron.IpcMainInvokeEvent, {
    allowInterruptActiveTasks: false,
    coordinationRelays: [],
  }) as { readonly kind: string; readonly connectionCode: string };
  assert.equal(result.kind, 'enabled');
  assert.equal(resumed, true);
  assert.deepEqual(decodeRuntimeHostOwnerConnectionCode(result.connectionCode), {
    name: decodeRuntimeHostOwnerConnectionCode(result.connectionCode).name,
    rootId: 'a'.repeat(64),
    transport: { kind: 'libp2p-direct', reachability: livePeer },
    credential: 'pending-credential',
  });
  const lifecycle = JSON.parse(
    await readFile(join(clientDataRoot, 'runtime-host-local-service.json'), 'utf8'),
  ) as { readonly state: string; readonly deploymentId: string };
  assert.equal(lifecycle.state, 'managed');
  assert.equal((lifecycle as { serviceId?: string }).serviceId, 'a'.repeat(64));
  assert.equal(lifecycle.deploymentId, deploymentId);
});

test('shares the running Local Host endpoint instead of its persisted startup routes', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-live-peer-share-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const rootId = 'a'.repeat(64);
  await mkdir(rootPath, { recursive: true });
  await writeManagedLifecycle(clientDataRoot, rootPath, rootId);
  const configuredPeer = {
    peerId: '12D3KooWpeer',
    routeHints: [],
    coordinationRelays: [],
  };
  const livePeer = peerReachability(
    configuredPeer.peerId,
    ['/ip4/192.0.2.1/udp/41000/quic-v1'],
    ['/dns4/relay.example/udp/443/quic-v1/p2p/12D3KooWrelay'],
  );
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: { handle() {}, removeHandler() {} },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: true,
    manager: () =>
      ({
        current() {
          return {
            candidate: {
              client: {
                async status() {
                  return { peerEndpoint: livePeer };
                },
              },
            },
          };
        },
      }) as unknown as RuntimeHostDesktopManager,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator: {
      async runPeer() {
        return {
          kind: 'result' as const,
          action: 'status' as const,
          status: {
            state: 'enabled' as const,
            serviceState: 'running',
            rootId,
            ...configuredPeer,
          },
        };
      },
      async close() {},
    } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
  });
  t.after(() => service.close());

  const target = await service.createCollaborationConnectionTarget();
  assert.deepEqual(target, {
    name: target.name,
    transport: { kind: 'libp2p-direct', reachability: livePeer },
  });
});

test('revokes the one Local sharing authority without changing peer connectivity', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-shared-access-revoke-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const rootId = 'a'.repeat(64);
  await mkdir(rootPath, { recursive: true });
  await writeManagedLifecycle(clientDataRoot, rootPath, rootId);
  const handlers = new Map<string, Parameters<Electron.IpcMain['handle']>[1]>();
  const revoked: unknown[] = [];
  const peer = {
    peerId: '12D3KooWpeer',
    routeHints: ['/ip4/192.0.2.1/udp/41000/quic-v1'],
    coordinationRelays: [],
  };
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: {
      handle: (channel, handler) => { handlers.set(channel, handler); },
      removeHandler: (channel) => { handlers.delete(channel); },
    },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: true,
    manager: () =>
      ({
        current() {
          return {
            candidate: {
              client: {
                async request(operation: string, input: unknown) {
                  assert.equal(operation, 'access.principal.revoke');
                  revoked.push(input);
                  return { revoked: true };
                },
              },
            },
          };
        },
      }) as unknown as RuntimeHostDesktopManager,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator: {
      async runPeer() {
        return {
          kind: 'result' as const,
          action: 'status' as const,
          status: {
            state: 'enabled' as const,
            serviceState: 'running',
            rootId,
            ...peer,
          },
        };
      },
      async close() {},
    } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
  });
  t.after(() => service.close());

  const revoke = handlers.get('local-runtime-host-remote-access:revoke-shared-access');
  assert.ok(revoke);
  assert.deepEqual(await revoke({} as Electron.IpcMainInvokeEvent), {
    state: 'on',
    managedService: true,
  });
  assert.deepEqual(revoked, [
    {
      principalKind: 'remote_owner',
      principalId: 'desktop-owner:local-runtime-host-sharing',
    },
  ]);
});

test('keeps the managed service visible when Direct peer support is unavailable', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-managed-without-peer-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const rootId = 'a'.repeat(64);
  await mkdir(rootPath, { recursive: true });
  await writeManagedLifecycle(clientDataRoot, rootPath, rootId);
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: { handle() {}, removeHandler() {} },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: false,
    manager: () => ({}) as RuntimeHostDesktopManager,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator: {
      async close() {},
    } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
  });
  t.after(() => service.close());

  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.state, 'unsupported');
  assert.equal(snapshot.managedService, true);
});

test('repairs an existing managed Host with the current setup package and restarts it when already current', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-managed-repair-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const rootId = 'a'.repeat(64);
  const setupPackage = { kind: 'npm' as const, specifier: 'maka-agent@0.2.0' };
  await mkdir(rootPath, { recursive: true });
  await writeManagedLifecycle(clientDataRoot, rootPath, rootId);
  const actions: string[] = [];
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: { handle() {}, removeHandler() {} },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: true,
    manager: () => undefined,
    resolveSetupPackage: async () => setupPackage,
    operator: {
      async runUpdate(input: {
        readonly setupPackage: unknown;
        readonly target: { readonly rootId: string; readonly deploymentId?: string };
        readonly allowManualUpdate?: boolean;
        readonly allowInterruptActiveTasks?: boolean;
      }) {
        actions.push('update');
        assert.equal(input.setupPackage, setupPackage);
        assert.equal(input.target.rootId, rootId);
        assert.equal(input.target.deploymentId, RECOVERY_DEPLOYMENT_ID);
        assert.equal(input.allowManualUpdate, true);
        assert.equal(input.allowInterruptActiveTasks, undefined);
        return {
          kind: 'result',
          action: 'update',
          update: { kind: 'already_current', version: '0.2.0' },
        } as never;
      },
      async runService(input: {
        readonly action: string;
        readonly target: { readonly rootId: string; readonly deploymentId?: string };
        readonly allowInterruptActiveTasks?: boolean;
      }) {
        actions.push(input.action);
        assert.equal(input.action, 'restart');
        assert.equal(input.target.rootId, rootId);
        assert.equal(input.target.deploymentId, RECOVERY_DEPLOYMENT_ID);
        assert.equal(input.allowInterruptActiveTasks, undefined);
        return { kind: 'result', action: 'restart' } as never;
      },
      async close() {},
    } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
  });
  t.after(() => service.close());

  assert.deepEqual(await service.repairManagedStartup({ allowManualUpdate: true }), {
    kind: 'repaired',
  });
  assert.deepEqual(actions, ['update', 'restart']);
});

test('replaces a conflicting supervised Host with the requested active-work policy', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-managed-conflict-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const rootId = 'a'.repeat(64);
  await mkdir(rootPath, { recursive: true });
  const policies: Array<boolean | undefined> = [];
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: { handle() {}, removeHandler() {} },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: true,
    manager: () => undefined,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    resolveManagedDeploymentAuthority: async () => ({
      kind: 'active',
      lifecycleMode: 'supervised',
      target: {
        schemaVersion: 1,
        serviceId: rootId,
        rootPath,
        rootId,
        operatorPath: join(base, 'operator'),
        deploymentId: RECOVERY_DEPLOYMENT_ID,
      },
    }),
    operator: {
      async runUpdate(input: {
        readonly target: { readonly rootId: string; readonly deploymentId?: string };
        readonly expectedHost?: { readonly hostEpoch: string; readonly pid: number };
        readonly allowInterruptActiveTasks?: boolean;
      }) {
        assert.equal(input.target.rootId, rootId);
        assert.equal(input.target.deploymentId, RECOVERY_DEPLOYMENT_ID);
        assert.deepEqual(input.expectedHost, { hostEpoch: 'older-host', pid: 42 });
        policies.push(input.allowInterruptActiveTasks);
        if (!input.allowInterruptActiveTasks) {
          return {
            kind: 'error' as const,
            action: 'update' as const,
            error: { code: 'active_tasks', message: 'active work remains' },
          } as never;
        }
        if (policies.length === 3) {
          return {
            kind: 'result' as const,
            action: 'update' as const,
            update: { kind: 'already_current', version: '0.2.0' },
          } as never;
        }
        return {
          kind: 'result' as const,
          action: 'update' as const,
          update: { kind: 'updated', previousVersion: '0.2.0', targetVersion: '0.2.0' },
        } as never;
      },
      async close() {},
    } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
  });
  t.after(() => service.close());

  const replacement = await service.resolveConflictingHostReplacement(
    hostRegistration({ rootId, lifecycleMode: 'service' }),
    new AbortController().signal,
  );
  assert.ok(replacement);
  assert.equal(await replacement.replace('refuse_active_work'), 'active_tasks');
  assert.equal(await replacement.replace('interrupt_active_work'), 'replaced');
  await assert.rejects(
    replacement.replace('interrupt_active_work'),
    /did not replace the observed Host/u,
  );
  assert.deepEqual(policies, [undefined, true, true]);
});

test('does not persist recoverable setup authority before Desktop ownership commits', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-remote-access-ownership-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const rootId = 'a'.repeat(64);
  const lifecyclePath = join(clientDataRoot, 'runtime-host-local-service.json');
  await mkdir(rootPath, { recursive: true });
  const handlers = new Map<string, Parameters<Electron.IpcMain['handle']>[1]>();
  let ownershipChecked = false;
  let setupCalls = 0;
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: {
      handle: (channel, handler) => { handlers.set(channel, handler); },
      removeHandler: (channel) => { handlers.delete(channel); },
    },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: true,
    manager: () =>
      ({
        async retireOwnedLocalHost() {
          ownershipChecked = true;
          await assert.rejects(readFile(lifecyclePath, 'utf8'), { code: 'ENOENT' });
          return { kind: 'not_owned' as const };
        },
      }) as unknown as RuntimeHostDesktopManager,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator: {
      async runSetup() {
        setupCalls += 1;
        throw new Error('setup must not run for an externally managed Host');
      },
      async close() {},
    } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
  });
  t.after(() => service.close());

  const enable = handlers.get('local-runtime-host-remote-access:enable');
  assert.ok(enable);
  const enabling = enable({} as Electron.IpcMainInvokeEvent, {
    allowInterruptActiveTasks: false,
    coordinationRelays: [],
  });
  await assert.rejects(enabling, /already managed outside this Desktop/u);
  assert.equal(ownershipChecked, true);
  await assert.rejects(readFile(lifecyclePath, 'utf8'), { code: 'ENOENT' });
  assert.equal(setupCalls, 0);
});

test('adopts committed managed authority for every pending receipt without replaying setup', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-remote-access-prestart-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const state of ['handoff', 'setupPending'] as const) {
    const clientDataRoot = join(base, state);
    const rootPath = join(clientDataRoot, 'workspaces', 'default');
    const rootId = 'a'.repeat(64);
    const deploymentId = '22222222-2222-4222-8222-222222222222';
    const operatorPath = join(base, 'installed', 'operator');
    await mkdir(rootPath, { recursive: true });
    await writeFile(
      join(clientDataRoot, 'runtime-host-local-service.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        state,
        rootPath,
        rootId,
        coordinationRelays: [],
        allowInterruptActiveTasks: true,
      })}\n`,
    );
    const service = createDesktopLocalRuntimeHostRemoteAccess({
      ipcMain: { handle() {}, removeHandler() {} },
      clientDataRoot,
      rootPath,
      rootId,
      directPeerAvailable: false,
      manager: () => assert.fail('pre-start reconciliation must not require the Local manager'),
      resolveManagedDeploymentAuthority: async () => ({
        kind: 'active',
        lifecycleMode: 'supervised',
        target: {
          schemaVersion: 1,
          serviceId: rootId,
          operatorPath,
          rootPath,
          rootId,
          deploymentId,
        },
      }),
      resolveSetupPackage: async () =>
        assert.fail('committed authority must not resolve a package'),
      operator: {
        async runSetup() {
          assert.fail('committed authority must not replay setup');
        },
        async close() {},
      } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
    });
    t.after(() => service.close());

    assert.equal(await service.recoverBeforeLocalHostStart(), true);
    assert.deepEqual(
      JSON.parse(await readFile(join(clientDataRoot, 'runtime-host-local-service.json'), 'utf8')),
      {
        schemaVersion: 1,
        state: 'managed',
        serviceId: rootId,
        operatorPath,
        rootPath,
        rootId,
        deploymentId,
      },
    );
  }
});

test('discards a legacy handoff that belongs to an externally managed Host', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-remote-access-legacy-external-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const rootId = 'a'.repeat(64);
  const lifecyclePath = join(clientDataRoot, 'runtime-host-local-service.json');
  await mkdir(rootPath, { recursive: true });
  await writeFile(
    lifecyclePath,
    `${JSON.stringify({
      schemaVersion: 1,
      state: 'handoff',
      rootPath,
      rootId,
      coordinationRelays: [],
      allowInterruptActiveTasks: false,
    })}\n`,
  );
  let setupCalls = 0;
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: { handle() {}, removeHandler() {} },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: true,
    manager: () =>
      ({
        async retireOwnedLocalHost() {
          return { kind: 'not_owned' as const };
        },
      }) as unknown as RuntimeHostDesktopManager,
    resolveManagedDeploymentAuthority: async () => undefined,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator: {
      async runSetup() {
        setupCalls += 1;
        throw new Error('setup must not replace an externally managed Host');
      },
      async close() {},
    } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
  });
  t.after(() => service.close());

  assert.equal(await service.recoverBeforeLocalHostStart(), false);
  await service.recover();

  assert.equal(setupCalls, 0);
  await assert.rejects(readFile(lifecyclePath, 'utf8'), { code: 'ENOENT' });
});

test('interrupted Local Host setup converges to its exact managed service', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-remote-access-recovery-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const rootId = 'a'.repeat(64);
  await mkdir(rootPath, { recursive: true });
  await writeFile(
    join(clientDataRoot, 'runtime-host-local-service.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      state: 'setupPending',
      rootPath,
      rootId,
      coordinationRelays: [],
      allowInterruptActiveTasks: true,
    })}\n`,
  );
  let setupCalls = 0;
  let setupQuiesced = false;
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: { handle() {}, removeHandler() {} },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: true,
    manager: () =>
      ({
        async retireOwnedLocalHost(mode: string) {
          assert.equal(mode, 'interrupt_active_work');
          return { kind: 'not_owned' as const };
        },
        async runManagedLocalHostChange(change: () => Promise<unknown>) {
          setupQuiesced = true;
          return change();
        },
      }) as unknown as RuntimeHostDesktopManager,
    resolveManagedDeploymentAuthority: async () => undefined,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator: {
      async runSetup() {
        setupCalls += 1;
        return {
          serviceId: rootId,
          operatorPath: join(base, 'operator'),
          rootPath,
          rootId,
          deploymentId: '22222222-2222-4222-8222-222222222222',
          credential: 'unused-pending-credential',
          directPeer: {
            peerId: '12D3KooWpeer',
            routeHints: ['/ip4/192.0.2.1/udp/41000/quic-v1'],
            coordinationRelays: [],
          },
        };
      },
      async close() {},
    } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
  });
  t.after(() => service.close());

  assert.equal(await service.recoverBeforeLocalHostStart(), false);
  assert.equal(setupCalls, 0);
  await service.recover();

  assert.equal(setupCalls, 1);
  assert.equal(setupQuiesced, true);
  assert.equal(
    JSON.parse(await readFile(join(clientDataRoot, 'runtime-host-local-service.json'), 'utf8'))
      .state,
    'managed',
  );
});

test('startup replays the persisted peer intent instead of gating recovery on status', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-peer-recovery-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const rootId = 'a'.repeat(64);
  await mkdir(rootPath, { recursive: true });
  await writeFile(
    join(clientDataRoot, 'runtime-host-local-service.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      state: 'peerChanging',
      serviceId: 'b'.repeat(64),
      operatorPath: join(clientDataRoot, 'operator'),
      rootPath,
      rootId,
      deploymentId: RECOVERY_DEPLOYMENT_ID,
      peerEnabled: true,
      coordinationRelays: ['/dns4/discovery.example/udp/443/quic-v1'],
      allowInterruptActiveTasks: false,
    })}\n`,
  );
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: { handle() {}, removeHandler() {} },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: false,
    manager: () => assert.fail('pre-start peer recovery must not require the manager'),
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator: {
      async runPeer(input: {
        readonly action: string;
        readonly coordinationRelays?: readonly string[];
      }) {
        assert.equal(input.action, 'enable');
        assert.deepEqual(input.coordinationRelays, [
          '/dns4/discovery.example/udp/443/quic-v1',
        ]);
        return {
          kind: 'result' as const,
          action: 'enable' as const,
          restarted: true,
          status: {
            state: 'enabled' as const,
            serviceState: 'running',
            rootId,
            peerId: '12D3KooWpeer',
            routeHints: ['/ip4/192.0.2.1/udp/41000/quic-v1'],
            coordinationRelays: ['/dns4/discovery.example/udp/443/quic-v1'],
          },
        };
      },
      async close() {},
    } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
  });
  t.after(() => service.close());

  assert.equal(await service.recoverBeforeLocalHostStart(), true);
  assert.equal(
    JSON.parse(await readFile(join(clientDataRoot, 'runtime-host-local-service.json'), 'utf8'))
      .state,
    'managed',
  );
});

test('re-enabling a managed peer forwards explicit interruption authority', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-peer-interrupt-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const rootId = 'a'.repeat(64);
  await mkdir(rootPath, { recursive: true });
  await writeManagedLifecycle(clientDataRoot, rootPath, rootId);
  const handlers = new Map<string, Parameters<Electron.IpcMain['handle']>[1]>();
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: {
      handle: (channel, handler) => { handlers.set(channel, handler); },
      removeHandler: (channel) => { handlers.delete(channel); },
    },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: true,
    manager: () =>
      ({
        current() {
          return undefined;
        },
        async retireOwnedLocalHost() {
          return { kind: 'not_owned' as const };
        },
        async runManagedLocalHostChange(change: () => Promise<unknown>) {
          return change();
        },
      }) as unknown as RuntimeHostDesktopManager,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator: {
      async runPeer(input: { readonly allowInterruptActiveTasks?: boolean }) {
        assert.equal(input.allowInterruptActiveTasks, true);
        return {
          kind: 'error' as const,
          action: 'enable' as const,
          error: { code: 'active_tasks', message: 'active' },
        };
      },
      async close() {},
    } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
  });
  t.after(() => service.close());

  const enable = handlers.get('local-runtime-host-remote-access:enable');
  assert.ok(enable);
  assert.deepEqual(
    await enable({} as Electron.IpcMainInvokeEvent, {
      allowInterruptActiveTasks: true,
      coordinationRelays: [],
    }),
    { kind: 'active_tasks' },
  );
  assert.equal(
    JSON.parse(await readFile(join(clientDataRoot, 'runtime-host-local-service.json'), 'utf8'))
      .state,
    'managed',
  );
});

test('pre-start recovery cleans a committed uninstall before an ephemeral Host can claim the root', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-uninstall-recovery-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const rootId = 'a'.repeat(64);
  await mkdir(rootPath, { recursive: true });
  await writeFile(
    join(clientDataRoot, 'runtime-host-local-service.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      state: 'uninstalling',
      serviceId: 'b'.repeat(64),
      operatorPath: join(base, 'operator'),
      rootPath,
      rootId,
      deploymentId: RECOVERY_DEPLOYMENT_ID,
      allowInterruptActiveTasks: false,
    })}\n`,
  );
  const actions: string[] = [];
  const cleanupPhases: boolean[] = [];
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: { handle() {}, removeHandler() {} },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: false,
    manager: () =>
      ({
        async runManagedLocalHostChange() {
          assert.fail('a committed uninstall must not touch a new ephemeral Local Host');
        },
      }) as unknown as RuntimeHostDesktopManager,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator: {
      async runService(input: {
        readonly action: 'retire' | 'uninstall';
        readonly retainManagedDeployment?: boolean;
      }) {
        assert.fail(`committed ${input.action} must not be repeated`);
      },
      async cleanupManagedDeployment(input: { readonly finalize?: boolean }) {
        actions.push('cleanup');
        cleanupPhases.push(input.finalize ?? false);
      },
      async close() {},
    } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
  });
  t.after(() => service.close());

  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.state, 'unsupported');
  assert.equal(snapshot.managedService, true);
  assert.equal(await service.recoverBeforeLocalHostStart(), true);
  assert.deepEqual(actions, ['cleanup', 'cleanup']);
  assert.deepEqual(cleanupPhases, [false, true]);
  await assert.rejects(readFile(join(clientDataRoot, 'runtime-host-local-service.json'), 'utf8'), {
    code: 'ENOENT',
  });
});

test('pre-start recovery settles a canonical uninstall transition through its exact operator', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-uninstall-transition-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const rootId = 'a'.repeat(64);
  await mkdir(rootPath, { recursive: true });
  await writeFile(
    join(clientDataRoot, 'runtime-host-local-service.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      state: 'uninstalling',
      serviceId: 'b'.repeat(64),
      operatorPath: join(base, 'operator'),
      rootPath,
      rootId,
      deploymentId: RECOVERY_DEPLOYMENT_ID,
      allowInterruptActiveTasks: false,
    })}\n`,
  );
  const actions: string[] = [];
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: { handle() {}, removeHandler() {} },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: false,
    manager: () => assert.fail('pre-start transition recovery must not require the manager'),
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    resolveManagedDeploymentAuthority: async () => ({ kind: 'transition' }),
    operator: {
      async runService(input: {
        readonly action: 'retire' | 'uninstall';
        readonly target: { readonly deploymentId: string };
      }) {
        actions.push(input.action);
        assert.equal(input.action, 'uninstall');
        assert.equal(input.target.deploymentId, RECOVERY_DEPLOYMENT_ID);
        return {
          kind: 'result' as const,
          action: 'uninstall' as const,
          retirement: { kind: 'stopped' as const },
          service: { state: 'not_installed' },
        };
      },
      async cleanupManagedDeployment() {
        actions.push('cleanup');
      },
      async close() {},
    } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
  });
  t.after(() => service.close());

  assert.equal(await service.recoverBeforeLocalHostStart(), true);
  assert.deepEqual(actions, ['uninstall', 'cleanup', 'cleanup']);
  await assert.rejects(readFile(join(clientDataRoot, 'runtime-host-local-service.json'), 'utf8'), {
    code: 'ENOENT',
  });
});

async function writeManagedLifecycle(
  clientDataRoot: string,
  rootPath: string,
  rootId: string,
): Promise<void> {
  await writeFile(
    join(clientDataRoot, 'runtime-host-local-service.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      state: 'managed',
      serviceId: 'b'.repeat(64),
      operatorPath: join(clientDataRoot, 'operator'),
      rootPath,
      rootId,
      deploymentId: RECOVERY_DEPLOYMENT_ID,
    })}\n`,
  );
}

function peerReachability(
  peerId: string,
  directRoutes: readonly string[],
  coordinationRoutes: readonly string[],
) {
  return {
    lease: {
      version: 1 as const,
      peerId,
      revision: 1,
      issuedAt: 1,
      expiresAt: 2,
      directRoutes,
      coordinationRoutes,
    },
    publicKey: Buffer.from('public').toString('base64url'),
    signature: Buffer.from('signature').toString('base64url'),
  };
}

function hostRegistration(
  overrides: Partial<Pick<HostRegistration, 'rootId' | 'lifecycleMode'>> = {},
): HostRegistration {
  return {
    kind: 'maka-runtime-host',
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId: 'a'.repeat(64),
    hostEpoch: 'older-host',
    endpoint: '/tmp/runtime-host.sock',
    protocolMin: 0,
    protocolMax: 0,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    compositionRevision: 'legacy',
    state: 'ready',
    pid: 42,
    createdAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

function sharedCredential(credentialId: string, status: 'active' | 'pending') {
  return {
    credentialId,
    credentialFingerprint: 'f'.repeat(32),
    principalKind: 'remote_owner' as const,
    principalId: 'desktop-owner:local-runtime-host-sharing',
    status,
    operationGrants: [],
    canPublishClientCapabilities: true,
    canUseHostPaths: false,
    createdAt: new Date(0).toISOString(),
    ...(status === 'pending' ? { expiresAt: new Date(Date.now() + 60_000).toISOString() } : {}),
  };
}
