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

import {
  CHECKIN_MAX_CARDS,
  isCheckinCardAction,
  isCheckinEvidenceSource,
  type CheckinCard,
} from '@maka/core/session-checkin';
import type { SessionCheckinGenerateResult } from '@maka/runtime-host/protocol';
import type { ConversationCheckinMemory } from '../ports.js';

/** A check-in costs a model call, so focus alone does not repeat it inside this window. */
export const CHECKIN_ATTEMPT_COOLDOWN_MS = 90 * 60 * 1000;
const SETTLED_KEYS_MAX = 200;

export const EMPTY_CHECKIN_MEMORY: ConversationCheckinMemory = Object.freeze({
  lastAttemptAt: 0,
  lastCheckinAt: null,
  cards: [],
  settled: [],
});

/** A card is the same card while its Session has not moved on. */
export function checkinCardKey(card: Pick<CheckinCard, 'sessionId' | 'sessionRevision'>) {
  return JSON.stringify([card.sessionId, card.sessionRevision]);
}

export function shouldRunCheckin(input: {
  readonly now: number;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly memory: ConversationCheckinMemory;
  readonly force?: boolean;
}): boolean {
  if (!input.enabled || input.running) return false;
  return input.force === true || input.now - input.memory.lastAttemptAt >= CHECKIN_ATTEMPT_COOLDOWN_MS;
}

export function recordCheckinAttempt(
  memory: ConversationCheckinMemory,
  now: number,
): ConversationCheckinMemory {
  return { ...memory, lastAttemptAt: now };
}

/**
 * An answer replaces the cards, including with none; a failure keeps the
 * cards the user already has and leaves `since` where it was. Without a
 * default model nothing ran, so it is no attempt and the cooldown does not
 * start: the first check-in after one is chosen runs at once.
 */
export function recordCheckinResult(
  memory: ConversationCheckinMemory,
  startedAt: number,
  result: SessionCheckinGenerateResult,
): ConversationCheckinMemory {
  if (result.kind === 'failed') {
    return result.errorClass === 'configuration' ? { ...memory, lastAttemptAt: 0 } : memory;
  }
  return {
    ...memory,
    lastCheckinAt: startedAt,
    cards: result.kind === 'generated' ? result.cards : [],
  };
}

export function settleCheckinCard(
  memory: ConversationCheckinMemory,
  card: CheckinCard,
): ConversationCheckinMemory {
  const key = checkinCardKey(card);
  if (memory.settled.includes(key)) return memory;
  return { ...memory, settled: [...memory.settled, key].slice(-SETTLED_KEYS_MAX) };
}

export function visibleCheckinCards(memory: ConversationCheckinMemory): CheckinCard[] {
  return memory.cards.filter((card) => !memory.settled.includes(checkinCardKey(card)));
}

/** Reads stored memory defensively: storage is user-editable and can predate this shape. */
export function decodeCheckinMemory(value: unknown): ConversationCheckinMemory {
  if (!isRecord(value)) return EMPTY_CHECKIN_MEMORY;
  const lastAttemptAt = finiteOr(value.lastAttemptAt, 0);
  const lastCheckinAt = value.lastCheckinAt === null ? null : finiteOr(value.lastCheckinAt, null);
  const cards = Array.isArray(value.cards)
    ? value.cards.filter(isStoredCard).slice(0, CHECKIN_MAX_CARDS)
    : [];
  const settled = Array.isArray(value.settled)
    ? value.settled.filter((key): key is string => typeof key === 'string').slice(-SETTLED_KEYS_MAX)
    : [];
  return { lastAttemptAt, lastCheckinAt, cards, settled };
}

function isStoredCard(value: unknown): value is CheckinCard {
  if (!isRecord(value) || !isRecord(value.evidence)) return false;
  return (
    typeof value.sessionId === 'string' &&
    typeof value.sessionRevision === 'number' &&
    typeof value.sessionName === 'string' &&
    typeof value.title === 'string' &&
    isCheckinEvidenceSource(value.evidence.source) &&
    typeof value.evidence.quote === 'string' &&
    isCheckinCardAction(value.action) &&
    (value.instruction === undefined || typeof value.instruction === 'string')
  );
}

function finiteOr<T>(value: unknown, fallback: T): number | T {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
