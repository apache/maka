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
import { createMakaCuBackend } from './maka-cu-backend.js';
import type { MakaCuBackendOptions } from './maka-cu-backend.js';
import type { MakaCuReleaseEvent, MakaCuServiceSnapshot } from './maka-cu-service.js';
import { createWindowsCuBackend } from './windows-cu-backend.js';
import type { WindowsCuBackendOptions } from './windows-cu-backend.js';
import type { WindowsCuService } from './windows-cu-service.js';

/**
 * One executor.
 *
 * This was a two-member set while cua-driver was being replaced, and the
 * selector took an overload per member. Keeping the id now that the second
 * executor is gone is not ceremony: `backendId` is what the capability snapshot
 * reports and what `'none'` is distinguished from, so it stays a named value
 * rather than becoming a boolean nobody can read.
 */
export const CU_BACKEND_IDS = ['maka-cu', 'windows-native'] as const;
export type CuBackendId = (typeof CU_BACKEND_IDS)[number];

export const DEFAULT_CU_BACKEND_ID: CuBackendId =
  process.platform === 'win32' ? 'windows-native' : 'maka-cu';

type DisposableBackend = CuDispatchBackend & {
  clearSession?: (sessionId: string) => void;
  dispose?: () => void;
  /** maka-cu supervises one child, not a role pair, so it reports its own shape. */
  executorState?: () => MakaCuServiceSnapshot | ReturnType<WindowsCuService['snapshot']>;
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

export interface MakaCuSelection {
  /** Omitted means the default; see `DEFAULT_CU_BACKEND_ID`. */
  backendId?: CuBackendId;
  binaryPath?: string;
  expectedBinarySha256?: string;
  compressFrame?: (
    base64: string,
    mimeType: string,
  ) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
  physicalInputRecentlyActive?: () => boolean | Promise<boolean>;
  /**
   * Whether the machine is locked. Handed to the tool layer rather than to the
   * driver, because the refusal is a session-state decision (see
   * `buildComputerUseTools`) and the driver has no session state to latch it in.
   */
  screenLocked?: (context: { sessionId: string }) => boolean | Promise<boolean>;
  overlay?: CuOverlayHook;
  onTrace?: MakaCuBackendOptions['onTrace'];
  /**
   * Coordinate and key dispatch post synthetic events. Off unless a host policy
   * says otherwise; the model-facing contract already states they fail closed.
   */
  allowCompatibilityInputDispatch?: boolean;
  createBackend?: (options: MakaCuBackendOptions) => DisposableBackend;
  createWindowsBackend?: (options: WindowsCuBackendOptions) => DisposableBackend;
  onSessionInvalidated?: MakaCuBackendOptions['onSessionInvalidated'];
  /** Test/host seam; production defaults to Node's platform. */
  platform?: NodeJS.Platform;
}

export type ComputerUseBackendSelection = MakaCuSelection;

export function selectComputerUseBackend(deps?: MakaCuSelection): SelectedComputerUseBackend {
  const platform = deps?.platform ?? process.platform;
  const backendId =
    deps?.backendId ??
    (platform === 'win32' ? 'windows-native' : platform === 'darwin' ? 'maka-cu' : 'none');
  if (backendId === 'none') return NONE;
  if (backendId === 'maka-cu' && platform !== 'darwin') return NONE;
  if (backendId === 'windows-native' && platform !== 'win32') return NONE;
  if (!deps?.binaryPath || !deps.expectedBinarySha256) return NONE;
  const binaryPath = deps.binaryPath;
  const expectedBinarySha256 = deps.expectedBinarySha256;
  try {
    let tools: ComputerUseToolSet | undefined;
    const invalidation = ({
      sessionId,
      reason,
      outcomeUnknown,
    }: {
      sessionId: string;
      reason: MakaCuReleaseEvent['reason'];
      outcomeUnknown: boolean;
    }) => {
      tools?.sessionEvents.reobserveRequired(sessionId);
      deps.onSessionInvalidated?.({ sessionId, reason, outcomeUnknown });
    };
    const backend =
      backendId === 'windows-native'
        ? (deps.createWindowsBackend ?? createWindowsCuBackend)({
            binaryPath,
            expectedBinarySha256,
            onSessionInvalidated: invalidation,
          })
        : (deps.createBackend ?? createMakaCuBackend)({
            binaryPath,
            expectedBinarySha256,
            ...(deps.compressFrame ? { compressFrame: deps.compressFrame } : {}),
            ...(deps.physicalInputRecentlyActive
              ? { physicalInputRecentlyActive: deps.physicalInputRecentlyActive }
              : {}),
            ...(deps.onTrace ? { onTrace: deps.onTrace } : {}),
            ...(deps.allowCompatibilityInputDispatch === undefined
              ? {}
              : { allowCompatibilityInputDispatch: deps.allowCompatibilityInputDispatch }),
            onSessionInvalidated: invalidation,
          });
    tools = buildComputerUseTools({
      backend,
      ...(deps.overlay ? { overlay: deps.overlay } : {}),
      ...(deps.screenLocked ? { screenLocked: deps.screenLocked } : {}),
    });
    return { backend, tools, backendId };
  } catch {
    return NONE;
  }
}
