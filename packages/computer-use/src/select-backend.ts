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
import type { MakaCuServiceSnapshot } from './maka-cu-service.js';

/**
 * One executor id, one supervised child contract.
 *
 * This was a two-member set while cua-driver was being replaced, and the
 * selector took an overload per member. Keeping the id now that the second
 * executor is gone is not ceremony: `backendId` is what the capability snapshot
 * reports and what `'none'` is distinguished from, so it stays a named value
 * rather than becoming a boolean nobody can read.
 *
 * A second id is deliberately not added for a new OS. macOS, Windows and any
 * future desktop executor speak the same `maka.cu/2` contract and are
 * supervised by the same service (`MakaCuService`); the platform differences
 * are the native binary behind that contract and the Desktop composition that
 * provisions it. See `CuPlatformBackendBinding` below.
 */
export const CU_BACKEND_IDS = ['maka-cu'] as const;
export type CuBackendId = (typeof CU_BACKEND_IDS)[number];

export const DEFAULT_CU_BACKEND_ID: CuBackendId = 'maka-cu';

/**
 * The platform abstraction seam.
 *
 * Selection is the one place a platform names its executor. The bindings here
 * say which native platform has a distributable executor behind the shared
 * `CuDispatchBackend`/`MakaCuService` pair; they do not say anything about the
 * model-facing action surface, which is platform-neutral by construction.
 *
 * An unsupported platform is a typed, fail-closed selection, never a backend
 * that silently no-ops. A future platform is added by proving its native
 * executor and Desktop provisioning, then registering it here (and in the
 * Desktop manifest pipeline) — not by copying the supervisor.
 */
export type CuPlatformBackendBinding = {
  readonly id: CuBackendId;
  readonly platform: NodeJS.Platform;
  /**
   * Human label for capability reporting. `macOS` is the only shipped member
   * today; the shared executor contract is what lets later members reuse the
   * rest of this package without a second backend implementation.
   */
  readonly platformLabel: string;
};

export const CU_PLATFORM_BACKEND_BINDINGS: readonly CuPlatformBackendBinding[] = [
  {
    id: 'maka-cu',
    platform: 'darwin',
    platformLabel: 'macOS',
  },
];

type DisposableBackend = CuDispatchBackend & {
  clearSession?: (sessionId: string) => void;
  dispose?: () => void;
  /** maka-cu supervises one child, not a role pair, so it reports its own shape. */
  executorState?: () => MakaCuServiceSnapshot;
};

export interface SelectedComputerUseBackend {
  backend?: DisposableBackend;
  tools: ComputerUseToolSet;
  backendId: CuBackendId | 'none';
  /**
   * Why no backend is selected, when that is the case. A missing reason means
   * a backend is live. This makes "Computer Use is unavailable on this
   * platform" a typed fact a capability UI can distinguish from a missing
   * executable or a construction failure instead of three flavours of `none`.
   */
  unavailableReason?: 'unsupported_platform' | 'missing_executable' | 'backend_failed';
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

function unavailable(
  reason: NonNullable<SelectedComputerUseBackend['unavailableReason']>,
): SelectedComputerUseBackend {
  return {
    backend: undefined,
    tools: emptyTools(),
    backendId: 'none',
    unavailableReason: reason,
  };
}

export interface MakaCuSelection {
  /** Omitted means the default; see `DEFAULT_CU_BACKEND_ID`. */
  backendId?: 'maka-cu';
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
  createBackend?: (options: MakaCuBackendOptions) => DisposableBackend;
  /**
   * Test/host seam. Production callers omit it and Node's own platform is
   * used; tests inject `darwin` so the same selection assertions run on every
   * CI OS instead of being skipped off-macOS.
   */
  platform?: NodeJS.Platform;
}

export type ComputerUseBackendSelection = MakaCuSelection;

export function selectComputerUseBackend(deps?: MakaCuSelection): SelectedComputerUseBackend {
  const platform = deps?.platform ?? process.platform;
  const binding = CU_PLATFORM_BACKEND_BINDINGS.find((candidate) => candidate.platform === platform);
  if (!binding) {
    return unavailable('unsupported_platform');
  }
  if (!deps?.binaryPath || !deps.expectedBinarySha256) {
    return unavailable('missing_executable');
  }
  const binaryPath = deps.binaryPath;
  const expectedBinarySha256 = deps.expectedBinarySha256;
  try {
    let tools: ComputerUseToolSet | undefined;
    const backend = (deps.createBackend ?? createMakaCuBackend)({
      binaryPath,
      expectedBinarySha256,
      ...(deps.compressFrame ? { compressFrame: deps.compressFrame } : {}),
      ...(deps.physicalInputRecentlyActive
        ? { physicalInputRecentlyActive: deps.physicalInputRecentlyActive }
        : {}),
      ...(deps.onTrace ? { onTrace: deps.onTrace } : {}),
      onSessionInvalidated: ({ sessionId }) => {
        tools?.sessionEvents.reobserveRequired(sessionId);
      },
    });
    tools = buildComputerUseTools({
      backend,
      ...(deps.overlay ? { overlay: deps.overlay } : {}),
      ...(deps.screenLocked ? { screenLocked: deps.screenLocked } : {}),
    });
    return { backend, tools, backendId: binding.id };
  } catch {
    return unavailable('backend_failed');
  }
}
