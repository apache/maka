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

import type { SessionTurnAccessRequest } from '@maka/runtime-host/protocol';

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
      request.intent.content.text === candidate.intent.content.text;
  });
}

export function turnRequestPreview(text: string, maxLength = 120): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
