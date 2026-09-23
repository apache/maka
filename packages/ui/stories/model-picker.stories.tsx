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

import { useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { ProviderType } from '@maka/core/llm-connections';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { SessionSummary } from '@maka/core/session';
import { ChatModelSwitcher, ModelChipStatic, NewChatModelPicker, ThinkingLevelSelector } from '../src/chat-model-switcher.js';
import {
  exactModelChoiceValue,
  modelChoiceValue,
  modelMenuGroups,
  type ChatModelChoice,
} from '../src/chat-model-helpers.js';
import { ModelPicker } from '../src/model-picker.js';
import { getConversationCopy } from '../src/conversation-copy.js';
import { useUiLocale } from '../src/locale-context.js';

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
  return { connectionId: `connection-${connectionSlug}`, connectionSlug, providerType, providerLabel, model, label, isDefault: false, thinkingLevels: [] };
}

const CHOICES: ChatModelChoice[] = [
  choice('openai-main', 'openai', 'OpenAI', 'gpt-5', 'GPT-5'),
  choice('openai-main', 'openai', 'OpenAI', 'gpt-5-mini', 'GPT-5 mini'),
  choice('openai-main', 'openai', 'OpenAI', 'o3', 'o3'),
  choice('anthropic-team', 'anthropic', 'Anthropic', 'claude-opus-4-1', 'Claude Opus 4.1'),
  choice('anthropic-team', 'anthropic', 'Anthropic', 'claude-sonnet-4', 'Claude Sonnet 4'),
  choice('google-lab', 'google', 'Google Gemini', 'gemini-3-pro', 'Gemini 3 Pro'),
  choice('fireworks', 'openai-compatible', 'Fireworks', 'accounts/fireworks/models/deepseek-v4-flash-0731', 'accounts/fireworks/models/deepseek-v4-flash-0731'),
];

// Canonical user-facing ladder when a model offers the common set.
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh'];

// A workspace with far more connections than any reference screen probes. Two
// OpenAI keys share a provider, so `modelMenuGroups` disambiguates their
// headings with the connection slug.
const MANY_CHOICES: ChatModelChoice[] = (
  [
    { slug: 'openai-main', type: 'openai', label: 'OpenAI', models: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o3', 'o4-mini', 'gpt-4.1'] },
    { slug: 'openai-alt', type: 'openai', label: 'OpenAI', models: ['gpt-5', 'o3'] },
    { slug: 'anthropic-team', type: 'anthropic', label: 'Anthropic', models: ['claude-opus-4-1', 'claude-sonnet-4', 'claude-haiku-4-5'] },
    { slug: 'google-lab', type: 'google', label: 'Google Gemini', models: ['gemini-3-pro', 'gemini-3-flash'] },
    { slug: 'deepseek-main', type: 'deepseek', label: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'] },
    { slug: 'moonshot-main', type: 'moonshot', label: 'Moonshot', models: ['kimi-k2-0711', 'kimi-k1-8k'] },
    { slug: 'relay', type: 'openai-compatible', label: 'Custom relay', models: ['vendor/alpha', 'vendor/beta', 'vendor/gamma'] },
  ] satisfies Array<{ slug: string; type: ProviderType; label: string; models: string[] }>
).flatMap((group) => group.models.map((model) => choice(group.slug, group.type, group.label, model, model)));

// Real over-length ids from models.dev (2026-03): the ids that outgrow the
// popup are path-style — `accounts/<provider>/models/<model>` on Fireworks or
// namespaced slugs on OpenRouter — where the tail is the actual model name.
const LONG_CHOICES: ChatModelChoice[] = [
  {
    connectionId: 'connection-fireworks',
    connectionSlug: 'fireworks',
    providerType: 'openai-compatible',
    providerLabel: 'Fireworks',
    connectionName: 'Fireworks',
    model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
    label: 'accounts/fireworks/models/deepseek-v4-flash-0731',
    description: 'DeepSeek V4 Flash 0731',
    isDefault: false,
    thinkingLevels: [],
  },
  {
    connectionId: 'connection-fireworks',
    connectionSlug: 'fireworks',
    providerType: 'openai-compatible',
    providerLabel: 'Fireworks',
    connectionName: 'Fireworks',
    model: 'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b',
    label: 'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b',
    isDefault: false,
    thinkingLevels: [],
  },
  {
    connectionId: 'connection-openrouter',
    connectionSlug: 'openrouter',
    providerType: 'openai-compatible',
    providerLabel: 'OpenRouter',
    connectionName: 'OpenRouter',
    model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition',
    label: 'cognitivecomputations/dolphin-mistral-24b-venice-edition',
    isDefault: false,
    thinkingLevels: [],
  },
];

function providerMark(type: ProviderType) {
  const labels: Partial<Record<ProviderType, string>> = {
    openai: 'O',
    anthropic: 'A',
    google: 'G',
    'openai-compatible': 'R',
  };
  return <span style={{ fontSize: 11, fontWeight: 700 }}>{labels[type] ?? 'M'}</span>;
}

function choiceValue(choice: ChatModelChoice) {
  return exactModelChoiceValue(choice.connectionId, choice.connectionSlug, choice.model);
}

function selectedLabel(value: string) {
  return CHOICES.find((choice) => choiceValue(choice) === value)?.label ?? value;
}

function choiceForTarget(input: { llmConnectionId: string; llmConnectionSlug: string; model: string }) {
  return CHOICES.find(
    (choice) =>
      choice.connectionId === input.llmConnectionId &&
      choice.connectionSlug === input.llmConnectionSlug &&
      choice.model === input.model,
  );
}

function ModelPickerFrame(props: { initialValue?: string }) {
  const [value, setValue] = useState(props.initialValue ?? choiceValue(CHOICES[4]!));
  return (
    <div style={{ width: 460 }}>
      <NewChatModelPicker
        label={selectedLabel(value)}
        choices={CHOICES}
        currentValue={value}
        currentProviderType="anthropic"
        renderProviderMark={providerMark}
        onPick={(next) => {
          const nextChoice = choiceForTarget(next);
          if (nextChoice) setValue(choiceValue(nextChoice));
        }}
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
// trigger and the new-chat picker below stay quiet. Activating the notice row
// acknowledges it for the Session and leaves the list open.
export const ExistingConversation: Story = {
  render: function ExistingConversationRender() {
    const [activeChoice, setActiveChoice] = useState(CHOICES[4]!);
    const activeSession = {
      id: 'storybook-model-switch',
      name: 'Model switch warning',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: 'active',
      backend: 'ai-sdk',
      llmConnectionId: activeChoice.connectionId,
      llmConnectionSlug: activeChoice.connectionSlug,
      connectionLocked: true,
      model: activeChoice.model,
      permissionMode: 'ask',
    } satisfies SessionSummary;
    return (
      <div style={{ width: 460, maxWidth: '100%' }}>
        <ChatModelSwitcher
          activeSession={activeSession}
          activeModelLabel={activeChoice.label}
          currentProviderType="anthropic"
          choices={CHOICES}
          hasConversationHistory
          renderProviderMark={providerMark}
          onChange={(next) => {
            const nextChoice = choiceForTarget(next);
            if (nextChoice) setActiveChoice(nextChoice);
          }}
        />
      </div>
    );
  },
  play: async ({ canvasElement, globals }) => {
    const english = globals.locale === 'en';
    const warning = english
      ? 'Switching may rebuild the provider prompt cache, making the next request slower or more expensive.'
      : '切换模型可能需要重建服务商提示缓存，使下一次请求更慢或成本更高。';
    // The row's accessible name is the warning plus its "select to dismiss" line.
    const noticeName = (name: string) => name.startsWith(warning);
    const triggerName = /切换当前任务模型|Switch model for this task/;
    const trigger = () => within(canvasElement).getByRole('button', { name: triggerName });
    const body = within(document.body);

    await userEvent.click(trigger());
    // The cache notice leads the open list as a regular row, announced by its
    // option text — reachable, and activating it is the acknowledgement.
    const notice = await body.findByRole('option', { name: noticeName });
    await expect(notice).not.toHaveAttribute('aria-disabled', 'true');

    await userEvent.keyboard('{Escape}');
    // Closing restores focus to the same trigger next frame, and is not an
    // acknowledgement: the notice is back on reopen.
    await waitFor(() => expect(trigger()).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    await body.findByRole('option', { name: noticeName });
    // Opening with ArrowDown highlights the first row, the notice; Enter on it
    // is the keyboard acknowledgement (a click on the row is the pointer one).
    await userEvent.keyboard('{Enter}');

    // Acknowledged: the list is open again without the notice, the model rows
    // are still there, and nothing was switched.
    await waitFor(() => expect(trigger()).toHaveAttribute('aria-expanded', 'true'));
    await body.findByRole('option', { name: /Claude Sonnet 4/ });
    await expect(body.queryByRole('option', { name: noticeName })).toBeNull();
    await expect(trigger()).toHaveTextContent('Claude Sonnet 4');

    // The acknowledgement holds for the Session across close and reopen.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger()).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    await body.findByRole('option', { name: /Claude Sonnet 4/ });
    await expect(body.queryByRole('option', { name: noticeName })).toBeNull();
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
          llmConnectionId: 'connection-anthropic-team',
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
    await userEvent.click(trigger);
    // No conversation history, so the cache warning row does not lead the list.
    await within(document.body).findByRole('option', { name: /Claude Sonnet 4/ });
    await expect(
      within(document.body).queryByRole('option', { name: /prompt cache|提示缓存/ }),
    ).not.toBeInTheDocument();
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

// Real path: Settings → 通用 → 默认模型 with the full multi-connection catalog.
// The Selector carries search — the answer to "找不到模型" that the wheel
// dropped.
export const SettingsCatalog: Story = {
  render: function SettingsCatalogRender() {
    // The settings catalog is slug-scoped (modelChoiceValue), unlike the
    // session switcher's connection-id-scoped exact values.
    const [value, setValue] = useState(
      modelChoiceValue(MANY_CHOICES[4]!.connectionSlug, MANY_CHOICES[4]!.model),
    );
    return (
      <div style={{ width: 260 }}>
        <ModelPicker
          groups={modelMenuGroups(MANY_CHOICES, 'zh-CN')}
          value={value}
          leadingOption={{ value: '', label: '未设置' }}
          renderProviderMark={providerMark}
          ariaLabel="默认模型"
          onValueChange={setValue}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button'));
    // Search narrows a 19-model catalog to the typed match.
    await userEvent.keyboard('gamma');
    await within(document.body).findByRole('option', { name: /vendor\/gamma/ });
  },
};

// Real path: quiet composer left footer — model + adjacent thinking menu.
export const ThinkingLevelSeparate: Story = {
  render: function ThinkingLevelSeparateRender() {
    const [value, setValue] = useState(choiceValue(CHOICES[4]!));
    const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | undefined>('medium');
    return (
      <div className="maka-model-selection-controls" style={{ width: 'max-content' }}>
        <NewChatModelPicker
          label={selectedLabel(value)}
          choices={CHOICES}
          currentValue={value}
          currentProviderType="anthropic"
          renderProviderMark={providerMark}
          onPick={(next) => {
            const nextChoice = choiceForTarget(next);
            if (nextChoice) setValue(choiceValue(nextChoice));
          }}
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
    const thinking = within(canvasElement).getByRole('combobox', { name: /思考级别/ });
    await userEvent.click(thinking);
    const medium = await within(document.body).findByRole('option', { name: '中' });
    await expect(medium).toHaveAttribute('aria-selected', 'true');
  },
};

// Real path: composer left footer when no connection yields a usable model —
// what a failed / offline / unauthorised catalog fetch all collapse to. The
// picker cannot exist without choices, so the composer swaps in an honest
// "configure a connection" chip (ModelChipStatic's onOpenSettings button)
// rather than a dropdown with nothing behind it.
export const NoModelsAvailable: Story = {
  render: function NoModelsAvailableRender() {
    const copy = getConversationCopy(useUiLocale()).composer;
    return (
      <div className="maka-model-selection-controls" style={{ width: 'max-content' }}>
        <ModelChipStatic label={copy.selectModel} onOpenSettings={() => {}} />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    // It is a real button into Settings, not inert text wearing a dead chevron.
    await expect(
      within(canvasElement).getByRole('button', {
        name: /配置模型连接|Configure model connections/,
      }),
    ).toBeInTheDocument();
  },
};

// Real path: home / new-chat model control for a workspace with many configured
// connections — the breadth #3446 F5 says a single reference screen never
// exercises. Two OpenAI keys land in the same provider, so their headings carry
// the disambiguating slug suffix.
export const ManyConnections: Story = {
  render: function ManyConnectionsRender() {
    const [value, setValue] = useState(choiceValue(MANY_CHOICES[0]!));
    return (
      <div style={{ width: 460, maxWidth: '100%' }}>
        <NewChatModelPicker
          label={MANY_CHOICES.find((candidate) => choiceValue(candidate) === value)?.label ?? value}
          choices={MANY_CHOICES}
          currentValue={value}
          currentProviderType="openai"
          renderProviderMark={providerMark}
          onPick={(next) => {
            const picked = MANY_CHOICES.find(
              (candidate) =>
                candidate.connectionId === next.llmConnectionId &&
                candidate.connectionSlug === next.llmConnectionSlug &&
                candidate.model === next.model,
            );
            if (picked) setValue(choiceValue(picked));
          }}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', {
      name: /选择新任务模型|Choose a model for the new task/,
    });
    await userEvent.click(trigger);
    const menu = within(document.body);
    // Every connection is its own labelled group and the last group's model is
    // reachable in the menu's accessibility tree. This drives the visual state;
    // selection behaviour and scroll geometry are contracts left to focused
    // tests / e2e, not asserted here.
    const groups = await menu.findAllByRole('group');
    await expect(groups.length).toBeGreaterThanOrEqual(7);
    await menu.findByRole('option', { name: /vendor\/gamma/ });
  },
};

// Real path: a custom relay connection exposing verbose model identifiers with
// a long user-set connection name — very long text in the trigger, the option
// labels, and the descriptions at once.
export const LongModelNames: Story = {
  render: () => (
    <div style={{ width: 460, maxWidth: '100%' }}>
      <NewChatModelPicker
        label={LONG_CHOICES[0]!.label}
        choices={LONG_CHOICES}
        currentValue={choiceValue(LONG_CHOICES[0]!)}
        currentProviderType="openai-compatible"
        renderProviderMark={providerMark}
        onPick={() => undefined}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', {
      name: /选择新任务模型|Choose a model for the new task/,
    });
    await userEvent.click(trigger);
    // Verifies the long-id model is reachable as an option; the label
    // ellipsizing at its start inside the capped popup is a visual check.
    await within(document.body).findByRole('option', {
      name: /deepseek-v4-flash-0731/,
    });
  },
};

// Real path: an existing Session whose connection is still configured but whose
// pinned model was dropped from that connection's catalog. ChatModelSwitcher
// surfaces the unknown current model as a leading row above the connection's
// remaining models (the `leadingOption` branch), labelled with the raw model id
// the session carries — not a hand-written label, and without removing the
// connection itself.
export const StaleCurrentModel: Story = {
  render: function StaleCurrentModelRender() {
    return (
      <div style={{ width: 460, maxWidth: '100%' }}>
        <ChatModelSwitcher
          activeSession={{
            id: 'storybook-stale-model',
            name: 'Retired model',
            isFlagged: false,
            isArchived: false,
            labels: [],
            hasUnread: false,
            status: 'active',
            backend: 'ai-sdk',
            llmConnectionId: 'connection-anthropic-team',
            llmConnectionSlug: 'anthropic-team',
            connectionLocked: false,
            model: 'claude-opus-3-retired',
            permissionMode: 'ask',
          }}
          activeModelLabel="claude-opus-3-retired"
          currentProviderType="anthropic"
          choices={CHOICES}
          renderProviderMark={providerMark}
          onChange={() => undefined}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', {
      name: /切换当前任务模型|Switch model for this task/,
    });
    await userEvent.click(trigger);
    const menu = within(document.body);
    // The dropped model leads the menu as the current selection…
    await menu.findByRole('option', { name: /claude-opus-3-retired/ });
    // …while its connection's remaining models still follow underneath.
    await menu.findByRole('option', { name: /Claude Sonnet 4/ });
  },
};
