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

import type { LiveTurnProjection } from '@maka/ui';
import type { TurnPhase } from './model-wait-state.js';
import { hasInFlightToolActivity } from './session-event-health.js';

/**
 * The low-entropy reading of a live turn: everything the shell derives from the
 * active projection EXCEPT the streamed content itself.
 *
 * #1985: a text delta changes the projection on every token, but it changes
 * none of these values once a turn is under way. The shell (and through it the
 * sidebar, the composer, and every non-chat surface) subscribes to this
 * snapshot, so a stream only re-renders the chat transcript — the one surface
 * that genuinely reads the growing text.
 *
 * Keep this free of buffers, arrays, and maps. Anything whose identity changes
 * per delta belongs to the chat surface, not here.
 */
export interface LiveTurnSnapshot {
  /** The projected turn's id, kept even once terminal — `deriveTurnActive`'s arm. */
  turnId: string | undefined;
  /** Turn phase, or undefined when no turn is in flight (incl. a settled one). */
  phase: TurnPhase | undefined;
  /** Whether the active text step has emitted anything yet. */
  hasStreamingText: boolean;
  /** Step id of the settled answer, once complete — the handoff key. Its
   *  presence is also what says the text step is closed. */
  streamingMessageId: string | undefined;
  /** Whether the active reasoning step has emitted anything yet. */
  hasThinkingText: boolean;
  /** Whether the turn has any tool activity at all. */
  hasLiveTools: boolean;
  /** Whether any tool is still pending / running / awaiting permission. */
  hasInFlightTools: boolean;
}

const NO_LIVE_TURN: LiveTurnSnapshot = {
  turnId: undefined,
  phase: undefined,
  hasStreamingText: false,
  streamingMessageId: undefined,
  hasThinkingText: false,
  hasLiveTools: false,
  hasInFlightTools: false,
};

export function deriveLiveTurnSnapshot(projection: LiveTurnProjection | undefined): LiveTurnSnapshot {
  if (!projection) return NO_LIVE_TURN;
  const steps = projection.steps;
  const textStep = findLast(steps, (step) => Boolean(step.text));
  const thinkingStep = findLast(steps, (step) => Boolean(step.thinking));
  const streamingTextComplete = textStep?.text?.complete === true;
  return {
    turnId: projection.turnId,
    phase: projection.terminal ? undefined : projection.phase,
    hasStreamingText: (textStep?.text?.text.length ?? 0) > 0,
    streamingMessageId: streamingTextComplete ? textStep?.stepId : undefined,
    hasThinkingText: (thinkingStep?.thinking?.text.length ?? 0) > 0,
    hasLiveTools: steps.some((step) => step.tools.length > 0),
    hasInFlightTools: steps.some((step) => hasInFlightToolActivity(step.tools)),
  };
}

export function liveTurnSnapshotsEqual(a: LiveTurnSnapshot, b: LiveTurnSnapshot): boolean {
  return (
    a.turnId === b.turnId &&
    a.phase === b.phase &&
    a.hasStreamingText === b.hasStreamingText &&
    a.streamingMessageId === b.streamingMessageId &&
    a.hasThinkingText === b.hasThinkingText &&
    a.hasLiveTools === b.hasLiveTools &&
    a.hasInFlightTools === b.hasInFlightTools
  );
}

/**
 * Session ids with a live streaming delta — the sidebar pulse set.
 *
 * Membership is NOT turn-invariant (a session leaves between a settled step and
 * the next one), but it is delta-invariant, which is what the sidebar needs.
 * Pair it with `sessionIdSetsEqual`: the set is rebuilt on every projection
 * change, so only value equality keeps the sidebar off the token path.
 */
export function selectStreamingSessionIds(
  liveTurnBySession: Record<string, LiveTurnProjection>,
): Set<string> {
  const streaming = new Set<string>();
  for (const [sessionId, projection] of Object.entries(liveTurnBySession)) {
    if (projection.steps.some((step) => step.text?.text && !step.text.complete)) streaming.add(sessionId);
  }
  return streaming;
}

export function sessionIdSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
}
