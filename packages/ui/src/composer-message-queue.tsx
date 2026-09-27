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

import { memo, useRef, useState } from 'react';
import type { TransientUserMessageProjection } from './chat-view.js';
import type { MessageQueueEntryProjection } from '@maka/core/events';
import { IconButton } from '@astryxdesign/core';
import { List, ListItem } from '@astryxdesign/core/List';
import type { ConversationCopy } from './conversation-copy.js';
import { CornerDownLeft, GripVertical, ICON_SIZE, Pencil, Trash2 } from './icons.js';
import { useMountedRef } from './use-mounted-ref.js';

type ComposerQueueEntry = Omit<MessageQueueEntryProjection, 'state'> & {
  state: MessageQueueEntryProjection['state'] | 'local';
  localMessage?: TransientUserMessageProjection;
};

/**
 * The queued follow-up section of the composer staging drawer. It lists
 * follow-up entries — Host-queued and still in flight — so a queued message
 * stays promotable, reorderable and deletable until a Turn consumes it; edit
 * hands it back to the composer.
 * Steering targets the active Turn and lives in the transcript instead, where
 * its delivery state is message metadata rather than a queue row.
 */
export interface ComposerMessageQueueProps {
  queuedMessages: readonly ComposerQueueEntry[];
  copy: ConversationCopy['composer'];
  onPromoteEntry?(entryId: string): void | Promise<void>;
  onEditEntry?(entry: Pick<MessageQueueEntryProjection, 'entryId' | 'content'>): void | Promise<void>;
  onDeleteEntry?(entryId: string): void | Promise<void>;
  onReorderEntries?(entryIds: readonly string[]): void | Promise<void>;
}

/** The plate owns next-turn sends only; steering renders in the transcript. */
export function projectComposerMessageQueue(
  queued: readonly MessageQueueEntryProjection[],
  transient: readonly TransientUserMessageProjection[],
): readonly ComposerQueueEntry[] {
  const followups = queued.filter((entry) => entry.placement === 'next_turn');
  // Dedup against the whole queue: a Host-admitted steering entry renders as a
  // transcript bubble, so its lingering local copy must not stay a plate row.
  const ids = new Set(queued.map((entry) => entry.messageId));
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
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const dragEntryId = useRef<string | null>(null);
  const mountedRef = useMountedRef();
  const copy = props.copy;

  const entries = props.queuedMessages;

  async function runEntryAction(
    entryId: string,
    action: (() => void | Promise<void>) | undefined,
  ): Promise<void> {
    if (!action || pendingEntryId) return;
    setPendingEntryId(entryId);
    try {
      // The caller (app shell) surfaces failures itself; the projection is
      // unchanged on failure, so there is nothing to settle here.
      await action();
    } catch {
      // surfaced by the caller
    } finally {
      if (mountedRef.current) setPendingEntryId(null);
    }
  }

  function dropOn(targetEntryId: string) {
    const fromId = dragEntryId.current;
    dragEntryId.current = null;
    if (!fromId || fromId === targetEntryId || !props.onReorderEntries) return;
    if (!entries.some((entry) => entry.entryId === targetEntryId)) return;
    const ids = entries.filter((entry) => entry.state === 'queued').map((entry) => entry.entryId);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(targetEntryId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, fromId);
    // The Host projection is the only rendered order. Keep other queue actions
    // pending until this request settles instead of maintaining a local overlay.
    void runEntryAction(fromId, () => props.onReorderEntries?.(ids));
  }

  return (
    <div
      className="maka-composer-queue"
      role="region"
      aria-label={copy.queuedMessagesAriaLabel(entries.length)}
    >
      <List className="maka-composer-queue-list" density="compact">
        {entries.map((entry) => {
          const local = entry.localMessage;
          const reorderable =
            entry.state === 'queued'
            && !local
            && Boolean(props.onReorderEntries)
            && pendingEntryId === null;
          return (
            <div
              key={entry.entryId}
              data-maka-queue-drop-target={reorderable ? 'true' : undefined}
              onDragOver={(event) => {
                if (reorderable && dragEntryId.current) event.preventDefault();
              }}
              onDrop={reorderable ? () => dropOn(entry.entryId) : undefined}
            >
              <ListItem
              label={(
                <span className="maka-composer-queue-text" title={entry.content.displayText ?? entry.content.text}>
                  {entry.content.displayText ?? entry.content.text}
                </span>
              )}
              style={{ minHeight: 28, paddingBlock: 0 }}
              startContent={local ? undefined : (
                <span
                  className="maka-composer-queue-grip"
                  draggable={reorderable}
                  aria-label={copy.reorderQueuedEntry}
                  onDragStart={(event) => {
                    dragEntryId.current = entry.entryId;
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', entry.entryId);
                    event.dataTransfer.setData('application/x-maka-queue-entry', entry.entryId);
                  }}
                  onDragEnd={() => {
                    dragEntryId.current = null;
                  }}
                >
                  <GripVertical size={ICON_SIZE.control} aria-hidden="true" />
                </span>
              )}
              endContent={(
                <span className="maka-composer-queue-actions">
                  {local ? local.deliveryActions?.map((action) => (
                    <IconButton key={action.label} variant="ghost" size="sm" type="button"
                      label={action.label}
                      tooltip={local.deliveryStatus ? `${local.deliveryStatus} · ${action.label}` : action.label}
                      icon={action.icon} clickAction={action.onClick} />
                  )) : (
                    <>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        isDisabled={pendingEntryId !== null || entry.state !== 'queued' || !props.onPromoteEntry}
                        label={copy.promoteQueuedEntry}
                        tooltip={copy.promoteQueuedEntry}
                        onClick={() => void runEntryAction(
                          entry.entryId,
                          props.onPromoteEntry
                            ? () => props.onPromoteEntry?.(entry.entryId)
                            : undefined,
                        )}
                        icon={<CornerDownLeft size={ICON_SIZE.control} aria-hidden="true" />}
                      />
                      <IconButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        isDisabled={pendingEntryId !== null || entry.state !== 'queued' || !props.onEditEntry}
                        label={copy.editQueuedEntry}
                        tooltip={copy.editQueuedEntry}
                        onClick={() => void runEntryAction(
                          entry.entryId,
                          props.onEditEntry ? () => props.onEditEntry?.(entry) : undefined,
                        )}
                        icon={<Pencil size={ICON_SIZE.control} aria-hidden="true" />}
                      />
                      <IconButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        isDisabled={pendingEntryId !== null || entry.state !== 'queued' || !props.onDeleteEntry}
                        label={copy.deleteQueuedEntry}
                        tooltip={copy.deleteQueuedEntry}
                        onClick={() => void runEntryAction(
                          entry.entryId,
                          props.onDeleteEntry
                            ? () => props.onDeleteEntry?.(entry.entryId)
                            : undefined,
                        )}
                        icon={<Trash2 size={ICON_SIZE.control} aria-hidden="true" />}
                      />
                    </>
                  )}
                </span>
              )}
            />
            </div>
          );
        })}
      </List>
    </div>
  );
});
