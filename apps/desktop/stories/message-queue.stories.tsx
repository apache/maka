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

interface QueueStoryState {
  readonly entries: readonly MessageQueueEntryProjection[];
  readonly revision: number;
}

type QueueStoryAction =
  | { readonly kind: "delete"; readonly entryId: string }
  | { readonly kind: "edit"; readonly entryId: string; readonly text: string }
  | { readonly kind: "promote"; readonly entryId: string }
  | { readonly kind: "reorder"; readonly entryIds: readonly string[] };

const STORY_SESSION: SessionSummary = {
  id: "queue-story-session",
  name: "Investigate context compaction",
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  lastMessageAt: Date.UTC(2026, 8, 27, 9, 30),
  lastMessagePreview: "Inspect the session diagnostics for PR #3526.",
  status: "running",
  backend: "ai-sdk",
  llmConnectionId: "connection-anthropic-main",
  llmConnectionSlug: "anthropic-main",
  connectionLocked: false,
  model: "claude-sonnet-4-5",
  permissionMode: "ask",
};

const STORY_MODELS: readonly ChatModelChoice[] = [{
  connectionId: "connection-anthropic-main",
  connectionSlug: "anthropic-main",
  providerType: "anthropic",
  providerLabel: "Anthropic",
  model: "claude-sonnet-4-5",
  label: "Claude Sonnet 4.5",
  isDefault: true,
  thinkingLevels: [],
}];

const INITIAL_STATE: QueueStoryState = {
  revision: 4,
  entries: [
    queued("steer", "Limit the investigation to the current worktree.", "current_turn"),
    queued("logs", "Inspect the compaction diagnostics for PR #3526."),
    queued("database", "Include the runtime.sqlite compaction records."),
    queued("summary", "Summarize the evidence before changing the protocol."),
  ],
};

function queued(
  suffix: string,
  text: string,
  placement: MessageQueueEntryProjection["placement"] = "next_turn",
): MessageQueueEntryProjection {
  return {
    entryId: `entry-${suffix}`,
    messageId: `message-${suffix}`,
    content: { text },
    placement,
    state: "queued",
  };
}

function updateStoryQueue(state: QueueStoryState, action: QueueStoryAction): QueueStoryState {
  let entries: readonly MessageQueueEntryProjection[];
  switch (action.kind) {
    case "delete":
      entries = state.entries.filter((entry) => entry.entryId !== action.entryId);
      break;
    case "edit":
      entries = state.entries.map((entry) => entry.entryId === action.entryId
        ? { ...entry, content: { ...entry.content, text: action.text, displayText: action.text } }
        : entry);
      break;
    case "promote":
      entries = state.entries.map((entry) => entry.entryId === action.entryId
        ? { ...entry, placement: "current_turn" as const }
        : entry);
      break;
    case "reorder": {
      const positions = new Map(action.entryIds.map((entryId, index) => [entryId, index]));
      const reordered = state.entries
        .filter((entry) => positions.has(entry.entryId))
        .sort((left, right) => positions.get(left.entryId)! - positions.get(right.entryId)!);
      let cursor = 0;
      entries = state.entries.map((entry) => positions.has(entry.entryId) ? reordered[cursor++]! : entry);
      break;
    }
  }
  return { entries, revision: state.revision + 1 };
}

function InteractiveMessageQueue() {
  const [state, dispatch] = useReducer(updateStoryQueue, INITIAL_STATE);
  return (
    <main style={{ maxWidth: 840, padding: "24px 24px 48px" }}>
      <Composer
        draftKey="storybook-message-queue"
        onSend={() => undefined}
        onStop={() => undefined}
        modelLabel="K3-256k"
        activeSession={STORY_SESSION}
        activeModel="claude-sonnet-4-5"
        activeModelLabel="K3-256k"
        modelChoices={[...STORY_MODELS]}
        permissionMode="ask"
        onPermissionModeChange={() => undefined}
        onPickAttachments={() => undefined}
        streaming
        queuedMessages={state.entries}
        queuedMessageRevision={state.revision}
        onPromoteQueuedEntry={(entryId) => dispatch({ kind: "promote", entryId })}
        onUpdateQueuedEntry={(entryId, _revision, text) => dispatch({ kind: "edit", entryId, text })}
        onDeleteQueuedEntry={(entryId) => dispatch({ kind: "delete", entryId })}
        onReorderQueuedEntries={(entryIds) => dispatch({ kind: "reorder", entryIds })}
      />
    </main>
  );
}

const meta = {
  title: "Product/Message Queue",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const InteractiveQueue: Story = { render: () => <InteractiveMessageQueue /> };
