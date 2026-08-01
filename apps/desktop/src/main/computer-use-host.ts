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

export function computerUseServiceHealth(
  backendId: SelectedComputerUseBackend['backendId'],
  state: {
    action: CuaDriverRoleSnapshot;
    capture: CuaDriverRoleSnapshot;
  } | undefined,
): {
  state: 'not_available' | 'not_run' | 'healthy' | 'degraded';
  reason: string;
} {
  if (backendId === 'none' || !state) {
    return {
      state: 'not_available',
      reason: '未找到通过完整性检查且可分发的 cua-driver artifact。',
    };
  }
  const roles = [state.action, state.capture];
  if (roles.some((role) =>
    role.state === 'unavailable' || role.state === 'disposed')) {
    return {
      state: 'not_available',
      reason: roles.some((role) => role.state === 'disposed')
        ? 'cua-driver service 已停止。'
        : 'cua-driver service 启动失败或已退出。',
    };
  }
  if (roles.some((role) =>
    role.state === 'starting' || role.state === 'backing_off')) {
    return {
      state: 'degraded',
      reason: 'cua-driver service 正在启动或恢复。',
    };
  }
  if (roles.every((role) => role.state === 'ready')) {
    return {
      state: 'healthy',
      reason: 'cua-driver 操作与截图服务已就绪。',
    };
  }
  if (roles.some((role) => role.state === 'ready')) {
    return {
      state: 'not_run',
      reason: 'cua-driver 部分服务已启动，其余服务将在需要时启动。',
    };
  }
  return {
    state: 'not_run',
    reason: 'cua-driver 已可用，将在首次调用时启动。',
  };
}
