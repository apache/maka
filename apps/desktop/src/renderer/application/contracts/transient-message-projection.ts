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
import type { StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { getConversationCopy, type TransientUserMessageProjection } from '@maka/ui';
import { ICON_SIZE, Pencil, Trash2 } from '@maka/ui/icons';

type TransientUserMessage = TransientUserMessageProjection;

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
 * Replace the queue-backed subset in the exact order supplied by the Host.
 * Other local intents keep their relative position because queue absence is
 * not cancellation or delivery proof.
 */
export function projectQueuedTransientMessages(
  transient: Map<string, TransientUserMessage>,
  queued: readonly TransientUserMessage[],
): void {
  if (queued.length === 0) return;
  const queuedIds = new Set(queued.map((message) => message.id));
  const retained = [...transient.entries()].filter(([id]) => !queuedIds.has(id));
  transient.clear();
  for (const [id, message] of retained) transient.set(id, message);
  for (const message of queued) transient.set(message.id, message);
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
