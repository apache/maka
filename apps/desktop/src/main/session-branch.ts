import type { BranchFromTurnInput, SessionSummary } from '@maka/core';
import { normalizeBranchFromTurnInput } from './permission-response-guard.js';

export async function handleBranchFromTurn(
  sessionId: string,
  input: unknown,
  deps: {
    ensureSessionWorkspaceAvailable(id: string): Promise<void>;
    branchFromTurn(id: string, input: BranchFromTurnInput): Promise<SessionSummary>;
    afterCreate?(session: SessionSummary): Promise<void>;
    emitCreated(id: string): void;
  },
): Promise<SessionSummary> {
  await deps.ensureSessionWorkspaceAvailable(sessionId);
  const session = await deps.branchFromTurn(sessionId, normalizeBranchFromTurnInput(input));
  await deps.afterCreate?.(session);
  deps.emitCreated(session.id);
  return session;
}
