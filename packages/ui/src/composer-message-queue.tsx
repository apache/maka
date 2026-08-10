import {
  memo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Check,
  CornerDownRight,
  GripVertical,
  ListEnd,
  Paperclip,
  Pencil,
  TextQuote,
  Trash2,
  Undo2,
  X,
} from './icons.js';
import { Button as UiButton, IconButton } from '@astryxdesign/core';
import type {
  MessageQueueEntryProjection,
  MessageQueueEntryState,
  MessageQueueMutation,
  MessageQueuePlacement,
} from '@maka/core';
import type { ConversationCopy } from './conversation-copy.js';
import { useMountedRef } from './use-mounted-ref.js';

export interface ComposerMessageQueueProps {
  queuedMessages: {
    paused?: boolean;
    steering: readonly MessageQueueEntryProjection[];
    followup: readonly MessageQueueEntryProjection[];
    pendingEntryIds?: ReadonlySet<string>;
  };
  copy: ConversationCopy['composer'];
  onRetractQueued?(): void | Promise<void>;
  onQueueMutation?(mutation: MessageQueueMutation): boolean | void | Promise<boolean | void>;
}

export const ComposerMessageQueue = memo(function ComposerMessageQueue(
  props: ComposerMessageQueueProps,
) {
  const [retractPending, setRetractPending] = useState(false);
  const [queueMutationPending, setQueueMutationPending] = useState(false);
  const [editingQueueEntryId, setEditingQueueEntryId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState('');
  const mountedRef = useMountedRef();
  const queueSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const queueCount =
    props.queuedMessages.steering.length + props.queuedMessages.followup.length;

  async function retractQueued() {
    if (!props.onRetractQueued || retractPending) return;
    setRetractPending(true);
    try {
      await props.onRetractQueued();
    } finally {
      if (mountedRef.current) setRetractPending(false);
    }
  }

  async function mutateQueue(mutation: MessageQueueMutation): Promise<boolean> {
    if (!props.onQueueMutation || queueMutationPending) return false;
    setQueueMutationPending(true);
    try {
      return (await props.onQueueMutation(mutation)) !== false;
    } finally {
      if (mountedRef.current) setQueueMutationPending(false);
    }
  }

  function beginQueueEdit(entry: MessageQueueEntryProjection) {
    if (entry.state !== 'queued') return;
    setEditingQueueEntryId(entry.entryId);
    setEditingQueueText(entry.content.text);
  }

  async function commitQueueEdit(entry: MessageQueueEntryProjection) {
    const text = editingQueueText.trim();
    if (!text) return;
    if (
      await mutateQueue({
        kind: 'update',
        entryId: entry.entryId,
        text,
      })
    ) {
      setEditingQueueEntryId(null);
      setEditingQueueText('');
    }
  }

  function reorderQueue(
    entries: readonly MessageQueueEntryProjection[],
    placement: 'current_turn' | 'next_turn',
    draggedEntryId: string,
    targetEntryId: string,
  ) {
    if (draggedEntryId === targetEntryId) return;
    const queued = entries.filter((entry) => entry.state === 'queued');
    const entryIds = reorderQueueEntryIds(queued, draggedEntryId, targetEntryId);
    if (!entryIds) return;
    void mutateQueue({
      kind: 'reorder',
      placement,
      entryIds,
    });
  }

  function handleQueueDragEnd(event: DragEndEvent) {
    const draggedEntryId = String(event.active.id);
    const targetEntryId = event.over ? String(event.over.id) : null;
    if (!targetEntryId || targetEntryId === draggedEntryId) return;
    for (const [placement, entries] of [
      ['current_turn', props.queuedMessages.steering],
      ['next_turn', props.queuedMessages.followup],
    ] as const) {
      if (
        entries.some((entry) => entry.entryId === draggedEntryId && entry.state === 'queued') &&
        entries.some((entry) => entry.entryId === targetEntryId && entry.state === 'queued')
      ) {
        reorderQueue(entries, placement, draggedEntryId, targetEntryId);
        return;
      }
    }
  }

  return (
    <div
      className="maka-composer-queue"
      role="region"
      aria-label={props.copy.queuedMessagesAriaLabel(queueCount)}
    >
      <div className="maka-composer-queue-list">
        {props.queuedMessages.paused ? (
          <div className="maka-composer-queue-paused">
            <span>{props.copy.queuePaused}</span>
            {props.onQueueMutation ? (
              <UiButton
                variant="ghost"
                size="sm"
                className="maka-composer-queue-resume"
                label={props.copy.resumeQueue}
                isDisabled={queueMutationPending}
                onClick={() => {
                  void mutateQueue({ kind: 'resume' });
                }}
              />
            ) : null}
          </div>
        ) : null}
        <DndContext
          sensors={queueSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleQueueDragEnd}
        >
          {([
            ['current_turn', props.queuedMessages.steering],
            ['next_turn', props.queuedMessages.followup],
          ] as const).map(([placement, entries]) => (
            <SortableContext
              key={placement}
              items={entries
                .filter((entry) => entry.state === 'queued')
                .map((entry) => entry.entryId)}
              strategy={verticalListSortingStrategy}
            >
              {entries.map((entry) => {
                const editing = editingQueueEntryId === entry.entryId;
                const canMutate =
                  entry.state === 'queued' &&
                  props.onQueueMutation !== undefined &&
                  !props.queuedMessages.pendingEntryIds?.has(entry.entryId) &&
                  !queueMutationPending;
                const pending = props.queuedMessages.pendingEntryIds?.has(entry.entryId) === true;
                return (
                  <SortableQueueRow
                    key={entry.entryId}
                    entryId={entry.entryId}
                    placement={placement}
                    state={entry.state}
                    pending={pending}
                    dragDisabled={!canMutate || editing}
                    dragLabel={props.copy.reorderQueuedMessage}
                  >
                    {placement === 'current_turn' ? (
                      <CornerDownRight size={14} aria-hidden="true" />
                    ) : (
                      <ListEnd size={14} aria-hidden="true" />
                    )}
                    <span className="maka-composer-queue-kind">
                      {placement === 'current_turn'
                        ? entry.state === 'in_flight'
                          ? props.copy.steerDeliveringLabel
                          : props.copy.steerQueuedLabel
                        : props.copy.followUpQueuedLabel}
                    </span>
                    {editing ? (
                      <input
                        autoFocus
                        className="maka-composer-queue-edit"
                        value={editingQueueText}
                        aria-label={props.copy.editQueuedMessage}
                        onChange={(event) => setEditingQueueText(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void commitQueueEdit(entry);
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            setEditingQueueEntryId(null);
                          }
                        }}
                      />
                    ) : (
                      <span className="maka-composer-queue-content">
                        <span className="maka-composer-queue-text">{entry.content.text}</span>
                        {(entry.content.attachments?.length ?? 0) > 0 ? (
                          <span
                            className="maka-composer-queue-context"
                            title={props.copy.queuedAttachmentCount(entry.content.attachments!.length)}
                          >
                            <Paperclip size={11} aria-hidden="true" />
                            {entry.content.attachments!.length}
                          </span>
                        ) : null}
                        {(entry.content.quotes?.length ?? 0) > 0 ? (
                          <span
                            className="maka-composer-queue-context"
                            title={props.copy.queuedQuoteCount(entry.content.quotes!.length)}
                          >
                            <TextQuote size={11} aria-hidden="true" />
                            {entry.content.quotes!.length}
                          </span>
                        ) : null}
                      </span>
                    )}
                    <span className="maka-composer-queue-actions">
                      {editing ? (
                        <>
                          <IconButton
                            variant="ghost"
                            type="button"
                            size="sm"
                            label={props.copy.saveQueuedMessage}
                            tooltip={props.copy.saveQueuedMessage}
                            isDisabled={
                              queueMutationPending || editingQueueText.trim().length === 0
                            }
                            onClick={() => {
                              void commitQueueEdit(entry);
                            }}
                            icon={<Check size={13} aria-hidden="true" />}
                          />
                          <IconButton
                            variant="ghost"
                            type="button"
                            size="sm"
                            label={props.copy.cancelQueuedEdit}
                            tooltip={props.copy.cancelQueuedEdit}
                            onClick={() => setEditingQueueEntryId(null)}
                            icon={<X size={13} aria-hidden="true" />}
                          />
                        </>
                      ) : (
                        <>
                          {placement === 'next_turn' ? (
                            <IconButton
                              variant="ghost"
                              type="button"
                              size="sm"
                              label={props.copy.sendQueuedNow}
                              tooltip={props.copy.sendQueuedNowTooltip}
                              isDisabled={!canMutate}
                              onClick={() => {
                                void mutateQueue({
                                  kind: 'promote',
                                  entryId: entry.entryId,
                                });
                              }}
                              icon={<CornerDownRight size={13} aria-hidden="true" />}
                            />
                          ) : null}
                          <IconButton
                            variant="ghost"
                            type="button"
                            size="sm"
                            label={props.copy.editQueuedMessage}
                            tooltip={props.copy.editQueuedMessage}
                            isDisabled={!canMutate}
                            onClick={() => beginQueueEdit(entry)}
                            icon={<Pencil size={13} aria-hidden="true" />}
                          />
                          <IconButton
                            variant="ghost"
                            type="button"
                            size="sm"
                            label={props.copy.deleteQueuedMessage}
                            tooltip={props.copy.deleteQueuedMessage}
                            isDisabled={!canMutate}
                            onClick={() => {
                              void mutateQueue({
                                kind: 'remove',
                                entryId: entry.entryId,
                              });
                            }}
                            icon={<Trash2 size={13} aria-hidden="true" />}
                          />
                        </>
                      )}
                    </span>
                  </SortableQueueRow>
                );
              })}
            </SortableContext>
          ))}
        </DndContext>
      </div>
      {props.onRetractQueued ? (
        <IconButton
          variant="ghost"
          type="button"
          size="sm"
          className="maka-composer-queue-retract"
          isDisabled={retractPending}
          aria-busy={retractPending ? 'true' : undefined}
          label={props.copy.retractQueued}
          tooltip={props.copy.retractQueued}
          onClick={() => {
            void retractQueued();
          }}
          icon={<Undo2 size={14} aria-hidden="true" />}
        />
      ) : null}
    </div>
  );
});

export function reorderQueueEntryIds(
  entries: readonly MessageQueueEntryProjection[],
  draggedEntryId: string,
  targetEntryId: string,
): string[] | undefined {
  const from = entries.findIndex((entry) => entry.entryId === draggedEntryId);
  const to = entries.findIndex((entry) => entry.entryId === targetEntryId);
  if (from < 0 || to < 0 || from === to) return undefined;
  const reordered = [...entries];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  return reordered.map((entry) => entry.entryId);
}

function SortableQueueRow(props: {
  entryId: string;
  placement: MessageQueuePlacement;
  state: MessageQueueEntryState;
  pending: boolean;
  dragDisabled: boolean;
  dragLabel: string;
  children: ReactNode;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: props.entryId,
    disabled: props.dragDisabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
  } satisfies CSSProperties;

  return (
    <div
      ref={setNodeRef}
      className="maka-composer-queue-row"
      data-entry-id={props.entryId}
      data-placement={props.placement === 'current_turn' ? 'current' : 'next'}
      data-state={props.state}
      data-pending={props.pending || undefined}
      data-dragging={isDragging || undefined}
      aria-busy={props.pending || undefined}
      style={style}
    >
      <IconButton
        ref={setActivatorNodeRef}
        variant="ghost"
        size="sm"
        className="maka-composer-queue-grip"
        label={props.dragLabel}
        icon={<GripVertical size={14} aria-hidden="true" />}
        isDisabled={props.dragDisabled}
        {...attributes}
        {...listeners}
      />
      {props.children}
    </div>
  );
}
