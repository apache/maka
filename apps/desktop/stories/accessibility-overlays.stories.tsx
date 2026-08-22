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
import type { BotOnboardingSnapshot } from '@maka/core/bot-onboarding';
import { BotOnboardingModal } from '../src/renderer/settings/bot-onboarding-modal';
import { WechatQrLoginModal } from '../src/renderer/settings/bot-wechat-login';
import { SideChatCloseConfirmation } from '../src/renderer/side-chat-close-confirmation';
import { withScopedMakaBridge } from './maka-bridge';

const meta = {
  title: 'Product/Accessibility Overlays',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const QR_DATA_URL = 'data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22160%22 height=%22160%22 viewBox=%220 0 10 10%22%3E%3Cpath d=%22M0 0h4v4H0zm6 0h4v4H6zM0 6h4v4H0zm6 6h2v-2H6zm2-4h2v2H8z%22/%3E%3C/svg%3E';
const confirmSideChatClose = fn();

const onboardingSnapshot: BotOnboardingSnapshot = {
  sessionId: 'storybook-onboarding',
  provider: 'feishu',
  brand: 'feishu',
  state: 'waiting',
  qrCodeDataUrl: QR_DATA_URL,
  expiresAt: Date.now() + 10 * 60_000,
  nextPollAfterMs: 60_000,
  canOpenInBrowser: true,
};

const withBotBridge = withScopedMakaBridge({
  settings: {
    bots: {
      wechatQrCode: async () => ({
        ok: true,
        qrcode: QR_DATA_URL,
        expired: false,
        loggedIn: false,
      }),
      onboarding: {
        start: async () => ({ ok: true, data: onboardingSnapshot }),
        poll: async () => ({ ok: true, data: onboardingSnapshot }),
        cancel: async () => ({
          ok: true,
          data: { ...onboardingSnapshot, state: 'cancelled' },
        }),
        openInBrowser: async () => ({ ok: true, data: undefined }),
      },
    },
  },
});

function SideChatCloseStory() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>关闭侧边对话</button>
      <SideChatCloseConfirmation
        open={open}
        sideChatCount={2}
        onCancel={() => setOpen(false)}
        onConfirm={(skipFutureConfirmations) => {
          confirmSideChatClose(skipFutureConfirmations);
          setOpen(false);
        }}
      />
    </>
  );
}

// Real path: conversation workbar → close a side-chat tab with content.
export const SideChatClose: Story = {
  render: () => <SideChatCloseStory />,
  play: async ({ canvasElement }) => {
    confirmSideChatClose.mockClear();
    const body = within(canvasElement.ownerDocument.body);
    const trigger = body.getByRole('button', { name: '关闭侧边对话' });
    await userEvent.click(trigger);
    const heading = await body.findByRole('heading', { name: /关闭 2 个侧边对话/ });
    await expect(heading).toHaveFocus();
    const dialog = body.getByRole('dialog');
    const checkbox = await body.findByRole('checkbox');
    await userEvent.click(checkbox);
    await userEvent.click(within(dialog).getByRole('button', { name: '关闭侧边对话' }));
    await expect(confirmSideChatClose).toHaveBeenCalledWith(true);
    await expect(body.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await expect(body.findByRole('dialog')).resolves.toBeTruthy();
  },
};

// Real path: Settings → Remote Access → Feishu → scan to connect.
export const BotOnboardingQr: Story = {
  decorators: [withBotBridge],
  render: () => (
    <BotOnboardingModal
      provider="feishu"
      isOpen
      onOpenChange={() => undefined}
      onConnected={() => undefined}
    />
  ),
};

// Real path: Settings → Remote Access → WeChat → QR login.
export const WechatLoginQr: Story = {
  decorators: [withBotBridge],
  render: () => (
    <WechatQrLoginModal
      isOpen
      onOpenChange={() => undefined}
      onRefreshStatuses={() => undefined}
    />
  ),
};
