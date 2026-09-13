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

import type {
  SessionTurnAccessRequest,
  SessionTurnRequestIntent,
} from '@maka/runtime-host/protocol';
import { userFacingText, type StoredMessage } from '@maka/core/session';

export function groupPendingTurnRequests(
  requests: readonly SessionTurnAccessRequest[],
): ReadonlyMap<string, readonly SessionTurnAccessRequest[]> {
  const grouped = new Map<string, SessionTurnAccessRequest[]>();
  for (const request of requests) {
    if (request.state.kind !== 'pending') continue;
    const sessionId = request.intent.sessionId;
    const sessionRequests = grouped.get(sessionId) ?? [];
    sessionRequests.push(request);
    grouped.set(sessionId, sessionRequests);
  }
  return grouped;
}

export function unseenTurnRequests(
  requests: readonly SessionTurnAccessRequest[],
  seenRequestIds: ReadonlySet<string>,
): readonly SessionTurnAccessRequest[] {
  return requests.filter(
    (request) => request.state.kind === 'pending' && !seenRequestIds.has(request.requestId),
  );
}

export function samePendingTurnRequests(
  left: readonly SessionTurnAccessRequest[],
  right: readonly SessionTurnAccessRequest[],
): boolean {
  return left.length === right.length && left.every((request, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      request.requestId === candidate.requestId &&
      request.intent.sessionId === candidate.intent.sessionId &&
      sameTurnRequestIntent(request.intent, candidate.intent);
  });
}

export function describeTurnRequestIntent(
  intent: SessionTurnRequestIntent,
  regenerateLabel: string,
): string {
  return 'content' in intent ? intent.content.text : regenerateLabel;
}

export function describeOwnerTurnRequestIntent(
  intent: SessionTurnRequestIntent,
  messages: readonly StoredMessage[],
  regenerateLabel: string,
): string {
  if ('content' in intent) return intent.content.text;
  const sourceUserMessage = messages.find(
    (message): message is Extract<StoredMessage, { type: 'user' }> =>
      message.type === 'user' && message.turnId === intent.sourceTurnId,
  );
  const sourceText = sourceUserMessage
    ? userFacingText(sourceUserMessage)
    : messages.find(
        (message): message is Extract<StoredMessage, { type: 'assistant' }> =>
          message.type === 'assistant' && message.turnId === intent.sourceTurnId,
      )?.text;
  return sourceText?.trim() ? `${regenerateLabel}: ${sourceText.trim()}` : regenerateLabel;
}

export function turnRequestPreview(text: string, maxLength = 120): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function turnRequestStateLabel(
  request: SessionTurnAccessRequest,
  copy: {
    readonly turnRequestPending: string;
    readonly turnRequestRejected: string;
    readonly turnRequestApproved: string;
    readonly turnRequestStarted: string;
    readonly turnRequestBlocked: string;
    readonly turnRequestFailed: string;
  },
): string {
  if (request.state.kind === 'pending') return copy.turnRequestPending;
  if (request.state.kind === 'rejected') return copy.turnRequestRejected;
  if (request.state.admission === 'pending') return copy.turnRequestApproved;
  if (request.state.admission === 'started') return copy.turnRequestStarted;
  if (request.state.admission === 'blocked') return copy.turnRequestBlocked;
  return copy.turnRequestFailed;
}

function sameTurnRequestIntent(
  left: SessionTurnRequestIntent,
  right: SessionTurnRequestIntent,
): boolean {
  if ('content' in left) {
    return (
      'content' in right &&
      left.turnId === right.turnId &&
      left.content.text === right.content.text
    );
  }
  return (
    !('content' in right) &&
    left.turnId === right.turnId &&
    left.sourceTurnId === right.sourceTurnId
  );
}
