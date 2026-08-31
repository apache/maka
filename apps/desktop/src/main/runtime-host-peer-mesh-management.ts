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

import type { IpcMain } from 'electron';
import type { PeerMeshNode } from '@maka/runtime-host/peer-mesh';
import {
  decodePeerMeshInvitation,
  type PeerMeshInvitationResult,
  type PeerMeshQueryResult,
} from '@maka/runtime-host/protocol';
import { projectPeerMeshQuery } from '@maka/runtime-host/server';
import type {
  DesktopRuntimeHostPeerMeshTarget,
} from '../preload/bridge-contract.js';
import type { DesktopRuntimeHostProfileService } from './runtime-host-profile-service.js';
import type {
  DesktopRuntimeHostSshPeerMeshManagementInput,
  createDesktopRuntimeHostSshTerminal,
} from './runtime-host-ssh-terminal.js';
import type { createDesktopRuntimeHostLocalOperator } from './runtime-host-local-operator.js';
import type {
  DesktopRuntimeHostLocalManagementTarget,
  DesktopLocalRuntimeHostRemoteAccess,
} from './runtime-host-local-remote-access.js';

type SshTerminal = ReturnType<typeof createDesktopRuntimeHostSshTerminal>;
type LocalOperator = ReturnType<typeof createDesktopRuntimeHostLocalOperator>;
type PeerMeshAction = DesktopRuntimeHostSshPeerMeshManagementInput['action'];
type PeerMeshResult = PeerMeshQueryResult | PeerMeshInvitationResult;

interface ManagedPeerMeshCommand {
  readonly action: PeerMeshAction;
  readonly meshId?: string | null;
  readonly peerId?: string;
  readonly invitation?: string;
  readonly displayName?: string | null;
  readonly signal?: AbortSignal;
}

type RunManagedPeerMeshCommand = (command: ManagedPeerMeshCommand) => Promise<PeerMeshResult>;

export function createDesktopRuntimeHostPeerMeshManagement(input: {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly localMesh?: () => PeerMeshNode | undefined;
  readonly localHost: Pick<DesktopLocalRuntimeHostRemoteAccess, 'getSnapshot' | 'inspectManaged'>;
  readonly runLocal: LocalOperator['runPeerMesh'];
  readonly profiles: Pick<DesktopRuntimeHostProfileService, 'resolveManagedService'>;
  readonly runRemote: SshTerminal['runPeerMeshManagement'];
}): { close(): void } {
  const activeOperations = new Map<string, AbortController>();
  const execute = async (
    targetValue: unknown,
    actionValue: unknown,
    meshIdValue?: unknown,
    peerIdValue?: unknown,
    invitationValue?: unknown,
    displayNameValue?: unknown,
    signal?: AbortSignal,
  ): Promise<PeerMeshQueryResult | PeerMeshInvitationResult> => {
    const target = requireTarget(targetValue);
    const action = requireAction(actionValue);
    const meshId =
      action === 'transit' && meshIdValue === null
        ? null
        : actionNeedsMesh(action)
          ? requireIdentifier(meshIdValue, 'Mesh ID')
          : undefined;
    const peerId = action === 'remove' ? requireIdentifier(peerIdValue, 'Peer ID') : undefined;
    const invitation = action === 'join' ? requireInvitation(invitationValue) : undefined;
    const displayName =
      action === 'rename' || action === 'rename-mesh'
        ? requireDisplayName(displayNameValue)
        : undefined;
    if (target.kind === 'desktop') {
      if (action === 'reconcile') {
        return reconcileDesktopTarget(
          input.localMesh?.(),
          input.localHost,
          input.runLocal,
          signal,
        );
      }
      return executeLocal(
        input.localMesh?.(),
        action,
        meshId,
        peerId,
        invitation,
        displayName,
        signal,
      );
    }
    if (target.kind === 'local_host') {
      return input.localHost.inspectManaged(async (managed) => {
        const run: RunManagedPeerMeshCommand = async (command) => {
          const response = await input.runLocal({
            operatorPath: managed.operatorPath,
            target: managedTarget(managed),
            ...command,
            signal: command.signal,
          });
          if (response.kind === 'error') throw new Error(response.error.message);
          return response.result;
        };
        if (action === 'reconcile') return reconcileManagedTarget(input.localMesh?.(), run, signal);
        return run({
          action,
          ...(meshId !== undefined ? { meshId } : {}),
          ...(peerId ? { peerId } : {}),
          ...(invitation ? { invitation: JSON.stringify(invitation) } : {}),
          ...(displayName !== undefined ? { displayName } : {}),
          signal,
        });
      });
    }
    const managed = await input.profiles.resolveManagedService(target.profileId);
    if (
      !managed ||
      managed.state !== 'active' ||
      managed.profile.transport.kind !== 'ssh' ||
      !managed.deployment.deploymentId
    ) {
      throw new Error('This Runtime Host does not have an active SSH management channel');
    }
    const transport = managed.profile.transport;
    const run: RunManagedPeerMeshCommand = async (command) => {
      const response = await input.runRemote({
        destination: transport.destination,
        ...(transport.sshPort === undefined ? {} : { sshPort: transport.sshPort }),
        operatorPath: managed.control.operatorPath,
        expectedTarget: {
          serviceId: managed.deployment.id,
          rootPath: managed.deployment.rootPath,
          rootId: managed.profile.rootId,
          deploymentId: managed.deployment.deploymentId,
        },
        ...command,
        signal: command.signal,
      });
      if (response.kind === 'error') throw new Error(response.error.message);
      if (response.action !== command.action) {
        throw new Error('Runtime Host returned an unrelated Mesh result');
      }
      return response.result;
    };
    if (action === 'reconcile') return reconcileManagedTarget(input.localMesh?.(), run, signal);
    return run({
      action,
      ...(meshId !== undefined ? { meshId } : {}),
      ...(peerId ? { peerId } : {}),
      ...(invitation ? { invitation: JSON.stringify(invitation) } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      signal,
    });
  };

  const channel = 'runtime-host-peer-mesh:execute';
  input.ipcMain.handle(
    channel,
    async (_event, target, action, meshId, peerId, invitation, displayName, operationIdValue) => {
      const operationId = requireOperationId(operationIdValue);
      if (!operationId) {
        return execute(target, action, meshId, peerId, invitation, displayName);
      }
      const controller = new AbortController();
      if (activeOperations.has(operationId)) throw new Error('Peer Mesh operation is already active');
      activeOperations.set(operationId, controller);
      try {
        return await execute(
          target,
          action,
          meshId,
          peerId,
          invitation,
          displayName,
          controller.signal,
        );
      } finally {
        activeOperations.delete(operationId);
      }
    },
  );
  const cancelChannel = 'runtime-host-peer-mesh:cancel';
  input.ipcMain.handle(cancelChannel, (_event, operationIdValue) => {
    const operationId = requireOperationId(operationIdValue, true);
    if (!operationId) throw new Error('Peer Mesh operation ID is required');
    activeOperations.get(operationId)?.abort(new Error('Peer Mesh operation was cancelled'));
  });
  return {
    close: () => {
      for (const controller of activeOperations.values()) {
        controller.abort(new Error('Peer Mesh management closed'));
      }
      activeOperations.clear();
      input.ipcMain.removeHandler(channel);
      input.ipcMain.removeHandler(cancelChannel);
    },
  };
}

async function reconcileDesktopTarget(
  desktopMesh: PeerMeshNode | undefined,
  localHost: Pick<DesktopLocalRuntimeHostRemoteAccess, 'getSnapshot' | 'inspectManaged'>,
  runLocal: LocalOperator['runPeerMesh'],
  signal?: AbortSignal,
): Promise<PeerMeshQueryResult> {
  if (!desktopMesh) throw new Error('This Desktop build does not include Direct peer support');
  const failures: unknown[] = [];
  const localSnapshot = await localHost.getSnapshot();
  if (localSnapshot.state === 'on') {
    await localHost.inspectManaged(async (managed) => {
      const run: RunManagedPeerMeshCommand = async (command) => {
        const response = await runLocal({
          operatorPath: managed.operatorPath,
          target: managedTarget(managed),
          ...command,
        });
        if (response.kind === 'error') throw new Error(response.error.message);
        return response.result;
      };
      await reconcileManagedTarget(desktopMesh, run, signal);
    }).catch((error) => failures.push(error));
  }
  await desktopMesh.reconcile(signal).catch((error) => failures.push(error));
  if (failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, 'Peer Mesh synchronization failed');
  }
  return projectPeerMeshQuery(desktopMesh);
}

async function reconcileManagedTarget(
  desktopMesh: PeerMeshNode | undefined,
  run: RunManagedPeerMeshCommand,
  signal?: AbortSignal,
): Promise<PeerMeshQueryResult> {
  if (!desktopMesh) return requireQueryResult(await run({ action: 'reconcile', signal }));

  const desktop = projectPeerMeshQuery(desktopMesh);
  const managed = requireQueryResult(await run({ action: 'status', signal }));
  const managedById = new Map(managed.meshes.map((mesh) => [mesh.meshId, mesh]));
  let recovered = false;
  for (const desktopMembership of desktop.meshes) {
    const managedMembership = managedById.get(desktopMembership.meshId);
    if (!managedMembership) continue;
    if (
      desktopMembership.role === 'authority' &&
      managedMembership.role === 'member' &&
      authorityRouteNeedsRecovery(managedMembership)
    ) {
      const invitation = await desktopMesh.invite(desktopMembership.meshId);
      await run({ action: 'join', invitation: JSON.stringify(invitation), signal });
      recovered = true;
      continue;
    }
    if (
      desktopMembership.role === 'member' &&
      managedMembership.role === 'authority' &&
      authorityRouteNeedsRecovery(desktopMembership)
    ) {
      const invited = await run({ action: 'invite', meshId: managedMembership.meshId, signal });
      const invitation = requireInvitationResult(invited).invitation;
      await desktopMesh.join(invitation, signal);
      recovered = true;
    }
  }
  return requireQueryResult(await run({ action: recovered ? 'status' : 'reconcile', signal }));
}

function authorityRouteNeedsRecovery(mesh: PeerMeshQueryResult['meshes'][number]): boolean {
  const authority = mesh.members.find(({ peerId }) => peerId === mesh.authorityPeerId);
  return authority === undefined || authority.state === 'unknown' || authority.state === 'stale';
}

function requireQueryResult(result: PeerMeshResult): PeerMeshQueryResult {
  if ('available' in result) return result;
  throw new Error('Runtime Host returned an unrelated Peer Mesh result');
}

function requireInvitationResult(result: PeerMeshResult): PeerMeshInvitationResult {
  if ('invitation' in result) return result;
  throw new Error('Runtime Host returned an unrelated Peer Mesh result');
}

async function executeLocal(
  mesh: PeerMeshNode | undefined,
  action: PeerMeshAction,
  meshId: string | null | undefined,
  peerId: string | undefined,
  invitation: ReturnType<typeof decodePeerMeshInvitation> | undefined,
  displayName: string | null | undefined,
  signal?: AbortSignal,
): Promise<PeerMeshQueryResult | PeerMeshInvitationResult> {
  if (!mesh) {
    if (action === 'status') return { available: false, meshes: [] };
    throw new Error('This Desktop build does not include Direct peer support');
  }
  const snapshot = (): PeerMeshQueryResult => projectPeerMeshQuery(mesh);
  switch (action) {
    case 'status':
      return snapshot();
    case 'create':
      await mesh.create();
      return snapshot();
    case 'invite': {
      const created = await mesh.invite(requiredValue(meshId, 'Mesh ID'));
      return { invitation: created, snapshot: snapshot() };
    }
    case 'join':
      await mesh.join(requiredValue(invitation, 'Peer Mesh invitation'), signal);
      return snapshot();
    case 'remove':
      await mesh.remove(requiredValue(meshId, 'Mesh ID'), requiredValue(peerId, 'Peer ID'));
      return snapshot();
    case 'leave':
      await mesh.leave(requiredValue(meshId, 'Mesh ID'), signal);
      return snapshot();
    case 'close':
      await mesh.closeMesh(requiredValue(meshId, 'Mesh ID'));
      return snapshot();
    case 'reconcile':
      await mesh.reconcile(signal);
      return snapshot();
    case 'transit':
      await mesh.setTransitMesh(meshId ?? null);
      return snapshot();
    case 'rename':
      await mesh.setDisplayName(requiredDisplayName(displayName));
      return snapshot();
    case 'rename-mesh':
      await mesh.setMeshDisplayName(
        requiredValue(meshId, 'Mesh ID'),
        requiredDisplayName(displayName),
      );
      return snapshot();
  }
}

function requiredDisplayName(value: string | null | undefined): string | null {
  if (value === undefined) throw new Error('Display name is required');
  return value;
}

function requireDisplayName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('Peer Mesh display name is invalid');
  return value;
}

function requiredValue<T>(value: T | null | undefined, label: string): NonNullable<T> {
  if (value === undefined || value === null) throw new Error(`${label} is required`);
  return value;
}

function requireTarget(value: unknown): DesktopRuntimeHostPeerMeshTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Peer Mesh target is invalid');
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'desktop' && Object.keys(record).length === 1) return { kind: 'desktop' };
  if (record.kind === 'local_host' && Object.keys(record).length === 1) {
    return { kind: 'local_host' };
  }
  if (
    record.kind === 'managed_host' &&
    Object.keys(record).length === 2 &&
    typeof record.profileId === 'string' &&
    record.profileId.length > 0 &&
    record.profileId.length <= 128
  ) {
    return { kind: 'managed_host', profileId: record.profileId };
  }
  throw new Error('Peer Mesh target is invalid');
}

function managedTarget(
  target: DesktopRuntimeHostLocalManagementTarget,
): Omit<DesktopRuntimeHostLocalManagementTarget, 'operatorPath'> {
  return {
    serviceId: target.serviceId,
    rootPath: target.rootPath,
    rootId: target.rootId,
    deploymentId: target.deploymentId,
  };
}

function requireAction(value: unknown): PeerMeshAction {
  if (
    value === 'status' || value === 'create' || value === 'invite' || value === 'join' ||
    value === 'remove' ||
    value === 'leave' ||
    value === 'close' ||
    value === 'reconcile' ||
    value === 'transit' ||
    value === 'rename' ||
    value === 'rename-mesh'
  ) return value;
  throw new Error('Peer Mesh action is invalid');
}

function actionNeedsMesh(action: PeerMeshAction): boolean {
  return (
    action === 'invite' ||
    action === 'remove' ||
    action === 'leave' ||
    action === 'close' ||
    action === 'transit' ||
    action === 'rename-mesh'
  );
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireOperationId(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error('Peer Mesh operation ID is invalid');
  }
  return value;
}

function requireInvitation(value: unknown): ReturnType<typeof decodePeerMeshInvitation> {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 128 * 1024) {
    throw new Error('Peer Mesh invitation is invalid');
  }
  try {
    return decodePeerMeshInvitation(JSON.parse(value) as unknown);
  } catch {
    throw new Error('Peer Mesh invitation is invalid');
  }
}
