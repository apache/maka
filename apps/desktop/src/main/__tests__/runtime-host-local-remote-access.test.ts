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
import { resolveRuntimeHostManagedServiceId } from '@maka/runtime-host/operator';
import type { RuntimeHostDesktopManager } from '../runtime-host-desktop-manager.js';
import { createDesktopLocalRuntimeHostRemoteAccess } from '../runtime-host-local-remote-access.js';
import type { createDesktopRuntimeHostLocalOperator } from '../runtime-host-local-operator.js';

test('enabling remote access hands the same root to one managed service before Desktop resumes', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-remote-access-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
  await mkdir(rootPath, { recursive: true });
  const handlers = new Map<string, Parameters<Electron.IpcMain['handle']>[1]>();
  let retired = false;
  let resumed = false;
  const manager = {
    async retireOwnedLocalHost() {
      retired = true;
      return { kind: 'retired' as const, resume: () => { resumed = true; } };
    },
  } as unknown as RuntimeHostDesktopManager;
  const peer = {
    peerId: '12D3KooWpeer',
    routeHints: ['/ip4/192.0.2.1/udp/41000/quic-v1'],
    coordinationRelays: [],
  };
  const operator = {
    async runSetup(input: { readonly rootPath: string; readonly principalId: string }) {
      assert.equal(retired, true);
      assert.equal(input.rootPath, rootPath);
      assert.equal(input.principalId, 'desktop-owner:local-runtime-host-sharing');
      return {
        serviceId,
        operatorPath: join(base, 'operator'),
        rootPath,
        rootId: 'a'.repeat(64),
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
    transport: { kind: 'libp2p-direct', ...peer },
    credential: 'pending-credential',
  });
  assert.equal(
    JSON.parse(await readFile(join(clientDataRoot, 'runtime-host-local-service.json'), 'utf8'))
      .state,
    'managed',
  );
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
  assert.deepEqual(await revoke({} as Electron.IpcMainInvokeEvent), { state: 'on' });
  assert.deepEqual(revoked, [
    {
      principalKind: 'remote_owner',
      principalId: 'desktop-owner:local-runtime-host-sharing',
    },
  ]);
});

test('an interrupted Local Host handoff converges to its exact managed service', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-remote-access-recovery-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  const rootId = 'a'.repeat(64);
  const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
  await mkdir(rootPath, { recursive: true });
  await writeFile(
    join(clientDataRoot, 'runtime-host-local-service.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      state: 'handoff',
      serviceId,
      rootPath,
      rootId,
      coordinationRelays: [],
      allowInterruptActiveTasks: true,
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
        async retireOwnedLocalHost(mode: string) {
          assert.equal(mode, 'interrupt_active_work');
          return { kind: 'not_owned' as const };
        },
      }) as unknown as RuntimeHostDesktopManager,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator: {
      async runSetup() {
        setupCalls += 1;
        return {
          serviceId,
          operatorPath: join(base, 'operator'),
          rootPath,
          rootId,
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

  await service.recover();

  assert.equal(setupCalls, 1);
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
      peerEnabled: true,
      coordinationRelays: ['/dns4/discovery.example/udp/443/quic-v1'],
      allowInterruptActiveTasks: false,
    })}\n`,
  );
  let resumed = false;
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: { handle() {}, removeHandler() {} },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: true,
    manager: () =>
      ({
        async retireOwnedLocalHost() {
          return { kind: 'retired' as const, resume: () => { resumed = true; } };
        },
      }) as unknown as RuntimeHostDesktopManager,
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

  await service.recover();
  assert.equal(resumed, true);
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

test('startup completes an exact persisted uninstall intent after Desktop interruption', async (t) => {
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
      allowInterruptActiveTasks: false,
    })}\n`,
  );
  const actions: string[] = [];
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: { handle() {}, removeHandler() {} },
    clientDataRoot,
    rootPath,
    rootId,
    directPeerAvailable: true,
    manager: () =>
      ({
        async retireOwnedLocalHost() {
          return { kind: 'retired' as const, resume() {} };
        },
      }) as unknown as RuntimeHostDesktopManager,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator: {
      async runService(input: {
        readonly action: 'retire' | 'uninstall';
        readonly retainManagedDeployment?: boolean;
      }) {
        actions.push(input.action);
        assert.equal(input.action, 'uninstall');
        assert.equal(input.retainManagedDeployment, true);
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

  await service.recover();
  assert.deepEqual(actions, ['uninstall', 'cleanup']);
  await assert.rejects(readFile(join(clientDataRoot, 'runtime-host-local-service.json'), 'utf8'), {
    code: 'ENOENT',
  });
});

test('startup resumes deployment cleanup without repeating a completed uninstall', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-cleanup-recovery-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  await mkdir(rootPath, { recursive: true });
  await writeFile(
    join(clientDataRoot, 'runtime-host-local-service.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      state: 'cleanupPending',
      serviceId: 'b'.repeat(64),
      operatorPath: join(base, 'operator'),
      rootPath,
      rootId: 'a'.repeat(64),
      allowInterruptActiveTasks: false,
    })}\n`,
  );
  let cleaned = false;
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: { handle() {}, removeHandler() {} },
    clientDataRoot,
    rootPath,
    rootId: 'a'.repeat(64),
    directPeerAvailable: true,
    manager: () => ({}) as RuntimeHostDesktopManager,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator: {
      async runService() {
        assert.fail('completed uninstall must not be repeated');
      },
      async cleanupManagedDeployment() {
        cleaned = true;
      },
      async close() {},
    } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>,
  });
  t.after(() => service.close());

  await service.recover();
  assert.equal(cleaned, true);
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
    })}\n`,
  );
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
