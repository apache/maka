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
import { dirname, join } from 'node:path';
import type { IpcMain } from 'electron';
import {
  encodeRuntimeHostOwnerConnectionCode,
  issueRuntimeHostOwnerConnectionCode,
} from '@maka/runtime-host/client';
import {
  createRuntimeHostLegacyPosixOperatorCommand,
  runtimeHostManagedOperatorCommand,
  decodeRuntimeHostOperatorCommand,
  resolveRuntimeHostManagedDeploymentAuthority,
  type RuntimeHostOperatorCommand,
} from '@maka/runtime-host/operator';
import type { HostPeerEndpoint, HostRegistration } from '@maka/runtime-host/protocol';
import type {
  DesktopLocalRuntimeHostRemoteAccessEnableResult,
  DesktopLocalRuntimeHostRemoteAccessSnapshot,
} from '../preload/bridge-contract.js';
import type {
  RuntimeHostDesktopManager,
  RuntimeHostLocalReplacement,
} from './runtime-host-desktop-manager.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import type {
  createDesktopRuntimeHostLocalOperator,
  DesktopRuntimeHostLocalServiceTarget,
} from './runtime-host-local-operator.js';
import type { DesktopRuntimeHostSetupPackage } from './runtime-host-setup-package.js';

const LIFECYCLE_FILE = 'runtime-host-local-service.json';
const SERVICE_ID_PATTERN = /^[a-f0-9]{64}$/u;
const ROOT_ID_PATTERN = /^[a-f0-9]{64}$/u;
const DEPLOYMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ADDRESS_MAX_BYTES = 2 * 1024;
const ADDRESS_MAX_COUNT = 16;
const LOCAL_REMOTE_ACCESS_PRINCIPAL_ID = 'desktop-owner:local-runtime-host-sharing';

interface LocalServiceTarget extends DesktopRuntimeHostLocalServiceTarget {
  readonly schemaVersion: 2;
  readonly operator: RuntimeHostOperatorCommand;
  readonly deploymentId: string;
}

interface LocalServiceSetupPending {
  readonly schemaVersion: 2;
  /** Persisted only after the Desktop-owned Host has retired. */
  readonly state: 'setupPending';
  readonly rootPath: string;
  readonly rootId: string;
  readonly coordinationRelays: readonly string[];
  readonly allowInterruptActiveTasks: boolean;
}

/** Released schema-v1 setup intent written before managed ownership was established. */
interface LocalServiceLegacyHandoff {
  readonly schemaVersion: 1;
  readonly state: 'handoff';
  readonly rootPath: string;
  readonly rootId: string;
  readonly coordinationRelays: readonly string[];
  readonly allowInterruptActiveTasks: boolean;
}

interface LocalServiceManaged extends LocalServiceTarget {
  readonly state: 'managed';
}

type LocalManagedDeploymentAuthority =
  | {
      readonly kind: 'active';
      readonly lifecycleMode: 'on_demand' | 'supervised';
      readonly deploymentRoot: string;
      readonly target: LocalServiceTarget;
    }
  | { readonly kind: 'transition' };

export interface DesktopRuntimeHostLocalManagementTarget
  extends DesktopRuntimeHostLocalServiceTarget {
  readonly operator: RuntimeHostOperatorCommand;
  readonly deploymentId: string;
}

export type DesktopRuntimeHostManagedStartupRepairResult =
  | { readonly kind: 'repaired' }
  | { readonly kind: 'active_tasks' }
  | { readonly kind: 'unavailable' };

export interface DesktopLocalRuntimeHostRemoteAccess {
  getSnapshot(): Promise<DesktopLocalRuntimeHostRemoteAccessSnapshot>;
  createCollaborationConnectionTarget(): Promise<{
    readonly name: string;
    readonly transport: {
      readonly kind: 'libp2p-direct';
      readonly reachability: HostPeerEndpoint;
    };
  }>;
  enable(value: unknown): Promise<DesktopLocalRuntimeHostRemoteAccessEnableResult>;
  disable(): Promise<DesktopLocalRuntimeHostRemoteAccessSnapshot>;
  uninstall(value: unknown): Promise<{ readonly kind: 'active_tasks' | 'uninstalled' }>;
  inspectManaged<T>(
    operation: (target: DesktopRuntimeHostLocalManagementTarget) => Promise<T>,
  ): Promise<T>;
  changeManaged<T>(
    operation: (target: DesktopRuntimeHostLocalManagementTarget) => Promise<T>,
  ): Promise<T>;
  resolveConflictingHostReplacement(
    registration: HostRegistration,
    signal: AbortSignal,
  ): Promise<RuntimeHostLocalReplacement | undefined>;
  repairManagedStartup(input?: {
    readonly allowManualUpdate?: boolean;
    readonly allowInterruptActiveTasks?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<DesktopRuntimeHostManagedStartupRepairResult>;
  recoverBeforeLocalHostStart(signal?: AbortSignal): Promise<boolean>;
  recover(): Promise<void>;
  close(): Promise<void>;
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
  | LocalServiceLegacyHandoff
  | LocalServiceSetupPending
  | LocalServiceManaged
  | LocalServicePeerChanging
  | LocalServiceUninstalling;

interface LocalPeerDescriptor {
  readonly peerId: string;
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
  readonly resolveManagedDeploymentAuthority?: (
    rootId: string,
  ) => Promise<LocalManagedDeploymentAuthority | undefined>;
}): DesktopLocalRuntimeHostRemoteAccess {
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
  const resolveManagedDeploymentAuthority =
    input.resolveManagedDeploymentAuthority ??
    (async (rootId: string): Promise<LocalManagedDeploymentAuthority | undefined> => {
      const authority = await resolveRuntimeHostManagedDeploymentAuthority(rootId);
      if (!authority) return undefined;
      if (authority.record.state !== 'active') return { kind: 'transition' };
      return {
        kind: 'active',
        lifecycleMode: authority.record.lifecycle.mode,
        deploymentRoot: authority.record.deploymentRoot,
        target: requireServiceTarget(
          {
            schemaVersion: 2,
            serviceId: authority.record.root.id,
            operator: runtimeHostManagedOperatorCommand(
              authority.record,
              process.platform === 'win32' ? 'win32' : 'posix',
            ),
            rootPath: authority.record.root.path,
            rootId: authority.record.root.id,
            deploymentId: authority.record.deploymentId,
          },
          input.rootPath,
        ),
      };
    });

  const adoptCommittedSetup = async (
    setup: LocalServiceSetupPending | LocalServiceLegacyHandoff,
  ): Promise<
    | { readonly kind: 'absent' | 'transition' }
    | { readonly kind: 'managed'; readonly managed: LocalServiceManaged }
  > => {
    const authority = await resolveManagedDeploymentAuthority(setup.rootId);
    if (!authority) return { kind: 'absent' };
    if (authority.kind === 'transition') return authority;
    const target =
      setup.schemaVersion === 1
        ? {
            ...authority.target,
            operator: createRuntimeHostLegacyPosixOperatorCommand(
              join(authority.deploymentRoot, 'operator'),
            ),
          }
        : authority.target;
    const managed = managedLifecycle(target);
    await writeDocument(lifecyclePath, managed);
    return { kind: 'managed', managed };
  };

  const getSnapshot = (): Promise<DesktopLocalRuntimeHostRemoteAccessSnapshot> =>
    serialize(async () => {
      let managedService = false;
      try {
        const lifecycle = await readLifecycle(lifecyclePath, input.rootPath, input.rootId);
        managedService = lifecycle !== undefined && hasManagedServiceTarget(lifecycle);
        if (!input.directPeerAvailable) {
          return {
            ...unsupportedSnapshot(),
            ...(managedService ? { managedService: true as const } : {}),
          };
        }
        if (!lifecycle) return { state: 'off' };
        if (lifecycle.state !== 'managed') {
          return {
            state: 'unavailable',
            message:
              lifecycle.state === 'setupPending' || lifecycle.state === 'handoff'
                ? 'Local Runtime Host setup is being recovered'
                : lifecycle.state === 'peerChanging'
                  ? 'Local Runtime Host remote access is being recovered'
                  : 'Local Runtime Host uninstall is being recovered',
            ...(managedService ? { managedService: true } : {}),
          };
        }
        const sharedAccess = await hasSharedAccess(input.operator, lifecycle);
        const peer = await readPeer(input.operator, lifecycle);
        return peer
          ? onSnapshot(sharedAccess)
          : { state: 'off', managedService: true, ...(sharedAccess ? { sharedAccess: true } : {}) };
      } catch (error) {
        return {
          state: 'unavailable',
          message: errorMessage(error),
          ...(managedService ? { managedService: true } : {}),
        };
      }
    });

  const enable = (value: unknown): Promise<DesktopLocalRuntimeHostRemoteAccessEnableResult> =>
    serialize(async () => {
      const request = requireEnableInput(value);
      if (!input.directPeerAvailable) throw new Error(unsupportedSnapshot().message);
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
        const recovered = await recoverLegacyHandoff(lifecycle);
        if (recovered.kind === 'active_tasks') return recovered;
        if (recovered.kind === 'external') {
          throw new Error('The Local Runtime Host is already managed outside this Desktop');
        }
        lifecycle = recovered.managed;
      }
      if (lifecycle?.state === 'setupPending') {
        const committed = await adoptCommittedSetup(lifecycle);
        if (committed.kind === 'managed') {
          lifecycle = committed.managed;
        } else {
          const recovered = await finishSetup(lifecycle, 'recovery');
          if (recovered.kind === 'active_tasks') return recovered;
          lifecycle = recovered.managed;
        }
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
          await issueConnectionCode(input.rootPath, peer, localClient(input.manager)),
        );
      }

      const setup: LocalServiceSetupPending = {
        schemaVersion: 2,
        state: 'setupPending',
        rootPath: input.rootPath,
        rootId: input.rootId,
        coordinationRelays: request.coordinationRelays,
        allowInterruptActiveTasks: request.allowInterruptActiveTasks,
      };
      const completed = await finishSetup(setup, 'request');
      if (completed.kind === 'active_tasks') return completed;
      const manager = requireManager(input.manager);
      await manager.waitUntilReady('local');
      const livePeer = await readLivePeer(localClient(input.manager), completed.peer);
      return enabledResult(
        encodeRuntimeHostOwnerConnectionCode({
          name: hostName(),
          rootId: completed.managed.rootId,
          transport: { kind: 'libp2p-direct', reachability: livePeer },
          credential: completed.credential,
        }),
      );
    });

  const finishSetup = async (
    setup: LocalServiceSetupPending,
    origin: 'request' | 'recovery',
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
      setup.allowInterruptActiveTasks ? 'interrupt_active_work' : 'refuse_active_work',
    );
    if (retirement.kind === 'active_tasks') {
      return { kind: 'active_tasks' };
    }
    if (retirement.kind === 'not_owned' && origin === 'request') {
      throw new Error('The Local Runtime Host is already managed outside this Desktop');
    }
    try {
      if (origin === 'request') await writeDocument(lifecyclePath, setup);
      const reconcile = () => reconcileSetup(setup, setupPackage);
      // Recovery may find that the operator already owns the root. Its setup
      // can still restart that Host, so keep Desktop reconnect quiesced across
      // the entire reconciliation just like every other managed-service change.
      return retirement.kind === 'not_owned'
        ? await manager.runManagedLocalHostChange(reconcile)
        : await reconcile();
    } finally {
      if (retirement.kind === 'retired') retirement.resume();
    }
  };

  const reconcileSetup = async (
    setup: LocalServiceSetupPending,
    setupPackage: DesktopRuntimeHostSetupPackage,
    signal: AbortSignal = closing.signal,
  ): Promise<{
    readonly kind: 'complete';
    readonly managed: LocalServiceManaged;
    readonly peer: LocalPeerDescriptor;
    readonly credential: string;
  }> => {
    let target: LocalServiceTarget | undefined;
    try {
      const complete = await input.operator.runSetup(
        {
          setupPackage,
          clientDataRoot: input.clientDataRoot,
          rootPath: setup.rootPath,
          principalId: LOCAL_REMOTE_ACCESS_PRINCIPAL_ID,
          coordinationRelays: setup.coordinationRelays,
          expectedTarget: {
            serviceId: setup.rootId,
            rootPath: setup.rootPath,
            rootId: setup.rootId,
          },
          signal,
        },
        () => undefined,
      );
      if (
        complete.serviceId !== setup.rootId ||
        complete.rootPath !== setup.rootPath ||
        complete.rootId !== setup.rootId ||
        !DEPLOYMENT_ID_PATTERN.test(complete.deploymentId) ||
        !complete.directPeer
      ) {
        throw new Error('Local Runtime Host setup returned an unrelated service');
      }
      target = requireServiceTarget(
        {
          schemaVersion: 2,
          serviceId: complete.serviceId,
          operator: complete.operator,
          rootPath: complete.rootPath,
          rootId: complete.rootId,
          deploymentId: complete.deploymentId,
        },
        setup.rootPath,
      );
      const peer = requireEnabledPeer({ state: 'enabled', ...complete.directPeer });
      const managed: LocalServiceManaged = { ...target, state: 'managed' };
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
    }
  };

  const recoverLegacyHandoff = async (
    legacy: LocalServiceLegacyHandoff,
  ): Promise<
    | { readonly kind: 'active_tasks' }
    | { readonly kind: 'external' }
    | { readonly kind: 'complete'; readonly managed: LocalServiceManaged }
  > => {
    const pending = pendingSetup(legacy);
    const authority = await adoptCommittedSetup(legacy);
    if (authority.kind === 'managed') {
      return { kind: 'complete', managed: authority.managed };
    }
    if (authority.kind === 'transition') {
      await writeDocument(lifecyclePath, pending);
      return finishSetup(pending, 'recovery');
    }

    const manager = requireManager(input.manager);
    const retirement = await manager.retireOwnedLocalHost(
      legacy.allowInterruptActiveTasks ? 'interrupt_active_work' : 'refuse_active_work',
    );
    if (retirement.kind === 'active_tasks') return { kind: 'active_tasks' };
    if (retirement.kind === 'not_owned') {
      const raced = await adoptCommittedSetup(legacy);
      if (raced.kind === 'managed') {
        return { kind: 'complete', managed: raced.managed };
      }
      if (raced.kind === 'absent') {
        await removeDocument(lifecyclePath);
        return { kind: 'external' };
      }
    }

    try {
      await writeDocument(lifecyclePath, pending);
      const setupPackage = await input.resolveSetupPackage(closing.signal);
      const reconcile = () => reconcileSetup(pending, setupPackage);
      return retirement.kind === 'not_owned'
        ? await manager.runManagedLocalHostChange(reconcile)
        : await reconcile();
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
      return issueConnectionCode(input.rootPath, peer, localClient(input.manager));
    });

  const createCollaborationConnectionTarget = () =>
    serialize(async () => {
      const managed = requireManaged(
        await readLifecycle(lifecyclePath, input.rootPath, input.rootId),
      );
      const peer = await readPeer(input.operator, managed);
      if (!peer) throw new Error('Remote access is not enabled on this computer');
      const livePeer = await readLivePeer(localClient(input.manager), peer);
      return {
        name: hostName(),
        transport: { kind: 'libp2p-direct' as const, reachability: livePeer },
      };
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
      const lifecycle = await readLifecycle(lifecyclePath, input.rootPath, input.rootId);
      if (lifecycle?.state === 'uninstalling') {
        const intent = allowInterruptActiveTasks && !lifecycle.allowInterruptActiveTasks
          ? { ...lifecycle, allowInterruptActiveTasks: true }
          : lifecycle;
        if (intent !== lifecycle) await writeDocument(lifecyclePath, intent);
        return finishUninstall(intent);
      }
      if (lifecycle?.state === 'cleanupPending') {
        return finishUninstall(lifecycle);
      }
      const managed = requireManagementTarget(lifecycle);
      const intent: LocalServiceUninstalling = {
        schemaVersion: 2,
        ...managed,
        state: 'uninstalling',
        allowInterruptActiveTasks,
      };
      await writeDocument(lifecyclePath, intent);
      return finishUninstall(intent);
    });

  const finishPeerChange = async (
    intent: LocalServicePeerChanging,
    coordination: 'manager' | 'direct' = 'manager',
  ): Promise<
    | { readonly kind: 'active_tasks' }
    | { readonly kind: 'complete'; readonly response: LocalPeerResultFrame }
  > => {
    const change = () =>
      input.operator.runPeer({
        operator: intent.operator,
        action: intent.peerEnabled ? 'enable' : 'disable',
        target: intent,
        coordinationRelays: intent.coordinationRelays,
        allowInterruptActiveTasks: intent.allowInterruptActiveTasks,
      });
    const response = coordination === 'manager'
      ? await runManagedServiceChange(change)
      : await change();
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
    coordination: 'manager' | 'direct' = 'manager',
    signal: AbortSignal = closing.signal,
  ): Promise<{ readonly kind: 'active_tasks' } | { readonly kind: 'uninstalled' }> => {
    if (intent.state === 'uninstalling') {
      const authority = await resolveManagedDeploymentAuthority(intent.rootId);
      if (authority) {
        const change = () =>
          input.operator.runService({
            operator: intent.operator,
            action: 'uninstall',
            target: intent,
            allowInterruptActiveTasks: intent.allowInterruptActiveTasks,
            retainManagedDeployment: true,
          });
        const response = coordination === 'manager'
          ? await runManagedServiceChange(change)
          : await change();
        if (response.kind === 'error') throw new Error(response.error.message);
        if (response.action !== 'uninstall') {
          throw new Error('Local Runtime Host returned an unrelated service result');
        }
        if (response.retirement.kind === 'active_tasks') {
          await writeDocument(lifecyclePath, managedLifecycle(intent));
          return { kind: 'active_tasks' };
        }
      }
      intent = { ...intent, state: 'cleanupPending' };
      await writeDocument(lifecyclePath, intent);
    }
    await input.operator.cleanupManagedDeployment({
      operator: intent.operator,
      target: intent,
      signal,
    });
    await input.operator.cleanupManagedDeployment({
      operator: intent.operator,
      target: intent,
      finalize: true,
      signal,
    });
    await removeDocument(lifecyclePath);
    return { kind: 'uninstalled' };
  };

  const runManagedServiceChange = <T>(change: () => Promise<T>): Promise<T> => {
    const manager = requireManager(input.manager);
    return manager.runManagedLocalHostChange(change);
  };

  const channels = [
    'local-runtime-host-remote-access:get-snapshot',
    'local-runtime-host-remote-access:enable',
    'local-runtime-host-remote-access:create-connection-code',
    'local-runtime-host-remote-access:revoke-shared-access',
    'local-runtime-host-remote-access:disable',
  ] as const;
  input.ipcMain.handle(channels[0], getSnapshot);
  input.ipcMain.handle(channels[1], (_event, value: unknown) => enable(value));
  input.ipcMain.handle(channels[2], createConnectionCode);
  input.ipcMain.handle(channels[3], revokeSharedAccess);
  input.ipcMain.handle(channels[4], disable);

  return {
    getSnapshot,
    createCollaborationConnectionTarget,
    enable,
    disable,
    uninstall,
    inspectManaged: (operation) =>
      serialize(async () => {
        const managed = requireManagementTarget(
          await readLifecycle(lifecyclePath, input.rootPath, input.rootId),
        );
        return operation(managed);
      }),
    changeManaged: (operation) =>
      serialize(async () => {
        const lifecycle = await readLifecycle(lifecyclePath, input.rootPath, input.rootId);
        if (lifecycle?.state === 'uninstalling' || lifecycle?.state === 'cleanupPending') {
          throw new Error('Finish uninstalling the Local Runtime Host before changing it');
        }
        const managed = requireManagementTarget(lifecycle);
        return requireManager(input.manager).runManagedLocalHostChange(() => operation(managed));
      }),
    resolveConflictingHostReplacement: async (registration, signal) => {
      signal.throwIfAborted();
      if (registration.rootId !== input.rootId) {
        throw conflictReplacementError(registration.pid, 'the workspace identity changed');
      }
      if (registration.lifecycleMode === 'ephemeral') return undefined;
      const authority = await resolveManagedDeploymentAuthority(registration.rootId);
      if (
        !authority ||
        authority.kind !== 'active' ||
        authority.lifecycleMode !== 'supervised'
      ) {
        return undefined;
      }
      const target = authority.target;
      return {
        replace: (activeWorkPolicy) =>
          serialize(async () => {
            signal.throwIfAborted();
            const setupPackage = await input.resolveSetupPackage(signal);
            const frame = await input.operator.runUpdate(
              {
                setupPackage,
                target,
                expectedHost: {
                  hostEpoch: registration.hostEpoch,
                  pid: registration.pid,
                },
                ...(activeWorkPolicy === 'interrupt_active_work'
                  ? { allowInterruptActiveTasks: true }
                  : {}),
                signal,
              },
              () => undefined,
            );
            if (frame.kind === 'error') {
              if (frame.error.code === 'active_tasks') return 'active_tasks';
              if (frame.error.code === 'target_mismatch') return 'replaced';
              throw conflictReplacementError(registration.pid, frame.error.message);
            }
            if (frame.kind === 'progress' || frame.action !== 'update') {
              throw conflictReplacementError(
                registration.pid,
                'the managed service returned an unrelated result',
              );
            }
            if (frame.update.kind === 'active_tasks') {
              return 'active_tasks';
            }
            if (frame.update.kind === 'already_current') {
              throw conflictReplacementError(
                registration.pid,
                'the managed service did not replace the observed Host',
              );
            }
            return 'replaced';
          }),
      };
    },
    repairManagedStartup: (options = {}) =>
      serialize(async () => {
        const signal = options.signal
          ? AbortSignal.any([options.signal, closing.signal])
          : closing.signal;
        signal.throwIfAborted();
        const lifecycle = await readLifecycle(lifecyclePath, input.rootPath, input.rootId);
        if (lifecycle?.state !== 'managed') return { kind: 'unavailable' };

        const setupPackage = await input.resolveSetupPackage(signal);
        const frame = await input.operator.runUpdate(
          {
            setupPackage,
            target: lifecycle,
            ...(options.allowManualUpdate ? { allowManualUpdate: true } : {}),
            ...(options.allowInterruptActiveTasks
              ? { allowInterruptActiveTasks: true }
              : {}),
            signal,
          },
          () => undefined,
        );
        if (frame.kind === 'error') {
          if (frame.error.code === 'active_tasks') return { kind: 'active_tasks' };
          throw new Error(`Runtime Host repair failed: ${frame.error.message}`);
        }
        if (frame.kind === 'progress' || frame.action !== 'update') {
          throw new Error('Runtime Host repair returned an unrelated result');
        }
        if (frame.update.kind === 'active_tasks') return { kind: 'active_tasks' };

        if (frame.update.kind === 'already_current') {
          const restarted = await input.operator.runService({
            operator: lifecycle.operator,
            action: 'restart',
            target: lifecycle,
            ...(options.allowInterruptActiveTasks
              ? { allowInterruptActiveTasks: true }
              : {}),
            signal,
          });
          if (restarted.kind === 'error') {
            if (restarted.error.code === 'active_tasks') return { kind: 'active_tasks' };
            throw new Error(`Runtime Host restart failed: ${restarted.error.message}`);
          }
          if (restarted.kind === 'progress' || restarted.action !== 'restart') {
            throw new Error('Runtime Host restart returned an unrelated result');
          }
        }
        return { kind: 'repaired' };
      }),
    recoverBeforeLocalHostStart: async (signal) => {
      const operationSignal = signal ? AbortSignal.any([signal, closing.signal]) : closing.signal;
      operationSignal.throwIfAborted();
      const observed = await readLifecycle(lifecyclePath, input.rootPath, input.rootId);
      if (observed?.state === 'peerChanging') {
        return serialize(async () => {
          operationSignal.throwIfAborted();
          const pending = await readLifecycle(lifecyclePath, input.rootPath, input.rootId);
          if (pending?.state !== 'peerChanging') return false;
          await finishPeerChange(pending, 'direct');
          return true;
        });
      }
      if (observed?.state === 'uninstalling' || observed?.state === 'cleanupPending') {
        return serialize(async () => {
          operationSignal.throwIfAborted();
          const pending = await readLifecycle(lifecyclePath, input.rootPath, input.rootId);
          if (pending?.state !== 'uninstalling' && pending?.state !== 'cleanupPending') {
            return false;
          }
          await finishUninstall(pending, 'direct', operationSignal);
          return true;
        });
      }
      if (observed?.state !== 'setupPending' && observed?.state !== 'handoff') return false;
      return serialize(async () => {
        operationSignal.throwIfAborted();
        const pending = await readLifecycle(lifecyclePath, input.rootPath, input.rootId);
        if (pending?.state !== 'setupPending' && pending?.state !== 'handoff') return false;
        const current = pendingSetup(pending);
        const authority = await adoptCommittedSetup(pending);
        if (authority.kind === 'absent') return false;
        if (authority.kind === 'managed') return true;
        if (pending.state === 'handoff') await writeDocument(lifecyclePath, current);
        const setupPackage = await input.resolveSetupPackage(operationSignal);
        await reconcileSetup(current, setupPackage, operationSignal);
        return true;
      });
    },
    recover: () =>
      serialize(async () => {
        const lifecycle = await readLifecycle(lifecyclePath, input.rootPath, input.rootId);
        if (!lifecycle) return;
        if (lifecycle.state === 'uninstalling' || lifecycle.state === 'cleanupPending') {
          await finishUninstall(lifecycle);
          return;
        }
        if (lifecycle.state === 'peerChanging') {
          const recovered = await finishPeerChange(lifecycle);
          if (recovered.kind === 'active_tasks') {
            throw new Error('Local Runtime Host peer recovery was blocked by active work');
          }
          return;
        }
        if (lifecycle.state === 'handoff' || lifecycle.state === 'setupPending') {
          const committed = await adoptCommittedSetup(lifecycle);
          if (committed.kind === 'managed') return;
          if (!input.directPeerAvailable) return;
          if (lifecycle.state === 'handoff') await recoverLegacyHandoff(lifecycle);
          else await finishSetup(lifecycle, 'recovery');
          return;
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

function conflictReplacementError(pid: number, reason: string): Error {
  return new Error(`Maka could not replace Runtime Host process ${pid}: ${reason}`);
}

function unsupportedSnapshot(): Extract<
  DesktopLocalRuntimeHostRemoteAccessSnapshot,
  { state: 'unsupported' }
> {
  return {
    state: 'unsupported',
    message: 'This Desktop build does not include Direct peer support',
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
    operator: receipt.operator,
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
  return { peerId: value.peerId };
}

function onSnapshot(sharedAccess: boolean): Extract<
  DesktopLocalRuntimeHostRemoteAccessSnapshot,
  { state: 'on' }
> {
  return {
    state: 'on',
    managedService: true,
    ...(sharedAccess ? { sharedAccess: true } : {}),
  };
}

function enabledResult(
  connectionCode: string,
): Extract<DesktopLocalRuntimeHostRemoteAccessEnableResult, { kind: 'enabled' }> {
  return { kind: 'enabled', connectionCode, snapshot: onSnapshot(true) };
}

async function issueConnectionCode(
  rootPath: string,
  peer: LocalPeerDescriptor,
  client: DesktopRuntimeHostClient,
): Promise<string> {
  return issueRuntimeHostOwnerConnectionCode({
    rootPath,
    name: hostName(),
    principalId: LOCAL_REMOTE_ACCESS_PRINCIPAL_ID,
    expectedPeerId: peer.peerId,
    client,
  });
}

async function readLivePeer(
  client: DesktopRuntimeHostClient,
  configured: LocalPeerDescriptor,
): Promise<HostPeerEndpoint> {
  const endpoint = (await client.status()).peerEndpoint;
  if (!endpoint) {
    throw new Error('Runtime Host Direct peer is not available');
  }
  if (endpoint.lease.peerId !== configured.peerId) {
    throw new Error('Runtime Host Direct peer identity changed');
  }
  return endpoint;
}

async function hasSharedAccess(
  operator: DesktopRuntimeHostLocalOperator,
  target: LocalServiceTarget,
): Promise<boolean> {
  const response = await operator.runAccess({
    operator: target.operator,
    target,
  });
  if (response.kind === 'error') throw new Error(response.error.message);
  if (response.action !== 'list') {
    throw new Error('Runtime Host operator returned an unrelated access result');
  }
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
    value.schemaVersion !== 2 ||
    typeof value.serviceId !== 'string' ||
    !SERVICE_ID_PATTERN.test(value.serviceId) ||
    typeof value.rootId !== 'string' ||
    !ROOT_ID_PATTERN.test(value.rootId) ||
    typeof value.deploymentId !== 'string' ||
    !DEPLOYMENT_ID_PATTERN.test(value.deploymentId) ||
    value.rootPath !== rootPath
  ) {
    throw new Error('Local Runtime Host service receipt is invalid');
  }
  return {
    schemaVersion: 2,
    serviceId: value.serviceId,
    rootPath,
    rootId: value.rootId,
    operator: decodeRuntimeHostOperatorCommand(value.operator),
    deploymentId: value.deploymentId,
  };
}

function requireManaged(lifecycle: LocalServiceLifecycle | undefined): LocalServiceManaged {
  if (lifecycle?.state !== 'managed') {
    throw new Error('Remote access has not been set up on this computer');
  }
  return lifecycle;
}

function requireManagementTarget(
  lifecycle: LocalServiceLifecycle | undefined,
): DesktopRuntimeHostLocalManagementTarget {
  if (!lifecycle || !hasManagedServiceTarget(lifecycle)) {
    throw new Error('This computer does not have a managed Local Runtime Host');
  }
  return lifecycle;
}

function pendingSetup(
  intent: LocalServiceSetupPending | LocalServiceLegacyHandoff,
): LocalServiceSetupPending {
  return {
    schemaVersion: 2,
    state: 'setupPending',
    rootPath: intent.rootPath,
    rootId: intent.rootId,
    coordinationRelays: intent.coordinationRelays,
    allowInterruptActiveTasks: intent.allowInterruptActiveTasks,
  };
}

function managedLifecycle(intent: LocalServiceTarget): LocalServiceManaged {
  return {
    schemaVersion: 2,
    state: 'managed',
    serviceId: intent.serviceId,
    operator: intent.operator,
    rootPath: intent.rootPath,
    rootId: intent.rootId,
    deploymentId: intent.deploymentId,
  };
}

function hasManagedServiceTarget(lifecycle: LocalServiceLifecycle): lifecycle is
  | LocalServiceManaged
  | LocalServicePeerChanging
  | LocalServiceUninstalling {
  return lifecycle.state !== 'handoff' && lifecycle.state !== 'setupPending';
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
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    value.rootPath !== rootPath ||
    value.rootId !== rootId
  ) {
    throw new Error('Local Runtime Host service lifecycle is invalid');
  }
  let record: Record<string, unknown> = value;
  if (record.schemaVersion === 1 && record.state === 'handoff') {
    assertExactKeys(record, [
      'schemaVersion',
      'state',
      'rootPath',
      'rootId',
      'coordinationRelays',
      'allowInterruptActiveTasks',
    ]);
    if (typeof record.allowInterruptActiveTasks !== 'boolean') {
      throw new Error('Local Runtime Host setup intent is invalid');
    }
    return {
      schemaVersion: 1,
      state: 'handoff',
      rootPath,
      rootId,
      coordinationRelays: requireAddresses(record.coordinationRelays),
      allowInterruptActiveTasks: record.allowInterruptActiveTasks,
    };
  }
  let migrated = false;
  if (record.schemaVersion === 1) {
    if (record.state === 'setupPending') {
      record = { ...record, schemaVersion: 2 };
    } else {
      if (typeof record.operatorPath !== 'string') {
        throw new Error('Local Runtime Host service receipt is invalid');
      }
      const { operatorPath, ...legacy } = record;
      record = {
        ...legacy,
        schemaVersion: 2,
        operator: createRuntimeHostLegacyPosixOperatorCommand(operatorPath),
      };
    }
    migrated = true;
  }
  const finish = async <T extends LocalServiceLifecycle>(lifecycle: T): Promise<T> => {
    if (migrated) await writeDocument(path, lifecycle);
    return lifecycle;
  };
  if (record.state === 'setupPending') {
    assertExactKeys(record, [
      'schemaVersion',
      'state',
      'rootPath',
      'rootId',
      'coordinationRelays',
      'allowInterruptActiveTasks',
    ]);
    if (typeof record.allowInterruptActiveTasks !== 'boolean') {
      throw new Error('Local Runtime Host setup intent is invalid');
    }
    return finish({
      schemaVersion: 2,
      state: record.state,
      rootPath,
      rootId,
      coordinationRelays: requireAddresses(record.coordinationRelays),
      allowInterruptActiveTasks: record.allowInterruptActiveTasks,
    });
  }
  const target = requireServiceTarget(record, rootPath);
  const targetKeys = [
    'schemaVersion',
    'state',
    'serviceId',
    'operator',
    'rootPath',
    'rootId',
    'deploymentId',
  ];
  assertExactKeys(
    record,
    record.state === 'managed'
      ? targetKeys
      : record.state === 'peerChanging'
        ? [
            ...targetKeys,
            'peerEnabled',
            'coordinationRelays',
            'allowInterruptActiveTasks',
          ]
        : [
            ...targetKeys,
            'allowInterruptActiveTasks',
          ],
  );
  if (
    record.state !== 'managed' &&
    record.state !== 'peerChanging' &&
    record.state !== 'uninstalling' &&
    record.state !== 'cleanupPending'
  ) {
    throw new Error('Local Runtime Host service lifecycle is invalid');
  }
  if (record.state === 'managed') return finish({ ...target, state: 'managed' });
  if (typeof record.allowInterruptActiveTasks !== 'boolean') {
    throw new Error('Local Runtime Host service intent is invalid');
  }
  if (record.state === 'peerChanging') {
    if (typeof record.peerEnabled !== 'boolean') {
      throw new Error('Local Runtime Host peer intent is invalid');
    }
    return finish({
      ...target,
      state: 'peerChanging',
      peerEnabled: record.peerEnabled,
      coordinationRelays: requireAddresses(record.coordinationRelays),
      allowInterruptActiveTasks: record.allowInterruptActiveTasks,
    });
  }
  return finish({
    ...target,
    state: record.state,
    allowInterruptActiveTasks: record.allowInterruptActiveTasks,
  });
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
    operator: receipt.operator,
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
