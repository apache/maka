import {
  buildComputerUseTools,
  type CuOverlayHook,
  type ComputerUseToolSet,
  type CuDispatchBackend,
} from '@maka/runtime';
import { createCuaDriverBackend } from './cua-driver-backend.js';
import type { CuaDriverBackendOptions } from './cua-driver-backend.js';
import type { CuaDriverRoleSnapshot } from './cua-driver-release.js';
import { createMakaCuBackend } from './maka-cu-backend.js';
import type { MakaCuBackendOptions } from './maka-cu-backend.js';
import type { MakaCuServiceSnapshot } from './maka-cu-service.js';

/**
 * The executors a caller may ask for.
 *
 * `'cua-driver'` is first because it is the default, and it stays the default
 * until maka-cu has an artifact that a packaged build is allowed to spawn.
 * Nothing here picks maka-cu on its own: a caller names it, or gets cua-driver.
 */
export const CU_BACKEND_IDS = ['cua-driver', 'maka-cu'] as const;
export type CuBackendId = (typeof CU_BACKEND_IDS)[number];

export const DEFAULT_CU_BACKEND_ID: CuBackendId = 'cua-driver';

type DisposableBackend = CuDispatchBackend & {
  clearSession?: (sessionId: string) => void;
  dispose?: () => void;
  serviceState?: () => {
    action: CuaDriverRoleSnapshot;
    capture: CuaDriverRoleSnapshot;
  };
  /** maka-cu supervises one child, not a role pair, so it reports its own shape. */
  executorState?: () => MakaCuServiceSnapshot;
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

function resolveHostBundleId(explicit?: string): string {
  return explicit ?? process.env.MAKA_CU_HOST_BUNDLE_ID ?? 'com.maka.desktop';
}

/** What both executors need from the host, spelled once. */
interface CommonSelection {
  binaryPath?: string;
  expectedBinarySha256?: string;
  compressFrame?: (
    base64: string,
    mimeType: string,
  ) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
  physicalInputRecentlyActive?: () => boolean | Promise<boolean>;
  overlay?: CuOverlayHook;
}

export interface CuaDriverSelection extends CommonSelection {
  /** Omitted means the default; see `DEFAULT_CU_BACKEND_ID`. */
  backendId?: 'cua-driver';
  hostBundleId?: string;
  expectedServerName?: string;
  expectedServerVersion?: string;
  expectedProtocolVersion?: string;
  onTrace?: CuaDriverBackendOptions['onTrace'];
  createBackend?: (options: CuaDriverBackendOptions) => DisposableBackend;
}

export interface MakaCuSelection extends CommonSelection {
  /** Required: maka-cu is never reached by leaving a field out. */
  backendId: 'maka-cu';
  onTrace?: MakaCuBackendOptions['onTrace'];
  /**
   * Coordinate and key dispatch post synthetic events. Off unless a host policy
   * says otherwise; the model-facing contract already states they fail closed.
   */
  allowCompatibilityInputDispatch?: boolean;
  createBackend?: (options: MakaCuBackendOptions) => DisposableBackend;
}

export type ComputerUseBackendSelection = CuaDriverSelection | MakaCuSelection;

/**
 * Two overloads rather than one union parameter, so that `createBackend` is
 * contextually typed. Given a bare union, TypeScript cannot decide which member
 * a fresh object literal is being written against and gives its methods an
 * implicit `any` — which is how a host would silently stop being told that it
 * had wired a cua-driver option into the maka-cu factory.
 */
export function selectComputerUseBackend(deps?: CuaDriverSelection): SelectedComputerUseBackend;
export function selectComputerUseBackend(deps: MakaCuSelection): SelectedComputerUseBackend;
export function selectComputerUseBackend(
  deps?: ComputerUseBackendSelection,
): SelectedComputerUseBackend {
  if (process.platform !== 'darwin') return NONE;
  if (!deps?.binaryPath || !deps.expectedBinarySha256) return NONE;
  const binaryPath = deps.binaryPath;
  const expectedBinarySha256 = deps.expectedBinarySha256;
  try {
    let tools: ComputerUseToolSet | undefined;
    const onSessionInvalidated = ({ sessionId }: { sessionId: string }) => {
      tools?.sessionEvents.reobserveRequired(sessionId);
    };
    const backendId: CuBackendId = deps.backendId ?? DEFAULT_CU_BACKEND_ID;
    let backend: DisposableBackend;
    if (deps.backendId === 'maka-cu') {
      backend = (deps.createBackend ?? createMakaCuBackend)({
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
        onSessionInvalidated,
      });
    } else {
      backend = (deps.createBackend ?? createCuaDriverBackend)({
        binaryPath,
        hostBundleId: resolveHostBundleId(deps.hostBundleId),
        expectedBinarySha256,
        ...(deps.expectedServerName ? { expectedServerName: deps.expectedServerName } : {}),
        ...(deps.expectedServerVersion
          ? { expectedServerVersion: deps.expectedServerVersion }
          : {}),
        ...(deps.expectedProtocolVersion
          ? { expectedProtocolVersion: deps.expectedProtocolVersion }
          : {}),
        ...(deps.compressFrame ? { compressFrame: deps.compressFrame } : {}),
        ...(deps.physicalInputRecentlyActive
          ? { physicalInputRecentlyActive: deps.physicalInputRecentlyActive }
          : {}),
        ...(deps.onTrace ? { onTrace: deps.onTrace } : {}),
        onSessionInvalidated,
      });
    }
    tools = buildComputerUseTools({
      backend,
      ...(deps.overlay ? { overlay: deps.overlay } : {}),
    });
    return { backend, tools, backendId };
  } catch {
    return NONE;
  }
}
