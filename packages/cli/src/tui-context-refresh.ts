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

import type { SessionEvent } from '@maka/core/events';

/**
 * How full the context is right now, re-asked mid-turn (#4545).
 *
 * The statusline ctx segment historically moved once per turn, when the
 * end-of-turn `token_usage` event landed — a long agentic turn burned context
 * for minutes with the indicator frozen at the previous turn's value. The Host
 * already commits a latest-context snapshot at every settled provider request
 * (the desktop inspector's data source), so the TUI pulls it on the same
 * signal desktop uses instead of growing a parallel push event.
 */

/**
 * When a live session's context snapshot is worth re-reading. Mirrors the
 * desktop inspector's TRACE_RELEVANT_EVENT_TYPES
 * (apps/desktop/src/renderer/session-trace-refresh.ts): the snapshot is
 * committed at each settled provider request, so the events that follow one —
 * tool boundaries above all — are the moments the answer can have changed.
 * That is deliberately not "every event": a streaming turn emits text deltas
 * continuously, and none of them moves the snapshot.
 */
const CTX_REFRESH_EVENT_TYPES: ReadonlySet<SessionEvent['type']> = new Set([
  'tool_start',
  'tool_result',
  'token_usage',
  'provider_retry',
  'error',
  'complete',
  'abort',
]);

export function isCtxRefreshRelevantEvent(event: SessionEvent): boolean {
  return CTX_REFRESH_EVENT_TYPES.has(event.type);
}

/**
 * Long enough to absorb a step boundary's event burst, short enough to feel
 * live. Same value and rationale as the desktop inspector's
 * TRACE_REFRESH_DEBOUNCE_MS.
 */
export const CTX_REFRESH_DEBOUNCE_MS = 400;

type CancelScheduled = () => void;

export interface CtxRefresher {
  /** Records an event; schedules a query when the event can have moved the snapshot. */
  observe(event: SessionEvent): void;
  /** Drops a scheduled query and retires any in-flight one. */
  cancel(): void;
}

/**
 * Coalesces a burst of refresh-worthy events into one query, and lets only
 * the latest issued query apply. A query that resolves after a newer one was
 * issued — or after `cancel` retired it — is dropped: the answer a slow read
 * brings back describes an older snapshot than the one already shown, and a
 * torn-down session is not owed an update at all. A failed query leaves the
 * last value standing: it is still the newest answer anyone has.
 *
 * The scheduler is injected so the policy is testable without a wall clock,
 * and follows the CLI's ticker convention: schedule returns the cancel.
 */
export function createCtxRefresher<T>(input: {
  query: () => Promise<T>;
  apply: (result: T) => void;
  delayMs: number;
  schedule: (callback: () => void, delayMs: number) => CancelScheduled;
}): CtxRefresher {
  let cancelScheduled: CancelScheduled | undefined;
  let revision = 0;
  const dropScheduled = (): void => {
    cancelScheduled?.();
    cancelScheduled = undefined;
  };
  const run = (): void => {
    cancelScheduled = undefined;
    const requestRevision = ++revision;
    void input.query().then(
      (result) => {
        if (requestRevision !== revision) return;
        input.apply(result);
      },
      () => {},
    );
  };
  return {
    observe(event) {
      if (!isCtxRefreshRelevantEvent(event)) return;
      // Restart rather than stack: the last event of a burst is the one whose
      // snapshot the reader wants, and an earlier timer would read before it.
      dropScheduled();
      cancelScheduled = input.schedule(run, input.delayMs);
    },
    cancel() {
      dropScheduled();
      revision += 1;
    },
  };
}

/** Default one-shot timer; unref'd so a pending refresh never holds the CLI open. */
export function scheduleCtxRefreshTimeout(callback: () => void, delayMs: number): CancelScheduled {
  const handle = setTimeout(callback, delayMs);
  handle.unref();
  return () => clearTimeout(handle);
}
