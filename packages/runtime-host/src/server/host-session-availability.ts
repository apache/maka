import type { RootExecutionDescriptor } from '@maka/core/agent-run';
import type { SessionHeader } from '@maka/core/session';

const WORKTREE_CHILD_UNAVAILABLE_REASON =
  'Worktree child Sessions must be continued through their parent agent.';
const CHILD_CONTINUATION_UNAVAILABLE_REASON =
  'Child Sessions must be continued through their parent agent.';

export function runtimeHostAutomationSessionUnavailableReason(
  header: Pick<SessionHeader, 'collaborationMode'>,
): string | undefined {
  if (header.collaborationMode === 'plan') {
    return 'Automations cannot execute while the target Session is in Plan mode.';
  }
  return undefined;
}

export function runtimeHostExternalTurnUnavailableReason(
  header: Pick<SessionHeader, 'collaborationMode' | 'subagentWorkspace'>,
): string | undefined {
  return runtimeHostExecutionUnavailableReason(header, { kind: 'external_message' });
}

export function runtimeHostSafeBoundaryContinuationUnavailableReason(
  header: Pick<SessionHeader, 'subagentParent'>,
): string | undefined {
  return header.subagentParent ? CHILD_CONTINUATION_UNAVAILABLE_REASON : undefined;
}

export function runtimeHostExecutionUnavailableReason(
  header: Pick<SessionHeader, 'collaborationMode' | 'subagentWorkspace'>,
  execution: RootExecutionDescriptor,
): string | undefined {
  return (
    (header.collaborationMode === 'plan' &&
    execution.kind !== 'external_message' &&
    execution.kind !== 'regenerate' &&
    execution.kind !== 'context_compact' &&
    execution.kind !== 'safe_boundary_continuation'
      ? 'Background and delegated roots cannot execute while the Session is in Plan mode.'
      : undefined) ??
    (header.subagentWorkspace && !isManagedWorktreeChildExecution(execution)
      ? WORKTREE_CHILD_UNAVAILABLE_REASON
      : undefined)
  );
}

function isManagedWorktreeChildExecution(execution: RootExecutionDescriptor): boolean {
  return (
    execution.kind === 'linked_child_initial' ||
    execution.kind === 'linked_child_resume' ||
    execution.kind === 'linked_child_provider_retry' ||
    execution.kind === 'claimed_agent_graph_intent'
  );
}
