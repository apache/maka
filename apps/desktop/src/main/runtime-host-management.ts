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
import type { RuntimeHostServiceManagementFrame } from '@maka/runtime-host/operator';
import type {
  DesktopRuntimeHostManagementAction,
  DesktopRuntimeHostManagementResponse,
} from '../preload/bridge-contract.js';
import type { DesktopRuntimeHostProfileService } from './runtime-host-profile-service.js';
import type {
  DesktopRuntimeHostSshCleanupInput,
  DesktopRuntimeHostSshManagementInput,
} from './runtime-host-ssh-terminal.js';

const MANAGEMENT_ACTIONS = new Set<DesktopRuntimeHostManagementAction>([
  'status',
  'start',
  'restart',
  'logs',
  'install',
  'uninstall',
]);

export function createDesktopRuntimeHostManagement(input: {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly profiles: Pick<
    DesktopRuntimeHostProfileService,
    | 'resolveManagedService'
    | 'markManagedServiceUninstalling'
    | 'clearManagedServiceBinding'
  >;
  readonly runServiceManagement: (
    input: DesktopRuntimeHostSshManagementInput,
  ) => Promise<RuntimeHostServiceManagementFrame>;
  readonly cleanupManagedDeployment: (
    input: DesktopRuntimeHostSshCleanupInput,
  ) => Promise<void>;
}): { close(): void } {
  const resolveManagedService = async (value: unknown) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
      throw new Error('Runtime Host profile ID is invalid');
    }
    const managed = await input.profiles.resolveManagedService(value);
    if (!managed) throw new Error('This Runtime Host profile is not bound to a managed service');
    return managed;
  };

  const run = async (
    profileId: unknown,
    action: unknown,
  ): Promise<DesktopRuntimeHostManagementResponse> => {
    if (!MANAGEMENT_ACTIONS.has(action as DesktopRuntimeHostManagementAction)) {
      throw new Error('Runtime Host service management action is invalid');
    }
    const managementAction = action as DesktopRuntimeHostManagementAction;
    const managed = await resolveManagedService(profileId);
    const { profile, service } = managed;
    if (profile.transport.kind !== 'ssh') {
      throw new Error('This Runtime Host profile is not bound to a managed service');
    }
    if (managed.state === 'uninstalling' && managementAction !== 'uninstall') {
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
      return input.runServiceManagement(managementInput);
    }

    let pending = managed;
    if (managed.state === 'active') {
      const response = await input.runServiceManagement({
        ...managementInput,
        retainManagedDeployment: true,
      });
      if (response.kind === 'error') return response;
      assertUninstalled(response);
      pending = await input.profiles.markManagedServiceUninstalling(managed);
    }
    await input.cleanupManagedDeployment({
      destination: managementInput.destination,
      ...(managementInput.sshPort === undefined
        ? {}
        : { sshPort: managementInput.sshPort }),
      operatorPath: managementInput.operatorPath,
    });
    await input.profiles.clearManagedServiceBinding(pending);
    return { kind: 'uninstalled', retainedStateRoot: service.rootPath };
  };

  const channel = 'runtime-host-management:run';
  input.ipcMain.handle(channel, (_event, profileId: unknown, action: unknown) =>
    run(profileId, action));

  return {
    close() {
      input.ipcMain.removeHandler(channel);
    },
  };
}

function assertUninstalled(
  frame: Extract<RuntimeHostServiceManagementFrame, { kind: 'result' }>,
): void {
  if (frame.action !== 'uninstall' || frame.service.state !== 'not_installed') {
    throw new Error('Remote Runtime Host service did not confirm a completed uninstall');
  }
}
