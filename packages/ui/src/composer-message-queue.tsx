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
import { Button, IconButton, Tooltip } from '@astryxdesign/core';
import { List, ListItem } from '@astryxdesign/core/List';
import type { ConversationCopy } from './conversation-copy.js';
import { Check, GripVertical, HelpCircle, ICON_SIZE, Trash2, X } from './icons.js';
import { useMountedRef } from './use-mounted-ref.js';

type ComposerQueueEntry = Omit<MessageQueueEntryProjection, 'state'> & {
  state: MessageQueueEntryProjection['state'] | 'local';
  localMessage?: TransientUserMessageProjection;
};

/**
 * The pending plate above the composer card. It lists both pending steering
 * and follow-up entries so a submitted message stays editable, reorderable and
 * deletable while it waits for the active Turn to reach a steering boundary.
 * Steering enters the transcript only when Runtime actually consumes it.
 */
export interface ComposerMessageQueueProps {
  queuedMessages: readonly ComposerQueueEntry[];
  queueRevision?: number;
  copy: ConversationCopy['composer'];
  onPromoteEntry?(entryId: string): void | Promise<void>;
  onUpdateEntry?(entryId: string, expectedQueueRevision: number, text: string): void | Promise<void>;
  onDeleteEntry?(entryId: string): void | Promise<void>;
  onReorderEntries?(entryIds: readonly string[]): void | Promise<void>;
}

/** Host entries own queue actions; local sends remain visible before a receipt. */
export function projectComposerMessageQueue(
  queued: readonly MessageQueueEntryProjection[],
  transient: readonly TransientUserMessageProjection[],
): readonly ComposerQueueEntry[] {
  const ids = new Set(queued.map((entry) => entry.messageId));
  const pending = transient.filter((message) => (message.pendingSteering || message.transientPlacement === 'next_turn') && !ids.has(message.id));
  if (pending.length === 0) return queued;
  return [...queued, ...pending.map((message): ComposerQueueEntry => ({
    entryId: message.id, messageId: message.id, content: { text: message.text },
    placement: message.transientPlacement, state: 'local', localMessage: message,
  }))];
}

export const ComposerMessageQueue = memo(function ComposerMessageQueue(
  props: ComposerMessageQueueProps,
) {
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editingQueueRevision, setEditingQueueRevision] = useState(0);
  const [editingText, setEditingText] = useState('');
  const dragEntryId = useRef<string | null>(null);
  const mountedRef = useMountedRef();
  const copy = props.copy;

  const entries = props.queuedMessages;
  const groups = (['current_turn', 'next_turn'] as const).map((placement) => ({
    placement, entries: entries.filter((entry) => entry.placement === placement),
  })).filter((group) => group.entries.length > 0);

  async function runEntryAction(
    entryId: string,
    action: (() => void | Promise<void>) | undefined,
  ): Promise<boolean> {
    if (!action || pendingEntryId) return false;
    setPendingEntryId(entryId);
    try {
      // The caller (app shell) surfaces failures itself; the projection is
      // unchanged on failure, so there is nothing to settle here.
      await action();
      return true;
    } catch {
      // surfaced by the caller
      return false;
    } finally {
      if (mountedRef.current) setPendingEntryId(null);
    }
  }

  function dropOn(targetEntryId: string) {
    const fromId = dragEntryId.current;
    dragEntryId.current = null;
    if (!fromId || fromId === targetEntryId || !props.onReorderEntries) return;
    const target = entries.find((entry) => entry.entryId === targetEntryId);
    const source = entries.find((entry) => entry.entryId === fromId);
    if (!target || source?.placement !== target.placement) return;
    const ids = entries.filter((entry) => entry.placement === target.placement && entry.state === 'queued').map((entry) => entry.entryId);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(targetEntryId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, fromId);
    // The Host projection is the only rendered order. Keep other queue actions
    // pending until this request settles instead of maintaining a local overlay.
    void runEntryAction(fromId, () => props.onReorderEntries?.(ids));
  }

  function beginEdit(entry: ComposerQueueEntry) {
    if (pendingEntryId || !props.onUpdateEntry || props.queueRevision === undefined) return;
    setEditingEntryId(entry.entryId);
    const text = entry.content.displayText ?? entry.content.text;
    setEditingQueueRevision(props.queueRevision);
    setEditingText(text);
  }

  async function commitEdit(entryId: string) {
    const text = editingText.trim();
    if (!text) return;
    const updated = await runEntryAction(entryId, () =>
      props.onUpdateEntry?.(entryId, editingQueueRevision, text)
    );
    if (updated && mountedRef.current) {
      setEditingEntryId(null);
      setEditingQueueRevision(0);
      setEditingText('');
    }
  }

  function cancelEdit() {
    setEditingEntryId(null);
    setEditingQueueRevision(0);
    setEditingText('');
  }

  return (
    <div
      className="maka-composer-queue"
      role="region"
      aria-label={copy.queuedMessagesAriaLabel(entries.length)}
    >
      {groups.map((group, index) => <section key={group.placement} data-queue-placement={group.placement}>
        <div className="maka-composer-queue-status">
          <span>{group.placement === 'current_turn' ? copy.steeringPending : copy.followupPending}</span>
          {index === 0 && <Tooltip alignment="end" content={<span style={{ whiteSpace: 'pre-line' }}>{copy.queueShortcuts}</span>}>
            <IconButton variant="ghost" size="sm" type="button" label={copy.queueShortcutsLabel}
              icon={<HelpCircle size={ICON_SIZE.control} aria-hidden="true" />} />
          </Tooltip>}
        </div>
        <List className="maka-composer-queue-list" density="compact">
        {group.entries.map((entry) => {
          const editing = editingEntryId === entry.entryId;
          const reorderable =
            entry.state === 'queued'
            && !editing
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
              label={editing ? (
                <textarea
                  autoFocus
                  className="maka-composer-queue-edit"
                  aria-label={copy.editQueuedEntry}
                  rows={1}
                  value={editingText}
                  onInput={(event) => setEditingText(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter'
                      && !event.shiftKey
                      && !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void commitEdit(entry.entryId);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelEdit();
                    }
                  }}
                />
              ) : (
                <>
                  <span className="maka-composer-queue-text" title={entry.content.displayText ?? entry.content.text}>
                    {entry.content.displayText ?? entry.content.text}
                  </span>
                  {entry.localMessage?.deliveryStatus && <span className="maka-composer-queue-delivery" role="status" title={entry.localMessage.deliveryDetail}>{entry.localMessage.deliveryStatus}</span>}
                </>
              )}
              style={{ minHeight: 28, paddingBlock: 0 }}
              startContent={(
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
                  {entry.localMessage?.deliveryActions?.length ? entry.localMessage.deliveryActions.map((action) => (
                    <Button key={action.label} variant="ghost" size="sm" type="button" label={action.label} onClick={action.onClick} />
                  )) : editing ? (
                    <>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        isDisabled={pendingEntryId !== null || editingText.trim().length === 0}
                        label={copy.saveQueuedEntry}
                        tooltip={copy.saveQueuedEntry}
                        onClick={() => void commitEdit(entry.entryId)}
                        icon={<Check size={ICON_SIZE.control} aria-hidden="true" />}
                      />
                      <IconButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        isDisabled={pendingEntryId !== null}
                        label={copy.cancelQueuedEntryEdit}
                        tooltip={copy.cancelQueuedEntryEdit}
                        onClick={cancelEdit}
                        icon={<X size={ICON_SIZE.control} aria-hidden="true" />}
                      />
                    </>
                  ) : (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        isDisabled={
                          pendingEntryId !== null
                          || entry.state !== 'queued'
                          || props.queueRevision === undefined
                          || !props.onUpdateEntry
                        }
                        label={copy.editQueuedEntry}
                        onClick={() => beginEdit(entry)}
                      />
                      {entry.placement === 'next_turn' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          isDisabled={pendingEntryId !== null || entry.state !== 'queued'}
                          label={copy.promoteQueuedEntry}
                          onClick={() => void runEntryAction(
                            entry.entryId,
                            props.onPromoteEntry
                              ? () => props.onPromoteEntry?.(entry.entryId)
                              : undefined,
                          )}
                        />
                      ) : null}
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
      </section>)}
    </div>
  );
});
