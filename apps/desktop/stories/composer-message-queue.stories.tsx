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

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import type { MessageQueueEntryProjection } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import { Composer } from '@maka/ui';
import type { ChatModelChoice } from '@maka/ui';

const NOW = Date.UTC(2026, 6, 1, 9, 30, 0);

const meta = {
  title: 'Product/Composer Message Queue',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

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
function QueuedComposer() {
  const [followup, setFollowup] = useState<MessageQueueEntryProjection[]>([
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
  ]);

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
  };

  return (
    <Composer
      {...base}
      queuedMessages={followup}
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
  );
}

// Real path: mid-turn sends stay visible above the composer until consumed.
// Drag follow-ups to reorder; 调整方向 promotes one, 编辑 updates it in place.
export const PendingPlate: Story = {
  render: () => (
    <div style={{ padding: '24px 24px 48px', maxWidth: 840 }}>
      <QueuedComposer />
    </div>
  ),
};
