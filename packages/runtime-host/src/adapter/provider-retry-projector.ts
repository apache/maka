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

import type { ProviderRetryEvent } from '@maka/core/events';
import type { LiveTurnSnapshot, TurnProviderRetry, TurnSnapshot } from '../protocol/index.js';

export function seedProviderRetry(
  turn: LiveTurnSnapshot,
  now: number,
): ProviderRetryEvent | undefined {
  return turn.providerRetry ? retryEvent(turn, turn.providerRetry, now) : undefined;
}

export function projectProviderRetryChange(
  previous: TurnSnapshot | null | undefined,
  next: TurnSnapshot | null | undefined,
  now: number,
): ProviderRetryEvent | undefined {
  if (!isLiveTurn(next) || !next.providerRetry) return undefined;
  const prior =
    isLiveTurn(previous) && previous.runId === next.runId ? previous.providerRetry : undefined;
  return sameRetry(prior, next.providerRetry)
    ? undefined
    : retryEvent(next, next.providerRetry, now);
}

function retryEvent(
  turn: LiveTurnSnapshot,
  retry: TurnProviderRetry,
  now: number,
): ProviderRetryEvent {
  const base = {
    type: 'provider_retry' as const,
    id: `host-retry:${turn.runId}:${retry.phase}:${retry.attempt}`,
    turnId: turn.turnId,
    ts: now,
    attempt: retry.attempt,
    maxAttempts: retry.maxAttempts,
    reason: retry.reason,
  };
  if (retry.phase === 'started') return { ...base, phase: 'started' };

  const elapsed = retry.ts === undefined ? 0 : Math.max(0, now - retry.ts);
  return {
    ...base,
    phase: 'scheduled',
    delayMs: retry.delayMs,
    remainingMs: Math.max(0, retry.delayMs - elapsed),
  };
}

function sameRetry(left: TurnProviderRetry | undefined, right: TurnProviderRetry): boolean {
  if (
    !left ||
    left.phase !== right.phase ||
    left.attempt !== right.attempt ||
    left.maxAttempts !== right.maxAttempts ||
    left.reason !== right.reason
  ) {
    return false;
  }
  return (
    left.phase === 'started' ||
    (right.phase === 'scheduled' && left.delayMs === right.delayMs && left.ts === right.ts)
  );
}

function isLiveTurn(turn: TurnSnapshot | null | undefined): turn is LiveTurnSnapshot {
  return (
    !!turn && turn.status !== 'completed' && turn.status !== 'failed' && turn.status !== 'cancelled'
  );
}
