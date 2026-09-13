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

import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ToastProvider, useToast, type ToastVariant } from '../src/toast.js';
import { Button } from '../src/index.js';

const meta = {
  title: 'Primitives/Toast',
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const VARIANTS: ToastVariant[] = ['info', 'success', 'warning', 'error'];

export const Seeded: Story = {
  render: () => {
    const toast = useToast();
    useEffect(() => {
      for (const variant of VARIANTS) {
        toast.toast({ title: `${variant} 标题`, description: `${variant} 说明文字`, variant, duration: 0 });
      }
    }, [toast]);
    return <div style={{ minHeight: 360 }} />;
  },
};

function ConfirmQueueExample() {
  const toast = useToast();
  const [results, setResults] = useState<boolean[]>([]);
  return (
    <div style={{ display: 'grid', gap: 12, padding: 24, width: 360 }}>
      <span>结果：{results.map(String).join(',')}</span>
      <Button
        variant="secondary"
        label="连续确认"
        onClick={() => {
          const first = toast.confirm({
            title: '确认 A？',
            confirmLabel: '确认 A',
          });
          const second = toast.confirm({
            title: '确认 B？',
            confirmLabel: '确认 B',
          });
          void Promise.all([first, second]).then(setResults);
        }}
      />
    </div>
  );
}

export const ConfirmQueued: Story = {
  render: () => <ConfirmQueueExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    const opener = canvas.getByRole('button', { name: '连续确认' });
    await userEvent.click(opener);

    const first = await page.findByRole('alertdialog', { name: '确认 A？' });
    await expect(page.queryAllByRole('alertdialog')).toHaveLength(1);
    await expect(page.queryByRole('alertdialog', { name: '确认 B？' })).not.toBeInTheDocument();
    const firstCancel = within(first).getByRole('button', { name: '取消' });
    await expect(firstCancel).toHaveFocus();
    await userEvent.click(firstCancel);

    await waitFor(() => {
      expect(page.queryByRole('alertdialog', { name: '确认 A？' })).not.toBeInTheDocument();
    });
    const second = await page.findByRole('alertdialog', { name: '确认 B？' });
    await expect(page.queryAllByRole('alertdialog')).toHaveLength(1);
    const secondCancel = within(second).getByRole('button', { name: '取消' });
    await expect(secondCancel).toHaveFocus();
    await userEvent.click(
      within(second).getByRole('button', { name: '确认 B' }),
    );

    await waitFor(() => expect(canvas.getByText('结果：false,true')).toBeInTheDocument());
    await expect(page.queryAllByRole('alertdialog')).toHaveLength(0);
    await expect(opener).toHaveFocus();
  },
};

// The diagnostics affordance the provider wires onto every error toast — and
// the branch where opening it also fails, so the provider raises its own
// failure toast instead of swallowing the rejection.
const DIAGNOSTICS_ERROR_ACTION = {
  label: '查看详情',
  failureTitle: '无法打开诊断',
  failureDescription: '日志服务未响应，请稍后重试。',
  onClick: async () => {
    throw new Error('diagnostics unavailable');
  },
};

// Real trigger: any failed operation surfaced through `toast.error` (a failed
// save, an offline sync, an unauthorised request — this surface has one error
// affordance, so they all share its shape). A bare `error` variant never
// exercises the action button or its own failure path.
export const ErrorWithDiagnostics: Story = {
  decorators: [
    (Story) => (
      <ToastProvider errorAction={DIAGNOSTICS_ERROR_ACTION}>
        <Story />
      </ToastProvider>
    ),
  ],
  render: () => {
    const toast = useToast();
    useEffect(() => {
      toast.toast({
        title: '保存失败',
        description: '网络中断，更改未同步。',
        variant: 'error',
        duration: 0,
      });
    }, [toast]);
    return <div style={{ minHeight: 360 }} />;
  },
  play: async () => {
    const page = within(document.body);
    // The error toast carries the provider's diagnostics action…
    const diagnostics = await page.findByRole('button', { name: '查看详情' });
    await userEvent.click(diagnostics);
    // …and when that action itself fails, the provider surfaces its own
    // failure toast rather than dropping the rejection on the floor.
    await page.findByText('无法打开诊断');
  },
};

function DestructiveConfirmExample() {
  const toast = useToast();
  return (
    <div style={{ display: 'grid', gap: 12, padding: 24, width: 360 }}>
      <Button
        variant="secondary"
        label="删除项目"
        onClick={() => {
          void toast.confirm({
            title: '删除项目？',
            description: '此操作会移除该项目的全部本地记录，且不可撤销。',
            confirmLabel: '删除',
            cancelLabel: '取消',
            destructive: true,
          });
        }}
      />
    </div>
  );
}

// Real trigger: an irreversible action (delete a project / task). The confirm
// button wears the destructive variant and initial focus rests on cancel, so
// the dangerous path is never the default.
export const DestructiveConfirm: Story = {
  render: () => <DestructiveConfirmExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    await userEvent.click(canvas.getByRole('button', { name: '删除项目' }));
    const dialog = await page.findByRole('alertdialog', { name: '删除项目？' });
    await expect(within(dialog).getByRole('button', { name: '删除' })).toBeInTheDocument();
    // The least-destructive choice holds initial focus.
    await expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus();
  },
};

const LONG_TOAST_TITLE =
  '同步到远程工作区时发生了一个需要你注意的、标题本身就相当冗长的问题';
const LONG_TOAST_DESCRIPTION =
  '远程主机在多次重试后仍未确认写入：连接在握手阶段被重置，随后的退避重试也接连超时。' +
  '本地更改已安全保留，你可以稍后重新同步；这段说明刻意写得很长，用来检验 toast 卡片在多行文本下是否仍然清晰，而不会把操作区挤出可视范围。';

// Very long title and body: the card must wrap legibly rather than clip text
// or shove the layout off-screen.
export const LongContent: Story = {
  render: () => {
    const toast = useToast();
    useEffect(() => {
      toast.toast({
        title: LONG_TOAST_TITLE,
        description: LONG_TOAST_DESCRIPTION,
        variant: 'warning',
        duration: 0,
      });
    }, [toast]);
    return <div style={{ minHeight: 360 }} />;
  },
};

// Many notifications at once — a burst of background results stacking up.
// Exercises the stack's density and whatever cap or scroll the layer applies,
// which a single seeded toast never shows.
export const ManyStacked: Story = {
  render: () => {
    const toast = useToast();
    useEffect(() => {
      for (let i = 1; i <= 8; i += 1) {
        toast.toast({
          title: `后台任务 ${i} 已完成`,
          description: `第 ${i} 条通知的说明文字。`,
          variant: VARIANTS[i % VARIANTS.length]!,
          duration: 0,
        });
      }
    }, [toast]);
    return <div style={{ minHeight: 360 }} />;
  },
};
