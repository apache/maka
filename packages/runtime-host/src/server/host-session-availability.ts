import type { RootExecutionDescriptor } from '@maka/core/agent-run';
import { isDeepResearchSession, type SessionHeader } from '@maka/core/session';

const WORKTREE_CHILD_UNAVAILABLE_REASON =
  'Worktree child Sessions must be continued through their parent agent.';
const CHILD_CONTINUATION_UNAVAILABLE_REASON =
  'Child Sessions must be continued through their parent agent.';

export function runtimeHostSessionUnavailableReason(
  header: Pick<SessionHeader, 'collaborationMode' | 'labels'>,
): string | undefined {
  if (header.collaborationMode === 'plan') {
    return 'Plan sessions are not yet supported by Runtime Host.';
  }
  if (isDeepResearchSession(header.labels)) {
    return 'Deep Research sessions are not yet supported by Runtime Host.';
  }
  return undefined;
}

export function runtimeHostExternalTurnUnavailableReason(
  header: Pick<SessionHeader, 'collaborationMode' | 'labels' | 'subagentWorkspace'>,
): string | undefined {
  return runtimeHostExecutionUnavailableReason(header, { kind: 'external_message' });
}

export function runtimeHostSafeBoundaryContinuationUnavailableReason(
  header: Pick<
    SessionHeader,
    'collaborationMode' | 'labels' | 'subagentParent' | 'subagentWorkspace'
  >,
): string | undefined {
  return (
    runtimeHostSessionUnavailableReason(header) ??
    (header.subagentParent ? CHILD_CONTINUATION_UNAVAILABLE_REASON : undefined)
  );
}

export function runtimeHostExecutionUnavailableReason(
  header: Pick<SessionHeader, 'collaborationMode' | 'labels' | 'subagentWorkspace'>,
  execution: RootExecutionDescriptor,
): string | undefined {
  return (
    runtimeHostSessionUnavailableReason(header) ??
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
