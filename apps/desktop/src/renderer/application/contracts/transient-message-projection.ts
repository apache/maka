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

/**
 * Edit/delete controls for steering the Host queued but has not consumed.
 * Both retract the queue entry; edit also hands the text back to the caller's
 * draft restore. `retract` resolves false when the Host call failed.
 */
export function queuedSteeringDeliveryActions(input: {
  locale: UiLocale;
  draftText: string;
  retract: (draftText?: string) => Promise<boolean>;
}): NonNullable<TransientUserMessage['deliveryActions']> {
  const copy = getConversationCopy(input.locale).composer;
  const icon = (glyph: typeof Pencil) => createElement(glyph, { size: ICON_SIZE.control, 'aria-hidden': true });
  return [
    { label: copy.editQueuedEntry, icon: icon(Pencil), onClick: async () => { await input.retract(input.draftText); } },
    { label: copy.deleteQueuedEntry, icon: icon(Trash2), onClick: async () => { await input.retract(); } },
  ];
}

/**
 * Queued steering is a thin projection of the Host queue snapshot, not a stored
 * transient: the bubble appears, updates and disappears with `queue` alone.
 * Appends one transcript bubble per queued current_turn entry — with the
 * retract-backed edit/delete actions — and drops any stored transient the
 * queue now owns, so a message never renders twice.
 */
export function withQueuedSteeringTransients(
  transientMessages: readonly TransientUserMessage[],
  queue:
    | {
        readonly entries: readonly MessageQueueEntryProjection[];
        readonly turnId?: string;
        readonly ts?: number;
      }
    | undefined,
  actions: {
    locale: UiLocale;
    /** Retract the queue entry; resolves false when the Host call failed. */
    retract(entry: MessageQueueEntryProjection, draftText?: string): Promise<boolean>;
  },
): TransientUserMessage[] {
  const steering = (queue?.entries ?? []).filter(
    (entry) => entry.placement === 'current_turn' && entry.state === 'queued',
  );
  if (steering.length === 0) return [...transientMessages];
  const bubbles = steering.map((entry): TransientUserMessage => ({
    id: entry.messageId,
    transientPlacement: 'current_turn',
    pendingSteering: true,
    hostTurnId: queue?.turnId,
    ts: queue?.ts ?? 0,
    text: entry.content.displayText ?? entry.content.text,
    ...(entry.content.attachments && { attachments: [...entry.content.attachments] }),
    ...(entry.content.directoryReferences && {
      directoryReferences: entry.content.directoryReferences,
    }),
    ...(entry.content.quotes && { quotes: [...entry.content.quotes] }),
    ...(entry.content.inlineReferences && {
      inlineReferences: [...entry.content.inlineReferences],
    }),
    deliveryActions: queuedSteeringDeliveryActions({
      locale: actions.locale,
      draftText: entry.content.displayText ?? entry.content.text,
      retract: (draftText) => actions.retract(entry, draftText),
    }),
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
    ...(update.pendingSteering === undefined && current.pendingSteering !== undefined ? { pendingSteering: current.pendingSteering } : {}),
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
