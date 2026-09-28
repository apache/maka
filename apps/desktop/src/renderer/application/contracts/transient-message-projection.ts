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

import { createElement } from 'react';
import type {
  AttachmentRef,
  DirectoryReference,
  MessageQueueEntryProjection,
  QuoteRef,
} from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { getConversationCopy, type TransientUserMessageProjection } from '@maka/ui';
import { ICON_SIZE, Pencil, Trash2 } from '@maka/ui/icons';

type TransientUserMessage = TransientUserMessageProjection;

/**
 * What a retracted send hands back to the composer: the editable text plus
 * the staged context (attachments, directory references, quotes) that rode
 * with it. `text` is the editable serialization — `displayText` when the
 * content carries a separate model-facing `text`.
 */
export interface RestoredDraftContent {
  text: string;
  attachments?: readonly AttachmentRef[];
  directoryReferences?: readonly DirectoryReference[];
  quotes?: readonly QuoteRef[];
}

export interface QueuedEntryDraftActions {
  retract(entryId: string): Promise<void>;
  restoreDraft(draft: RestoredDraftContent): void;
}

/**
 * Editing any queued message takes it out of the Host queue first, so it cannot
 * run half-edited, then hands its full content back to the composer. `retract`
 * reports its own failure and rejects, so a failed edit restores nothing.
 */
export async function retractQueuedEntryToDraft(
  { entryId, content }: Pick<MessageQueueEntryProjection, 'entryId' | 'content'>,
  actions: QueuedEntryDraftActions,
): Promise<void> {
  await actions.retract(entryId);
  actions.restoreDraft({
    text: content.displayText ?? content.text,
    attachments: content.attachments,
    directoryReferences: content.directoryReferences,
    quotes: content.quotes,
  });
}

/**
 * Queued steering is a thin projection of the Host queue snapshot, not a stored
 * transient: one tail bubble per current_turn entry, appearing and disappearing
 * with `queue` alone.
 */
export function withQueuedSteeringTransients(
  transientMessages: readonly TransientUserMessage[],
  queue: { readonly entries: readonly MessageQueueEntryProjection[]; readonly ts?: number } | undefined,
  actions: QueuedEntryDraftActions & { locale: UiLocale },
): TransientUserMessage[] {
  const steering = (queue?.entries ?? []).filter(
    (entry) => entry.placement === 'current_turn',
  );
  if (steering.length === 0) return [...transientMessages];
  const copy = getConversationCopy(actions.locale).composer;
  const icon = (glyph: typeof Pencil) => createElement(glyph, { size: ICON_SIZE.control, 'aria-hidden': true });
  const ignore = () => {};
  const bubbles = steering.map((entry): TransientUserMessage => ({
    id: entry.messageId,
    transientPlacement: 'transcript',
    ts: queue?.ts ?? 0,
    text: entry.content.displayText ?? entry.content.text,
    ...(entry.content.attachments && { attachments: [...entry.content.attachments] }),
    ...(entry.content.directoryReferences && { directoryReferences: entry.content.directoryReferences }),
    ...(entry.content.quotes && { quotes: [...entry.content.quotes] }),
    ...(entry.content.inlineReferences && { inlineReferences: [...entry.content.inlineReferences] }),
    deliveryActions: [
      {
        label: copy.editQueuedEntry,
        icon: icon(Pencil),
        onClick: () => retractQueuedEntryToDraft(entry, actions).catch(ignore),
      },
      { label: copy.deleteQueuedEntry, icon: icon(Trash2), onClick: () => actions.retract(entry.entryId).catch(ignore) },
    ],
  }));
  const ids = new Set(bubbles.map((message) => message.id));
  return [
    ...transientMessages.filter((message) => !ids.has(message.id)),
    ...bubbles,
  ];
}

/**
 * A Host-named Turn outranks a later local update that still has none: the
 * IPC reply can land after the Host event that already bound this Message.
 */
export function mergeTransientMessageProjection(
  current: TransientUserMessage,
  update: TransientUserMessage,
): TransientUserMessage {
  update = {
    ...update,
    // A Message's send time is written once; an update's `ts` must not move it.
    ts: current.ts,
    ...(!Object.hasOwn(update, 'deliveryStatus') && current.deliveryStatus !== undefined ? { deliveryStatus: current.deliveryStatus } : {}),
    ...(!Object.hasOwn(update, 'deliveryDetail') && current.deliveryDetail !== undefined ? { deliveryDetail: current.deliveryDetail } : {}),
    ...(!Object.hasOwn(update, 'deliveryActions') && current.deliveryActions !== undefined ? { deliveryActions: current.deliveryActions } : {}),
  };
  return current.hostTurnId !== undefined && update.hostTurnId === undefined
    ? { ...update, hostTurnId: current.hostTurnId }
    : update;
}

/**
 * Project renderer-only messages beside the canonical transcript until the
 * canonical transcript carries the same message id. Keeping the two arrays
 * distinct prevents a prior transient render from masquerading as durable
 * evidence on the next projection.
 */
export function reconcileTransientMessages(
  transient: Map<string, TransientUserMessage>,
  durable: readonly StoredMessage[],
): TransientUserMessage[] {
  for (const message of durable) transient.delete(message.id);
  return [...transient.values()];
}
