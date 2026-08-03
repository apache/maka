import type { SessionHeader } from '@maka/core/session';
import { agentGraphIdForRootSession } from '@maka/runtime';

/** Resolve the root Session whose parked graph wake a boundary answer can release. */
export function sandboxBoundaryGraphWakeRoot(
  header: Pick<SessionHeader, 'id' | 'subagentParent'>,
): string | undefined {
  const parent = header.subagentParent;
  if (!parent) return header.id;
  if (!parent.graph) return undefined;
  if (parent.graph.graphId !== agentGraphIdForRootSession(parent.parentSessionId)) {
    throw new Error(
      `Graph operator Session ${header.id} does not match root Session ${parent.parentSessionId}`,
    );
  }
  return parent.parentSessionId;
}
