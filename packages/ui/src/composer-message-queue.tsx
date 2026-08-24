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
import type { MessageQueueEntryProjection } from '@maka/core/events';
import { IconButton } from '@astryxdesign/core';
import { List, ListItem } from '@astryxdesign/core/List';
import type { ConversationCopy } from './conversation-copy.js';
import { CornerDownRight, GripVertical, ICON_SIZE, Undo2 } from './icons.js';
import { useMountedRef } from './use-mounted-ref.js';

/**
 * The pending plate above the composer card: the follow-up queue in send
 * order (first at the top). Steering entries never appear here — 立即发送 and
 * Shift+Enter hand a message to the active Turn, and it leaves the plate at
 * that moment (it surfaces in the transcript when the Turn consumes it).
 * Every action round-trips through the Runtime Host — the plate mirrors the
 * authoritative queue projection, never a local copy.
 */
export interface ComposerMessageQueueProps {
  queuedMessages: readonly MessageQueueEntryProjection[];
  copy: ConversationCopy['composer'];
  onPromoteEntry?(entryId: string): void | Promise<void>;
  onRetractEntry?(entry: MessageQueueEntryProjection): void | Promise<void>;
  onReorderEntries?(entryIds: readonly string[]): void | Promise<void>;
}

export const ComposerMessageQueue = memo(function ComposerMessageQueue(
  props: ComposerMessageQueueProps,
) {
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const dragEntryId = useRef<string | null>(null);
  const mountedRef = useMountedRef();
  const copy = props.copy;

  const followup = props.queuedMessages;

  async function runEntryAction(
    entryId: string,
    action: (() => void | Promise<void>) | undefined,
  ) {
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
    const ids = followup.map((entry) => entry.entryId);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(targetEntryId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, fromId);
    // The Host projection is the only rendered order. Keep other queue actions
    // pending until this request settles instead of maintaining a local overlay.
    void runEntryAction(fromId, () => props.onReorderEntries?.(ids));
  }

  function retractButton(entry: MessageQueueEntryProjection) {
    return (
      <IconButton
        variant="ghost"
        size="sm"
        type="button"
        isDisabled={pendingEntryId !== null}
        label={copy.retractQueuedEntry}
        tooltip={copy.retractQueuedEntry}
        onClick={() => void runEntryAction(
          entry.entryId,
          props.onRetractEntry ? () => props.onRetractEntry?.(entry) : undefined,
        )}
        icon={<Undo2 size={ICON_SIZE.control} aria-hidden="true" />}
      />
    );
  }

  return (
    <div
      className="maka-composer-queue"
      role="region"
      aria-label={copy.queuedMessagesAriaLabel(followup.length)}
    >
      <List className="maka-composer-queue-list" density="compact">
        {followup.map((entry) => (
          <div
            key={entry.entryId}
            onDragOver={(event) => {
              if (dragEntryId.current) event.preventDefault();
            }}
            onDrop={() => dropOn(entry.entryId)}
          >
            <ListItem
              label={entry.content.displayText ?? entry.content.text}
              style={{ minHeight: 28, paddingBlock: 0 }}
              startContent={(
                <span
                  className="maka-composer-queue-grip"
                  draggable={Boolean(props.onReorderEntries) && pendingEntryId === null}
                  aria-label={copy.reorderQueuedEntry}
                  onDragStart={(event) => {
                    dragEntryId.current = entry.entryId;
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', entry.entryId);
                  }}
                  onDragEnd={() => {
                    dragEntryId.current = null;
                  }}
                >
                  <GripVertical size={ICON_SIZE.control} aria-hidden="true" />
                </span>
              )}
              endContent={(
                <>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    isDisabled={pendingEntryId !== null}
                    label={copy.promoteQueuedEntry}
                    tooltip={copy.promoteQueuedEntry}
                    onClick={() => void runEntryAction(
                      entry.entryId,
                      props.onPromoteEntry
                        ? () => props.onPromoteEntry?.(entry.entryId)
                        : undefined,
                    )}
                    icon={<CornerDownRight size={ICON_SIZE.control} aria-hidden="true" />}
                  />
                  {retractButton(entry)}
                </>
              )}
            />
          </div>
        ))}
      </List>
    </div>
  );
});
