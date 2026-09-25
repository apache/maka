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
  SessionEvent,
} from '@maka/core/events';
import type { TransientUserMessageProjection } from '@maka/ui';

export interface MessageQueueProjection {
  readonly entries: readonly MessageQueueEntryProjection[];
  readonly transientMessages: readonly TransientUserMessageProjection[];
}

type QueueState = {
  readonly queueRevision?: number;
  readonly entries: readonly MessageQueueEntryProjection[];
};
type QueueBySession = Record<string, QueueState>;

export interface MessageQueueStores {
  readonly messageQueueStore?: {
    getState(): { readonly messageQueueBySession: QueueBySession };
    setMessageQueueBySession(updater: (current: QueueBySession) => QueueBySession): void;
  };
  readonly addTransientMessage?: (sessionId: string, message: TransientUserMessageProjection) => void;
  readonly removeTransientMessage?: (sessionId: string, messageId: string) => void;
}

/** One presentation contract for Host queue snapshots in every chat surface. */
export function deriveMessageQueueProjection(
  event: QueueUpdateEvent,
): MessageQueueProjection {
  const entries = [
    ...(event.steeringEntries ?? []),
    ...(event.followupEntries ?? []),
  ].map((entry) => structuredClone(entry));
  return {
    entries,
    transientMessages: entries.map((entry) => queuedTransientMessage(entry, event)),
  };
}

/**
 * A message is on the plate exactly while the Host queue holds it. Leaving the
 * queue, it moves straight to where it now lives, so no event leaves it unshown.
 */
export function applyMessageQueueEvent(
  sessionId: string,
  event: SessionEvent,
  { messageQueueStore, addTransientMessage, removeTransientMessage }: MessageQueueStores,
): void {
  const dropQueuedMessage = (messageId: string) =>
    messageQueueStore?.setMessageQueueBySession((current) => withoutQueuedMessage(current, sessionId, messageId));
  switch (event.type) {
    case 'queue_update': {
      const queue = deriveMessageQueueProjection(event);
      for (const entry of queue.entries) removeTransientMessage?.(sessionId, entry.messageId);
      messageQueueStore?.setMessageQueueBySession((current) => {
        if (!event.steering.length && !event.followup.length) {
          if (!current[sessionId]) return current;
          const next = { ...current };
          delete next[sessionId];
          return next;
        }
        return { ...current, [sessionId]: { queueRevision: event.queueRevision, entries: queue.entries } };
      });
      return;
    }
    case 'message_admission': {
      if (event.outcome === 'retracted') {
        removeTransientMessage?.(sessionId, event.messageId);
        return;
      }
      // Main announces the admission before the queue update that drops the
      // entry, so a follow-up becomes its Turn's prompt without a gap. Admitted
      // steering waits for `steering_message` to place it inside the Turn.
      const entry = messageQueueStore?.getState().messageQueueBySession[sessionId]?.entries
        .find((candidate) => candidate.messageId === event.messageId);
      if (entry?.placement !== 'next_turn') return;
      addTransientMessage?.(sessionId, {
        ...queuedTransientMessage(entry, event),
        transientPlacement: 'transcript',
        hostTurnId: event.turnId,
      });
      dropQueuedMessage(event.messageId);
      return;
    }
    case 'steering_message':
      // The live Turn projection now renders this same messageId in place.
      // Retire the local submission placeholder; a later nack is represented
      // by the Host queue alone.
      removeTransientMessage?.(sessionId, event.messageId);
      dropQueuedMessage(event.messageId);
      return;
  }
}

function withoutQueuedMessage(current: QueueBySession, sessionId: string, messageId: string): QueueBySession {
  const queue = current[sessionId];
  if (!queue?.entries.some((entry) => entry.messageId === messageId)) return current;
  const entries = queue.entries.filter((entry) => entry.messageId !== messageId);
  if (entries.length > 0) return { ...current, [sessionId]: { ...queue, entries } };
  const next = { ...current };
  delete next[sessionId];
  return next;
}

function queuedTransientMessage(
  entry: MessageQueueEntryProjection,
  event: { turnId: string; ts: number },
): TransientUserMessageProjection {
  return {
    id: entry.messageId,
    transientPlacement: entry.placement === 'current_turn' ? 'steering' : 'follow_up',
    ...(entry.placement === 'current_turn' && { hostTurnId: event.turnId }),
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
  };
}
