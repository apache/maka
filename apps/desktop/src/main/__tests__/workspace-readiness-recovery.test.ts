import assert from 'node:assert/strict';
import test from 'node:test';
import type { OnboardingState } from '@maka/core';
import { deriveWorkspaceReadinessRecovery } from '../../renderer/workspace-readiness-recovery.js';

function derive(state: OnboardingState | undefined, overrides = {}) {
  return deriveWorkspaceReadinessRecovery({
    state,
    locale: 'zh',
    activeSessionId: undefined,
    showOnboardingHero: false,
    ...overrides,
  });
}

test('does not duplicate ready, onboarding, or active-session surfaces', () => {
  assert.equal(derive(undefined), undefined);
  assert.equal(
    derive({ kind: 'ready_empty', connectionSlug: 'opencode-free', model: 'big-pickle' }),
    undefined,
  );
  assert.equal(derive({ kind: 'needs_connection' }, { showOnboardingHero: true }), undefined);
  assert.equal(derive({ kind: 'needs_connection' }, { activeSessionId: 'session-1' }), undefined);
});

test('routes a missing model back to the affected connection', () => {
  const recovery = derive({ kind: 'needs_model', connectionSlug: 'opencode-free' });

  assert.equal(recovery?.tone, 'warning');
  assert.deepEqual(recovery?.target, {
    kind: 'connection',
    connectionSlug: 'opencode-free',
  });
  assert.ok(recovery?.title);
  assert.ok(recovery?.description);
  assert.ok(recovery?.actionLabel);
});

test('routes an unhealthy workspace to model settings as a hard block', () => {
  const recovery = derive({ kind: 'blocked', reason: 'all_connections_unhealthy' });

  assert.equal(recovery?.tone, 'destructive');
  assert.deepEqual(recovery?.target, { kind: 'models' });
});
