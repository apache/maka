import assert from 'node:assert/strict';
import test from 'node:test';
import type { EffectivePricingEntry } from '@maka/runtime-host/protocol';
import type { DesktopPricingSnapshot } from '../../shared/runtime-host-pricing.js';
import {
  decidePricingRecovery,
  findCurrentPricingDeleteTarget,
  createPricingDraft,
  formatPricingRate,
  preparePricingDraftForAuthorityReview,
  pricingSnapshotIdentityChanged,
  pricingTargetMatchesSnapshot,
  validatePricingDraft,
} from '../../renderer/settings/pricing-settings-model.js';

test('Pricing draft preserves exact keys and distinguishes blank cache rates from zero', () => {
  const result = validatePricingDraft({
    mode: 'add',
    modelKey: '  Acme:Coder-β  ',
    inputUsdPer1M: '1.25',
    outputUsdPer1M: '2.5',
    cacheReadUsdPer1M: '',
    cacheWriteUsdPer1M: '0',
  }, []);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.pricing, {
    modelKey: 'Acme:Coder-β',
    inputUsdPer1M: 1.25,
    outputUsdPer1M: 2.5,
    cacheWriteUsdPer1M: 0,
  });
});

test('Pricing draft rejects missing, non-finite, negative, overlong, and duplicate values', () => {
  const existing = [builtin('provider:Existing', 1)];
  const invalid = validatePricingDraft({
    mode: 'add',
    modelKey: 'provider:Existing',
    inputUsdPer1M: '',
    outputUsdPer1M: 'Infinity',
    cacheReadUsdPer1M: '-0.1',
    cacheWriteUsdPer1M: 'NaN',
  }, existing);
  assert.deepEqual(invalid, {
    ok: false,
    errors: {
      modelKey: 'duplicate_model_key',
      inputUsdPer1M: 'required',
      outputUsdPer1M: 'invalid_rate',
      cacheReadUsdPer1M: 'invalid_rate',
      cacheWriteUsdPer1M: 'invalid_rate',
    },
  });

  const overlong = validatePricingDraft({
    mode: 'add',
    modelKey: 'x'.repeat(129),
    inputUsdPer1M: '0',
    outputUsdPer1M: '0',
    cacheReadUsdPer1M: '',
    cacheWriteUsdPer1M: '',
  }, existing);
  assert.deepEqual(overlong.errors, { modelKey: 'model_key_too_long' });

  const caseDistinct = validatePricingDraft({
    mode: 'add',
    modelKey: 'provider:existing',
    inputUsdPer1M: '0',
    outputUsdPer1M: '0',
    cacheReadUsdPer1M: '',
    cacheWriteUsdPer1M: '',
  }, existing);
  assert.equal(caseDistinct.ok, true);
});

test('editing seeds canonical numeric strings without filling omitted optionals', () => {
  assert.deepEqual(createPricingDraft(custom('provider:model', 0.00000001, 'become_unpriced')), {
    mode: 'edit',
    modelKey: 'provider:model',
    inputUsdPer1M: '1e-8',
    outputUsdPer1M: '2e-8',
    cacheReadUsdPer1M: '',
    cacheWriteUsdPer1M: '0',
  });
  assert.equal(formatPricingRate(0.00000001), '$1e-8');
  assert.notEqual(formatPricingRate(0.00000001), '$0');
});

test('authority review preserves an Add draft and makes an exact fresh key editable', () => {
  const draft = {
    mode: 'add' as const,
    modelKey: '  Acme:Coder-β  ',
    inputUsdPer1M: '1.25',
    outputUsdPer1M: '2.5',
    cacheReadUsdPer1M: '',
    cacheWriteUsdPer1M: '0',
  };
  assert.deepEqual(
    preparePricingDraftForAuthorityReview(draft, [builtin('Acme:Coder-β', 4)]),
    { ...draft, mode: 'edit' },
  );
  assert.equal(
    preparePricingDraftForAuthorityReview(draft, [builtin('acme:coder-β', 4)]),
    draft,
  );
});

test('recovery matching includes override provenance and delete consequence', () => {
  const equalBuiltin = builtin('provider:model', 4);
  const equalCustom = custom('provider:model', 4, 'restore_builtin');
  const upsertTarget = { kind: 'upsert' as const, pricing: equalCustom.pricing };

  assert.equal(pricingTargetMatchesSnapshot(upsertTarget, snapshot([equalBuiltin])), false);
  assert.equal(pricingTargetMatchesSnapshot(upsertTarget, snapshot([equalCustom])), true);
  assert.equal(pricingTargetMatchesSnapshot({
    kind: 'delete',
    modelKey: 'provider:model',
    expected: 'builtin',
  }, snapshot([equalBuiltin])), true);
  assert.equal(pricingTargetMatchesSnapshot({
    kind: 'delete',
    modelKey: 'provider:model',
    expected: 'unpriced',
  }, snapshot([])), true);
  assert.equal(pricingTargetMatchesSnapshot({
    kind: 'delete',
    modelKey: 'provider:model',
    expected: 'no_override',
  }, snapshot([equalBuiltin])), true);
  assert.equal(pricingTargetMatchesSnapshot({
    kind: 'delete',
    modelKey: 'provider:model',
    expected: 'no_override',
  }, snapshot([])), true);
  assert.equal(pricingTargetMatchesSnapshot({
    kind: 'delete',
    modelKey: 'provider:model',
    expected: 'no_override',
  }, snapshot([equalCustom])), false);
});

test('a revision or connection change invalidates the editor save base', () => {
  const base = snapshot([], 4);
  assert.equal(pricingSnapshotIdentityChanged(base, snapshot([], 4)), false);
  assert.equal(pricingSnapshotIdentityChanged(base, snapshot([], 5)), true);
  assert.equal(pricingSnapshotIdentityChanged(base, {
    ...base,
    connectionId: 'connection-replaced',
  }), true);
  assert.equal(pricingSnapshotIdentityChanged(base, {
    ...base,
    hostEpoch: 'host-replaced',
  }), true);
});

test('delayed recovery preserves the real conflict, unknown, saved, or stale cause', () => {
  assert.deepEqual(decidePricingRecovery('revision_conflict', true), {
    kind: 'complete',
    notice: 'synchronized_conflict',
  });
  assert.deepEqual(decidePricingRecovery('revision_conflict', false), {
    kind: 'review',
    reason: 'revision_conflict',
    notice: 'review_conflict',
  });
  assert.deepEqual(decidePricingRecovery('outcome_unknown', true), {
    kind: 'complete',
    notice: 'synchronized_unknown',
  });
  assert.deepEqual(decidePricingRecovery('outcome_unknown', false), {
    kind: 'review',
    reason: 'outcome_unknown',
    notice: 'review_unknown',
  });
  assert.deepEqual(decidePricingRecovery('known_saved', false), {
    kind: 'review',
    reason: 'authority_changed',
    notice: 'authority_changed',
  });
  assert.deepEqual(decidePricingRecovery('stale', true), {
    kind: 'complete',
    notice: 'synchronized_conflict',
  });
});

test('delete review derives its consequence only from a current Custom override', () => {
  assert.deepEqual(findCurrentPricingDeleteTarget(
    'provider:model',
    [custom('provider:model', 4, 'restore_builtin')],
  ), {
    kind: 'delete',
    modelKey: 'provider:model',
    expected: 'builtin',
  });
  assert.deepEqual(findCurrentPricingDeleteTarget(
    'provider:model',
    [custom('provider:model', 4, 'become_unpriced')],
  ), {
    kind: 'delete',
    modelKey: 'provider:model',
    expected: 'unpriced',
  });
  assert.equal(findCurrentPricingDeleteTarget(
    'provider:model',
    [builtin('provider:model', 4)],
  ), undefined);
  assert.equal(findCurrentPricingDeleteTarget('provider:model', []), undefined);
});

function builtin(modelKey: string, rate: number): EffectivePricingEntry {
  return {
    pricing: {
      modelKey,
      inputUsdPer1M: rate,
      outputUsdPer1M: rate * 2,
    },
    source: 'builtin',
  };
}

function custom(
  modelKey: string,
  rate: number,
  resetEffect: 'restore_builtin' | 'become_unpriced',
): EffectivePricingEntry {
  return {
    pricing: {
      modelKey,
      inputUsdPer1M: rate,
      outputUsdPer1M: rate * 2,
      cacheWriteUsdPer1M: 0,
    },
    source: 'custom',
    resetEffect,
  };
}

function snapshot(
  entries: readonly EffectivePricingEntry[],
  revision = 4,
): DesktopPricingSnapshot {
  return {
    hostEpoch: 'host-current',
    connectionId: 'connection-current',
    revision,
    entries,
  };
}
