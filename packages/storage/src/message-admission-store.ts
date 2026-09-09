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
  decodeMessageContent,
  normalizeMessageContent,
  type MessageContent,
} from '@maka/core/events';
import {
  decodeSkillInvocationResult,
  type SkillInvocationResult,
} from '@maka/core/skill-invocation';
import {
  normalizeSubmittedTurnIntent,
  submittedTurnIntentsEqual,
  type SubmittedTurnIntent,
} from './submitted-turn-intent.js';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface PendingMessageAdmission {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly content: MessageContent;
  readonly submittedContentDigest: `sha256:${string}`;
  readonly submittedPlacement: 'current_turn' | 'next_turn';
  readonly placement: 'current_turn' | 'next_turn';
  readonly disposition: 'steering' | 'followup';
  /**
   * What this Message asked of its Turn beyond the words, when it asked for
   * anything. Recovery re-opens the Turn from this record and answers retries
   * against it, so the whole intent lives here: without it a crash between
   * this commit and the root admission silently downgrades an explicit graph
   * or swarm request to the Session default, and a later retry of the very
   * same submit reads as a different one.
   */
  readonly submittedIntent?: SubmittedTurnIntent;
  /** The Skill resolution answer returned for this admitted Message. */
  readonly skillInvocation: SkillInvocationResult;
  readonly admittedAt: number;
}

export interface ProvenRootMessageHandoff {
  readonly messageId: string;
  readonly content: MessageContent;
  readonly admittedAt: number;
}

/** Immutable proof that an admission was delivered as steering by a later execution owner. */
export interface ProvenSteeringMessageHandoff {
  readonly messageId: string;
  readonly admissionTurnId: string;
  readonly admissionRunId: string;
  readonly executionTurnId: string;
  readonly eventId: string;
  readonly eventTs: number;
  readonly content: MessageContent;
  readonly admittedAt: number;
}

export interface MarkMessagesHandedOffInput {
  readonly sessionId: string;
  readonly messageIds: readonly string[];
  readonly turnId: string;
  readonly provenRootMessages?: readonly ProvenRootMessageHandoff[];
  readonly provenSteeringMessages?: readonly ProvenSteeringMessageHandoff[];
}

export type MessageAdmissionCancellationClaimOutcome =
  | 'cancelled_by_claim'
  | 'same_claim'
  | 'already_cancelled';

export interface MessageAdmissionStore {
  commitMessageAdmission(admission: PendingMessageAdmission): Promise<PendingMessageAdmission>;
  readMessageAdmission(
    sessionId: string,
    messageId: string,
  ): Promise<PendingMessageAdmission | undefined>;
  /**
   * Whether this Message identity carries a cancellation tombstone. That a
   * Message was cancelled is the whole fact callers need — the tombstone's
   * own columns never leave this layer.
   */
  hasCancelledMessageAdmission(sessionId: string, messageId: string): Promise<boolean>;
  claimMessageAdmissionCancellation(
    sessionId: string,
    messageId: string,
    claimId: string,
  ): Promise<MessageAdmissionCancellationClaimOutcome>;
  listMessageAdmissions(sessionId: string): Promise<readonly PendingMessageAdmission[]>;
  markMessagesHandedOff(input: MarkMessagesHandedOffInput): Promise<void>;
  updateMessageAdmission(admission: PendingMessageAdmission): Promise<void>;
  reorderMessageAdmissions(sessionId: string, messageIds: readonly string[]): Promise<void>;
  cancelMessageAdmissions(sessionId: string, messageIds: readonly string[]): Promise<void>;
}

export function normalizePendingMessageAdmission(
  admission: PendingMessageAdmission,
): PendingMessageAdmission {
  for (const [name, value] of [
    ['Session', admission.sessionId],
    ['Turn', admission.turnId],
    ['Run', admission.runId],
    ['Message', admission.messageId],
  ] as const) {
    assertSafeId(value, `Invalid ${name} identity`);
  }
  if (
    (admission.submittedPlacement !== 'current_turn' &&
      admission.submittedPlacement !== 'next_turn') ||
    (admission.placement !== 'current_turn' && admission.placement !== 'next_turn') ||
    (admission.disposition !== 'steering' && admission.disposition !== 'followup') ||
    (admission.placement === 'current_turn') !== (admission.disposition === 'steering')
  ) {
    throw new Error('Invalid pending Message placement');
  }
  if (!Number.isSafeInteger(admission.admittedAt) || admission.admittedAt < 0) {
    throw new Error('Invalid message admission timestamp');
  }
  const normalized = Object.freeze({
    ...admission,
    content: normalizeMessageContent(admission.content),
    ...(admission.submittedIntent
      ? { submittedIntent: normalizeSubmittedTurnIntent(admission.submittedIntent) }
      : {}),
    skillInvocation: decodeSkillInvocationResult(admission.skillInvocation),
  });
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized.submittedContentDigest)) {
    throw new Error('Invalid pending Message submitted content digest');
  }
  return normalized;
}

export function normalizeProvenRootMessageHandoff(
  handoff: ProvenRootMessageHandoff,
): ProvenRootMessageHandoff {
  assertSafeId(handoff.messageId, 'Invalid proven Root Message identity');
  if (!Number.isSafeInteger(handoff.admittedAt) || handoff.admittedAt < 0) {
    throw new Error('Invalid proven Root Message timestamp');
  }
  return Object.freeze({
    ...handoff,
    content: decodeMessageContent(handoff.content),
  });
}

export function normalizeProvenSteeringMessageHandoff(
  handoff: ProvenSteeringMessageHandoff,
): ProvenSteeringMessageHandoff {
  assertSafeId(handoff.messageId, 'Invalid proven steering Message identity');
  assertSafeId(handoff.admissionTurnId, 'Invalid proven steering admission Turn');
  assertSafeId(handoff.admissionRunId, 'Invalid proven steering admission Run');
  assertSafeId(handoff.executionTurnId, 'Invalid proven steering execution Turn');
  assertSafeId(handoff.eventId, 'Invalid proven steering RuntimeEvent identity');
  if (!Number.isSafeInteger(handoff.eventTs) || handoff.eventTs < 0) {
    throw new Error('Invalid proven steering RuntimeEvent timestamp');
  }
  if (!Number.isSafeInteger(handoff.admittedAt) || handoff.admittedAt < 0) {
    throw new Error('Invalid proven steering Message timestamp');
  }
  return Object.freeze({ ...handoff, content: decodeMessageContent(handoff.content) });
}

export function samePendingMessageAdmission(
  left: PendingMessageAdmission,
  right: PendingMessageAdmission,
): boolean {
  const a = normalizePendingMessageAdmission(left);
  const b = normalizePendingMessageAdmission(right);
  return (
    a.sessionId === b.sessionId &&
    a.turnId === b.turnId &&
    a.runId === b.runId &&
    a.messageId === b.messageId &&
    a.submittedContentDigest === b.submittedContentDigest &&
    a.submittedPlacement === b.submittedPlacement &&
    a.placement === b.placement &&
    a.disposition === b.disposition &&
    a.admittedAt === b.admittedAt &&
    submittedTurnIntentsEqual(a.submittedIntent, b.submittedIntent) &&
    isDeepStrictEqual(a.skillInvocation, b.skillInvocation) &&
    isDeepStrictEqual(a.content, b.content)
  );
}

function assertSafeId(value: string, message: string): void {
  if (!SAFE_ID_PATTERN.test(value)) throw new Error(message);
}
