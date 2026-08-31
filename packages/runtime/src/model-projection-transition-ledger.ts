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
 * The Session-scoped reducer over durable model-projection transitions (#4283).
 *
 * One authority, one direction: the append-only operational AgentRunEvent
 * ledger holds the transitions, this module folds them onto the canonical
 * RuntimeEvent stream, and every consumer of model-facing history — the live
 * continuation, the next Turn, a cold restart, rolling compaction, a branch —
 * reads the result of that fold rather than the raw events.
 *
 * Two rules make the fold deterministic regardless of who wrote what when:
 *
 * 1. Source-digest validation. A transition may only replace the exact
 *    projection it names. A writer that decided against a projection some other
 *    writer has already replaced is stale, and its record is inert forever —
 *    not applied later, not applied on another machine, not applied after a
 *    restart. This is what stops replaced content from coming back.
 * 2. Predecessor chaining. Within one target, a transition applies only when
 *    the transition it names as predecessor is the one currently in effect. The
 *    chain is also the fold's ordering authority: successors are followed, never
 *    sorted, so ledger order, arrival order, run order and clock skew cannot
 *    disagree about the result.
 */

import type { AgentRunEvent, AgentRunStore } from '@maka/core/agent-run';
import {
  decodeModelProjectionTransition,
  durableToolResultProjectionDigest,
  MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
  type ModelProjectionTransition,
} from '@maka/core/model-projection-transition';
import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import type { RuntimeEvent } from '@maka/core/runtime-event';

import {
  compatibilityToolResultProjection,
  durableProjectionToToolResultOutput,
} from './durable-tool-result-projection.js';

export interface EffectiveModelProjectionReduction {
  /** The events every model-history consumer must read instead of the raw ledger. */
  events: RuntimeEvent[];
  /** Transitions that took effect, in reduction order. */
  applied: ModelProjectionTransition[];
  /**
   * Transitions the fold refused: a stale source digest or a broken predecessor
   * chain. They stay durable and stay inert — a refusal is not a retry.
   */
  rejected: ModelProjectionTransition[];
  /**
   * Records in the ledger this build could not decode.
   *
   * A reader that cannot interpret the whole chain may still show what it did
   * fold, but it must not commit a successor onto a state it only partly knows.
   */
  undecodable: number;
}

/**
 * Read every transition this session has committed.
 *
 * Sparse per-event records have no max-coverage lineage to select from, so —
 * unlike the compaction checkpoint — there is no single-row projection to read
 * here: the whole set is the state.
 */
export async function loadModelProjectionTransitionsFromRunLedger(
  runStore: Pick<AgentRunStore, 'listSessionRuns' | 'readEvents'>,
  sessionId: string,
): Promise<LoadedModelProjectionTransitions> {
  const byId = new Map<string, ModelProjectionTransition>();
  let undecodable = 0;
  for (const run of await runStore.listSessionRuns(sessionId)) {
    for (const event of await runStore.readEvents(sessionId, run.runId)) {
      if (event.type !== MODEL_PROJECTION_TRANSITION_EVENT_TYPE) continue;
      const transition = decodeLedgerTransition(event, sessionId);
      if (!transition) {
        undecodable += 1;
        continue;
      }
      // A content-derived id makes a duplicated concurrent append idempotent.
      if (!byId.has(transition.transitionId)) byId.set(transition.transitionId, transition);
    }
  }
  return { transitions: [...byId.values()], undecodable };
}

export interface LoadedModelProjectionTransitions {
  transitions: ModelProjectionTransition[];
  /** Ledger records of the right type that this build could not decode. */
  undecodable: number;
}

export function decodeLedgerTransition(
  event: AgentRunEvent,
  sessionId: string,
): ModelProjectionTransition | undefined {
  if (event.type !== MODEL_PROJECTION_TRANSITION_EVENT_TYPE) return undefined;
  try {
    return decodeModelProjectionTransition(event.data?.transition, sessionId);
  } catch {
    // A record this build cannot decode is not a licence to show the replaced
    // content again — but neither can it be applied. It stays out of the fold.
    return undefined;
  }
}

/**
 * The effective projection of one `function_response` event, before any
 * transition: what the durable schema holds, or what the single compatibility
 * codec makes of a legacy event. `undefined` means provider-native opaque
 * state, which no transition may address.
 */
export function baseToolResultProjection(
  event: RuntimeEvent,
): DurableToolResultProjection | undefined {
  const content = event.content;
  if (content?.kind !== 'function_response') return undefined;
  if (content.providerExecuted === true && content.providerOutput !== undefined) return undefined;
  return compatibilityToolResultProjection(content, event.sessionId);
}

export function reduceEffectiveModelProjections(
  events: readonly RuntimeEvent[],
  transitions: readonly ModelProjectionTransition[],
  undecodable = 0,
): EffectiveModelProjectionReduction {
  const applied: ModelProjectionTransition[] = [];
  const rejected: ModelProjectionTransition[] = [];
  if (transitions.length === 0) {
    return { events: [...events], applied, rejected, undecodable };
  }

  const byTarget = new Map<string, ModelProjectionTransition[]>();
  for (const transition of transitions) {
    const key = targetKey(transition.target.runtimeEventId, transition.target.part);
    const group = byTarget.get(key);
    if (group) group.push(transition);
    else byTarget.set(key, [transition]);
  }

  const nextEvents = events.map((event) => {
    const group = byTarget.get(targetKey(event.id, 'tool_result'));
    if (!group) return event;
    const base = baseToolResultProjection(event);
    if (!base) {
      for (const transition of group) rejected.push(transition);
      return event;
    }
    const content = event.content;
    if (content?.kind !== 'function_response') return event;

    let current = base;
    let currentDigest = durableToolResultProjectionDigest(current);
    let previousTransitionId: string | undefined;
    let changed = false;
    const remaining = new Set(group);
    // Follow the chain instead of sorting it. Only the successor of what is
    // currently in effect can apply, so the fold needs no cursor and no
    // tie-break on anything the writer's clock or run decided.
    for (;;) {
      const next = nextInChain(remaining, previousTransitionId, currentDigest, content);
      if (!next) break;
      remaining.delete(next);
      current = next.replacement;
      currentDigest = durableToolResultProjectionDigest(current);
      previousTransitionId = next.transitionId;
      changed = true;
      applied.push(next);
    }
    for (const transition of remaining) rejected.push(transition);
    if (!changed) return event;
    return {
      ...event,
      content: {
        ...content,
        // `result` is rewritten alongside the projection so a consumer that
        // still reads the legacy field cannot resurrect the replaced body.
        result: legacyResultForProjection(current),
        modelProjection: current,
      },
    } satisfies RuntimeEvent;
  });

  return { events: nextEvents, applied, rejected, undecodable };
}

/**
 * The one transition that may apply next to this target.
 *
 * Two writers can name the same predecessor — a concurrent append that lost the
 * race, or a retry of the same decision. Both are refused unless they also match
 * the digest currently in effect, and among equals the smallest content-derived
 * id wins, so every reader picks the same successor without consulting a clock.
 */
function nextInChain(
  remaining: ReadonlySet<ModelProjectionTransition>,
  previousTransitionId: string | undefined,
  currentDigest: string,
  content: { id: string; name: string },
): ModelProjectionTransition | undefined {
  let best: ModelProjectionTransition | undefined;
  for (const transition of remaining) {
    if (
      transition.previousTransitionId !== previousTransitionId ||
      transition.sourceProjectionDigest !== currentDigest ||
      transition.target.toolCallId !== content.id ||
      transition.target.toolName !== content.name
    ) {
      continue;
    }
    if (!best || transition.transitionId < best.transitionId) best = transition;
  }
  return best;
}

function legacyResultForProjection(projection: DurableToolResultProjection): unknown {
  const output = durableProjectionToToolResultOutput(projection);
  return output.type === 'execution-denied'
    ? { kind: 'text', text: output.reason ?? '' }
    : output.value;
}

function targetKey(runtimeEventId: string, part: string): string {
  return `${runtimeEventId}::${part}`;
}
