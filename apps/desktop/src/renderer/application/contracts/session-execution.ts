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

import type { SessionExecutionProjection } from '../../../shared/session-execution-projection.js';
export type {
  HostPendingInteractionKind,
  SessionExecutionProjection,
} from '../../../shared/session-execution-projection.js';

/**
 * Whether a projection write invalidates a settled-history read.
 *
 * Producers call this on every write, where both frames of a batched
 * transition are still visible. Comparing rendered snapshots instead would
 * miss an `available → unavailable → available` sequence React batches into
 * one commit, and the settled turn would never be reread.
 */
export function executionInvalidatesHistory(
  previous: SessionExecutionProjection | undefined,
  next: SessionExecutionProjection | undefined,
): boolean {
  if (!next?.available || next.rootTurn) return false;
  if (!previous?.available) return true;
  return previous.rootTurn !== null;
}

/** A projection plus the producer's invalidation counter for it. */
export interface ExecutionHistoryState {
  readonly sessionId: string;
  readonly projection: SessionExecutionProjection | undefined;
  readonly historyEpoch: number;
}

/**
 * The one place the producer-side epoch advances. The Session identity travels
 * with the projection so a navigation render can never pair the new id with the
 * previous Session's execution.
 */
export function advanceExecutionHistory(
  current: ExecutionHistoryState,
  sessionId: string,
  projection: SessionExecutionProjection | undefined,
): ExecutionHistoryState {
  if (current.sessionId === sessionId && current.projection === projection) return current;
  const sameSession = current.sessionId === sessionId;
  return {
    sessionId,
    projection,
    historyEpoch: (sameSession ? current.historyEpoch : 0)
      + (sameSession && executionInvalidatesHistory(current.projection, projection) ? 1 : 0),
  };
}

/** Retain the last nonterminal identity for Stop and conservative controls even when observation is unavailable. */
export function activeHostTurn(projection: SessionExecutionProjection | undefined) {
  const turn = projection?.rootTurn;
  return turn && turn.status !== 'completed' && turn.status !== 'failed' && turn.status !== 'cancelled'
    ? turn : undefined;
}

/**
 * A failed observation is a different fact from an unread projection, but it is
 * not a reason to forget the turn identity Stop and other conservative controls
 * rely on: mark the known projection unavailable and keep its root. Before the
 * first seed there is nothing to keep, so report an empty unavailable one.
 */
export function unavailableExecutionProjection(
  previous: SessionExecutionProjection | undefined,
): SessionExecutionProjection {
  if (previous?.available) return { ...previous, available: false };
  return previous ?? {
    type: 'host_execution',
    available: false,
    rootTurn: null,
    pendingInteractionKinds: [],
  };
}

/** Presentation fields only; the Host retains ownership of the lifecycle. */
export function chatTurnActivity(projection: SessionExecutionProjection | undefined) {
  if (!projection?.available) return undefined;
  const turn = activeHostTurn(projection);
  return turn ? {
    turnId: turn.turnId,
    awaitingInput: turn.status === 'waiting_for_user',
    compacting: turn.rootExecutionKind === 'context_compact',
  } : undefined;
}
