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
 * sparse — it names one projection part of one RuntimeEvent — and so is not a
 * generalization of the contiguous-prefix `HistoryCompactCheckpoint` (#4283).
 *
 * Everything a deterministic reduction needs is on the record:
 *
 * - `target` — which RuntimeEvent projection part is replaced;
 * - `sourceProjectionDigest` — the exact projection it is allowed to replace,
 *   so a stale concurrent writer cannot apply against content it never saw;
 * - `replacement` — what the model sees instead, including where the replaced
 *   body still lives when it is recoverable at all;
 * - `previousTransitionId` — the predecessor for this target, which is also the
 *   reduction's ordering authority: readers follow the chain rather than a
 *   cursor, so ledger order and wall-clock skew cannot change the result.
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
  /**
   * The transition this one supersedes for the same target, if any.
   *
   * Absent means "applies to the base projection". Together with
   * `sourceProjectionDigest` this is the only ordering a reducer needs.
   */
  previousTransitionId?: string;
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
  ],
  ['previousTransitionId'],
);

const TARGET_SHAPE = defineObjectShape<ModelProjectionTransitionTarget>()(
  ['runtimeEventId', 'part', 'toolCallId', 'toolName'],
  [],
);

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
  previousTransitionId?: string;
  now: number;
}

/**
 * Build one transition with a content-derived id.
 *
 * The id digests everything the record asserts and nothing about when or where
 * it was written, so two writers that independently decide the same replacement
 * for the same source produce the same record: a duplicate concurrent append is
 * idempotent rather than a second competing successor.
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
    ...(input.previousTransitionId ? { previousTransitionId: input.previousTransitionId } : {}),
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
    (value.previousTransitionId !== undefined && !nonEmptyString(value.previousTransitionId)) ||
    !isTransitionTarget(value.target)
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

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
