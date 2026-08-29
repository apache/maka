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

import { LOCAL_RUNTIME_HOST_PROFILE } from '@maka/runtime-host/client';
import type { RuntimeHostServiceManagementFrame } from '@maka/runtime-host/operator';
import type {
  DesktopLocalRuntimeHostRemoteAccess,
  DesktopRuntimeHostLocalManagementTarget,
} from './runtime-host-local-remote-access.js';
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
}): DesktopRuntimeHostManagementProvider {
  return {
    profileId: LOCAL_RUNTIME_HOST_PROFILE.id,
    accessManagementAvailable: false,
    run: (action, allowInterruptActiveTasks) => {
      const execute = (target: DesktopRuntimeHostLocalManagementTarget) =>
        input.operator.runService({
          operatorPath: target.operatorPath,
          action,
          target,
          ...(allowInterruptActiveTasks ? { allowInterruptActiveTasks: true } : {}),
        }).then((frame) => requireLocalFrame(frame, action));
      return action === 'status' || action === 'logs'
        ? input.remoteAccess.inspectManaged(execute)
        : input.remoteAccess.changeManaged(execute);
    },
    uninstall: async (allowInterruptActiveTasks) => {
      const result = await input.remoteAccess.uninstall({ allowInterruptActiveTasks });
      return { kind: result.kind, retainedStateRoot: input.rootPath };
    },
    update: async (allowInterruptActiveTasks, onProgress) => {
      const setupPackage = await input.resolveUpdatePackage();
      return input.remoteAccess.changeManaged(
        (target) =>
          input.operator.runUpdate(
            {
              setupPackage,
              target,
              ...(allowInterruptActiveTasks ? { allowInterruptActiveTasks: true } : {}),
            },
            onProgress,
          ).then((frame) => requireLocalFrame(frame, 'update')),
      );
    },
    configureProjectDirectories: (
      roots,
      expectedConfigFingerprint,
      allowInterruptActiveTasks,
    ) =>
      input.remoteAccess.changeManaged(
        (target) =>
          input.operator.runService({
            operatorPath: target.operatorPath,
            action: 'configure',
            target,
            projectDirectoryRoots: roots,
            expectedConfigFingerprint,
            ...(allowInterruptActiveTasks ? { allowInterruptActiveTasks: true } : {}),
          }).then((frame) => requireLocalFrame(frame, 'configure')),
      ),
    updatePolicy: (policy) =>
      input.remoteAccess.inspectManaged((target) =>
        input.operator.runUpdatePolicy({
          operatorPath: target.operatorPath,
          target,
          ...(policy ? { policy } : {}),
        }).then((frame) => requireLocalFrame(frame, 'update_policy'))),
    reconcileUpdate: (onProgress) =>
      input.remoteAccess.changeManaged((target) =>
        input.operator.runUpdateReconciliation(
          { operatorPath: target.operatorPath, target },
          onProgress,
        ).then((frame) => requireLocalFrame(frame, 'reconcile_update'))),
    currentHostEpoch: input.currentHostEpoch,
    awaitUpdatedConnection: input.awaitUpdatedConnection,
  };
}

function requireLocalFrame<Action extends RuntimeHostServiceManagementFrame['action']>(
  frame: RuntimeHostServiceManagementFrame,
  action: Action,
): Exclude<RuntimeHostServiceManagementFrame, { readonly kind: 'progress' }> & {
  readonly action: Action;
} {
  if (frame.kind === 'progress' || frame.action !== action) {
    throw new Error('Local Runtime Host returned an unrelated management result');
  }
  return frame as Exclude<
    RuntimeHostServiceManagementFrame,
    { readonly kind: 'progress' }
  > & { readonly action: Action };
}
