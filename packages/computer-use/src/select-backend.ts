import {
  buildComputerUseTools,
  type CuOverlayHook,
  type ComputerUseToolSet,
  type CuDispatchBackend,
} from '@maka/runtime';
import { createCuaDriverBackend } from './cua-driver-backend.js';
import type { CuaDriverBackendOptions } from './cua-driver-backend.js';
import type { CuaDriverRoleSnapshot } from './cua-driver-release.js';

export type CuBackendId = 'cua-driver';

type DisposableBackend = CuDispatchBackend & {
  clearSession?: (sessionId: string) => void;
  dispose?: () => void;
  serviceState?: () => {
    action: CuaDriverRoleSnapshot;
    capture: CuaDriverRoleSnapshot;
  };
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

export function selectComputerUseBackend(deps?: {
  binaryPath?: string;
  hostBundleId?: string;
  expectedBinarySha256?: string;
  expectedServerName?: string;
  expectedServerVersion?: string;
  expectedProtocolVersion?: string;
  compressFrame?: (
    base64: string,
    mimeType: string,
  ) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
  physicalInputRecentlyActive?: () => boolean | Promise<boolean>;
  screenLocked?: () => boolean | Promise<boolean>;
  onTrace?: CuaDriverBackendOptions['onTrace'];
  overlay?: CuOverlayHook;
  createBackend?: (options: CuaDriverBackendOptions) => DisposableBackend;
}): SelectedComputerUseBackend {
  if (process.platform !== 'darwin') return NONE;
  if (!deps?.binaryPath || !deps.expectedBinarySha256) return NONE;
  try {
    let tools: ComputerUseToolSet | undefined;
    const backend = (deps.createBackend ?? createCuaDriverBackend)({
      binaryPath: deps.binaryPath,
      hostBundleId: resolveHostBundleId(deps?.hostBundleId),
      expectedBinarySha256: deps.expectedBinarySha256,
      ...(deps.expectedServerName ? { expectedServerName: deps.expectedServerName } : {}),
      ...(deps.expectedServerVersion ? { expectedServerVersion: deps.expectedServerVersion } : {}),
      ...(deps.expectedProtocolVersion
        ? { expectedProtocolVersion: deps.expectedProtocolVersion }
        : {}),
      ...(deps?.compressFrame ? { compressFrame: deps.compressFrame } : {}),
      ...(deps?.physicalInputRecentlyActive
        ? { physicalInputRecentlyActive: deps.physicalInputRecentlyActive }
        : {}),
      ...(deps?.screenLocked ? { screenLocked: deps.screenLocked } : {}),
      ...(deps?.onTrace ? { onTrace: deps.onTrace } : {}),
      // Typing, scrolling and dragging go through cua-driver's compatibility
      // event backend. That path was left off in the shipping build, which meant
      // the code existed, had tests, and could never run — Computer Use could
      // look at a machine and click on it, but not write in it, scroll it, or
      // drag anything.
      //
      // The concern behind the switch was real: synthesized events can collide
      // with what the user is physically doing. Turning off the whole capability
      // is a blunt way to express that, and the precise one is already here —
      // `physicalInputFailure()` guards every one of these dispatch sites and
      // refuses while the user is actually at the keyboard, driven by the
      // `physicalInputRecentlyActive` probe the host passes in above.
      allowCompatibilityInputDispatch: true,
      onSessionInvalidated: ({ sessionId }) => {
        tools?.sessionEvents.reobserveRequired(sessionId);
      },
    });
    tools = buildComputerUseTools({
      backend,
      ...(deps.overlay ? { overlay: deps.overlay } : {}),
    });
    return {
      backend,
      tools,
      backendId: 'cua-driver',
    };
  } catch {
    return NONE;
  }
}
