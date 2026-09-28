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

import { memo } from 'react';
import type { TransientUserMessageProjection } from './chat-view.js';
import type { MessageQueueEntryProjection } from '@maka/core/events';
import type { ComposerQueueEntry } from './composer-message-queue-controller.js';
import {
  ComposerMessageQueueView,
  type ComposerMessageQueueViewProps,
} from './composer-message-queue-view.js';

export type { ComposerQueueEntry } from './composer-message-queue-controller.js';

export interface ComposerMessageQueueHostProps {
  queuedMessages?: readonly MessageQueueEntryProjection[];
  queuedMessageRevision?: number;
  onPromoteQueuedEntry?(entryId: string): void | Promise<void>;
  /** Compatibility callback for surfaces that still restore a queued entry into the draft. */
  onEditQueuedEntry?(
    entry: Pick<MessageQueueEntryProjection, 'entryId' | 'content'>,
  ): void | Promise<void>;
  onUpdateQueuedEntry?(
    entryId: string,
    expectedQueueRevision: number,
    text: string,
  ): void | Promise<void>;
  onDeleteQueuedEntry?(entryId: string): void | Promise<void>;
  onReorderQueuedEntries?(
    entryIds: readonly string[],
    expectedQueueRevision: number,
  ): void | Promise<void>;
}

export interface ComposerMessageQueueProps extends Omit<ComposerMessageQueueViewProps, 'entries'> {
  queuedMessages: readonly ComposerQueueEntry[];
  onEditEntry?(
    entry: Pick<MessageQueueEntryProjection, 'entryId' | 'content'>,
  ): void | Promise<void>;
}

/** Host entries own queue actions; local sends remain visible before a receipt. */
export function projectComposerMessageQueue(
  queued: readonly MessageQueueEntryProjection[],
  transient: readonly TransientUserMessageProjection[],
): readonly ComposerQueueEntry[] {
  const followups = queued.filter((entry) => entry.placement === 'next_turn');
  const ids = new Set(followups.map((entry) => entry.messageId));
  const pending = transient.filter((message) => message.transientPlacement !== 'transcript' && !ids.has(message.id));
  if (pending.length === 0) return followups;
  return [...followups, ...pending.map((message): ComposerQueueEntry => ({
    entryId: message.id, messageId: message.id, content: { text: message.text },
    placement: 'next_turn', state: 'local', localMessage: message,
  }))];
}

export const ComposerMessageQueue = memo(function ComposerMessageQueue(
  props: ComposerMessageQueueProps,
) {
  const { queuedMessages, ...viewProps } = props;
  return <ComposerMessageQueueView entries={queuedMessages} {...viewProps} />;
});
