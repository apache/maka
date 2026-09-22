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

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import type { MessageQueueEntryProjection } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import { Composer } from '@maka/ui';
import type { ChatModelChoice, ComposerHandle, TransientUserMessageProjection } from '@maka/ui';
import {
  ConversationServicesProvider,
  SessionLocalMessages,
  type ConversationServices,
} from '../src/renderer/features/conversation';
import type { DesktopLocalMessage } from '../src/shared/session-local-contract.js';

const NOW = Date.UTC(2026, 6, 1, 9, 30, 0);
const SESSION_ID = 's';

type DeliveryState = 'queued' | 'unconfirmed' | 'failed';

function localDeliveryMessages(state: DeliveryState): DesktopLocalMessage[] {
  const base = {
    sessionId: SESSION_ID,
    attachments: [],
    inlineReferences: [],
    placement: 'next_turn' as const,
  };
  if (state === 'unconfirmed') {
    return [
      {
        ...base,
        messageId: 'local-unconfirmed',
        createdAt: NOW - 60_000,
        state: 'unknown',
        canCancel: false,
        text: 'Check whether the queue drained before retrying the compaction audit.',
        error: 'Connection dropped before the receipt arrived',
      },
      {
        ...base,
        messageId: 'local-waiting',
        createdAt: NOW - 30_000,
        state: 'saved',
        canCancel: true,
        text: 'Summarize the retry budget for the pending follow-ups.',
      },
    ];
  }
  if (state === 'failed') {
    return [
      {
        ...base,
        messageId: 'local-failed',
        createdAt: NOW - 60_000,
        state: 'failed',
        canCancel: true,
        text: 'Attach the runtime.sqlite compaction log to the report.',
        error: 'Message preparation failed. The local copy is retained.',
      },
    ];
  }
  return [];
}

function localDeliveryServices(state: DeliveryState): ConversationServices {
  let messages = localDeliveryMessages(state);
  return {
    listMessages: async () => messages,
    cancelMessage: async (_sessionId, messageId) => {
      messages = messages.filter((message) => message.messageId !== messageId);
    },
    reconcileMessage: async () => undefined,
    subscribeChanges: () => () => undefined,
    sessions: {
      readSnapshot: async () => {
        throw new Error('Session snapshots are not used in this story');
      },
      promoteQueueEntry: async () => undefined,
      updateQueueEntry: async () => undefined,
      retractQueueEntry: async () => undefined,
      reorderQueueEntries: async () => undefined,
    },
    skills: { listInvocable: async () => [] },
    workspace: {
      searchFiles: async () => ({ ok: false as const, reason: 'no_project' as const }),
    },
    newTasks: {
      subscribeChanges: () => () => undefined,
      listInvocableSkills: async () => [],
      searchFiles: async () => ({ ok: false as const, reason: 'no_project' as const }),
    },
    mcp: { subscribeChanges: () => () => undefined },
  };
}

const meta = {
  title: 'Product/Composer Message Queue',
  component: QueuedComposer,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof QueuedComposer>;

export default meta;

type Story = StoryObj<typeof meta>;
type ComposerProps = ComponentProps<typeof Composer>;

function noop() {
  return undefined;
}

function session(): SessionSummary {
  return {
    id: 's',
    name: '排查 Context summary failed',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    lastMessageAt: NOW,
    lastMessagePreview: '查一下 PR #3526 相关的 session。',
    status: 'running',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-anthropic-main',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: false,
    model: 'claude-sonnet-4-5',
    permissionMode: 'ask',
  };
}

const modelChoices: ChatModelChoice[] = [
  {
    connectionId: 'connection-anthropic-main',
    connectionSlug: 'anthropic-main',
    providerType: 'anthropic',
    providerLabel: 'Anthropic',
    model: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    isDefault: true,
    thinkingLevels: [],
  },
];

function followUpEntry(entryId: string, text: string): MessageQueueEntryProjection {
  return {
    entryId,
    messageId: `message-${entryId}`,
    content: { text },
    placement: 'next_turn',
    state: 'queued',
  };
}

/**
 * Local stand-in for the Runtime Host queue projection: promote hands an
 * entry to the active Turn (it leaves the plate), update edits it in place,
 * retract drops it, and reorder applies the drag order. The component contract
 * (projection in, mutations
 * out) is the real one; only the authority is simulated.
 */
// A production queue snapshot also carries queued steering; the drawer filters
// it out — steering renders in the transcript instead (see the
// QueuedSteeringInTranscript story in app-shell).
const DEFAULT_QUEUE: MessageQueueEntryProjection[] = [
  {
    entryId: 'entry-steer',
    messageId: 'message-steer',
    content: { text: '先把刚才的判断改成只检查当前工作树。' },
    placement: 'current_turn',
    state: 'queued',
  },
  followUpEntry('entry-1', '先不要改协议。'),
  followUpEntry('entry-2', '查一下 PR #3526 相关的 session 及其 compaction 诊断记录。'),
  followUpEntry('entry-3', '把 runtime.sqlite 里的 compaction 日志也带上。'),
];

function QueuedComposer({
  deliveryState,
  stagedContext = true,
  entries = DEFAULT_QUEUE,
}: {
  deliveryState: DeliveryState;
  stagedContext?: boolean;
  entries?: MessageQueueEntryProjection[];
}) {
  const composerRef = useRef<ComposerHandle>(null);
  const [followup, setFollowup] = useState<MessageQueueEntryProjection[]>(entries);

  const base: ComposerProps = {
    draftKey: 'storybook-composer-queue',
    onSend: noop,
    onStop: noop,
    modelLabel: 'K3-256k',
    activeSession: session(),
    activeModel: 'claude-sonnet-4-5',
    activeModelLabel: 'K3-256k',
    modelChoices,
    permissionMode: 'ask',
    onPermissionModeChange: noop,
    onPickAttachments: noop,
    streaming: true,
    // Real mid-turn state can stage context while follow-ups wait: the two
    // sections stack inside the one staging drawer.
    pendingQuotes: stagedContext
      ? [{ text: 'queue.entries 表在 Host 端是唯一权威', label: '设计笔记' }]
      : undefined,
    pendingAttachments: stagedContext
      ? [{ kind: 'other', displayName: 'compaction-audit.md', mimeType: 'text/markdown', size: 12_400 }]
      : undefined,
  };

  const [published, setPublished] = useState(new Map<string, TransientUserMessageProjection>());
  const publish = useCallback((_sessionId: string, message: TransientUserMessageProjection) => {
    setPublished((current) => new Map(current).set(message.id, message));
  }, []);
  const retire = useCallback((_sessionId: string, messageId: string) => {
    setPublished((current) => {
      const next = new Map(current);
      next.delete(messageId);
      return next;
    });
  }, []);
  const services = useMemo(() => localDeliveryServices(deliveryState), [deliveryState]);

  return (
    <ConversationServicesProvider services={services}>
      <SessionLocalMessages
        sessionId={SESSION_ID}
        publish={publish}
        retire={retire}
        reportError={noop}
        restoreDraft={(_id, draft) => {
          composerRef.current?.setText(draft.text);
          composerRef.current?.focus();
        }}
      />
      <Composer
        {...base}
        ref={composerRef}
        queuedMessages={deliveryState === 'queued' ? followup : []}
        pendingMessages={[...published.values()]}
        queuedMessageRevision={1}
        onPromoteQueuedEntry={(entryId) => {
          setFollowup((current) => current.filter((candidate) => candidate.entryId !== entryId));
        }}
        onUpdateQueuedEntry={(entryId, _expectedQueueRevision, text) => {
          setFollowup((current) =>
            current.map((candidate) =>
              candidate.entryId === entryId
                ? { ...candidate, content: { ...candidate.content, text, displayText: text } }
                : candidate,
            ),
          );
        }}
        onDeleteQueuedEntry={(entryId) => {
          setFollowup((current) => current.filter((candidate) => candidate.entryId !== entryId));
        }}
        onReorderQueuedEntries={(entryIds) => {
          setFollowup((current) =>
            entryIds.flatMap((entryId) =>
              current.filter((candidate) => candidate.entryId === entryId),
            ),
          );
        }}
      />
    </ConversationServicesProvider>
  );
}

function storyFrame(children: ReactNode): ReactElement {
  return <div style={{ padding: '24px 24px 48px', maxWidth: 840 }}>{children}</div>;
}

// Real path: mid-turn sends while a quote and a file are staged — the staging
// drawer holds the queue section above a hairline and the context chips below.
// Drag follow-ups to reorder; 直接发送 promotes one, 编辑 updates it in place.
export const PendingPlate: Story = {
  args: { deliveryState: 'queued' },
  argTypes: {
    deliveryState: {
      options: ['queued', 'unconfirmed', 'failed'],
      control: { type: 'radio' },
    },
  },
  render: (args) =>
    storyFrame(
      <QueuedComposer key={args.deliveryState} deliveryState={args.deliveryState} />,
    ),
};

// Real path: follow-ups sent mid-turn with nothing staged — the drawer holds
// the queue section alone and collapses to a "N 条待发送消息" strip.
export const QueueOnly: Story = {
  args: { deliveryState: 'queued' },
  render: () => storyFrame(<QueuedComposer deliveryState="queued" stagedContext={false} />),
};

// Real path: the user folds the staging slab; every staged item collapses into
// the count strip until it is reopened.
export const StagingCollapsed: Story = {
  args: { deliveryState: 'queued' },
  render: () => storyFrame(<QueuedComposer deliveryState="queued" />),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /收起|collapse/i }));
    await waitFor(() => {
      expect(canvas.queryByText('先不要改协议。')).toBeNull();
      expect(canvas.getByRole('button', { name: /附加内容|staged/i })).toBeVisible();
    });
  },
};

// Real path: a long Turn while the user keeps queueing — the list scrolls
// inside the drawer instead of growing the composer.
export const OverflowingQueue: Story = {
  args: { deliveryState: 'queued' },
  render: () =>
    storyFrame(
      <QueuedComposer
        deliveryState="queued"
        stagedContext={false}
        entries={Array.from({ length: 9 }, (_, index) =>
          followUpEntry(`entry-${index + 1}`, `排队跟进 ${index + 1}：检查 compaction 诊断记录的第 ${index + 1} 段。`),
        )}
      />,
    ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvasElement.querySelector<HTMLElement>('.maka-composer-queue-list');
    await waitFor(() => {
      expect(list).not.toBeNull();
      expect(list!.scrollHeight).toBeGreaterThan(list!.clientHeight);
    });
    await expect(canvas.getAllByText(/^排队跟进/).length).toBe(9);
  },
};

// Real path: the pencil on a queued row opens an inline editor inside the
// drawer; Enter commits, Escape cancels.
export const EditingQueuedEntry: Story = {
  args: { deliveryState: 'queued' },
  render: () => storyFrame(<QueuedComposer deliveryState="queued" stagedContext={false} />),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByRole('button', { name: '编辑' })[1]!);
    const editor = await canvas.findByRole('textbox', { name: '编辑' });
    await expect(editor).toHaveValue('查一下 PR #3526 相关的 session 及其 compaction 诊断记录。');
    await userEvent.clear(editor);
    await userEvent.type(editor, '改查 PR #3526 的 session 列表。');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(canvas.getByText('改查 PR #3526 的 session 列表。')).toBeVisible();
      expect(canvas.queryByRole('textbox', { name: '编辑' })).toBeNull();
    });
  },
};

// Real path: a 720px Desktop window — the smoke runner gives ids containing
// "narrow" the narrow viewport; rows stay one line and actions keep the
// trailing edge.
export const NarrowPendingPlate: Story = {
  args: { deliveryState: 'queued' },
  render: () => storyFrame(<QueuedComposer deliveryState="queued" />),
};
