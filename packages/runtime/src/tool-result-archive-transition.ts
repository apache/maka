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
 * The one writer that turns a Tool Result prune decision into durable truth
 * (#4283).
 *
 * Both prune paths — the current Turn's active prune before the next provider
 * step, and the prior Turn's stale prune before compaction — come through here.
 * They used to keep their replacement in a Turn-local map and a policy-carried
 * ref table respectively, so each owned a private recovery contract and neither
 * survived a restart. Now each records one `ModelProjectionTransition`, and the
 * Session reducer is the only thing that decides what the model sees.
 *
 * Write order is the whole safety argument:
 *
 * 1. Archive the replaced body. A failure here leaves the projection untouched.
 * 2. Append the transition. A failure here leaves an artifact nothing points
 *    at — unreachable by the reducer, so safe to reclaim once something does —
 *    and again leaves the projection untouched.
 * 3. Only then may a caller show the replacement.
 *
 * There is no state in which the model has lost content the ledger cannot
 * explain, and none in which a completed tool effect is repeated.
 */

import { MATERIALIZED_IMAGE_TOKENS } from '@maka/core/attachments';
import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import { DURABLE_TOOL_RESULT_PROJECTION_VERSION } from '@maka/core/durable-tool-result-projection';
import {
  buildModelProjectionTransition,
  type ModelProjectionTransition,
} from '@maka/core/model-projection-transition';
import type { RuntimeEvent } from '@maka/core/runtime-event';

import type { ActiveToolResultSupersession } from './active-tool-result-working-set.js';
import {
  estimateTokens,
  finitePositive,
  sha256,
  turnKey,
  utf8ByteLength,
} from './context-budget-helpers.js';
import {
  durableProjectionToToolResultOutput,
  projectionArtifactMedia,
} from './durable-tool-result-projection.js';
import { baseToolResultProjection, nextInChain } from './model-projection-transition-ledger.js';
import {
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  buildArchivedToolResultPlaceholder,
  isArchivedToolResultPlaceholder,
  serializeToolResultForArchive,
  type ArchivedToolResultPlaceholder,
  type ArchivedToolResultReason,
  type StaleToolResultArchiveCandidate,
  type StaleToolResultPrunePolicy,
} from './tool-result-archive.js';

const DEFAULT_MAX_TOOL_RESULT_ESTIMATED_TOKENS = 2048;

export type ModelProjectionTransitionRecorder = (
  transition: ModelProjectionTransition,
) => Promise<void>;

/**
 * What the model actually reads for one Tool Result, as bytes.
 *
 * Both the prune thresholds and the archived body are measured over the
 * effective durable projection rather than the raw execution fact: the
 * projection is what costs context, and archiving anything else would store a
 * body that is not the one removed from the model's view.
 */
export function serializedToolResultProjection(projection: DurableToolResultProjection): string {
  const output = durableProjectionToToolResultOutput(projection);
  return serializeToolResultForArchive(
    output.type === 'execution-denied' ? { kind: 'text', text: output.reason ?? '' } : output.value,
  );
}

/** The replacement a pruned Tool Result projects to. */
export function archivedToolResultProjection(
  placeholder: ArchivedToolResultPlaceholder,
): DurableToolResultProjection {
  return {
    version: DURABLE_TOOL_RESULT_PROJECTION_VERSION,
    kind: 'json',
    value: placeholder as unknown as Record<string, never>,
  };
}

export interface ToolResultArchiveTransitionServices {
  sessionId: string;
  archiveToolResult: (input: {
    sessionId: string;
    runtimeEventId: string;
    turnId: string;
    toolCallId: string;
    toolName: string;
    result: unknown;
    serializedResult: string;
    bodySha256: string;
    originalBytes: number;
    originalEstimatedTokens: number;
    rewriteVersion: typeof ARCHIVED_TOOL_RESULT_REWRITE_VERSION;
    reason: ArchivedToolResultReason;
  }) => Promise<{ artifactId: string } | void> | { artifactId: string } | void;
  recordTransition: ModelProjectionTransitionRecorder;
  /**
   * Re-read the durable ledger after an append.
   *
   * A successful append does not make this transition the fold's answer: a
   * concurrent Turn can append a rival successor to the same source, and the
   * fold accepts exactly one of them. Without this seam the caller would show a
   * replacement that the next read replaces with the other writer's.
   */
  loadTransitions?: () => Promise<{ transitions: ModelProjectionTransition[] }>;
  now: () => number;
}

export interface ToolResultArchiveTransitionRequest {
  runtimeEventId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  /** The projection this transition is allowed to replace. */
  sourceProjection: DurableToolResultProjection;
  serializedResult: string;
  originalBytes: number;
  originalEstimatedTokens: number;
  reason: ArchivedToolResultReason;
  previousTransitionId?: string;
  supersession?: ActiveToolResultSupersession;
  /** Raw execution fact kept only so the archive writer can name the artifact. */
  result?: unknown;
}

export interface ToolResultArchiveTransitionOutcome {
  placeholder: ArchivedToolResultPlaceholder;
  transition: ModelProjectionTransition;
}

/**
 * Archive one body and commit the transition that replaces its projection.
 *
 * Returns `undefined` when either durable step fails: the caller then leaves
 * the model-visible content exactly as it was, which is the only outcome that
 * keeps "visible history is append-only" true under partial failure.
 */
export async function archiveToolResultAsTransition(
  services: ToolResultArchiveTransitionServices,
  request: ToolResultArchiveTransitionRequest,
): Promise<ToolResultArchiveTransitionOutcome | undefined> {
  const bodySha256 = sha256(request.serializedResult);
  let archived: { artifactId: string } | void;
  try {
    archived = await Promise.resolve(
      services.archiveToolResult({
        sessionId: services.sessionId,
        runtimeEventId: request.runtimeEventId,
        turnId: request.turnId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        result: request.result,
        serializedResult: request.serializedResult,
        bodySha256,
        originalBytes: request.originalBytes,
        originalEstimatedTokens: request.originalEstimatedTokens,
        rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
        reason: request.reason,
      }),
    );
  } catch {
    return undefined;
  }
  const artifactId = archived?.artifactId;
  if (typeof artifactId !== 'string' || artifactId.trim().length === 0) return undefined;

  const placeholder = buildArchivedToolResultPlaceholder({
    artifactId,
    runtimeEventId: request.runtimeEventId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    bodySha256,
    originalEstimatedTokens: request.originalEstimatedTokens,
    originalBytes: request.originalBytes,
    reason: request.reason,
    ...(request.supersession ? { supersession: request.supersession } : {}),
  });

  let transition: ModelProjectionTransition;
  try {
    transition = buildModelProjectionTransition({
      sessionId: services.sessionId,
      target: {
        runtimeEventId: request.runtimeEventId,
        part: 'tool_result',
        toolCallId: request.toolCallId,
        toolName: request.toolName,
      },
      sourceProjection: request.sourceProjection,
      // The placeholder inside the replacement is the whole archive record:
      // artifact id, body digest and original size. The transition does not
      // repeat them — one fact, one place.
      replacement: archivedToolResultProjection(placeholder),
      ...(request.previousTransitionId
        ? { previousTransitionId: request.previousTransitionId }
        : {}),
      now: services.now(),
    });
    await services.recordTransition(transition);
    const winner = await winningTransition(services, transition);
    if (winner && winner.transitionId !== transition.transitionId) {
      // The rival won. Show what the ledger says, not what this writer wrote;
      // its own record stays durable and inert, and the body it archived is
      // unreachable exactly as a refused transition's archive should be.
      const replaced = winner.replacement.kind === 'json' ? winner.replacement.value : undefined;
      if (!isArchivedToolResultPlaceholder(replaced)) return undefined;
      return { placeholder: replaced, transition: winner };
    }
  } catch {
    // The archive artifact is now unreferenced: nothing in the effective
    // history names it, which is what reducer-derived reachability reports. It
    // is content-addressed, so a retry of the same decision reuses it rather
    // than publishing a second one. No cleanup pass consumes that reachability
    // yet, so such an artifact is retained until one does — it cannot break
    // replay, but it is not reclaimed either (#4283).
    return undefined;
  }
  return { placeholder, transition };
}

/** The transition the durable fold accepts for this target, after an append. */
async function winningTransition(
  services: ToolResultArchiveTransitionServices,
  appended: ModelProjectionTransition,
): Promise<ModelProjectionTransition | undefined> {
  if (!services.loadTransitions) return appended;
  const { transitions } = await services.loadTransitions();
  return nextInChain(transitions, appended.previousTransitionId, appended.sourceProjectionDigest, {
    id: appended.target.toolCallId,
    name: appended.target.toolName,
  });
}

/**
 * Prior-Turn results large enough to archive before compaction.
 *
 * Collection reads events the transition reducer has already folded, so a
 * result an earlier transition replaced is measured at its replacement size and
 * simply falls below the threshold — there is no second "already pruned?"
 * predicate to keep in step with the fold.
 */
export function collectStaleToolResultArchiveCandidates(
  events: readonly RuntimeEvent[],
  prunePolicy: StaleToolResultPrunePolicy | undefined,
  charsPerToken: number,
): StaleToolResultArchiveCandidate[] {
  if (prunePolicy?.enabled !== true) return [];
  const maxResultEstimatedTokens =
    finitePositive(prunePolicy.maxResultEstimatedTokens) ??
    DEFAULT_MAX_TOOL_RESULT_ESTIMATED_TOKENS;
  const minRecentTurnsFull = Math.max(0, Math.floor(prunePolicy.minRecentTurnsFull ?? 1));
  const protectedTurnIds = recentTurnIds(events, minRecentTurnsFull);
  const candidates: StaleToolResultArchiveCandidate[] = [];
  for (const event of events) {
    const content = event.content;
    if (
      event.partial ||
      event.modelVisibility === 'hidden' ||
      content?.kind !== 'function_response' ||
      protectedTurnIds.has(turnKey(event))
    ) {
      continue;
    }
    const sourceProjection = baseToolResultProjection(event);
    if (!sourceProjection) continue;
    const serializedResult = serializedToolResultProjection(sourceProjection);
    const originalBytes = utf8ByteLength(serializedResult);
    const media = projectionArtifactMedia(sourceProjection);
    // An artifact serializes to a short reference and materializes to real
    // image bytes, so the string alone would price a screenshot at nothing.
    const originalEstimatedTokens =
      estimateTokens(serializedResult.length, charsPerToken) +
      media.length * MATERIALIZED_IMAGE_TOKENS;
    // A result that carries media is always a candidate: archiving it drops
    // whole images from the request, which is worth doing whatever the
    // reference text around them happens to weigh. The size gate is there to
    // spare small text results, so it only decides those.
    if (media.length === 0 && originalEstimatedTokens <= maxResultEstimatedTokens) continue;
    candidates.push({
      runtimeEventId: event.id,
      turnId: event.turnId,
      toolCallId: content.id,
      toolName: content.name,
      result: content.result,
      sourceProjection,
      serializedResult,
      originalEstimatedTokens,
      originalBytes,
      rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
      reason: 'stale_tool_result_pruned_before_compact',
    });
  }
  return candidates;
}

/**
 * Archive artifacts the effective history still needs.
 *
 * Derived from the folded events, never from a parallel bookkeeping table: an
 * artifact is reachable exactly when a placeholder the model can still see names
 * it. An archive whose transition was refused is therefore unreachable by
 * construction.
 *
 * This is the reachability authority a reclaiming pass must ask; no such pass
 * exists yet, so nothing here is reclaimed today (#4283). Adding one is what
 * makes an unreferenced archive temporary rather than retained.
 */
export function collectReachableArchiveArtifactIds(events: readonly RuntimeEvent[]): Set<string> {
  const reachable = new Set<string>();
  for (const event of events) {
    const content = event.content;
    if (content?.kind !== 'function_response') continue;
    if (isArchivedToolResultPlaceholder(content.result)) {
      reachable.add(content.result.artifactId);
    }
  }
  return reachable;
}

function recentTurnIds(events: readonly RuntimeEvent[], count: number): Set<string> {
  if (count <= 0) return new Set();
  const order: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const key = turnKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  return new Set(order.slice(Math.max(0, order.length - count)));
}
