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

export interface MessageQueueState {
  readonly queueRevision?: number;
  readonly entries: readonly MessageQueueEntryProjection[];
}
type QueueBySession = Record<string, MessageQueueState>;

/** What one Host event changes about the messages a Session shows outside its transcript. */
interface MessageQueueChange {
  /** The Session's next queue; `null` once the Host holds nothing. */
  readonly queue?: MessageQueueState | null;
  readonly retire?: readonly string[];
  readonly publish?: TransientUserMessageProjection;
}

/** A surface that holds its queue and pending prompts as one value. */
export interface MessagePresentation {
  readonly transientMessages: readonly TransientUserMessageProjection[];
  readonly messageQueue: MessageQueueState;
}

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
 * queue, it moves straight to where it now lives, so no event leaves it
 * unshown.
 */
function messageQueueChange(
  queue: MessageQueueState | undefined,
  event: SessionEvent,
): MessageQueueChange | undefined {
  switch (event.type) {
    case 'queue_update': {
      const { entries } = deriveMessageQueueProjection(event);
      return {
        queue: event.steering.length || event.followup.length ? { queueRevision: event.queueRevision, entries } : null,
        retire: entries.map((entry) => entry.messageId),
      };
    }
    case 'message_admission': {
      if (event.outcome === 'retracted') return { retire: [event.messageId], ...dequeued(queue, event.messageId) };
      // Main announces the admission before the queue update that drops the
      // entry, so a follow-up becomes its Turn's prompt without a gap. Steering
      // is not bound here: steering folded into a successor Turn can share one
      // prompt with other messages, whose id then matches none of them.
      const entry = queue?.entries.find((candidate) => candidate.messageId === event.messageId);
      if (entry?.placement !== 'next_turn') return undefined;
      return {
        publish: { ...queuedTransientMessage(entry, event), transientPlacement: 'transcript', hostTurnId: event.turnId },
        ...dequeued(queue, event.messageId),
      };
    }
    case 'steering_message':
      // The live Turn projection now renders this same messageId in place.
      // Retire the local submission placeholder; a later nack is represented
      // by the Host queue alone.
      return { retire: [event.messageId], ...dequeued(queue, event.messageId) };
    default:
      return undefined;
  }
}

/** Applies the queue rule to a Session whose queue and pending prompts live in separate stores. */
export function applyMessageQueueEvent(
  sessionId: string,
  event: SessionEvent,
  { messageQueueStore, addTransientMessage, removeTransientMessage }: MessageQueueStores,
): void {
  const change = messageQueueChange(messageQueueStore?.getState().messageQueueBySession[sessionId], event);
  if (!change) return;
  for (const messageId of change.retire ?? []) removeTransientMessage?.(sessionId, messageId);
  if (change.publish) addTransientMessage?.(sessionId, change.publish);
  const { queue } = change;
  if (queue === undefined) return;
  messageQueueStore?.setMessageQueueBySession((current) => {
    if (queue) return { ...current, [sessionId]: queue };
    if (!current[sessionId]) return current;
    const next = { ...current };
    delete next[sessionId];
    return next;
  });
}

export function reduceMessagePresentation(current: MessagePresentation, event: SessionEvent): MessagePresentation {
  const change = messageQueueChange(current.messageQueue, event);
  if (!change) return current;
  const replaced = new Set([...(change.retire ?? []), ...(change.publish ? [change.publish.id] : [])]);
  return {
    transientMessages: [
      ...current.transientMessages.filter((message) => !replaced.has(message.id)),
      ...(change.publish ? [change.publish] : []),
    ],
    messageQueue: change.queue === undefined ? current.messageQueue : change.queue ?? { entries: [] },
  };
}

function dequeued(queue: MessageQueueState | undefined, messageId: string): Pick<MessageQueueChange, 'queue'> {
  if (!queue?.entries.some((entry) => entry.messageId === messageId)) return {};
  const entries = queue.entries.filter((entry) => entry.messageId !== messageId);
  return { queue: entries.length > 0 ? { ...queue, entries } : null };
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
