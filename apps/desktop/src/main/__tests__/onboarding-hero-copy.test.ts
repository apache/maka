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

});
