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
import { expect, userEvent, within } from 'storybook/test';
import type { ProviderType } from '@maka/core/llm-connections';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { SessionSummary } from '@maka/core/session';
import { ChatModelSwitcher, NewChatModelPicker, ThinkingLevelSelector } from '../src/chat-model-switcher.js';
import {
  modelChoiceValue,
  type ChatModelChoice,
} from '../src/chat-model-helpers.js';
import { ModelPicker } from '../src/model-picker.js';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Model Picker',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function choice(
  connectionSlug: string,
  providerType: ChatModelChoice['providerType'],
  providerLabel: string,
  model: string,
  label: string,
): ChatModelChoice {
  return { connectionSlug, providerType, providerLabel, model, label, isDefault: false, thinkingLevels: [] };
}

const CHOICES: ChatModelChoice[] = [
  choice('openai-main', 'openai', 'OpenAI', 'gpt-5', 'GPT-5'),
  choice('openai-main', 'openai', 'OpenAI', 'gpt-5-mini', 'GPT-5 mini'),
  choice('openai-main', 'openai', 'OpenAI', 'o3', 'o3'),
  choice('anthropic-team', 'anthropic', 'Anthropic', 'claude-opus-4-1', 'Claude Opus 4.1'),
  choice('anthropic-team', 'anthropic', 'Anthropic', 'claude-sonnet-4', 'Claude Sonnet 4'),
  choice('google-lab', 'google', 'Google Gemini', 'gemini-3-pro', 'Gemini 3 Pro'),
  choice('openrouter', 'openai-compatible', 'Custom relay', 'vendor/a-very-long-model-name-with-reasoning-and-tools-preview', 'A very long model name with reasoning and tools preview'),
];

// Canonical user-facing ladder when a model offers the common set.
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh'];

function providerMark(type: ProviderType) {
  const labels: Partial<Record<ProviderType, string>> = {
    openai: 'O',
    anthropic: 'A',
    google: 'G',
    'openai-compatible': 'R',
  };
  return <span style={{ fontSize: 11, fontWeight: 700 }}>{labels[type] ?? 'M'}</span>;
}

function selectedLabel(value: string) {
  return CHOICES.find((choice) => modelChoiceValue(choice.connectionSlug, choice.model) === value)?.label ?? value;
}

function ModelPickerFrame(props: { initialValue?: string }) {
  const [value, setValue] = useState(props.initialValue ?? 'anthropic-team:claude-sonnet-4');
  return (
    <div style={{ width: 460 }}>
      <NewChatModelPicker
        label={selectedLabel(value)}
        choices={CHOICES}
        currentValue={value}
        currentProviderType="anthropic"
        renderProviderMark={providerMark}
        onPick={({ llmConnectionSlug, model }) => setValue(modelChoiceValue(llmConnectionSlug, model))}
      />
    </div>
  );
}

// Real path: chat → composer footer model control.
export const Default: Story = {
  render: () => <ModelPickerFrame />,
};

// Real path: an existing conversation -> composer footer model control. The
// cache notice belongs inside this picker's open decision surface; the resting
// trigger and the new-chat picker below stay quiet.
export const ExistingConversation: Story = {
  render: function ExistingConversationRender() {
    const [value, setValue] = useState('anthropic-team:claude-sonnet-4');
    const [connectionSlug, model] = value.split(':', 2);
    const activeSession = {
      id: 'storybook-model-switch',
      name: 'Model switch warning',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: 'active',
      backend: 'ai-sdk',
      llmConnectionSlug: connectionSlug,
      connectionLocked: true,
      model,
      permissionMode: 'ask',
    } satisfies SessionSummary;
    return (
      <div style={{ width: 460, maxWidth: '100%' }}>
        <ChatModelSwitcher
          activeSession={activeSession}
          activeModelLabel={selectedLabel(value)}
          currentProviderType="anthropic"
          choices={CHOICES}
          hasConversationHistory
          renderProviderMark={providerMark}
          onChange={({ llmConnectionSlug, model: nextModel }) =>
            setValue(modelChoiceValue(llmConnectionSlug, nextModel))}
        />
      </div>
    );
  },
  play: async ({ canvasElement, globals }) => {
    const english = globals.locale === 'en';
    const warning = english
      ? 'Switching may rebuild the provider prompt cache, making the next request slower or more expensive.'
      : '切换模型可能需要重建服务商提示缓存，使下一次请求更慢或成本更高。';
    const trigger = within(canvasElement).getByRole('button', {
      name: /切换当前任务模型|Switch model for this task/,
    });
    const announcement = canvasElement.querySelector<HTMLElement>('.maka-model-switch-announcement');
    await expect(announcement).toHaveAttribute('role', 'status');
    await expect(trigger).not.toHaveAttribute('aria-description');
    await expect(announcement).toBeEmptyDOMElement();
    await expect(document.body.querySelector('.maka-model-switch-notice')).not.toBeInTheDocument();

    await userEvent.hover(trigger);
    await within(document.body).findByText(
      english ? 'Switch model for this task' : '切换当前任务模型',
    );
    await userEvent.unhover(trigger);

    await userEvent.click(trigger);
    const notice = document.body.querySelector('.maka-model-switch-notice');
    await expect(notice).toBeInTheDocument();
    await expect(notice).toHaveAttribute('aria-hidden', 'true');
    await expect(notice).toHaveTextContent(warning);
    await expect(announcement).toHaveTextContent(warning);
    await expect(announcement).toHaveAttribute('aria-live', 'polite');
    await expect(announcement).toHaveAttribute('aria-atomic', 'true');
    const menu = within(document.body).getByRole('menu');
    await expect(menu).not.toContainElement(announcement);

    await userEvent.keyboard('{Escape}');
    await expect(announcement).toBeEmptyDOMElement();
    await expect(document.body.querySelector('.maka-model-switch-notice')).not.toBeInTheDocument();

    await userEvent.keyboard('{ArrowDown}');
    await expect(announcement).toHaveTextContent(warning);
    await expect(document.body.querySelector('.maka-model-switch-notice')).toBeInTheDocument();
  },
};

// Real path: an existing but still-empty Session. There is no conversation
// prefix to abandon yet, so this stays as quiet as the new-chat picker.
export const EmptyConversation: Story = {
  render: () => (
    <div style={{ width: 460, maxWidth: '100%' }}>
      <ChatModelSwitcher
        activeSession={{
          id: 'storybook-empty-model-switch',
          name: 'Empty conversation',
          isFlagged: false,
          isArchived: false,
          labels: [],
          hasUnread: false,
          status: 'active',
          backend: 'ai-sdk',
          llmConnectionSlug: 'anthropic-team',
          connectionLocked: false,
          model: 'claude-sonnet-4',
          permissionMode: 'ask',
        }}
        activeModelLabel="Claude Sonnet 4"
        currentProviderType="anthropic"
        choices={CHOICES}
        renderProviderMark={providerMark}
        onChange={() => undefined}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', {
      name: /切换当前任务模型|Switch model for this task/,
    });
    const announcement = canvasElement.querySelector<HTMLElement>('.maka-model-switch-announcement');
    await expect(announcement).toHaveAttribute('role', 'status');
    await expect(trigger).not.toHaveAttribute('aria-description');
    await expect(announcement).toBeEmptyDOMElement();
    await expect(document.body.querySelector('.maka-model-switch-notice')).not.toBeInTheDocument();

    await userEvent.click(trigger);
    await expect(announcement).toBeEmptyDOMElement();
    await expect(document.body.querySelector('.maka-model-switch-notice')).not.toBeInTheDocument();
  },
};

// Real path: Settings → 通用 before any provider exposes a model choice.
// The 260px frame stands in for the one part that cannot be imported from
// this package: the desktop's `select.css` sizes the trigger to 260px via
// `.settingsRows .settingsModelPickerTrigger`, which only exists in the
// renderer's stylesheet. Size and state are the production ones.
export const EmptyCatalog: Story = {
  render: () => (
    <div style={{ width: 260 }}>
      <ModelPicker
        groups={[]}
        value=""
        ariaLabel="默认模型"
        disabled
        onValueChange={async () => {}}
      />
    </div>
  ),
};

// Real path: quiet composer left footer — model + adjacent thinking menu.
export const ThinkingLevelSeparate: Story = {
  render: function ThinkingLevelSeparateRender() {
    const [value, setValue] = useState('anthropic-team:claude-sonnet-4');
    const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | undefined>('medium');
    return (
      <div className="maka-model-selection-controls" style={{ width: 'max-content' }}>
        <NewChatModelPicker
          label={selectedLabel(value)}
          choices={CHOICES}
          currentValue={value}
          currentProviderType="anthropic"
          renderProviderMark={providerMark}
          onPick={({ llmConnectionSlug, model }) => setValue(modelChoiceValue(llmConnectionSlug, model))}
        />
        <ThinkingLevelSelector
          levels={THINKING_LEVELS}
          current={thinkingLevel}
          onChange={setThinkingLevel}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const thinking = within(canvasElement).getByRole('button', { name: /思考级别/ });
    await userEvent.click(thinking);
    await within(document.body).findByRole('menuitem', { name: '中' });
  },
};
