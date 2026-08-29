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
import { projectPeerMeshStatus } from '@maka/runtime-host/server';
import type {
  DesktopRuntimeHostPeerMeshTarget,
} from '../preload/bridge-contract.js';
import type { DesktopRuntimeHostProfileService } from './runtime-host-profile-service.js';
import type {
  DesktopRuntimeHostSshPeerMeshManagementInput,
  createDesktopRuntimeHostSshTerminal,
} from './runtime-host-ssh-terminal.js';

type SshTerminal = ReturnType<typeof createDesktopRuntimeHostSshTerminal>;
type PeerMeshAction = DesktopRuntimeHostSshPeerMeshManagementInput['action'];

export function createDesktopRuntimeHostPeerMeshManagement(input: {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly localMesh?: () => PeerMeshNode | undefined;
  readonly profiles: Pick<DesktopRuntimeHostProfileService, 'resolveManagedService'>;
  readonly runRemote: SshTerminal['runPeerMeshManagement'];
}): { close(): void } {
  const execute = async (
    targetValue: unknown,
    actionValue: unknown,
    meshIdValue?: unknown,
    peerIdValue?: unknown,
    invitationValue?: unknown,
  ): Promise<PeerMeshQueryResult | PeerMeshInvitationResult> => {
    const target = requireTarget(targetValue);
    const action = requireAction(actionValue);
    const meshId = actionNeedsMesh(action) ? requireIdentifier(meshIdValue, 'Mesh ID') : undefined;
    const peerId = action === 'remove' ? requireIdentifier(peerIdValue, 'Peer ID') : undefined;
    const invitation = action === 'join' ? requireInvitation(invitationValue) : undefined;
    if (target.kind === 'desktop') {
      return executeLocal(input.localMesh?.(), action, meshId, peerId, invitation);
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
    const response = await input.runRemote({
      destination: managed.profile.transport.destination,
      ...(managed.profile.transport.sshPort === undefined
        ? {}
        : { sshPort: managed.profile.transport.sshPort }),
      operatorPath: managed.control.operatorPath,
      action,
      expectedTarget: {
        serviceId: managed.deployment.id,
        rootPath: managed.deployment.rootPath,
        rootId: managed.profile.rootId,
        deploymentId: managed.deployment.deploymentId,
      },
      ...(meshId ? { meshId } : {}),
      ...(peerId ? { peerId } : {}),
      ...(invitation ? { invitation: JSON.stringify(invitation) } : {}),
    });
    if (response.kind === 'error') throw new Error(response.error.message);
    if (response.action !== action) throw new Error('Runtime Host returned an unrelated Mesh result');
    return response.result;
  };

  const channel = 'runtime-host-peer-mesh:execute';
  input.ipcMain.handle(
    channel,
    (_event, target, action, meshId, peerId, invitation) =>
      execute(target, action, meshId, peerId, invitation),
  );
  return { close: () => input.ipcMain.removeHandler(channel) };
}

async function executeLocal(
  mesh: PeerMeshNode | undefined,
  action: PeerMeshAction,
  meshId: string | undefined,
  peerId: string | undefined,
  invitation: ReturnType<typeof decodePeerMeshInvitation> | undefined,
): Promise<PeerMeshQueryResult | PeerMeshInvitationResult> {
  if (!mesh) {
    if (action === 'status') return { available: false, meshes: [] };
    throw new Error('This Desktop build does not include Direct peer support');
  }
  const snapshot = (): PeerMeshQueryResult => ({
    available: true,
    localPeerId: mesh.localPeerId(),
    meshes: mesh.status().map(projectPeerMeshStatus),
  });
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
      await mesh.join(requiredValue(invitation, 'Peer Mesh invitation'));
      return snapshot();
    case 'remove':
      await mesh.remove(requiredValue(meshId, 'Mesh ID'), requiredValue(peerId, 'Peer ID'));
      return snapshot();
    case 'leave':
      await mesh.leave(requiredValue(meshId, 'Mesh ID'));
      return snapshot();
    case 'close':
      await mesh.closeMesh(requiredValue(meshId, 'Mesh ID'));
      return snapshot();
    case 'reconcile':
      await mesh.reconcile();
      return snapshot();
  }
}

function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}

function requireTarget(value: unknown): DesktopRuntimeHostPeerMeshTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Peer Mesh target is invalid');
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'desktop' && Object.keys(record).length === 1) return { kind: 'desktop' };
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

function requireAction(value: unknown): PeerMeshAction {
  if (
    value === 'status' || value === 'create' || value === 'invite' || value === 'join' ||
    value === 'remove' || value === 'leave' || value === 'close' || value === 'reconcile'
  ) return value;
  throw new Error('Peer Mesh action is invalid');
}

function actionNeedsMesh(action: PeerMeshAction): boolean {
  return action === 'invite' || action === 'remove' || action === 'leave' || action === 'close';
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error(`${label} is invalid`);
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
