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

/**
 * Pure model-wait derivation for the two turn-wait cues (#646).
 *
 * A turn has two kinds of "nothing is streaming right now" lulls, and they must
 * read differently:
 *   - `processing` — the connect-to-first-token wait at the turn head, before
 *     any event has arrived. The screen is otherwise empty, so it earns the
 *     prominent "正在处理…" indicator.
 *   - `continuing` — a mid-turn lull AFTER the turn has already produced content
 *     (a tool settled, a step's text finished) while the model works on the next
 *     step. The prior steps are already on screen, so this earns only a calm
 *     "继续中…" hint, never "正在处理…" (which would flicker on after every step
 *     and read as if the live thinking had been swallowed — the #646 regression
 *     this split fixes).
 *
 * The single dimension that separates them is the turn PHASE: `'waiting'` until
 * the first content event, `'streamed'` after. Kept free of React so the
 * derivation is unit-tested directly. The rising-edge debounce that reveals
 * these cues (`createDelayedFlag` / `useDelayedFlag`) and the running-status
 * line's `RUNNING_STATUS_DELAY_MS` live in `@maka/ui` so the side-conversation
 * feature can share them.
 */

/** Rising-edge delay before the first-token processing indicator appears. Tunable. */
export const MODEL_PROCESSING_DELAY_MS = 200;

/**
 * Rising-edge delay before the mid-turn "继续中…" hint appears. Longer than the
 * first-token delay so a quick hop between two fast steps never flashes it — the
 * hint is only worth showing once a step-to-step lull is visibly stalling.
 */
export const MODEL_CONTINUING_DELAY_MS = 600;

/**
 * A turn's coarse phase from the renderer's point of view. Absent (no entry) =
 * no turn in flight. `'waiting'` = armed at send, no content event yet.
 * `'streamed'` = the turn has emitted at least one content event.
 */
export type TurnPhase = 'waiting' | 'streamed';

/**
 * Whether a turn is running for the active session — the Stop affordance, and
 * the composer lock that rides with it.
 *
 * Two witnesses, ORed. They must never be ANDed: the local arm is the only
 * instant one, and gating it on a session-level witness meant a send opened
 * nothing until a status round-trip landed, then had it retracted by any list
 * refresh that resolved before the runtime's `running` write.
 *
 * `runningTurnIds` is read only for turns OTHER than the arm's. For the arm's
 * own turn the local projection knows more — it sees the terminal event first —
 * so a snapshot taken before that event must not light Stop back up. For any
 * other turn (another client, a scheduled task, one still running across a reload)
 * it is the only witness there is. It is a set because a session can run
 * concurrent turns, and the arm's own turn lingering in it must not hide a
 * sibling that is genuinely still running.
 */
export function deriveTurnActive(input: {
  /** The active session's live projection, if this renderer has one. */
  turnPhase: TurnPhase | undefined;
  armedTurnId: string | undefined;
  /** The turns the authority is running for this session. */
  runningTurnIds: readonly string[] | undefined;
}): boolean {
  if (input.turnPhase !== undefined) return true;
  return input.runningTurnIds?.some((turnId) => turnId !== input.armedTurnId) === true;
}

export interface ModelWaitInputs {
  /** Turn phase, or undefined when no turn is in flight. */
  turnPhase: TurnPhase | undefined;
  /** Whether the active assistant answer buffer has any content. */
  hasStreamingText: boolean;
  /** Whether the active reasoning buffer has any content. */
  hasThinkingText: boolean;
  /** Whether any live tool is still pending / running / awaiting permission. */
  hasInFlightTools: boolean;
}

/** Which wait cue (if any) the current turn state calls for. */
export type ModelWaitKind = 'none' | 'processing' | 'continuing';

/**
 * Which turn-wait cue to show. `'none'` whenever something is actively on
 * screen (streaming text / reasoning / an in-flight tool) or no turn is in
 * flight. Otherwise the turn is idle-waiting, and the PHASE decides: the
 * first-token head is `'processing'`, every later step-to-step lull is
 * `'continuing'`.
 */
export function deriveModelWait(input: ModelWaitInputs): ModelWaitKind {
  const idle = !input.hasStreamingText && !input.hasThinkingText && !input.hasInFlightTools;
  if (!idle || input.turnPhase === undefined) return 'none';
  return input.turnPhase === 'waiting' ? 'processing' : 'continuing';
}
