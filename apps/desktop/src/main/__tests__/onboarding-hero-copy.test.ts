import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { OnboardingState } from '@maka/core';
import { getOnboardingHeroCopy } from '../../renderer/onboarding-hero-copy.js';
import { getOnboardingCopy } from '../../renderer/locales/onboarding-copy.js';

const configuredStates: OnboardingState[] = [
  { kind: 'ready_empty', connectionSlug: 'a', model: 'm' },
  { kind: 'ready_with_history', connectionSlug: 'a', model: 'm' },
];

describe('onboarding hero copy', () => {
  const onboardingStates: OnboardingState[] = [
    { kind: 'needs_connection' },
    { kind: 'needs_connection_credentials', connectionSlug: 'anthropic-live' },
    { kind: 'needs_model', connectionSlug: 'openai-live' },
    { kind: 'blocked', reason: 'all_connections_unhealthy' },
  ];

  it('maps each incomplete state to its shortest recovery destination', () => {
    const expectedTargets = [
      { kind: 'provider_catalog' },
      { kind: 'connection', connectionSlug: 'anthropic-live' },
      { kind: 'connection', connectionSlug: 'openai-live' },
      { kind: 'models' },
    ];
    for (const [index, state] of onboardingStates.entries()) {
      const copy = getOnboardingHeroCopy(state, 'zh');
      assert.ok(copy, state.kind);
      assert.equal(copy.kind, state.kind);
      assert.deepEqual(copy.cta.target, expectedTargets[index]);
      assert.match(`${copy.title}${copy.body}${copy.cta.label}`, /[一-鿿]/);
      assert.equal(copy.tone, state.kind === 'blocked' ? 'destructive' : undefined);
    }
  });

  it('keeps connection slugs as metadata instead of interpolating them into copy', () => {
    for (const state of onboardingStates) {
      if (state.kind !== 'needs_connection_credentials' && state.kind !== 'needs_model') continue;
      for (const locale of ['zh', 'en'] as const) {
        const copy = getOnboardingHeroCopy(state, locale);
        assert.ok(copy);
        assert.equal(copy.connectionSlug, state.connectionSlug);
        assert.equal(copy.body.includes(state.connectionSlug), false);
      }
    }
  });

  it('names the recovery action instead of the Settings container', () => {
    const labels = onboardingStates.map((state) => getOnboardingHeroCopy(state, 'zh')?.cta.label);
    assert.match(labels[1] ?? '', /凭据/);
    assert.match(labels[2] ?? '', /模型/);
    assert.match(labels[3] ?? '', /修复/);
    assert.equal(getOnboardingCopy('zh').skip, '跳过引导');
  });

  it('does not render onboarding copy for configured users', () => {
    for (const state of configuredStates) {
      assert.equal(getOnboardingHeroCopy(state, 'zh'), null);
    }
  });

});
