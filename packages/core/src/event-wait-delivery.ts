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

import { defineObjectShape, hasExactShape, isRecord } from './record-schema.js';

/** A naturally completed Goal Turn has no suspended tool call. */
export interface GoalWaitingProvenance {
  readonly waitId: string;
  readonly sourceTurnId: string;
  readonly generation: number;
  readonly resultDigest: `sha256:${string}`;
}

export function decodeGoalWaitingProvenance(value: unknown): GoalWaitingProvenance {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !== 'generation,resultDigest,sourceTurnId,waitId' ||
    typeof value.waitId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.waitId) ||
    typeof value.sourceTurnId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.sourceTurnId) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0 ||
    typeof value.resultDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.resultDigest)
  )
    throw new TypeError('Invalid Goal waiting provenance');
  return Object.freeze({ ...value }) as unknown as GoalWaitingProvenance;
}

export function sameGoalWaitingProvenance(
  a: GoalWaitingProvenance | undefined,
  b: GoalWaitingProvenance | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.waitId === b.waitId &&
    a.sourceTurnId === b.sourceTurnId &&
    a.generation === b.generation &&
    a.resultDigest === b.resultDigest
  );
}

/** Read compatibility for PR3/PR4 history only; never authorizes a new admission. */
export interface LegacyEventWaitProvenance {
  readonly waitId: string;
  readonly deliveryKey: string;
  readonly sourceTurnId: string;
  readonly sourceToolCallId: string;
  readonly generation: number;
  readonly outcome: 'satisfied' | 'invalidated' | 'source_unavailable' | 'expired';
  readonly resultDigest: `sha256:${string}`;
}
const legacyShape = defineObjectShape<LegacyEventWaitProvenance>()(
  [
    'waitId',
    'deliveryKey',
    'sourceTurnId',
    'sourceToolCallId',
    'generation',
    'outcome',
    'resultDigest',
  ],
  [],
);
export function decodeLegacyEventWaitProvenance(value: unknown): LegacyEventWaitProvenance {
  if (
    !isRecord(value) ||
    !hasExactShape(value, legacyShape) ||
    typeof value.waitId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.waitId) ||
    value.deliveryKey !== `event-wait/${value.waitId}` ||
    typeof value.sourceTurnId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.sourceTurnId) ||
    typeof value.sourceToolCallId !== 'string' ||
    !value.sourceToolCallId ||
    new TextEncoder().encode(value.sourceToolCallId).byteLength > 512 ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0 ||
    !['satisfied', 'invalidated', 'source_unavailable', 'expired'].includes(
      value.outcome as string,
    ) ||
    typeof value.resultDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.resultDigest)
  ) {
    throw new TypeError('Invalid event wait provenance');
  }
  return Object.freeze({
    waitId: value.waitId,
    deliveryKey: value.deliveryKey,
    sourceTurnId: value.sourceTurnId,
    sourceToolCallId: value.sourceToolCallId,
    generation: value.generation,
    outcome: value.outcome,
    resultDigest: value.resultDigest,
  }) as LegacyEventWaitProvenance;
}

export function sameLegacyEventWaitProvenance(
  a: LegacyEventWaitProvenance | undefined,
  b: LegacyEventWaitProvenance | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.waitId === b.waitId &&
    a.deliveryKey === b.deliveryKey &&
    a.sourceTurnId === b.sourceTurnId &&
    a.sourceToolCallId === b.sourceToolCallId &&
    a.generation === b.generation &&
    a.outcome === b.outcome &&
    a.resultDigest === b.resultDigest
  );
}

/** The two provenance formats describe different consumers and cannot coexist. */
export function decodeGoalEventProvenance(value: { goalWaiting?: unknown; eventWait?: unknown }): {
  goalWaiting?: GoalWaitingProvenance;
  eventWait?: LegacyEventWaitProvenance;
} {
  if (value.goalWaiting !== undefined && value.eventWait !== undefined)
    throw new TypeError('Conflicting Goal wait provenance');
  return {
    ...(value.goalWaiting === undefined
      ? {}
      : { goalWaiting: decodeGoalWaitingProvenance(value.goalWaiting) }),
    ...(value.eventWait === undefined
      ? {}
      : { eventWait: decodeLegacyEventWaitProvenance(value.eventWait) }),
  };
}
