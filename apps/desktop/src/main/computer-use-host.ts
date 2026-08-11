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
  /** Whether the machine is locked; refuses every call while it is. */
  screenLocked?: (context: { sessionId: string }) => boolean | Promise<boolean>;
  onTrace?: MakaCuBackendOptions['onTrace'];
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
    ? join(input.resourcesPath, 'bin', 'maka-cu')
    : resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'resources',
        'bin',
        'maka-cu',
      ));
  try {
    const manifest = JSON.parse(readRegularFile(manifestPath).toString('utf8')) as {
      makaCu?: {
        binarySha256?: string;
        distributionReady?: boolean;
      };
    };
    const expectedBinarySha256 = manifest.makaCu?.binarySha256;
    if (input.isPackaged && manifest.makaCu?.distributionReady !== true) {
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
        ...(input.screenLocked ? { screenLocked: input.screenLocked } : {}),
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
