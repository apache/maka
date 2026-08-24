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
