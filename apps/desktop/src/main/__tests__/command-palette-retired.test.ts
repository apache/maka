import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import { buildCommandList } from '../../renderer/command-palette-commands.js';

function connection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'openai-live',
    name: 'OpenAI Live',
    providerType: 'openai',
    defaultModel: 'gpt-4.1',
    enabled: true,
    models: [{ id: 'gpt-4.1' }],
    modelSource: 'fetched',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

// A retained retired row is still enabled: retirement keeps the connection so
// the credential stays visible and deletable, and nothing flips its flag.
const retired = connection({
  slug: 'claude-subscription',
  name: 'Claude Subscription',
  providerType: 'claude-subscription',
  defaultModel: 'claude-opus-5',
  models: [{ id: 'claude-opus-5' }],
});

function commandIds(connections: LlmConnection[], defaultSlug: string | null): string[] {
  return buildCommandList({
    locale: 'en',
    activeSessionId: undefined,
    themePref: 'auto',
    connections,
    defaultSlug,
    onNewChat: () => {},
    onOpenSettings: () => {},
    onOpenSettingsSection: () => {},
    onOpenShortcuts: () => {},
    onSetTheme: () => {},
    onTestConnection: () => {},
    onSetDefaultConnection: () => {},
  }).map((command) => command.id);
}

test('a retained retired connection gets no palette commands', () => {
  // Settings hides "set as default" and "test connection" for a retired row,
  // but the palette used to filter on `enabled` alone — offering commands the
  // storage default-target gate and the hidden auth actions then refuse.
  const live = connection({ slug: 'anthropic-live', name: 'Anthropic Live' });
  const ids = commandIds([connection(), live, retired], 'openai-live');
  // Positive control: a live non-default connection keeps both commands, so an
  // over-broad filter cannot pass this test by dropping everything.
  assert.ok(ids.includes(`connection:set-default:${live.slug}`));
  assert.ok(ids.includes(`connection:test:${live.slug}`));
  assert.ok(!ids.includes(`connection:set-default:${retired.slug}`));
  assert.ok(!ids.includes(`connection:test:${retired.slug}`));
});

test('a stale in-memory default pointing at a retired connection is not testable', () => {
  // The catalog releases such a default on load; this covers the window where
  // the renderer still holds the old slug.
  const ids = commandIds([retired, connection()], retired.slug);
  assert.ok(!ids.includes('diag:test-default'));
});
