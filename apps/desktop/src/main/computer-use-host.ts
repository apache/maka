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

import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CuaDriverBackendOptions, CuaDriverServiceState } from '@maka/computer-use';
import {
  selectComputerUseBackend,
  type SelectedComputerUseBackend,
} from '@maka/computer-use';
import type { CapabilityReasonCode } from '@maka/core/capabilities';
import type { CuOverlayHook } from '@maka/runtime/computer-use-types';

export interface ComputerUseHostState {
  selected: SelectedComputerUseBackend;
  binaryPath?: string;
  expectedBinarySha256?: string;
}

function readRegularFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error('expected a regular file');
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function createComputerUseHost(input: {
  isPackaged: boolean;
  resourcesPath: string;
  manifestPath?: string;
  binaryPath?: string;
  compressFrame?: (
    base64: string,
    mimeType: string,
  ) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
  physicalInputRecentlyActive: () => boolean | Promise<boolean>;
  requestAccessibilityPermission?: CuaDriverBackendOptions['requestAccessibilityPermission'];
  /** Whether the machine is locked; refuses every call while it is. */
  screenLocked?: (context: { sessionId: string }) => boolean | Promise<boolean>;
  overlay?: CuOverlayHook;
}): ComputerUseHostState {
  const manifestPath = input.manifestPath ?? (input.isPackaged
    ? join(input.resourcesPath, 'bundled-tools.json')
    : resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'bundled-tools.json',
      ));
  const binaryPath = input.binaryPath ?? (input.isPackaged
    ? join(input.resourcesPath, 'bin', 'cua-driver')
    : resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'resources',
        'bin',
        'cua-driver',
      ));
  try {
    const manifest = JSON.parse(readRegularFile(manifestPath).toString('utf8')) as {
      cuaDriver?: {
        binarySha256?: string;
        distributionReady?: boolean;
      };
    };
    const expectedBinarySha256 = manifest.cuaDriver?.binarySha256;
    if (input.isPackaged && manifest.cuaDriver?.distributionReady !== true) {
      return { selected: selectComputerUseBackend() };
    }
    if (!expectedBinarySha256 || !/^[a-f0-9]{64}$/.test(expectedBinarySha256)) {
      return { selected: selectComputerUseBackend() };
    }
    accessSync(binaryPath, constants.R_OK | constants.X_OK);
    const actual = createHash('sha256')
      .update(readRegularFile(binaryPath))
      .digest('hex');
    if (actual !== expectedBinarySha256) {
      return { selected: selectComputerUseBackend() };
    }
    return {
      // No `backendId`: the host takes whatever `DEFAULT_CU_BACKEND_ID` names,
      // so "which executor ships" is one decision recorded in one place rather
      // than a default and a host that could disagree about it.
      selected: selectComputerUseBackend({
        binaryPath,
        expectedBinarySha256,
        ...(input.compressFrame ? { compressFrame: input.compressFrame } : {}),
        physicalInputRecentlyActive: input.physicalInputRecentlyActive,
        ...(input.requestAccessibilityPermission
          ? { requestAccessibilityPermission: input.requestAccessibilityPermission }
          : {}),
        ...(input.screenLocked ? { screenLocked: input.screenLocked } : {}),
        ...(input.overlay ? { overlay: input.overlay } : {}),
      }),
      binaryPath,
      expectedBinarySha256,
    };
  } catch {
    return { selected: selectComputerUseBackend() };
  }
}

export function createDesktopPhysicalInputGuard(
  getSystemIdleTime: () => number,
): () => boolean {
  return () => getSystemIdleTime() < 1;
}

export function computerUseServiceHealth(
  backendId: SelectedComputerUseBackend['backendId'],
  state: { state: CuaDriverServiceState; generation: number } | undefined,
): {
  state: 'not_available' | 'not_run' | 'healthy' | 'degraded';
  reason: CapabilityReasonCode;
} {
  if (backendId === 'none' || !state) {
    return { state: 'not_available', reason: 'cu_executor_undistributable' };
  }
  switch (state.state) {
    case 'disposed':
      return { state: 'not_available', reason: 'cu_executor_stopped' };
    case 'unavailable':
      return { state: 'not_available', reason: 'cu_executor_start_failed' };
    case 'starting':
      return { state: 'degraded', reason: 'cu_executor_recovering' };
    case 'ready':
      return { state: 'healthy', reason: 'cu_executor_ready' };
    default:
      return { state: 'not_run', reason: 'cu_executor_lazy_start' };
  }
}
