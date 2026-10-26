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
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { SessionSummary } from '@maka/core/session';
import { Composer } from '@maka/ui';
import { describeAntigravityModels } from '../../../packages/antigravity-acp-plugin/src/model-presentation';

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

const externalRecoveryArgs = {
  activeSession: { ...activeSession, id: 'external-session', backend: 'plugin-executor',
    executorId: 'antigravity', model: 'gemini-3.8-flash-high', llmConnectionId: undefined, llmConnectionSlug: '' },
  activeModelLabel: 'gemini-3.8-flash-high',
  sendBlocked: false,
  onPickAttachments: fn(),
  permissionMode: 'ask',
  onPermissionModeChange: fn(),
  contextUsage: { reading: { kind: 'unavailable' }, onOpen: fn() },
  executorPicker: {
    fixed: true,
    selection: { executorId: 'antigravity', configuration: { model: 'gemini-3.8-flash-high', mode: 'default' } },
    catalog: [{
      id: 'antigravity', displayName: 'Antigravity', readiness: 'restorable',
      supportsModelChange: false, supportsAttachments: false,
      ...describeAntigravityModels([
        { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
        { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      ]),
      modes: [{ id: 'default', name: 'Default' }],
      supportsModeChange: false,
    }],
    onSelect: fn(), onSetup: fn(), onRetry: fn(), onNewTask: fn(), onRestore: fn(),
  },
} satisfies Partial<React.ComponentProps<typeof Composer>>;

// Component-level frame: the full-width composer used by ChatComposerRegion.
// The surrounding transcript is omitted; the Composer owns its production card and toolbar.
const renderExternalRecovery: Story['render'] = (args) => (
  <div style={{ display: 'grid', alignContent: 'end', minHeight: 320 }}>
    <Composer {...args} onSend={fn()} onStop={fn()} />
  </div>
);

// The harness supplies the Host catalog transition; Composer owns all toolbar layout.
function ExternalRestoreTransition(args: React.ComponentProps<typeof Composer>) {
  const [ready, setReady] = useState(false);
  return <div style={{ display: 'grid', alignContent: 'end', minHeight: 320 }}>
    <Composer {...args} onSend={() => { setReady(true); }} onStop={fn()}
      executorPicker={{ ...args.executorPicker!, catalog: args.executorPicker!.catalog.map(entry => ({
        ...entry, readiness: ready ? 'ready' : 'restorable',
        supportsModelChange: ready, supportsModeChange: ready,
      })) }} />
  </div>;
}

const checkRecoveryLayout: Story['play'] = async ({ canvasElement, args }) => {
  const card = canvasElement.querySelector<HTMLElement>('.maka-composer-astryx')!;
  await expect(canvasElement.querySelector('.maka-executor-recovery')).toBeNull();
  const editor = canvasElement.querySelector<HTMLElement>(COMPOSER_INPUT)!;
  await userEvent.click(editor);
  await userEvent.type(editor, '继续');
  await expect(args.executorPicker?.onRestore).not.toHaveBeenCalled();
  await expect(canvasElement.querySelector('button[type="submit"]')).not.toHaveAttribute('aria-disabled', 'true');
  await userEvent.clear(editor);
  await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
  const model = canvasElement.querySelector<HTMLElement>('.maka-model-picker-root')!;
  const usage = canvasElement.querySelector<HTMLElement>('.maka-context-usage-action')!;
  if (usage.getBoundingClientRect().width > 0) {
    const modelBox = model.getBoundingClientRect();
    const usageBox = usage.getBoundingClientRect();
    await expect(Math.abs((modelBox.top + modelBox.bottom - usageBox.top - usageBox.bottom) / 2)).toBeLessThan(2);
  }
};

// Real path: reopen an external ACP conversation whose host projects readiness=restorable.
export const ExternalSessionAutomaticRestore: Story = {
  args: externalRecoveryArgs,
  render: args => <ExternalRestoreTransition {...args} />,
  play: async context => {
    await checkRecoveryLayout!(context);
    const { canvasElement } = context;
    const selectors = ['.maka-model-switcher-trigger', '.maka-thinking-level-selector', '.maka-executor-mode-selector'];
    const controls = selectors.map(selector => canvasElement.querySelector<HTMLElement>(selector)!);
    for (const control of controls) {
      await expect(control).toBeVisible();
      const button = control.querySelector('button')!;
      await expect(button.disabled || button.getAttribute('aria-disabled') === 'true').toBe(true);
    }
    const before = controls.map(control => ({ label: control.textContent, box: control.getBoundingClientRect() }));
    const editor = canvasElement.querySelector<HTMLElement>(COMPOSER_INPUT)!;
    await userEvent.type(editor, '继续');
    await userEvent.click(canvasElement.querySelector('button[type="submit"]')!);
    for (const [index, control] of controls.entries()) {
      const button = control.querySelector('button')!;
      await expect(button.disabled || button.getAttribute('aria-disabled') === 'true').toBe(false);
      await expect(control.textContent).toBe(before[index]!.label);
      const after = control.getBoundingClientRect();
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        await expect(Math.abs(after[key] - before[index]!.box[key])).toBeLessThan(1);
      }
    }
  },
};

// Real path: sending into an external conversation fails to restore its saved configuration.
export const ExternalSessionRestoreFailed: Story = {
  args: {
    ...externalRecoveryArgs,
    executorPicker: {
      ...externalRecoveryArgs.executorPicker,
      catalog: externalRecoveryArgs.executorPicker.catalog.map(entry => ({ ...entry, readiness: 'restore_failed' })),
    },
  },
  render: renderExternalRecovery,
  play: async ({ canvasElement }) => {
    const recovery = canvasElement.querySelector<HTMLElement>('.maka-executor-recovery')!;
    await expect(recovery).toBeVisible();
    await expect(within(recovery).getByRole('button')).toBeEnabled();
    const editor = canvasElement.querySelector<HTMLElement>(COMPOSER_INPUT)!;
    await userEvent.type(editor, '继续');
    await expect(canvasElement.querySelector('button[type="submit"]')).not.toHaveAttribute('aria-disabled', 'true');
    const card = canvasElement.querySelector<HTMLElement>('.maka-composer-astryx')!;
    await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
  },
};

// Real path: a Session still shows its cached sign-in state after a Host inspection fails.
export const ExternalSessionInspectionFailed: Story = {
  args: {
    ...externalRecoveryArgs,
    sendBlocked: true,
    executorPicker: {
      ...externalRecoveryArgs.executorPicker,
      error: 'Host inspection disconnected',
      catalog: externalRecoveryArgs.executorPicker.catalog.map(entry => ({ ...entry, readiness: 'authentication_required' })),
    },
  },
  render: renderExternalRecovery,
  play: async ({ canvasElement, args }) => {
    const recovery = canvasElement.querySelector<HTMLElement>('.maka-executor-recovery')!;
    const notice = canvasElement.querySelector<HTMLElement>('.maka-executor-notice')!;
    await expect(recovery).toBeVisible();
    await expect(notice).toBeVisible();
    await expect(within(recovery).getByRole('button', { name: '前往登录' })).toBeVisible();
    const retry = within(notice).getByRole('button', { name: '重试' });
    await userEvent.click(retry);
    await expect(args.executorPicker!.onRetry).toHaveBeenCalledWith(undefined);
    await expect(args.executorPicker!.onSetup).not.toHaveBeenCalled();
    await expect(args.executorPicker!.onRestore).not.toHaveBeenCalled();
    await expect(args.executorPicker!.onSelect).not.toHaveBeenCalled();
    const card = canvasElement.querySelector<HTMLElement>('.maka-composer-astryx')!;
    await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
  },
};
