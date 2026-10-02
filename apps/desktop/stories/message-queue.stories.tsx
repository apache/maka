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

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { MessageQueueEntryProjection } from "@maka/core/events";
import type { SessionSummary } from "@maka/core/session";
import { Composer, type ChatModelChoice, type ComposerHandle, type TransientUserMessageProjection } from "@maka/ui";
import { SessionLocalMessages } from "../src/renderer/features/conversation/testing.js";
import { ConversationServicesProvider } from "../src/renderer/features/conversation";
import { stubConversationServices } from "../src/renderer/features/conversation/testing";

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

function PausedFollowUpQueue() {
  const composer = useRef<ComposerHandle>(null);
  const [messages, setMessages] = useState<TransientUserMessageProjection[]>([]);
  const services = useMemo(() => stubConversationServices({
    listMessages: async () => [{
      messageId: "paused-follow-up", sessionId: STORY_SESSION.id, createdAt: 1,
      text: "Review the retained attachment before sending this follow-up again.",
      state: "paused", canCancel: true, placement: "next_turn", attachments: [], inlineReferences: [],
    }],
  }), []);
  const publish = useCallback((_sessionId: string, message: TransientUserMessageProjection) => {
    setMessages((current) => [...current.filter((item) => item.id !== message.id), message]);
  }, []);
  const retire = useCallback((_sessionId: string, messageId: string) => {
    setMessages((current) => current.filter((item) => item.id !== messageId));
  }, []);
  const restore = useCallback<NonNullable<ComponentProps<typeof SessionLocalMessages>["restoreUnsentDraft"]>>((sessionId, draft) => {
    if (!composer.current) return false;
    composer.current.appendDraft(sessionId, draft.text, draft.inlineReferences, draft.replacesLocalMessageId);
    return true;
  }, []);
  return <ConversationServicesProvider services={services}>
    <SessionLocalMessages sessionId={STORY_SESSION.id} publish={publish} update={publish} retire={retire}
      canRestoreDraft={() => !composer.current?.getText()} restoreDraft={() => false} restoreUnsentDraft={restore} />
    {recoveryStoryFrame(<Composer ref={composer} draftKey={STORY_SESSION.id} streaming
      onSend={() => false} onStop={() => undefined} pendingMessages={messages} />)}
  </ConversationServicesProvider>;
}

// Real path: edit a never-dispatched follow-up, then clear the draft. The retained
// original remains paused in the production queue, with visible recovery guidance.
export const PausedFollowUp: Story = {
  render: () => <PausedFollowUpQueue />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector('.maka-composer-queue-feedback')).not.toBeNull());
    const row = canvasElement.querySelector<HTMLElement>('.maka-composer-queue-list [role="listitem"]')!;
    const feedback = row.querySelector<HTMLElement>('[role="status"]')!;
    const actions = row.querySelector<HTMLElement>('.maka-composer-queue-local-actions')!;
    await expect(feedback).toBeVisible();
    await expect(feedback.querySelector('.maka-composer-queue-delivery-detail')).toBeVisible();
    await expect(actions).toBeVisible();
    await expect(actions.getBoundingClientRect().top).toBeGreaterThanOrEqual(feedback.getBoundingClientRect().bottom - 1);
    await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    const button = actions.querySelector('button')!;
    button.focus();
    await expect(button).toHaveFocus();
  },
};

function recoveryStoryFrame(children: ReactNode) {
  return <div style={{ padding: "24px 24px 48px", maxWidth: 840 }}>{children}</div>;
}

function RecoveredFileDraft() {
  const composer = useRef<ComposerHandle>(null);
  const [draftKey, setDraftKey] = useState('other-session');
  const [sent, setSent] = useState('');
  useEffect(() => {
    composer.current!.setDraft('original-session', 'Review first');
    composer.current!.appendDraft('original-session', '  inspect @src/index.ts ', [
      { kind: 'workspace_file', value: '@src/index.ts', label: 'index.ts', start: 10 },
    ]);
  }, []);
  return recoveryStoryFrame(<>
    {/* Review controls stand in for sidebar navigation; the draft and token
        implementation below is the production Composer, without a second store. */}
    <button type="button" onClick={() => setDraftKey('original-session')}>Open original session</button>
    <button type="button" onClick={() => {
      composer.current!.setText(composer.current!.getText());
      composer.current!.appendDraft('original-session', 'more');
    }}>Replace with plain text</button>
    <Composer ref={composer} draftKey={draftKey} onStop={() => undefined}
      onSend={(text, metadata) => { setSent(JSON.stringify({ text, references: metadata?.workspaceFileReferences })); return false; }} />
    <output aria-label="Captured send">{sent}</output>
  </>);
}

// Real path: withdraw a queued message containing a workspace-file token after
// switching Sessions, return to its original draft, then send it again. The
// restored token stays a file reference rather than becoming lookalike text.
export const RecoveredFileReference: Story = {
  render: () => <RecoveredFileDraft />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Open original session' }));
    await waitFor(() => expect(canvasElement.querySelector('[data-astryx-token-value="@src/index.ts"]')).not.toBeNull());
    const input = canvasElement.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await userEvent.click(input);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      const sent = JSON.parse(canvas.getByLabelText('Captured send').textContent || '{}');
      expect(sent.text).toBe('Review first\n\ninspect @src/index.ts');
      expect(sent.references).toEqual([{ value: '@src/index.ts', start: 22 }]);
    });
    await userEvent.click(canvas.getByRole('button', { name: 'Replace with plain text' }));
    await waitFor(() => expect(canvasElement.querySelector('[data-astryx-token-value="@src/index.ts"]')).toBeNull());
    await userEvent.click(input);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      const sent = JSON.parse(canvas.getByLabelText('Captured send').textContent || '{}');
      expect(sent.text).toBe('Review first\n\ninspect @src/index.ts\n\nmore');
      expect(sent.references).toBeUndefined();
    });
  },
};
