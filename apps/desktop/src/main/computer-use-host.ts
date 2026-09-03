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
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MakaCuBackendOptions } from '@maka/computer-use';
import type { MakaCuServiceSnapshot } from '@maka/computer-use';
import {
  selectComputerUseBackend,
  type SelectedComputerUseBackend,
} from '@maka/computer-use';
import type { CuOverlayHook } from '@maka/runtime/computer-use-types';

export interface ComputerUseHostState {
  selected: SelectedComputerUseBackend;
  binaryPath?: string;
  expectedBinarySha256?: string;
}

type BundledToolManifest = {
  makaCu?: { binarySha256?: string; distributionReady?: boolean };
  windowsCu?: {
    binarySha256?: string;
    distributionReady?: boolean;
    files?: Array<{ name?: string; sizeBytes?: number; sha256?: string }>;
  };
};

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

function hasPinnedWindowsHelperFiles(
  binaryPath: string,
  files: NonNullable<BundledToolManifest['windowsCu']>['files'],
): boolean {
  if (!Array.isArray(files) || files.length === 0) return false;
  const expected = new Map<string, { sizeBytes: number; sha256: string }>();
  for (const file of files) {
    if (
      typeof file?.name !== 'string' ||
      file.name.length === 0 ||
      file.name !== file.name.split(/[\\/]/).pop() ||
      typeof file.sizeBytes !== 'number' ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      expected.has(file.name)
    ) return false;
    expected.set(file.name, { sizeBytes: file.sizeBytes, sha256: file.sha256 });
  }
  let actual: string[];
  try {
    actual = readdirSync(dirname(binaryPath), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== 'bundled-tools.json')
      .map((entry) => entry.name);
  } catch {
    return false;
  }
  if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) return false;
  for (const [name, pin] of expected) {
    try {
      const bytes = readRegularFile(join(dirname(binaryPath), name));
      if (bytes.byteLength !== pin.sizeBytes) return false;
      if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) return false;
    } catch {
      return false;
    }
  }
  return expected.has(binaryPath.split(/[\\/]/).pop() ?? '');
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
  /** Whether the machine is locked; refuses every call while it is. */
  screenLocked?: (context: { sessionId: string }) => boolean | Promise<boolean>;
  onTrace?: MakaCuBackendOptions['onTrace'];
  overlay?: CuOverlayHook;
  /** Test seam for Windows manifest selection. */
  platform?: NodeJS.Platform;
}): ComputerUseHostState {
  const manifestPath = input.manifestPath ?? (input.isPackaged
    ? join(input.resourcesPath, 'bundled-tools.json')
    : resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'bundled-tools.json',
      ));
  const platform = input.platform ?? process.platform;
  const windows = platform === 'win32';
  const binaryPath = input.binaryPath ?? (windows
    ? (process.env.MAKA_WINDOWS_CU_HELPER_PATH ?? (input.isPackaged
      ? join(input.resourcesPath, 'bin', 'maka-cu-windows', 'maka-cu-windows.exe')
      : resolve(
          dirname(fileURLToPath(import.meta.url)),
          '..',
          '..',
          'resources',
          'bin',
          'maka-cu-windows',
          'maka-cu-windows.exe',
        )))
    : (input.isPackaged
      ? join(input.resourcesPath, 'bin', 'maka-cu')
      : resolve(
          dirname(fileURLToPath(import.meta.url)),
          '..',
          '..',
          'resources',
          'bin',
          'maka-cu',
        )));
  try {
    const manifest = JSON.parse(readRegularFile(manifestPath).toString('utf8')) as BundledToolManifest;
    const entry = windows ? manifest.windowsCu : manifest.makaCu;
    const expectedBinarySha256 = entry?.binarySha256;
    if (input.isPackaged && entry?.distributionReady !== true) {
      return { selected: selectComputerUseBackend({ platform }) };
    }
    if (!expectedBinarySha256 || !/^[a-f0-9]{64}$/.test(expectedBinarySha256)) {
      return { selected: selectComputerUseBackend({ platform }) };
    }
    if (windows && !hasPinnedWindowsHelperFiles(binaryPath, manifest.windowsCu?.files)) {
      return { selected: selectComputerUseBackend({ platform }) };
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
        ...(input.screenLocked ? { screenLocked: input.screenLocked } : {}),
        ...(input.onTrace ? { onTrace: input.onTrace } : {}),
        ...(input.overlay ? { overlay: input.overlay } : {}),
        platform,
      }),
      binaryPath,
      expectedBinarySha256,
    };
  } catch {
    return { selected: selectComputerUseBackend({ platform }) };
  }
}

export function createDesktopPhysicalInputGuard(
  getSystemIdleTime: () => number,
): () => boolean {
  return () => getSystemIdleTime() < 1;
}

/**
 * One executor, one state.
 *
 * cua-driver ran as a pair of roles — one process to act, one to capture — so
 * this had to reconcile two states into one word, and "healthy" meant both.
 * maka-cu supervises a single child, so the reported state is the state.
 */
export function computerUseServiceHealth(
  backendId: SelectedComputerUseBackend['backendId'],
  state: MakaCuServiceSnapshot | undefined,
): {
  state: 'not_available' | 'not_run' | 'healthy' | 'degraded';
  reason: string;
} {
  if (backendId === 'none' || !state) {
    return {
      state: 'not_available',
      reason: '未找到通过完整性检查且可分发的 maka-cu executor。',
    };
  }
  switch (state.state) {
    case 'disposed':
      return { state: 'not_available', reason: 'maka-cu executor 已停止。' };
    case 'unavailable':
      return { state: 'not_available', reason: 'maka-cu executor 启动失败或已退出。' };
    case 'starting':
    case 'backing_off':
      return { state: 'degraded', reason: 'maka-cu executor 正在启动或恢复。' };
    case 'ready':
      return { state: 'healthy', reason: 'maka-cu executor 已就绪。' };
    default:
      return { state: 'not_run', reason: 'maka-cu 已可用，将在首次调用时启动。' };
  }
}
