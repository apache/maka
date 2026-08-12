import type { ExecutionBoundaryReadModel } from '@maka/core/sandbox-boundary';
import type { PermissionMode } from '@maka/core/permission';
import { executionBoundaryDisplayMode } from '@maka/core/sandbox-boundary';

export interface DesktopExecutionBoundarySurface {
  permissionMode: PermissionMode | undefined;
  localInteractionAvailable: boolean;
}

export function deriveDesktopExecutionBoundarySurface(
  activeSessionId: string | undefined,
  boundary: ExecutionBoundaryReadModel | undefined,
  fallbackMode: PermissionMode,
): DesktopExecutionBoundarySurface {
  if (!activeSessionId) {
    return {
      permissionMode: fallbackMode,
      localInteractionAvailable: true,
    };
  }
  // #1611: the boundary is the authority on what the session may do, and
  // `executionBoundaryDisplayMode` is the single place that maps it to a mode
  // the user sees — shared with the TUI so the two surfaces cannot drift.
  // Until it resolves (and permanently, for an externally isolated session)
  // this surface fails closed: no mode, no local controls.
  const permissionMode = boundary ? executionBoundaryDisplayMode(boundary) : undefined;
  return permissionMode
    ? { permissionMode, localInteractionAvailable: true }
    : { permissionMode: undefined, localInteractionAvailable: false };
}
