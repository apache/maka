import { buildComputerUseTools, type ComputerUseToolSet } from '@maka/runtime/computer-use-tools';
import { type CuOverlayHook, type CuDispatchBackend } from '@maka/runtime/computer-use-types';
import { createMakaCuBackend } from './maka-cu-backend.js';
import type { MakaCuBackendOptions } from './maka-cu-backend.js';
import type { MakaCuServiceSnapshot } from './maka-cu-service.js';

/**
 * One executor.
 *
 * This was a two-member set while cua-driver was being replaced, and the
 * selector took an overload per member. Keeping the id now that the second
 * executor is gone is not ceremony: `backendId` is what the capability snapshot
 * reports and what `'none'` is distinguished from, so it stays a named value
 * rather than becoming a boolean nobody can read.
 */
export const CU_BACKEND_IDS = ['maka-cu'] as const;
export type CuBackendId = (typeof CU_BACKEND_IDS)[number];

export const DEFAULT_CU_BACKEND_ID: CuBackendId = 'maka-cu';

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
  /**
   * Coordinate and key dispatch post synthetic events. Off unless a host policy
   * says otherwise; the model-facing contract already states they fail closed.
   */
  allowCompatibilityInputDispatch?: boolean;
  createBackend?: (options: MakaCuBackendOptions) => DisposableBackend;
}

export type ComputerUseBackendSelection = MakaCuSelection;

export function selectComputerUseBackend(deps?: MakaCuSelection): SelectedComputerUseBackend {
  if (process.platform !== 'darwin') return NONE;
  if (!deps?.binaryPath || !deps.expectedBinarySha256) return NONE;
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
      ...(deps.allowCompatibilityInputDispatch === undefined
        ? {}
        : { allowCompatibilityInputDispatch: deps.allowCompatibilityInputDispatch }),
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
