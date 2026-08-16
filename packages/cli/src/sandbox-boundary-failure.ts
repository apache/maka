import type { SessionEvent } from '@maka/core/events';
import type { InvocationResult } from '@maka/runtime/invocation-context';

export type SandboxBoundaryFailureReason = 'sandbox_boundary_required' | 'requires_bypass';

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

export function invocationHasSandboxBoundaryFailure(result: InvocationResult): boolean {
  return result.events.some(
    (event) => runtimeEventSandboxBoundaryFailureReason(event) !== undefined,
  );
}

export function invocationRecoveredSandboxBoundaryFailure(
  result: InvocationResult | undefined,
): boolean {
  if (!invocationCompletedWithOutput(result)) return false;
  let unresolvedBoundaryFailure = false;
  let recoveredBoundaryFailure = false;
  for (const event of result.events) {
    if (event.content?.kind !== 'function_response') continue;
    if (event.content.isError && runtimeEventSandboxBoundaryFailureReason(event)) {
      unresolvedBoundaryFailure = true;
      continue;
    }
    if (unresolvedBoundaryFailure && !event.content.isError) {
      unresolvedBoundaryFailure = false;
      recoveredBoundaryFailure = true;
    }
  }
  return recoveredBoundaryFailure && !unresolvedBoundaryFailure;
}

function runtimeEventSandboxBoundaryFailureReason(
  event: InvocationResult['events'][number],
): SandboxBoundaryFailureReason | undefined {
  if (event.content?.kind !== 'function_response' || !isRecord(event.content.result)) {
    return undefined;
  }
  const failure = event.content.result.sandboxFailure;
  return isRecord(failure) ? normalizeSandboxBoundaryFailureReason(failure.reason) : undefined;
}

function normalizeSandboxBoundaryFailureReason(
  reason: unknown,
): SandboxBoundaryFailureReason | undefined {
  return reason === 'sandbox_boundary_required' || reason === 'requires_bypass'
    ? reason
    : undefined;
}

function invocationCompletedWithOutput(
  result: InvocationResult | undefined,
): result is InvocationResult & { status: 'completed'; finalOutput: string } {
  return result?.status === 'completed' && typeof result.finalOutput === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
