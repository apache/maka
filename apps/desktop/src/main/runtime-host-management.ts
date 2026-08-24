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
import {
  RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY,
  runtimeHostAccessCredentialFingerprint,
  type RuntimeHostAccessManagementFrame,
  type RuntimeHostServiceManagementFrame,
} from '@maka/runtime-host/operator';
import type {
  DesktopRuntimeHostAccessSnapshot,
  DesktopRuntimeHostManagementAction,
  DesktopRuntimeHostManagementResponse,
  DesktopRuntimeHostManagementProgress,
} from '../preload/bridge-contract.js';
import type { DesktopRuntimeHostProfileService } from './runtime-host-profile-service.js';
import { sameDesktopRuntimeHostManagedServiceBinding } from './runtime-host-managed-services.js';
import type {
  DesktopRuntimeHostSshCleanupInput,
  DesktopRuntimeHostSshAccessInput,
  DesktopRuntimeHostSshManagementInput,
  DesktopRuntimeHostSshUpdateInput,
  DesktopRuntimeHostSetupPackage,
  RuntimeHostServiceUpdateTerminalFrame,
} from './runtime-host-ssh-terminal.js';

const MANAGEMENT_ACTIONS = new Set<DesktopRuntimeHostManagementAction>([
  'status',
  'start',
  'restart',
  'logs',
  'install',
  'uninstall',
]);

type RuntimeHostAccessCredentialMetadata = Extract<
  RuntimeHostAccessManagementFrame,
  { kind: 'result'; action: 'list' }
>['credentials'][number];

export function createDesktopRuntimeHostManagement(input: {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly profiles: Pick<
    DesktopRuntimeHostProfileService,
    | 'resolveManagedService'
    | 'resolveManagedAccess'
    | 'rotateManagedCredential'
    | 'markManagedServiceUninstalling'
    | 'markManagedServiceCleanupPending'
    | 'clearManagedServiceBinding'
  >;
  readonly runServiceManagement: (
    input: DesktopRuntimeHostSshManagementInput,
  ) => Promise<Exclude<RuntimeHostServiceManagementFrame, { kind: 'progress' }>>;
  readonly runAccessManagement: (
    input: DesktopRuntimeHostSshAccessInput,
  ) => Promise<RuntimeHostAccessManagementFrame>;
  readonly runUpdate: (
    input: DesktopRuntimeHostSshUpdateInput,
    onProgress: (phase: DesktopRuntimeHostManagementProgress['phase']) => void,
  ) => Promise<RuntimeHostServiceUpdateTerminalFrame>;
  readonly resolveUpdatePackage: () => DesktopRuntimeHostSetupPackage;
  readonly currentHostEpoch: (profileId: string) => string | undefined;
  readonly awaitUpdatedConnection: (
    profileId: string,
    expectedHostId: string,
    previousHostEpoch: string | undefined,
    replacementExpected: boolean,
  ) => Promise<void>;
  readonly sendProgress: (progress: DesktopRuntimeHostManagementProgress) => void;
  readonly cleanupManagedDeployment: (
    input: DesktopRuntimeHostSshCleanupInput,
  ) => Promise<void>;
}): { close(): void } {
  const requireProfileId = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
      throw new Error('Runtime Host profile ID is invalid');
    }
    return value;
  };
  const resolveManagedService = async (value: unknown) => {
    const managed = await input.profiles.resolveManagedService(requireProfileId(value));
    if (!managed) throw new Error('This Runtime Host profile is not bound to a managed service');
    return managed;
  };

  const statusRequests = new Map<string, Promise<DesktopRuntimeHostManagementResponse>>();
  const runManagedAction = async (
    profileId: string,
    managementAction: DesktopRuntimeHostManagementAction,
  ): Promise<DesktopRuntimeHostManagementResponse> => {
    const managed = await resolveManagedService(profileId);
    const { profile, service } = managed;
    if (profile.transport.kind !== 'ssh') {
      throw new Error('This Runtime Host profile is not bound to a managed service');
    }
    if (managed.state !== 'active' && managementAction !== 'uninstall') {
      throw new Error('Finish uninstalling this Runtime Host service before managing it');
    }
    const managementInput: DesktopRuntimeHostSshManagementInput = {
      destination: profile.transport.destination,
      ...(profile.transport.sshPort === undefined ? {} : { sshPort: profile.transport.sshPort }),
      operatorPath: service.operatorPath,
      action: managementAction,
      expectedTarget: {
        serviceId: service.id,
        rootPath: service.rootPath,
        rootId: profile.rootId,
      },
      ...(managementAction === 'install'
        ? {
            rootPath: service.rootPath,
            websocketPort: profile.transport.remotePort,
            websocketPath: profile.transport.websocketPath,
          }
        : {}),
    };
    if (managementAction !== 'uninstall') {
      const response = await input.runServiceManagement(managementInput);
      if (response.action !== managementAction) {
        throw new Error('Remote Runtime Host returned a different management action');
      }
      return response.kind === 'result'
        ? {
            ...response,
            action: managementAction,
            accessManagementAvailable:
              response.operatorCapabilities?.includes(
                RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY,
              ) ?? false,
          }
        : { ...response, action: managementAction };
    }

    let pending = managed;
    if (pending.state !== 'cleanup_pending') {
      pending = await input.profiles.markManagedServiceUninstalling(pending);
      const response = await input.runServiceManagement({
        ...managementInput,
        retainManagedDeployment: true,
      });
      if (response.action !== managementAction) {
        throw new Error('Remote Runtime Host returned a different management action');
      }
      if (response.kind === 'error') return { ...response, action: managementAction };
      assertUninstalled(response);
      pending = await input.profiles.markManagedServiceCleanupPending(pending);
    }
    await input.cleanupManagedDeployment({
      destination: managementInput.destination,
      ...(managementInput.sshPort === undefined
        ? {}
        : { sshPort: managementInput.sshPort }),
      operatorPath: managementInput.operatorPath,
      expectedTarget: managementInput.expectedTarget,
    });
    await input.profiles.clearManagedServiceBinding(pending);
    return { kind: 'uninstalled', retainedStateRoot: service.rootPath };
  };
  const run = (
    profileIdValue: unknown,
    action: unknown,
  ): Promise<DesktopRuntimeHostManagementResponse> => {
    if (!MANAGEMENT_ACTIONS.has(action as DesktopRuntimeHostManagementAction)) {
      throw new Error('Runtime Host service management action is invalid');
    }
    const profileId = requireProfileId(profileIdValue);
    const managementAction = action as DesktopRuntimeHostManagementAction;
    if (managementAction !== 'status') return runManagedAction(profileId, managementAction);
    const existing = statusRequests.get(profileId);
    if (existing) return existing;
    const request = runManagedAction(profileId, managementAction);
    statusRequests.set(profileId, request);
    const forget = () => {
      if (statusRequests.get(profileId) === request) statusRequests.delete(profileId);
    };
    void request.then(forget, forget);
    return request;
  };

  const resolveAccess = async (value: unknown) => {
    const profileId = requireProfileId(value);
    const managed = await input.profiles.resolveManagedAccess(profileId);
    if (!managed) {
      throw new Error('This Runtime Host profile does not have managed credential access');
    }
    if (managed.state !== 'active') {
      throw new Error('Finish uninstalling this Runtime Host service before managing access');
    }
    if (managed.profile.transport.kind !== 'ssh') {
      throw new Error('This Runtime Host profile does not have an SSH management channel');
    }
    return {
      managed,
      canRotate: managed.enabled,
      currentCredentialFingerprint: managed.credentialFingerprint,
      target: {
        destination: managed.profile.transport.destination,
        ...(managed.profile.transport.sshPort === undefined
          ? {}
          : { sshPort: managed.profile.transport.sshPort }),
        operatorPath: managed.service.operatorPath,
        rootPath: managed.service.rootPath,
        expectedRootId: managed.profile.rootId,
      },
    };
  };

  const update = async (
    profileIdValue: unknown,
    allowInterruptActiveTasksValue: unknown,
  ): Promise<DesktopRuntimeHostManagementResponse> => {
    if (typeof allowInterruptActiveTasksValue !== 'boolean') {
      throw new Error('Runtime Host update interruption authority is invalid');
    }
    const profileId = requireProfileId(profileIdValue);
    const managed = await resolveManagedService(profileId);
    if (managed.state !== 'active' || managed.profile.transport.kind !== 'ssh') {
      throw new Error('This Runtime Host profile is not available for managed updates');
    }
    const previousHostEpoch = input.currentHostEpoch(profileId);
    const response = await input.runUpdate(
      {
        destination: managed.profile.transport.destination,
        ...(managed.profile.transport.sshPort === undefined
          ? {}
          : { sshPort: managed.profile.transport.sshPort }),
        setupPackage: input.resolveUpdatePackage(),
        expectedTarget: {
          serviceId: managed.service.id,
          rootPath: managed.service.rootPath,
          rootId: managed.profile.rootId,
        },
        ...(allowInterruptActiveTasksValue ? { allowInterruptActiveTasks: true } : {}),
      },
      (phase) => input.sendProgress({ profileId, phase }),
    );
    if (
      response.kind === 'result' &&
      response.update.kind !== 'active_tasks'
    ) {
      try {
        const current = await input.profiles.resolveManagedService(profileId);
        if (!current || !sameDesktopRuntimeHostManagedServiceBinding(current, managed)) {
          throw new Error('Runtime Host profile changed while its service was updating');
        }
        await input.awaitUpdatedConnection(
          profileId,
          managed.profile.rootId,
          previousHostEpoch,
          response.update.kind !== 'already_current',
        );
      } catch (error) {
        return {
          schemaVersion: 1,
          kind: 'error',
          action: 'update',
          error: {
            code: 'desktop_reconnect_failed',
            message:
              'The Runtime Host update completed, but Desktop could not reconnect: ' +
              (error instanceof Error ? error.message : String(error)),
          },
        };
      }
    }
    return response.kind === 'result'
      ? {
          ...response,
          accessManagementAvailable:
            response.operatorCapabilities?.includes(
              RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY,
            ) ?? false,
        }
      : response;
  };

  const accessSnapshot = (
    credentials: Extract<
      RuntimeHostAccessManagementFrame,
      { kind: 'result'; action: 'list' }
    >['credentials'],
    currentFingerprint: string,
    canRotate: boolean,
  ): DesktopRuntimeHostAccessSnapshot => ({
    canRotate,
    credentials: credentials.map((credential) => ({
      credentialId: credential.credentialId,
      principalKind: credential.principalKind,
      principalId: credential.principalId,
      status: credential.status,
      createdAt: credential.createdAt,
      ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
      isCurrentDesktop: credential.credentialFingerprint === currentFingerprint,
    })),
  });

  const listCredentials = async (
    profileId: unknown,
  ): Promise<DesktopRuntimeHostAccessSnapshot> => {
    const access = await resolveAccess(profileId);
    const response = await input.runAccessManagement({
      ...access.target,
      action: 'list',
    });
    if (response.kind === 'error') throw new Error(response.error.message);
    if (response.action !== 'list') {
      throw new Error('Remote Runtime Host did not return its access credentials');
    }
    return accessSnapshot(
      response.credentials,
      access.currentCredentialFingerprint,
      access.canRotate,
    );
  };

  const rotateCredential = async (
    profileId: unknown,
  ): Promise<DesktopRuntimeHostAccessSnapshot> => {
    const access = await resolveAccess(profileId);
    if (!access.canRotate) {
      throw new Error('Enable this Runtime Host before rotating its access credential');
    }
    const response = await input.runAccessManagement({
      ...access.target,
      action: 'prepare',
      currentCredentialFingerprint: access.currentCredentialFingerprint,
    });
    if (response.kind === 'error') throw new Error(response.error.message);
    if (response.action !== 'prepare') {
      throw new Error('Remote Runtime Host did not prepare a replacement credential');
    }
    const replacementFingerprint = runtimeHostAccessCredentialFingerprint(response.credential);
    const current = response.credentials.find(
      (credential) =>
        credential.credentialFingerprint === access.currentCredentialFingerprint,
    );
    const replacement = response.credentials.find(
      (credential) => credential.credentialFingerprint === replacementFingerprint,
    );
    if (
      !current ||
      current.status !== 'active' ||
      current.principalKind !== 'remote_owner' ||
      !current.canPublishClientCapabilities ||
      current.canUseHostPaths ||
      !replacement ||
      replacement.status !== 'pending' ||
      !sameCredentialAuthority(current, replacement)
    ) {
      throw new Error('Remote Runtime Host returned an invalid Desktop credential replacement');
    }
    await input.profiles.rotateManagedCredential(access.managed, response.credential);
    const finalized = response.credentials.flatMap((credential) => {
      if (credential.credentialId === replacement.credentialId) {
        const { expiresAt: _expiresAt, ...active } = credential;
        return [{ ...active, status: 'active' as const }];
      }
      return credential.status === 'active' &&
        credential.principalKind === replacement.principalKind &&
        credential.principalId === replacement.principalId
        ? []
        : [credential];
    });
    return accessSnapshot(finalized, replacementFingerprint, true);
  };

  const revokeCredential = async (
    profileId: unknown,
    credentialId: unknown,
  ): Promise<DesktopRuntimeHostAccessSnapshot> => {
    if (typeof credentialId !== 'string' || credentialId.length === 0 || credentialId.length > 128) {
      throw new Error('Runtime Host access credential ID is invalid');
    }
    const access = await resolveAccess(profileId);
    const response = await input.runAccessManagement({
      ...access.target,
      action: 'revoke',
      credentialId,
      currentCredentialFingerprint: access.currentCredentialFingerprint,
    });
    if (response.kind === 'error') throw new Error(response.error.message);
    if (response.action !== 'revoke') {
      throw new Error('Remote Runtime Host did not confirm credential revocation');
    }
    return accessSnapshot(
      response.credentials,
      access.currentCredentialFingerprint,
      access.canRotate,
    );
  };

  const channels = [
    'runtime-host-management:run',
    'runtime-host-management:update',
    'runtime-host-management:list-credentials',
    'runtime-host-management:rotate-credential',
    'runtime-host-management:revoke-credential',
  ] as const;
  input.ipcMain.handle(channels[0], (_event, profileId: unknown, action: unknown) =>
    run(profileId, action));
  input.ipcMain.handle(
    channels[1],
    (_event, profileId: unknown, allowInterruptActiveTasks: unknown) =>
      update(profileId, allowInterruptActiveTasks),
  );
  input.ipcMain.handle(channels[2], (_event, profileId: unknown) =>
    listCredentials(profileId));
  input.ipcMain.handle(channels[3], (_event, profileId: unknown) =>
    rotateCredential(profileId));
  input.ipcMain.handle(
    channels[4],
    (_event, profileId: unknown, credentialId: unknown) =>
      revokeCredential(profileId, credentialId),
  );

  return {
    close() {
      for (const channel of channels) input.ipcMain.removeHandler(channel);
    },
  };
}

function sameCredentialAuthority(
  current: RuntimeHostAccessCredentialMetadata,
  replacement: RuntimeHostAccessCredentialMetadata,
): boolean {
  return (
    current.principalKind === replacement.principalKind &&
    current.principalId === replacement.principalId &&
    current.canPublishClientCapabilities === replacement.canPublishClientCapabilities &&
    current.canUseHostPaths === replacement.canUseHostPaths &&
    current.operationGrants.length === replacement.operationGrants.length &&
    current.operationGrants.every((grant) => replacement.operationGrants.includes(grant))
  );
}

function assertUninstalled(
  frame: Extract<RuntimeHostServiceManagementFrame, { kind: 'result' }>,
): void {
  if (frame.action !== 'uninstall' || frame.service.state !== 'not_installed') {
    throw new Error('Remote Runtime Host service did not confirm a completed uninstall');
  }
}
