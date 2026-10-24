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

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ChatView } from '@maka/ui';
import { createPersonalAssistantServices, PersonalAssistantServicesProvider, PersonalAssistantTaskLayout } from '../src/renderer/features/personal-assistant/index.js';

const meta = {
  title: 'Product/Personal Assistant Tasks',
  parameters: { layout: 'fullscreen' },
  globals: { locale: 'en' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const session = { id: '["story-host","assistant"]', labels: ['personal-assistant'] };
const activeSession = { ...session, name: 'Personal Assistant', isFlagged: false, isArchived: false, hasUnread: false, status: 'active' as const, backend: 'ai-sdk' as const, llmConnectionSlug: 'fixture', connectionLocked: false, model: 'fixture', permissionMode: 'ask' as const };
const services = createPersonalAssistantServices({
  defaultHost: async () => ({ hostId: 'story-host', profileId: 'story-profile' }),
  hostSnapshot: async () => ({ entries: [{ hostId: 'story-host', profile: { id: 'story-profile' }, enabled: true }] }),
  createSession: async () => ({ id: 'assistant' }),
  listSessions: async () => [{ id: 'assistant' }],
  call: async () => ({
    state: { sessionId: 'assistant' },
    tasks: { installed: true, items: [
      { id: 'research', title: 'Compare the accessibility findings across the desktop release candidates', status: 'active', runtimeStatus: 'running', state: 'Reviewing the keyboard navigation notes and preparing a summary', updatedAt: 1750000000000 },
      { id: 'reply', title: 'Follow up on the venue booking', status: 'waiting', waitingFor: 'Waiting for the venue to confirm availability', updatedAt: 1749999900000 },
      { id: 'review', title: 'Confirm the proposed travel dates', status: 'active', runtimeStatus: 'waiting_for_user', state: 'Please choose between the two suggested dates', updatedAt: 1749999800000 },
      { id: 'queued', title: 'Prepare the weekly reading list', status: 'active', updatedAt: 1749999700000 },
      { id: 'done', title: 'Summarize last week’s notes', status: 'completed', updatedAt: 1749999600000 },
    ] },
  }),
});

function TasksSurface() {
  // The production task/chat frame owns layout. Only the outer host size is
  // Storybook scaffolding; no Electron/app-shell orchestration is needed here.
  return <PersonalAssistantServicesProvider value={services}>
    <div style={{ display: 'flex', height: '100vh', minHeight: 420, background: 'var(--background)', color: 'var(--foreground)' }}>
      <PersonalAssistantTaskLayout session={session} composer={null}>
        <ChatView activeSession={activeSession} scrollBehavior="smooth" messages={[
          { type: 'user', id: 'question', turnId: 'turn', ts: 1, text: 'What should I focus on this afternoon?' },
          { type: 'assistant', id: 'answer', turnId: 'turn', ts: 2, modelId: 'fixture', text: 'I’m reviewing the accessibility findings. The venue is still confirming availability, and the travel dates need your input. You can continue the conversation while I keep those tasks up to date.' },
          { type: 'turn_state', id: 'complete', turnId: 'turn', ts: 3, status: 'completed' },
        ]} onNew={() => undefined} />
      </PersonalAssistantTaskLayout>
    </div>
  </PersonalAssistantServicesProvider>;
}

async function taskPanel(canvasElement: HTMLElement) {
  await waitFor(() => expect(canvasElement.querySelector('.assistant-task-float')).not.toBeNull());
  return canvasElement.querySelector<HTMLElement>('.assistant-task-float')!;
}

// Real path: open the Personal Assistant conversation with ongoing tasks;
// PersonalAssistantTaskLayout mounts the live task panel beside the transcript.
export const Expanded: Story = {
  render: () => <TasksSurface />,
  play: async ({ canvasElement }) => {
    const panel = await taskPanel(canvasElement);
    const canvas = within(panel);
    await userEvent.click(canvas.getByRole('button', { name: /Compare the accessibility findings/ }));
    await expect(canvas.getByText('Reviewing the keyboard navigation notes and preparing a summary')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Back to tasks' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Next page' }));
    await expect(canvas.getByText('Prepare the weekly reading list')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Previous page' }));
    const header = panel.querySelector('header');
    const headerWidth = header!.getBoundingClientRect().width;
    await userEvent.click(canvas.getByRole('button', { name: 'Collapse tasks' }));
    await expect(panel.querySelector('header')).toBe(header);
    await expect(header!.getBoundingClientRect().width).toBe(headerWidth);
    await expect(panel.querySelector('.assistant-task-counts')).toHaveTextContent('1 Running');
    await userEvent.click(canvas.getByRole('button', { name: 'Expand tasks' }));
    const frame = panel.closest<HTMLElement>('.personal-assistant-chat-frame')!;
    const conversation = frame.querySelector<HTMLElement>('.personal-assistant-chat')!;
    const bounds = panel.getBoundingClientRect();
    const container = frame.getBoundingClientRect();
    await expect(bounds.left).toBeGreaterThanOrEqual(container.left);
    await expect(bounds.right).toBeLessThanOrEqual(container.right);
    if (container.width <= 620) await expect(bounds.bottom).toBeLessThanOrEqual(conversation.getBoundingClientRect().top + 1);
  },
};

// Real path: collapse that same ongoing-task panel with its header control.
export const Collapsed: Story = {
  render: () => <TasksSurface />,
  play: async ({ canvasElement }) => {
    const panel = await taskPanel(canvasElement);
    await userEvent.click(within(panel).getByRole('button', { name: 'Collapse tasks' }));
    await expect(within(panel).getByRole('button', { name: /Expand tasks/ })).toBeVisible();
  },
};
