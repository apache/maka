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
import { normalizeMessageContent, type MessageContent } from '@maka/core/events';

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
  readonly admittedAt: number;
}

export interface MessageAdmissionStore {
  commitMessageAdmission(admission: PendingMessageAdmission): Promise<PendingMessageAdmission>;
  readMessageAdmission(
    sessionId: string,
    messageId: string,
  ): Promise<PendingMessageAdmission | undefined>;
  listMessageAdmissions(sessionId: string): Promise<readonly PendingMessageAdmission[]>;
  markMessagesHandedOff(input: {
    sessionId: string;
    messageIds: readonly string[];
    turnId: string;
  }): Promise<void>;
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
  });
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized.submittedContentDigest)) {
    throw new Error('Invalid pending Message submitted content digest');
  }
  return normalized;
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
    isDeepStrictEqual(a.content, b.content)
  );
}

function assertSafeId(value: string, message: string): void {
  if (!SAFE_ID_PATTERN.test(value)) throw new Error(message);
}
