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

const RECEIPT_FILE = 'runtime-host-local-service.json';
const HANDOFF_FILE = 'runtime-host-local-service-handoff.json';
const SERVICE_ID_PATTERN = /^[a-f0-9]{64}$/u;
const ROOT_ID_PATTERN = /^[a-f0-9]{64}$/u;
const ADDRESS_MAX_BYTES = 2 * 1024;
const ADDRESS_MAX_COUNT = 16;

interface LocalServiceReceipt extends DesktopRuntimeHostLocalServiceTarget {
  readonly schemaVersion: 1;
  readonly operatorPath: string;
}

interface LocalServiceHandoff {
  readonly schemaVersion: 1;
  readonly rootPath: string;
  readonly rootId: string;
  readonly coordinationRelays: readonly string[];
}

interface LocalPeerDescriptor {
  readonly peerId: string;
  readonly routeHints: readonly string[];
  readonly coordinationRelays: readonly string[];
}

type DesktopRuntimeHostLocalOperator = ReturnType<
  typeof createDesktopRuntimeHostLocalOperator
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
  const receiptPath = join(input.clientDataRoot, RECEIPT_FILE);
  const handoffPath = join(input.clientDataRoot, HANDOFF_FILE);
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
        const receipt = await readReceipt(receiptPath, input.rootPath);
        if (!receipt) {
          return (await readHandoff(handoffPath, input.rootPath, input.rootId))
            ? { state: 'unavailable', message: 'Local Runtime Host setup is being recovered' }
            : { state: 'off' };
        }
        const peer = await readPeer(input.operator, receipt);
        return peer ? onSnapshot() : { state: 'off', managedService: true };
      } catch (error) {
        return { state: 'unavailable', message: errorMessage(error) };
      }
    });

  const enable = (value: unknown): Promise<DesktopLocalRuntimeHostRemoteAccessEnableResult> =>
    serialize(async () => {
      const request = requireEnableInput(value);
      if (!supported(input.directPeerAvailable)) throw new Error(unsupportedSnapshot().message);
      let existing = await readReceipt(receiptPath, input.rootPath);
      if (!existing) {
        const interrupted = await readHandoff(handoffPath, input.rootPath, input.rootId);
        if (interrupted) {
          const recovered = await finishHandoff(
            interrupted,
            true,
            request.allowInterruptActiveTasks,
          );
          if (recovered.kind === 'active_tasks') return recovered;
          existing = recovered.receipt;
        }
      }
      if (existing) {
        const currentPeer = await readPeer(input.operator, existing);
        if (
          currentPeer &&
          sameStrings(currentPeer.coordinationRelays, request.coordinationRelays)
        ) {
          return enabledResult(
            await issueConnectionCode(
              input.rootPath,
              existing.rootId,
              currentPeer,
              localClient(input.manager),
            ),
          );
        }
        const manager = requireManager(input.manager);
        const previousHostEpoch = manager.current('local')?.candidate?.client.hostEpoch;
        const response = await manager.runManagedLocalHostChange(() =>
          input.operator.runPeer({
            operatorPath: existing.operatorPath,
            action: 'enable',
            target: existing,
            coordinationRelays: request.coordinationRelays,
          }),
        );
        if (response.kind === 'error') {
          if (response.error.code === 'active_tasks') return { kind: 'active_tasks' };
          throw new Error(response.error.message);
        }
        const peer = requireEnabledPeer(response.status);
        await manager.waitUntilReady('local', previousHostEpoch);
        return enabledResult(
          await issueConnectionCode(input.rootPath, existing.rootId, peer, localClient(input.manager)),
        );
      }

      const handoff: LocalServiceHandoff = {
        schemaVersion: 1,
        rootPath: input.rootPath,
        rootId: input.rootId,
        coordinationRelays: request.coordinationRelays,
      };
      await writeDocument(handoffPath, handoff);
      const completed = await finishHandoff(
        handoff,
        false,
        request.allowInterruptActiveTasks,
      );
      if (completed.kind === 'active_tasks') return completed;
      return enabledResult(
        encodeRuntimeHostOwnerConnectionCode({
          name: hostName(),
          rootId: completed.receipt.rootId,
          transport: { kind: 'libp2p-direct', ...completed.peer },
          credential: completed.credential,
        }),
      );
    });

  const finishHandoff = async (
    handoff: LocalServiceHandoff,
    allowAlreadyManaged: boolean,
    allowInterruptActiveTasks: boolean,
  ): Promise<
    | { readonly kind: 'active_tasks' }
    | {
        readonly kind: 'complete';
        readonly receipt: LocalServiceReceipt;
        readonly peer: LocalPeerDescriptor;
        readonly credential: string;
      }
  > => {
    const setupPackage = await input.resolveSetupPackage(closing.signal);
    const manager = requireManager(input.manager);
    const retirement = await manager.retireOwnedLocalHost(
      allowInterruptActiveTasks ? 'interrupt_active_work' : 'refuse_active_work',
    );
    if (retirement.kind === 'active_tasks') {
      if (!allowAlreadyManaged) await removeDocument(handoffPath);
      return { kind: 'active_tasks' };
    }
    if (retirement.kind === 'not_owned' && !allowAlreadyManaged) {
      await removeDocument(handoffPath);
      throw new Error('The Local Runtime Host is already managed outside this Desktop');
    }
    let receipt: LocalServiceReceipt | undefined;
    try {
      const complete = await input.operator.runSetup(
        {
          setupPackage,
          clientDataRoot: input.clientDataRoot,
          rootPath: handoff.rootPath,
          principalId: `desktop-owner:${randomUUID()}`,
          coordinationRelays: handoff.coordinationRelays,
          signal: closing.signal,
        },
        () => undefined,
      );
      if (
        complete.rootPath !== handoff.rootPath ||
        complete.rootId !== handoff.rootId ||
        !complete.directPeer
      ) {
        throw new Error('Local Runtime Host setup returned an unrelated service');
      }
      receipt = requireReceipt(
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
      await writeDocument(receiptPath, receipt);
      await removeDocument(handoffPath);
      return { kind: 'complete', receipt, peer, credential: complete.credential };
    } catch (error) {
      if (!receipt) throw error;
      try {
        await uninstallExactService(input.operator, receipt);
        await removeDocument(receiptPath);
        await removeDocument(handoffPath);
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
      const receipt = await requireStoredReceipt(receiptPath, input.rootPath);
      const peer = await readPeer(input.operator, receipt);
      if (!peer) throw new Error('Remote access is not enabled on this computer');
      return issueConnectionCode(input.rootPath, receipt.rootId, peer, localClient(input.manager));
    });

  const disable = (): Promise<DesktopLocalRuntimeHostRemoteAccessSnapshot> =>
    serialize(async () => {
      const receipt = await requireStoredReceipt(receiptPath, input.rootPath);
      const response = await requireManager(input.manager).runManagedLocalHostChange(() =>
        input.operator.runPeer({
          operatorPath: receipt.operatorPath,
          action: 'disable',
          target: receipt,
        }),
      );
      if (response.kind === 'error') throw new Error(response.error.message);
      if (response.status.state === 'enabled') {
        throw new Error('Local Runtime Host Direct peer did not disable');
      }
      return { state: 'off', managedService: true };
    });

  const uninstall = (
    value: unknown,
  ): Promise<{ readonly kind: 'active_tasks' | 'uninstalled' }> =>
    serialize(async () => {
      if (!isRecord(value) || typeof value.allowInterruptActiveTasks !== 'boolean') {
        throw new Error('Local Runtime Host uninstall request is invalid');
      }
      const allowInterruptActiveTasks = value.allowInterruptActiveTasks;
      const receipt = await requireStoredReceipt(receiptPath, input.rootPath);
      return requireManager(input.manager).runManagedLocalHostChange(async () => {
        const retired = await input.operator.runService({
          operatorPath: receipt.operatorPath,
          action: 'retire',
          target: receipt,
          allowInterruptActiveTasks,
        });
        if (retired.kind === 'error') throw new Error(retired.error.message);
        if (retired.action !== 'retire') {
          throw new Error('Local Runtime Host returned an unrelated service result');
        }
        if (retired.retirement.kind === 'active_tasks') return { kind: 'active_tasks' };
        const removed = await input.operator.runService({
          operatorPath: receipt.operatorPath,
          action: 'uninstall',
          target: receipt,
        });
        if (removed.kind === 'error') throw new Error(removed.error.message);
        if (removed.action !== 'uninstall' || removed.service.state !== 'not_installed') {
          throw new Error('Local Runtime Host service was not cleanly uninstalled');
        }
        await removeDocument(receiptPath);
        return { kind: 'uninstalled' };
      });
    });

  const channels = [
    'local-runtime-host-remote-access:get-snapshot',
    'local-runtime-host-remote-access:enable',
    'local-runtime-host-remote-access:create-connection-code',
    'local-runtime-host-remote-access:disable',
    'local-runtime-host-remote-access:uninstall',
  ] as const;
  input.ipcMain.handle(channels[0], getSnapshot);
  input.ipcMain.handle(channels[1], (_event, value: unknown) => enable(value));
  input.ipcMain.handle(channels[2], createConnectionCode);
  input.ipcMain.handle(channels[3], disable);
  input.ipcMain.handle(channels[4], (_event, value: unknown) => uninstall(value));

  return {
    recover: () =>
      serialize(async () => {
        if (!supported(input.directPeerAvailable)) return;
        if (await readReceipt(receiptPath, input.rootPath)) {
          await removeDocument(handoffPath);
          return;
        }
        const handoff = await readHandoff(handoffPath, input.rootPath, input.rootId);
        if (!handoff) return;
        await finishHandoff(handoff, true, false);
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
  receipt: LocalServiceReceipt,
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

function onSnapshot(): Extract<
  DesktopLocalRuntimeHostRemoteAccessSnapshot,
  { state: 'on' }
> {
  return { state: 'on' };
}

function enabledResult(
  connectionCode: string,
): Extract<DesktopLocalRuntimeHostRemoteAccessEnableResult, { kind: 'enabled' }> {
  return { kind: 'enabled', connectionCode, snapshot: onSnapshot() };
}

async function issueConnectionCode(
  rootPath: string,
  rootId: string,
  peer: LocalPeerDescriptor,
  client: DesktopRuntimeHostClient,
): Promise<string> {
  const prepared = await client.request('access.credential.prepare', {
    principalKind: 'remote_owner',
    principalId: `desktop-owner:${randomUUID()}`,
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

async function requireStoredReceipt(path: string, rootPath: string): Promise<LocalServiceReceipt> {
  const receipt = await readReceipt(path, rootPath);
  if (!receipt) throw new Error('Remote access has not been set up on this computer');
  return receipt;
}

async function readReceipt(path: string, rootPath: string): Promise<LocalServiceReceipt | undefined> {
  try {
    return requireReceipt(JSON.parse(await readFile(path, 'utf8')) as unknown, rootPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function requireReceipt(value: unknown, rootPath: string): LocalServiceReceipt {
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

async function readHandoff(
  path: string,
  rootPath: string,
  rootId: string,
): Promise<LocalServiceHandoff | undefined> {
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
    value.rootId !== rootId ||
    Object.keys(value).some(
      (key) => !['schemaVersion', 'rootPath', 'rootId', 'coordinationRelays'].includes(key),
    )
  ) {
    throw new Error('Local Runtime Host handoff journal is invalid');
  }
  return {
    schemaVersion: 1,
    rootPath,
    rootId,
    coordinationRelays: requireAddresses(value.coordinationRelays),
  };
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
  receipt: LocalServiceReceipt,
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
