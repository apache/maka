/**
 * Minimal linked-Session projection for Work Board items.
 *
 * Phase 0 deliberately restricts this to facts directly available from the
 * current Session continuity contract plus the active turn. Recovery and
 * Agent Graph states are not synthesized here; they can be added only after
 * a canonical read interface and a real UI requirement exist.
 */

import { isSessionStatus, isTurnStatus, type SessionStatus, type TurnStatus } from './session.js';

export interface WorkBoardLinkedSessionProjection {
  sessionId: string;
  sessionStatus: SessionStatus | 'missing';
  currentTurn?: {
    turnId: string;
    runId: string;
    status: TurnStatus;
  };
}

/**
 * Pure read projection. Returns the normalized, readonly snapshot for one
 * linked Session. It never reads or writes the board store and never mutates
 * Runtime state.
 */
export function projectWorkBoardLinkedSession(
  facts: unknown,
): WorkBoardLinkedSessionProjection | null {
  if (!isRecord(facts)) return null;
  if (
    typeof facts.sessionId !== 'string' ||
    facts.sessionId.trim() !== facts.sessionId ||
    facts.sessionId.length === 0
  ) {
    return null;
  }
  if (facts.sessionStatus !== 'missing' && !isSessionStatus(facts.sessionStatus)) {
    return null;
  }
  if (facts.sessionStatus === 'missing') {
    if (facts.currentTurn !== undefined) return null;
    return { sessionId: facts.sessionId, sessionStatus: 'missing' };
  }
  if (facts.currentTurn === undefined) {
    return { sessionId: facts.sessionId, sessionStatus: facts.sessionStatus };
  }
  const currentTurn = facts.currentTurn;
  if (!isRecord(currentTurn)) return null;
  if (
    typeof currentTurn.turnId !== 'string' ||
    currentTurn.turnId.trim() !== currentTurn.turnId ||
    currentTurn.turnId.length === 0
  ) {
    return null;
  }
  if (
    typeof currentTurn.runId !== 'string' ||
    currentTurn.runId.trim() !== currentTurn.runId ||
    currentTurn.runId.length === 0
  ) {
    return null;
  }
  if (!isTurnStatus(currentTurn.status)) return null;
  return {
    sessionId: facts.sessionId,
    sessionStatus: facts.sessionStatus,
    currentTurn: {
      turnId: currentTurn.turnId,
      runId: currentTurn.runId,
      status: currentTurn.status,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
