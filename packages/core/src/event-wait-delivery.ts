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

import { isRecord } from './record-schema.js';

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
