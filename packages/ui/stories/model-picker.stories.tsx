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
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { ExecutorCatalogEntry, ExecutorSelection } from '@maka/core/executor-catalog';
import type { SessionSummary } from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { ProviderBrandMark } from '../../../apps/desktop/src/renderer/features/connection-settings/index.js';
import { Composer } from '../src/composer.js';
import { ModelPicker } from '../src/model-picker.js';
import { modelChoiceValue, modelMenuGroups, type ChatModelChoice } from '../src/chat-model-helpers.js';
import { useUiLocale } from '../src/locale-context.js';
import * as React from 'react';
import codexClient from '../../../scripts/plugins/codex-app-server-executor/client.js?raw';
import { MakaClientPluginSdkModule, MakaClientSlotCore, MakaClientSlotProvider } from '../src/client-plugin-slots.js';
import type { MakaClientPluginContext } from '../src/client-plugin-runtime.js';

const meta = {
  title: 'Product/Model Picker',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const CHOICES: ChatModelChoice[] = [
  { connectionId: 'openai-main', connectionSlug: 'openai-main', connectionName: 'OpenAI', providerType: 'openai',
    providerLabel: 'OpenAI', model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', isDefault: true,
    contextWindow: 1_048_576, thinkingLevels: ['low', 'medium', 'high', 'xhigh'] },
  { connectionId: 'openai-main', connectionSlug: 'openai-main', connectionName: 'OpenAI', providerType: 'openai',
    providerLabel: 'OpenAI', model: 'gpt-6-astra', label: 'GPT-6 Astra', isDefault: false, thinkingLevels: ['low', 'medium', 'high'] },
  { connectionId: 'anthropic', connectionSlug: 'anthropic', connectionName: 'Anthropic', providerType: 'anthropic',
    providerLabel: 'Anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', isDefault: false, thinkingLevels: ['low', 'medium', 'high'] },
  { connectionId: 'anthropic', connectionSlug: 'anthropic', connectionName: 'Anthropic', providerType: 'anthropic',
    providerLabel: 'Anthropic', model: 'claude-sonnet-5', label: 'Claude Sonnet 5', isDefault: false, thinkingLevels: ['low', 'high'] },
  { connectionId: 'google', connectionSlug: 'google', connectionName: 'Google Gemini', providerType: 'google',
    providerLabel: 'Google Gemini', model: 'gemini-3.8-pro', label: 'Gemini 3.8 Pro', isDefault: false, thinkingLevels: ['low', 'high'] },
];
const CATALOG: readonly ExecutorCatalogEntry[] = [{
  id: 'antigravity', displayName: 'Antigravity', readiness: 'ready',
  models: [
    { id: 'flash-low', name: 'Gemini 3.8 Flash (Low)', providerType: 'google' },
    { id: 'flash-high', name: 'Gemini 3.8 Flash (High)', providerType: 'google' },
    { id: 'pro-high', name: 'Gemini 3.8 Pro', providerType: 'google' },
  ],
  modelGroups: [{ id: 'flash', name: 'Gemini 3.8 Flash', variants: [
    { modelId: 'flash-low', level: 'low' }, { modelId: 'flash-high', level: 'high' },
  ] }],
  currentModel: 'flash-high', supportsModelChange: true, supportsAttachments: true,
}];
const brand = (type: ChatModelChoice['providerType']) => <ProviderBrandMark type={type} />;

function PickerFrame(props: {
  existing?: boolean;
  external?: boolean;
  choices?: ChatModelChoice[];
  catalog?: readonly ExecutorCatalogEntry[];
  plugin?: boolean;
}) {
  const choices = props.choices ?? CHOICES;
  const [choice, setChoice] = useState(choices[0]!);
  const [thinking, setThinking] = useState<ThinkingLevel | undefined>('high');
  const [target, setTarget] = useState<import('../src/client-plugin-slots.js').MakaClientExecutorTarget>();
  const [core] = useState(() => {
    const slots = new MakaClientSlotCore();
    if (props.plugin) {
      let factory!: (require: (id: string) => unknown) => { apply(context: { slots: MakaClientSlotCore; remote: MakaClientPluginContext['remote'] }): void };
      new Function('window', codexClient)({ __MakaModuleLoader__: { load: (entry: { factory: typeof factory }) => { factory = entry.factory; } } });
      factory(id => {
        if (id === 'react') return React;
        if (id === '@maka/ui/client-plugin') return MakaClientPluginSdkModule;
        throw new Error(`Unknown client module: ${id}`);
      }).apply({ slots, remote: { call: async () => [{ model: 'gpt-6-astra', displayName: 'GPT-6 Astra', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] } as unknown as MakaClientPluginContext['remote'] });
    }
    return slots;
  });
  const [selection, setSelection] = useState<ExecutorSelection | undefined>(props.external
    ? { executorId: 'antigravity', configuration: { model: 'flash-high' } } : undefined);
  const session = props.existing ? {
    id: 'model-picker-preview', model: choice.model, llmConnectionId: choice.connectionId,
    llmConnectionSlug: choice.connectionSlug, status: 'active', permissionMode: 'ask',
  } as SessionSummary : undefined;
  const pick = (target: { llmConnectionId: string; model: string }) => {
    const next = choices.find(item => item.connectionId === target.llmConnectionId && item.model === target.model);
    if (next) { setChoice(next); setThinking(undefined); }
  };
  return <MakaClientSlotProvider core={core}><div style={{ width: 680, maxWidth: '100%', marginTop: 380 }}>
    <Composer
      activeSession={session}
      modelLabel={choice.label} activeModelLabel={choice.label} activeModel={choice.model}
      activeModelConnectionId={choice.connectionId} activeModelConnectionSlug={choice.connectionSlug}
      modelChoices={choices}
      newChatModel={{ llmConnectionId: choice.connectionId, llmConnectionSlug: choice.connectionSlug, model: choice.model }}
      activeThinkingLevels={choice.thinkingLevels} activeThinkingLevel={thinking}
      newChatThinkingLevels={choice.thinkingLevels} newChatThinkingLevel={thinking}
      onThinkingLevelChange={setThinking} onNewChatThinkingLevelChange={setThinking}
      onModelChange={pick} onPickNewChatModel={pick}
      executorTarget={target} onExecutorTargetChange={props.plugin ? next => { setSelection(undefined); setTarget(next); } : undefined}
      executorPicker={!props.existing || props.external ? {
        catalog: props.catalog ?? CATALOG, selection, fixed: props.existing,
        onSelect: next => { setSelection(next); setTarget(undefined); }, onSetup: () => undefined, onRetry: () => undefined, onNewTask: () => undefined,
      } : undefined}
      renderProviderMark={brand}
      onSend={() => undefined} onStop={() => undefined}
    />
  </div></MakaClientSlotProvider>;
}

async function openModels(canvasElement: HTMLElement) {
  const trigger = canvasElement.querySelector<HTMLElement>('.maka-model-switcher-trigger button')!;
  await userEvent.click(trigger);
  const page = within(canvasElement.ownerDocument.body);
  await waitFor(() => expect(page.getByRole('listbox')).toBeVisible());
  const search = page.getByRole('combobox', { expanded: true });
  await userEvent.click(search);
  await expect(search).toHaveFocus();
  return page;
}

// Real path: an existing native task → composer model and effort controls.
export const Default: Story = {
  render: () => <PickerFrame existing />,
};

// Real path: new task → select a native connection or an external Agent in one grouped list.
export const ExecutorCatalogReady: Story = {
  render: () => <PickerFrame />,
  play: async ({ canvasElement }) => {
    const page = await openModels(canvasElement);
    await expect(await page.findByRole('group', { name: 'Antigravity' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'OpenAI' })).toBeVisible();
    const search = page.getByRole('combobox', { expanded: true });
    await userEvent.type(search, 'Flash');
    await userEvent.click(await page.findByRole('option', { name: /Gemini 3.8 Flash/ }));
    await waitFor(() => expect(canvasElement.querySelector('.maka-model-switcher-trigger')).toHaveTextContent('Gemini 3.8 Flash'));
    await expect(canvasElement.querySelector('.maka-thinking-level-selector')).toHaveTextContent(/High|高/);
    await openModels(canvasElement);
  },
};

// Real path: a new task with the Codex extension enabled and an ACP Agent configured.
export const CodexAndAcp: Story = {
  render: () => <PickerFrame plugin />,
  play: async ({ canvasElement }) => {
    const page = await openModels(canvasElement);
    await expect(await page.findByRole('group', { name: 'Codex' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Antigravity' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'OpenAI' })).toBeVisible();
    const codexOption = within(page.getByRole('group', { name: 'Codex' })).getByRole('option', { name: 'GPT-6 Astra' });
    await expect(codexOption.querySelector('svg')).not.toBeNull();
    await expect(canvasElement.querySelectorAll('.maka-model-switcher-trigger')).toHaveLength(1);
    await userEvent.click(codexOption);
    await waitFor(() => expect(canvasElement.querySelector('.maka-model-switcher-trigger')).toHaveTextContent(/^GPT-6 Astra$/));
    await expect(canvasElement.querySelector('.maka-thinking-level-selector')).toHaveTextContent(/High|高/);
    await openModels(canvasElement);
  },
};

// Real path: a new task selects a ready ACP Agent while another configured Agent requires sign-in.
export const UnselectedUnavailableAgentNarrow: Story = {
  render: () => <PickerFrame catalog={[CATALOG[0]!, {
    id: 'claude', displayName: 'Claude Agent', readiness: 'authentication_required',
    models: [], supportsModelChange: false, supportsAttachments: false,
  }]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: /Go to sign in|前往登录/ })).toBeVisible();
    const label = canvasElement.querySelector<HTMLElement>('.maka-composer-model-label')!;
    await waitFor(() => expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1));
    const page = await openModels(canvasElement);
    await userEvent.click(page.getByRole('option', { name: /Gemini 3.8 Flash/ }));
    await waitFor(() => expect(canvasElement.querySelector('.maka-model-switcher-trigger')).toHaveTextContent(/^Gemini 3\.8 Flash$/));
    await expect(canvas.getByRole('button', { name: /Go to sign in|前往登录/ })).toBeVisible();
    const recovery = canvasElement.querySelector<HTMLElement>('.maka-executor-recovery')!;
    await expect(recovery).toBeVisible();
    await expect(recovery).toHaveAttribute('data-state', 'authentication_required');
    await expect(recovery).toHaveTextContent('Claude Agent');
    await expect(within(recovery).getByRole('button', { name: /Go to sign in|前往登录/ })).toBeVisible();
    await openModels(canvasElement);
  },
};

// Real path: an existing external Agent task → change its model without changing executor.
export const ExistingExecutorConversation: Story = {
  render: () => <PickerFrame existing external />,
  play: async ({ canvasElement }) => {
    const page = await openModels(canvasElement);
    await expect(await page.findByRole('group', { name: 'Antigravity' })).toBeVisible();
    await expect(page.queryByRole('group', { name: 'OpenAI' })).toBeNull();
  },
};

const MANY_CHOICES = Array.from({ length: 5 }, (_, i) => CHOICES.map(choice => ({
  ...choice, connectionId: choice.connectionId + '-' + i, connectionSlug: choice.connectionSlug + '-' + i,
  connectionName: (choice.connectionName ?? choice.providerLabel) + ' ' + (i + 1),
})) ).flat();

// Real path: native task with many configured connections → searchable groups.
export const ManyConnections: Story = {
  render: () => <PickerFrame existing choices={MANY_CHOICES} />,
  play: async ({ canvasElement }) => {
    const page = await openModels(canvasElement);
    const groups = await page.findAllByRole('group');
    await expect(groups.length).toBeGreaterThan(10);
    const search = page.getByRole('combobox', { expanded: true });
    await userEvent.type(search, 'Astra');
    await expect(await page.findAllByRole('option')).toHaveLength(5);
    await expect(search).toHaveFocus();
  },
};

const LONG_CHOICES: ChatModelChoice[] = [0, 1].map(index => ({
  ...CHOICES[0]!, model: 'accounts/fireworks/models/deepseek-v4-flash-0731-' + (index ? 'high' : 'low'),
  label: 'accounts/fireworks/models/deepseek-v4-flash-0731-' + (index ? 'high' : 'low'),
  providerType: 'custom', providerLabel: 'Fireworks', connectionName: 'Fireworks',
}));

// Real path: a native task selects a long relay model name; the production Composer owns truncation.
export const LongModelNames: Story = {
  render: () => <PickerFrame existing choices={LONG_CHOICES} />,
  play: async ({ canvasElement }) => {
    const trigger = canvasElement.querySelector<HTMLElement>('.maka-model-switcher-trigger')!;
    const label = trigger.querySelector<HTMLElement>('.maka-composer-model-label')!;
    await expect(label).toHaveAttribute('title', LONG_CHOICES[0]!.label);
    await expect(getComputedStyle(label).textOverflow).toBe('ellipsis');
    await expect(trigger.textContent).not.toContain('1M');
    const page = await openModels(canvasElement);
    const list = await page.findByRole('listbox');
    await waitFor(() => expect(list.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth));
    await expect(list.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
  },
};

// Real path: a selected external Agent requires sign-in; its history remains available.
export const UnavailableAgent: Story = {
  render: () => <PickerFrame existing external catalog={[{ ...CATALOG[0]!, readiness: 'authentication_required' }]} />,
};

// Real path: Settings → Subagents → select a model from the same Astryx option catalog.
export const SettingsCatalog: Story = {
  render: function SettingsCatalogRender() {
    const locale = useUiLocale();
    const [value, setValue] = useState(modelChoiceValue('openai-main', 'gpt-6.1-sol'));
    return <div style={{ width: 360, maxWidth: '100%' }}><ModelPicker
      groups={modelMenuGroups(CHOICES, locale)} value={value} onValueChange={setValue}
      renderProviderMark={brand} ariaLabel="Model"
    /></div>;
  },
};
