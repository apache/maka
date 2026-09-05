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
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import { createScheduledTaskFormSeed } from '../src/scheduled-task-helpers.js';
import { ScheduledTaskFormDialog } from '../src/scheduled-task-form-dialog.js';
import { Markdown } from '../src/markdown.js';
import { SessionRenameDialog } from '../src/session-rename-dialog.js';

const meta = {
  title: 'Product/Accessibility Dialogs',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;
const renameConversation = fn();
const closeRenameDialog = fn();
const closeScheduledTaskDialog = fn();

function RenameConversationStory() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>重命名任务</button>
      {open ? (
        <SessionRenameDialog
          target={{ kind: 'session', id: 'session-story', name: '发布前检查' }}
          onOpenChange={(nextOpen) => {
            closeRenameDialog(nextOpen);
            setOpen(nextOpen);
          }}
          onRename={renameConversation}
        />
      ) : null}
    </>
  );
}

// Real path: conversation sidebar → row actions → rename.
export const RenameConversation: Story = {
  render: () => <RenameConversationStory />,
  play: async ({ canvasElement }) => {
    renameConversation.mockClear();
    closeRenameDialog.mockClear();
    const body = within(canvasElement.ownerDocument.body);
    const trigger = body.getByRole('button', { name: '重命名任务' });
    await userEvent.click(trigger);
    const field = await body.findByRole('textbox', { name: '重命名任务' });
    await expect(field).toHaveFocus();
    await userEvent.clear(field);
    await userEvent.type(field, '发布前 AX 检查');
    await userEvent.click(body.getByRole('button', { name: '保存' }));
    await expect(closeRenameDialog).toHaveBeenCalledWith(false);
    await expect(renameConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-story' }),
      '发布前 AX 检查',
    );
    await waitFor(() =>
      expect(body.queryByRole('dialog', { name: '重命名任务' })).not.toBeInTheDocument());
    await userEvent.click(trigger);
    await expect(body.findByRole('dialog', { name: '重命名任务' })).resolves.toBeTruthy();
  },
};

function CreateScheduledTaskStory() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>新建定时任务</button>
      <ScheduledTaskFormDialog
        open={open}
        seed={createScheduledTaskFormSeed()}
        tasks={[]}
        onOpenChange={(nextOpen) => {
          closeScheduledTaskDialog(nextOpen);
          setOpen(nextOpen);
        }}
        onCreate={() => undefined}
      />
    </>
  );
}

// Real path: sidebar → 定时任务 → 新建定时任务.
export const CreateScheduledTask: Story = {
  render: () => <CreateScheduledTaskStory />,
  play: async ({ canvasElement }) => {
    closeScheduledTaskDialog.mockClear();
    const body = within(canvasElement.ownerDocument.body);
    const trigger = body.getByRole('button', { name: '新建定时任务' });
    await userEvent.click(trigger);
    const dialog = await body.findByRole('dialog', { name: '新建定时任务' });
    await expect(within(dialog).getByRole('textbox', { name: /标题/ })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    await expect(closeScheduledTaskDialog).toHaveBeenCalledWith(false);
    await waitFor(() =>
      expect(body.queryByRole('dialog', { name: '新建定时任务' })).not.toBeInTheDocument());
    await expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await expect(body.findByRole('dialog', { name: '新建定时任务' })).resolves.toBeTruthy();
  },
};

// Real path: conversation or Daily Review Markdown → Mermaid diagram → 全屏查看图表.
export const MermaidFullscreen: Story = {
  render: () => (
    <div style={{ margin: '0 auto', maxWidth: 720, padding: 24 }}>
      <Markdown
        text={[
          '```mermaid',
          'flowchart LR',
          '  Observe --> Resolve',
          '  Resolve --> Act',
          '  Act --> Verify',
          '```',
        ].join('\n')}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const expand = await waitFor(
      () => canvas.getByRole('button', { name: '全屏查看图表' }),
      { timeout: 10_000 },
    );
    await userEvent.click(expand);
    await expect(
      within(canvasElement.ownerDocument.body).findByRole('dialog', {
        name: 'Mermaid 图表',
      }),
    ).resolves.toBeTruthy();
  },
};
