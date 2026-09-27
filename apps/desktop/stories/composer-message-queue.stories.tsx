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

import { useReducer } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { MessageQueueEntryProjection } from "@maka/core/events";
import type { SessionSummary } from "@maka/core/session";
import { Composer, type ChatModelChoice } from "@maka/ui";

const SESSION: SessionSummary = {
  id: "s",
  name: "排查 Context summary failed",
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  lastMessageAt: Date.UTC(2026, 6, 1, 9, 30, 0),
  lastMessagePreview: "查一下 PR #3526 相关的 session。",
  status: "running",
  backend: "ai-sdk",
  llmConnectionId: "connection-anthropic-main",
  llmConnectionSlug: "anthropic-main",
  connectionLocked: false,
  model: "claude-sonnet-4-5",
  permissionMode: "ask",
};
const MODELS: ChatModelChoice[] = [{
  connectionId: "connection-anthropic-main",
  connectionSlug: "anthropic-main",
  providerType: "anthropic",
  providerLabel: "Anthropic",
  model: "claude-sonnet-4-5",
  label: "Claude Sonnet 4.5",
  isDefault: true,
  thinkingLevels: [],
}];
const INITIAL_QUEUE: MessageQueueEntryProjection[] = [
  queueEntry("entry-steer", "先把刚才的判断改成只检查当前工作树。", "current_turn"),
  queueEntry("entry-1", "先不要改协议。"),
  queueEntry("entry-2", "查一下 PR #3526 相关的 session 及其 compaction 诊断记录。"),
  queueEntry("entry-3", "把 runtime.sqlite 里的 compaction 日志也带上。"),
];

type QueueAction =
  | { type: "remove"; entryId: string }
  | { type: "rename"; entryId: string; text: string }
  | { type: "reorder"; entryIds: readonly string[] };

function queueEntry(
  entryId: string,
  text: string,
  placement: MessageQueueEntryProjection["placement"] = "next_turn",
): MessageQueueEntryProjection {
  return {
    entryId,
    messageId: `message-${entryId}`,
    content: { text },
    placement,
    state: "queued",
  };
}

function reduceQueue(
  queue: readonly MessageQueueEntryProjection[],
  action: QueueAction,
): MessageQueueEntryProjection[] {
  if (action.type === "remove") {
    return queue.filter((entry) => entry.entryId !== action.entryId);
  }
  if (action.type === "rename") {
    return queue.map((entry) => entry.entryId === action.entryId
      ? { ...entry, content: { ...entry.content, text: action.text, displayText: action.text } }
      : entry);
  }
  const rank = new Map(action.entryIds.map((entryId, index) => [entryId, index]));
  return [...queue].sort((left, right) =>
    (rank.get(left.entryId) ?? -1) - (rank.get(right.entryId) ?? -1),
  );
}

function PendingQueueExample() {
  const [queue, dispatch] = useReducer(reduceQueue, INITIAL_QUEUE);
  return (
    <div style={{ padding: "24px 24px 48px", maxWidth: 840 }}>
      <Composer
        draftKey="storybook-composer-queue"
        onSend={() => undefined}
        onStop={() => undefined}
        modelLabel="K3-256k"
        activeSession={SESSION}
        activeModel="claude-sonnet-4-5"
        activeModelLabel="K3-256k"
        modelChoices={MODELS}
        permissionMode="ask"
        onPermissionModeChange={() => undefined}
        onPickAttachments={() => undefined}
        streaming
        queuedMessages={queue}
        queuedMessageRevision={1}
        onPromoteQueuedEntry={(entryId) => dispatch({ type: "remove", entryId })}
        onUpdateQueuedEntry={(entryId, _revision, text) =>
          dispatch({ type: "rename", entryId, text })}
        onDeleteQueuedEntry={(entryId) => dispatch({ type: "remove", entryId })}
        onReorderQueuedEntries={(entryIds) => dispatch({ type: "reorder", entryIds })}
      />
    </div>
  );
}

const meta = {
  title: "Product/Composer Message Queue",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const PendingPlate: Story = { render: () => <PendingQueueExample /> };
