import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ProviderType, ThinkingLevel } from '@maka/core';
import { NewChatModelPicker } from '../src/chat-model-switcher.js';
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

const CHOICES: ChatModelChoice[] = [
  { connectionSlug: 'openai-main', providerType: 'openai', model: 'gpt-5', label: 'GPT-5' },
  { connectionSlug: 'openai-main', providerType: 'openai', model: 'gpt-5-mini', label: 'GPT-5 mini' },
  { connectionSlug: 'openai-main', providerType: 'openai', model: 'o3', label: 'o3' },
  { connectionSlug: 'anthropic-team', providerType: 'anthropic', model: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
  { connectionSlug: 'anthropic-team', providerType: 'anthropic', model: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
  { connectionSlug: 'google-lab', providerType: 'google', model: 'gemini-3-pro', label: 'Gemini 3 Pro' },
  {
    connectionSlug: 'openrouter',
    providerType: 'openai-compatible',
    model: 'vendor/a-very-long-model-name-with-reasoning-and-tools-preview',
    label: 'A very long model name with reasoning and tools preview',
  },
];

const THINKING_LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];

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

function ModelPickerFrame(props: { initialValue?: string; thinking?: boolean }) {
  const [value, setValue] = useState(props.initialValue ?? 'anthropic-team:claude-sonnet-4');
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | undefined>('medium');
  return (
    <div style={{ width: 460 }}>
      <NewChatModelPicker
        label={selectedLabel(value)}
        choices={CHOICES}
        currentValue={value}
        currentProviderType="anthropic"
        renderProviderMark={providerMark}
        onPick={({ llmConnectionSlug, model }) => setValue(modelChoiceValue(llmConnectionSlug, model))}
        thinkingLevels={props.thinking ? THINKING_LEVELS : undefined}
        thinkingLevel={props.thinking ? thinkingLevel : undefined}
        onThinkingLevelChange={props.thinking ? setThinkingLevel : undefined}
      />
    </div>
  );
}

// Real path: chat → composer footer model control.
export const Default: Story = {
  render: () => <ModelPickerFrame />,
};

// Real path: Settings → 通用 before any provider exposes a model choice.
export const EmptyCatalog: Story = {
  render: () => (
    <div style={{ width: 320 }}>
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

