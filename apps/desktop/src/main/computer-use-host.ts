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
import type { CuaDriverRoleSnapshot } from '@maka/computer-use';
import type { CuaDriverBackendOptions } from '@maka/computer-use';
import type { MakaCuServiceSnapshot } from '@maka/computer-use';
import {
  selectComputerUseBackend,
  type SelectedComputerUseBackend,
} from '@maka/computer-use';
import type { CuOverlayHook } from '@maka/runtime';

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
  onTrace?: CuaDriverBackendOptions['onTrace'];
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
        expectedVersion?: string;
        expectedProtocolVersion?: string;
      };
    };
    const expectedBinarySha256 = manifest.cuaDriver?.binarySha256;
    const expectedServerVersion = manifest.cuaDriver?.expectedVersion;
    const expectedProtocolVersion =
      manifest.cuaDriver?.expectedProtocolVersion;
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
      selected: selectComputerUseBackend({
        binaryPath,
        expectedBinarySha256,
        expectedServerName: 'cua-driver',
        ...(expectedServerVersion ? { expectedServerVersion } : {}),
        ...(expectedProtocolVersion ? { expectedProtocolVersion } : {}),
        ...(input.compressFrame ? { compressFrame: input.compressFrame } : {}),
        physicalInputRecentlyActive: input.physicalInputRecentlyActive,
        ...(input.onTrace ? { onTrace: input.onTrace } : {}),
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

/**
 * The health half of the Computer Use capability card, for whichever executor
 * was selected.
 *
 * This used to take the cua-driver role pair and nothing else, while the card's
 * `available` half had already been widened to "any selected executor". With a
 * genuinely ready maka-cu backend the two halves disagreed, and executing the
 * built desktop module against one showed exactly how:
 *
 *   executorState()      = {"state":"ready","generation":1}
 *   serviceState (boot)  = undefined
 *   health               = {"state":"not_available","reason":"未找到通过完整性检查且可分发的 cua-driver artifact。"}
 *   artifactAvailable    = true
 *
 * — available, state not_available, and a reason naming an executor that is not
 * the one running. cua-driver supervises an action/capture role pair; maka-cu
 * supervises one child (§11) and reports its own shape. Both are read here as a
 * list of role states, so the card is right for either, and neither is selected
 * by being described.
 */
export type ComputerUseExecutorState =
  | { action: CuaDriverRoleSnapshot; capture: CuaDriverRoleSnapshot }
  | MakaCuServiceSnapshot;

function roleStates(state: ComputerUseExecutorState): Array<CuaDriverRoleSnapshot['state']> {
  return 'action' in state ? [state.action.state, state.capture.state] : [state.state];
}

export function computerUseServiceHealth(
  backendId: SelectedComputerUseBackend['backendId'],
  state: ComputerUseExecutorState | undefined,
): {
  state: 'not_available' | 'not_run' | 'healthy' | 'degraded';
  reason: string;
} {
  if (backendId === 'none' || !state) {
    return {
      state: 'not_available',
      reason: '未找到通过完整性检查且可分发的 Computer Use 执行器 artifact。',
    };
  }
  const roles = roleStates(state);
  if (roles.some((role) => role === 'unavailable' || role === 'disposed')) {
    return {
      state: 'not_available',
      reason: roles.some((role) => role === 'disposed')
        ? `${backendId} service 已停止。`
        : `${backendId} service 启动失败或已退出。`,
    };
  }
  if (roles.some((role) => role === 'starting' || role === 'backing_off')) {
    return {
      state: 'degraded',
      reason: `${backendId} service 正在启动或恢复。`,
    };
  }
  if (roles.every((role) => role === 'ready')) {
    return {
      state: 'healthy',
      reason: `${backendId} 操作与截图服务已就绪。`,
    };
  }
  if (roles.some((role) => role === 'ready')) {
    return {
      state: 'not_run',
      reason: `${backendId} 部分服务已启动，其余服务将在需要时启动。`,
    };
  }
  return {
    state: 'not_run',
    reason: `${backendId} 已可用，将在首次调用时启动。`,
  };
}
