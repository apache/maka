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

import { Button, IconButton, Tooltip } from "@astryxdesign/core";
import { List, ListItem } from "@astryxdesign/core/List";
import type { MessageQueueEntryProjection } from "@maka/core/events";
import type { ConversationCopy } from "./conversation-copy.js";
import {
  type ComposerQueueEntry,
  useComposerMessageQueueController,
} from "./composer-message-queue-controller.js";
import { Check, GripVertical, HelpCircle, ICON_SIZE, Trash2, X } from "./icons.js";
import { PlatformShortcutText } from "./platform-shortcut-text.js";

export interface ComposerMessageQueueViewProps {
  entries: readonly ComposerQueueEntry[];
  queueRevision?: number;
  copy: ConversationCopy["composer"];
  onEditEntry?(entry: Pick<MessageQueueEntryProjection, "entryId" | "content">): void | Promise<void>;
  onPromoteEntry?(entryId: string): void | Promise<void>;
  onUpdateEntry?(entryId: string, expectedQueueRevision: number, text: string): void | Promise<void>;
  onDeleteEntry?(entryId: string): void | Promise<void>;
  onReorderEntries?(entryIds: readonly string[], expectedQueueRevision: number): void | Promise<void>;
}

type QueueController = ReturnType<typeof useComposerMessageQueueController>;

export function ComposerMessageQueueView(props: ComposerMessageQueueViewProps) {
  const { entries, ...queueProps } = props;
  const controller = useComposerMessageQueueController(entries, queueProps);

  return (
    <div
      className="maka-composer-queue"
      role="region"
      aria-label={props.copy.queuedMessagesAriaLabel(entries.length)}
    >
      {controller.groups.map((group, index) => (
        <QueueGroup
          key={group.placement}
          controller={controller}
          entries={group.entries}
          placement={group.placement}
          showHelp={index === 0}
          {...queueProps}
        />
      ))}
    </div>
  );
}

interface QueueGroupProps extends ComposerMessageQueueViewProps {
  controller: QueueController;
  entries: readonly ComposerQueueEntry[];
  placement: ComposerQueueEntry["placement"];
  showHelp: boolean;
}

function QueueGroup({ controller, entries, placement, showHelp, ...props }: QueueGroupProps) {
  const copy = props.copy;
  return (
    <section data-queue-placement={placement}>
      <div className="maka-composer-queue-status">
        <span>{placement === "current_turn" ? copy.queuedMessages : copy.queuedMessages}</span>
        {showHelp ? (
          <Tooltip
            alignment="end"
            content={<span style={{ whiteSpace: "pre-line" }}><PlatformShortcutText apple="⌘ K" other="Ctrl K" /></span>}
          >
            <IconButton
              variant="ghost"
              size="sm"
              type="button"
              label={copy.queuedMessages}
              icon={<HelpCircle size={ICON_SIZE.control} aria-hidden="true" />}
            />
          </Tooltip>
        ) : null}
      </div>
      <List className="maka-composer-queue-list" density="compact">
        {entries.map((entry) => (
          <QueueRow key={entry.entryId} controller={controller} entry={entry} {...props} />
        ))}
      </List>
    </section>
  );
}

interface QueueRowProps extends Omit<ComposerMessageQueueViewProps, "entries"> {
  controller: QueueController;
  entry: ComposerQueueEntry;
}

function QueueRow({ controller, entry, ...props }: QueueRowProps) {
  const copy = props.copy;
  const editing = controller.editing?.entryId === entry.entryId;
  const reorderable = controller.canReorder(entry);

  return (
    <div
      data-maka-queue-drop-target={reorderable ? "true" : undefined}
      onDragOver={(event) => {
        if (reorderable && controller.hasDrag()) event.preventDefault();
      }}
      onDrop={reorderable ? () => controller.dropOn(entry.entryId) : undefined}
    >
      <ListItem
        label={editing ? (
          <QueueEditor controller={controller} label={copy.editQueuedEntry} />
        ) : (
          <QueueEntryLabel entry={entry} />
        )}
        style={{ minHeight: 28, paddingBlock: 0 }}
        startContent={<QueueDragHandle controller={controller} entry={entry} enabled={reorderable} label={copy.reorderQueuedEntry} />}
        endContent={<QueueEntryActions controller={controller} editing={editing} entry={entry} {...props} />}
      />
    </div>
  );
}

function QueueEditor({ controller, label }: { controller: QueueController; label: string }) {
  return (
    <textarea
      autoFocus
      className="maka-composer-queue-edit"
      aria-label={label}
      rows={1}
      value={controller.editing?.text ?? ""}
      onInput={(event) => controller.setEditingText(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void controller.commitEdit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          controller.cancelEdit();
        }
      }}
    />
  );
}

function QueueEntryLabel({ entry }: { entry: ComposerQueueEntry }) {
  const text = entry.content.displayText ?? entry.content.text;
  return (
    <>
      <span className="maka-composer-queue-text" title={text}>{text}</span>
      {entry.localMessage?.deliveryStatus ? (
        <span
          className="maka-composer-queue-delivery"
          role="status"
          title={entry.localMessage.deliveryDetail}
        >
          {entry.localMessage.deliveryStatus}
        </span>
      ) : null}
    </>
  );
}

function QueueDragHandle(props: {
  controller: QueueController;
  entry: ComposerQueueEntry;
  enabled: boolean;
  label: string;
}) {
  return (
    <span
      className="maka-composer-queue-grip"
      draggable={props.enabled}
      aria-label={props.label}
      onDragStart={(event) => {
        if (!props.enabled || props.controller.beginDrag(props.entry.entryId) === undefined) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", props.entry.entryId);
        event.dataTransfer.setData("application/x-maka-queue-entry", props.entry.entryId);
      }}
      onDragEnd={props.controller.endDrag}
    >
      <GripVertical size={ICON_SIZE.control} aria-hidden="true" />
    </span>
  );
}

interface QueueEntryActionsProps extends Omit<ComposerMessageQueueViewProps, "entries"> {
  controller: QueueController;
  editing: boolean;
  entry: ComposerQueueEntry;
}

function QueueEntryActions({ controller, editing, entry, ...props }: QueueEntryActionsProps) {
  if (entry.localMessage) {
    return (
      <span className="maka-composer-queue-actions">
        {entry.localMessage.deliveryActions?.map((action) => (
          <IconButton
            key={action.label}
            variant="ghost"
            size="sm"
            type="button"
            label={action.label}
            tooltip={action.label}
            icon={action.icon}
            onClick={action.onClick}
          />
        ))}
      </span>
    );
  }
  return (
    <span className="maka-composer-queue-actions">
      {editing
        ? <QueueEditActions controller={controller} copy={props.copy} />
        : <QueueDefaultActions controller={controller} entry={entry} {...props} />}
    </span>
  );
}

function QueueEditActions(props: {
  controller: QueueController;
  copy: ConversationCopy["composer"];
}) {
  const disabled = props.controller.pendingEntryId !== null;
  return (
    <>
      <IconButton
        variant="ghost"
        size="sm"
        type="button"
        isDisabled={disabled || (props.controller.editing?.text.trim().length ?? 0) === 0}
        label={props.copy.quoteCommentSave}
        tooltip={props.copy.quoteCommentSave}
        onClick={() => void props.controller.commitEdit()}
        icon={<Check size={ICON_SIZE.control} aria-hidden="true" />}
      />
      <IconButton
        variant="ghost"
        size="sm"
        type="button"
        isDisabled={disabled}
        label={props.copy.quoteCommentCancel}
        tooltip={props.copy.quoteCommentCancel}
        onClick={props.controller.cancelEdit}
        icon={<X size={ICON_SIZE.control} aria-hidden="true" />}
      />
    </>
  );
}

function QueueDefaultActions({ controller, entry, ...props }: Omit<QueueEntryActionsProps, "editing">) {
  const busy = controller.pendingEntryId !== null;
  const queued = entry.state === "queued";
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        isDisabled={busy || !queued || (!props.onEditEntry && (props.queueRevision === undefined || !props.onUpdateEntry))}
        label={props.copy.editQueuedEntry}
        onClick={() => controller.beginEdit(entry)}
      />
      {entry.placement === "next_turn" ? (
        <Button
          variant="ghost"
          size="sm"
          type="button"
          isDisabled={busy || !queued}
          label={props.copy.promoteQueuedEntry}
          onClick={() => void controller.runAction(
            entry.entryId,
            props.onPromoteEntry ? () => props.onPromoteEntry?.(entry.entryId) : undefined,
          )}
        />
      ) : null}
      <IconButton
        variant="ghost"
        size="sm"
        type="button"
        isDisabled={busy || !queued || !props.onDeleteEntry}
        label={props.copy.deleteQueuedEntry}
        tooltip={props.copy.deleteQueuedEntry}
        onClick={() => void controller.runAction(
          entry.entryId,
          props.onDeleteEntry ? () => props.onDeleteEntry?.(entry.entryId) : undefined,
        )}
        icon={<Trash2 size={ICON_SIZE.control} aria-hidden="true" />}
      />
    </>
  );
}
