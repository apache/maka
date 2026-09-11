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

import { isDeepStrictEqual } from 'node:util';
import {
  isOrchestrationMode,
  isTurnOrchestrationSource,
  type TurnOrchestration,
} from '@maka/core/orchestration';

// Mirrors the protocol's submit bounds. Storage sits below the protocol, so the
// durable side re-states them rather than importing them.
const SKILL_ID_MAX_COUNT = 50;
const SKILL_ID_MAX_LENGTH = 512;
const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * What a submit asked of its Turn beyond the words: the exact Skills to load
 * and the orchestration to run under. Content and placement describe neither,
 * so this is the rest of what makes a submit the same submit.
 *
 * It is one value and every durable record keeps it whole. A record that kept
 * only a part — or only a digest it could not rebuild — could not answer a
 * retry that arrives after the Host recovered the Message from that record.
 */
export interface SubmittedTurnIntent {
  readonly skillIds: readonly string[];
  readonly turnOrchestration?: TurnOrchestration;
}

/**
 * Validate an intent from any source — a caller, a durable record, or a JSON
 * column — into the one canonical shape the equality below compares.
 */
export function normalizeSubmittedTurnIntent(value: unknown): SubmittedTurnIntent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid submitted Turn intent');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'skillIds' && key !== 'turnOrchestration') {
      throw new Error('Invalid submitted Turn intent');
    }
  }
  const { skillIds, turnOrchestration } = record;
  if (
    !Array.isArray(skillIds) ||
    skillIds.length > SKILL_ID_MAX_COUNT ||
    skillIds.some(
      (id) =>
        typeof id !== 'string' ||
        id.length === 0 ||
        id.length > SKILL_ID_MAX_LENGTH ||
        !SKILL_ID_PATTERN.test(id),
    )
  ) {
    throw new Error('Invalid submitted Turn intent Skill ids');
  }
  let orchestration: TurnOrchestration | undefined;
  if (turnOrchestration !== undefined) {
    if (
      typeof turnOrchestration !== 'object' ||
      turnOrchestration === null ||
      !isOrchestrationMode((turnOrchestration as TurnOrchestration).mode) ||
      !isTurnOrchestrationSource((turnOrchestration as TurnOrchestration).source)
    ) {
      throw new Error('Invalid submitted Turn intent orchestration');
    }
    const { mode, source } = turnOrchestration as TurnOrchestration;
    orchestration = Object.freeze({ mode, source });
  }
  // An intent that asks for nothing is not an intent: the absent value already
  // says that, and admitting a second spelling of it would make two records
  // that mean the same thing compare unequal.
  if (skillIds.length === 0 && orchestration === undefined) {
    throw new Error('Invalid submitted Turn intent: it asks for nothing');
  }
  return Object.freeze({
    skillIds: Object.freeze([...(skillIds as readonly string[])]),
    ...(orchestration ? { turnOrchestration: orchestration } : {}),
  });
}

/** Skill order is part of the request, so it is compared in order. */
export function submittedTurnIntentsEqual(
  left: SubmittedTurnIntent | undefined,
  right: SubmittedTurnIntent | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.skillIds.length === right.skillIds.length &&
    left.skillIds.every((id, index) => id === right.skillIds[index]) &&
    isDeepStrictEqual(left.turnOrchestration, right.turnOrchestration)
  );
}
