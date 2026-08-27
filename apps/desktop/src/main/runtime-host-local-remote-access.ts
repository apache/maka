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

import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { IpcMain } from 'electron';
import {
  consumeAccessCredentialDelivery,
  encodeRuntimeHostOwnerConnectionCode,
} from '@maka/runtime-host/client';
import { resolveRuntimeHostManagedServiceId } from '@maka/runtime-host/operator';
import { REMOTE_OWNER_OPERATION_GRANTS } from '@maka/runtime-host/protocol';
import type {
  DesktopLocalRuntimeHostRemoteAccessEnableResult,
  DesktopLocalRuntimeHostRemoteAccessSnapshot,
} from '../preload/bridge-contract.js';
import type { RuntimeHostDesktopManager } from './runtime-host-desktop-manager.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import type {
  createDesktopRuntimeHostLocalOperator,
  DesktopRuntimeHostLocalServiceTarget,
} from './runtime-host-local-operator.js';
import type { DesktopRuntimeHostSetupPackage } from './runtime-host-ssh-terminal.js';

const LIFECYCLE_FILE = 'runtime-host-local-service.json';
const SERVICE_ID_PATTERN = /^[a-f0-9]{64}$/u;
const ROOT_ID_PATTERN = /^[a-f0-9]{64}$/u;
const ADDRESS_MAX_BYTES = 2 * 1024;
const ADDRESS_MAX_COUNT = 16;
const LOCAL_REMOTE_ACCESS_PRINCIPAL_ID = 'desktop-owner:local-runtime-host-sharing';

interface LocalServiceTarget extends DesktopRuntimeHostLocalServiceTarget {
  readonly schemaVersion: 1;
  readonly operatorPath: string;
}

interface LocalServiceHandoff {
  readonly schemaVersion: 1;
  readonly state: 'handoff';
  readonly serviceId: string;
  readonly rootPath: string;
  readonly rootId: string;
  readonly coordinationRelays: readonly string[];
  readonly allowInterruptActiveTasks: boolean;
}

interface LocalServiceManaged extends LocalServiceTarget {
  readonly state: 'managed';
}

interface LocalServicePeerChanging extends LocalServiceTarget {
  readonly state: 'peerChanging';
  readonly peerEnabled: boolean;
  readonly coordinationRelays: readonly string[];
  readonly allowInterruptActiveTasks: boolean;
}

interface LocalServiceUninstalling extends LocalServiceTarget {
  readonly state: 'uninstalling' | 'cleanupPending';
  readonly allowInterruptActiveTasks: boolean;
}

type LocalServiceLifecycle =
  | LocalServiceHandoff
  | LocalServiceManaged
  | LocalServicePeerChanging
  | LocalServiceUninstalling;

interface LocalPeerDescriptor {
  readonly peerId: string;
  readonly routeHints: readonly string[];
  readonly coordinationRelays: readonly string[];
}

type DesktopRuntimeHostLocalOperator = ReturnType<
  typeof createDesktopRuntimeHostLocalOperator
>;
type LocalPeerResultFrame = Extract<
  Awaited<ReturnType<DesktopRuntimeHostLocalOperator['runPeer']>>,
  { kind: 'result'; action: 'enable' | 'disable' }
>;

export function createDesktopLocalRuntimeHostRemoteAccess(input: {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly clientDataRoot: string;
  readonly rootPath: string;
  readonly rootId: string;
  readonly directPeerAvailable: boolean;
  readonly manager: () => RuntimeHostDesktopManager | undefined;
  readonly resolveSetupPackage: (
    signal?: AbortSignal,
  ) => DesktopRuntimeHostSetupPackage | Promise<DesktopRuntimeHostSetupPackage>;
  readonly operator: DesktopRuntimeHostLocalOperator;
}): { recover(): Promise<void>; close(): Promise<void> } {
  const lifecyclePath = join(input.clientDataRoot, LIFECYCLE_FILE);
  const closing = new AbortController();
  let mutation = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutation.then(operation);
    mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const getSnapshot = (): Promise<DesktopLocalRuntimeHostRemoteAccessSnapshot> =>
    serialize(async () => {
      if (!supported(input.directPeerAvailable)) return unsupportedSnapshot();
      try {
        const lifecycle = await readLifecycle(lifecyclePath, input.rootPath, input.rootId);
        if (!lifecycle) return { state: 'off' };
        if (lifecycle.state !== 'managed') {
          return {
            state: 'unavailable',
            message:
              lifecycle.state === 'handoff'
                ? 'Local Runtime Host setup is being recovered'
                : lifecycle.state === 'peerChanging'
                  ? 'Local Runtime Host remote access is being recovered'
                  : 'Local Runtime Host uninstall is being recovered',
          };
        }
        const sharedAccess = await hasSharedAccess(input.operator, lifecycle);
        const peer = await readPeer(input.operator, lifecycle);
        return peer
          ? onSnapshot(sharedAccess)
          : { state: 'off', managedService: true, ...(sharedAccess ? { sharedAccess: true } : {}) };
      } catch (error) {
        return { state: 'unavailable', message: errorMessage(error) };
      }
    });

  const enable = (value: unknown): Promise<DesktopLocalRuntimeHostRemoteAccessEnableResult> =>
    serialize(async () => {
      const request = requireEnableInput(value);
      if (!supported(input.directPeerAvailable)) throw new Error(unsupportedSnapshot().message);
      let lifecycle = await readLifecycle(lifecyclePath, input.rootPath, input.rootId);
      if (lifecycle?.state === 'uninstalling') {
        const recovered = await finishUninstall(lifecycle);
        if (recovered.kind === 'active_tasks') return recovered;
        lifecycle = undefined;
      }
      if (lifecycle?.state === 'cleanupPending') {
        await finishUninstall(lifecycle);
        lifecycle = undefined;
      }
      if (lifecycle?.state === 'peerChanging') {
        const recovered = await finishPeerChange(lifecycle);
        if (recovered.kind === 'active_tasks') return recovered;
        lifecycle = managedLifecycle(lifecycle);
      }
      if (lifecycle?.state === 'handoff') {
        const recovered = await finishHandoff(lifecycle, true);
        if (recovered.kind === 'active_tasks') return recovered;
        lifecycle = recovered.managed;
      }
      if (lifecycle?.state === 'managed') {
        const manager = requireManager(input.manager);
        const previousHostEpoch = manager.current('local')?.candidate?.client.hostEpoch;
        const desired: LocalServicePeerChanging = {
          ...lifecycle,
          state: 'peerChanging',
          peerEnabled: true,
          coordinationRelays: request.coordinationRelays,
          allowInterruptActiveTasks: request.allowInterruptActiveTasks,
        };
        await writeDocument(lifecyclePath, desired);
        const changed = await finishPeerChange(desired);
        if (changed.kind === 'active_tasks') {
          return changed;
        }
        const peer = requireEnabledPeer(changed.response.status);
        await manager.waitUntilReady(
          'local',
          changed.response.restarted ? previousHostEpoch : undefined,
        );
        return enabledResult(
          await issueConnectionCode(input.rootPath, desired.rootId, peer, localClient(input.manager)),
        );
      }

      const handoff: LocalServiceHandoff = {
        schemaVersion: 1,
        state: 'handoff',
        serviceId: resolveRuntimeHostManagedServiceId(input.clientDataRoot),
        rootPath: input.rootPath,
        rootId: input.rootId,
        coordinationRelays: request.coordinationRelays,
        allowInterruptActiveTasks: request.allowInterruptActiveTasks,
      };
      await writeDocument(lifecyclePath, handoff);
      const completed = await finishHandoff(handoff, false);
      if (completed.kind === 'active_tasks') return completed;
      return enabledResult(
        encodeRuntimeHostOwnerConnectionCode({
          name: hostName(),
          rootId: completed.managed.rootId,
          transport: { kind: 'libp2p-direct', ...completed.peer },
          credential: completed.credential,
        }),
      );
    });

  const finishHandoff = async (
    handoff: LocalServiceHandoff,
    allowAlreadyManaged: boolean,
  ): Promise<
    | { readonly kind: 'active_tasks' }
    | {
        readonly kind: 'complete';
        readonly managed: LocalServiceManaged;
        readonly peer: LocalPeerDescriptor;
        readonly credential: string;
      }
  > => {
    const setupPackage = await input.resolveSetupPackage(closing.signal);
    const manager = requireManager(input.manager);
    const retirement = await manager.retireOwnedLocalHost(
      handoff.allowInterruptActiveTasks ? 'interrupt_active_work' : 'refuse_active_work',
    );
    if (retirement.kind === 'active_tasks') {
      if (!allowAlreadyManaged) await removeDocument(lifecyclePath);
      return { kind: 'active_tasks' };
    }
    if (retirement.kind === 'not_owned' && !allowAlreadyManaged) {
      await removeDocument(lifecyclePath);
      throw new Error('The Local Runtime Host is already managed outside this Desktop');
    }
    let target: LocalServiceTarget | undefined;
    try {
      const complete = await input.operator.runSetup(
        {
          setupPackage,
          clientDataRoot: input.clientDataRoot,
          rootPath: handoff.rootPath,
          principalId: LOCAL_REMOTE_ACCESS_PRINCIPAL_ID,
          coordinationRelays: handoff.coordinationRelays,
          expectedTarget: handoff,
          signal: closing.signal,
        },
        () => undefined,
      );
      if (
        complete.serviceId !== handoff.serviceId ||
        complete.rootPath !== handoff.rootPath ||
        complete.rootId !== handoff.rootId ||
        !complete.directPeer
      ) {
        throw new Error('Local Runtime Host setup returned an unrelated service');
      }
      target = requireServiceTarget(
        {
          schemaVersion: 1,
          serviceId: complete.serviceId,
          operatorPath: complete.operatorPath,
          rootPath: complete.rootPath,
          rootId: complete.rootId,
        },
        handoff.rootPath,
      );
      const peer = requireEnabledPeer({ state: 'enabled', ...complete.directPeer });
      const managed: LocalServiceManaged = {
        ...target,
        state: 'managed',
      };
      await writeDocument(lifecyclePath, managed);
      return { kind: 'complete', managed, peer, credential: complete.credential };
    } catch (error) {
      if (!target) throw error;
      try {
        await uninstallExactService(input.operator, target);
        await removeDocument(lifecyclePath);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Local Runtime Host setup rollback failed',
        );
      }
      throw error;
    } finally {
      if (retirement.kind === 'retired') retirement.resume();
    }
  };

  const createConnectionCode = (): Promise<string> =>
    serialize(async () => {
      const managed = requireManaged(
        await readLifecycle(lifecyclePath, input.rootPath, input.rootId),
      );
      const peer = await readPeer(input.operator, managed);
      if (!peer) throw new Error('Remote access is not enabled on this computer');
      return issueConnectionCode(input.rootPath, managed.rootId, peer, localClient(input.manager));
    });

  const revokeSharedAccess = (): Promise<DesktopLocalRuntimeHostRemoteAccessSnapshot> =>
    serialize(async () => {
      const managed = requireManaged(
        await readLifecycle(lifecyclePath, input.rootPath, input.rootId),
      );
      await localClient(input.manager).request('access.principal.revoke', {
        principalKind: 'remote_owner',
        principalId: LOCAL_REMOTE_ACCESS_PRINCIPAL_ID,
      });
      const peer = await readPeer(input.operator, managed);
      return peer ? onSnapshot(false) : { state: 'off', managedService: true };
    });

  const disable = (): Promise<DesktopLocalRuntimeHostRemoteAccessSnapshot> =>
    serialize(async () => {
      const managed = requireManaged(
        await readLifecycle(lifecyclePath, input.rootPath, input.rootId),
      );
      const desired: LocalServicePeerChanging = {
        ...managed,
        state: 'peerChanging',
        peerEnabled: false,
        coordinationRelays: [],
        allowInterruptActiveTasks: false,
      };
      await writeDocument(lifecyclePath, desired);
      const changed = await finishPeerChange(desired);
      if (changed.kind === 'active_tasks') {
        throw new Error('Runtime Host still owns active work; remote access was not disabled');
      }
      if (changed.response.status.state === 'enabled') {
        throw new Error('Local Runtime Host Direct peer did not disable');
      }
      return { state: 'off', managedService: true, ...(await sharedAccessFlag(input.operator, managed)) };
    });

  const uninstall = (
    value: unknown,
  ): Promise<{ readonly kind: 'active_tasks' | 'uninstalled' }> =>
    serialize(async () => {
      if (!isRecord(value) || typeof value.allowInterruptActiveTasks !== 'boolean') {
        throw new Error('Local Runtime Host uninstall request is invalid');
      }
      const allowInterruptActiveTasks = value.allowInterruptActiveTasks;
      const managed = requireManaged(
        await readLifecycle(lifecyclePath, input.rootPath, input.rootId),
      );
      const intent: LocalServiceUninstalling = {
        ...managed,
        state: 'uninstalling',
        allowInterruptActiveTasks,
      };
      await writeDocument(lifecyclePath, intent);
      return finishUninstall(intent);
    });

  const finishPeerChange = async (
    intent: LocalServicePeerChanging,
  ): Promise<
    | { readonly kind: 'active_tasks' }
    | { readonly kind: 'complete'; readonly response: LocalPeerResultFrame }
  > => {
    const changed = await runManagedServiceChange(intent.allowInterruptActiveTasks, () =>
      input.operator.runPeer({
        operatorPath: intent.operatorPath,
        action: intent.peerEnabled ? 'enable' : 'disable',
        target: intent,
        coordinationRelays: intent.coordinationRelays,
        allowInterruptActiveTasks: intent.allowInterruptActiveTasks,
      }),
    );
    if (changed.kind === 'active_tasks') {
      await writeDocument(lifecyclePath, managedLifecycle(intent));
      return changed;
    }
    const response = changed.value;
    if (response.kind === 'error') {
      if (response.error.code === 'active_tasks') {
        await writeDocument(lifecyclePath, managedLifecycle(intent));
        return { kind: 'active_tasks' };
      }
      throw new Error(response.error.message);
    }
    if (response.action === 'status') {
      throw new Error('Local Runtime Host returned an unrelated peer result');
    }
    await writeDocument(lifecyclePath, managedLifecycle(intent));
    return { kind: 'complete', response };
  };

  const finishUninstall = async (
    intent: LocalServiceUninstalling,
  ): Promise<{ readonly kind: 'active_tasks' } | { readonly kind: 'uninstalled' }> => {
    if (intent.state === 'uninstalling') {
      const changed = await runManagedServiceChange(intent.allowInterruptActiveTasks, () =>
        input.operator.runService({
          operatorPath: intent.operatorPath,
          action: 'uninstall',
          target: intent,
          allowInterruptActiveTasks: intent.allowInterruptActiveTasks,
          retainManagedDeployment: true,
        }),
      );
      if (changed.kind === 'active_tasks') {
        await writeDocument(lifecyclePath, managedLifecycle(intent));
        return changed;
      }
      const response = changed.value;
      if (response.kind === 'error') throw new Error(response.error.message);
      if (response.action !== 'uninstall') {
        throw new Error('Local Runtime Host returned an unrelated service result');
      }
      if (response.retirement.kind === 'active_tasks') {
        await writeDocument(lifecyclePath, managedLifecycle(intent));
        return { kind: 'active_tasks' };
      }
      intent = { ...intent, state: 'cleanupPending' };
      await writeDocument(lifecyclePath, intent);
    }
    await input.operator.cleanupManagedDeployment({
      operatorPath: intent.operatorPath,
      target: intent,
      signal: closing.signal,
    });
    await removeDocument(lifecyclePath);
    return { kind: 'uninstalled' };
  };

  const runManagedServiceChange = async <T>(
    allowInterruptActiveTasks: boolean,
    change: () => Promise<T>,
  ): Promise<{ readonly kind: 'active_tasks' } | { readonly kind: 'complete'; readonly value: T }> => {
    const manager = requireManager(input.manager);
    const retirement = await manager.retireOwnedLocalHost(
      allowInterruptActiveTasks ? 'interrupt_active_work' : 'refuse_active_work',
    );
    if (retirement.kind === 'active_tasks') return { kind: 'active_tasks' };
    if (retirement.kind === 'not_owned') {
      return { kind: 'complete', value: await manager.runManagedLocalHostChange(change) };
    }
    try {
      return { kind: 'complete', value: await change() };
    } finally {
      retirement.resume();
    }
  };

  const channels = [
    'local-runtime-host-remote-access:get-snapshot',
    'local-runtime-host-remote-access:enable',
    'local-runtime-host-remote-access:create-connection-code',
    'local-runtime-host-remote-access:revoke-shared-access',
    'local-runtime-host-remote-access:disable',
    'local-runtime-host-remote-access:uninstall',
  ] as const;
  input.ipcMain.handle(channels[0], getSnapshot);
  input.ipcMain.handle(channels[1], (_event, value: unknown) => enable(value));
  input.ipcMain.handle(channels[2], createConnectionCode);
  input.ipcMain.handle(channels[3], revokeSharedAccess);
  input.ipcMain.handle(channels[4], disable);
  input.ipcMain.handle(channels[5], (_event, value: unknown) => uninstall(value));

  return {
    recover: () =>
      serialize(async () => {
        if (!supported(input.directPeerAvailable)) return;
        const lifecycle = await readLifecycle(lifecyclePath, input.rootPath, input.rootId);
        if (!lifecycle) return;
        if (lifecycle.state === 'handoff') {
          await finishHandoff(lifecycle, true);
          return;
        }
        if (lifecycle.state === 'uninstalling') {
          await finishUninstall(lifecycle);
          return;
        }
        if (lifecycle.state === 'cleanupPending') {
          await finishUninstall(lifecycle);
          return;
        }
        if (lifecycle.state === 'peerChanging') {
          const recovered = await finishPeerChange(lifecycle);
          if (recovered.kind === 'active_tasks') {
            throw new Error('Local Runtime Host peer recovery was blocked by active work');
          }
        }
      }),
    async close() {
      for (const channel of channels) input.ipcMain.removeHandler(channel);
      closing.abort(new Error('Maka is shutting down'));
      await input.operator.close();
      await mutation;
    },
  };
}

function supported(directPeerAvailable: boolean): boolean {
  return directPeerAvailable && (process.platform === 'darwin' || process.platform === 'linux');
}

function unsupportedSnapshot(): Extract<
  DesktopLocalRuntimeHostRemoteAccessSnapshot,
  { state: 'unsupported' }
> {
  return {
    state: 'unsupported',
    message:
      process.platform === 'darwin' || process.platform === 'linux'
        ? 'This Desktop build does not include Direct peer support'
        : 'Remote access to this computer currently requires macOS or Linux',
  };
}

function requireEnableInput(value: unknown): {
  readonly allowInterruptActiveTasks: boolean;
  readonly coordinationRelays: readonly string[];
} {
  if (!isRecord(value) || typeof value.allowInterruptActiveTasks !== 'boolean') {
    throw new Error('Local Runtime Host remote-access request is invalid');
  }
  return {
    allowInterruptActiveTasks: value.allowInterruptActiveTasks,
    coordinationRelays: requireAddresses(value.coordinationRelays),
  };
}

async function readPeer(
  operator: DesktopRuntimeHostLocalOperator,
  receipt: LocalServiceTarget,
): Promise<LocalPeerDescriptor | undefined> {
  const response = await operator.runPeer({
    operatorPath: receipt.operatorPath,
    action: 'status',
    target: receipt,
  });
  if (response.kind === 'error') throw new Error(response.error.message);
  return response.status.state === 'enabled' ? requireEnabledPeer(response.status) : undefined;
}

function requireEnabledPeer(value: unknown): LocalPeerDescriptor {
  if (!isRecord(value) || value.state !== 'enabled') {
    throw new Error('Runtime Host Direct peer is not enabled');
  }
  if (typeof value.peerId !== 'string' || value.peerId.length === 0 || value.peerId.length > 160) {
    throw new Error('Runtime Host returned an invalid peer identity');
  }
  const peer = {
    peerId: value.peerId,
    routeHints: requireAddresses(value.routeHints),
    coordinationRelays: requireAddresses(value.coordinationRelays),
  };
  if (peer.routeHints.length === 0 && peer.coordinationRelays.length === 0) {
    throw new Error('Runtime Host Direct peer has no reachable route');
  }
  return peer;
}

function onSnapshot(sharedAccess: boolean): Extract<
  DesktopLocalRuntimeHostRemoteAccessSnapshot,
  { state: 'on' }
> {
  return { state: 'on', ...(sharedAccess ? { sharedAccess: true } : {}) };
}

function enabledResult(
  connectionCode: string,
): Extract<DesktopLocalRuntimeHostRemoteAccessEnableResult, { kind: 'enabled' }> {
  return { kind: 'enabled', connectionCode, snapshot: onSnapshot(true) };
}

async function issueConnectionCode(
  rootPath: string,
  rootId: string,
  peer: LocalPeerDescriptor,
  client: DesktopRuntimeHostClient,
): Promise<string> {
  const prepared = await client.request('access.credential.prepare', {
    principalKind: 'remote_owner',
    principalId: LOCAL_REMOTE_ACCESS_PRINCIPAL_ID,
    operationGrants: REMOTE_OWNER_OPERATION_GRANTS,
    canPublishClientCapabilities: true,
    canUseHostPaths: false,
    bindClientInstance: true,
  });
  const credential = await consumeAccessCredentialDelivery(
    rootPath,
    prepared.deliveryId,
    prepared.credentialId,
  );
  return encodeRuntimeHostOwnerConnectionCode({
    name: hostName(),
    rootId,
    transport: { kind: 'libp2p-direct', ...peer },
    credential,
  });
}

async function hasSharedAccess(
  operator: DesktopRuntimeHostLocalOperator,
  target: LocalServiceTarget,
): Promise<boolean> {
  const response = await operator.runAccess({
    operatorPath: target.operatorPath,
    target,
  });
  if (response.kind === 'error') throw new Error(response.error.message);
  return response.credentials.some(
    (credential) =>
      credential.principalKind === 'remote_owner' &&
      credential.principalId === LOCAL_REMOTE_ACCESS_PRINCIPAL_ID,
  );
}

async function sharedAccessFlag(
  operator: DesktopRuntimeHostLocalOperator,
  target: LocalServiceTarget,
): Promise<{ readonly sharedAccess: true } | Record<string, never>> {
  return (await hasSharedAccess(operator, target)) ? { sharedAccess: true } : {};
}

function localClient(manager: () => RuntimeHostDesktopManager | undefined): DesktopRuntimeHostClient {
  const snapshot = requireManager(manager).current('local');
  if (!snapshot?.candidate) throw new Error('The Local Runtime Host is reconnecting');
  return snapshot.candidate.client;
}

function requireManager(
  manager: () => RuntimeHostDesktopManager | undefined,
): RuntimeHostDesktopManager {
  const current = manager();
  if (!current) throw new Error('Runtime Host manager is unavailable');
  return current;
}

function hostName(): string {
  return hostname().trim().slice(0, 128) || 'Remote computer';
}

function requireServiceTarget(value: unknown, rootPath: string): LocalServiceTarget {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.serviceId !== 'string' ||
    !SERVICE_ID_PATTERN.test(value.serviceId) ||
    typeof value.rootId !== 'string' ||
    !ROOT_ID_PATTERN.test(value.rootId) ||
    value.rootPath !== rootPath ||
    typeof value.operatorPath !== 'string' ||
    !isAbsolute(value.operatorPath)
  ) {
    throw new Error('Local Runtime Host service receipt is invalid');
  }
  return {
    schemaVersion: 1,
    serviceId: value.serviceId,
    rootPath,
    rootId: value.rootId,
    operatorPath: value.operatorPath,
  };
}

function requireManaged(lifecycle: LocalServiceLifecycle | undefined): LocalServiceManaged {
  if (lifecycle?.state !== 'managed') {
    throw new Error('Remote access has not been set up on this computer');
  }
  return lifecycle;
}

function managedLifecycle(intent: LocalServiceTarget): LocalServiceManaged {
  return {
    schemaVersion: 1,
    state: 'managed',
    serviceId: intent.serviceId,
    operatorPath: intent.operatorPath,
    rootPath: intent.rootPath,
    rootId: intent.rootId,
  };
}

async function readLifecycle(
  path: string,
  rootPath: string,
  rootId: string,
): Promise<LocalServiceLifecycle | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.rootPath !== rootPath ||
    value.rootId !== rootId
  ) {
    throw new Error('Local Runtime Host service lifecycle is invalid');
  }
  if (value.state === 'handoff') {
    assertExactKeys(value, [
      'schemaVersion',
      'state',
      'serviceId',
      'rootPath',
      'rootId',
      'coordinationRelays',
      'allowInterruptActiveTasks',
    ]);
    if (
      typeof value.serviceId !== 'string' ||
      !SERVICE_ID_PATTERN.test(value.serviceId) ||
      typeof value.allowInterruptActiveTasks !== 'boolean'
    ) {
      throw new Error('Local Runtime Host handoff intent is invalid');
    }
    return {
      schemaVersion: 1,
      state: 'handoff',
      serviceId: value.serviceId,
      rootPath,
      rootId,
      coordinationRelays: requireAddresses(value.coordinationRelays),
      allowInterruptActiveTasks: value.allowInterruptActiveTasks,
    };
  }
  const target = requireServiceTarget(value, rootPath);
  assertExactKeys(
    value,
    value.state === 'managed'
      ? [
          'schemaVersion',
          'state',
          'serviceId',
          'operatorPath',
          'rootPath',
          'rootId',
        ]
      : value.state === 'peerChanging'
        ? [
            'schemaVersion',
            'state',
            'serviceId',
            'operatorPath',
            'rootPath',
            'rootId',
            'peerEnabled',
            'coordinationRelays',
            'allowInterruptActiveTasks',
          ]
        : [
            'schemaVersion',
            'state',
            'serviceId',
            'operatorPath',
            'rootPath',
            'rootId',
            'allowInterruptActiveTasks',
          ],
  );
  if (
    value.state !== 'managed' &&
    value.state !== 'peerChanging' &&
    value.state !== 'uninstalling' &&
    value.state !== 'cleanupPending'
  ) {
    throw new Error('Local Runtime Host service lifecycle is invalid');
  }
  if (value.state === 'managed') return { ...target, state: 'managed' };
  if (typeof value.allowInterruptActiveTasks !== 'boolean') {
    throw new Error('Local Runtime Host service intent is invalid');
  }
  if (value.state === 'peerChanging') {
    if (typeof value.peerEnabled !== 'boolean') {
      throw new Error('Local Runtime Host peer intent is invalid');
    }
    return {
      ...target,
      state: 'peerChanging',
      peerEnabled: value.peerEnabled,
      coordinationRelays: requireAddresses(value.coordinationRelays),
      allowInterruptActiveTasks: value.allowInterruptActiveTasks,
    };
  }
  return {
    ...target,
    state: value.state,
    allowInterruptActiveTasks: value.allowInterruptActiveTasks,
  };
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    Object.keys(value).length !== keys.length
  ) {
    throw new Error('Local Runtime Host service lifecycle is invalid');
  }
}

async function writeDocument(path: string, value: object): Promise<void> {
  const temporaryPath = join(dirname(path), `.runtime-host-local-service-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeDocument(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

async function uninstallExactService(
  operator: DesktopRuntimeHostLocalOperator,
  receipt: LocalServiceTarget,
): Promise<void> {
  const response = await operator.runService({
    operatorPath: receipt.operatorPath,
    action: 'uninstall',
    target: receipt,
  });
  if (
    response.kind === 'error' ||
    response.action !== 'uninstall' ||
    response.service.state !== 'not_installed'
  ) {
    throw new Error(
      response.kind === 'error'
        ? response.error.message
        : 'Local Runtime Host service was not cleanly uninstalled',
    );
  }
}

function requireAddresses(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > ADDRESS_MAX_COUNT) {
    throw new Error('Runtime Host peer routes are invalid');
  }
  return value.map((entry) => {
    if (
      typeof entry !== 'string' ||
      !entry.startsWith('/') ||
      Buffer.byteLength(entry, 'utf8') > ADDRESS_MAX_BYTES ||
      /[\s\u0000-\u001f\u007f]/u.test(entry)
    ) {
      throw new Error('Runtime Host peer route is invalid');
    }
    return entry;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
