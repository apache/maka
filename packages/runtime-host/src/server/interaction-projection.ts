import {
  decodeInteractionAnswer,
  decodeInteractionCanonicalOutcome,
  interactionCanonicalOutcomesEquivalent,
  type InteractionAnswer,
  type InteractionCanonicalOutcome,
} from '@maka/core/interaction';
import {
  RuntimeInteractionInvariantError,
  type RuntimePermissionAnswer,
  type RuntimePermissionOutcome,
  type RuntimeUserQuestionOutcome,
} from '@maka/runtime';
import type {
  InteractionRecord,
  StoredInteractionOutcome,
  StoredInteractionRequest,
} from '@maka/storage/interaction-store';
import {
  INTERACTION_PENDING_REVISION,
  INTERACTION_RESOLVED_REVISION,
  INTERACTION_SCHEMA_VERSION,
  type InteractionAnsweredSnapshot,
  type InteractionPendingSnapshot,
  type InteractionSnapshot,
  type SessionInteractionProjection,
} from '../protocol/index.js';

export function projectInteractionRecord(record: InteractionRecord): InteractionSnapshot {
  const base = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    interactionId: record.request.requestId,
    sessionId: record.request.sessionId,
    turnId: record.request.turnId,
    runId: record.request.runId,
    request: record.request.request,
  } as const;
  const outcome = record.outcome?.outcome;
  if (!outcome) {
    return {
      ...base,
      revision: INTERACTION_PENDING_REVISION,
      status: 'pending',
      outcome: null,
    };
  }
  return outcome.kind === 'closure'
    ? { ...base, revision: INTERACTION_RESOLVED_REVISION, status: 'closed', outcome }
    : { ...base, revision: INTERACTION_RESOLVED_REVISION, status: 'answered', outcome };
}

export function projectPendingInteraction(
  request: StoredInteractionRequest,
): InteractionPendingSnapshot {
  return {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    interactionId: request.requestId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    runId: request.runId,
    revision: INTERACTION_PENDING_REVISION,
    request: request.request,
    status: 'pending',
    outcome: null,
  };
}

export function projectSessionInteractions(
  pending: readonly StoredInteractionRequest[],
): SessionInteractionProjection {
  return {
    pending: [...pending].sort(compareStoredInteractionRequests).map(projectPendingInteraction),
  };
}

export function compareStoredInteractionRequests(
  left: StoredInteractionRequest,
  right: StoredInteractionRequest,
): number {
  return left.createdAt - right.createdAt || left.requestId.localeCompare(right.requestId);
}

export function permissionInteractionAnswer(answer: RuntimePermissionAnswer): InteractionAnswer {
  return decodeInteractionAnswer({
    kind: 'permission',
    decision: answer.decision,
    rememberForTurn: answer.rememberForTurn ?? false,
  });
}

export function permissionCanonicalOutcome(
  answer: RuntimePermissionAnswer,
  committedAt: number,
): Exclude<InteractionCanonicalOutcome, { kind: 'closure' }> {
  const outcome = decodeInteractionCanonicalOutcome({
    kind: 'permission_answer',
    decision: answer.decision,
    rememberForTurn: answer.rememberForTurn ?? false,
    reviewer: answer.reviewer ?? 'user',
    ...(answer.riskLevel === undefined ? {} : { riskLevel: answer.riskLevel }),
    committedAt,
  });
  if (outcome.kind !== 'permission_answer') {
    throw new RuntimeInteractionInvariantError('Runtime permission answer decoded incorrectly');
  }
  return outcome;
}

export function wireCanonicalOutcome(
  answer: InteractionAnswer,
  committedAt: number,
): Exclude<InteractionCanonicalOutcome, { kind: 'closure' }> {
  if (answer.kind === 'question') {
    return { kind: 'question_answer', answers: [...answer.answers], committedAt };
  }
  return answer.decision === 'deny'
    ? {
        kind: 'permission_answer',
        decision: 'deny',
        rememberForTurn: false,
        reviewer: 'user',
        committedAt,
      }
    : {
        kind: 'permission_answer',
        decision: 'allow',
        rememberForTurn: answer.rememberForTurn,
        reviewer: 'user',
        committedAt,
      };
}

export function runtimePermissionOutcome(
  outcome: InteractionCanonicalOutcome,
): RuntimePermissionOutcome {
  if (outcome.kind === 'closure') return { kind: 'closure', reason: outcome.reason };
  if (outcome.kind !== 'permission_answer') {
    throw new RuntimeInteractionInvariantError(
      'Permission Interaction resolved with a question answer',
    );
  }
  return {
    kind: 'permission_answer',
    answer: {
      decision: outcome.decision,
      rememberForTurn: outcome.rememberForTurn,
      reviewer: outcome.reviewer,
      ...(outcome.riskLevel === undefined ? {} : { riskLevel: outcome.riskLevel }),
    },
  };
}

export function runtimeQuestionOutcome(
  outcome: InteractionCanonicalOutcome,
): RuntimeUserQuestionOutcome {
  if (outcome.kind === 'closure') {
    if (outcome.reason === 'timed_out') {
      throw new RuntimeInteractionInvariantError('Question Interaction resolved with a timeout');
    }
    return { kind: 'closure', reason: outcome.reason };
  }
  if (outcome.kind !== 'question_answer') {
    throw new RuntimeInteractionInvariantError(
      'Question Interaction resolved with a permission answer',
    );
  }
  return { kind: 'question_answer', answer: { answers: [...outcome.answers] } };
}

export function answerOutcome(
  record: InteractionRecord & { outcome: StoredInteractionOutcome },
  candidate: InteractionAnswer,
):
  | { readonly ok: true; readonly result: InteractionAnsweredSnapshot }
  | {
      readonly ok: false;
      readonly error: { readonly code: 'already_resolved'; readonly message: string };
    } {
  const snapshot = projectInteractionRecord(record);
  if (snapshot.status === 'closed') {
    return {
      ok: false,
      error: { code: 'already_resolved', message: 'Interaction was already closed' },
    };
  }
  if (snapshot.status !== 'answered') {
    throw new RuntimeInteractionInvariantError('Committed Interaction did not project as resolved');
  }
  const candidateOutcome = wireCanonicalOutcome(candidate, snapshot.outcome.committedAt);
  return interactionCanonicalOutcomesEquivalent(snapshot.outcome, candidateOutcome)
    ? { ok: true, result: snapshot }
    : {
        ok: false,
        error: {
          code: 'already_resolved',
          message: 'Interaction has a different canonical answer',
        },
      };
}
