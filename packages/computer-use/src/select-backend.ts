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

import { buildComputerUseTools, type ComputerUseToolSet } from '@maka/runtime/computer-use-tools';
import { type CuOverlayHook, type CuDispatchBackend } from '@maka/runtime/computer-use-types';
import { createCuaDriverBackend, type CuaDriverBackendOptions } from './cua-driver-backend.js';
import type { CuaDriverService } from './cua-driver-service.js';

export const CU_BACKEND_IDS = ['cua-driver'] as const;
export type CuBackendId = (typeof CU_BACKEND_IDS)[number];
export const DEFAULT_CU_BACKEND_ID: CuBackendId = 'cua-driver';

type DisposableBackend = CuDispatchBackend & {
  clearSession?: (sessionId: string) => void;
  dispose?: () => void;
  executorState?: () => ReturnType<CuaDriverService['snapshot']>;
};

export interface SelectedComputerUseBackend {
  backend?: DisposableBackend;
  tools: ComputerUseToolSet;
  backendId: CuBackendId | 'none';
}

function emptyTools(): ComputerUseToolSet {
  const tools = [] as unknown as ComputerUseToolSet;
  tools.clearSession = () => {};
  const snapshot = () => ({ status: 'unobserved' as const, generation: 0 });
  tools.sessionEvents = {
    snapshot,
    physicalUserIntervened: snapshot,
    interventionDebounceElapsed: snapshot,
    reobserveRequired: snapshot,
    screenLocked: snapshot,
    screenUnlocked: snapshot,
    blockedUrlDetected: snapshot,
    userStopped: snapshot,
    dynamicContentChanged: snapshot,
  };
  return tools;
}

const NONE: SelectedComputerUseBackend = {
  backend: undefined,
  tools: emptyTools(),
  backendId: 'none',
};

export interface ComputerUseBackendSelection {
  binaryPath?: string;
  expectedBinarySha256?: string;
  compressFrame?: CuaDriverBackendOptions['compressFrame'];
  physicalInputRecentlyActive?: CuaDriverBackendOptions['physicalInputRecentlyActive'];
  requestAccessibilityPermission?: CuaDriverBackendOptions['requestAccessibilityPermission'];
  screenLocked?: (context: { sessionId: string }) => boolean | Promise<boolean>;
  overlay?: CuOverlayHook;
  createBackend?: (options: CuaDriverBackendOptions) => DisposableBackend;
}

export function selectComputerUseBackend(
  deps?: ComputerUseBackendSelection,
): SelectedComputerUseBackend {
  if (process.platform !== 'darwin') return NONE;
  if (!deps?.binaryPath || !deps.expectedBinarySha256) return NONE;
  try {
    let tools: ComputerUseToolSet | undefined;
    const backend = (deps.createBackend ?? createCuaDriverBackend)({
      binaryPath: deps.binaryPath,
      expectedBinarySha256: deps.expectedBinarySha256,
      ...(deps.compressFrame ? { compressFrame: deps.compressFrame } : {}),
      ...(deps.physicalInputRecentlyActive
        ? { physicalInputRecentlyActive: deps.physicalInputRecentlyActive }
        : {}),
      ...(deps.requestAccessibilityPermission
        ? { requestAccessibilityPermission: deps.requestAccessibilityPermission }
        : {}),
      onSessionInvalidated: ({ sessionId }) => {
        tools?.sessionEvents.reobserveRequired(sessionId);
      },
    });
    tools = buildComputerUseTools({
      backend,
      ...(deps.overlay ? { overlay: deps.overlay } : {}),
      ...(deps.screenLocked ? { screenLocked: deps.screenLocked } : {}),
    });
    return { backend, tools, backendId: DEFAULT_CU_BACKEND_ID };
  } catch {
    return NONE;
  }
}
