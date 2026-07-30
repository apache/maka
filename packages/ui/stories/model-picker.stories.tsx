import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ProviderType, ThinkingLevel } from '@maka/core';
import { NewChatModelPicker } from '../src/chat-model-switcher.js';
import { modelChoiceValue, type ChatModelChoice } from '../src/chat-model-helpers.js';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Model Picker',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const CHOICES: ChatModelChoice[] = [
  { connectionSlug: 'openai-main', providerType: 'openai', model: 'gpt-5', label: 'GPT-5' },
  { connectionSlug: 'openai-main', providerType: 'openai', model: 'gpt-5-mini', label: 'GPT-5 mini' },
  { connectionSlug: 'openai-main', providerType: 'openai', model: 'o3', label: 'o3' },
  { connectionSlug: 'openai-main', providerType: 'openai', model: 'o3-mini', label: 'o3 mini' },
  { connectionSlug: 'anthropic-team', providerType: 'anthropic', model: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
  { connectionSlug: 'anthropic-team', providerType: 'anthropic', model: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
  { connectionSlug: 'anthropic-team', providerType: 'anthropic', model: 'claude-haiku-3-5', label: 'Claude Haiku 3.5' },
  { connectionSlug: 'google-lab', providerType: 'google', model: 'gemini-3-pro', label: 'Gemini 3 Pro' },
  { connectionSlug: 'google-lab', providerType: 'google', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ...Array.from({ length: 14 }, (_, index) => ({
    connectionSlug: 'openrouter',
    providerType: 'openai-compatible' as const,
    model: `catalog-model-${index + 1}`,
    label: `Catalog model ${index + 1}`,
  })),
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

function selectedLabel(value: string) {
  return CHOICES.find((choice) => modelChoiceValue(choice.connectionSlug, choice.model) === value)?.label ?? value;
}

function ModelPickerFrame() {
  const [value, setValue] = useState('anthropic-team:claude-sonnet-4');
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | undefined>('medium');
  const label = useMemo(() => selectedLabel(value), [value]);

  return (
    <div style={{ display: 'grid', gap: 12, width: 300 }}>
      <NewChatModelPicker
        label={label}
        choices={CHOICES}
        currentValue={value}
        renderProviderMark={providerMark}
        onPick={({ llmConnectionSlug, model }) => setValue(modelChoiceValue(llmConnectionSlug, model))}
        thinkingLevels={['minimal', 'low', 'medium', 'high']}
        thinkingLevel={thinkingLevel}
        onThinkingLevelChange={setThinkingLevel}
      />
      <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>
        打开 picker 后，底部“思考级别”会展开右侧菜单。试试搜索 “sonnet”、“OpenAI” 或一个不存在的词。
      </span>
    </div>
  );
}

// Real path: chat → the model button in the composer footer (chat-model-switcher.tsx),
// also reachable from 设置 → 通用 as the default-model field. Search and the 思考级别 submenu
// are driven from inside the story.
export const Default: Story = {
  render: () => <ModelPickerFrame />,
};
