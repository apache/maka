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
  MessageQueueEntryProjection,
  QueueUpdateEvent,
} from '@maka/core/events';
import type { TransientUserMessageProjection } from '@maka/ui';

export interface MessageQueueProjection {
  readonly entries: readonly MessageQueueEntryProjection[];
  readonly transientMessages: readonly TransientUserMessageProjection[];
}

/** One presentation contract for Host queue snapshots in every chat surface. */
export function deriveMessageQueueProjection(
  event: QueueUpdateEvent,
): MessageQueueProjection {
  const entries = [
    ...(event.steeringEntries ?? []),
    ...(event.followupEntries ?? []),
  ]
    .filter((entry) => entry.state === 'queued')
    .map((entry) => structuredClone(entry));
  return {
    entries,
    transientMessages: entries.map((entry) => ({
        id: entry.messageId,
        transientPlacement: entry.placement,
        ...(entry.placement === 'current_turn' && {
          hostTurnId: event.turnId,
          pendingSteering: true,
        }),
        ts: event.ts,
        text: entry.content.displayText ?? entry.content.text,
        ...(entry.content.attachments && { attachments: [...entry.content.attachments] }),
        ...(entry.content.directoryReferences && {
          directoryReferences: entry.content.directoryReferences,
        }),
        ...(entry.content.quotes && { quotes: [...entry.content.quotes] }),
        ...(entry.content.inlineReferences && {
          inlineReferences: [...entry.content.inlineReferences],
        }),
      })),
  };
}
