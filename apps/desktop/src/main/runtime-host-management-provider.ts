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
  RuntimeHostServiceUpdatePhase,
} from '@maka/runtime-host/operator';
import type {
  DesktopRuntimeHostManagementAction,
} from '../preload/bridge-contract.js';

export type DesktopRuntimeHostManagementTerminalFrame = Exclude<
  RuntimeHostServiceManagementFrame,
  { readonly kind: 'progress' }
>;

export interface DesktopRuntimeHostManagementProvider {
  readonly profileId: string;
  readonly accessManagementAvailable: boolean;
  run(
    action: Exclude<DesktopRuntimeHostManagementAction, 'uninstall'>,
    allowInterruptActiveTasks: boolean,
  ): Promise<DesktopRuntimeHostManagementTerminalFrame>;
  uninstall(
    allowInterruptActiveTasks: boolean,
  ): Promise<{ readonly kind: 'active_tasks' | 'uninstalled'; readonly retainedStateRoot: string }>;
  update(
    allowInterruptActiveTasks: boolean,
    onProgress: (phase: RuntimeHostServiceUpdatePhase) => void,
  ): Promise<DesktopRuntimeHostManagementTerminalFrame>;
  configureProjectDirectories(
    roots: readonly { readonly label: string; readonly path: string }[],
    expectedConfigFingerprint: string,
    allowInterruptActiveTasks: boolean,
  ): Promise<DesktopRuntimeHostManagementTerminalFrame>;
  updatePolicy(
    policy?: RuntimeHostManagedUpdatePolicy,
  ): Promise<DesktopRuntimeHostManagementTerminalFrame>;
  reconcileUpdate(
    onProgress: (phase: RuntimeHostServiceUpdatePhase) => void,
  ): Promise<DesktopRuntimeHostManagementTerminalFrame>;
  currentHostEpoch(): string | undefined;
  awaitUpdatedConnection(
    previousHostEpoch: string | undefined,
    replacementExpected: boolean,
  ): Promise<void>;
}
