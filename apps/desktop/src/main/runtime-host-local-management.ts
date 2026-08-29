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

import type {
  RuntimeHostManagedUpdatePolicy,
  RuntimeHostServiceManagementFrame,
} from '@maka/runtime-host/operator';
import type {
  DesktopRuntimeHostDirectPeerSnapshot,
  DesktopRuntimeHostManagementAction,
  DesktopRuntimeHostManagementProgress,
  DesktopRuntimeHostManagementResponse,
  DesktopRuntimeHostUpdatePolicySnapshot,
  DesktopRuntimeHostUpdateReconciliationResponse,
} from '../preload/bridge-contract.js';
import type { DesktopLocalRuntimeHostRemoteAccess } from './runtime-host-local-remote-access.js';
import type { createDesktopRuntimeHostLocalOperator } from './runtime-host-local-operator.js';
import type { DesktopRuntimeHostManagementProvider } from './runtime-host-management-provider.js';
import type { DesktopRuntimeHostSetupPackage } from './runtime-host-setup-package.js';

type LocalOperator = ReturnType<typeof createDesktopRuntimeHostLocalOperator>;

export function createDesktopRuntimeHostLocalManagement(input: {
  readonly remoteAccess: DesktopLocalRuntimeHostRemoteAccess;
  readonly operator: LocalOperator;
  readonly rootPath: string;
  readonly resolveUpdatePackage: () =>
    | DesktopRuntimeHostSetupPackage
    | Promise<DesktopRuntimeHostSetupPackage>;
  readonly currentHostEpoch: () => string | undefined;
  readonly awaitUpdatedConnection: (
    previousHostEpoch: string | undefined,
    replacementExpected: boolean,
  ) => Promise<void>;
  readonly sendProgress: (progress: DesktopRuntimeHostManagementProgress) => void;
}): DesktopRuntimeHostManagementProvider {
  const withAccessFlag = (
    frame: Exclude<RuntimeHostServiceManagementFrame, { kind: 'progress' }>,
  ): DesktopRuntimeHostManagementResponse => {
    if (
      frame.action !== 'status' &&
      frame.action !== 'start' &&
      frame.action !== 'restart' &&
      frame.action !== 'logs' &&
      frame.action !== 'install' &&
      frame.action !== 'uninstall' &&
      frame.action !== 'configure' &&
      frame.action !== 'update'
    ) {
      throw new Error('Local Runtime Host returned an unrelated management result');
    }
    return (frame.kind === 'result'
      ? { ...frame, accessManagementAvailable: false }
      : frame) as DesktopRuntimeHostManagementResponse;
  };

  const activeTasks = (
    action: DesktopRuntimeHostManagementAction | 'configure' | 'update',
  ): DesktopRuntimeHostManagementResponse => ({
    schemaVersion: 1,
    kind: 'error',
    action,
    error: {
      code: 'active_tasks',
      message: 'Runtime Host still owns active work',
    },
  });

  const runService = async (
    action: Exclude<DesktopRuntimeHostManagementAction, 'uninstall'>,
  ): Promise<DesktopRuntimeHostManagementResponse> => {
    const changed = await input.remoteAccess.manage(
      action === 'status' || action === 'logs' ? undefined : false,
      (target) => input.operator.runService({
        operatorPath: target.operatorPath,
        action,
        target,
      }),
    );
    if (changed.kind === 'active_tasks') return activeTasks(action);
    const frame = requireTerminalFrame(changed.value, action);
    return withAccessFlag(frame);
  };

  const reconnect = async (
    response: DesktopRuntimeHostManagementResponse,
    previousHostEpoch: string | undefined,
    replacementExpected: boolean,
  ): Promise<DesktopRuntimeHostManagementResponse> => {
    if (response.kind !== 'result') return response;
    try {
      await input.awaitUpdatedConnection(previousHostEpoch, replacementExpected);
      return response;
    } catch (error) {
      return {
        ...response,
        reconnectError: {
          code: 'desktop_reconnect_failed',
          message:
            'The Runtime Host change was applied, but Desktop could not reconnect: ' +
            (error instanceof Error ? error.message : String(error)),
        },
      };
    }
  };

  const updatePolicy = async (
    policy?: RuntimeHostManagedUpdatePolicy,
  ): Promise<DesktopRuntimeHostUpdatePolicySnapshot> => {
    const managed = await input.remoteAccess.manage(undefined, async (target) => {
      if (policy && policy.kind !== 'manual') {
        const current = requireTerminalFrame(
          await input.operator.runUpdatePolicy({
            operatorPath: target.operatorPath,
            target,
          }),
          'update_policy',
        );
        if (current.kind === 'error') throw new Error(current.error.message);
        if (current.updateSchedulerState === undefined) {
          throw new Error('Update or repair this Runtime Host before enabling automatic updates');
        }
      }
      return requireTerminalFrame(
        await input.operator.runUpdatePolicy({
          operatorPath: target.operatorPath,
          target,
          ...(policy ? { policy } : {}),
        }),
        'update_policy',
      );
    });
    if (managed.kind === 'active_tasks') throw new Error('Runtime Host still owns active work');
    if (managed.value.kind === 'error') throw new Error(managed.value.error.message);
    return projectUpdatePolicy(managed.value);
  };

  return {
    profileId: 'local',
    run: async (action, allowInterruptActiveTasks = false) => {
      if (action !== 'uninstall') return runService(action);
      const result = await input.remoteAccess.uninstall({ allowInterruptActiveTasks });
      return result.kind === 'active_tasks'
        ? activeTasks(action)
        : { kind: 'uninstalled', retainedStateRoot: input.rootPath };
    },
    update: async (allowInterruptActiveTasks) => {
      const previousHostEpoch = input.currentHostEpoch();
      input.sendProgress({ profileId: 'local', phase: 'preparing_cli' });
      const setupPackage = await input.resolveUpdatePackage();
      const changed = await input.remoteAccess.manage(
        allowInterruptActiveTasks,
        (target) => input.operator.runUpdate(
          {
            setupPackage,
            target,
            ...(allowInterruptActiveTasks ? { allowInterruptActiveTasks: true } : {}),
          },
          (phase) => input.sendProgress({ profileId: 'local', phase }),
        ),
      );
      if (changed.kind === 'active_tasks') return activeTasks('update');
      const frame = requireTerminalFrame(changed.value, 'update');
      const response = withAccessFlag(frame);
      const replacementExpected =
        frame.kind === 'result' &&
        frame.action === 'update' &&
        frame.update.kind !== 'active_tasks' &&
        frame.update.kind !== 'already_current';
      return replacementExpected
        ? reconnect(response, previousHostEpoch, true)
        : response;
    },
    configureProjectDirectories: async (
      roots,
      expectedConfigFingerprint,
      allowInterruptActiveTasks,
    ) => {
      const previousHostEpoch = input.currentHostEpoch();
      const changed = await input.remoteAccess.manage(
        allowInterruptActiveTasks,
        (target) => input.operator.runService({
          operatorPath: target.operatorPath,
          action: 'configure',
          target,
          projectDirectoryRoots: roots,
          expectedConfigFingerprint,
          ...(allowInterruptActiveTasks ? { allowInterruptActiveTasks: true } : {}),
        }),
      );
      if (changed.kind === 'active_tasks') return activeTasks('configure');
      const frame = requireTerminalFrame(changed.value, 'configure');
      const response = withAccessFlag(frame);
      return frame.kind === 'result' &&
        frame.action === 'configure' &&
        frame.configuration.kind === 'configured'
        ? reconnect(response, previousHostEpoch, true)
        : response;
    },
    getUpdatePolicy: () => updatePolicy(),
    setUpdatePolicy: (policy) => updatePolicy(policy),
    reconcileUpdate: async (): Promise<DesktopRuntimeHostUpdateReconciliationResponse> => {
      const previousHostEpoch = input.currentHostEpoch();
      const changed = await input.remoteAccess.manage(false, (target) =>
        input.operator.runUpdateReconciliation(
          { operatorPath: target.operatorPath, target },
          (phase) => input.sendProgress({ profileId: 'local', phase }),
        ));
      if (changed.kind === 'active_tasks') {
        return {
          kind: 'error',
          error: { code: 'active_tasks', message: 'Runtime Host still owns active work' },
        };
      }
      const frame = requireTerminalFrame(changed.value, 'reconcile_update');
      if (frame.kind === 'error') return { kind: 'error', error: frame.error };
      const response: DesktopRuntimeHostUpdateReconciliationResponse = {
        kind: 'result',
        updatePolicy: projectUpdatePolicy(frame),
        reconciliation: frame.reconciliation,
        ...(frame.service ? { service: frame.service } : {}),
      };
      if (
        frame.reconciliation.kind !== 'updated' &&
        frame.reconciliation.kind !== 'repaired'
      ) {
        return response;
      }
      try {
        await input.awaitUpdatedConnection(previousHostEpoch, true);
        return response;
      } catch (error) {
        return {
          ...response,
          reconnectError: {
            code: 'desktop_reconnect_failed',
            message:
              'The Runtime Host change was applied, but Desktop could not reconnect: ' +
              (error instanceof Error ? error.message : String(error)),
          },
        };
      }
    },
    getDirectPeer: async (): Promise<DesktopRuntimeHostDirectPeerSnapshot> => {
      const snapshot = await input.remoteAccess.getSnapshot();
      return {
        state:
          snapshot.state === 'on'
            ? 'enabled'
            : snapshot.state === 'off' && snapshot.managedService
              ? 'disabled'
              : 'unsupported',
        routeHints: [],
        coordinationRelays: [],
        automaticRelayDiscovery: false,
        profilePresent: true,
        profileEnabled: false,
        clientAvailable: false,
        managementAvailable: false,
      };
    },
    configureDirectPeer: async () => {
      throw new Error('Manage access to this computer from the Remote access controls');
    },
    listCredentials: async () => {
      throw new Error('Manage access to this computer from the Remote access controls');
    },
    rotateCredential: async () => {
      throw new Error('The Local Runtime Host does not use a remote profile credential');
    },
    revokeCredential: async () => {
      throw new Error('Manage access to this computer from the Remote access controls');
    },
  };
}

function requireTerminalFrame<Action extends RuntimeHostServiceManagementFrame['action']>(
  frame: RuntimeHostServiceManagementFrame,
  action: Action,
): Exclude<RuntimeHostServiceManagementFrame, { kind: 'progress' }> & { readonly action: Action } {
  if (frame.kind === 'progress' || frame.action !== action) {
    throw new Error('Local Runtime Host returned an unrelated management result');
  }
  return frame as Exclude<RuntimeHostServiceManagementFrame, { kind: 'progress' }> & {
    readonly action: Action;
  };
}

function projectUpdatePolicy(
  frame: Extract<RuntimeHostServiceManagementFrame, {
    readonly kind: 'result';
    readonly action: 'update_policy' | 'reconcile_update';
  }>,
): DesktopRuntimeHostUpdatePolicySnapshot {
  if (frame.updateSchedulerState === undefined) {
    return { ...frame.updatePolicy, schedulingState: 'unsupported' };
  }
  return { ...frame.updatePolicy, schedulingState: frame.updateSchedulerState };
}
