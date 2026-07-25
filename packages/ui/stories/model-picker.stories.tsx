import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ProviderType, ThinkingLevel } from '@maka/core';
import { NewChatModelPicker } from '../src/chat-model-switcher.js';
import { modelChoiceValue, type ChatModelChoice } from '../src/chat-model-helpers.js';

// FIDELITY CONVENTION (#1433) — every story in this file must map to an app
// state a real user can reach, with that path noted above the story. Stories
// are treated as ground truth for what the product looks like, so one that
// composes an unreachable state makes every visual comparison built on it
// wrong. If the app changes and a story no longer matches a reachable state,
// fix the story or delete it — do not keep both "the app" and "the story
// version" of a surface alive. Where a story deliberately puts several states
// side by side for review, say so: the arrangement is a scaffold, each panel
// is the reachable state.

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
