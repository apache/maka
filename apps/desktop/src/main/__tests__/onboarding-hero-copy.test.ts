import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { OnboardingState } from '@maka/core';
import {
  getOnboardingHeroCopy,
  getOnboardingSetupSteps,
} from '../../renderer/onboarding-hero-copy.js';

const configuredStates: OnboardingState[] = [
  { kind: 'ready_empty', defaultConnectionSlug: 'a', defaultModel: 'm' },
  { kind: 'ready_with_history', defaultConnectionSlug: 'a', defaultModel: 'm' },
];

describe('onboarding hero copy', () => {
  const onboardingStates: OnboardingState[] = [
    { kind: 'needs_connection' },
    { kind: 'needs_default_connection' },
    { kind: 'needs_connection_credentials', connectionSlug: 'anthropic-live' },
    { kind: 'needs_default_model', connectionSlug: 'openai-live' },
    { kind: 'blocked', reason: 'all_connections_unhealthy' },
  ];

  it('maps incomplete states to the models recovery flow', () => {
    for (const state of onboardingStates) {
      const copy = getOnboardingHeroCopy(state, 'zh');
      assert.ok(copy, state.kind);
      assert.equal(copy.kind, state.kind);
      assert.equal(copy.cta.settingsSection, 'models');
      assert.match(`${copy.title}${copy.body}${copy.cta.label}`, /[一-鿿]/);
      assert.equal(copy.tone, state.kind === 'blocked' ? 'destructive' : undefined);
    }
  });

  it('keeps connection slugs as metadata instead of interpolating them into copy', () => {
    for (const state of onboardingStates) {
      if (state.kind !== 'needs_connection_credentials' && state.kind !== 'needs_default_model') continue;
      for (const locale of ['zh', 'en'] as const) {
        const copy = getOnboardingHeroCopy(state, locale);
        assert.ok(copy);
        assert.equal(copy.connectionSlug, state.connectionSlug);
        assert.equal(copy.body.includes(state.connectionSlug), false);
      }
    }
  });

  it('does not render onboarding copy or steps for configured users', () => {
    for (const state of configuredStates) {
      assert.equal(getOnboardingHeroCopy(state, 'zh'), null);
      assert.equal(getOnboardingSetupSteps(state, 'zh'), null);
    }
  });

  it('provides localized copy without leaking internal state identifiers', () => {
    const internalTokens = [
      'needs_connection',
      'needs_default_connection',
      'needs_connection_credentials',
      'needs_default_model',
      'all_connections_unhealthy',
    ];
    for (const state of onboardingStates) {
      for (const locale of ['zh', 'en'] as const) {
        const copy = getOnboardingHeroCopy(state, locale);
        const steps = getOnboardingSetupSteps(state, locale);
        assert.ok(copy);
        assert.ok(steps);
        const rendered = JSON.stringify({
          copy: [copy.eyebrow, copy.title, copy.body, copy.cta.label],
          steps,
        });
        for (const token of internalTokens) assert.equal(rendered.includes(token), false, token);
        if (locale === 'en') assert.doesNotMatch(rendered, /[\u3400-\u9fff]/);
      }
    }
  });

  it('moves exactly one active setup step to the missing requirement', () => {
    const cases: Array<[OnboardingState, string]> = [
      [{ kind: 'needs_connection' }, '选择 AI 接入'],
      [{ kind: 'needs_default_connection' }, '设为默认'],
      [{ kind: 'needs_connection_credentials', connectionSlug: 'anthropic-live' }, '补齐认证'],
      [{ kind: 'needs_default_model', connectionSlug: 'openai-live' }, '选择聊天模型'],
      [{ kind: 'blocked', reason: 'all_connections_unhealthy' }, '修复认证或网络'],
    ];
    for (const [state, label] of cases) {
      const steps = getOnboardingSetupSteps(state, 'zh');
      assert.ok(steps);
      assert.equal(steps.length, 3);
      assert.deepEqual(steps.filter((step) => step.state === 'active').map((step) => step.label), [label]);
    }
  });
});
