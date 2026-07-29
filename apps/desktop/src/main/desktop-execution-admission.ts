import type { ExecutionBoundary } from '@maka/core';

export function assertDesktopExecutionBoundary(
  sessionId: string,
  boundary: ExecutionBoundary,
): void {
  if (boundary.kind === 'external') {
    throw new Error(
      `Cannot run externally isolated session ${sessionId} outside its owning harness.`,
    );
  }
}
