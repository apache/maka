import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveOnboardingState,
  hasSettledInitialOnboarding,
  isOnboardingMilestone,
  sanitizeOnboardingMilestones,
  type DeriveOnboardingStateInput,
  type OnboardingMilestone,
  type OnboardingState,
} from '../onboarding.js';
import type { LlmConnection } from '../llm-connections.js';

function realConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'anthropic-live',
    name: 'Anthropic Live',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    models: [
      {
        id: 'claude-sonnet-4-5-20250929',
        capabilities: { vision: true, reasoning: true, functionCalling: true },
        contextWindow: 200_000,
      },
    ],
    modelSource: 'fetched',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as LlmConnection;
}

function derive(input: Partial<DeriveOnboardingStateInput> = {}): OnboardingState {
  return deriveOnboardingState({
    connections: input.connections ?? [],
    defaultSlug: input.defaultSlug,
    sessions: input.sessions ?? [],
    secrets: input.secrets ?? {},
  });
}

describe('deriveOnboardingState', () => {
  it('routes the current default to the exact actionable fix', () => {
    const cases: Array<[LlmConnection, Record<string, boolean>, OnboardingState]> = [
      [
        realConnection({ slug: 'missing-secret' }),
        {},
        { kind: 'needs_connection_credentials', connectionSlug: 'missing-secret' },
      ],
      [
        realConnection({ slug: 'missing-model', defaultModel: '', models: undefined }),
        { 'missing-model': true },
        { kind: 'needs_model', connectionSlug: 'missing-model' },
      ],
      [
        realConnection({ slug: 'empty-models', defaultModel: 'stale', models: [] }),
        { 'empty-models': true },
        { kind: 'needs_model', connectionSlug: 'empty-models' },
      ],
      [
        realConnection({ slug: 'stale-model', defaultModel: 'stale', models: [{ id: 'fresh' }] }),
        { 'stale-model': true },
        { kind: 'needs_model', connectionSlug: 'stale-model' },
      ],
      [
        realConnection({
          slug: 'image-only',
          defaultModel: 'image-only',
          models: [{ id: 'image-only', capabilities: { chat: false, imageGeneration: true } }],
        }),
        { 'image-only': true },
        { kind: 'needs_model', connectionSlug: 'image-only' },
      ],
    ];
    for (const [connection, secrets, expected] of cases) {
      assert.deepEqual(derive({ connections: [connection], secrets }), expected);
    }
  });

  it('preserves readiness priority across broken and ready alternatives', () => {
    const missingSecret = realConnection({ slug: 'current' });
    const brokenAlternative = realConnection({ slug: 'broken-alt', models: [] });
    assert.deepEqual(
      derive({
        connections: [missingSecret, brokenAlternative],
        secrets: { 'broken-alt': true },
      }),
      { kind: 'needs_connection_credentials', connectionSlug: 'current' },
    );

    const readyAlternative = realConnection({ slug: 'ready-alt' });
    assert.deepEqual(
      derive({
        connections: [missingSecret, readyAlternative],
        secrets: { 'ready-alt': true },
      }),
      {
        kind: 'ready_empty',
        connectionSlug: readyAlternative.slug,
        model: readyAlternative.defaultModel!,
      },
    );
  });

  it('accepts wired OAuth providers and ignores validation telemetry', () => {
    for (const connection of [
      realConnection({
        slug: 'claude-subscription',
        providerType: 'claude-subscription',
        lastTestStatus: 'error',
      }),
      realConnection({
        slug: 'openai-codex',
        providerType: 'openai-codex',
        defaultModel: 'gpt-5.5',
        models: [{ id: 'gpt-5.5' }],
        lastTestStatus: 'error',
      }),
    ]) {
      assert.equal(
        derive({ connections: [connection], secrets: { [connection.slug]: true } }).kind,
        'ready_empty',
      );
    }
  });
});

describe('onboarding milestone persistence', () => {
  it('rejects malformed or privacy-leaking values', () => {
    const invalid = [
      null,
      [],
      new Date(),
      { id: 'unknown' },
      { id: 'first_chat_sent', completedAt: 1, skippedAt: 2 },
      { id: 'first_chat_sent', completedAt: -1 },
      { id: 'first_chat_sent', completedAt: Infinity },
      { id: 'first_chat_sent', completedAt: '1' },
      { id: 'first_chat_sent', prompt: 'private user content' },
    ];
    for (const value of invalid) assert.equal(isOnboardingMilestone(value), false);
  });

  it('sanitizes invalid entries with last-valid-value and first-seen-order semantics', () => {
    const raw = [
      { id: 'first_personalization', completedAt: 10 },
      { id: 'first_chat_sent', completedAt: 1 },
      { id: 'first_chat_sent', completedAt: 'invalid' },
      { id: 'unknown', completedAt: 2 },
      { id: 'first_chat_sent', skippedAt: 3 },
      { id: 'first_personalization', completedAt: 11 },
    ];
    assert.deepEqual<OnboardingMilestone[]>(sanitizeOnboardingMilestones(raw), [
      { id: 'first_personalization', completedAt: 11 },
      { id: 'first_chat_sent', skippedAt: 3 },
    ]);
    assert.deepEqual(sanitizeOnboardingMilestones(null), []);
  });

  it('settles initial onboarding only on its completed or skipped terminal state', () => {
    const cases: Array<[OnboardingMilestone[], boolean]> = [
      [[], false],
      [[{ id: 'first_chat_sent', completedAt: 1 }], false],
      [[{ id: 'initial_onboarding' }], false],
      [[{ id: 'initial_onboarding', completedAt: 1 }], true],
      [[{ id: 'initial_onboarding', skippedAt: 1 }], true],
    ];
    for (const [milestones, expected] of cases) {
      assert.equal(hasSettledInitialOnboarding(milestones), expected);
    }
  });
});
