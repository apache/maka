import type { RuntimeContinuationSafetyObservation } from './runtime-resume.js';

export interface ResolvedWorkspaceIdentity {
  workspaceIdentity: string;
  canonicalPath: string;
}

export interface LocalContinuationSafetyInspectorDeps {
  readSessionCwd(sessionId: string): Promise<string>;
  resolveWorkspaceIdentity(cwd: string): Promise<ResolvedWorkspaceIdentity>;
  listAvailableToolNames(sessionId: string): Promise<readonly string[]>;
  hasPendingBackgroundOperations(sessionId: string): Promise<boolean>;
  readWorkspaceCheckpoint?: (
    sessionId: string,
  ) => Promise<RuntimeContinuationSafetyObservation['workspaceCheckpoint']>;
}

export function createLocalContinuationSafetyInspector(
  deps: LocalContinuationSafetyInspectorDeps,
): (sessionId: string) => Promise<RuntimeContinuationSafetyObservation> {
  return async (sessionId) => {
    const cwd = await deps.readSessionCwd(sessionId);
    const [workspace, availableToolNames, hasPendingBackgroundOperations, workspaceCheckpoint] =
      await Promise.all([
        deps.resolveWorkspaceIdentity(cwd),
        deps.listAvailableToolNames(sessionId),
        deps.hasPendingBackgroundOperations(sessionId),
        deps.readWorkspaceCheckpoint?.(sessionId),
      ]);
    return {
      workspaceIdentity: workspace.workspaceIdentity,
      workspacePath: workspace.canonicalPath,
      backgroundOperationsSettled: !hasPendingBackgroundOperations,
      availableToolNames: [...new Set(availableToolNames)].sort(),
      ...(workspaceCheckpoint ? { workspaceCheckpoint } : {}),
    };
  };
}
