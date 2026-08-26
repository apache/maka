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

import type { StoredMessage } from '@maka/core/session';
import type { MessageLifecycleStatus } from '@maka/runtime-host/protocol';
import type { TransientUserMessageProjection } from '@maka/ui';

type TransientUserMessage = TransientUserMessageProjection;

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

export function mergeTransientMessageProjection(
  current: TransientUserMessage,
  update: TransientUserMessage,
): TransientUserMessage {
  const hostBoundCurrentTurn =
    current.transientPlacement === 'current_turn'
    && update.transientPlacement === 'current_turn'
    && current.turnId !== current.id
    && update.turnId === update.id;
  return hostBoundCurrentTurn ? { ...update, turnId: current.turnId } : update;
}

export function reconcileTransientMessageLifecycle(
  transient: Map<string, TransientUserMessage>,
  messages: readonly { messageId: string; status: MessageLifecycleStatus }[],
): void {
  for (const message of messages) {
    if (message.status === 'cancelled') transient.delete(message.messageId);
  }
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
  options: { includeTransient?: boolean } = {},
): TransientUserMessage[] {
  for (const message of durable) transient.delete(message.id);
  if (transient.size === 0 || options.includeTransient === false) return [];
  return [...transient.values()];
}
