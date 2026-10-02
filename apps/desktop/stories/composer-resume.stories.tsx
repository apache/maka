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

/**
 * The composer's Resume offer (#5903).
 *
 * When the Runtime Host's resume planner confirms the session's latest
 * interrupted Turn can resume, the composer sends nothing new: with an empty
 * draft the send slot shows Resume instead of Send, and typing anything
 * brings Send back. Production wires `resumeAction` from
 * `useShellResume.resumeAvailableBySession` — the authoritative plan read —
 * and the click reuses the same `sessions:resumeLatest` admission as the
 * transcript banner, so the stories below drive the exact prop surface the
 * shell renders.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { SessionSummary } from '@maka/core/session';
import { Composer } from '@maka/ui';

const COMPOSER_INPUT = '.maka-composer-editor [contenteditable="true"]';

const activeSession: SessionSummary = {
  id: 'session-interrupted',
  name: '生成周报图表',
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  status: 'aborted',
  lastMessageAt: Date.now() - 5 * 60_000,
  backend: 'ai-sdk',
  llmConnectionId: 'connection-anthropic-main',
  llmConnectionSlug: 'anthropic-main',
  connectionLocked: false,
  model: 'claude-sonnet-4-5',
  permissionMode: 'ask',
};

const meta = {
  title: 'Composer/Resume Offer',
  parameters: { layout: 'fullscreen' },
  render: (args) => (
    // Same harness shape as the other bare-Composer stories. Those stories —
    // this one included — render the card at its floor width because the
    // storybook preview never loads the app root's `--maka-reading-measure`
    // token (maka-tokens.css). That preview gap is main's to close, not this
    // story's to paper over; the play functions assert on roles, not layout.
    <div style={{ display: 'flex', alignItems: 'flex-end', height: 320, padding: 24 }}>
      <Composer
        {...args}
        activeSession={activeSession}
        activeModelLabel="Claude Sonnet 4.5"
        onSend={fn()}
        onStop={fn()}
      />
    </div>
  ),
} satisfies Meta<typeof Composer>;
export default meta;

type Story = StoryObj<typeof Composer>;

/** Empty draft, Host says the interrupted Turn can resume: Resume owns the slot. */
export const ResumeOffered: Story = {
  args: {
    resumeAction: { pending: false, onResume: fn() },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: '继续' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: '发送' })).toBeNull();
  },
};

/** The click is in flight through the safe-boundary admission. */
export const ResumePending: Story = {
  args: {
    resumeAction: { pending: true, onResume: fn() },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Astryx IconButton renders isDisabled as aria-disabled (the control stays
    // focusable), the same assertion the send-toggle suite uses.
    await expect(canvas.getByRole('button', { name: '正在继续…' })).toHaveAttribute('aria-disabled', 'true');
  },
};

/** Typing anything switches the same slot back to sending a new message. */
export const TypingRestoresSend: Story = {
  args: {
    resumeAction: { pending: false, onResume: fn() },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const editor = canvasElement.querySelector<HTMLElement>(COMPOSER_INPUT);
    await expect(editor).not.toBeNull();
    await userEvent.click(editor!);
    await userEvent.keyboard('补上超时后的最后一步');
    await expect(canvas.getByRole('button', { name: '发送' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: '继续' })).toBeNull();
  },
};
