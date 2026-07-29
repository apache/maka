import type { ExecutionBoundary, PermissionMode } from '@maka/core';

export interface DesktopExecutionBoundarySurface {
  permissionMode: PermissionMode | undefined;
  localInteractionAvailable: boolean;
}

export function deriveDesktopExecutionBoundarySurface(
  activeSessionId: string | undefined,
  boundary: ExecutionBoundary | undefined,
  fallbackMode: PermissionMode,
): DesktopExecutionBoundarySurface {
  if (!activeSessionId) {
    return {
      permissionMode: fallbackMode,
      localInteractionAvailable: true,
    };
  }
  if (!boundary || boundary.kind === 'external') {
    return {
      permissionMode: undefined,
      localInteractionAvailable: false,
    };
  }
  return {
    permissionMode: boundary.kind === 'bypass' ? 'bypass' : 'ask',
    localInteractionAvailable: true,
  };
}
