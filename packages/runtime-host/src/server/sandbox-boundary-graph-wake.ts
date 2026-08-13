import type { SessionHeader } from '@maka/core/session';
import type { AgentGraphInstanceStore } from '@maka/core/agent-graph-instance';

export interface SandboxBoundaryGraphWakeHeaderReader {
  readHeaderSnapshot(sessionId: string): Promise<Pick<SessionHeader, 'id' | 'subagentParent'>>;
}

/** Resolve the root Session whose parked graph wake a boundary answer can release. */
export async function sandboxBoundaryGraphWakeRoot(
  header: Pick<SessionHeader, 'id' | 'subagentParent'>,
  graphInstances?: Pick<AgentGraphInstanceStore, 'listAgentGraphInstances'>,
): Promise<string | undefined> {
  const parent = header.subagentParent;
  if (!parent) return header.id;
  if (!parent.graph) return undefined;
  if (!graphInstances) {
    throw new Error('Graph operator lineage requires the graph instance authority');
  }
  const owned = await graphInstances.listAgentGraphInstances(parent.parentSessionId);
  if (!owned.some((instance) => instance.graphId === parent.graph?.graphId)) {
    throw new Error(
      `Graph operator Session ${header.id} does not match root Session ${parent.parentSessionId}`,
    );
  }
  return parent.parentSessionId;
}

/** Resolve durable lineage before notifying the root graph supervisor. */
export async function notifySandboxBoundaryGraphWake(
  sessionId: string,
  sessions: SandboxBoundaryGraphWakeHeaderReader,
  graphInstances: Pick<AgentGraphInstanceStore, 'listAgentGraphInstances'>,
  notifyPermissionResponse: (rootSessionId: string) => Promise<void> | void,
): Promise<void> {
  const header = await sessions.readHeaderSnapshot(sessionId);
  const rootSessionId = await sandboxBoundaryGraphWakeRoot(header, graphInstances);
  if (rootSessionId) await notifyPermissionResponse(rootSessionId);
}
