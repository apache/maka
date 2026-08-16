import type { SessionEvent } from '@maka/core/events';

type SandboxBoundaryFailureReason = 'sandbox_boundary_required' | 'requires_bypass';

export function sessionEventSandboxBoundaryFailureReason(
  event: SessionEvent,
): SandboxBoundaryFailureReason | undefined {
  if (
    event.type !== 'tool_result' ||
    !event.isError ||
    event.content.kind !== 'text' ||
    !event.content.sandboxFailure
  ) {
    return undefined;
  }
  return normalizeSandboxBoundaryFailureReason(event.content.sandboxFailure.reason);
}

function normalizeSandboxBoundaryFailureReason(
  reason: unknown,
): SandboxBoundaryFailureReason | undefined {
  return reason === 'sandbox_boundary_required' || reason === 'requires_bypass'
    ? reason
    : undefined;
}
