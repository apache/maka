import type { ExecutionBoundary } from '@maka/core';

/**
 * Whether the desktop may run this session at all.
 *
 * An externally isolated session belongs to the harness that owns its sandbox;
 * the desktop has no authority over that boundary and must not act inside it.
 *
 * Exposed alongside the assert so a caller that is *surveying* sessions can ask
 * without catching. Both shapes read the same rule from here, so a caller never
 * restates it — and a by-design skip stays distinguishable from a real failure,
 * which matters wherever both are handled in one place.
 */
export function isDesktopAdmissibleExecutionBoundary(boundary: ExecutionBoundary): boolean {
  return boundary.kind !== 'external';
}

export function assertDesktopExecutionBoundary(
  sessionId: string,
  boundary: ExecutionBoundary,
): void {
  if (!isDesktopAdmissibleExecutionBoundary(boundary)) {
    throw new Error(
      `Cannot run externally isolated session ${sessionId} outside its owning harness.`,
    );
  }
}
