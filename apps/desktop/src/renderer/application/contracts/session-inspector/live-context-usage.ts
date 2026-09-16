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
import type { ContextDiagnosticsResult } from '@maka/runtime-host/protocol';
import { createTraceRefreshCoalescer, type TraceRefreshCoalescer } from './session-trace-refresh.js';

/**
 * What the composer is about to send on, and therefore the only route a
 * context figure may describe (#4717).
 *
 * The gauge next to the model picker answers "how full is the window THIS
 * model sees". A token count is one model's number in one tokenizer, so a
 * snapshot from another route says nothing about that: model A's tokens
 * against model B's window is a precise-looking lie, the same refusal
 * `selectLatestRequestUsage` makes for the turn-end anchor. The snapshot has
 * no connectionId — the Host records the provider, not the connection — so
 * (providerType, modelId) is the tightest pair it can vouch for.
 */
export interface LiveContextRoute {
  readonly model?: string;
  readonly providerType?: string;
}

/** The gauge's reading: the last settled request's prompt, and its ceiling. */
export interface LiveContextUsage {
  readonly usageTokens: number;
  /** The window the request was metered against, frozen at call time. */
  readonly contextWindow?: number;
}

/**
 * Maps a context diagnostics snapshot onto the gauge, or refuses.
 *
 * "Used" is `inputTokens` — the prompt of the most recent settled request.
 * That is deliberately NOT input+output: the snapshot does not carry output,
 * and the inspector's context bar reads the same field. The frozen
 * `contextWindow` travels with the tokens, so the gauge can divide one row's
 * numerator by the same row's denominator exactly as the inspector's bar
 * does — a window from the live catalog could disagree with the metered
 * request, while a user-declared override still wins by design.
 */
export function liveContextUsageFromDiagnostics(
  diagnostics: ContextDiagnosticsResult | undefined,
  route: LiveContextRoute,
): LiveContextUsage | undefined {
  if (!diagnostics || diagnostics.status !== 'available') return undefined;
  if (route.model === undefined || route.providerType === undefined) return undefined;
  if (diagnostics.modelId !== route.model || diagnostics.providerId !== route.providerType) {
    return undefined;
  }
  const inputTokens = diagnostics.inputTokens;
  if (inputTokens === undefined || !Number.isFinite(inputTokens) || inputTokens <= 0) {
    return undefined;
  }
  return {
    usageTokens: inputTokens,
    ...(diagnostics.contextWindow !== undefined
      ? { contextWindow: diagnostics.contextWindow }
      : {}),
  };
}

export interface LiveContextUsageTarget {
  readonly sessionId: string;
  readonly route: LiveContextRoute;
}

/**
 * Identity, not reference: two targets answer the same question when their
 * session and route match field by field.
 */
function sameLiveContextUsageTarget(
  left: LiveContextUsageTarget | undefined,
  right: LiveContextUsageTarget | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.sessionId === right.sessionId &&
    left.route.model === right.route.model &&
    left.route.providerType === right.route.providerType
  );
}

export interface LiveContextUsageTracker {
  /** Aims the tracker at a session, or at nothing. Reads immediately. */
  setTarget(target: LiveContextUsageTarget | undefined): void;
  /** Records a live event; schedules a re-read when it can change the snapshot. */
  observe(event: SessionEvent): void;
  /** Drops any scheduled or in-flight read; the last reported value stands. */
  dispose(): void;
}

/**
 * Keeps the composer gauge on the per-request snapshot rather than the
 * per-turn anchor.
 *
 * The Host seals `latest_context` when each provider request settles, so the
 * finest honest granularity is "after each step" — token-level real-time
 * mid-stream is impossible, since the provider only reports input tokens at
 * completion (#4545 spells out why the alternatives were rejected). This
 * tracker pulls that snapshot on the same signal the inspector uses — the
 * trace-relevant live events, coalesced — with the three protections the
 * inspector proved out: a revision counter drops reads that answer an older
 * question, a failed read keeps the last value standing, and a target change
 * clears that value first and discards whatever is still in flight. The last
 * two compose rather than collide: the value kept standing is only ever the
 * CURRENT target's, because switching targets clears the previous target's
 * reading before the first read on the new one — a rejected first read must
 * not pin the old target's number in place.
 *
 * Framework-free on purpose: the timer and the query are injected, so the
 * policy is testable without a DOM, and the hook in
 * `use-live-context-usage.ts` is a thin React shell over this.
 */
export function createLiveContextUsageTracker(input: {
  query: (sessionId: string) => Promise<ContextDiagnosticsResult>;
  delayMs: number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
  onChange: (usage: LiveContextUsage | undefined) => void;
}): LiveContextUsageTracker {
  let target: LiveContextUsageTarget | undefined;
  let revision = 0;
  const coalescer: TraceRefreshCoalescer = createTraceRefreshCoalescer({
    refresh: () => refresh(),
    delayMs: input.delayMs,
    schedule: input.schedule,
    cancel: input.cancel,
  });

  function refresh(): void {
    const current = target;
    if (!current) return;
    const readRevision = ++revision;
    void input.query(current.sessionId).then(
      (diagnostics) => {
        if (readRevision !== revision) return;
        input.onChange(liveContextUsageFromDiagnostics(diagnostics, current.route));
      },
      () => {
        // A failed read leaves the last value standing: it is still the newest
        // answer anyone has, and blanking it would report "no usage" for a
        // read that simply failed.
      },
    );
  }

  return {
    setTarget(next) {
      // Any target change — another session, another route, or none — makes
      // the current reading unanswerable until the next read lands, and
      // invalidates every read already in flight. A changed target clears the
      // reading on screen BEFORE the first read on the new one: that reading
      // answers the previous target's question, and a rejected first read
      // would otherwise pin it there indefinitely. Re-aiming at the SAME
      // target does not clear — the standing value still answers it, and
      // blanking it would flicker.
      revision += 1;
      const changed = !sameLiveContextUsageTarget(target, next);
      target = next;
      coalescer.cancel();
      if (!next) {
        input.onChange(undefined);
        return;
      }
      if (changed) input.onChange(undefined);
      refresh();
    },
    observe(event) {
      coalescer.observe(event);
    },
    dispose() {
      revision += 1;
      target = undefined;
      coalescer.cancel();
    },
  };
}
