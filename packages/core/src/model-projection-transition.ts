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
 * Durable model-projection transitions (#4283).
 *
 * A successful model-visible history is append-only. Any lossy change to
 * already-visible history — pruning a large Tool Result, omitting an image a
 * provider rejected — must first become a durable successor in the append-only
 * operational AgentRunEvent ledger, so no later replay, compaction, branch, or
 * restart can restore the replaced form.
 *
 * This module owns the one typed record that expresses such a change. It is
 * deliberately NOT a generalization of `HistoryCompactCheckpoint`: that
 * checkpoint replaces one validated CONTIGUOUS prefix, and keeps that meaning.
 * A transition is SPARSE — it names one projection part of one RuntimeEvent —
 * and the two have different coverage, concurrency, copy and recovery algebra.
 *
 * Everything a deterministic reduction needs is on the record:
 *
 * - `target` — which RuntimeEvent projection part is replaced;
 * - `sourceProjectionDigest` — the exact projection it is allowed to replace,
 *   so a stale concurrent writer cannot apply against content it never saw;
 * - `replacement` / `archive` — what the model sees instead, and where the
 *   replaced body still lives when it is recoverable at all;
 * - `previousTransitionId` + `highWaterSeq` — predecessor and cursor identity,
 *   so ledger readers in any order converge on the same effective history.
 */

import * as nodeCrypto from 'node:crypto';

import {
  decodeDurableToolResultProjection,
  type DurableToolResultProjection,
} from './durable-tool-result-projection.js';
import { stableJsonStringify } from './tool-args-identity.js';
import { defineObjectShape, hasExactShape, isFiniteNumber, isRecord } from './record-schema.js';

export const MODEL_PROJECTION_TRANSITION_VERSION = 1 as const;

/** The append-only operational ledger record that carries one transition. */
export const MODEL_PROJECTION_TRANSITION_EVENT_TYPE = 'model_projection_transition_recorded';

/** Reduction cursor name, mirroring the checkpoint protocol's high-water pair. */
export const MODEL_PROJECTION_TRANSITION_HIGH_WATER_NAME = 'model-projection-transition-high-water';

export const MODEL_PROJECTION_TRANSITION_REASONS = [
  /** Current-turn result archived before the next provider step. */
  'active_tool_result_archived',
  /** Prior-turn result archived before whole-turn compaction. */
  'stale_tool_result_archived',
] as const;

export type ModelProjectionTransitionReason = (typeof MODEL_PROJECTION_TRANSITION_REASONS)[number];

/**
 * The addressed projection part. `tool_result` is the whole durable Tool Result
 * projection of one `function_response` RuntimeEvent — the only part kind that
 * exists while the projection schema has no independently addressable segments.
 */
export interface ModelProjectionTransitionTarget {
  runtimeEventId: string;
  part: 'tool_result';
  toolCallId: string;
  toolName: string;
}

/**
 * Session-owned archive of the replaced body.
 *
 * Optional: a transition that removes content irrecoverably (an image a
 * provider refused to accept) is still a valid transition. Present here, it is
 * both the model's way back to the content and the reachability root that keeps
 * the artifact from being reclaimed.
 */
export interface ModelProjectionTransitionArchive {
  artifactId: string;
  /** Lowercase hex sha256 of the archived serialized body. */
  bodySha256: string;
  originalBytes: number;
  originalEstimatedTokens: number;
}

export interface ModelProjectionTransition {
  kind: 'maka.model_projection_transition';
  version: typeof MODEL_PROJECTION_TRANSITION_VERSION;
  transitionId: string;
  sessionId: string;
  createdAt: number;
  target: ModelProjectionTransitionTarget;
  /** Digest of the projection this record is allowed to replace. */
  sourceProjectionDigest: `sha256:${string}`;
  replacement: DurableToolResultProjection;
  archive?: ModelProjectionTransitionArchive;
  reason: ModelProjectionTransitionReason;
  /** The transition this one supersedes for the same target, if any. */
  previousTransitionId?: string;
  highWaterName: string;
  highWaterSeq: number;
}

const TRANSITION_SHAPE = defineObjectShape<ModelProjectionTransition>()(
  [
    'kind',
    'version',
    'transitionId',
    'sessionId',
    'createdAt',
    'target',
    'sourceProjectionDigest',
    'replacement',
    'reason',
    'highWaterName',
    'highWaterSeq',
  ],
  ['archive', 'previousTransitionId'],
);

const TARGET_SHAPE = defineObjectShape<ModelProjectionTransitionTarget>()(
  ['runtimeEventId', 'part', 'toolCallId', 'toolName'],
  [],
);

const ARCHIVE_SHAPE = defineObjectShape<ModelProjectionTransitionArchive>()(
  ['artifactId', 'bodySha256', 'originalBytes', 'originalEstimatedTokens'],
  [],
);

const REASONS: ReadonlySet<string> = new Set(MODEL_PROJECTION_TRANSITION_REASONS);

/**
 * The identity of one durable projection, over strict key-sorted JSON.
 *
 * Writer and reducer must agree byte for byte: a digest computed one way at
 * write time and another at read time would silently turn every transition
 * into a source mismatch, i.e. into content that quietly comes back.
 */
export function durableToolResultProjectionDigest(
  projection: DurableToolResultProjection,
): `sha256:${string}` {
  return `sha256:${nodeCrypto
    .createHash('sha256')
    .update(stableJsonStringify(projection))
    .digest('hex')}`;
}

export interface BuildModelProjectionTransitionInput {
  sessionId: string;
  target: ModelProjectionTransitionTarget;
  sourceProjection: DurableToolResultProjection;
  replacement: DurableToolResultProjection;
  archive?: ModelProjectionTransitionArchive;
  reason: ModelProjectionTransitionReason;
  previousTransitionId?: string;
  highWaterSeq: number;
  now: number;
}

/**
 * Build one transition with a content-derived id.
 *
 * The id is a digest of everything the record asserts, so two writers that
 * independently decide the same replacement for the same source produce the
 * same record: a duplicate concurrent append is idempotent rather than a second
 * competing successor.
 */
export function buildModelProjectionTransition(
  input: BuildModelProjectionTransitionInput,
): ModelProjectionTransition {
  const sourceProjectionDigest = durableToolResultProjectionDigest(
    decodeDurableToolResultProjection(input.sourceProjection),
  );
  const replacement = decodeDurableToolResultProjection(input.replacement);
  const body = {
    version: MODEL_PROJECTION_TRANSITION_VERSION,
    sessionId: input.sessionId,
    target: input.target,
    sourceProjectionDigest,
    replacement,
    ...(input.archive ? { archive: input.archive } : {}),
    reason: input.reason,
    ...(input.previousTransitionId ? { previousTransitionId: input.previousTransitionId } : {}),
    highWaterName: MODEL_PROJECTION_TRANSITION_HIGH_WATER_NAME,
    highWaterSeq: input.highWaterSeq,
  };
  const transitionId = `mptransition-${nodeCrypto
    .createHash('sha256')
    .update(stableJsonStringify(body))
    .digest('hex')
    .slice(0, 32)}`;
  return decodeModelProjectionTransition(
    {
      kind: 'maka.model_projection_transition',
      transitionId,
      createdAt: input.now,
      ...body,
    },
    input.sessionId,
  );
}

export function decodeModelProjectionTransition(
  value: unknown,
  sessionId: string,
): ModelProjectionTransition {
  if (!isModelProjectionTransition(value, sessionId)) {
    throw new Error('Invalid model projection transition');
  }
  return value;
}

export function isModelProjectionTransition(
  value: unknown,
  sessionId: string,
): value is ModelProjectionTransition {
  if (
    !isRecord(value) ||
    !hasExactShape(value, TRANSITION_SHAPE) ||
    value.kind !== 'maka.model_projection_transition' ||
    value.version !== MODEL_PROJECTION_TRANSITION_VERSION ||
    !nonEmptyString(value.transitionId) ||
    value.sessionId !== sessionId ||
    !isFiniteNumber(value.createdAt) ||
    !isSha256Digest(value.sourceProjectionDigest) ||
    typeof value.reason !== 'string' ||
    !REASONS.has(value.reason) ||
    !nonEmptyString(value.highWaterName) ||
    !isFiniteNumber(value.highWaterSeq) ||
    (value.previousTransitionId !== undefined && !nonEmptyString(value.previousTransitionId)) ||
    !isTransitionTarget(value.target) ||
    (value.archive !== undefined && !isTransitionArchive(value.archive))
  ) {
    return false;
  }
  try {
    decodeDurableToolResultProjection(value.replacement);
  } catch {
    return false;
  }
  return true;
}

function isTransitionTarget(value: unknown): value is ModelProjectionTransitionTarget {
  return (
    isRecord(value) &&
    hasExactShape(value, TARGET_SHAPE) &&
    nonEmptyString(value.runtimeEventId) &&
    value.part === 'tool_result' &&
    nonEmptyString(value.toolCallId) &&
    nonEmptyString(value.toolName)
  );
}

function isTransitionArchive(value: unknown): value is ModelProjectionTransitionArchive {
  return (
    isRecord(value) &&
    hasExactShape(value, ARCHIVE_SHAPE) &&
    nonEmptyString(value.artifactId) &&
    typeof value.bodySha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.bodySha256) &&
    isFiniteNumber(value.originalBytes) &&
    value.originalBytes > 0 &&
    isFiniteNumber(value.originalEstimatedTokens) &&
    value.originalEstimatedTokens > 0
  );
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
