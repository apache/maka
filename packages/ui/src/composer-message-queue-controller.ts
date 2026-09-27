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

import { useRef, useState } from "react";
import type { MessageQueueEntryProjection } from "@maka/core/events";
import { moveQueueEntryId } from "@maka/core/message-queue-order";
import type { TransientUserMessageProjection } from "./chat-view.js";
import { useMountedRef } from "./use-mounted-ref.js";

export type ComposerQueueEntry = Omit<MessageQueueEntryProjection, "state"> & {
  state: MessageQueueEntryProjection["state"] | "local";
  localMessage?: TransientUserMessageProjection;
};

export interface ComposerQueueActions {
  queueRevision?: number;
  onEditEntry?(entry: ComposerQueueEntry): void | Promise<void>;
  onUpdateEntry?(entryId: string, expectedQueueRevision: number, text: string): void | Promise<void>;
  onReorderEntries?(entryIds: readonly string[], expectedQueueRevision: number): void | Promise<void>;
}

export function useComposerMessageQueueController(
  entries: readonly ComposerQueueEntry[],
  actions: ComposerQueueActions,
) {
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    entryId: string;
    queueRevision: number;
    text: string;
  } | null>(null);
  const pending = useRef<string | null>(null);
  const drag = useRef<{ entryId: string; queueRevision: number } | null>(null);
  const mountedRef = useMountedRef();

  const groups = (["current_turn", "next_turn"] as const)
    .map((placement) => ({
      placement,
      entries: entries.filter((entry) => entry.placement === placement),
    }))
    .filter((group) => group.entries.length > 0);

  async function runAction(
    entryId: string,
    action: (() => void | Promise<void>) | undefined,
  ): Promise<boolean> {
    if (!action || pending.current) return false;
    pending.current = entryId;
    setPendingEntryId(entryId);
    try {
      await action();
      return true;
    } catch {
      return false;
    } finally {
      if (pending.current === entryId) pending.current = null;
      if (mountedRef.current) setPendingEntryId(null);
    }
  }

  function beginEdit(entry: ComposerQueueEntry): void {
    if (pendingEntryId) return;
    if (!actions.onUpdateEntry || actions.queueRevision === undefined) {
      if (actions.onEditEntry) void runAction(entry.entryId, () => actions.onEditEntry?.(entry));
      return;
    }
    setEditing({
      entryId: entry.entryId,
      queueRevision: actions.queueRevision,
      text: entry.content.displayText ?? entry.content.text,
    });
  }

  function cancelEdit(): void {
    setEditing(null);
  }

  async function commitEdit(): Promise<void> {
    if (!editing) return;
    const text = editing.text.trim();
    if (!text) return;
    const updated = await runAction(editing.entryId, () =>
      actions.onUpdateEntry?.(editing.entryId, editing.queueRevision, text),
    );
    if (updated && mountedRef.current) setEditing(null);
  }

  function canReorder(entry: ComposerQueueEntry): boolean {
    return (
      entry.state === "queued" &&
      editing?.entryId !== entry.entryId &&
      Boolean(actions.onReorderEntries) &&
      actions.queueRevision !== undefined &&
      pendingEntryId === null
    );
  }

  function beginDrag(entryId: string): number | undefined {
    if (actions.queueRevision === undefined) return undefined;
    drag.current = { entryId, queueRevision: actions.queueRevision };
    return actions.queueRevision;
  }

  function endDrag(): void {
    drag.current = null;
  }

  function hasDrag(): boolean {
    return drag.current !== null;
  }

  function dropOn(targetEntryId: string): void {
    const source = drag.current;
    drag.current = null;
    if (
      !source ||
      source.entryId === targetEntryId ||
      !actions.onReorderEntries
    ) {
      return;
    }
    const target = entries.find((entry) => entry.entryId === targetEntryId);
    const sourceEntry = entries.find((entry) => entry.entryId === source.entryId);
    if (!target || sourceEntry?.placement !== target.placement) return;
    const entryIds = entries
      .filter((entry) => entry.placement === target.placement && entry.state === "queued")
      .map((entry) => entry.entryId);
    const reordered = moveQueueEntryId(entryIds, source.entryId, targetEntryId);
    if (!reordered) return;
    void runAction(source.entryId, () =>
      actions.onReorderEntries?.(reordered, source.queueRevision),
    );
  }

  return {
    beginDrag,
    beginEdit,
    cancelEdit,
    canReorder,
    commitEdit,
    dropOn,
    editing,
    endDrag,
    groups,
    hasDrag,
    pendingEntryId,
    runAction,
    setEditingText(text: string) {
      setEditing((current) => current ? { ...current, text } : null);
    },
  };
}
