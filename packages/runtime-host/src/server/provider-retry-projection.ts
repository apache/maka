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
import type { LiveTurnSnapshot, TurnProviderRetry } from '../protocol/index.js';
import type { CanonicalSessionProjection } from './canonical-session-projection.js';

export function recordProviderRetry(
  canonical: CanonicalSessionProjection,
  event: ProviderRetryEvent,
): CanonicalSessionProjection {
  const rootTurn = liveRoot(canonical);
  if (!rootTurn) return canonical;
  return {
    ...canonical,
    rootTurn: { ...rootTurn, providerRetry: retrySnapshot(event) },
  };
}

export function clearProviderRetry(
  canonical: CanonicalSessionProjection,
): CanonicalSessionProjection {
  const rootTurn = liveRoot(canonical);
  if (!rootTurn?.providerRetry) return canonical;
  const { providerRetry: _removed, ...withoutRetry } = rootTurn;
  return { ...canonical, rootTurn: withoutRetry };
}

export function carryProviderRetry(
  current: CanonicalSessionProjection,
  refreshed: CanonicalSessionProjection,
): CanonicalSessionProjection {
  const previous = liveRoot(current);
  const next = liveRoot(refreshed);
  if (
    !previous?.providerRetry ||
    !next ||
    previous.runId !== next.runId ||
    previous.turnId !== next.turnId ||
    next.providerRetry
  ) {
    return refreshed;
  }
  return { ...refreshed, rootTurn: { ...next, providerRetry: previous.providerRetry } };
}

function liveRoot(canonical: CanonicalSessionProjection): LiveTurnSnapshot | undefined {
  const root = canonical.rootTurn;
  if (
    !root ||
    root.status === 'completed' ||
    root.status === 'failed' ||
    root.status === 'cancelled'
  ) {
    return undefined;
  }
  return root;
}

function retrySnapshot(event: ProviderRetryEvent): TurnProviderRetry {
  const common = {
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    reason: event.reason,
  };
  return event.phase === 'started'
    ? { phase: 'started', ...common }
    : {
        phase: 'scheduled',
        ...common,
        delayMs: event.delayMs,
        ts: event.ts,
      };
}
