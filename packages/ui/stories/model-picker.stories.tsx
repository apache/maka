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
  choice('openrouter', 'openai-compatible', 'Custom relay', 'vendor/a-very-long-model-name-with-reasoning-and-tools-preview', 'A very long model name with reasoning and tools preview'),
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

// A relay whose connection name, model ids, and descriptions all overflow the
// trigger and option widths — the "very long text" state truncation must honour.
const LONG_MODEL_LABEL =
  'A very long model name that keeps going well past any reasonable trigger width so wrapping and truncation get exercised';
const LONG_CHOICES: ChatModelChoice[] = [
  {
    connectionId: 'connection-relay-verbose',
    connectionSlug: 'relay-verbose',
    providerType: 'openai-compatible',
    providerLabel: 'Custom relay',
    connectionName: 'My self-hosted relay with an unusually descriptive connection name that also overflows',
    model: 'vendor/a-very-long-model-identifier-with-reasoning-tools-and-a-2026-preview-suffix',
    label: LONG_MODEL_LABEL,
    description:
      'A deliberately verbose description that runs onto several lines so the option body’s overflow handling stays legible instead of pushing the menu wider.',
    knowledgeCutoff: '2026-01',
    isDefault: false,
    thinkingLevels: [],
  },
  {
    connectionId: 'connection-relay-verbose',
    connectionSlug: 'relay-verbose',
    providerType: 'openai-compatible',
    providerLabel: 'Custom relay',
    connectionName: 'My self-hosted relay with an unusually descriptive connection name that also overflows',
    model: 'vendor/second-extremely-long-model-identifier-preview-with-an-extended-context-window',
    label: 'Another exhaustively named preview model with an extended context window and a trailing note',
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
// trigger and the new-chat picker below stay quiet.
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
    const thinking = within(canvasElement).getByRole('button', { name: /思考级别/ });
    await userEvent.click(thinking);
    const medium = await within(document.body).findByRole('menuitemradio', { name: '中' });
    await expect(medium).toHaveAttribute('aria-checked', 'true');
  },
};

// Real path: Settings → 通用 → default model, while the just-picked model is
// being saved. Production drives `ModelPicker.loading` from the save in flight
// (general-settings-page.tsx `loading={saving}`), with the catalog present and
// the row disabled — not an empty catalog. (When the catalog itself is
// unavailable the settings row renders a skeleton, which is a different
// component, so that is not modelled here.)
export const SavingDefaultModel: Story = {
  render: () => (
    <div style={{ width: 260 }}>
      <ModelPicker
        groups={modelMenuGroups(CHOICES)}
        value={modelChoiceValue(CHOICES[4]!.connectionSlug, CHOICES[4]!.model)}
        leadingOption={{ value: '', label: '未设置' }}
        renderProviderMark={providerMark}
        ariaLabel="默认模型"
        disabled
        loading
        triggerClassName="settingsModelPickerTrigger"
        onValueChange={async () => {}}
      />
    </div>
  ),
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
    await menu.findByRole('menuitemradio', { name: 'vendor/gamma' });
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
    // Verifies the long-labelled model is reachable as a radio menu item. Whether the
    // long text truncates or wraps within the menu bounds is a visual check,
    // not asserted here.
    await within(document.body).findByRole('menuitemradio', {
      name: /A very long model name that keeps going/,
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
    await menu.findByRole('menuitemradio', { name: /claude-opus-3-retired/ });
    // …while its connection's remaining models still follow underneath.
    await menu.findByRole('menuitemradio', { name: 'Claude Sonnet 4' });
  },
};
