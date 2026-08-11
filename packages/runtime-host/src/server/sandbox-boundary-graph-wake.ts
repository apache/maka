import type { SessionHeader } from '@maka/core/session';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';

export interface SandboxBoundaryGraphWakeHeaderReader {
  readHeaderSnapshot(sessionId: string): Promise<Pick<SessionHeader, 'id' | 'subagentParent'>>;
}

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

/** Resolve durable lineage before notifying the root graph supervisor. */
export async function notifySandboxBoundaryGraphWake(
  sessionId: string,
  sessions: SandboxBoundaryGraphWakeHeaderReader,
  notifyPermissionResponse: (rootSessionId: string) => Promise<void> | void,
): Promise<void> {
  const header = await sessions.readHeaderSnapshot(sessionId);
  const rootSessionId = sandboxBoundaryGraphWakeRoot(header);
  if (rootSessionId) await notifyPermissionResponse(rootSessionId);
}
