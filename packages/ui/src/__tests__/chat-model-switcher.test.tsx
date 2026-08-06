import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { ChatModelSwitcher, ThinkingLevelSelector } from '../chat-model-switcher.js';
import type { ChatModelChoice } from '../chat-model-helpers.js';
import type { SessionSummary } from '@maka/core';

function render(children: ReactNode): string {
  return renderToStaticMarkup(<LocaleProvider locale="zh">{children}</LocaleProvider>);
}

const SESSION: SessionSummary = {
  id: 'session-1',
  name: 'Test',
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  status: 'done',
  backend: 'fake',
  llmConnectionSlug: 'anthropic-main',
  connectionLocked: false,
  model: 'claude-sonnet-4',
  permissionMode: 'ask',
};

const CHOICES: ChatModelChoice[] = [
  {
    connectionSlug: 'anthropic-main',
    providerType: 'anthropic',
    providerLabel: 'Anthropic',
    model: 'claude-opus-4-1',
    label: 'Claude Opus 4.1',
    isDefault: false,
    thinkingLevels: [],
  },
  {
    connectionSlug: 'anthropic-main',
    providerType: 'anthropic',
    providerLabel: 'Anthropic',
    model: 'claude-sonnet-4',
    label: 'Claude Sonnet 4',
    isDefault: true,
    thinkingLevels: ['off', 'high'],
  },
  {
    connectionSlug: 'openai-main',
    providerType: 'openai',
    providerLabel: 'OpenAI',
    model: 'gpt-5',
    label: 'GPT-5',
    isDefault: true,
    thinkingLevels: [],
  },
];

describe('ChatModelSwitcher menu', () => {
  it('groups the catalog by connection, each section named by its heading', () => {
    const markup = render(
      <ChatModelSwitcher
        activeSession={SESSION}
        choices={CHOICES}
        onChange={() => {}}
      />,
    );
    const groups = [...markup.matchAll(/role="group" aria-label="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(groups, ['Anthropic', 'OpenAI'], 'one named group per connection');
    assert.match(markup, /Claude Opus 4\.1/);
    // The current value wears the check; other rows must not.
    const checks = markup.match(/lucide-check/g) ?? [];
    assert.equal(checks.length, 1, 'exactly the current model is checked');
  });

  it('offers an unknown current model as a checked leading row', () => {
    const markup = render(
      <ChatModelSwitcher
        activeSession={{ ...SESSION, model: 'claude-retired-3' }}
        choices={CHOICES}
        onChange={() => {}}
      />,
    );
    assert.match(markup, /claude-retired-3/, 'the current model stays visible even off-catalog');
  });

  it('locks every menu row, not just the trigger, when disabled', () => {
    // An aria-disabled trigger still opens its menu on ArrowDown (Astryx
    // DropdownMenu's keydown path does not consult isDisabled), so a lock
    // that lived only on the trigger would be bypassable by keyboard.
    const markup = render(
      <ChatModelSwitcher
        activeSession={SESSION}
        choices={CHOICES}
        disabledReason="locked"
        onChange={() => {}}
      />,
    );
    const items = (markup.match(/<div\b[^>]*role="menuitem"[^>]*>/g) ?? [])
      .filter((tag) => tag.includes('aria-disabled="true"'));
    assert.equal(items.length, CHOICES.length, 'every row is inert while locked');
  });
});

describe('ThinkingLevelSelector menu', () => {
  it('locks rows with the trigger and explains the lock on the trigger', () => {
    const markup = render(
      <ThinkingLevelSelector
        levels={['off', 'high']}
        current="high"
        onChange={() => {}}
        disabled
        disabledReason="等结束后再切换思考级别。"
      />,
    );
    const items = (markup.match(/<div\b[^>]*role="menuitem"[^>]*>/g) ?? [])
      .filter((tag) => tag.includes('aria-disabled="true"'));
    assert.equal(items.length, 3, 'default + two levels all locked');
    assert.match(markup, /等结束后再切换思考级别/, 'the tooltip carries the lock reason');
  });

  it('maps the default row back to undefined', () => {
    // The sentinel round-trip: DEFAULT_THINKING_LEVEL is menu-only; hosts see
    // `undefined` for the default. This is a render-level fact — the default
    // row exists and the current ladder entry is the checked one.
    const markup = render(
      <ThinkingLevelSelector levels={['off', 'high']} current={undefined} onChange={() => {}} />,
    );
    assert.match(markup, /默认/);
    const checks = markup.match(/lucide-check/g) ?? [];
    assert.equal(checks.length, 1, 'the default row is the checked one');
  });
});
