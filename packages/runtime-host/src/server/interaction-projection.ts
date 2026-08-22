/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import {
  INTERACTION_CLOSURE_REASONS,
  interactionCanonicalOutcomesEquivalent,
  projectInteractionSandboxBoundaryRequest,
  type InteractionAnswer,
  type InteractionCanonicalOutcome,
} from '@maka/core/interaction';
import type { SandboxBoundaryRequest } from '@maka/core/sandbox-boundary';
import {
  RuntimeInteractionInvariantError,
  type RuntimeUserQuestionOutcome,
} from '@maka/runtime/interaction-authority';
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
  sandboxBoundaries: readonly SandboxBoundaryRequest[] = [],
): SessionInteractionProjection {
  return {
    pending: [
      ...pending.map((request) => ({
        createdAt: request.createdAt,
        interactionId: request.requestId,
        snapshot: projectPendingInteraction(request),
      })),
      ...sandboxBoundaries.map((request) => ({
        createdAt: request.createdAt,
        interactionId: request.requestId,
        snapshot: projectPendingSandboxBoundaryInteraction(request),
      })),
    ]
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.interactionId.localeCompare(right.interactionId),
      )
      .map(({ snapshot }) => snapshot),
  };
}

export function projectSandboxBoundaryInteraction(
  request: SandboxBoundaryRequest,
): InteractionSnapshot {
  const base = sandboxBoundaryInteractionBase(request);
  if (request.status === 'pending') {
    return {
      ...base,
      revision: INTERACTION_PENDING_REVISION,
      status: 'pending',
      outcome: null,
    };
  }
  const closureReason = INTERACTION_CLOSURE_REASONS.find(
    (reason) => reason === request.outcomeReason,
  );
  if (closureReason) {
    return {
      ...base,
      revision: INTERACTION_RESOLVED_REVISION,
      status: 'closed',
      outcome: {
        kind: 'closure',
        reason: closureReason,
        committedAt: requireSandboxBoundarySettledAt(request),
      },
    };
  }
  return {
    ...base,
    revision: INTERACTION_RESOLVED_REVISION,
    status: 'answered',
    outcome: sandboxBoundaryCanonicalOutcome(request),
  };
}

export function projectPendingSandboxBoundaryInteraction(
  request: SandboxBoundaryRequest,
): InteractionPendingSnapshot {
  const snapshot = projectSandboxBoundaryInteraction(request);
  if (snapshot.status !== 'pending') {
    throw new RuntimeInteractionInvariantError(
      `Sandbox boundary Interaction ${request.requestId} is already resolved`,
    );
  }
  return snapshot;
}

export function compareStoredInteractionRequests(
  left: StoredInteractionRequest,
  right: StoredInteractionRequest,
): number {
  return left.createdAt - right.createdAt || left.requestId.localeCompare(right.requestId);
}

export function questionCanonicalOutcome(
  answer: Extract<InteractionAnswer, { kind: 'question' }>,
  committedAt: number,
): Extract<InteractionCanonicalOutcome, { kind: 'question_answer' }> {
  return { kind: 'question_answer', answers: [...answer.answers], committedAt };
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
  const candidateOutcome = canonicalOutcomeForHistoricalAnswer(
    candidate,
    snapshot.outcome.committedAt,
  );
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

function canonicalOutcomeForHistoricalAnswer(
  answer: InteractionAnswer,
  committedAt: number,
): Exclude<InteractionCanonicalOutcome, { kind: 'closure' }> {
  if (answer.kind === 'question') {
    return questionCanonicalOutcome(answer, committedAt);
  }
  if (answer.kind === 'sandbox_boundary') {
    throw new RuntimeInteractionInvariantError(
      'Sandbox boundary answers require their canonical boundary settlement',
    );
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

function sandboxBoundaryInteractionBase(request: SandboxBoundaryRequest) {
  if (!request.turnId || !request.runId) {
    throw new RuntimeInteractionInvariantError(
      `Sandbox boundary ${request.requestId} has no hosted Run provenance`,
    );
  }
  return {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    interactionId: request.requestId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    runId: request.runId,
    request: projectInteractionSandboxBoundaryRequest(request),
  } as const;
}

function sandboxBoundaryCanonicalOutcome(
  request: SandboxBoundaryRequest,
): Extract<InteractionCanonicalOutcome, { kind: 'sandbox_boundary_decision' }> {
  if (request.status === 'pending') {
    throw new RuntimeInteractionInvariantError(
      `Sandbox boundary Interaction ${request.requestId} is still pending`,
    );
  }
  return {
    kind: 'sandbox_boundary_decision',
    decision: request.status === 'denied' ? 'deny' : 'allow',
    status: request.status,
    committedAt: requireSandboxBoundarySettledAt(request),
  };
}

function requireSandboxBoundarySettledAt(request: SandboxBoundaryRequest): number {
  if (request.settledAt === undefined) {
    throw new RuntimeInteractionInvariantError(
      `Sandbox boundary Interaction ${request.requestId} has no settlement timestamp`,
    );
  }
  return request.settledAt;
}
